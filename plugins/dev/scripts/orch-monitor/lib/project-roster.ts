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
// CTL-1380 (Bug A): before the union, observed-work repo identifiers are NORMALIZED
// into the configured short-name key space via buildObservedRepoAliases /
// normalizeObservedRepo. BoardPayload.repos arrives as lowercased team keys ("ctl",
// "adv") and/or full owner/repos ("coalesce-labs/catalyst") — none of which equal a
// configured short-name ("catalyst", "adva") — so without normalization the union
// never collapsed them and the nav showed a duplicate "unconfigured" lane per
// configured team. Normalization folds each alias onto the team's short-name so
// observed work flips the configured descriptor's hasWork instead.
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
import { resolveLayer1ConfigPath } from "./config-path";
import { VALID_HUES } from "./config-writer";

export interface ProjectDescriptor {
  /** Linear team key, UPPERCASE (verbatim from teams[].key). For an unconfigured
   *  observed-work descriptor, the repo short-name UPPERCASED as a stand-in. */
  key: string;
  /** EFFECTIVE display name: overlay.name ?? displayCaseName(repo). */
  name: string;
  /** Short repo name, LOWERCASED — the value BoardPayload.repos carries and the
   *  nav/repo-scope key on. */
  repo: string;
  /** Full owner/repo from teams[].vcsRepo; null for an unconfigured descriptor. */
  vcsRepo: string | null;
  /** EFFECTIVE hue NAME: overlay.color ?? repoColors[vcsRepo] ?? null.
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
  // CTL-1153 (M2): raw override fields from catalyst.projects[] overlay.
  // The editor and icon hook read these; every render site reads the EFFECTIVE
  // fields above. A strict JSON superset of M1 — absent projects[] → all null.
  /** Raw stored name override; null ⇒ no override (effective name = displayCaseName). */
  storedName: string | null;
  /** Raw stored color override; null ⇒ no override (effective color = repoColors). */
  storedColor: string | null;
  /** Chosen icon candidate path; null ⇒ favicon auto-detect default. */
  icon: string | null;
  /** Per-project Linear stateMap partial override; null ⇒ inherit global stateMap. */
  stateMap: Record<string, string> | null;
  /** Provenance of the descriptor: overlay (has a projects[] entry), config (teams[]
   *  only, no projects[] entry), or unconfigured (observed-work lane with no team). */
  source: "config" | "overlay" | "unconfigured";
}

