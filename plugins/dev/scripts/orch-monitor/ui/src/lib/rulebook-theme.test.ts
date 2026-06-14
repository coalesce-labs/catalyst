// rulebook-theme.test.ts — CTL-1103 Phase 5: verifies the three visual channels
// (strata, severity, live indicator) are mutually distinct. Pure; no DOM.
// Run: cd ui && bun test src/lib/rulebook-theme.test.ts
import { describe, it, expect } from "bun:test";
import {
  strataTone,
  severityTone,
  liveIndicatorTone,
} from "./rulebook-theme";

describe("strataTone", () => {
  it("returns a non-empty string for each of the 6 strata", () => {
    for (const id of [1, 2, 3, 4, 5, 6]) {
      expect(typeof strataTone(id)).toBe("string");
      expect(strataTone(id).length).toBeGreaterThan(0);
    }
  });

  it("all 6 strata tones are pairwise distinct", () => {
    const tones = [1, 2, 3, 4, 5, 6].map(strataTone);
    expect(new Set(tones).size).toBe(6);
  });
});

describe("severityTone", () => {
  it("returns distinct tokens for info, warn, error", () => {
    expect(severityTone("info")).not.toBe(severityTone("warn"));
    expect(severityTone("warn")).not.toBe(severityTone("error"));
    expect(severityTone("info")).not.toBe(severityTone("error"));
  });
});

describe("liveIndicatorTone", () => {
  it("returns a non-empty string for both firing and not-firing", () => {
    expect(typeof liveIndicatorTone(true)).toBe("string");
    expect(typeof liveIndicatorTone(false)).toBe("string");
    expect(liveIndicatorTone(true).length).toBeGreaterThan(0);
  });
});

describe("three visual channels are mutually distinct", () => {
  it("strata, severity, and live indicator each produce a distinct token", () => {
    const strata = strataTone(1);
    const sev = severityTone("info");
    const live = liveIndicatorTone(true);
    expect(new Set([strata, sev, live]).size).toBe(3);
  });

  it("strata tone for every id differs from severity(info)", () => {
    const sevToken = severityTone("info");
    for (const id of [1, 2, 3, 4, 5, 6]) {
      expect(strataTone(id)).not.toBe(sevToken);
    }
  });

  it("strata tone for every id differs from liveIndicatorTone(true)", () => {
    const liveToken = liveIndicatorTone(true);
    for (const id of [1, 2, 3, 4, 5, 6]) {
      expect(strataTone(id)).not.toBe(liveToken);
    }
  });
});
