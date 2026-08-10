#!/usr/bin/env node
// cluster-heartbeat-sync.mjs — synchronous bridge over the async
// cluster-heartbeat CLI (CTL-1090).
//
// Why this exists: the execution-core dispatch paths (scheduler.mjs, recovery.mjs
// reclaimDeadHostWork) are synchronous, and the cross-host liveness channel is
// async (fetch-based, in cluster-heartbeat.mjs). Rather than make those paths
// async, we drive the liveness publish/read through spawnSync of
// `node cluster-heartbeat.mjs …` — the same sync-subprocess convention the
// daemon already uses for Linear writes (cluster-claim-sync.mjs mirrors
// cluster-claim.mjs via the same pattern).
//
// FAIL-OPEN contract: ANY failure — spawn error, timeout, non-zero exit, or
// unparseable stdout — is reported as { ok: false } (publish) or {} (read).
// A Linear hiccup must NEVER break liveness: worst case a peer briefly looks
// stale, and the 10-min grace absorbs it.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// CLUSTER_HEARTBEAT_CLI — absolute path to the CLI, resolved relative to this
// module so it works regardless of the daemon's cwd.
const CLUSTER_HEARTBEAT_CLI = fileURLToPath(
  new URL("./cluster-heartbeat.mjs", import.meta.url),
);

// LIVENESS_TIMEOUT_MS — hard cap on publish/read subprocesses. 15s is generous
// for a healthy API and bounds a hung call. Overridable for tests / slow networks.
const LIVENESS_TIMEOUT_MS =
  Number(process.env.EXECUTION_CORE_LIVENESS_TIMEOUT_MS) || 15_000;

// ─── permanent in-process cache: anchor identifier → issue UUID (CTL-863 fleet-unfreeze, entourage follow-up to #2552) ──
//
// #2552 cached the ReadFence read (82% of the fence traffic) in cluster-claim-sync.mjs
// via fenceCheckSyncCached, but left the "entourage" queries uncached: every heartbeat
// publish resolves the anchor issue's identifier → UUID via `query ResolveIssueId`, even
// though the SAME anchor identifier is resolved on EVERY ~2min publish tick from EVERY
// host in the cluster (LIVENESS_PUBLISH_INTERVAL_MS) — and that UUID can never change for
// a given identifier once Linear assigns it. So unlike the ReadFence read (a TTL cache,
// because the underlying claim/fence state genuinely changes on a cadence), this is safe
// to cache PERMANENTLY — there is no staleness window to reason about at all.
//
// resolveIssueId is itself bundled inside the `publish` CLI subcommand (a single
// subprocess call must still do both the resolve AND the attachmentCreate write), so
// caching it in-process here means: pre-resolve the UUID via the small standalone
// `resolve-anchor` subcommand (ONE tiny subprocess call, cached after the first success),
// then pass the resolved UUID into `publish` so ITS internal resolveIssueId call is
// skipped. A cache miss/disable falls back to the pre-follow-up behavior byte-for-byte
// (publish resolves the anchor itself).
//
// CATALYST_ANCHOR_UUID_CACHE — "0" disables (every call re-resolves); any other value
// (including unset) keeps the cache on. There is no TTL knob — the whole point is that
// this mapping never goes stale.
const anchorUuidCache = new Map();

// clearAnchorUuidCache — test-only reset of the module-scope cache between cases.
export function clearAnchorUuidCache() {
  anchorUuidCache.clear();
}

function anchorUuidCacheEnabled(env) {
  return env?.CATALYST_ANCHOR_UUID_CACHE !== "0";
}

