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
// inbound GitHub events — the smee channel URL. HMAC secrets are NEVER carried
// here; they travel via the SOPS secret-files path (cluster-sync.mjs). Returns
// null when the seed has no monitor block. The CONSUMER (merge_shared_config)
// gates writing these onto a member by roster length > 1 — a single-host member
// must NOT ingest webhooks (HRW no-op + claimDispatch skipped → double-dispatch).
//
// ⛔ CTL-1928: the LINEAR half is deliberately NOT carried any more. Linear
// ingestion is the cloud feed (`cloud-feed-timer.mjs`, `CATALYST_CLOUD_FEED`),
// and the workspace's 7 Linear webhook subscriptions were retired when the
// fleet cut over. Propagating `linear.smeeChannel` would silently RE-CREATE the
// retired path on every new join: `readLinearSmeeChannel` (orch-monitor's
// webhook-config.ts) falls back to the FIRST per-team entry's `smeeChannel`, so
// even a bundle carrying only the per-team map — no top-level channel — is
// enough to start a Linear tunnel on the joining host. That is why the whole
// `linear` block goes, rather than just the top-level key.
//
// Dropping the per-team `webhookId` map with it is deliberate too, and it is
// what keeps `catalyst doctor` honest: its `webhook-ingestion` check FAILs a
// member carrying a `webhookId` whose HMAC secret does not resolve ("half-wired
// … config residue"). A joining host has no reason to hold identifiers for
// subscriptions that no longer deliver, and carrying them would manufacture
// exactly that dangling-key FAIL. The GitHub route stays: it is still smee-fed
// (measured on the live fleet — ~1.6k `github.*` events per 6 h drive
// monitor-merge, CI waits and the broker's PR-lifecycle routing), and the cloud
// has no GitHub ingestion to replace it yet.
//
// The retirement + rollback procedure: docs/runbooks/cloud-feed-cutover.md.
function extractMonitorWebhooks(l2) {
  const monitor = l2?.catalyst?.monitor;
  if (!monitor || typeof monitor !== "object") return null;
  const out = {};

  const ghSmee = monitor.github?.smeeChannel;
  if (typeof ghSmee === "string" && ghSmee) {
    out.github = { smeeChannel: ghSmee };
  }

  return Object.keys(out).length > 0 ? out : null;
}

// CTL-1231: carry a SHARED-only, secret-free slice of the seed's
// ~/.claude/settings.json so a member's interactive `claude` sessions inherit
// the cluster's telemetry posture + autonomy defaults. Built from an EXPLICIT
// allow-list of named keys (never "copy env minus a deny-list"), so a secret
// can't leak by omission. Deliberately EXCLUDES: secret-bearing env keys
// (AIRTABLE/SHADCN/*_TOKEN/*_KEY), OTEL_RESOURCE_ATTRIBUTES (per-host —
// synthesized at merge), OTEL_EXPORTER_OTLP_ENDPOINT (carried via
// otlpEndpointHint), and absolute laptop paths.
const CLAUDE_ENV_ALLOW = [
  "CLAUDE_CODE_ENABLE_TELEMETRY",
  "OTEL_METRICS_EXPORTER",
  "OTEL_LOGS_EXPORTER",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_METRIC_EXPORT_INTERVAL",
  "OTEL_LOGS_EXPORT_INTERVAL",
  "OTEL_SERVICE_NAME",
];
const CLAUDE_TOP_ALLOW = ["model", "cleanupPeriodDays", "alwaysThinkingEnabled", "includeCoAuthoredBy"];

function claudeSettingsPath() {
  return (
    process.env.CATALYST_CLAUDE_SETTINGS_FILE ||
    resolve(homedir(), ".claude", "settings.json")
  );
}

function extractClaudeSettings() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(claudeSettingsPath(), "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const out = {};
  for (const k of CLAUDE_TOP_ALLOW) {
    if (parsed[k] !== undefined) out[k] = parsed[k];
  }
  if (parsed.env && typeof parsed.env === "object") {
    const env = {};
    for (const k of CLAUDE_ENV_ALLOW) {
      if (parsed.env[k] !== undefined) env[k] = parsed.env[k];
    }
    if (Object.keys(env).length > 0) out.env = env;
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
    // The GitHub org that hosts the seed's thoughts repo — distinct from
    // projectKey (the Layer-2 secrets-file key), from repoUrl/pluginSourceUrl
    // (wherever the plugin source lives, possibly a personal fork), and from
    // thoughts.profile (a HumanLayer alias that need not equal the owner).
    // Falls back to thoughts.profile for a seed predating catalyst.thoughts.org
    // — correct only when the two names coincide, so the consumer warns.
    // null when neither is set. Optional (existence-only) — a null degrades to
    // a warning in catalyst-join.sh, never an abort.
    thoughtsOrg: l1?.catalyst?.thoughts?.org ?? l1?.catalyst?.thoughts?.profile ?? null,
    // Whether thoughtsOrg came from the authoritative catalyst.thoughts.org or
    // the thoughts.profile fallback, so the consumer can say which.
    thoughtsOrgSource: l1?.catalyst?.thoughts?.org
      ? "thoughts.org"
      : l1?.catalyst?.thoughts?.profile
        ? "thoughts.profile"
        : null,
    // Codex #3080 P1: the HumanLayer profile ALIAS paired with thoughtsOrg. It need not
    // equal the owner — the documented rightsite-cloud/adva layout hosts thoughts under
    // github.com/rightsite-cloud but reaches them through the local profile `adva`, and
    // create-worktree.sh later requests `adva` by name from Layer-1. Carrying only the
    // owner meant provision-thoughts fell back to profile == org on its bare-CSV path,
    // so humanlayer.json got no `adva` profile and background worktrees resolved to a
    // nonexistent one and failed to sync thoughts. null when unset (identity applies).
    thoughtsProfile: l1?.catalyst?.thoughts?.profile ?? null,
    // CTL-1284: non-secret webhook wiring (smee channels + per-team webhookId
    // map). null when the seed has no monitor block. multiHost-gated by the
    // consumer; deliberately NOT in BUNDLE_REQUIRED_KEYS.
    monitorWebhooks: extractMonitorWebhooks(l2),
    // CTL-1231: allow-listed, secret-free ~/.claude/settings.json slice (telemetry
    // posture + autonomy defaults). null when the seed has no settings. Optional
    // (existence-only) — an older seed degrades gracefully.
    claudeSettings: extractClaudeSettings(),
  };
}

// Deep-redact secrets for logging. NEVER log assembleJoinBundle() output directly.
export function redactBundleForLog(bundle) {
  const out = { ...bundle };
  // Replace the entire botCreds subtree — these are keys-to-the-kingdom.
  out.botCreds = "[REDACTED]";
  return out;
}
