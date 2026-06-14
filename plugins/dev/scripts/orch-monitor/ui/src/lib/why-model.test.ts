// why-model.test.ts — CTL-1100 Phase 6

import { describe, it, expect } from "bun:test";
import { isTraceResult, emptyTrace } from "./why-model";

describe("isTraceResult", () => {
  it("accepts documented shape", () => {
    expect(isTraceResult({
      ticket: "CTL-1234",
      tickId: 42,
      nowMs: 1000,
      host: "h1",
      beliefs: [{ belief_id: 1, name: "session_registered", subject: "CTL-1234/plan",
                  value: null, rule_id: "R1", stratum: 1, sources: [] }],
    })).toBe(true);
  });
  it("accepts empty shape {ticket, tickId:null, beliefs:[]}", () => {
    expect(isTraceResult({ ticket: "CTL-99", tickId: null, beliefs: [] })).toBe(true);
  });
  it("rejects null", () => expect(isTraceResult(null)).toBe(false));
  it("rejects missing beliefs", () => expect(isTraceResult({ ticket: "CTL-1", tickId: 1 })).toBe(false));
  it("rejects non-string ticket", () => expect(isTraceResult({ ticket: 123, tickId: 1, beliefs: [] })).toBe(false));
});

describe("emptyTrace", () => {
  it("is a valid TraceResult", () => {
    expect(isTraceResult(emptyTrace("CTL-1"))).toBe(true);
  });
  it("has tickId null and empty beliefs", () => {
    const t = emptyTrace("CTL-1");
    expect(t.tickId).toBeNull();
    expect(t.beliefs).toEqual([]);
  });
});
