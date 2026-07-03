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

// claimDispatchSync — soft-CAS claim `ticket` for `hostName` at `phase`,
// synchronously. Returns { won, generation }. won:false on any failure
// (fail-closed). `spawn`/`nodeBin`/`cli`/`env`/`timeout` are injectable so the
// unit tests never spawn a real process.
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
    if (!res || res.status !== 0 || typeof res.stdout !== "string") {
      return { won: false, generation: null };
    }
    // The CLI prints exactly one JSON line; take the last non-empty line defensively.
    const line = res.stdout.trim().split("\n").filter(Boolean).pop();
    const parsed = JSON.parse(line);
    return {
      won: parsed?.won === true,
      generation: Number.isFinite(parsed?.generation) ? parsed.generation : null,
    };
  } catch {
    return { won: false, generation: null };
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
