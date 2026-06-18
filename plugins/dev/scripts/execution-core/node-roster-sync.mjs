#!/usr/bin/env node
// node-roster-sync.mjs — synchronous bridge over the async node-roster CLI
// (CTL-1273).
//
// Why this exists: getClusterHosts() in config.mjs is SYNCHRONOUS and called
// per scheduler tick, but the cluster-anchor roster source is async (fetch-based,
// in node-roster.mjs). Rather than make the hot path async, we drive the roster
// read through spawnSync of `node node-roster.mjs …` — the same sync-subprocess
// convention as cluster-heartbeat-sync.mjs.
//
// FAIL-OPEN contract: ANY failure — spawn error, timeout, non-zero exit, or
// unparseable stdout — is reported as { ok: false, names: [] }. A Linear hiccup
// must NEVER empty the roster: the resolver treats ok:false as "fall back to the
// next source" (static → hosts.json → single-host), never as an empty fleet that
// would mass-evict every peer under HRW.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// NODE_ROSTER_CLI — absolute path to the CLI, resolved relative to this module so
// it works regardless of the daemon's cwd.
const NODE_ROSTER_CLI = fileURLToPath(new URL("./node-roster.mjs", import.meta.url));

// ROSTER_TIMEOUT_MS — hard cap on the read subprocess. 15s is generous for a
// healthy API and bounds a hung call. Overridable for tests / slow networks.
const ROSTER_TIMEOUT_MS = Number(process.env.EXECUTION_CORE_ROSTER_TIMEOUT_MS) || 15_000;

// readNodeNamesSync — read the enrolled node names from the anchor synchronously.
// Returns { ok: true, names } on a successful read (names may be []), or
// { ok: false, names: [] } on any failure (fail-open). `ok` lets the resolver
// distinguish "anchor unreadable" from "anchor read OK".
// `spawn`/`nodeBin`/`cli`/`env`/`timeout` are injectable for unit tests.
export function readNodeNamesSync(
  { anchorIssue },
  {
    spawn = spawnSync,
    nodeBin = process.execPath,
    cli = NODE_ROSTER_CLI,
    env = process.env,
    timeout = ROSTER_TIMEOUT_MS,
  } = {}
) {
  try {
    const res = spawn(nodeBin, [cli, "names", anchorIssue], {
      encoding: "utf8",
      env,
      timeout,
    });
    if (!res || res.status !== 0 || typeof res.stdout !== "string") {
      return { ok: false, names: [] };
    }
    const line = res.stdout.trim().split("\n").filter(Boolean).pop();
    if (!line) return { ok: false, names: [] };
    const parsed = JSON.parse(line);
    if (!Array.isArray(parsed)) return { ok: false, names: [] };
    const names = parsed.filter((n) => typeof n === "string" && n.length > 0);
    return { ok: true, names };
  } catch {
    return { ok: false, names: [] };
  }
}

// registerNodeSync — upsert a node enrollment record on the anchor synchronously.
// Returns { ok: true } on success, { ok: false, error } on any failure. Unlike
// the read path, the CLI writer surfaces the error so the operator sees it.
export function registerNodeSync(
  { anchorIssue, name, address = null },
  {
    spawn = spawnSync,
    nodeBin = process.execPath,
    cli = NODE_ROSTER_CLI,
    env = process.env,
    timeout = ROSTER_TIMEOUT_MS,
  } = {}
) {
  try {
    const args = [cli, "register", anchorIssue, name];
    if (address) args.push(address);
    const res = spawn(nodeBin, args, { encoding: "utf8", env, timeout });
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

// deregisterNodeSync — delete a node enrollment record from the anchor
// synchronously. Returns { ok: true, removed } on success, { ok: false, error }
// on any failure.
export function deregisterNodeSync(
  { anchorIssue, name },
  {
    spawn = spawnSync,
    nodeBin = process.execPath,
    cli = NODE_ROSTER_CLI,
    env = process.env,
    timeout = ROSTER_TIMEOUT_MS,
  } = {}
) {
  try {
    const res = spawn(nodeBin, [cli, "deregister", anchorIssue, name], {
      encoding: "utf8",
      env,
      timeout,
    });
    if (!res || res.status !== 0 || typeof res.stdout !== "string") {
      return { ok: false, error: describeSpawnFailure(res) };
    }
    const line = res.stdout.trim().split("\n").filter(Boolean).pop();
    const parsed = JSON.parse(line);
    return { ok: true, removed: Boolean(parsed?.removed) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// describeSpawnFailure — render a short, log-safe reason from a spawnSync result.
// Mirrors cluster-heartbeat-sync.mjs. Truncates stderr so a noisy subprocess can't
// bloat a log line.
function describeSpawnFailure(res) {
  if (!res) return "no spawn result";
  if (res.error) return `spawn error: ${res.error.message || String(res.error)}`;
  const stderr = typeof res.stderr === "string" ? res.stderr.trim().slice(-200) : "";
  if (res.status !== 0) {
    return `exit ${res.status}${stderr ? `: ${stderr}` : ""}`;
  }
  return "missing stdout";
}
