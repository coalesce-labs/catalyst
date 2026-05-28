// claude-agents.mjs — `claude agents --json` as the single source of truth for
// background-worker liveness, termination, and concurrency (CTL-657).
//
// Pre-CTL-657 the recovery/reaper paths read ~/.claude/jobs/<id>/pid to decide
// liveness and to SIGKILL a worker — but that pid file exists for 0/981 job
// dirs on Claude Code 2.1.152 (spare-pool model, no per-job pid file). Every
// pid-based primitive was therefore dead code: the keep-alive guard always read
// "dead" (the 79-event false-dead revive storm) and the defensive kill always
// no-op'd. Meanwhile `claude agents --json` reports the real live sessions
// (.sessionId, .status, .kind) and `claude stop <shortId>` actually deregisters
// one. This module centralizes both so recovery, the reaper, and the scheduler
// share ONE liveness / termination / concurrency primitive.

import { execFileSync, spawnSync } from "node:child_process";
import { shortIdFromSessionId } from "./claude-ids.mjs";

const CLAUDE_BIN = process.env.CATALYST_DISPATCH_CLAUDE_BIN || "claude";

// listClaudeAgentsResult — like listClaudeAgents but distinguishes a FAILED read
// ({ ok:false }) from a genuinely empty fleet ({ ok:true, agents:[] }). The TTL
// cache (cachedListClaudeAgents) needs that distinction: on a transient
// `claude agents` failure it must serve the last-good snapshot rather than flap
// every tracked session to "absent" — which would fire a false-wake / false-
// reclaim storm across the whole fleet.
export function listClaudeAgentsResult({ exec = execFileSync } = {}) {
  try {
    const out = exec(CLAUDE_BIN, ["agents", "--json"], { encoding: "utf8" });
    const parsed = JSON.parse(out);
    if (!Array.isArray(parsed)) return { ok: false, agents: [] };
    return { ok: true, agents: parsed };
  } catch {
    return { ok: false, agents: [] };
  }
}

// listClaudeAgents — the parsed `claude agents --json` array, or [] on any
// failure (binary missing, non-JSON output, non-array). Never throws.
export function listClaudeAgents({ exec } = {}) {
  return listClaudeAgentsResult({ exec }).agents;
}

// --- TTL liveness cache (CTL-672) ---
//
// A short-TTL memoization of listClaudeAgents so the broker watchdog and the
// CTL-662 reclaim sweep share ONE `claude agents --json` invocation per window
// instead of each shelling out per tick. The 5s default is far below both the
// reclaim cadence and any phase duration, so a cached snapshot is never
// meaningfully stale for a liveness decision, while N consumers collapse to at
// most ~12 invocations/min regardless of how many ask.
//
// SINGLE-HOST ASSUMPTION: `claude agents` enumerates only LOCAL sessions, so
// this cache — and every liveness decision built on it — is correct only while
// the broker/daemon are co-located with their workers. A distributed deployment
// (workers on remote hosts) must reinstate an over-the-wire liveness signal
// (heartbeats or a liveness RPC); see CTL-672's single-host caveat.
const LIVENESS_TTL_MS = Number(process.env.CATALYST_LIVENESS_TTL_MS) || 5_000;
let _livenessCache = { ts: 0, agents: null }; // agents:null ⇒ never populated

export function cachedListClaudeAgents({
  exec,
  now = Date.now,
  ttlMs = LIVENESS_TTL_MS,
  force = false,
} = {}) {
  const t = now();
  if (!force && _livenessCache.agents !== null && t - _livenessCache.ts < ttlMs) {
    return _livenessCache.agents;
  }
  const res = listClaudeAgentsResult({ exec });
  if (res.ok) {
    _livenessCache = { ts: t, agents: res.agents };
    return res.agents;
  }
  // Failed refresh: serve last-good if we have one — and do NOT advance ts, so
  // the next call retries the read rather than locking a stale snapshot in for a
  // full TTL. Cold-start with no prior snapshot ⇒ [] (nothing better to serve).
  return _livenessCache.agents ?? [];
}