/** One entry in the catalyst.projects[] overlay array. */
export interface ProjectOverlayEntry {
  key: string;              // uppercased
  vcsRepo: string | null;   // copied from teams[] on first edit, null for orphan
  name?: string;
  color?: string;
  icon?: string;
  stateMap?: Record<string, string>;
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
 * CTL-1380 (Bug A): build the alias → configured-short-name lookup that normalizes
 * observed-work repo identifiers (BoardPayload.repos) into the SAME key space the
 * configured team descriptors use (the vcsRepo short-name).
 *
 * WHY this is needed: BoardPayload.repos does NOT carry configured short-names.
 * board-data.mjs's repoFor() derives a ticket's repo from its team-key prefix, and
 * in the daemon-spawned monitor (cwd has no .catalyst/config.json) board-data's own
 * team→short map loads empty, so repoFor() falls back to the LOWERCASED TEAM KEY
 * ("ctl", "adv", "otl", "sli"); some tickets also carry an explicit FULL owner/repo
 * ("coalesce-labs/catalyst"). None of those equal a configured short-name
 * ("catalyst", "adva", …), so the UNION rule below never collapsed them → duplicate
 * source:"unconfigured" lanes for teams that ARE configured (the 10-entry nav bug).
 *
 * This map folds every known alias of a configured team — its short-name (identity),
 * its team key, its full owner/repo, and (via registry, joined by team key) its
 * repoRoot basename — onto that team's short-name, so observed work merges into the
 * configured descriptor instead of spawning a duplicate.
 */
export function buildObservedRepoAliases(
  teams: TeamEntry[],
  registry: RegistryEntry[],
): Map<string, string> {
  const aliases = new Map<string, string>();
  const shortByTeamKey = new Map<string, string>();
  for (const t of teams ?? []) {
    if (!t || typeof t.key !== "string" || typeof t.vcsRepo !== "string") continue;
    if (!t.vcsRepo.includes("/")) continue;
    const short = shortName(t.vcsRepo);
    shortByTeamKey.set(t.key.toUpperCase(), short);
    aliases.set(short, short); // short-name → itself (identity)
    aliases.set(t.key.toLowerCase(), short); // lowercased team key (repoFor fallback)
    aliases.set(t.vcsRepo.toLowerCase(), short); // full owner/repo (e.g. e.repo passthrough)
  }
  // registry repoRoot basename → the team's short-name, joined by team key. Enriches
  // the alias set so a ticket whose repo was derived from a registry repoRoot path
  // also folds onto the configured descriptor.
  for (const r of registry ?? []) {
    if (!r || typeof r.team !== "string" || typeof r.repoRoot !== "string") continue;
    const short = shortByTeamKey.get(r.team.toUpperCase());
    if (!short) continue;
    const base = basename(r.repoRoot).toLowerCase();
    if (base) aliases.set(base, short);
  }
  return aliases;
}

/**
 * Normalize ONE observed-work repo identifier into the configured short-name key
 * space. An exact alias hit wins; a FULL owner/repo ("owner/name") with no exact
 * alias collapses to its basename (so it matches a configured team keyed by
 * basename AND, for a genuinely-unconfigured repo, yields a "/"-free key the
 * repo-icon endpoint accepts); everything else passes through lowercased so a
 * genuinely-unconfigured short name still appears once.
 */
export function normalizeObservedRepo(
  raw: string,
  aliases: Map<string, string>,
): string {
  const r = String(raw).trim().toLowerCase();
  const hit = aliases.get(r);
  if (hit) return hit;
  if (r.includes("/")) {
    const base = basename(r);
    return aliases.get(base) ?? base;
  }
  return r;
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
  // CTL-1380 (Bug A): normalize observed-work repo identifiers into the configured
  // short-name key space BEFORE the union, so observed work (which arrives as team
  // keys / full owner-repos) merges into the configured descriptor instead of
  // spawning a duplicate source:"unconfigured" lane.
  const aliases = buildObservedRepoAliases(teams ?? [], registry ?? []);
  const observed = new Set(
    (observedRepos ?? []).map((r) => normalizeObservedRepo(String(r), aliases)),
  );
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
      // M2 raw-override fields — null until applyProjectsOverlay folds in overlay
      storedName: null,
      storedColor: null,
      icon: null,
      stateMap: null,
      source: "config",
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
      storedName: null,
      storedColor: null,
      icon: null,
      stateMap: null,
      source: "unconfigured",
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

// ─── CTL-1153 (M2): catalyst.projects[] overlay ───────────────────────────────

/**
 * Lenient, fail-open reader for catalyst.projects[]. Returns [] on any error.
 * Mirrors the readTeams root-flex at :151-175 (tolerates both catalyst-wrapped
 * and bare shapes; skips entries missing key; drops non-string/non-record fields
 * but never throws).
 */
export function readProjectsOverlay(configPath: string): ProjectOverlayEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  const root = isRecord(parsed.catalyst) ? parsed.catalyst : parsed;
  if (!isRecord(root)) return [];
  const projects = root.projects;
  if (!Array.isArray(projects)) return [];

  const out: ProjectOverlayEntry[] = [];
  for (const p of projects) {
    if (!isRecord(p)) continue;
    const key = typeof p.key === "string" ? p.key.toUpperCase().trim() : "";
    if (!key) continue;
    const vcsRepo =
      typeof p.vcsRepo === "string" ? p.vcsRepo.trim() : null;
    const entry: ProjectOverlayEntry = { key, vcsRepo };
    if (typeof p.name === "string" && p.name.trim()) entry.name = p.name.trim();
    if (typeof p.color === "string" && VALID_HUES.has(p.color)) entry.color = p.color;
    if (typeof p.icon === "string" && p.icon.trim()) entry.icon = p.icon.trim();
    if (isRecord(p.stateMap)) {
      const sm: Record<string, string> = {};
      for (const [k, v] of Object.entries(p.stateMap)) {
        if (typeof v === "string") sm[k] = v;
      }
      if (Object.keys(sm).length > 0) entry.stateMap = sm;
    }
    out.push(entry);
  }
  return out;
}

/**
 * PURE merge: apply catalyst.projects[] overlay entries over the M1 base descriptors.
 *
 * Rules:
 *  - Match overlay entry to base descriptor by KEY (case-insensitive).
 *  - On match: fold overlay.name/color into effective name/defaultColor; copy raw
 *    storedName/storedColor/icon/stateMap; mark source="overlay".
 *  - Unknown color in overlay ⇒ ignored (falls back to base defaultColor).
 *  - Forward-compat: an overlay key ∉ base (with a non-null vcsRepo) is APPENDED
 *    as a new descriptor (source="overlay"); a null-vcsRepo orphan is skipped.
 *  - Empty overlay ⇒ identity transform (proves absent projects[] ⇒ M1 behavior).
 */
export function applyProjectsOverlay(
  base: ProjectDescriptor[],
  overlay: ProjectOverlayEntry[],
): ProjectDescriptor[] {
  if (overlay.length === 0) return base;

  const overlayByKey = new Map<string, ProjectOverlayEntry>();
  for (const e of overlay) {
    overlayByKey.set(e.key.toUpperCase(), e);
  }

  const out: ProjectDescriptor[] = [];
  const handledKeys = new Set<string>();

  for (const desc of base) {
    const e = overlayByKey.get(desc.key.toUpperCase());
    if (!e) {
      out.push(desc);
      continue;
    }
    handledKeys.add(desc.key.toUpperCase());

    const storedName = e.name ?? null;
    const storedColor = e.color && VALID_HUES.has(e.color) ? e.color : null;

    out.push({
      ...desc,
      // EFFECTIVE fields — reflect the override
      name: storedName ?? desc.name,
      defaultColor: storedColor ?? desc.defaultColor,
      // RAW override fields
      storedName,
      storedColor,
      icon: e.icon ?? null,
      stateMap: e.stateMap ?? null,
      source: "overlay",
    });
  }

  // Forward-compat: overlay entries for unknown keys with a vcsRepo → append
  for (const e of overlay) {
    if (handledKeys.has(e.key.toUpperCase())) continue;
    if (!e.vcsRepo) continue; // null-vcsRepo orphan: skip
    const repo = basename(e.vcsRepo).toLowerCase();
    const storedName = e.name ?? null;
    const storedColor = e.color && VALID_HUES.has(e.color) ? e.color : null;
    out.push({
      key: e.key.toUpperCase(),
      name: storedName ?? displayCaseName(repo),
      repo,
      vcsRepo: e.vcsRepo,
      defaultColor: storedColor,
      iconUrl: `/api/repo-icon/${repo}`,
      repoRoot: null,
      hasWork: false,
      storedName,
      storedColor,
      icon: e.icon ?? null,
      stateMap: e.stateMap ?? null,
      source: "overlay",
    });
  }

  return out;
}

export interface LoadProjectsOpts {
  /** Observed-work repos from the live BoardPayload.repos (drives hasWork + union). */
  observedRepos?: string[];
  /** Override the Layer-1 config path. Tests inject a temp fixture here. When
   *  omitted, defaults to resolveLayer1ConfigPath() — env-pointer first
   *  (CATALYST_CONFIG_FILE > CATALYST_CONFIG_PATH), cwd only as the last resort. */
  configPath?: string;
  /** Override the registry path (defaults to `${CATALYST_DIR}/execution-core/registry.json`). */
  registryPath?: string;
}

/**
 * I/O wrapper. Reads teams + repoColors from the Layer-1 config and repoRoot
 * enrichment from registry.json under CATALYST_DIR (process.env.CATALYST_DIR ??
 * $HOME/catalyst — NEVER process.cwd(), which in a worktree is the worktree not
 * ~/catalyst). Fail-open to [] on ANY error.
 *
 * The config path defaults via resolveLayer1ConfigPath() (CTL-1152 originally hard-
 * coded `${process.cwd()}/.catalyst/config.json`, which read the WRONG directory
 * when the daemon spawned the monitor from .../execution-core → zero configured
 * teams → nav showed only the observed-work repos). The shared helper prefers the
 * CATALYST_CONFIG_FILE / CATALYST_CONFIG_PATH env pointer the deploy exports, so
 * project resolution is cwd-independent whenever an env var is set.
 */
export function loadProjects(opts: LoadProjectsOpts = {}): ProjectDescriptor[] {
  try {
    const configPath = opts.configPath ?? resolveLayer1ConfigPath();
    const catalystDir = process.env.CATALYST_DIR ?? join(homedir(), "catalyst");
    const registryPath =
      opts.registryPath ?? join(catalystDir, "execution-core", "registry.json");
    const observedRepos = opts.observedRepos ?? [];

    const teams = readTeams(configPath);
    const { repoColors } = loadMonitorConfig(configPath);
    const registry = readRegistry(registryPath);
    const overlay = readProjectsOverlay(configPath);

    const base = buildProjects(teams, repoColors, registry, observedRepos);
    return applyProjectsOverlay(base, overlay);
  } catch {
    return [];
  }
}
