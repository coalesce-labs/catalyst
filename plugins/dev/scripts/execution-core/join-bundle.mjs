// join-bundle.mjs — CTL-1183. Assembles the SHARED-only cluster join-bundle
// from Layer-1 + Layer-2 config. Pure function — no network, no side effects.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { getClusterHosts, getLivenessAnchorIssue } from "./config.mjs";
import { listProjects } from "./registry.mjs";

export const JOIN_BUNDLE_SCHEMA_VERSION = 1;

function layer2Path() {
  return (
    process.env.CATALYST_LAYER2_CONFIG_FILE ||
    resolve(homedir(), ".config", "catalyst", "config.json")
  );
}

// Resolve the seed's own repoRoot from the execution-core registry — the
// daemon's authoritative team→repoRoot map — rather than process.cwd().
// CTL-1183 / PATH-B #3: `catalyst cluster join-token` arms this listener
// detached (nohup, cwd=HOME), so a cwd-relative .catalyst/config.json is
// absent and every layer1Identity field comes back null. The first registry
// project's repoRoot owns the committed .catalyst/{config,hosts}.json.
function registryRepoRoot() {
  try {
    const first = listProjects()[0];
    return first?.repoRoot || null;
  } catch {
    return null;
  }
}

function layer1Path() {
  if (process.env.CATALYST_CONFIG_FILE) return process.env.CATALYST_CONFIG_FILE;
  const root = registryRepoRoot();
  if (root) return resolve(root, ".catalyst", "config.json");
  return resolve(process.cwd(), ".catalyst", "config.json");
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
  // Pin CATALYST_CONFIG_FILE to the registry repoRoot for the rest of assembly
  // so the OTHER cwd-dependent read — getClusterHosts() via config.mjs
  // getCatalystRepoDir() — also resolves <repoRoot>/.catalyst/hosts.json instead
  // of falling back to the single-host default when this listener runs detached
  // (PATH-B #3). Guarded so an explicit override (and tests) always win.
  if (!process.env.CATALYST_CONFIG_FILE) {
    const root = registryRepoRoot();
    if (root)
      process.env.CATALYST_CONFIG_FILE = resolve(root, ".catalyst", "config.json");
  }
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
