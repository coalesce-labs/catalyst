// linear-read-event.test.mjs — CTL-1403. Unit tests for the reads-by-source
// canonical-event builder/appender. Pure + hermetic: buildLinearReadEnvelope has
// no I/O; emitLinearReadEvent is exercised against an injected temp logPath so it
// never touches the real ~/catalyst/events log.
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LINEAR_READ_EVENT,
  LINEAR_READ_SOURCES,
  buildLinearReadEnvelope,
  emitLinearReadEvent,
} from "./linear-read-event.mjs";

const FIXED_TS = "2026-07-08T01:27:00Z";
const now = () => FIXED_TS;

const scratch = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "linear-read-event-"));
  scratch.push(d);
  return d;
}
afterEach(() => {
  while (scratch.length) {
    try { rmSync(scratch.pop(), { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe("LINEAR_READ_SOURCES", () => {
  test("is the closed 4-value enum, all non-replica prefixed 'linearis'", () => {
    expect([...LINEAR_READ_SOURCES]).toEqual([
      "replica",
      "linearis",
      "linearis_miss",
      "linearis_exception",
    ]);
    for (const s of LINEAR_READ_SOURCES) {
      if (s !== "replica") expect(s.startsWith("linearis")).toBe(true);
    }
    expect(Object.isFrozen(LINEAR_READ_SOURCES)).toBe(true);
  });
});

describe("buildLinearReadEnvelope", () => {
  test("replica-hit success: full attribute contract + INFO severity", () => {
    const e = buildLinearReadEnvelope(
      { source: "replica", result: "ok", op: "read_ticket", entity: "CTL-1403", ageMs: 4210 },
      { now },
    );
    expect(e.attributes["event.name"]).toBe(LINEAR_READ_EVENT);
    expect(e.attributes["event.entity"]).toBe("linear");
    expect(e.attributes["event.action"]).toBe("read");
    expect(e.attributes["event.label"]).toBe("CTL-1403"); // entity_id lives here, never a metric label
    expect(e.attributes["linear.read.source"]).toBe("replica");
    expect(e.attributes["linear.read.result"]).toBe("ok");
    expect(e.attributes["linear.read.op"]).toBe("read_ticket");
    expect(e.attributes["linear.read.age_ms"]).toBe(4210);
    expect(e.severityText).toBe("INFO");
    expect(e.severityNumber).toBe(9);
    expect(e.resource["service.name"]).toBe("catalyst.linear-read");
    expect(e.resource["service.namespace"]).toBe("catalyst");
    expect(e.ts).toBe(FIXED_TS);
  });

  test("failed read: WARN severity + result=failed", () => {
    const e = buildLinearReadEnvelope({ source: "linearis", result: "failed", entity: "CTL-9" }, { now });
    expect(e.severityText).toBe("WARN");
    expect(e.severityNumber).toBe(13);
    expect(e.attributes["linear.read.result"]).toBe("failed");
  });

  test("age_ms omitted when null / undefined / non-finite (never faked to 0)", () => {
    for (const ageMs of [null, undefined, NaN, Infinity]) {
      const e = buildLinearReadEnvelope({ source: "linearis_miss", result: "ok", entity: "CTL-1", ageMs }, { now });
      expect("linear.read.age_ms" in e.attributes).toBe(false);
    }
  });

  test("op + entity omitted when absent (list/search have no single entity)", () => {
    const e = buildLinearReadEnvelope({ source: "linearis", result: "ok" }, { now });
    expect("event.label" in e.attributes).toBe(false);
    expect("linear.read.op" in e.attributes).toBe(false);
    // source/result are always present (the metric dimensions).
    expect(e.attributes["linear.read.source"]).toBe("linearis");
    expect(e.attributes["linear.read.result"]).toBe("ok");
  });

  test("serviceName override (daemon surface = catalyst.execution-core)", () => {
    const e = buildLinearReadEnvelope(
      { source: "replica", result: "ok", entity: "CTL-2", serviceName: "catalyst.execution-core" },
      { now },
    );
    expect(e.resource["service.name"]).toBe("catalyst.execution-core");
  });

  test("no queryable field lands in body.payload (otel-forward strips it)", () => {
    const e = buildLinearReadEnvelope({ source: "replica", result: "ok", entity: "CTL-3", ageMs: 1 }, { now });
    // body carries only a human message; every queryable value is a flat attribute.
    expect(e.body.payload).toBeUndefined();
    expect(typeof e.body.message).toBe("string");
  });
});

describe("emitLinearReadEvent", () => {
  test("appends one canonical JSONL line to the injected logPath and returns true", () => {
    const logPath = join(tmp(), "events", "2026-07.jsonl");
    const ok = emitLinearReadEvent(
      { source: "replica", result: "ok", op: "read_ticket", entity: "CTL-1403", ageMs: 4210 },
      { logPath, now },
    );
    expect(ok).toBe(true);
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.attributes["event.name"]).toBe(LINEAR_READ_EVENT);
    expect(parsed.attributes["linear.read.source"]).toBe("replica");
    expect(parsed.severityText).toBe("INFO");
  });

  test("is best-effort: returns false and NEVER throws on an un-writable path (CTL-988)", () => {
    // A path whose parent is a file, not a directory → mkdir/append fail internally.
    const dir = tmp();
    const filePath = join(dir, "events");
    // create a FILE at 'events' so resolve(dir,'events','x.jsonl') can't mkdir.
    emitLinearReadEvent({ source: "replica", result: "ok", entity: "CTL-1" }, { logPath: filePath, now }); // seeds nothing harmful
    const bad = join(filePath, "sub", "2026-07.jsonl");
    let threw = false;
    let ret = null;
    try {
      ret = emitLinearReadEvent({ source: "replica", result: "ok", entity: "CTL-1" }, { logPath: bad, now });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(ret).toBe(false);
  });
});
