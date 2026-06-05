import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTailer } from "./lib/tail.ts";
import { readCheckpoint, writeCheckpoint } from "./lib/checkpoint.ts";

describe("checkpoint persists real read offset (CTL-766)", () => {
  test("a checkpoint written from tailer.currentOffset() resumes past the backlog", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ckoff-"));
    const file = join(dir, "2026-05.jsonl");
    const ckPath = join(dir, "otel-forward.checkpoint.json");
    const line = JSON.stringify({ ts: "2026-05-08T00:00:01Z", attributes: { "event.name": "t" } }) + "\n";
    writeFileSync(file, line);

    const ac = new AbortController();
    const tailer = createTailer({ filePath: file, offset: 0, onLine: () => {}, signal: ac.signal, pollMs: 10 });
    await tailer.drain();
    ac.abort();

    // Mirror the production ckTimer write: persist the REAL position, not 0.
    writeCheckpoint(ckPath, { path: tailer.currentPath(), offset: tailer.currentOffset() });

    const ck = readCheckpoint(ckPath);
    expect(ck?.offset).toBe(Buffer.byteLength(line, "utf8"));
    expect(ck?.offset).not.toBe(0);
    rmSync(dir, { recursive: true });
  });
});

describe("daemon integration", () => {
  test("processLine skips legacy lines and counts canonical", async () => {
    // Reset module state by reimporting fresh
    const mod = await import("./index.ts");
    // The module initializes stats when imported; test that exported functions work
    // processLine should skip non-canonical lines
    const legacyLine = JSON.stringify({ ts: "2026-05-08T00:00:00Z", event: "old" });
    const canonicalLine = JSON.stringify({ ts: "2026-05-08T00:00:01Z", attributes: { "event.name": "t" }, resource: { "service.name": "s", "service.namespace": "catalyst", "service.version": "1.0.0" }, severityText: "INFO", severityNumber: 9, traceId: null, spanId: null, body: {} });

    const statsBefore = mod.getStats();
    mod.processLine(legacyLine);
    mod.processLine(canonicalLine);
    const statsAfter = mod.getStats();

    expect(statsAfter.skipped).toBe(statsBefore.skipped + 1);
    expect(statsAfter.processed).toBe(statsBefore.processed + 1);
  });
});
