// journey-model.test.ts — CTL-1100 Phase 6

import { describe, it, expect } from "bun:test";
import { isJourney, journeyPhaseStatus, PHASE_LIST, type Journey } from "./journey-model";

function makeJourney(overrides: Partial<Journey> = {}): Journey {
  return {
    ticket: "CTL-9001",
    hops: [],
    gates: {
      checklist: PHASE_LIST.map((p) => ({
        phase: p,
        signalStatus: null,
        satisfied: false,
      })),
      nextPhase: null,
    },
    verifyVerdict: { verdict: null },
    remediateCycles: 0,
    unblockHints: [],
    hosts: [],
    ...overrides,
  };
}

describe("isJourney", () => {
  it("accepts a well-formed journey", () => {
    expect(isJourney(makeJourney())).toBe(true);
  });
  it("rejects null", () => expect(isJourney(null)).toBe(false));
  it("rejects missing ticket", () => expect(isJourney({ hops: [], gates: { checklist: [], nextPhase: null }, hosts: [], remediateCycles: 0, unblockHints: [], verifyVerdict: { verdict: null } })).toBe(false));
  it("rejects non-array hops", () => expect(isJourney({ ...makeJourney(), hops: "x" })).toBe(false));
});

describe("journeyPhaseStatus", () => {
  it("satisfied gate → done", () => {
    const j = makeJourney({
      gates: {
        checklist: PHASE_LIST.map((p) => ({
          phase: p,
          signalStatus: p === "implement" ? "done" : null,
          satisfied: p === "implement",
        })),
        nextPhase: "verify",
      },
    });
    expect(journeyPhaseStatus(j, "implement")).toBe("done");
  });

  it("nextPhase → current", () => {
    const j = makeJourney({
      gates: {
        checklist: PHASE_LIST.map((p) => ({
          phase: p,
          signalStatus: p === "implement" ? "done" : null,
          satisfied: p === "implement",
        })),
        nextPhase: "verify",
      },
    });
    expect(journeyPhaseStatus(j, "verify")).toBe("current");
  });

  it("verify with fail verdict → failed", () => {
    const j = makeJourney({
      gates: {
        checklist: PHASE_LIST.map((p) => ({
          phase: p,
          signalStatus: p === "verify" ? "done" : (p === "implement" ? "done" : null),
          satisfied: p !== "verify" && p !== "implement" ? false : p === "implement",
        })),
        nextPhase: "remediate",
      },
      verifyVerdict: { verdict: "fail" },
    });
    expect(journeyPhaseStatus(j, "verify")).toBe("failed");
  });

  it("untouched phase → pending", () => {
    const j = makeJourney();
    expect(journeyPhaseStatus(j, "teardown")).toBe("pending");
  });

  it("anchored to PHASE_LIST (10 phases)", () => {
    expect(PHASE_LIST.length).toBe(10);
    const j = makeJourney();
    for (const p of PHASE_LIST) {
      const status = journeyPhaseStatus(j, p);
      expect(["done","current","pending","failed"].includes(status)).toBe(true);
    }
  });
});
