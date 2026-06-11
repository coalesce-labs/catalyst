import { readFileSync } from "fs";

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
export function loadMonitorConfig(configPath: string): MonitorConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch {
    return { repoColors: {}, repoOwners: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { repoColors: {}, repoOwners: {} };
  }
  if (!isRecord(parsed) || !isRecord(parsed.catalyst)) return { repoColors: {}, repoOwners: {} };
  const monitor = parsed.catalyst.monitor;
  if (!isRecord(monitor)) return { repoColors: {}, repoOwners: {} };

  // repoColors from catalyst.monitor.github.repoColors
  const github = monitor.github;
  const repoColors: Record<string, string> = {};
  if (isRecord(github) && isRecord(github.repoColors)) {
    for (const [repo, color] of Object.entries(github.repoColors)) {
      if (typeof color === "string") repoColors[repo] = color;
    }
  }

  // CTL-961: repoOwners from catalyst.monitor.linear.teams (repo short-name → owner/repo)
  // CTL-979: key is lowercased so /api/repo-icon/adva resolves vcsRepo "rightsite-cloud/Adva".
  const repoOwners: Record<string, string> = {};
  const linear = monitor.linear;
  if (isRecord(linear) && Array.isArray(linear.teams)) {
    for (const team of linear.teams) {
      if (isRecord(team) && typeof team.vcsRepo === "string" && team.vcsRepo.includes("/")) {
        const shortName = team.vcsRepo.split("/").at(-1);
        if (shortName) repoOwners[shortName.toLowerCase()] = team.vcsRepo;
      }
    }
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
