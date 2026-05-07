import { readFileSync } from "fs";

export interface MonitorConfig {
  repoColors: Record<string, string>;
}

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
