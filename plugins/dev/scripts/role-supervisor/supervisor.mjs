// supervisor.mjs — CTL-1994. Keeps ONE long-running role alive on the Claude
// Agent SDK, replacing the `claude -p` brief it used to be launched with.
//
// ── What it replaces, and why ───────────────────────────────────────────────
// Until now the coordination roles ran as `claude -p` with a hand-written brief
// (`~/catalyst/comms/coord/launch-*.txt` — thirteen numbered versions of one
// role's brief in a single day). Measured on 2026-08-18:
//   * a provider 529 killed SEVEN lanes at once, and again 6-7 an hour later;
//     both times a human pasted the briefs back in, 10-60 min later;
//   * print mode ends the run the moment the agent waits, so the role's own
//     watcher had to live outside it and its findings never re-entered;
//   * with no heartbeat, "quiet" and "dead" were indistinguishable.
// The phase workers already had 429/529 backoff. The roles had none. This is
// that policy, applied to the process shape that needed it — see
// ../lib/agent-liveness.mjs, which is the single copy of the decision logic.
//
// ── What it is NOT ─────────────────────────────────────────────────────────
// It never talks in Linear. It has no opinion about tickets. It starts a role,
// keeps it alive, and pages the concierge when it cannot. Everything the role
// says, the ROLE says.
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import {
  assertSdkAuth, decideRestart, isScopeActive, classifyHeartbeat, LIVENESS,
} from "../lib/agent-liveness.mjs";
import { roleFiles } from "./paths.mjs";
import {
  readManifest, beat, readCounters, countLastHour, recordEvent,
  readSession, writeSession, acquireLease, releaseLease,
} from "./state.mjs";

/**
 * The resume bundle: what a restarted role reads before it does anything.
 * Order matters and is the steward skill's `references/resume.md` order —
 * handoff, status doc, its own plan thread, then the replica. Where they
 * disagree the replica wins, and the difference is worth a line in its first turn.
 */
export function buildResumePrompt(manifest, { resumedFrom = null, reason = null } = {}) {
  const lines = [];
  lines.push(`You are ${manifest.role}${manifest.scope ? `, steward of ${manifest.scope}` : ""}.`);
  lines.push("");
  lines.push(`Invoke the ${manifest.skill} skill and follow it. Your scope is ${manifest.scope ?? "as stated in your manifest"}.`);
  lines.push("");
  if (resumedFrom) {
    // The role does not know it was restarted unless it is told. A silent
    // resumption is indistinguishable from a role that never stopped, which is
    // exactly the ambiguity the heartbeat exists to remove.
    lines.push(`⚠️ You were RESTARTED by the supervisor (${reason ?? "reason unrecorded"}).`);
    lines.push(`Resume from: ${resumedFrom}`);
    lines.push("Your FIRST action is to read, in this order: your latest handoff, your status doc, your own");
    lines.push("top-level plan comment and its thread, then the replica. Where they disagree, the replica wins.");
    lines.push('Your first turn must state: "resumed from <artifact> at <time>", plus what changed while you were gone.');
    lines.push("");
  }
  if (manifest.brief_path && existsSync(manifest.brief_path)) {
    lines.push("Standing brief:");
    lines.push(readFileSync(manifest.brief_path, "utf8").trim());
  }
  return lines.join("\n");
}

/** The nudge sent when a role goes idle while its scope is still active. */
export function buildIdleReentryPrompt() {
  return [
    "You stopped while your scope is still active (work in flight, an open ask you raised, or a human",
    "comment newer than your last reply). Continue from your last artifact — do not start over and do",
    "not re-read your whole brief. State what you are picking up, then keep going.",
  ].join("\n");
}

/** The nudge sent when the role's status doc has gone stale. Cadence is computed, not remembered. */
export function buildStatusDocPrompt(ageMin) {
  return `Your status doc is ${ageMin} minutes old while your scope is active (cadence: every merge, every blocker change, at least every 90 min). Update it now, from the template, with a timestamp you read from the clock — then continue.`;
}

/**
 * Run one role until it is told to stop.
 *
 * `runSession` is injectable — the tests drive the whole restart ladder with a
 * fake, so none of this policy has to be discovered during an actual outage.
 * It receives {prompt, cwd, env, resumeSessionId} and resolves
 * {exitCode, sessionId, overloaded, quotaExhausted, lastArtifact}.
 */
