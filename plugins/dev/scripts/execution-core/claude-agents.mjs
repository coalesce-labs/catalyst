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

import { execFile, execFileSync, spawnSync } from "node:child_process";
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

// --- Phase 00 (CTL-731): hardened async liveness read --------------------
//
// THE FIX for daemon event-loop starvation. Pre-CTL-731 the scheduler's hot
// path read liveness via `countBackgroundAgents → listClaudeAgents →
// execFileSync('claude agents --json')` — a SYNCHRONOUS subprocess spawn on
// EVERY scheduler tick + autotune pass + per-worker reclaim. Live instrumentation
// proved this monopolized the event loop: a 2s `setInterval` logged 0 ticks in
// 90s, so the tailer poll never advanced the cursor and live new-work discovery
// never happened. A hung `claude agents` RPC (the CTL-692 failure mode) wedged
// the loop indefinitely because the sync read had no timeout.
//
// This block replaces that hot path with ONE warm, shared, never-blocking
// snapshot combining five safeguards — each necessary; a bare `{timeout:3000}`
// on the sync read alone regresses into repeated-3s-block / stale-count /
// cold-start-over-spawn failure modes:
//   (a) ASYNC read (execFile→promise, never execFileSync) — a hung RPC no longer
//       blocks the loop; the timer fires, the loop continues, the cache updates
//       when the read resolves or times out.
//   (b) TIMEOUT (~3s, env-tunable) — on the deadline the child is ABORTED (killed,
//       not leaked) and the refresh is treated as a failure (serve last-good).
//   (c) SINGLE-FLIGHT — one in-flight `claude agents --json` at a time; concurrent
//       callers (scheduler tick, reaper, autotune) join the same promise.
//   (d) BACKOFF — after N consecutive failures, stop re-attempting every call and
//       serve last-good for an exponential window so a persistently-hung binary is
//       not hammered each tick. Reset on first success.
//   (e) NON-BLOCKING getter — getAgentsCached() returns last-good SYNCHRONOUSLY
//       (never awaits); if stale and no refresh is in flight (and not backed off)
//       it fires a fire-and-forget single-flight refresh. Exposes snapshot age /
//       isFresh so the scheduler can gate new-work dispatch on staleness.
const LIVENESS_TIMEOUT_MS = Number(process.env.CATALYST_LIVENESS_TIMEOUT_MS) || 3_000;
// Stale threshold for the non-blocking getter (and the scheduler's dispatch gate).
// 2× the TTL: a snapshot older than this is "stale" and a background refresh is
// kicked; the scheduler holds NEW-work dispatch while stale (fail-safe — never
// over-spawn on an unknown/old count). Advancement of in-flight phases is
// independent of this and continues regardless.
const LIVENESS_STALE_MS = Number(process.env.CATALYST_LIVENESS_STALE_MS) || 2 * LIVENESS_TTL_MS;
// Backoff: below this many consecutive failures every stale read retries; at/above
// it, suppress refresh for an exponential window (base × 2^over, capped).
const LIVENESS_BACKOFF_AFTER = Number(process.env.CATALYST_LIVENESS_BACKOFF_AFTER) || 3;
const LIVENESS_BACKOFF_BASE_MS = 1_000;
const LIVENESS_BACKOFF_CAP_MS = Number(process.env.CATALYST_LIVENESS_BACKOFF_CAP_MS) || 30_000;

let _asyncSnap = { ts: 0, agents: null }; // agents:null ⇒ never populated
let _inflight = null; // (c) single-flight latch — a Promise or null
let _failures = 0; // (d) consecutive failure counter
let _backoffUntil = 0; // (d) suppress refresh until now() ≥ this

// backoffWindowMs — 0 below the failure threshold (retry every stale read), then
// exponential (base × 2^over) capped at LIVENESS_BACKOFF_CAP_MS.
function backoffWindowMs(failures) {
  if (failures < LIVENESS_BACKOFF_AFTER) return 0;
  const over = failures - LIVENESS_BACKOFF_AFTER; // 0, 1, 2, …
  return Math.min(LIVENESS_BACKOFF_CAP_MS, LIVENESS_BACKOFF_BASE_MS * 2 ** over);
}

