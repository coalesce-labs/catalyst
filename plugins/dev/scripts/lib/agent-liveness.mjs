// agent-liveness.mjs — CTL-1994. The pure, node-builtins-only leaf that decides
// whether an agent session is healthy, overloaded, silent or dead, and how long
// to wait before trying again.
//
// WHY IT LIVES HERE, not in execution-core: two very different processes need
// the same answers.
//   1. `sdk-run-phase-agent.mjs` — the per-ticket phase WORKER, which has had
//      429/529 backoff since CTL-1365b.
//   2. `role-supervisor/` — the long-running ROLE processes (steward,
//      concierge), which until now ran as `claude -p` with NO backoff at all.
//      On 2026-08-18 a provider 529 killed seven role lanes at once, twice, and
//      a human pasted the briefs back in 10-60 minutes later.
// The policy that already worked for workers is the policy roles need. Putting
// one copy here is the alternative to a second, drifting copy — and
// execution-core's own `config.mjs` chain reaches `bun:sqlite`, so a role
// runner cannot simply import from there. Everything in this file is pure and
// imports nothing but `node:*` (just `node:crypto`, for the jitter source), so
// both callers can load it under bare `node` with no node_modules.
//
// Every function is total and injectable: no clock, no randomness, and no env
// is read unless it is passed in. That is what makes the restart policy
// testable rather than something you find out about during an outage.

import { randomInt } from "node:crypto";

// The jitter source. This is backoff jitter, NOT a credential — but the value
// flows into the heartbeat record alongside the session id, and CodeQL reads a
// non-crypto RNG reaching that sink as js/insecure-randomness (high). It is
// right to complain and cheap to satisfy: jitter is computed only on failure
// paths, so a CSPRNG costs nothing measurable, and using one removes the SOURCE
// rather than suppressing the warning. Injectable, so tests stay deterministic.
const cryptoRandom = () => randomInt(0, 2 ** 30) / 2 ** 30;

/** HTTP statuses that mean "the provider is overloaded, try again later". */
export const OVERLOADED_STATUSES = new Set([429, 529]);

/** Pull a status code out of the several shapes the SDK and the API use. */
export function statusOf(x) {
  return x?.api_error_status ?? x?.status ?? x?.statusCode ?? x?.error?.status ?? null;
}

/** A terminal result that is a 429/529 overload, or an `overloaded_error` subtype. */
export function isOverloadedResult(result) {
  if (!result) return false;
  if (OVERLOADED_STATUSES.has(Number(statusOf(result)))) return true;
  const t = result.error?.type ?? result.error_type;
  return t === "overloaded_error";
}

/** A thrown error that is a 429/529 overload. */
export function isOverloadedError(err) {
  if (!err) return false;
  if (OVERLOADED_STATUSES.has(Number(statusOf(err)))) return true;
  const t = err?.error?.type ?? err?.type;
  if (t === "overloaded_error") return true;
  // The SDK mislabels some overloads, so the message is the last resort. Word
  // boundaries matter: without them "1529 turns" would read as a 529.
  return /\b(429|529|overloaded)\b/i.test(String(err?.message ?? ""));
}

/**
 * Exponential backoff (base·2^i), capped, with full jitter.
 * `random` is injectable so a backoff test is deterministic.
 * Returns 50%-100% of the ceiling — jitter is what stops N restarted roles from
 * retrying in lockstep and re-creating the thundering herd that killed them.
 */
export function backoffMs(i, { baseMs = 1000, capMs = 30000, random = cryptoRandom } = {}) {
  const ceil = Math.min(capMs, baseMs * 2 ** i);
  return Math.floor(ceil * (0.5 + 0.5 * random()));
}

/**
 * Subscription auth only. An API key outranks the OAuth token in headless mode
 * and silently METERS — so the correct behaviour is to refuse loudly rather
 * than to run and bill. Returns {ok, reason}; never throws.
 */
export function assertSdkAuth({ env = process.env, oauthToken } = {}) {
  if (env.ANTHROPIC_API_KEY) {
    return { ok: false, reason: "ANTHROPIC_API_KEY is set — refusing to run a role on the SDK (it outranks the OAuth token and would silently meter; unset it and authenticate via CLAUDE_CODE_OAUTH_TOKEN)" };
  }
  if (env.ANTHROPIC_AUTH_TOKEN) {
    return { ok: false, reason: "ANTHROPIC_AUTH_TOKEN is set — refusing to run a role on the SDK (it overrides the subscription OAuth token)" };
  }
  if (!oauthToken) {
    return { ok: false, reason: "CLAUDE_CODE_OAUTH_TOKEN is missing — refusing to run a role on the SDK (run `claude setup-token`)" };
  }
  return { ok: true, reason: null };
}

// ── Liveness ────────────────────────────────────────────────────────────────
// "Quiet" and "dead" are indistinguishable for a `claude -p` role: both look
// like nothing happening. A heartbeat makes them two different numbers.

export const LIVENESS = { LIVE: "live", SILENT: "silent", DEAD: "dead", MISSING: "missing" };

export const SILENT_AFTER_MS = 10 * 60 * 1000;
export const DEAD_AFTER_MS = 30 * 60 * 1000;

/**
 * Classify a heartbeat by age. `now` and the thresholds are injectable.
 * A missing heartbeat is MISSING, never LIVE — the absence of a signal is not
 * evidence of health, and defaulting it to healthy is how a dead role hides.
 */
