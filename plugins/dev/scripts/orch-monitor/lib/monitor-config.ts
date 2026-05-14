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
    return { repoColors: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { repoColors: {} };
  }
  if (!isRecord(parsed) || !isRecord(parsed.catalyst)) return { repoColors: {} };
  const monitor = parsed.catalyst.monitor;
  if (!isRecord(monitor)) return { repoColors: {} };
  const github = monitor.github;
  if (!isRecord(github)) return { repoColors: {} };
  const repoColors = github.repoColors;
  if (!isRecord(repoColors)) return { repoColors: {} };
  const result: Record<string, string> = {};
  for (const [repo, color] of Object.entries(repoColors)) {
    if (typeof color === "string") result[repo] = color;
  }
  return { repoColors: result };
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
      entry.width = col.width as number | "auto";
    }
    if (typeof col.minTerminalWidth === "number") {
      entry.minTerminalWidth = col.minTerminalWidth;
    }
    result.push(entry);
  }
  return result.length > 0 ? result : null;
}
