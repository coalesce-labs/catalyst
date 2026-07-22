import { describe, test, expect } from "bun:test";
import { normalizeFlatEvent, isFlatEvent, isPinoRecord, normalizePinoRecord } from "./normalize.ts";

describe("isFlatEvent", () => {
  test("true for flat reap-intent record", () => {
    expect(
      isFlatEvent({ ts: "2026-06-01T00:00:00Z", event: "phase.terminal.reap-requested" })
    ).toBe(true);
  });
  test("false for canonical record (has attributes)", () => {
    expect(isFlatEvent({ ts: "2026-06-01T00:00:00Z", attributes: { "event.name": "x" } })).toBe(
      false
    );
  });
  test("false for object with neither event nor attributes", () => {
    expect(isFlatEvent({ ts: "2026-06-01T00:00:00Z" })).toBe(false);
  });
});

describe("normalizeFlatEvent", () => {
  test("maps flat event → canonical envelope under catalyst.execution-core", () => {
    const flat = {
      ts: "2026-06-08T00:00:00Z",
      event: "phase.terminal.reap-requested",
      ticket: "CTL-1008",
      phase: "plan",
      bg_job_id: "abc123",
      reason: "quiet",
    };
    const c = normalizeFlatEvent(flat);
    expect(c.resource["service.name"]).toBe("catalyst.execution-core");
    expect(c.attributes["event.name"]).toBe("phase.terminal.reap-requested");
    expect(c.attributes["catalyst.worker.ticket"]).toBe("CTL-1008");
    expect(c.severityText).toBeDefined();
    expect(c.body).toBeDefined();
    // unknown flat fields land in body.payload, not dropped
    expect((c.body as { payload: Record<string, unknown> }).payload.reason).toBe("quiet");
  });

  test("output passes the canonical attributes-key gate", () => {
    const result = normalizeFlatEvent({
      ts: "2026-06-01T00:00:00Z",
      event: "orphans.reap-requested",
    });
    expect("attributes" in result).toBe(true);
  });

  test("ts maps to both ts and observedTs", () => {
    const c = normalizeFlatEvent({
      ts: "2026-06-01T00:00:00Z",
      event: "phase.yield.reap-requested",
    });
    expect(c.ts).toBe("2026-06-01T00:00:00Z");
    expect(c.observedTs).toBe("2026-06-01T00:00:00Z");
  });

  test("id is deterministic for same input", () => {
    const flat = {
      ts: "2026-06-01T00:00:00Z",
      event: "worktree.cleanup-deferred",
      bg_job_id: "xyz",
    };
    const c1 = normalizeFlatEvent(flat);
    const c2 = normalizeFlatEvent(flat);
    expect(c1.id).toBe(c2.id);
  });

  test("known field ticket maps to catalyst.worker.ticket attribute", () => {
    const c = normalizeFlatEvent({
      ts: "t",
      event: "phase.abort.reap-requested",
      ticket: "CTL-999",
    });
    expect(c.attributes["catalyst.worker.ticket"]).toBe("CTL-999");
  });

  test("known field orch_id maps to catalyst.orchestrator.id attribute", () => {
    const c = normalizeFlatEvent({
      ts: "t",
      event: "phase.abort.reap-requested",
      orch_id: "CTL-999",
    });
    expect(c.attributes["catalyst.orchestrator.id"]).toBe("CTL-999");
  });
});

describe("isPinoRecord (CTL-1424)", () => {
  test("true for pino-shaped record with numeric level and string msg", () => {
    expect(isPinoRecord({ level: 40, msg: "some warning" })).toBe(true);
  });

  test("true when a structured `event` field is present (reaper WARN/ERROR shape)", () => {
    // A pino log with level+msg is a pino record even if it also carries an
    // `event` field; processLine checks isPinoRecord first so severity survives.
    expect(isPinoRecord({ event: "phase.x", level: 40, msg: "m" })).toBe(true);
  });

  test("false for a real flat catalyst event (no numeric level / string msg)", () => {
    expect(isPinoRecord({ ts: "2026-06-01T00:00:00Z", event: "phase.x" })).toBe(false);
  });

  test("false for canonical record (has attributes)", () => {
    expect(isPinoRecord({ attributes: { "event.name": "x" }, level: 40, msg: "m" })).toBe(false);
  });

  test("false when level is string (not number)", () => {
    expect(isPinoRecord({ level: "40", msg: "m" })).toBe(false);
  });

  test("false when msg is missing", () => {
    expect(isPinoRecord({ level: 40 })).toBe(false);
  });

  test("false for null", () => {
    expect(isPinoRecord(null)).toBe(false);
  });

  test("false for non-object", () => {
    expect(isPinoRecord("string")).toBe(false);
  });
});

