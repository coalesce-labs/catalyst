// memory-event.test.mjs — CTL-685. OTel memory-event builder + best-effort
// appender. buildMemoryEnvelope is asserted without touching the FS;
// emitMemoryEvent is exercised against a temp event log.
//
// Run: cd plugins/dev/scripts/execution-core && bun test memory-event.test.mjs

import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMemoryEnvelope,
  emitMemoryEvent,
  MEMORY_EVENT_SAMPLED,
  MEMORY_EVENT_WARN,
  MEMORY_EVENT_KILLED,
} from "./memory-event.mjs";

const basePayload = {
  sessionId: "abcd1234-5555-6666-7777-888888888888",
  shortId: "abcd1234",
  ticket: "CTL-685",
  phase: "implement",
  rss_mb: 1200,
};

describe("buildMemoryEnvelope", () => {
  test("sampled event has INFO severity and correct event name", () => {
    const env = buildMemoryEnvelope(MEMORY_EVENT_SAMPLED, basePayload);
    expect(env.severityText).toBe("INFO");
    expect(env.severityNumber).toBe(9);
    expect(env.attributes["event.name"]).toBe("worker.memory.sampled");
    expect(env.attributes["event.entity"]).toBe("worker");
    expect(env.resource["service.name"]).toBe("catalyst.execution-core");
  });

  test("warn event has WARN severity", () => {
    const env = buildMemoryEnvelope(MEMORY_EVENT_WARN, basePayload);
    expect(env.severityText).toBe("WARN");
  });

  test("killed event has WARN severity", () => {
    const env = buildMemoryEnvelope(MEMORY_EVENT_KILLED, basePayload);
    expect(env.severityText).toBe("WARN");
  });

  test("linear.issue.identifier present when ticket provided; event.label is ticket", () => {
    const env = buildMemoryEnvelope(MEMORY_EVENT_SAMPLED, basePayload);
    expect(env.attributes["linear.issue.identifier"]).toBe("CTL-685");
    expect(env.attributes["event.label"]).toBe("CTL-685");
  });

  test("no linear.issue.identifier when ticket absent; label falls back to shortId", () => {
    const env = buildMemoryEnvelope(MEMORY_EVENT_SAMPLED, {
      sessionId: "abcd1234-5555-6666-7777-888888888888",
      shortId: "abcd1234",
      rss_mb: 800,
    });
    expect("linear.issue.identifier" in env.attributes).toBe(false);
    expect(env.attributes["event.label"]).toBe("abcd1234");
  });

  test("label falls back to sessionId when shortId absent", () => {
    const env = buildMemoryEnvelope(MEMORY_EVENT_SAMPLED, {
      sessionId: "abcd1234-5555-6666-7777-888888888888",
      rss_mb: 800,
    });
    expect(env.attributes["event.label"]).toBe("abcd1234-5555-6666-7777-888888888888");
  });

  test("label is 'unknown' when all ids absent", () => {
    const env = buildMemoryEnvelope(MEMORY_EVENT_SAMPLED, { rss_mb: 800 });
    expect(env.attributes["event.label"]).toBe("unknown");
  });

  test("swap_mb defaults to null when omitted", () => {
    const env = buildMemoryEnvelope(MEMORY_EVENT_SAMPLED, basePayload);
    expect(env.body.payload.swap_mb).toBe(null);
  });

  test("payload carries all fields including threshold_mb and sample_count", () => {
    const env = buildMemoryEnvelope(MEMORY_EVENT_WARN, {
      ...basePayload,
      rss_mb: 5000,
      threshold_mb: 4000,
      sample_count: 3,
    });
    expect(env.body.payload).toMatchObject({
      sessionId: basePayload.sessionId,
      shortId: "abcd1234",
      ticket: "CTL-685",
      phase: "implement",
      rss_mb: 5000,
      swap_mb: null,
      threshold_mb: 4000,
      sample_count: 3,
    });
  });

  test("ts is a Z-suffixed timestamp with no millisecond fraction", () => {
    const env = buildMemoryEnvelope(MEMORY_EVENT_SAMPLED, basePayload);
    expect(env.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test("injectable now() overrides timestamp", () => {
    const fixed = "2026-05-29T12:00:00Z";
    const env = buildMemoryEnvelope(MEMORY_EVENT_SAMPLED, basePayload, { now: () => fixed });
    expect(env.ts).toBe(fixed);
    expect(env.observedTs).toBe(fixed);
  });

  test("envelope has id, traceId, spanId random hex fields", () => {
    const env = buildMemoryEnvelope(MEMORY_EVENT_SAMPLED, basePayload);
    expect(env.id).toMatch(/^[0-9a-f]{16}$/);
    expect(env.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(env.spanId).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("emitMemoryEvent", () => {
  test("appends exactly one valid JSON line to the event log and returns true", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl685-me-"));
    const logPath = join(dir, "2026-05.jsonl");
    const ok = emitMemoryEvent(MEMORY_EVENT_SAMPLED, basePayload, { logPath });
    expect(ok).toBe(true);
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.attributes["event.name"]).toBe(MEMORY_EVENT_SAMPLED);
    expect(parsed.body.payload.ticket).toBe("CTL-685");
  });

  test("creates the parent directory when missing (never throws)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl685-me-"));
    const logPath = join(dir, "nested", "deep", "2026-05.jsonl");
    expect(emitMemoryEvent(MEMORY_EVENT_WARN, basePayload, { logPath })).toBe(true);
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
  });

  test("returns false and does not throw for an unwritable logPath", () => {
    // Use a path under a non-existent root that cannot be created
    // The simplest way: pass a directory as the logPath (can't appendFileSync to a dir)
    const dir = mkdtempSync(join(tmpdir(), "ctl685-me-bad-"));
    // logPath is the dir itself (not a file) — appendFileSync will throw EISDIR
    let result;
    expect(() => {
      result = emitMemoryEvent(MEMORY_EVENT_SAMPLED, basePayload, { logPath: dir });
    }).not.toThrow();
    expect(result).toBe(false);
  });
});