// resolveAnchorIssueIdSync — spawn `node cluster-heartbeat.mjs resolve-anchor <anchor>`
// and return the resolved UUID, or null on ANY failure (spawn error, timeout, non-zero
// exit, unparseable stdout, or a resolution miss) — fail-open: the caller treats null as
// "could not pre-resolve" and falls back to letting `publish` resolve it inline, exactly
// as before this follow-up. `spawn`/`nodeBin`/`cli`/`env`/`timeout` are injectable so unit
// tests never spawn a real process.
export function resolveAnchorIssueIdSync(
  { anchorIssue },
  {
    spawn = spawnSync,
    nodeBin = process.execPath,
    cli = CLUSTER_HEARTBEAT_CLI,
    env = process.env,
    timeout = LIVENESS_TIMEOUT_MS,
  } = {},
) {
  try {
    const res = spawn(nodeBin, [cli, "resolve-anchor", anchorIssue], {
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

// resolveAnchorIssueIdSyncCached — the cached entry point. Checks the permanent Map
// first; a hit returns immediately with ZERO subprocess spawn. A miss spawns
// resolveAnchorIssueIdSync and caches ONLY a truthy (successfully resolved) UUID — a
// null (any failure) is never cached, so the very next call retries for real instead of
// latching a transient hiccup forever. `now`/`env` are the test seams (mirroring
// fenceCheckSyncCached in cluster-claim-sync.mjs); every other option passes straight
// through to resolveAnchorIssueIdSync on a miss.
export function resolveAnchorIssueIdSyncCached({ anchorIssue }, { env = process.env, ...rest } = {}) {
  if (!anchorUuidCacheEnabled(env)) {
    return resolveAnchorIssueIdSync({ anchorIssue }, { env, ...rest });
  }
  const cached = anchorUuidCache.get(anchorIssue);
  if (cached) return cached;
  const issueId = resolveAnchorIssueIdSync({ anchorIssue }, { env, ...rest });
  if (issueId) anchorUuidCache.set(anchorIssue, issueId);
  return issueId;
}

// publishHeartbeatSync — publish this host's liveness record synchronously.
// Returns { ok: true } on success, { ok: false, error } on any failure (fail-open).
// CTL-1251: the failure path now carries a short `error` reason (exit code +
// stderr tail / spawn error / timeout / unparseable) so the publisher tick can
// LOG why a publish failed — previously every failure was a silent { ok: false }
// and a post-restart non-publish was undiagnosable. Callers must still treat any
// non-ok as fail-open and never throw.
// `spawn`/`nodeBin`/`cli`/`env`/`timeout` are injectable for unit tests.
// CTL-863 follow-up: `resolveIssueId` is the injectable pre-resolve seam (defaults to
// resolveAnchorIssueIdSyncCached) — a resolved UUID is threaded into the `publish` argv
// so that subprocess skips its own ResolveIssueId call. A null (cache miss that also
// failed to resolve, or the cache disabled AND the resolve failing) falls back to the
// pre-follow-up 4-arg form untouched.
export function publishHeartbeatSync(
  { anchorIssue, host, inFlightTickets = [], maxParallel = null, lastAdvanceAt = null },
  {
    spawn = spawnSync,
    nodeBin = process.execPath,
    cli = CLUSTER_HEARTBEAT_CLI,
    env = process.env,
    timeout = LIVENESS_TIMEOUT_MS,
    resolveIssueId = resolveAnchorIssueIdSyncCached,
  } = {},
) {
  try {
    const ticketsCsv = inFlightTickets.join(",");
    const issueId = resolveIssueId({ anchorIssue }, { spawn, nodeBin, cli, env, timeout });
    // CTL-1092: append max_parallel as a 4th arg ONLY when it resolves to a
    // positive int. A host that can't resolve its slot count still publishes
    // liveness via the back-compat 3-arg form (the CLI reads it as null).
    const argv = [cli, "publish", anchorIssue, host, ticketsCsv];
    if (Number.isInteger(maxParallel) && maxParallel > 0) {
      argv.push(String(maxParallel));
    } else if (issueId) {
      // Keep the positional 5th slot for issueId even with no maxParallel to report.
      argv.push("");
    }
    if (issueId) argv.push(issueId);
    if (lastAdvanceAt != null) argv.push(`--last-advance-at=${lastAdvanceAt}`);
    const res = spawn(nodeBin, argv, {
      encoding: "utf8",
      env,
      timeout,
    });
    if (!res || res.status !== 0 || typeof res.stdout !== "string") {
      return { ok: false, error: describeSpawnFailure(res) };
    }
    const line = res.stdout.trim().split("\n").filter(Boolean).pop();
    JSON.parse(line); // validate parseable; value not needed
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// describeSpawnFailure — render a short, log-safe reason from a spawnSync result
// (CTL-1251). Covers the three non-throwing failure shapes: a timeout/spawn error
// (res.error set, status null), a non-zero exit (status + stderr tail), and a
// missing/!string stdout. Truncates stderr so a noisy subprocess can't bloat the
// daemon log line. A heartbeat publish carries no secret, so stderr is safe to log.
function describeSpawnFailure(res) {
  if (!res) return "no spawn result";
  if (res.error) return `spawn error: ${res.error.message || String(res.error)}`;
  const stderr = typeof res.stderr === "string" ? res.stderr.trim().slice(-200) : "";
  if (res.status !== 0) {
    return `exit ${res.status}${stderr ? `: ${stderr}` : ""}`;
  }
  return "missing stdout";
}

// readPeerHeartbeatsSync — read all peer liveness records synchronously.
// Returns { [host]: rec } on success, {} on any failure (fail-open).
// `spawn`/`nodeBin`/`cli`/`env`/`timeout` are injectable for unit tests.
export function readPeerHeartbeatsSync(
  { anchorIssue },
  {
    spawn = spawnSync,
    nodeBin = process.execPath,
    cli = CLUSTER_HEARTBEAT_CLI,
    env = process.env,
    timeout = LIVENESS_TIMEOUT_MS,
    // CTL-1091 (Codex P1 follow-up): when TRUE, a DETERMINATE read FAILURE (spawn
    // error, timeout, nonzero exit, non-string/unparseable/non-object stdout) THROWS
    // instead of collapsing to `{}`. This lets the strict DISPATCH liveness path
    // (readClusterHeartbeats requirePeerView → readPositiveLive → resolveDispatchRoster)
    // tell a FAILED peer read (→ full-roster outage fallback) apart from a genuinely
    // EMPTY but SUCCESSFUL read (status 0, no peers published yet → legitimate [self]).
    // Default false preserves the historical fail-open behavior recovery relies on:
    // every failure → `{}` (unseen ≠ dead → never reclaim).
    strict = false,
  } = {},
) {
  try {
    const res = spawn(nodeBin, [cli, "read", anchorIssue], {
      encoding: "utf8",
      env,
      timeout,
    });
    if (!res || res.status !== 0 || typeof res.stdout !== "string") {
      if (strict)
        throw new Error(
          `ctl-1091: peer heartbeat read failed (status=${res?.status ?? "none"}) — indeterminate peer view`,
        );
      return {};
    }
    const line = res.stdout.trim().split("\n").filter(Boolean).pop();
    if (!line) return {}; // status 0, no data → genuinely empty (a determinate success)
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      if (strict) throw new Error("ctl-1091: peer heartbeat read returned a malformed payload");
      return {};
    }
    return parsed;
  } catch (err) {
    if (strict) throw err; // preserve the failure for the strict dispatch path
    return {};
  }
}

// ─── 45s TTL cache: peer-heartbeat read (CTL-863 fleet-unfreeze, entourage follow-up to #2552) ──
//
// readPeerHeartbeatsSync's `read` subcommand issues the SAME anchor-issue lookup
// (fetch the issue by identifier + its attachments) as the fence's ReadFence read that
// fenceCheckSyncCached already caches in cluster-claim-sync.mjs — just against the
// heartbeat anchor instead of a per-ticket fence, and via a completely separate
// subprocess/cache scope (this file never imports cluster-claim-sync.mjs, matching the
// existing PR-order-independent, no-cross-module-import convention the two cluster-*
// modules already follow). recovery.mjs's dead-host detection (readClusterHeartbeats,
// defaultOwnedTicketsForHost) calls this every recovery pass, so it re-reads the SAME
// anchor issue on the SAME cadence the ReadFence traffic was flooding the shared
// app-actor bucket at. The underlying heartbeat data only changes on the ~2min publish
// cadence (LIVENESS_PUBLISH_INTERVAL_MS) and dead-host detection already tolerates a
// generous 10-min grace window, so a 45s cache cannot make a live host look staler than
// it already tolerates — safe by construction, exactly like the ReadFence cache's own
// rationale.
//
// CATALYST_FENCE_READ_CACHE_MS — reused verbatim (same env var, same 45s default) rather
// than a new sibling knob: both caches answer the identical question ("how fresh must an
// anchor-issue attachment read be before we trust the last answer without re-asking
// Linear?") for the SAME class of Linear traffic, so one shared TTL knob keeps the
// operator model simple. 0 disables the cache entirely.
const HEARTBEAT_READ_CACHE_MS_DEFAULT = 45_000;

// CTL-1092 follow-up (retry-storm fix, 2026-08-10): an empty read result (readPeerHeartbeatsSync
// collapses EVERY failure mode — spawn error, timeout, non-zero exit, a RATELIMITED/401 GraphQL
// rejection swallowed inside the subprocess, unparseable stdout — to the SAME `{}` it would also
// return for a genuinely-empty anchor) used to NEVER be cached, so every caller re-spawned the
// real subprocess read on EVERY call — including every ~5-9s scheduler tick, from EVERY host,
// for as long as the underlying Linear app-actor bucket stays exhausted. Observed live 2026-08-10:
// the shared orchestrator app-actor's 5000/hr bucket saturated, cross-host heartbeat reads started
// returning {} fleet-wide, and the uncached retry-every-tick behavior kept hammering that same
// already-exhausted bucket instead of backing off — amplifying the outage duration instead of
// letting it drain. An empty result is now cached too, but for a much SHORTER window than a
// successful non-empty read (CATALYST_HEARTBEAT_FAILURE_BACKOFF_MS, default 20s vs the 45s success
// TTL) — short enough to notice a real recovery quickly and well under the 5-min liveness grace
// window (node-liveness.mjs DEFAULT_LIVENESS_GRACE_MS), but long enough to cut retry volume
// several-fold during a sustained outage instead of firing on every scheduler tick. 0 disables
// the backoff (every empty result is treated as an immediate cache miss, matching the old
// never-cache-empty behavior).
const HEARTBEAT_FAILURE_BACKOFF_MS_DEFAULT = 20_000;

// heartbeatReadCache — module-scope Map(anchorIssue -> {peers, ts, empty}).
const heartbeatReadCache = new Map();

// clearHeartbeatReadCache — test-only reset of the module-scope cache between cases.
export function clearHeartbeatReadCache() {
  heartbeatReadCache.clear();
}

function resolveHeartbeatReadCacheMs(env) {
  const raw = Number(env?.CATALYST_FENCE_READ_CACHE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : HEARTBEAT_READ_CACHE_MS_DEFAULT;
}

function resolveHeartbeatFailureBackoffMs(env) {
  const raw = Number(env?.CATALYST_HEARTBEAT_FAILURE_BACKOFF_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : HEARTBEAT_FAILURE_BACKOFF_MS_DEFAULT;
}

// readPeerHeartbeatsSyncCached — the cached entry point. A hit within the TTL returns
// immediately with ZERO subprocess spawn (mirrors fenceCheckSyncCached). `now`/`env` are
// injectable test seams; every other option passes straight through to
// readPeerHeartbeatsSync on a cache miss.
//
// Two TTLs, keyed off the SAME cache entry: a non-empty (successful, real data) result is
// trusted for `ttlMs` (CATALYST_FENCE_READ_CACHE_MS, default 45s); an empty result — genuinely
// no peers published yet, OR any failure mode readPeerHeartbeatsSync swallowed to `{}` — is
// trusted for the much shorter `failureBackoffMs` (CATALYST_HEARTBEAT_FAILURE_BACKOFF_MS,
// default 20s) before the next call re-attempts a real read. See the constant's comment above
// for why an empty result is no longer left permanently uncached.
export function readPeerHeartbeatsSyncCached({ anchorIssue }, { now = Date.now, env = process.env, ...rest } = {}) {
  const ttlMs = resolveHeartbeatReadCacheMs(env);
  const failureBackoffMs = resolveHeartbeatFailureBackoffMs(env);
  const cached = heartbeatReadCache.get(anchorIssue);
  if (cached) {
    const effectiveTtl = cached.empty ? failureBackoffMs : ttlMs;
    if (effectiveTtl > 0 && now() - cached.ts < effectiveTtl) return cached.peers;
  }
  const peers = readPeerHeartbeatsSync({ anchorIssue }, { env, ...rest });
  const isEmpty = !peers || Object.keys(peers).length === 0;
  if (isEmpty ? failureBackoffMs > 0 : ttlMs > 0) {
    heartbeatReadCache.set(anchorIssue, { peers, ts: now(), empty: isEmpty });
  }
  return peers;
}
