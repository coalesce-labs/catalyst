// project-roster.ts — CTL-1152: the config-driven project roster.
//
// Replaces the hardcoded team/repo knowledge with a single source of truth:
// `catalyst.monitor.linear.teams[]` (the same array webhook-config and
// monitor-config already read). buildProjects() is the PURE builder behind
// GET /api/projects and the nav; loadProjects() does the fail-open I/O.
//
// The UNION RULE merges two roster sources by SHORT REPO NAME (descriptor.repo,
// lowercased):
//   1) Configured teams → one descriptor each, ALWAYS included (even with zero
//      observed work → hasWork=false), so a configured-but-idle team stays visible.
//   2) Observed-work repos (BoardPayload.repos) with NO configured descriptor →
//      appended as explicit SELF-IDENTIFYING "unconfigured" descriptors (key =
//      repo short-name UPPERCASED, vcsRepo/defaultColor/repoRoot null, hasWork=true).
//      Never dropped, never collapsed to an "other" bucket.
//
// Identity authority is config teams[]; registry.json (CATALYST_DIR-relative)
// contributes repoRoot ONLY, joined by team key — its team identity can DIVERGE
// from config (e.g. ADV registry repoRoot=groundworkapp/Adva vs config vcsRepo=
// coalesce-labs/adva), so config wins on identity and registry only enriches.
//
// Everything fail-opens: any config/registry read or parse error yields [] so the
// endpoint and the nav degrade to a first-class empty state rather than throwing
// (mirrors /api/config and the repo-icon endpoint).

import { readFileSync } from "fs";
import { homedir } from "os";
import { join, basename } from "path";
import { loadMonitorConfig } from "./monitor-config";

export interface ProjectDescriptor {
  /** Linear team key, UPPERCASE (verbatim from teams[].key). For an unconfigured
   *  observed-work descriptor, the repo short-name UPPERCASED as a stand-in. */
  key: string;
  /** Display-cased short repo name for human reading ("catalyst" → "Catalyst"). */
  name: string;
  /** Short repo name, LOWERCASED — the value BoardPayload.repos carries and the
   *  nav/repo-scope key on. */
  repo: string;
  /** Full owner/repo from teams[].vcsRepo; null for an unconfigured descriptor. */
  vcsRepo: string | null;
  /** Hue NAME resolved from repoColors[vcsRepo] (repoColors is keyed by owner/repo);
   *  null when no color configured or vcsRepo is null. SHORT-NAME-resolved so the
   *  UI keys it by descriptor.repo and never re-derives from owner/repo. */
  defaultColor: string | null;
  /** The existing per-repo favicon endpoint path "/api/repo-icon/<repo>". */
  iconUrl: string;
  /** OPTIONAL enrichment from registry.json projects[].repoRoot, joined by team
   *  key; null when registry is absent/unreadable or the team has no entry. */
  repoRoot: string | null;
  /** True when descriptor.repo ∈ observedRepos (BoardPayload.repos). Always true
   *  for an unconfigured descriptor (it exists BECAUSE it was observed). */
  hasWork: boolean;
}

interface TeamEntry {
  key: string;
  vcsRepo: string;
}

interface RegistryEntry {
  team: string;
  repoRoot?: string;
}

