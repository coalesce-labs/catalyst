#!/usr/bin/env node
// cluster-claim-sync.mjs — a SYNCHRONOUS bridge over the async cluster-claim CLI
// (CTL-850, the behavioral-cutover PR).
//
// Why this exists: the execution-core dispatch paths (scheduler.mjs schedulerTick,
// monitor.mjs dispatchTriage) are synchronous, and their existing daemon-side
// Linear writes already go through synchronous spawnSync shell wrappers
// (linear-write.mjs → linear-transition.sh). The cross-host claim, by contrast,
// is async (fetch-based, in cluster-claim.mjs). Rather than make the whole tick
// async (which would churn the 292KB scheduler/monitor test suites and the
// setInterval/setTimeout drivers), we drive the claim through spawnSync of
// `node cluster-claim.mjs claim …` here — the same sync-subprocess convention the
// daemon already uses for Linear writes, and it reuses the verified, tested lib.
//
// FAIL-CLOSED contract: ANY failure — spawn error, timeout, non-zero exit, or
// unparseable stdout — is reported as { won: false }. The caller then does NOT
// dispatch this tick and reconsiders next tick. A transient Linear hiccup must
// never cause a double-dispatch; deferring is always safe (the HRW pre-filter
// already guarantees only the owning host even reaches the claim).
//
// ⚠️ FAIL-CLOSED IS NOT FAIL-SILENT (CTL-2033). Every result also carries a
// `reason` naming WHICH of those outcomes happened, so a caller can log a refused
// write as the stall it is instead of as the lost race it is not. See CLAIM_REASON
// below.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// CLUSTER_CLAIM_CLI — absolute path to the claim CLI, resolved relative to this
// module so it works regardless of the daemon's cwd.
const CLUSTER_CLAIM_CLI = fileURLToPath(new URL("./cluster-claim.mjs", import.meta.url));

// CLAIM_TIMEOUT_MS — hard cap on the claim subprocess. The soft-CAS is up to four
// sequential Linear round-trips (read → resolve → write → read-back); 15s is
// generous for a healthy API and bounds a hung call so a stuck claim can't wedge
// a tick. Overridable for tests / slow networks.
const CLAIM_TIMEOUT_MS = Number(process.env.EXECUTION_CORE_CLAIM_TIMEOUT_MS) || 15_000;

// EXECUTION_CORE_CLAIM_STALE_MS — mirrors EXECUTION_CORE_CLAIM_TIMEOUT_MS in
// purpose. Consumed by the claim subprocess (cluster-claim.mjs:CLAIM_STALE_MS_DEFAULT)
// via the env passthrough at the spawn call below. When set, overrides the
// 300_000 ms (5 min) default stale-claim preemption threshold (CTL-1297).

// ─── permanent in-process cache: ticket identifier → issue UUID (CTL-863 fleet-unfreeze, entourage follow-up to #2552) ──
//
// #2552 cached the ReadFence read (82% of the fence traffic) below via
// fenceCheckSyncCached, but left the "entourage" queries uncached: every claim
// resolves the ticket's identifier → UUID via `query ResolveIssueId` inside writeClaim,
// even though a ticket's issue UUID can never change once Linear assigns it. Unlike the
// ReadFence read (a TTL cache, because the underlying claim/fence state genuinely
// changes on a cadence), this is safe to cache PERMANENTLY — there is no staleness
// window to reason about.
//
// resolveIssueId is bundled inside the `claim` CLI subcommand (one subprocess call does
// read + resolve + write + read-back), so caching it here means: pre-resolve the UUID
// via the small standalone `resolve-issue-id` subcommand (cached after the first
// success), then pass the resolved UUID into `claim` so ITS internal resolveIssueId call
// is skipped. A cache miss/disable falls back to the pre-follow-up behavior byte-for-byte
// (claim resolves the ticket itself). Deliberately NOT applied to the CAS reads
// (readClaim, inside claimTicket) — those are the actual fencing correctness check, not
// an immutable mapping, so caching them would risk a false win/lose (see claimTicket's
// own doc comment).
//
// CATALYST_ANCHOR_UUID_CACHE — shared with cluster-heartbeat-sync.mjs's identical anchor
// cache (same env name, same semantics: one operator knob for "cache identifier→UUID
// resolution permanently" across both entourage call sites). "0" disables; any other
// value (including unset) keeps it on.
const issueIdCache = new Map();

// clearIssueIdCache — test-only reset of the module-scope cache between cases.
export function clearIssueIdCache() {
  issueIdCache.clear();
}

