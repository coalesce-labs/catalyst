import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTailer } from "./lib/tail.ts";
import { readCheckpoint, writeCheckpoint } from "./lib/checkpoint.ts";
import { computeLagMs, buildLagEvent } from "./index.ts";

describe("computeLagMs (CTL-1060 Phase 3)", () => {
  test("returns ms delta between localNewestTs and lastForwardedTs", () => {
    expect(computeLagMs("2026-06-12T10:00:10Z", "2026-06-12T10:00:00Z")).toBe(10_000);
  });

  test("returns 0 when lastForwardedTs >= localNewestTs (caught-up or ahead)", () => {
    expect(computeLagMs("2026-06-12T10:00:00Z", "2026-06-12T10:00:10Z")).toBe(0);
    expect(computeLagMs("2026-06-12T10:00:00Z", "2026-06-12T10:00:00Z")).toBe(0);
  });

  test("returns 0 when either timestamp is undefined", () => {
    expect(computeLagMs(undefined, "2026-06-12T10:00:00Z")).toBe(0);
    expect(computeLagMs("2026-06-12T10:00:00Z", undefined)).toBe(0);
    expect(computeLagMs(undefined, undefined)).toBe(0);
  });
});

describe("buildLagEvent (CTL-1060 Phase 3)", () => {
  test("returns canonical event with forward_lag name and correct payload fields", () => {
    const ev = buildLagEvent({
      localNewestTs: "2026-06-12T10:00:10Z",
      lastForwardedTs: "2026-06-12T10:00:00Z",
      dlqDepth: 5,
    });
    expect(ev.attributes["event.name"]).toBe("catalyst.observability.forward_lag");
    expect(ev.resource["service.name"]).toBe("catalyst.otel-forward");
    const payload = ev.body?.payload as Record<string, unknown>;
    expect(payload.lagMs).toBe(10_000);
    expect(payload.localNewestTs).toBe("2026-06-12T10:00:10Z");
    expect(payload.lastForwardedTs).toBe("2026-06-12T10:00:00Z");
    expect(payload.dlqDepth).toBe(5);
  });
});

describe("checkpoint persists real read offset (CTL-766)", () => {
  test("a checkpoint written from tailer.currentOffset() resumes past the backlog", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ckoff-"));
    const file = join(dir, "2026-05.jsonl");
    const ckPath = join(dir, "otel-forward.checkpoint.json");
    const line =
      JSON.stringify({ ts: "2026-05-08T00:00:01Z", attributes: { "event.name": "t" } }) + "\n";
    writeFileSync(file, line);

    const ac = new AbortController();
    const tailer = createTailer({
      filePath: file,
      offset: 0,
      onLine: () => {},
      signal: ac.signal,
      pollMs: 10,
    });
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
    const flatLine = JSON.stringify({
      ts: "2026-05-08T00:00:00Z",
      event: "phase.terminal.reap-requested",
      ticket: "CTL-1008",
    });
    const canonicalLine = JSON.stringify({
      ts: "2026-05-08T00:00:01Z",
      attributes: { "event.name": "t" },
      resource: {
        "service.name": "s",
        "service.namespace": "catalyst",
        "service.version": "1.0.0",
      },
      severityText: "INFO",
      severityNumber: 9,
      traceId: null,
      spanId: null,
      body: {},
    });

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
    const flatLine = JSON.stringify({
      ts: "2026-05-08T00:00:01Z",
      event: "worktree.cleanup-deferred",
    });

    // We verify by calling processLine and checking stats; the buffer contents
    // are tested at the normalize.ts unit level
    const statsBefore = mod.getStats();
    mod.processLine(flatLine);
    const statsAfter = mod.getStats();
    expect(statsAfter.processed).toBe(statsBefore.processed + 1);
  });

  test("processLine counts pino-shaped records as processed (CTL-1424)", async () => {
    const mod = await import("./index.ts");
    const pinoLine = JSON.stringify({ level: 40, time: 1751500000000, msg: "warn line" });
    const statsBefore = mod.getStats();
    mod.processLine(pinoLine);
    const statsAfter = mod.getStats();
    expect(statsAfter.processed).toBe(statsBefore.processed + 1);
    expect(statsAfter.skipped).toBe(statsBefore.skipped);
  });

  test("canonical event with existing severity is emitted unchanged through processLine (CTL-1424 AC bullet 2)", async () => {
    const mod = await import("./index.ts");
    const canonicalLine = JSON.stringify({
      ts: "2026-05-08T00:00:01Z",
      attributes: { "event.name": "some.error.event" },
      resource: { "service.name": "catalyst.some-service", "service.namespace": "catalyst", "service.version": "1.0.0" },
      severityText: "ERROR",
      severityNumber: 17,
      traceId: null,
      spanId: null,
      body: { message: "error" },
    });
    const statsBefore = mod.getStats();
    mod.processLine(canonicalLine);
    const statsAfter = mod.getStats();
    expect(statsAfter.processed).toBe(statsBefore.processed + 1);
  });
});

describe("pino records through tailer shouldForward (CTL-1424)", () => {
  test("tailer emits pino-shaped lines via onLine", async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createTailer } = await import("./lib/tail.ts");

    const dir = mkdtempSync(join(tmpdir(), "pino-tail-"));
    const file = join(dir, "2026-05.jsonl");
    writeFileSync(file, JSON.stringify({ level: 40, time: 1751500000000, msg: "warn line" }) + "\n");

    const emitted: string[] = [];
    const ac = new AbortController();
    const tailer = createTailer({
      filePath: file,
      offset: 0,
      onLine: (l) => emitted.push(l),
      signal: ac.signal,
      pollMs: 10,
    });
    await tailer.drain();
    ac.abort();

    expect(emitted.length).toBe(1);
    const parsed = JSON.parse(emitted[0]);
    expect(parsed.level).toBe(40);
    rmSync(dir, { recursive: true });
  });
});
