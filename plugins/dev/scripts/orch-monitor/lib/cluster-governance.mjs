// cluster-governance.mjs — CTL-1104. Per-host governance snapshot reader.
// Generalizes execution-core/cli/governance.mjs::readLatestGovernance (single-
// host, CLI-only) to the full cluster roster. Pure + injectable; no bun:sqlite.
//
// SINGLE-HOST IDENTITY NO-OP: roster length <= 1 sets singleHost:true.
// Mirrors the classifyHostLiveness drift-guard pattern from node-liveness.mjs —
// tests import both and assert identical classification so governance freshness
// can never diverge from host liveness.
//
// Cross-reference: execution-core/cli/governance.mjs does the same per-host
// parse loop for a single host; both are intentionally kept separate to avoid
// dragging the CLI module into the monitor's import graph.

import { readFileSync } from "node:fs";
import {
  classifyHostLiveness,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_LIVENESS_GRACE_MS,
} from "./node-liveness.mjs";

// Lazy-load the execution-core config (VITE-GRAPH GUARD, CTL-883): the config
// module pulls pino + Node deps that break esbuild/vite browser bundling if they
// appear in any static import chain. We compute the specifier at module-eval so
// vite's static analysis never sees it as a resolvable import. Best-effort: if
// the module is absent (e.g. running in a stripped test environment without
// execution-core), we degrade to empty defaults.
const CONFIG_SPECIFIER = ["../execution-core/config.mjs"].join("");
let _config = null;
try {
  _config = await import(CONFIG_SPECIFIER);
} catch {
  // config unavailable — callers that pass logPath + roster explicitly are unaffected
}

const HEARTBEAT_EVENT = "node.heartbeat";

/**
 * readClusterGovernance — scan the event log for the latest node.heartbeat per
 * roster host and return each host's governance snapshot + staleness metadata.
 *
 * @param {object} [opts]
 * @param {string}   [opts.logPath]    path to the unified event log (default: config)
 * @param {string[]} [opts.roster]     cluster host list (default: config)
 * @param {number}   [opts.now]        epoch ms, injectable for tests (default: Date.now())
 * @param {number}   [opts.intervalMs] heartbeat cadence threshold
 * @param {number}   [opts.graceMs]    liveness grace window
 * @returns {{ singleHost: boolean, generatedAt: string, nodes: ClusterGovernanceNode[] }}
 */
export function readClusterGovernance({
  logPath = _config?.getEventLogPath?.() ?? "",
  roster = _config?.getClusterHosts?.() ?? [],
  now = Date.now(),
  intervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
  graceMs = DEFAULT_LIVENESS_GRACE_MS,
} = {}) {
  const hosts = Array.isArray(roster) ? roster : [];

  // Single pass over the log: keep the latest heartbeat ts + governance per host.
  /** @type {Map<string, { ts: string, governance: Record<string, unknown> | null }>} */
  const best = new Map();

  let raw = "";
  try {
    raw = readFileSync(logPath, "utf8");
  } catch {
    // Missing log → all hosts will be offline (empty best map).
  }

  for (const line of raw.split("\n")) {
    if (!line || !line.includes(HEARTBEAT_EVENT)) continue;
    let evt;
    try { evt = JSON.parse(line); } catch { continue; }
    if (evt?.attributes?.["event.name"] !== HEARTBEAT_EVENT) continue;
    const host = evt?.body?.payload?.["host.name"] ?? evt?.resource?.["host.name"];
    if (typeof host !== "string" || host.length === 0) continue;
    const ts = evt?.ts;
    if (typeof ts !== "string" || ts.length === 0) continue;
    const gov = evt?.body?.payload?.governance ?? null;
    const current = best.get(host);
    if (!current || ts > current.ts) {
      best.set(host, { ts, governance: gov });
    }
  }

  // Map roster to nodes.
  const nodes = hosts.map((host) => {
    const entry = best.get(host);
    if (!entry) {
      return { host, governance: null, reportedAt: null, ageMs: null, status: /** @type {"offline"} */ ("offline") };
    }
    const reportedAt = entry.ts;
    const parsed = Date.parse(reportedAt);
    const ageMs = Number.isFinite(parsed) ? Math.max(0, now - parsed) : null;
    const status = classifyHostLiveness(reportedAt, now, { intervalMs, graceMs });
    return { host, governance: entry.governance, reportedAt, ageMs, status };
  });

  return {
    singleHost: hosts.length <= 1,
    generatedAt: new Date(now).toISOString(),
    nodes,
  };
}
