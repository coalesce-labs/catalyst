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
// Returns { ok: true } on success, { ok: false, error } on any failure (fail-open).
// CTL-1251: the failure path now carries a short `error` reason (exit code +
// stderr tail / spawn error / timeout / unparseable) so the publisher tick can
// LOG why a publish failed — previously every failure was a silent { ok: false }
// and a post-restart non-publish was undiagnosable. Callers must still treat any
// non-ok as fail-open and never throw.
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
