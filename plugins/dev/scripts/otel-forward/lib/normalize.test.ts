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

  test("false for flat event (has string event field) — flat events win", () => {
    expect(isPinoRecord({ event: "phase.x", level: 40, msg: "m" })).toBe(false);
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
    const c = normalizePinoRecord({ level: 40, time: BASE_TIME, msg: "warn line", name: "execution-core", pid: 123 });
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
    const c = normalizePinoRecord({ level: 30, time: BASE_TIME, msg: "m", pid: 42, name: "execution-core" });
    const payload = (c.body as { payload: Record<string, unknown> }).payload;
    expect(payload).toBeDefined();
    expect(payload.pid).toBe(42);
    expect(payload.name).toBe("execution-core");
  });

  test("output has attributes (passes processLine gate)", () => {
    const c = normalizePinoRecord({ level: 30, msg: "info" });
    expect("attributes" in c).toBe(true);
  });
});
