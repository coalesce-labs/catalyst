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

// publishHeartbeatSync — publish this host's liveness record synchronously.
// Returns { ok: true } on success, { ok: false } on any failure (fail-open).
// `spawn`/`nodeBin`/`cli`/`env`/`timeout` are injectable for unit tests.
export function publishHeartbeatSync(
  { anchorIssue, host, inFlightTickets = [] },
  {
    spawn = spawnSync,
    nodeBin = process.execPath,
    cli = CLUSTER_HEARTBEAT_CLI,
    env = process.env,
    timeout = LIVENESS_TIMEOUT_MS,
  } = {},
) {
  try {
    const ticketsCsv = inFlightTickets.join(",");
    const res = spawn(nodeBin, [cli, "publish", anchorIssue, host, ticketsCsv], {
      encoding: "utf8",
      env,
      timeout,
    });
    if (!res || res.status !== 0 || typeof res.stdout !== "string") return { ok: false };
    const line = res.stdout.trim().split("\n").filter(Boolean).pop();
    JSON.parse(line); // validate parseable; value not needed
    return { ok: true };
  } catch {
    return { ok: false };
  }
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
  } = {},
) {
  try {
    const res = spawn(nodeBin, [cli, "read", anchorIssue], {
      encoding: "utf8",
      env,
      timeout,
    });
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