export function classifyHeartbeat(hb, { now, silentAfterMs = SILENT_AFTER_MS, deadAfterMs = DEAD_AFTER_MS } = {}) {
  if (typeof now !== "number") throw new TypeError("classifyHeartbeat: `now` (ms) is required — this function must not read the clock");
  if (!hb || typeof hb.ts !== "number") return { state: LIVENESS.MISSING, ageMs: null };
  const ageMs = now - hb.ts;
  if (ageMs >= deadAfterMs) return { state: LIVENESS.DEAD, ageMs };
  if (ageMs >= silentAfterMs) return { state: LIVENESS.SILENT, ageMs };
  return { state: LIVENESS.LIVE, ageMs };
}

// ── Restart policy ──────────────────────────────────────────────────────────

export const RESTART_CAP_PER_HOUR = 5;

/** Backoff ladder for a provider overload: 60s → 2m → 5m → 15m, then capped. */
export const OVERLOAD_LADDER_MS = [60_000, 120_000, 300_000, 900_000];

/**
 * Decide what to do when a role's session has ended.
 *
 * Returns { action, waitMs, sameSession, reason } where action is one of
 * "resume" (same SDK session), "restart" (fresh session from the handoff),
 * "stop" (do not restart; page a human/the concierge), or "idle-reenter"
 * (the session ended cleanly but the scope is still active).
 *
 * Pure: pass `restartsLastHour` and `attempt` in; nothing is read from disk.
 */
export function decideRestart({
  exitCode,
  overloaded = false,
  quotaExhausted = false,
  stopRequested = false,
  scopeActive = false,
  attempt = 0,
  restartsLastHour = 0,
  reentriesLastHour = 0,
  random = cryptoRandom,
} = {}) {
  if (stopRequested) {
    return { action: "stop", waitMs: 0, sameSession: false, reason: "stop requested — the role wrote its handoff and exited; it stays down until `start`" };
  }

  // A restart storm is worse than a down role: it burns the same quota that is
  // usually the reason the role is failing in the first place.
  if (restartsLastHour >= RESTART_CAP_PER_HOUR) {
    return { action: "stop", waitMs: 0, sameSession: false, reason: `${restartsLastHour} restarts in the last hour (cap ${RESTART_CAP_PER_HOUR}) — stopping and paging rather than looping` };
  }

  if (quotaExhausted) {
    return { action: "restart", waitMs: 15 * 60_000, sameSession: false, reason: "quota exhausted — waiting 15 min; the concierge posts one board line, and no relaunch storm" };
  }

  if (overloaded) {
    const ladder = OVERLOAD_LADDER_MS;
    const capMs = ladder[Math.min(attempt, ladder.length - 1)];
    // Jitter here for the same reason as backoffMs: seven lanes died together,
    // so seven lanes would otherwise retry together.
    const waitMs = Math.floor(capMs * (0.5 + 0.5 * random()));
    return { action: "resume", waitMs, sameSession: true, reason: `provider overload — backing off ${Math.round(waitMs / 1000)}s and resuming the SAME session (never re-paste the brief)` };
  }

  if (exitCode === 0) {
    if (!scopeActive) {
      return { action: "stop", waitMs: 0, sameSession: false, reason: "clean exit and the scope is quiet — nothing to re-enter" };
    }
    // Bounded: 3 re-entries per hour, then hand off and start fresh. An agent
    // that keeps stopping while work is outstanding is usually stuck, not done.
    if (reentriesLastHour >= 3) {
      return { action: "restart", waitMs: 0, sameSession: false, reason: "3 idle re-entries in the last hour — handing off and starting a fresh session instead of re-entering again" };
    }
    return { action: "idle-reenter", waitMs: 0, sameSession: true, reason: "the session ended while the scope is still active — re-entering it to continue from its last artifact" };
  }

  return {
    action: "restart",
    waitMs: backoffMs(attempt, { baseMs: 5_000, capMs: 120_000, random }),
    sameSession: false,
    reason: `non-zero exit (${exitCode}) — restarting from the handoff with backoff`,
  };
}

/**
 * Is the scope active? Computable, so "active" is never a judgement call:
 * a ticket in flight, an open ask this role raised, or a human comment newer
 * than this role's last reply.
 */
export function isScopeActive({ inFlightTickets = 0, openAsksRaised = 0, humanCommentNewerThanLastReply = false } = {}) {
  return inFlightTickets > 0 || openAsksRaised > 0 || humanCommentNewerThanLastReply === true;
}

/**
 * Is a status doc stale for its scope? The cadence is COORD-178's, computed
 * from the doc's own timestamp rather than trusted to the role's memory —
 * a role that held this cadence as a brief instruction produced zero status
 * docs in 90 minutes.
 */
export const STATUS_DOC_CADENCE_MS = 90 * 60 * 1000;
export const STATUS_DOC_STALE_MS = 2 * 60 * 60 * 1000;
export const STATUS_DOC_QUIET_CADENCE_MS = 24 * 60 * 60 * 1000;

export function classifyStatusDoc({ updatedAtMs, now, scopeActive = true } = {}) {
  if (typeof now !== "number") throw new TypeError("classifyStatusDoc: `now` (ms) is required — this function must not read the clock");
  if (typeof updatedAtMs !== "number") return { state: "missing", ageMs: null, dueForUpdate: true };
  const ageMs = now - updatedAtMs;
  if (!scopeActive) {
    return { state: ageMs >= STATUS_DOC_QUIET_CADENCE_MS ? "due" : "current", ageMs, dueForUpdate: ageMs >= STATUS_DOC_QUIET_CADENCE_MS };
  }
  if (ageMs >= STATUS_DOC_STALE_MS) return { state: "stale", ageMs, dueForUpdate: true };
  if (ageMs >= STATUS_DOC_CADENCE_MS) return { state: "due", ageMs, dueForUpdate: true };
  return { state: "current", ageMs, dueForUpdate: false };
}
