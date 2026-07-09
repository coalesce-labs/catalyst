#!/usr/bin/env node
// loki-liveness-sync.mjs — synchronous bridge over the async loki-liveness CLI
// (CTL-1420 #17). recovery.mjs's dead-host detection (readClusterHeartbeats,
// defaultOwnedTicketsForHost) is synchronous; the Loki read is async (fetch), so we
// drive it through spawnSync of `node loki-liveness.mjs read <lokiUrl>` — the same
// sync-subprocess convention cluster-heartbeat-sync.mjs uses for the Linear read.
//
// FAIL-OPEN contract: ANY failure — spawn error, timeout, non-zero exit, or
// unparseable stdout — is reported as {}. A Loki hiccup must NEVER break liveness:
// an empty map makes deadHosts treat every peer as "never seen ⇒ alive" (no false
// reclaim), and the 10-min grace absorbs a brief blip.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const LOKI_LIVENESS_CLI = fileURLToPath(new URL("./loki-liveness.mjs", import.meta.url));

// Hard cap on the read subprocess. 8s is generous for a healthy Loki query (~70ms
// measured) and bounds a hung call well inside the 10-min dead-host grace.
const LOKI_LIVENESS_TIMEOUT_MS =
  Number(process.env.EXECUTION_CORE_LOKI_LIVENESS_TIMEOUT_MS) || 8_000;

// readClusterLivenessFromLokiSync — spawn `node loki-liveness.mjs read <lokiUrl>` and
// return the peer-liveness map { [host]: {last_seen, in_flight_tickets} }, or {} on
// ANY failure (fail-open). No lokiUrl → {} with zero spawn.
// `spawn`/`nodeBin`/`cli`/`env`/`timeout` are injectable for unit tests.
export function readClusterLivenessFromLokiSync(
  { lokiUrl },
  {
    spawn = spawnSync,
    nodeBin = process.execPath,
    cli = LOKI_LIVENESS_CLI,
    env = process.env,
    timeout = LOKI_LIVENESS_TIMEOUT_MS,
  } = {},
) {
  if (typeof lokiUrl !== "string" || lokiUrl.length === 0) return {};
  try {
    const res = spawn(nodeBin, [cli, "read", lokiUrl], { encoding: "utf8", env, timeout });
    if (!res || res.status !== 0 || typeof res.stdout !== "string") return {};
    const line = res.stdout.trim().split("\n").filter(Boolean).pop();
    if (!line) return {};
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

// ─── short TTL cache (mirrors readPeerHeartbeatsSyncCached) ──
// recovery reads liveness once per pass; a short cache avoids a subprocess spawn every
// pass. The heartbeat data changes on the 30s emit cadence and dead-host detection
// tolerates a 10-min grace, so a 20s cache can't make a live host look staler than
// already tolerated. EXECUTION_CORE_LOKI_LIVENESS_CACHE_MS overrides; 0 disables.
const LOKI_LIVENESS_CACHE_MS_DEFAULT = 20_000;
const livenessCache = new Map();

// clearLokiLivenessCache — test-only reset of the module-scope cache between cases.
export function clearLokiLivenessCache() {
  livenessCache.clear();
}

function resolveCacheMs(env) {
  const raw = Number(env?.EXECUTION_CORE_LOKI_LIVENESS_CACHE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : LOKI_LIVENESS_CACHE_MS_DEFAULT;
}

// readClusterLivenessFromLokiSyncCached — cached entry point. A hit within the TTL
// returns immediately with ZERO subprocess spawn. Only a NON-EMPTY result is cached:
// an empty {} is indistinguishable from a failed read, so it is never latched (the
// next call retries for real). `now`/`env` are injectable test seams.
export function readClusterLivenessFromLokiSyncCached({ lokiUrl }, { now = Date.now, env = process.env, ...rest } = {}) {
  const ttlMs = resolveCacheMs(env);
  if (ttlMs > 0) {
    const cached = livenessCache.get(lokiUrl);
    if (cached && now() - cached.ts < ttlMs) return cached.peers;
  }
  const peers = readClusterLivenessFromLokiSync({ lokiUrl }, { env, ...rest });
  if (ttlMs > 0 && peers && Object.keys(peers).length > 0) {
    livenessCache.set(lokiUrl, { peers, ts: now() });
  }
  return peers;
}
