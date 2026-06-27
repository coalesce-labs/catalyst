// cluster-roster.ts — CTL-1214 Phase 2: the single project-roster source.
//
// The fleet's team→repo roster relocates from each repo's deprecated Layer-1
// `catalyst.monitor.linear.teams[]` to the cluster-scope
// `catalyst-cluster/cluster.json.projects[]` (design §13). This module is the ONE
// place that defines the roster precedence — cluster first, Layer-1 fallback —
// so webhook-config, monitor-config, and project-roster all read the same source
// in the same order instead of each re-reading Layer-1 directly.
//
// Precedence (mirrors board-data.mjs:378 `pickTeams(cluster) ?? pickTeams(l1) ?? []`):
//   1. cluster.json.projects[]  — {teamKey,vcsRepo,projectKey} mapped to {key,vcsRepo}
//   2. Layer-1 monitor.linear.teams[] — {key,vcsRepo} (back-compat during migration)
//   3. []                       — neither source resolves
//
// FAIL-OPEN + back-compat-first: the cluster source only WINS when it yields ≥1
// valid entry, so a missing/malformed cluster.json never empties a roster the
// running monitor still gets from Layer-1 (the CTL-1214 "lose no value" invariant).

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { resolveLayer1ConfigPath } from "./config-path";

/** One project-roster entry: a Linear team short-key and its `owner/repo`. */
export interface TeamEntry {
  key: string;
  vcsRepo: string;
}

export interface ReadClusterProjectsOpts {
  /** Override the catalyst-cluster repo dir. Defaults to the same resolver
   *  resolveClusterHosts() uses: CATALYST_CLUSTER_DIR → ${CATALYST_DIR|~/catalyst}/catalyst-cluster. */
  clusterDir?: string;
  /** Override the Layer-1 `.catalyst/config.json` path for the fallback. Defaults
   *  to resolveLayer1ConfigPath() (env pointer first, cwd last). */
  layer1ConfigPath?: string;
  /** Inject the environment (tests). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

// Loose owner/repo shape: alphanumerics, dots, dashes, underscores, exactly one
// slash, non-empty parts. Mirrors webhook-config's REPO_SHAPE so the unified
// roster reader rejects the same malformed repos (missing slash, extra path
// segments) the per-file readers used to.
const REPO_SHAPE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// resolveClusterRepoDir — local mirror of config.mjs getClusterRepoDir() so this
// module stays dependency-free (no execution-core import → no bun:sqlite reach
// into the ui build graph). Same precedence: CATALYST_CLUSTER_DIR env →
// ${CATALYST_DIR | ~/catalyst}/catalyst-cluster.
function resolveClusterRepoDir(opts: ReadClusterProjectsOpts, env: NodeJS.ProcessEnv): string {
  if (typeof opts.clusterDir === "string" && opts.clusterDir.length > 0) return opts.clusterDir;
  if (typeof env.CATALYST_CLUSTER_DIR === "string" && env.CATALYST_CLUSTER_DIR.length > 0) {
    return env.CATALYST_CLUSTER_DIR;
  }
  const catalystDir =
    typeof env.CATALYST_DIR === "string" && env.CATALYST_DIR.length > 0
      ? env.CATALYST_DIR
      : join(homedir(), "catalyst");
  return join(catalystDir, "catalyst-cluster");
}

// readClusterConfigFile — parse <clusterDir>/cluster.json. Returns the parsed
// object, or null when absent/malformed (the back-compat fall-through to Layer-1).
// Never throws.
function readClusterConfigFile(clusterDir: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(clusterDir, "cluster.json"), "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// parseTeamEntries — the ONE lenient validator shared by both sources. Skips
// entries with an empty key or a vcsRepo that is not `owner/repo`, warns on each
// skip (parity with webhook-config's readLinearTeams), and deduplicates by key
// (last entry wins, with a warn). Order is preserved (Map insertion order).
function parseTeamEntries(raw: unknown, sourceLabel: string): TeamEntry[] {
  if (!Array.isArray(raw)) return [];
  const byKey = new Map<string, string>();
  for (const entry of raw) {
    if (!isRecord(entry)) {
      console.warn(`[cluster-roster] Ignoring ${sourceLabel} entry — not an object: ${JSON.stringify(entry)}`);
      continue;
    }
    const key = typeof entry.key === "string" ? entry.key.trim() : "";
    const vcsRepo = typeof entry.vcsRepo === "string" ? entry.vcsRepo.trim() : "";
    if (key.length === 0) {
      console.warn(`[cluster-roster] Ignoring ${sourceLabel} entry with empty "key"`);
      continue;
    }
    if (vcsRepo.length === 0 || !REPO_SHAPE.test(vcsRepo)) {
      console.warn(
        `[cluster-roster] Ignoring ${sourceLabel} entry for key "${key}" — vcsRepo "${vcsRepo}" must match "owner/repo".`,
      );
      continue;
    }
    if (byKey.has(key)) {
      console.warn(
        `[cluster-roster] Duplicate ${sourceLabel} entry for key "${key}" — last entry wins ("${vcsRepo}").`,
      );
    }
    byKey.set(key, vcsRepo);
  }
  return Array.from(byKey.entries()).map(([key, vcsRepo]) => ({ key, vcsRepo }));
}

// parseClusterProjects — map cluster.json.projects[] {teamKey,vcsRepo,projectKey}
// onto the {key,vcsRepo} shape, then run the shared validator.
function parseClusterProjects(projects: unknown): TeamEntry[] {
  if (!Array.isArray(projects)) return [];
  // Array.isArray narrows `unknown` to `any[]`; re-type to `unknown[]` so each
  // element stays `unknown` (no implicit-any property reads in the map).
  const normalized = (projects as unknown[]).map((p) =>
    isRecord(p) ? { key: p.teamKey, vcsRepo: p.vcsRepo } : p,
  );
  return parseTeamEntries(normalized, "cluster.json projects");
}

// readLayer1Teams — the back-compat fallback: Layer-1 monitor.linear.teams[].
// Tolerates both the `{catalyst:{monitor}}` and bare `{monitor}` shapes (the
// project-roster readTeams root-flex). Fail-open to [].
function readLayer1Teams(configPath: string): TeamEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  const root = isRecord(parsed.catalyst) ? parsed.catalyst : parsed;
  if (!isRecord(root)) return [];
  const monitor = root.monitor;
  if (!isRecord(monitor)) return [];
  const linear = monitor.linear;
  if (!isRecord(linear)) return [];
  return parseTeamEntries(linear.teams, "monitor.linear.teams");
}

/**
 * readClusterProjects — resolve the fleet's project roster as `TeamEntry[]`,
 * cluster.json.projects[] first and Layer-1 monitor.linear.teams[] as the
 * back-compat fallback. The cluster source wins only when it yields ≥1 valid
 * entry, so a missing/malformed cluster.json never strands a roster the monitor
 * still has in Layer-1. Never throws — every read fail-opens to the next source.
 */
export function readClusterProjects(opts: ReadClusterProjectsOpts = {}): TeamEntry[] {
  const env = opts.env ?? process.env;

  const cluster = readClusterConfigFile(resolveClusterRepoDir(opts, env));
  if (cluster !== null) {
    const fromCluster = parseClusterProjects(cluster.projects);
    if (fromCluster.length > 0) return fromCluster;
  }

  const layer1Path = opts.layer1ConfigPath ?? resolveLayer1ConfigPath(env);
  return readLayer1Teams(layer1Path);
}
