// governance-model.test.ts — CTL-1100 Phase 6

import { describe, it, expect } from "bun:test";
import {
  isGovernanceSnapshot,
  flagTone,
  modeTone,
  GOVERNANCE_FLAG_LABELS,
} from "./governance-model";

describe("isGovernanceSnapshot", () => {
  it("accepts minimal {available:false}", () => {
    expect(isGovernanceSnapshot({ available: false })).toBe(true);
  });
  it("accepts full readGovernanceConfig() shape", () => {
    expect(isGovernanceSnapshot({
      available: true,
      beliefsShadow: true,
      diagnostician: false,
      intentsEnforce: false,
      advanceShadowSummary: false,
      stallJanitor: { mode: "enforce" },
      watchdog: { mode: "shadow" },
      unstuckSweep: { mode: "off" },
    })).toBe(true);
  });
  it("rejects null", () => expect(isGovernanceSnapshot(null)).toBe(false));
  it("rejects missing available", () => expect(isGovernanceSnapshot({ beliefsShadow: true })).toBe(false));
  it("rejects non-boolean available", () => expect(isGovernanceSnapshot({ available: "yes" })).toBe(false));
});

describe("flagTone", () => {
  it("true → green", () => expect(flagTone(true)).toBe("green"));
  it("false → muted", () => expect(flagTone(false)).toBe("muted"));
});

describe("modeTone", () => {
  it("enforce → green", () => expect(modeTone("enforce")).toBe("green"));
  it("shadow → yellow", () => expect(modeTone("shadow")).toBe("yellow"));
  it("off → muted", () => expect(modeTone("off")).toBe("muted"));
  it("unknown → muted", () => expect(modeTone("disabled")).toBe("muted"));
});

describe("GOVERNANCE_FLAG_LABELS", () => {
  it("covers all 7 modes", () => {
    expect(Object.keys(GOVERNANCE_FLAG_LABELS).length).toBe(7);
  });
  it("includes beliefsShadow and stallJanitor", () => {
    expect("beliefsShadow" in GOVERNANCE_FLAG_LABELS).toBe(true);
    expect("stallJanitor" in GOVERNANCE_FLAG_LABELS).toBe(true);
  });
});
