import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTailer } from "./tail.ts";

describe("createTailer", () => {
  test("emits only canonical lines (has attributes)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tail-"));
    const file = join(dir, "2026-05.jsonl");
    writeFileSync(file, JSON.stringify({ ts: "2026-05-08T00:00:00Z", event: "old" }) + "\n");
    appendFileSync(file, JSON.stringify({ ts: "2026-05-08T00:00:01Z", attributes: { "event.name": "test" } }) + "\n");

    const emitted: string[] = [];
    const ac = new AbortController();
    const tailer = createTailer({ filePath: file, offset: 0, onLine: (l) => emitted.push(l), signal: ac.signal, pollMs: 10 });
    await tailer.drain();
    ac.abort();

    expect(emitted.length).toBe(1);
    const parsed = JSON.parse(emitted[0]);
    expect(parsed.attributes["event.name"]).toBe("test");
    rmSync(dir, { recursive: true });
  });

  test("handles month rollover by switching file path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tail-"));
    let callCount = 0;
    const monthFn = () => {
      callCount++;
      return callCount === 1 ? join(dir, "2026-04.jsonl") : join(dir, "2026-05.jsonl");
    };
    const tailer = createTailer({ monthFn, offset: 0, onLine: () => {}, signal: new AbortController().signal, pollMs: 10 });
    expect(tailer.currentPath()).toBe(join(dir, "2026-04.jsonl"));
    rmSync(dir, { recursive: true });
  });
});