function issueIdCacheEnabled(env) {
  return env?.CATALYST_ANCHOR_UUID_CACHE !== "0";
}

// resolveIssueIdSync — spawn `node cluster-claim.mjs resolve-issue-id <ticket>` and
// return the resolved UUID, or null on ANY failure (spawn error, timeout, non-zero exit,
// unparseable stdout, or a resolution miss) — fail-open: the caller treats null as
// "could not pre-resolve" and falls back to letting `claim` resolve it inline, exactly as
// before this follow-up. `spawn`/`nodeBin`/`cli`/`env`/`timeout` are injectable so unit
// tests never spawn a real process.
export function resolveIssueIdSync(
  { ticket },
  {
    spawn = spawnSync,
    nodeBin = process.execPath,
    cli = CLUSTER_CLAIM_CLI,
    env = process.env,
    timeout = CLAIM_TIMEOUT_MS,
  } = {},
) {
  try {
    const res = spawn(nodeBin, [cli, "resolve-issue-id", ticket], {
      encoding: "utf8",
      env,
      timeout,
    });
    if (!res || res.status !== 0 || typeof res.stdout !== "string") return null;
    const line = res.stdout.trim().split("\n").filter(Boolean).pop();
    const parsed = JSON.parse(line);
    return typeof parsed?.issueId === "string" && parsed.issueId.length > 0 ? parsed.issueId : null;
  } catch {
    return null;
  }
}

// resolveIssueIdSyncCached — the cached entry point. A hit returns immediately with
// ZERO subprocess spawn. A miss spawns resolveIssueIdSync and caches ONLY a truthy
// (successfully resolved) UUID — a null (any failure) is never cached, so the very next
// call retries for real instead of latching a transient hiccup forever. `env` is the
// test seam gating the cache; every other option passes straight through to
// resolveIssueIdSync on a miss.
export function resolveIssueIdSyncCached({ ticket }, { env = process.env, ...rest } = {}) {
  if (!issueIdCacheEnabled(env)) {
    return resolveIssueIdSync({ ticket }, { env, ...rest });
  }
  const cached = issueIdCache.get(ticket);
  if (cached) return cached;
  const issueId = resolveIssueIdSync({ ticket }, { env, ...rest });
  if (issueId) issueIdCache.set(ticket, issueId);
  return issueId;
}

// ── CTL-2033: the claim's discriminated outcome ──────────────────────────────
//
// `claimDispatchSync` used to return `{ won:false, generation:null }` for FOUR
// structurally different things: a peer legitimately winning the fence, a
// subprocess that failed to spawn or timed out, a non-zero exit, and stdout that
// did not parse. Only the first is normal. The other three are a stall, and they
// were byte-identical to it — no reason, no log, nothing to alert on.
//
// This is the same defect the sibling `fenceCheckSync` was written NOT to have:
// its comment says it returns "a discriminated result the caller can act on
// WITHOUT a second interpretation pass". This function never learned it.
//
// Measured 2026-08-18 (CTL-879, after #3661 instrumented the gate): 36 held
// tickets across both minis logged `lost-cross-host-claim` — every one on a
// ticket that host OWNS under HRW, so a race was impossible, and every one with
// `claim_reason: null`, because the result was structurally incapable of
// carrying one. mini was simultaneously at 300/300 Linear write budget.
//
// ⛔ THE FAIL DIRECTION IS TOWARD "FAILURE", NOT TOWARD "NORMAL". `isClaimFailure`
// treats anything that is not explicitly WON or PEER_WON — including a null or an
// unrecognised reason — as a failure. An unknown outcome logged as a loud failure
// costs an operator one WARN; an unknown outcome logged as a normal race is
// exactly the three hours this ticket exists to buy back.
export const CLAIM_REASON = Object.freeze({
  /** exit 0, stdout parsed, won:true — we hold the fence. */
  WON: "won",
  /** exit 0, stdout parsed, won:false — the soft-CAS RAN and a peer won the read-back. NORMAL. */
  PEER_WON: "peer-won",
  /** the CLI reported a HOST-BUDGET refusal (`budget:*`) — the write never left this host. */
  BUDGET_REFUSED: "budget-refused",
  /** the CLI ran and reported a non-budget failure (auth, transport, GraphQL, unknown route). */
  CLI_FAILED: "cli-failed",
  /** the process ran but its stdout could not be parsed as the contract's JSON line. */
  UNPARSEABLE: "unparseable-stdout",
  /** `spawn` itself threw — the subprocess never started. */
  SPAWN_THREW: "spawn-threw",
});