// displayCaseName — split on -/_/space, capitalize each word, rejoin with spaces.
// Kept in lockstep with the ui nav-model displayCaseName so server+client casing
// can't drift ("catalyst-otel" → "Catalyst Otel").
function displayCaseName(repo: string): string {
  return repo
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function shortName(vcsRepo: string): string {
  return basename(vcsRepo).toLowerCase();
}

/**
 * PURE builder. Iterates configured teams (deriving repo, joining repoColors by
 * owner/repo and registry by team key, computing hasWork), then appends an
 * unconfigured descriptor for every observed repo no team already covers.
 *
 * Ordering: configured teams in config order first, then unconfigured-work
 * descriptors sorted by repo, so the roster is stable.
 */
export function buildProjects(
  teams: TeamEntry[],
  repoColors: Record<string, string>,
  registry: RegistryEntry[],
  observedRepos: string[],
): ProjectDescriptor[] {
  const observed = new Set((observedRepos ?? []).map((r) => String(r)));
  const repoRootByTeam = new Map<string, string>();
  for (const r of registry ?? []) {
    if (r && typeof r.team === "string" && typeof r.repoRoot === "string") {
      repoRootByTeam.set(r.team.toUpperCase(), r.repoRoot);
    }
  }

  const out: ProjectDescriptor[] = [];
  const covered = new Set<string>();

  for (const t of teams ?? []) {
    if (!t || typeof t.key !== "string" || typeof t.vcsRepo !== "string") continue;
    if (!t.vcsRepo.includes("/")) continue;
    const key = t.key.toUpperCase();
    const repo = shortName(t.vcsRepo);
    covered.add(repo);
    out.push({
      key,
      name: displayCaseName(repo),
      repo,
      vcsRepo: t.vcsRepo,
      defaultColor: repoColors?.[t.vcsRepo] ?? null,
      iconUrl: `/api/repo-icon/${repo}`,
      repoRoot: repoRootByTeam.get(key) ?? null,
      hasWork: observed.has(repo),
    });
  }

  // UNION: observed-work repos with no configured descriptor → unconfigured lanes.
  const unconfigured = [...observed]
    .filter((repo) => !covered.has(repo))
    .sort();
  for (const repo of unconfigured) {
    out.push({
      key: repo.toUpperCase(),
      name: displayCaseName(repo),
      repo,
      vcsRepo: null,
      defaultColor: null,
      iconUrl: `/api/repo-icon/${repo}`,
      repoRoot: null,
      hasWork: true,
    });
  }

  return out;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// Read catalyst.monitor.linear.teams[] (the IDENTITY authority) from a config
// file. Fail-open to []. Same lenient parsing webhook-config's readLinearTeams
// uses — skip entries with empty key or non-owner/repo vcsRepo.
function readTeams(configPath: string): TeamEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  // tolerate both the Layer-1 { catalyst: { monitor: ... } } and a bare { monitor }
  const root = isRecord(parsed.catalyst) ? parsed.catalyst : parsed;
  if (!isRecord(root)) return [];
  const monitor = root.monitor;
  if (!isRecord(monitor)) return [];
  const linear = monitor.linear;
  if (!isRecord(linear) || !Array.isArray(linear.teams)) return [];
  const out: TeamEntry[] = [];
  for (const entry of linear.teams) {
    if (!isRecord(entry)) continue;
    const key = typeof entry.key === "string" ? entry.key.trim() : "";
    const vcsRepo = typeof entry.vcsRepo === "string" ? entry.vcsRepo.trim() : "";
    if (key.length === 0 || vcsRepo.length === 0 || !vcsRepo.includes("/")) continue;
    out.push({ key, vcsRepo });
  }
  return out;
}

// Read registry.json projects[] (repoRoot-only enrichment, joined by team key).
// Fail-open to [].
function readRegistry(registryPath: string): RegistryEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(registryPath, "utf8"));
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.projects)) return [];
  const out: RegistryEntry[] = [];
  for (const p of parsed.projects) {
    if (!isRecord(p) || typeof p.team !== "string") continue;
    const entry: RegistryEntry = { team: p.team };
    if (typeof p.repoRoot === "string") entry.repoRoot = p.repoRoot;
    out.push(entry);
  }
  return out;
}

export interface LoadProjectsOpts {
  /** Observed-work repos from the live BoardPayload.repos (drives hasWork + union). */
  observedRepos?: string[];
  /** Override the Layer-1 config path (defaults to `${process.cwd()}/.catalyst/config.json`). */
  configPath?: string;
  /** Override the registry path (defaults to `${CATALYST_DIR}/execution-core/registry.json`). */
  registryPath?: string;
}

/**
 * I/O wrapper. Reads teams + repoColors from the Layer-1 config (same cwd-relative
 * path /api/config uses) and repoRoot enrichment from registry.json under
 * CATALYST_DIR (process.env.CATALYST_DIR ?? $HOME/catalyst — NEVER process.cwd(),
 * which in a worktree is the worktree not ~/catalyst). Fail-open to [] on ANY error.
 */
export function loadProjects(opts: LoadProjectsOpts = {}): ProjectDescriptor[] {
  try {
    const configPath = opts.configPath ?? `${process.cwd()}/.catalyst/config.json`;
    const catalystDir = process.env.CATALYST_DIR ?? join(homedir(), "catalyst");
    const registryPath =
      opts.registryPath ?? join(catalystDir, "execution-core", "registry.json");
    const observedRepos = opts.observedRepos ?? [];

    const teams = readTeams(configPath);
    const { repoColors } = loadMonitorConfig(configPath);
    const registry = readRegistry(registryPath);

    return buildProjects(teams, repoColors, registry, observedRepos);
  } catch {
    return [];
  }
}
