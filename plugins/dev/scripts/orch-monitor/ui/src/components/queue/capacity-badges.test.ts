// capacity-badges.test.ts — CTL-764 Phase 8: pure tests for buildCapacityBadges.
import { describe, it, expect } from "bun:test";
import { buildCapacityBadges } from "./capacity-badges";

describe("buildCapacityBadges (CTL-764 Phase 8)", () => {
  it("returns triage/queued/blocked/needs-input/needs-human in that fixed order", () => {
    const config = {
      maxParallel: 4,
      inFlight: 2,
      freeSlots: 2,
      active: 2,
      working: 2,
      stuck: 0,
      triage: 1,
      queued: 3,
      blocked: 2,
      needsInput: 1,
      needsHuman: 2,
    };
    const badges = buildCapacityBadges(config);
    const labels = badges.map((b) => b.label);
    expect(labels).toEqual(["triage", "queued", "blocked", "needs-input", "needs-human"]);
  });

  it("omits badges with zero count", () => {
    const config = {
      maxParallel: 4,
      inFlight: 2,
      freeSlots: 2,
      active: 2,
      working: 2,
      stuck: 0,
      triage: 0,
      queued: 1,
      blocked: 0,
      needsInput: 0,
      needsHuman: 0,
    };
    const badges = buildCapacityBadges(config);
    expect(badges).toHaveLength(1);
    expect(badges[0].label).toBe("queued");
    expect(badges[0].count).toBe(1);
  });

  it("triage badge carries the legend text", () => {
    const config = {
      maxParallel: 4,
      inFlight: 2,
      freeSlots: 2,
      active: 2,
      working: 2,
      stuck: 0,
      triage: 2,
      queued: 0,
      blocked: 0,
      needsInput: 0,
      needsHuman: 0,
    };
    const badges = buildCapacityBadges(config);
    const triage = badges.find((b) => b.label === "triage");
    expect(triage).toBeDefined();
    expect(triage!.legend).toBe("triage is intake — not counted against maxParallel");
  });

  it("missing optional fields default to 0 and are omitted (back-compat with older payloads)", () => {
    const config = { maxParallel: 4, inFlight: 2, freeSlots: 2, active: 2, working: 2, stuck: 0 };
    const badges = buildCapacityBadges(config);
    expect(badges).toHaveLength(0);
  });

  it("returns empty array when all counts are zero", () => {
    const config = {
      maxParallel: 4,
      inFlight: 2,
      freeSlots: 2,
      active: 2,
      working: 2,
      stuck: 0,
      triage: 0,
      queued: 0,
      blocked: 0,
      needsInput: 0,
      needsHuman: 0,
    };
    const badges = buildCapacityBadges(config);
    expect(badges).toHaveLength(0);
  });
});
