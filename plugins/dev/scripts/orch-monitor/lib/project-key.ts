import { readFileSync } from "fs";
import { join } from "path";

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export function detectProjectKey(cwd: string): string | null {
  try {
    const raw = readFileSync(join(cwd, ".catalyst", "config.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !isRecord(parsed.catalyst)) return null;
    const key = parsed.catalyst.projectKey;
    return typeof key === "string" && key ? key : null;
  } catch {
    return null;
  }
}
