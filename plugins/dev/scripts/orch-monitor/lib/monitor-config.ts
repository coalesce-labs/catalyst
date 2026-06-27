import { readFileSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import { readClusterProjects } from "./cluster-roster";

export type HudColumnId =
  | "status"
  | "time"
  | "repo"
  | "icon"
  | "event"
  | "ref"
  | "orch"
  | "worker"
  | "details";

export interface HudColumnConfig {
  id: HudColumnId;
  visible?: boolean;
  width?: number | "auto";
  minTerminalWidth?: number;
}

export interface MonitorConfig {
  repoColors: Record<string, string>;
  /**
   * CTL-961: repo short-name → GitHub owner/repo string.
   * Derived from `catalyst.monitor.linear.teams` (same source linearTeams uses).
   * e.g. { "catalyst": "coalesce-labs/catalyst", "adva": "coalesce-labs/adva" }
   * Used by the /api/repo-icon/:repo endpoint to resolve auto-detected favicons.
   */
  repoOwners: Record<string, string>;
}

const VALID_COLUMN_IDS = new Set<string>([
  "status", "time", "repo", "icon", "event", "ref", "orch", "worker", "details",
]);

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * Load monitor display config from `.catalyst/config.json`.
 * Returns defaults when the file is missing or the key is absent.
 *
 * Schema:
 *   {
 *     "catalyst": {
 *       "monitor": {
 *         "github": {
 *           "repoColors": {
 *             "owner/repo": "blue"
 *           }
 *         }
 *       }
 *     }
 *   }
 */
// repoSlugFromRoot — derive a GitHub "owner/repo" slug from a registry repoRoot
// path (…/code-repos/github/groundworkapp/Adva → groundworkapp/Adva). Returns null
// when there is no /github/<owner>/<repo> segment. §13 — the registry's repoRoot is
// the machine-level source of truth for which repo a team actually lives in.
function repoSlugFromRoot(repoRoot: string): string | null {
  const m = repoRoot.match(/\/github\/([^/]+\/[^/]+?)\/?$/);
  return m ? m[1] : null;
}

// readRepoColorsInto — fold catalyst.monitor.github.repoColors from ONE config
// file into `target`. Fail-open (absent/malformed → no-op). Later calls override
// earlier ones per-key, so the caller layers Layer-1 first then Layer-2 to give
// Layer-2 (the node scope) the win.
function readRepoColorsInto(target: Record<string, string>, configPath: string): void {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (isRecord(parsed) && isRecord(parsed.catalyst) && isRecord(parsed.catalyst.monitor)) {
      const github = parsed.catalyst.monitor.github;
      if (isRecord(github) && isRecord(github.repoColors)) {
        for (const [repo, color] of Object.entries(github.repoColors)) {
          if (typeof color === "string") target[repo] = color;
        }
      }
    }
  } catch {
    /* this layer absent/malformed → contributes no colors */
  }
}

// defaultLayer2ConfigPath — the node-scope config (~/.config/catalyst/config.json),
// honoring the same CATALYST_LAYER2_CONFIG_FILE override the doctor uses.
function defaultLayer2ConfigPath(): string {
  return (
    process.env.CATALYST_LAYER2_CONFIG_FILE ??
    join(homedir(), ".config", "catalyst", "config.json")
  );
}

export function loadMonitorConfig(
  configPath: string,
  registryPath?: string,
  layer2ConfigPath: string = defaultLayer2ConfigPath(),
): MonitorConfig {
  const repoColors: Record<string, string> = {};
  const repoOwners: Record<string, string> = {};

  // --- repoColors: Layer-1 base, Layer-2 (node scope) override (CTL-1214 P2 #3) ---
  // The schema + `catalyst doctor` advise relocating catalyst.monitor.github.repoColors
  // to the Layer-2 node config (~/.config/catalyst/config.json). Read Layer-1 first as
  // the back-compat base, then overlay Layer-2 so an operator who MOVED repoColors to
  // Layer-2 isn't left with no colors (and a per-key Layer-2 entry wins). Both fail-open.
  readRepoColorsInto(repoColors, configPath);
  if (layer2ConfigPath && layer2ConfigPath !== configPath) {
    readRepoColorsInto(repoColors, layer2ConfigPath);
  }

  // --- roster-derived FALLBACK repoOwners (CTL-961, CTL-1214 Phase 2) ---
  // The team→repo roster now comes through the shared readClusterProjects()
  // (cluster.json.projects[] first, Layer-1 catalyst.monitor.linear.teams[]
  // fallback). §13: this stays the FALLBACK for repoOwners — the registry
  // override below still WINS so a stale committed roster (e.g. ADV →
  // coalesce-labs/adva, a 404) can't break repo icons.
  for (const team of readClusterProjects({ layer1ConfigPath: configPath })) {
    const shortName = team.vcsRepo.split("/").at(-1);
    if (shortName) repoOwners[shortName.toLowerCase()] = team.vcsRepo;
  }

  // --- registry-derived repoOwners OVERRIDE (§13) ---
  // The machine-level execution-core/registry.json carries the CORRECT team→repoRoot,
  // which can DIVERGE from the stale committed monitor.linear.teams (ADV: registry
  // groundworkapp/Adva vs config coalesce-labs/adva — a dead 404 that breaks repo
  // icons). Derive the slug from repoRoot and let the registry WIN so icons/links
  // resolve the real repo. The committed config stays only as a fallback.
  const regPath =
    registryPath ??
    join(process.env.CATALYST_DIR ?? join(homedir(), "catalyst"), "execution-core", "registry.json");
  try {
    const reg: unknown = JSON.parse(readFileSync(regPath, "utf8"));
    if (isRecord(reg) && Array.isArray(reg.projects)) {
      for (const p of reg.projects) {
        if (isRecord(p) && typeof p.repoRoot === "string") {
          const slug = repoSlugFromRoot(p.repoRoot);
          if (slug) repoOwners[basename(slug).toLowerCase()] = slug;
        }
      }
    }
  } catch {
    /* no registry → config-derived owners stand */
  }

  return { repoColors, repoOwners };
}

/**
 * Load per-user HUD column config from `~/.config/catalyst/monitor.json`.
 * Returns null when the file is absent, malformed, or has no columns array.
 *
 * Schema:
 *   {
 *     "hud": {
 *       "columns": [
 *         { "id": "time", "visible": true },
 *         { "id": "details", "visible": true }
 *       ]
 *     }
 *   }
 */
export function loadHudConfig(monitorJsonPath: string): HudColumnConfig[] | null {
  let raw: string;
  try {
    raw = readFileSync(monitorJsonPath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const hud = parsed.hud;
  if (!isRecord(hud)) return null;
  const columns = hud.columns;
  if (!Array.isArray(columns)) return null;
  const result: HudColumnConfig[] = [];
  for (const col of columns) {
    if (!isRecord(col) || typeof col.id !== "string") continue;
    if (!VALID_COLUMN_IDS.has(col.id)) continue;
    const entry: HudColumnConfig = { id: col.id as HudColumnId };
    if (typeof col.visible === "boolean") entry.visible = col.visible;
    if (typeof col.width === "number" || col.width === "auto") {
      entry.width = col.width;
    }
    if (typeof col.minTerminalWidth === "number") {
      entry.minTerminalWidth = col.minTerminalWidth;
    }
    result.push(entry);
  }
  return result.length > 0 ? result : null;
}