// resetLivenessCache — drop the memoized snapshot. Test seam, and an explicit
// invalidation hook for callers that just changed the fleet (e.g. right after a
// dispatch or a `claude stop`) and want the next read to reflect it immediately.
export function resetLivenessCache() {
  _livenessCache = { ts: 0, agents: null };
}

// agentForShortId — the agent record whose sessionId truncates to `shortId`, or
// null. `shortId` must already be the 8-char form.
export function agentForShortId(shortId, agents) {
  if (!shortId || !Array.isArray(agents)) return null;
  return (
    agents.find((a) => {
      try {
        return shortIdFromSessionId(a?.sessionId) === shortId;
      } catch {
        return false;
      }
    }) ?? null
  );
}

// isBgJobAlive — true iff a live `claude agents` session matches bgJobId. This
// replaces the pid-file keep-alive check: a crashed worker disappears from
// `claude agents`, whereas a live one (busy OR idle between turns) is still
// listed. Best-effort — a malformed id or a failed `claude agents` read returns
// false so the caller falls through to its existing revive path. A non-short-id
// (e.g. the "bg-9" test fixture) short-circuits to false WITHOUT shelling out,
// keeping the pre-CTL-657 revive tests deterministic.
export function isBgJobAlive(bgJobId, { exec, agents } = {}) {
  if (!bgJobId) return false;
  let shortId;
  try {
    shortId = shortIdFromSessionId(bgJobId);
  } catch {
    return false;
  }
  const list = agents ?? listClaudeAgents({ exec });
  return agentForShortId(shortId, list) !== null;
}

// livenessForBgJob — the THREE-valued liveness CTL-662's reclaim keys on:
//   "busy"   — a live session with an open turn (or present but status not
//              explicitly "idle": active/null/unknown all normalize to busy, the
//              conservative direction — we never reclaim a worker we cannot PROVE
//              is idle). A busy worker is NEVER auto-reclaimed regardless of how
//              long its state.json mtime has been stale (the CTL-662 fix: an
//              in-process sub-agent fan-out keeps the parent's turn busy while
//              mtime goes stale).
//   "idle"   — a live session with status "idle" (registered, between turns).
//              Reclaim-eligible, but only after the caller's idle-confirmation.
//   "absent" — not a live `claude agents` session (crashed/exited). Dead.
// isBgJobAlive stays for the presence-only concurrency callers; this is the
// status-aware superset. Best-effort: any doubt (falsy/malformed id, failed
// `claude agents` read) returns "absent" so the caller falls through to its
// existing recovery path — same fail direction as isBgJobAlive returning false.
export function livenessForBgJob(bgJobId, { exec, agents } = {}) {
  if (!bgJobId) return "absent";
  let shortId;
  try {
    shortId = shortIdFromSessionId(bgJobId);
  } catch {
    return "absent";
  }
  const list = agents ?? listClaudeAgents({ exec });
  const agent = agentForShortId(shortId, list);
  if (!agent) return "absent";
  return agent.status === "idle" ? "idle" : "busy";
}

// countBackgroundAgents — number of live sessions with kind === "background".
// The scheduler's concurrency gate: interactive (human) sessions are unlimited
// and MUST NOT count against maxParallel, so only `background` agents are
// tallied. An absent/unknown kind is NOT counted as background (fail-low so a
// kind-reporting quirk can never inflate the in-flight count and starve
// dispatch).
export function countBackgroundAgents({ exec, agents } = {}) {
  const list = agents ?? listClaudeAgents({ exec });
  return list.filter((a) => a?.kind === "background").length;
}

// claudeStop — `claude stop <shortId>`. shortId MUST be the 8-char form
// (`claude stop` rejects full UUIDs with rc=1). Returns {ok, error?}; never
// throws.
export function claudeStop(shortId, { spawn = spawnSync } = {}) {
  try {
    const res = spawn(CLAUDE_BIN, ["stop", shortId], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if ((res.status ?? 0) === 0) return { ok: true };
    return { ok: false, error: res.stderr?.trim() || `claude stop rc=${res.status}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