export async function superviseRole(role, {
  runSession,
  env = process.env,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = console.log,
  maxIterations = Infinity,
  // How often to refresh the heartbeat WHILE a session runs. A productive SDK
  // session is intentionally long-lived (15m+), and the supervisor writes no
  // heartbeat between the pre-session beat and the post-session beat — so a
  // healthy long session's boundary heartbeat ages past the holding-sentinel's
  // 15m silence threshold and past classifyHeartbeat's 10m SILENT mark, and a
  // working steward gets kickstarted. Refreshing under those thresholds keeps a
  // live session legible as live. 0 disables (tests whose fake session resolves
  // instantly never trip it either way — the timer is cleared before it fires).
  livenessRefreshMs = 5 * 60 * 1000,
} = {}) {
  const manifest = readManifest(role, env);
  if (!manifest) throw new Error(`role-supervisor: no manifest for role '${role}' at ${roleFiles(role, env).manifest}`);

  const auth = assertSdkAuth({ env, oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN });
  if (!auth.ok) throw new Error(`role-supervisor: ${auth.reason}`);

  const lease = acquireLease(role, { now: now() }, env);
  if (!lease.ok) throw new Error(`role-supervisor: ${lease.reason}`);

  let attempt = 0;
  let iterations = 0;
  try {
    for (;;) {
      if (++iterations > maxIterations) return { stopped: "max-iterations", attempt };

      const resumeSessionId = readSession(role, env);
      const prompt = resumeSessionId
        ? buildIdleReentryPrompt()
        : buildResumePrompt(manifest, { resumedFrom: manifest.handoff_path ?? "the status doc", reason: attempt ? "previous session ended" : null });

      beat(role, { now: now(), sessionId: resumeSessionId, scope: manifest.scope, state: "running" }, env);

      // Keep the heartbeat fresh for the LIFE of the session, not just at its
      // boundary — otherwise a healthy long-running role reads as silent and its
      // own backstop restarts it (Codex P1). Runs off the event loop, unref'd so
      // it never keeps the process alive, and cleared in `finally` so a session
      // that resolves before the first tick never writes an extra beat. A crashed
      // process stops the event loop and thus stops beating, so a genuinely dead
      // role is still detected and restarted.
      let refreshTimer = null;
      if (livenessRefreshMs > 0 && typeof setInterval === "function") {
        refreshTimer = setInterval(() => {
          try {
            beat(role, { now: now(), sessionId: resumeSessionId, scope: manifest.scope, state: "running" }, env);
          } catch {
            /* fail-open: a failed liveness refresh must never crash the supervisor */
          }
        }, livenessRefreshMs);
        if (refreshTimer && typeof refreshTimer.unref === "function") refreshTimer.unref();
      }

      let result;
      try {
        result = await runSession({ prompt, cwd: manifest.cwd, env, resumeSessionId });
      } catch (err) {
        // A thrown error is a crash: classify it the same way as a bad exit so
        // an overload thrown rather than returned still takes the same ladder.
        result = { exitCode: 1, thrown: err, overloaded: false };
      } finally {
        if (refreshTimer) clearInterval(refreshTimer);
      }

      if (result?.sessionId) writeSession(role, result.sessionId, env);
      beat(role, { now: now(), sessionId: result?.sessionId ?? resumeSessionId, scope: manifest.scope, state: "between-sessions", lastArtifact: result?.lastArtifact ?? null }, env);

      // CTL-2095: re-read the manifest AFTER the session completes so that a steward
      // which called `role-supervisor complete` during its turn is honoured. The
      // top-of-iteration read (used for the resume-prompt build) may remain stale —
      // only the DECISION must use the fresh copy. isScopeActive is computed here,
      // replacing the stale value from the top of the loop.
      const freshManifest = readManifest(role, env) ?? manifest;
      const freshScopeActive = isScopeActive(freshManifest.activity ?? {});

      const counters = readCounters(role, env);
      const decision = decideRestart({
        exitCode: result?.exitCode ?? 1,
        overloaded: !!result?.overloaded,
        quotaExhausted: !!result?.quotaExhausted,
        stopRequested: !!result?.stopRequested,
        scopeActive: freshScopeActive,
        attempt,
        restartsLastHour: countLastHour(counters, "restart", { now: now() }),
        reentriesLastHour: countLastHour(counters, "reentry", { now: now() }),
      });

      log(`role-supervisor[${role}]: ${decision.action} — ${decision.reason}`);

      if (decision.action === "stop") {
        beat(role, { now: now(), scope: manifest.scope, state: "stopped" }, env);
        return { stopped: decision.reason, attempt };
      }

      recordEvent(role, decision.action === "idle-reenter" ? "reentry" : "restart", { now: now() }, env);
      if (!decision.sameSession) writeSession(role, null, env);
      attempt = decision.action === "resume" || decision.action === "restart" ? attempt + 1 : 0;

      if (decision.waitMs > 0) {
        beat(role, { now: now(), scope: manifest.scope, state: `waiting:${Math.round(decision.waitMs / 1000)}s` }, env);
        await sleep(decision.waitMs);
      }
    }
  } finally {
    releaseLease(role, {}, env);
  }
}

/** Is this role silent or dead right now? Used by the quiet-fleet instrument. */
export function roleLiveness(role, { now = Date.now() } = {}, env = process.env) {
  return classifyHeartbeat(readHeartbeatSafe(role, env), { now });
}

function readHeartbeatSafe(role, env) {
  try {
    return JSON.parse(readFileSync(roleFiles(role, env).heartbeat, "utf8"));
  } catch {
    return null;
  }
}

export { LIVENESS, spawn };
