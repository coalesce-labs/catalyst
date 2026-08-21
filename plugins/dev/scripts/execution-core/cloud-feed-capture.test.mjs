// cloud-feed-capture.test.mjs — CTL-1847.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCaptureSink, defaultCapturePath } from "./cloud-feed-capture.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "cf-capture-"));

describe("createCaptureSink", () => {
  test("writes the suppressed event and its verdict as one JSONL line", () => {
    const dir = tmp();
    const sink = createCaptureSink({ path: join(dir, "cap.jsonl") });
    const event = { ts: "2026-08-16T20:00:00Z", attributes: { "event.name": "linear.issue.state_changed" } };
    expect(sink.append(event, { suppress: true, reason: "smee-captured", source: "webhook" })).toBe(true);

    const lines = readFileSync(sink.path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.event).toEqual(event);
    expect(parsed.verdict.reason).toBe("smee-captured");
    expect(typeof parsed.capturedAt).toBe("string");
  });

  test("the captured event is a FAITHFUL copy — the verdict sits beside it, not merged in", () => {
    // If the annotation were merged into the event, the parity harness would be
    // diffing our bookkeeping instead of the two producers.
    const dir = tmp();
    const sink = createCaptureSink({ path: join(dir, "cap.jsonl") });
    const event = { ts: "t", body: { payload: { ticket: "CTL-1" } } };
    sink.append(event, { reason: "smee-captured" });
    const parsed = JSON.parse(readFileSync(sink.path, "utf8").trim());
    expect(parsed.event).toEqual(event);
    expect(parsed.event.verdict).toBeUndefined();
    expect(parsed.event.reason).toBeUndefined();
  });

  test("counts written and per-reason totals", () => {
    const dir = tmp();
    const sink = createCaptureSink({ path: join(dir, "cap.jsonl") });
    sink.append({ a: 1 }, { reason: "smee-captured" });
    sink.append({ a: 2 }, { reason: "smee-captured" });
    sink.append({ a: 3 }, { reason: "own-write-echo" });
    expect(sink.stats()).toEqual({
      written: 3,
      failed: 0,
      reasons: { "smee-captured": 2, "own-write-echo": 1 },
    });
  });

  test("REFUSES an event-log path at construction, not at first write", () => {
    // A guard that fires on the first write has already been handed a live config.
    const dir = tmp();
    expect(() => createCaptureSink({ path: join(dir, "2026-08.jsonl") })).toThrow();
  });

  test("REFUSES a path inside the events dir", () => {
    const dir = tmp();
    expect(() =>
      createCaptureSink({ path: join(dir, "events", "cap.jsonl"), eventsDir: join(dir, "events") }),
    ).toThrow();
  });

  test("NEGATIVE CONTROL: an ordinary path is accepted", () => {
    // Without this the refusal tests could pass against a sink that refuses
    // everything.
    const dir = tmp();
    expect(() => createCaptureSink({ path: join(dir, "capture", "linear.jsonl") })).not.toThrow();
  });

  test("is FAIL-OPEN on a write error, and COUNTS the failure", () => {
    // The capture is evidence; evidence must never be load-bearing for the
    // dispatch tail it observes. But a fail-open sink that doesn't count its
    // failures reads exactly like a sink with nothing to write.
    const dir = tmp();
    const sink = createCaptureSink({
      path: join(dir, "cap.jsonl"),
      appendFn: () => {
        throw new Error("EROFS");
      },
    });
    expect(() => sink.append({ a: 1 }, { reason: "smee-captured" })).not.toThrow();
    expect(sink.append({ a: 1 }, { reason: "smee-captured" })).toBe(false);
    expect(sink.stats().failed).toBe(2);
    expect(sink.stats().written).toBe(0);
  });

  test("an unserializable event is counted, named, and does not throw", () => {
    const dir = tmp();
    const sink = createCaptureSink({ path: join(dir, "cap.jsonl") });
    const circular = { a: 1 };
    circular.self = circular;
    expect(sink.append(circular, { reason: "smee-captured" })).toBe(false);
    expect(sink.stats().reasons.unserializable).toBe(1);
    expect(sink.stats().failed).toBe(1);
  });

  test("creates the parent directory", () => {
    const dir = tmp();
    const sink = createCaptureSink({ path: join(dir, "deep", "nested", "cap.jsonl") });
    sink.append({ a: 1 }, { reason: "r" });
    expect(existsSync(sink.path)).toBe(true);
  });
});

describe("defaultCapturePath", () => {
  test("lands under <orchDir>/capture and is not event-log shaped", () => {
    const p = defaultCapturePath("/orch", "tenant-0");
    expect(p).toBe("/orch/capture/linear-suppressed-tenant-0.jsonl");
    // The name must never match /^\d{4}-\d{2}\.jsonl$/ or the sink refuses it.
    expect(() => createCaptureSink({ path: p, appendFn: () => {}, mkdirFn: () => {} })).not.toThrow();
  });
});
