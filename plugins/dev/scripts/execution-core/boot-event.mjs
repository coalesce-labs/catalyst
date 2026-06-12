// boot-event.mjs — CTL-1084. Structured "node.boot" self-report appended to
// the unified event log so `catalyst-stack status` can prove what a restart
// did. Mirrors heartbeat-event.mjs (OTel envelope, appendFileSync, NEVER throws).
import { mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getEventLogPath, getHostName, log, readGovernanceConfig, readGovernanceSources,
} from "./config.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
// plugins/dev/scripts/execution-core/ → plugins/dev/scripts/ → plugins/dev/
// → plugins/dev/.claude-plugin/plugin.json
const DEFAULT_MANIFEST = join(__dir, "..", "..", ".claude-plugin", "plugin.json");

export function readPluginVersion(manifestPath = DEFAULT_MANIFEST) {
  try { return JSON.parse(readFileSync(manifestPath, "utf8"))?.version ?? "unknown"; }
  catch { return "unknown"; }
}

export function buildBootEnvelope({
  now,
  pluginVersionFn = readPluginVersion,
  governanceFn = readGovernanceConfig,
  sourcesFn = readGovernanceSources,
  summary = {},
} = {}) {
  const ts = now ? now() : new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const host = getHostName();
  return {
    ts,
    attributes: { "event.name": "node.boot" },
    resource: { "host.name": host },
    body: {
      payload: {
        "host.name": host,
        plugin_version: pluginVersionFn(),
        effective_flags: governanceFn(),
        flag_sources: sourcesFn(),
        adopted_workers:   summary.adoptedWorkers   ?? 0,
        zombies_cleared:   summary.zombiesCleared   ?? 0,
        rewalk_planned:    summary.rewalkPlanned    ?? 0,
        rewalk_dispatched: summary.rewalkDispatched ?? 0,
      },
    },
  };
}

export function emitBootEvent({ logPath = getEventLogPath(), ...opts } = {}) {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, JSON.stringify(buildBootEnvelope(opts)) + "\n");
  } catch (err) {
    log?.warn?.({ err: err?.message }, "emitBootEvent failed (continuing)");
  }
}
