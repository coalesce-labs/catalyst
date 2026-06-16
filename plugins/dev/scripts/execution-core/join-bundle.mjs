// join-bundle.mjs — CTL-1183. Assembles the SHARED-only cluster join-bundle
// from Layer-1 + Layer-2 config. Pure function — no network, no side effects.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { getClusterHosts, getLivenessAnchorIssue } from "./config.mjs";

export const JOIN_BUNDLE_SCHEMA_VERSION = 1;

function layer2Path() {
  return (
    process.env.CATALYST_LAYER2_CONFIG_FILE ||
    resolve(homedir(), ".config", "catalyst", "config.json")
  );
}

function layer1Path() {
  return (
    process.env.CATALYST_CONFIG_FILE ||
    resolve(process.cwd(), ".catalyst", "config.json")
  );
}

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function resolvePluginSourceUrl(l2) {
  const dirs = l2?.catalyst?.orchestration?.pluginDirs;
  const dir = Array.isArray(dirs) ? dirs[0] : dirs;
  if (typeof dir === "string" && dir) {
    try {
      return (
        execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], {
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        }).trim() || null
      );
    } catch {
      /* fall through to repoUrl */
    }
  }
  return null;
}

export function assembleJoinBundle() {
  const l1 = readJson(layer1Path());
  const l2 = readJson(layer2Path());
  const bot = l2?.catalyst?.linear?.bot ?? {};
  const repo = l2?.catalyst?.repository ?? {};
  const repoUrl = repo.org && repo.name ? `${repo.org}/${repo.name}` : null;

  return {
    schemaVersion: JOIN_BUNDLE_SCHEMA_VERSION,
    hostsRoster: getClusterHosts(),
    livenessAnchorIssue: getLivenessAnchorIssue(),
    botCreds: {
      orchestrator: bot.orchestrator ?? null,
      worker: bot.worker ?? null,
    },
    otlpEndpointHint:
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
      l2?.catalyst?.cluster?.otlpEndpointHint ||
      null,
    layer1Identity: {
      projectKey: l1?.catalyst?.projectKey ?? null,
      teamKey: l1?.catalyst?.linear?.teamKey ?? null,
      teamId: l1?.catalyst?.linear?.teamId ?? null,
      stateMap: l1?.catalyst?.linear?.stateMap ?? null,
    },
    repoUrl,
    pluginSourceUrl: resolvePluginSourceUrl(l2) || repoUrl,
  };
}

// Deep-redact secrets for logging. NEVER log assembleJoinBundle() output directly.
export function redactBundleForLog(bundle) {
  const out = { ...bundle };
  // Replace the entire botCreds subtree — these are keys-to-the-kingdom.
  out.botCreds = "[REDACTED]";
  return out;
}
