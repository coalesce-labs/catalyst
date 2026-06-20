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
// absent and every layer1Identity field comes back null.
//
// CTL-1274: the cluster ROSTER no longer lives in a per-repo .catalyst/hosts.json
// (RETIRED) — it lives in the catalyst-cluster repo (getClusterHosts reads
// cluster.json independently of which repoRoot we pick). So this resolver no
// longer disambiguates by hosts.json ownership; it returns the registry's first
// project repoRoot (the daemon's primary/coordination team — insertion order),
// which supplies the Layer-1 identity (projectKey/teamKey/stateMap). On a
// multi-team seed an operator who needs a non-primary team's identity sets
// CATALYST_CONFIG_FILE explicitly (it always wins, in layer1Path + assembly).
function registryRepoRoot() {
  try {
    const projects = listProjects();
    if (!projects.length) return null;
    return projects[0]?.repoRoot || null;
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

// CTL-1284: extract the NON-SECRET webhook wiring a member needs to ingest
// inbound GitHub/Linear events — smee channel URLs + the per-team webhookId map
// that readAllLinearSecrets keys on. HMAC secrets are NEVER carried here; they
// travel via the SOPS secret-files path (cluster-sync.mjs). Returns null when the
// seed has no monitor block. The CONSUMER (merge_shared_config) gates writing
// these onto a member by roster length > 1 — a single-host member must NOT
// ingest webhooks (HRW no-op + claimDispatch skipped → double-dispatch).
function extractMonitorWebhooks(l2) {
  const monitor = l2?.catalyst?.monitor;
  if (!monitor || typeof monitor !== "object") return null;
  const out = {};

  const ghSmee = monitor.github?.smeeChannel;
  if (typeof ghSmee === "string" && ghSmee) {
    out.github = { smeeChannel: ghSmee };
  }

  const linear = monitor.linear;
  if (linear && typeof linear === "object" && !Array.isArray(linear)) {
    const lin = {};
    if (typeof linear.smeeChannel === "string" && linear.smeeChannel) {
      lin.smeeChannel = linear.smeeChannel;
    }
    // Per-team keyed entries: { ctl: {webhookId, smeeChannel, resourceTypes}, ... }.
    // Keep only non-secret identifiers; drop registeredAt and anything else.
    for (const key of Object.keys(linear)) {
      const entry = linear[key];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      if (typeof entry.webhookId !== "string" || !entry.webhookId) continue;
      const e = { webhookId: entry.webhookId };
      if (typeof entry.smeeChannel === "string" && entry.smeeChannel) {
        e.smeeChannel = entry.smeeChannel;
      }
      if (Array.isArray(entry.resourceTypes)) e.resourceTypes = entry.resourceTypes;
      lin[key] = e;
    }
    if (Object.keys(lin).length > 0) out.linear = lin;
  }

  return Object.keys(out).length > 0 ? out : null;
}

export function assembleJoinBundle() {
  // Pin CATALYST_CONFIG_FILE to the registry repoRoot so the cwd-dependent
  // Layer-1 identity read (layer1Path → <repoRoot>/.catalyst/config.json)
  // resolves the seed's committed identity instead of a missing cwd-relative
  // file when this listener runs detached (nohup, cwd=HOME; PATH-B #3). The
  // roster itself comes from the catalyst-cluster repo via getClusterHosts()
  // (CTL-1274) and is independent of this pin. Guarded so an explicit override
  // (and tests) always win.
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
    // CTL-1284: non-secret webhook wiring (smee channels + per-team webhookId
    // map). null when the seed has no monitor block. multiHost-gated by the
    // consumer; deliberately NOT in BUNDLE_REQUIRED_KEYS.
    monitorWebhooks: extractMonitorWebhooks(l2),
  };
}

// Deep-redact secrets for logging. NEVER log assembleJoinBundle() output directly.
export function redactBundleForLog(bundle) {
  const out = { ...bundle };
  // Replace the entire botCreds subtree — these are keys-to-the-kingdom.
  out.botCreds = "[REDACTED]";
  return out;
}
