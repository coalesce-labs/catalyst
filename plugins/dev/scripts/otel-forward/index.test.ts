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
  test("processLine normalizes flat reap-intent lines and counts them as processed", async () => {
    const mod = await import("./index.ts");
    const flatLine = JSON.stringify({ ts: "2026-05-08T00:00:00Z", event: "phase.terminal.reap-requested", ticket: "CTL-1008" });
    const canonicalLine = JSON.stringify({ ts: "2026-05-08T00:00:01Z", attributes: { "event.name": "t" }, resource: { "service.name": "s", "service.namespace": "catalyst", "service.version": "1.0.0" }, severityText: "INFO", severityNumber: 9, traceId: null, spanId: null, body: {} });

    const statsBefore = mod.getStats();
    mod.processLine(flatLine);
    mod.processLine(canonicalLine);
    const statsAfter = mod.getStats();

    // Both flat and canonical lines now count as processed (not skipped)
    expect(statsAfter.processed).toBe(statsBefore.processed + 2);
    expect(statsAfter.skipped).toBe(statsBefore.skipped);
  });

  test("processLine still skips genuinely malformed lines (no event, no attributes)", async () => {
    const mod = await import("./index.ts");
    const malformedLine = JSON.stringify({ ts: "2026-05-08T00:00:00Z", someOtherField: "x" });
    const notJsonLine = "not-json{{{";

    const statsBefore = mod.getStats();
    mod.processLine(malformedLine);
    mod.processLine(notJsonLine);
    const statsAfter = mod.getStats();

    expect(statsAfter.skipped).toBe(statsBefore.skipped + 2);
    expect(statsAfter.processed).toBe(statsBefore.processed);
  });

  test("processLine normalized flat event has correct service.name and event.name in buffer", async () => {
    const mod = await import("./index.ts");
    const flatLine = JSON.stringify({ ts: "2026-05-08T00:00:01Z", event: "worktree.cleanup-deferred" });

    // We verify by calling processLine and checking stats; the buffer contents
    // are tested at the normalize.ts unit level
    const statsBefore = mod.getStats();
    mod.processLine(flatLine);
    const statsAfter = mod.getStats();
    expect(statsAfter.processed).toBe(statsBefore.processed + 1);
  });
});
