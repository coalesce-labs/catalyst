// governance-model.test.ts — CTL-1100 Phase 6 + CTL-1104 Phase 2

import { describe, it, expect } from "bun:test";
import {
  isGovernanceSnapshot,
  flagTone,
  modeTone,
  GOVERNANCE_FLAG_LABELS,
  isClusterGovernanceSignal,
  decodeClusterGovernanceFrame,
  governanceAgeLabel,
  isGovernanceStale,
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

// ── CTL-1104 Phase 2: cluster-governance wire model ────────────────────────

const VALID_SIGNAL = {
  singleHost: true,
  generatedAt: "2026-06-13T12:00:00.000Z",
  nodes: [
    {
      host: "mac-mini",
      governance: { beliefsShadow: true, stallJanitor: { mode: "enforce" } },
      reportedAt: "2026-06-13T11:59:55.000Z",
      ageMs: 5_000,
      status: "live" as const,
    },
  ],
};

describe("isClusterGovernanceSignal", () => {
  it("accepts a minimal empty-nodes signal", () => {
    expect(isClusterGovernanceSignal({ singleHost: true, generatedAt: "", nodes: [] })).toBe(true);
  });
  it("accepts a fully-populated signal", () => {
    expect(isClusterGovernanceSignal(VALID_SIGNAL)).toBe(true);
  });
  it("rejects null", () => expect(isClusterGovernanceSignal(null)).toBe(false));
  it("rejects missing nodes", () => expect(isClusterGovernanceSignal({ singleHost: true, generatedAt: "" })).toBe(false));
  it("rejects non-array nodes", () => expect(isClusterGovernanceSignal({ singleHost: true, generatedAt: "", nodes: "oops" })).toBe(false));
  it("rejects a node missing host", () => {
    expect(isClusterGovernanceSignal({ singleHost: true, generatedAt: "", nodes: [{ governance: null, status: "offline" }] })).toBe(false);
  });
});

describe("decodeClusterGovernanceFrame", () => {
  it("parses valid JSON into the signal", () => {
    const frame = JSON.stringify(VALID_SIGNAL);
    const result = decodeClusterGovernanceFrame(frame);
    expect(result).not.toBeNull();
    expect(result?.nodes[0].host).toBe("mac-mini");
  });
  it("returns null on garbage input", () => {
    expect(decodeClusterGovernanceFrame("{bad json")).toBeNull();
    expect(decodeClusterGovernanceFrame("null")).toBeNull();
    expect(decodeClusterGovernanceFrame("{}")).toBeNull();
  });
});

describe("governanceAgeLabel", () => {
  it("< 1000ms → 'just now'", () => expect(governanceAgeLabel(500)).toBe("just now"));
  it("0ms → 'just now'", () => expect(governanceAgeLabel(0)).toBe("just now"));
  it("5s → '5s ago'", () => expect(governanceAgeLabel(5_000)).toBe("5s ago"));
  it("90s → '1m ago'", () => expect(governanceAgeLabel(90_000)).toBe("1m ago"));
  it("3600s → '1h ago'", () => expect(governanceAgeLabel(3_600_000)).toBe("1h ago"));
  it("null → '—'", () => expect(governanceAgeLabel(null)).toBe("—"));
});

describe("isGovernanceStale", () => {
  it("live → false", () => expect(isGovernanceStale("live")).toBe(false));
  it("degraded → true", () => expect(isGovernanceStale("degraded")).toBe(true));
  it("offline → true", () => expect(isGovernanceStale("offline")).toBe(true));
});
