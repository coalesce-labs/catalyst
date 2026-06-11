import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { normalizeEventName } from "./reconcile.ts";

function isCanonical(obj: unknown): obj is { attributes: Record<string, unknown> } {
  return typeof obj === "object" && obj !== null && "attributes" in obj;
}

// Scan one JSONL file, returning a Map<normalizedEventName, count>.
// Streams line-by-line to avoid loading large month files into memory.
export async function scanJsonlFile(filePath: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      let rawName: string | undefined;
      if (isCanonical(obj)) {
        rawName = obj.attributes["event.name"] as string | undefined;
      } else if (typeof obj === "object" && obj !== null && "event" in obj) {
        rawName = (obj as Record<string, unknown>).event as string | undefined;
      }
      if (rawName) {
        const name = normalizeEventName(rawName);
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    } catch {
      // malformed line — skip
    }
  }

  return counts;
}