// defaultExecFileAsync — the production async reader: execFile wrapped as a
// promise, bound to an AbortSignal so the timeout path can kill the child.
function defaultExecFileAsync(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { encoding: "utf8", ...opts }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

// refreshAgents — perform ONE async, timed, single-flight `claude agents --json`
// read and update the shared snapshot. Returns the resolved agents array (or the
// last-good / [] on failure); never rejects. Concurrent callers join the same
// in-flight promise (anti-stampede). Injectable seams: execFileAsync (the async
// reader), now (clock), timeoutMs, setTimer/clearTimer (the deadline timer).
export function refreshAgents({
  execFileAsync = defaultExecFileAsync,
  now = Date.now,
  timeoutMs = LIVENESS_TIMEOUT_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (_inflight) return _inflight; // (c) join the in-flight read
  const controller = new AbortController();
  let timer = null;
  const run = (async () => {
    try {
      const out = await Promise.race([
        // (a) async read, bound to the abort signal for (b).
        execFileAsync(CLAUDE_BIN, ["agents", "--json"], {
          encoding: "utf8",
          signal: controller.signal,
        }),
        // (b) deadline: abort the child and reject so we fall back to last-good.
        new Promise((_, reject) => {
          timer = setTimer(() => {
            controller.abort();
            reject(new Error("claude agents --json timed out"));
          }, timeoutMs);
        }),
      ]);
      const parsed = JSON.parse(out);
      if (!Array.isArray(parsed)) throw new Error("claude agents --json: non-array JSON");
      _asyncSnap = { ts: now(), agents: parsed };
      _failures = 0; // (d) success resets backoff
      _backoffUntil = 0;
      return parsed;
    } catch {
      _failures += 1; // (d) arm/extend backoff
      _backoffUntil = now() + backoffWindowMs(_failures);
      return _asyncSnap.agents ?? []; // serve last-good (or [] cold)
    } finally {
      if (timer !== null) clearTimer(timer);
      _inflight = null; // (c) release the latch
    }
  })();
  _inflight = run;
  return run;
}

// getAgentsCached — (e) the non-blocking consumer API. Returns the last-good
// snapshot SYNCHRONOUSLY (never awaits a subprocess). When the snapshot is stale
// AND no refresh is in flight AND we are not in a backoff window, it fires a
// fire-and-forget single-flight refresh so the next read is fresh. The returned
// object carries freshness metadata so the scheduler can gate new-work dispatch.
//   { agents, populated, ageMs, isFresh, ts }
export function getAgentsCached({
  now = Date.now,
  staleMs = LIVENESS_STALE_MS,
  refresh = refreshAgents,
} = {}) {
  const t = now();
  const populated = _asyncSnap.agents !== null;
  const ageMs = populated ? t - _asyncSnap.ts : Infinity;
  const isFresh = populated && ageMs < staleMs;
  if (!isFresh && !_inflight && t >= _backoffUntil) {
    // Fire-and-forget: never await, never throw out of the getter.
    try {
      Promise.resolve(refresh({ now })).catch(() => {});
    } catch {
      /* a synchronous throw from a test refresher must not break the getter */
    }
  }
  return {
    agents: populated ? _asyncSnap.agents : [],
    populated,
    ageMs,
    isFresh,
    ts: _asyncSnap.ts,
  };
}

// resetLivenessCache — drop the memoized snapshot. Test seam, and an explicit
// invalidation hook for callers that just changed the fleet (e.g. right after a
// dispatch or a `claude stop`) and want the next read to reflect it immediately.
// CTL-731: also resets the async snapshot + single-flight/backoff state.
export function resetLivenessCache() {
  _livenessCache = { ts: 0, agents: null };
  _asyncSnap = { ts: 0, agents: null };
  _inflight = null;
  _failures = 0;
  _backoffUntil = 0;
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
//
// CTL-731: when `agents` is not injected, source from the warm, never-blocking
// snapshot (getAgentsCached) instead of a synchronous execFileSync. This is the
// scheduler/autotune hot path — it must NOT spawn a subprocess on the event loop.
// Tests inject `agents` directly (pure logic) and are unaffected.
export function countBackgroundAgents({ agents, now } = {}) {
  const list = agents ?? getAgentsCached(now ? { now } : {}).agents;
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
