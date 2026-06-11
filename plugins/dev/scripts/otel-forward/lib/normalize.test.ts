import { describe, test, expect } from "bun:test";
import { normalizeFlatEvent, isFlatEvent } from "./normalize.ts";

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