/**
 * isClaimFailure — did this claim FAIL, as opposed to legitimately lose a race?
 * Fail-loud on the unknown (see the block comment above): only the two explicitly
 * normal reasons return false.
 */
export function isClaimFailure(reason) {
  return reason !== CLAIM_REASON.WON && reason !== CLAIM_REASON.PEER_WON;
}

// CLAIM_DETAIL_MAX — the detail carried into a log line is BOUNDED. A GraphQL
// errors[] body can be kilobytes, and this string lands in a per-ticket log line
// on every sweep of every held ticket.
const CLAIM_DETAIL_MAX = 240;

// scrubDetail — bound the excerpt and mask anything token-shaped before it enters
// a log line. Deliberately LOCAL rather than imported from linear-write-proxy.mjs:
// this module is a leaf that spawnSync's the CLI, and importing the proxy would
// pull its budget-ledger + credential graph into every caller of the sync bridge.
// The CLI's own errors carry no credential today; this is the guard for the day
// one of them starts to.
function scrubDetail(text) {
  if (typeof text !== "string" || text === "") return null;
  const masked = text.replace(/\b(?:lin_api_|ghp_|gho_|ghs_|github_pat_|sk-|xoxb-)[A-Za-z0-9_\-]+/g, "[redacted]");
  return masked.length > CLAIM_DETAIL_MAX ? `${masked.slice(0, CLAIM_DETAIL_MAX)}…` : masked;
}

