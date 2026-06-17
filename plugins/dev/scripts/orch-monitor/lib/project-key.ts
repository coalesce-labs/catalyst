import { readFileSync } from "fs";
import { join } from "path";

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** CTL-1156: read projectKey directly from a config file path, independent of cwd. */
export function detectProjectKeyFromConfig(configPath: string): string | null {
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !isRecord(parsed.catalyst)) return null;
    const key = parsed.catalyst.projectKey;
    return typeof key === "string" && key ? key : null;
  } catch {
    return null;
  }
}

export function detectProjectKey(cwd: string): string | null {
  return detectProjectKeyFromConfig(join(cwd, ".catalyst", "config.json"));
}
