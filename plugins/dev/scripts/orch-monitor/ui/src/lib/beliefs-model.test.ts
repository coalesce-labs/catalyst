// beliefs-model.test.ts — CTL-1100 Phase 6

import { describe, it, expect } from "bun:test";
import {
  isBeliefFrame,
  decodeBeliefFrame,
  beliefKey,
  applyBeliefFrame,
  beliefsToArray,
  EMPTY_BELIEFS_STATE,
  type BeliefFrame,
} from "./beliefs-model";

function makeFrame(belief_id: number, rule_id = "R1", subject = "CTL-1/plan"): BeliefFrame {
  return { belief_id, tick_id: 1, rule_id, name: "session_registered", subject,
           value: null, source_fact_ids: "[]", stratum: 1, ts_ms: 1000, host: "h1", rules_sha: null };
}

describe("isBeliefFrame", () => {
  it("accepts a valid frame", () => {
    expect(isBeliefFrame(makeFrame(1))).toBe(true);
  });
  it("rejects null", () => {
    expect(isBeliefFrame(null)).toBe(false);
  });
  it("rejects missing belief_id", () => {
    const { belief_id: _, ...rest } = makeFrame(1);
    expect(isBeliefFrame(rest)).toBe(false);
  });
  it("rejects non-string rule_id", () => {
    expect(isBeliefFrame({ ...makeFrame(1), rule_id: 42 })).toBe(false);
  });
});

describe("decodeBeliefFrame", () => {
  it("parses valid JSON frame", () => {
    const f = makeFrame(5);
    expect(decodeBeliefFrame(JSON.stringify(f))).toEqual(f);
  });
  it("returns null for bad JSON", () => {
    expect(decodeBeliefFrame("{not json")).toBeNull();
  });
  it("returns null for truncated object", () => {
    expect(decodeBeliefFrame(JSON.stringify({ belief_id: 1 }))).toBeNull();
  });
});

describe("applyBeliefFrame", () => {
  it("latest belief_id per key wins", () => {
    const s0 = EMPTY_BELIEFS_STATE;
    const s1 = applyBeliefFrame(s0, makeFrame(5));
    const s2 = applyBeliefFrame(s1, makeFrame(3)); // lower id — must NOT overwrite
    const frames = beliefsToArray(s2.store);
    expect(frames.length).toBe(1);
    expect(frames[0]?.belief_id).toBe(5);
  });

  it("higher belief_id replaces lower", () => {
    const s0 = EMPTY_BELIEFS_STATE;
    const s1 = applyBeliefFrame(s0, makeFrame(3));
    const s2 = applyBeliefFrame(s1, makeFrame(7));
    expect(beliefsToArray(s2.store)[0]?.belief_id).toBe(7);
  });

  it("cursor is monotonically increasing", () => {
    const s0 = EMPTY_BELIEFS_STATE;
    const s1 = applyBeliefFrame(s0, makeFrame(10));
    const s2 = applyBeliefFrame(s1, makeFrame(5)); // lower — cursor stays at 10
    expect(s2.cursor).toBe(10);
  });

  it("two different keys coexist", () => {
    const s0 = EMPTY_BELIEFS_STATE;
    const s1 = applyBeliefFrame(s0, makeFrame(1, "R1", "CTL-1/plan"));
    const s2 = applyBeliefFrame(s1, makeFrame(2, "R2", "CTL-2/plan"));
    expect(s2.store.size).toBe(2);
  });
});