// parseClaimLine — the CLI prints exactly one JSON line; take the last non-empty
// one defensively. Returns null when there is nothing parseable, so the caller can
// tell "no JSON at all" from "JSON that says won:false".
function parseClaimLine(stdout) {
  if (typeof stdout !== "string") return null;
  const line = stdout.trim().split("\n").filter(Boolean).pop();
  if (!line) return null;
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// classifyCliReason — map the CLI's own refusal word onto this module's outcome.
// A `budget:*` reason (linear-write-proxy's `classifyWrite` gate: `budget:day-exhausted`,
// `budget:per-ticket-cap`, `budget:already-converged`) is named separately because
// it is HOST-WIDE and self-clearing on the UTC day roll — an operator reading it
// needs to lift a limit, not debug a claim.
function classifyCliReason(cliReason) {
  if (typeof cliReason === "string" && cliReason.startsWith("budget:")) return CLAIM_REASON.BUDGET_REFUSED;
  return CLAIM_REASON.CLI_FAILED;
}

// claimDispatchSync — soft-CAS claim `ticket` for `hostName` at `phase`,
// synchronously. Returns { won, generation, reason, detail } — `reason` is ALWAYS
// one of CLAIM_REASON and is never null (CTL-2033); `detail` is a bounded, scrubbed
// string on a failure and null otherwise. won:false on any failure (fail-closed).
// `spawn`/`nodeBin`/`cli`/`env`/`timeout` are injectable so the unit tests never
// spawn a real process.
//
// ⚠️ NO IN-CALL RETRY, DELIBERATELY. This runs inside the synchronous daemon tick,
// and the measured failure is a HOST-WIDE write-budget refusal — every candidate in
// the sweep fails for the same reason at the same instant. A hot retry would spend
// more of the exhausted budget, block the tick on a sleep, and add fork pressure at
// exactly the moment the host is under it. The retry is the NEXT SWEEP (measured
// 2026-08-18: every 5-10 min), which is a real backoff that costs nothing. What was
// missing was never the retry — it was the reason and the alarm.
// CTL-863 follow-up: `resolveIssueId` is the injectable pre-resolve seam (defaults to
// resolveIssueIdSyncCached) — a resolved UUID is threaded into the `claim` argv so that
// subprocess skips its own ResolveIssueId call. A null (miss/disabled+failed) falls back
// to the pre-follow-up 3-arg form untouched.
export function claimDispatchSync(
  { ticket, hostName, phase },
  {
    spawn = spawnSync,
    nodeBin = process.execPath,
    cli = CLUSTER_CLAIM_CLI,
    env = process.env,
    timeout = CLAIM_TIMEOUT_MS,
    resolveIssueId = resolveIssueIdSyncCached,
  } = {},
) {
  try {
    const issueId = resolveIssueId({ ticket }, { spawn, nodeBin, cli, env, timeout });
    const args = [cli, "claim", ticket, hostName, phase];
    if (issueId) args.push(issueId);
    const res = spawn(nodeBin, args, {
      encoding: "utf8",
      env,
      timeout,
    });
    const parsed = parseClaimLine(res?.stdout);
    // A structured `error.reason` is authoritative wherever it appears — the CLI
    // pairs it with CLAIM_FAILED_EXIT today, and reading it independently of the
    // exit code means a future exit-code change cannot silently reclassify a
    // failure as a race.
    const cliReason = typeof parsed?.error?.reason === "string" ? parsed.error.reason : null;
    if (cliReason) {
      return {
        won: false,
        generation: null,
        reason: classifyCliReason(cliReason),
        detail: scrubDetail(`${cliReason}: ${parsed?.error?.message ?? ""}`.trim()),
      };
    }
    if (!res || res.status !== 0 || typeof res.stdout !== "string") {
      // Ran and failed, but said nothing structured: keep the exit status and the
      // stderr excerpt, which is the only evidence left.
      return {
        won: false,
        generation: null,
        reason: CLAIM_REASON.CLI_FAILED,
        detail: scrubDetail(
          `exit=${res?.status ?? "null"}${res?.signal ? ` signal=${res.signal}` : ""}` +
            `${res?.error?.message ? ` error=${res.error.message}` : ""}` +
            `${typeof res?.stderr === "string" && res.stderr.trim() ? ` stderr=${res.stderr.trim()}` : ""}`,
        ),
      };
    }
    if (!parsed) {
      return {
        won: false,
        generation: null,
        reason: CLAIM_REASON.UNPARSEABLE,
        detail: scrubDetail(res.stdout.trim()),
      };
    }
    const won = parsed.won === true;
    return {
      won,
      generation: Number.isFinite(parsed.generation) ? parsed.generation : null,
      reason: won ? CLAIM_REASON.WON : CLAIM_REASON.PEER_WON,
      detail: null,
    };
  } catch (err) {
    return {
      won: false,
      generation: null,
      reason: CLAIM_REASON.SPAWN_THREW,
      detail: scrubDetail(String(err?.message ?? err)),
    };
  }
}

// FENCE_STALE_EXIT — mirror of cluster-claim.mjs's exit code: the CLI exits 10
// when the ticket's current claim generation no longer matches the generation we
// asked about (a stale/partitioned generation). Kept in sync deliberately; the
// two files are the only places this contract lives.
const FENCE_STALE_EXIT = 10;

// fenceCheckSync — is `generation` still the CURRENT fence for `ticket`?
// Synchronously drives `node cluster-claim.mjs fence-check <ticket> <gen>` over
// spawnSync (the same sync-subprocess convention as claimDispatchSync). Returns a
// discriminated result the caller can act on WITHOUT a second interpretation pass:
//   { current: true }              → exit 0: the generation is current, proceed.
//   { current: false, stale: true } → exit 10 (FENCE_STALE_EXIT): a takeover
//                                      bumped past us; we are a stale/partitioned
//                                      generation → the side-effect must be rejected.
//   { current: false, stale: false }→ ANY other failure (spawn error, timeout,
//                                      other non-zero exit, unparseable stdout).
//
// FAIL-CLOSED for a destructive caller: this returns current:false (NOT current)
// on every non-success, so the only path that yields current:true is an explicit
// exit-0 from the fence CLI. A stop-worker caller treats current:false as "do not
// kill" — the conservative answer when the fence cannot be affirmatively
// confirmed (we never SIGKILL a worker on an uncertain or errored fence read).
// `stale` distinguishes the verified-stale rejection (the Gherkin "fenced out"
// case) from an indeterminate failure for honest UI messaging.
//
// `spawn`/`nodeBin`/`cli`/`env`/`timeout` are injectable so the unit tests never
// spawn a real process.
export function fenceCheckSync(
  { ticket, generation },
  {
    spawn = spawnSync,
    nodeBin = process.execPath,
    cli = CLUSTER_CLAIM_CLI,
    env = process.env,
    timeout = CLAIM_TIMEOUT_MS,
  } = {},
) {
  try {
    const res = spawn(nodeBin, [cli, "fence-check", ticket, String(generation)], {
      encoding: "utf8",
      env,
      timeout,
    });
    if (!res) return { current: false, stale: false };
    if (res.status === 0) return { current: true, stale: false };
    if (res.status === FENCE_STALE_EXIT) return { current: false, stale: true };
    // Any other exit / spawn error / timeout: indeterminate → not current, not
    // verified-stale. Fail-closed for the destructive caller.
    return { current: false, stale: false };
  } catch {
    return { current: false, stale: false };
  }
}

// ─── in-process TTL cache around the fence read (CTL-863 fleet-unfreeze, urgent interim) ──
//
// The CTL-863 fence guards (fenceGuard, fence-guard.mjs) call fenceCheckSync
// before EVERY external-write site — ~11 call sites across scheduler.mjs,
// recovery.mjs, and stale-pr-rescue-timer.mjs. Each call spawns a FRESH `node
// cluster-claim.mjs fence-check <ticket> <gen>` subprocess (a new process, so
// caching INSIDE cluster-claim.mjs would be cold every time) that issues
// Linear's `query ReadFence` (an attachment read). Live-proxy-confirmed at
// ~5,000/hr — 62% of ALL Linear traffic on the shared app-actor bucket —
// saturating it and tripping the CTL-679 rate-limit breaker open, which
// freezes fleet dispatch entirely.
//
// fenceCheckSyncCached wraps fenceCheckSync with an in-process TTL cache that
// lives in THIS module (imported once by the long-running daemon process —
// scheduler.mjs / recovery.mjs / stale-pr-rescue-timer.mjs — so the Map
// persists across calls, unlike the per-call subprocess). Keyed by
// `${ticket}::${generation}`, NOT ticket alone: isFenceCurrent's answer is a
// function of BOTH — a takeover can leave the same ticket at a different
// current generation, so two different generations asked about the same
// ticket are NOT interchangeable answers.
//
// The underlying fence only changes on the heartbeat cadence (~2 min,
// cluster-heartbeat.mjs), so caching a read for up to 45s cannot observe a
// staler fence than genuinely existed at write time — safe by construction,
// not a race. This is the INTERIM stopgap; the durable fix replaces the
// read-per-check pattern with an event-log-derived fence (see
// thoughts/shared/plans/2026-07-03-fence-to-eventlog.md).
//
// Only a DETERMINATE read is cached: {current:true} or {current:false,
// stale:true} (a confirmed non-current generation). The indeterminate bucket —
// {current:false, stale:false}, i.e. a spawn error/timeout/other exit — is a
// FAILURE, not an answer. fenceGuard fail-closes on it (suppresses the write),
// so caching a transient hiccup would extend a false "not current" verdict for
// the full TTL instead of retrying on the very next call. Never cached.
//
// CATALYST_FENCE_READ_CACHE_MS — TTL override in ms, read from the same `env`
// seam fenceCheckSync already threads through to the spawned subprocess. 0
// disables the cache entirely (every call falls through to a real
// fenceCheckSync) — an escape hatch for debugging/verification. Unset/invalid
// → the 45s default.
const FENCE_READ_CACHE_MS_DEFAULT = 45_000;

// fenceReadCache — module-scope Map(`${ticket}::${generation}` -> {result, ts}).
const fenceReadCache = new Map();

// clearFenceReadCache — test-only reset of the module-scope cache between cases.
export function clearFenceReadCache() {
  fenceReadCache.clear();
}

function resolveFenceReadCacheMs(env) {
  const raw = Number(env?.CATALYST_FENCE_READ_CACHE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : FENCE_READ_CACHE_MS_DEFAULT;
}

// fenceCheckSyncCached — the cached entry point. fence-guard.mjs's default
// `check` seam points here so every real external-write-site fence check
// benefits without any change to fenceGuard's decision logic or fail-closed
// semantics — this only decides whether to skip the underlying read, never
// what the read means. `now`/`env` are injectable for tests; every other
// option (`spawn`/`nodeBin`/`cli`/`timeout`) passes straight through to
// fenceCheckSync unchanged on a cache miss.
export function fenceCheckSyncCached({ ticket, generation }, { now = Date.now, env = process.env, ...rest } = {}) {
  const ttlMs = resolveFenceReadCacheMs(env);
  const key = `${ticket}::${generation}`;
  if (ttlMs > 0) {
    const cached = fenceReadCache.get(key);
    if (cached && now() - cached.ts < ttlMs) {
      return cached.result;
    }
  }
  const result = fenceCheckSync({ ticket, generation }, { env, ...rest });
  // Cache only a determinate read (never the indeterminate/error bucket).
  if (ttlMs > 0 && (result.current === true || result.stale === true)) {
    fenceReadCache.set(key, { result, ts: now() });
  }
  return result;
}

// ─── in-process TTL cache around the triage attempt count read (CTL-1649) ────
//
// The triage re-dispatch cap gate (monitor.mjs dispatchTriage) calls
// readTriageAttemptCountSync before EVERY triage sweep sweep for each
// multi-host candidate. Each call spawns a FRESH `node cluster-claim.mjs
// read-triage-attempt <ticket>` subprocess that issues a Linear attachment
// read. A TTL cache mirrors fenceCheckSyncCached's design: keyed by ticket
// (not ticket+generation — the count is the answer, not a generation check),
// TTL 30s default (CATALYST_TRIAGE_ATTEMPT_CACHE_MS). Bumps always invalidate
// the cache entry so a fresh count is visible on the very next cap-gate read.
//
// Only a determinate numeric count (>= 0) is cached. A null (fence-absent or
// spawn failure) is never cached — null is the fail-open signal, and latching
// it would suppress all future reads for the TTL duration.
const TRIAGE_ATTEMPT_CACHE_MS_DEFAULT = 30_000;
const triageAttemptCache = new Map();

// clearTriageAttemptCacheSync — test-only reset of the module-scope cache.
export function clearTriageAttemptCacheSync() {
  triageAttemptCache.clear();
}

function resolveTriageAttemptCacheMs(env) {
  const raw = Number(env?.CATALYST_TRIAGE_ATTEMPT_CACHE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : TRIAGE_ATTEMPT_CACHE_MS_DEFAULT;
}

// readTriageAttemptCountSync — spawn `node cluster-claim.mjs read-triage-attempt
// <ticket>` and return `{ count }`. `count` is the fleet-wide triage attempt
// count (>= 0) when a fence exists, or null when no fence is found (fence-absent
// → caller fails open to host-local counting). Also null on any spawn failure.
// A TTL cache (keyed by ticket) coalesces repeated reads within the same sweep
// cycle. `now` is injectable for tests.
export function readTriageAttemptCountSync(
  { ticket },
  {
    spawn = spawnSync,
    nodeBin = process.execPath,
    cli = CLUSTER_CLAIM_CLI,
    env = process.env,
    timeout = CLAIM_TIMEOUT_MS,
    now = Date.now,
  } = {},
) {
  const ttlMs = resolveTriageAttemptCacheMs(env);
  if (ttlMs > 0) {
    const cached = triageAttemptCache.get(ticket);
    if (cached && now() - cached.ts < ttlMs) {
      return { count: cached.count };
    }
  }
  try {
    const res = spawn(nodeBin, [cli, "read-triage-attempt", ticket], {
      encoding: "utf8",
      env,
      timeout,
    });
    if (!res || res.status !== 0 || typeof res.stdout !== "string") {
      return { count: null };
    }
    const line = res.stdout.trim().split("\n").filter(Boolean).pop();
    const parsed = JSON.parse(line);
    const count = typeof parsed?.count === "number" ? parsed.count : null;
    if (ttlMs > 0 && count !== null) {
      triageAttemptCache.set(ticket, { count, ts: now() });
    }
    return { count };
  } catch {
    return { count: null };
  }
}

// bumpTriageAttemptCountSync — spawn `node cluster-claim.mjs bump-triage-attempt
// <ticket>`. Always invalidates the TTL cache for that ticket (a bump means the
// stored count is now stale — the next read must go live). Returns `{ count }`
// where `count` is the new fleet-wide count on success, or null on any failure
// (best-effort — never throws).
export function bumpTriageAttemptCountSync(
  { ticket },
  {
    spawn = spawnSync,
    nodeBin = process.execPath,
    cli = CLUSTER_CLAIM_CLI,
    env = process.env,
    timeout = CLAIM_TIMEOUT_MS,
  } = {},
) {
  // Invalidate before the spawn: even if the write fails, the caller
  // (bumpTriageDispatchCount in monitor.mjs) is about to act on the count
  // having changed — stale cached reads post-bump are always wrong.
  triageAttemptCache.delete(ticket);
  try {
    const res = spawn(nodeBin, [cli, "bump-triage-attempt", ticket], {
      encoding: "utf8",
      env,
      timeout,
    });
    if (!res || res.status !== 0 || typeof res.stdout !== "string") {
      return { count: null };
    }
    const line = res.stdout.trim().split("\n").filter(Boolean).pop();
    const parsed = JSON.parse(line);
    const count = typeof parsed?.count === "number" ? parsed.count : null;
    return { count };
  } catch {
    return { count: null };
  }
}