describe("normalizePinoRecord (CTL-1424)", () => {
  const BASE_TIME = 1751500000000;

  test("level 40 → WARN / 13", () => {
    const c = normalizePinoRecord({
      level: 40,
      time: BASE_TIME,
      msg: "warn line",
      name: "execution-core",
      pid: 123,
    });
    expect(c.severityText).toBe("WARN");
    expect(c.severityNumber).toBe(13);
  });

  test("level 10 → TRACE / 1 (AC endpoint)", () => {
    const c = normalizePinoRecord({ level: 10, time: BASE_TIME, msg: "trace line" });
    expect(c.severityText).toBe("TRACE");
    expect(c.severityNumber).toBe(1);
  });

  test("level 60 → FATAL / 21 (AC endpoint)", () => {
    const c = normalizePinoRecord({ level: 60, time: BASE_TIME, msg: "fatal line" });
    expect(c.severityText).toBe("FATAL");
    expect(c.severityNumber).toBe(21);
  });

  test("resource service.name === catalyst.execution-core", () => {
    const c = normalizePinoRecord({ level: 30, msg: "info" });
    expect(c.resource["service.name"]).toBe("catalyst.execution-core");
  });

  test("ts derived from time (unix ms)", () => {
    const c = normalizePinoRecord({ level: 30, time: BASE_TIME, msg: "info" });
    expect(c.ts).toBe(new Date(BASE_TIME).toISOString());
  });

  test("body.message === msg", () => {
    const c = normalizePinoRecord({ level: 30, time: BASE_TIME, msg: "the message" });
    expect((c.body as { message: string }).message).toBe("the message");
  });

  test("residual fields (pid, name) preserved in body.payload", () => {
    const c = normalizePinoRecord({
      level: 30,
      time: BASE_TIME,
      msg: "m",
      pid: 42,
      name: "execution-core",
    });
    const payload = (c.body as { payload: Record<string, unknown> }).payload;
    expect(payload).toBeDefined();
    expect(payload.pid).toBe(42);
    expect(payload.name).toBe("execution-core");
  });

  test("output has attributes (passes processLine gate)", () => {
    const c = normalizePinoRecord({ level: 30, msg: "info" });
    expect("attributes" in c).toBe(true);
  });

  // CTL-1424 Codex P2 #3: service.name follows the pino logger `name`.
  test("service.name derived from logger name (catalyst.<name>)", () => {
    const c = normalizePinoRecord({ level: 40, time: BASE_TIME, msg: "m", name: "broker" });
    expect(c.resource["service.name"]).toBe("catalyst.broker");
  });

  test("service.name not double-prefixed when name already catalyst.*", () => {
    const c = normalizePinoRecord({
      level: 40,
      time: BASE_TIME,
      msg: "m",
      name: "catalyst.cloud-sync",
    });
    expect(c.resource["service.name"]).toBe("catalyst.cloud-sync");
  });

  // CTL-1424 Codex P2 #1: a pino WARN/ERROR carrying an `event` field keeps its
  // severity, and the event field is preserved in payload (not treated as flat).
  test("event-field WARN record keeps WARN severity, event lands in payload", () => {
    const c = normalizePinoRecord({
      level: 40,
      time: BASE_TIME,
      msg: "reaper: handler threw",
      event: "phase.x.reap",
    });
    expect(c.severityText).toBe("WARN");
    expect(c.severityNumber).toBe(13);
    expect((c.body as { message: string }).message).toBe("reaper: handler threw");
    const payload = (c.body as { payload: Record<string, unknown> }).payload;
    expect(payload.event).toBe("phase.x.reap");
  });

  // CTL-1424 Codex P2 #4: pino trace context lifted to top-level traceId/spanId.
  test("valid trace_id/span_id preserved at top level", () => {
    const c = normalizePinoRecord({
      level: 30,
      time: BASE_TIME,
      msg: "tick",
      trace_id: "6fe12c6b16282dc66b1da0b1b96e403c",
      span_id: "c68263307ba267a2",
    });
    expect(c.traceId).toBe("6fe12c6b16282dc66b1da0b1b96e403c");
    expect(c.spanId).toBe("c68263307ba267a2");
  });

  test("malformed trace_id/span_id are dropped (stay null)", () => {
    const c = normalizePinoRecord({
      level: 30,
      time: BASE_TIME,
      msg: "m",
      trace_id: "not-hex",
      span_id: "xyz",
    });
    expect(c.traceId).toBeNull();
    expect(c.spanId).toBeNull();
  });

  // CTL-1424 Codex P2 #2: same-ms bursts get distinct ids / logRecordUids.
  test("distinct ids for same-ms records that differ in msg or severity", () => {
    const base = { time: BASE_TIME, name: "execution-core", pid: 7 };
    const a = normalizePinoRecord({ ...base, level: 40, msg: "first" });
    const b = normalizePinoRecord({ ...base, level: 40, msg: "second" });
    const cWarn = normalizePinoRecord({ ...base, level: 50, msg: "first" });
    expect(a.id).not.toBe(b.id);
    expect(a.id).not.toBe(cWarn.id);
  });
});

// CTL-764 Phase 6: canonical worker.transition events must not be rewritten by normalizeFlatEvent.
describe("isFlatEvent / worker.transition canonical guard (CTL-764)", () => {
  test("canonical worker.transition record (has attributes) → isFlatEvent returns false", () => {
    const canonical = {
      ts: "2026-07-08T00:00:00Z",
      attributes: {
        "event.name": "worker.transition.CTL-764",
        "catalyst.worker.ticket": "CTL-764",
        "catalyst.worker.to_disposition": "needs-human",
      },
      body: {},
    };
    expect(isFlatEvent(canonical)).toBe(false);
  });

  test("flat worker.transition record (has event) → isFlatEvent returns true", () => {
    const flat = {
      ts: "2026-07-08T00:00:00Z",
      event: "worker.transition.CTL-764",
      ticket: "CTL-764",
    };
    expect(isFlatEvent(flat)).toBe(true);
  });
});
