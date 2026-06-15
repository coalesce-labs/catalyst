// cli/beliefs-shadow-status.test.mjs — CTL-935 Phase 6: flag-live verification.
// Run: cd plugins/dev/scripts/execution-core && bun test cli/beliefs-shadow-status.test.mjs

import { describe, test, expect } from "bun:test";
import { computeShadowStatus, STALE_THRESHOLD_MS, CONTIGUITY_GAP_THRESHOLD_MS } from "./beliefs-shadow-status.mjs";

const NOW = 1_000_000_000; // fixed reference epoch for all tests

// ─── INACTIVE ────────────────────────────────────────────────────────────────

describe("INACTIVE — flag off", () => {
  test("beliefsShadow=false, source=config → INACTIVE", () => {
    const result = computeShadowStatus({
      flagActive: false,
      flagSource: "config",
      latestTickMs: NOW - 10_000,
      tickCount: 5,
      tickGapMs: 60_000,
      nowMs: NOW,
    });
    expect(result.status).toBe("INACTIVE");
    expect(result.sourceWarning).toBe(false);
  });

  test("beliefsShadow=false, source=default → INACTIVE, no sourceWarning", () => {
    const result = computeShadowStatus({
      flagActive: false,
      flagSource: "default",
      latestTickMs: null,
      tickCount: 0,
      tickGapMs: null,
      nowMs: NOW,
    });
    expect(result.status).toBe("INACTIVE");
    expect(result.sourceWarning).toBe(false);
  });
});

// ─── ACTIVE ───────────────────────────────────────────────────────────────────

describe("ACTIVE — flag on, fresh ticks, no gap", () => {
  test("beliefsShadow=true, source=config → ACTIVE, sourceWarning=false", () => {
    const result = computeShadowStatus({
      flagActive: true,
      flagSource: "config",
      latestTickMs: NOW - 10_000,
      tickCount: 100,
      tickGapMs: 60_000,
      nowMs: NOW,
    });
    expect(result.status).toBe("ACTIVE");
    expect(result.source).toBe("config");
    expect(result.sourceWarning).toBe(false);
  });

  test("env-override source → ACTIVE with sourceWarning=true", () => {
    const result = computeShadowStatus({
      flagActive: true,
      flagSource: "env-override",
      latestTickMs: NOW - 10_000,
      tickCount: 50,
      tickGapMs: 60_000,
      nowMs: NOW,
    });
    expect(result.status).toBe("ACTIVE");
    expect(result.sourceWarning).toBe(true);
    expect(result.source).toBe("env-override");
  });

  test("contiguity OK when tickGapMs is null (single tick)", () => {
    const result = computeShadowStatus({
      flagActive: true,
      flagSource: "config",
      latestTickMs: NOW - 10_000,
      tickCount: 1,
      tickGapMs: null,
      nowMs: NOW,
    });
    expect(result.status).toBe("ACTIVE");
    expect(result.contiguityViolation).toBe(false);
  });

  test("contiguity OK when tickGapMs < threshold", () => {
    const result = computeShadowStatus({
      flagActive: true,
      flagSource: "config",
      latestTickMs: NOW - 10_000,
      tickCount: 10,
      tickGapMs: CONTIGUITY_GAP_THRESHOLD_MS - 1,
      nowMs: NOW,
    });
    expect(result.status).toBe("ACTIVE");
    expect(result.contiguityViolation).toBe(false);
  });
});

// ─── NO-DATA ─────────────────────────────────────────────────────────────────

describe("NO-DATA — flag on but no ticks (the empty-log failure mode)", () => {
  test("beliefsShadow=true, tickCount=0 → NO-DATA (flag set but daemon not ticking)", () => {
    const result = computeShadowStatus({
      flagActive: true,
      flagSource: "config",
      latestTickMs: null,
      tickCount: 0,
      tickGapMs: null,
      nowMs: NOW,
    });
    expect(result.status).toBe("NO-DATA");
  });

  test("NO-DATA is NOT a pass: passed=false", () => {
    const result = computeShadowStatus({
      flagActive: true,
      flagSource: "config",
      latestTickMs: null,
      tickCount: 0,
      tickGapMs: null,
      nowMs: NOW,
    });
    expect(result.passed).toBe(false);
  });
});

// ─── COLLECTION-STALE ────────────────────────────────────────────────────────

describe("COLLECTION-STALE — flag on, ticks exist, but newest tick too old", () => {
  test("newest tick older than STALE_THRESHOLD_MS → COLLECTION-STALE even when flag=true", () => {
    const result = computeShadowStatus({
      flagActive: true,
      flagSource: "config",
      latestTickMs: NOW - STALE_THRESHOLD_MS - 1,
      tickCount: 5,
      tickGapMs: 60_000,
      nowMs: NOW,
    });
    expect(result.status).toBe("COLLECTION-STALE");
    expect(result.passed).toBe(false);
  });

  test("newest tick exactly at threshold boundary is NOT stale", () => {
    const result = computeShadowStatus({
      flagActive: true,
      flagSource: "config",
      latestTickMs: NOW - STALE_THRESHOLD_MS,
      tickCount: 5,
      tickGapMs: 60_000,
      nowMs: NOW,
    });
    // At exactly the boundary it's still fresh (strictly-greater-than).
    expect(result.status).toBe("ACTIVE");
  });
});

// ─── CONTIGUITY-VIOLATION ────────────────────────────────────────────────────

describe("CONTIGUITY-VIOLATION — gap in tick stream", () => {
  test("tickGapMs >= threshold → contiguityViolation=true, status reflects it", () => {
    const result = computeShadowStatus({
      flagActive: true,
      flagSource: "config",
      latestTickMs: NOW - 10_000,
      tickCount: 100,
      tickGapMs: CONTIGUITY_GAP_THRESHOLD_MS,
      nowMs: NOW,
    });
    expect(result.contiguityViolation).toBe(true);
    expect(result.status).toBe("CONTIGUITY-VIOLATION");
  });

  test("CONTIGUITY-VIOLATION is NOT a pass", () => {
    const result = computeShadowStatus({
      flagActive: true,
      flagSource: "config",
      latestTickMs: NOW - 10_000,
      tickCount: 100,
      tickGapMs: CONTIGUITY_GAP_THRESHOLD_MS + 1,
      nowMs: NOW,
    });
    expect(result.passed).toBe(false);
  });
});

// ─── passed flag ─────────────────────────────────────────────────────────────

describe("passed flag summary", () => {
  test("ACTIVE without violations → passed=true", () => {
    const result = computeShadowStatus({
      flagActive: true,
      flagSource: "config",
      latestTickMs: NOW - 10_000,
      tickCount: 100,
      tickGapMs: 60_000,
      nowMs: NOW,
    });
    expect(result.passed).toBe(true);
  });

  test("ACTIVE with sourceWarning → passed=true (warning, not failure)", () => {
    const result = computeShadowStatus({
      flagActive: true,
      flagSource: "env-override",
      latestTickMs: NOW - 10_000,
      tickCount: 50,
      tickGapMs: 60_000,
      nowMs: NOW,
    });
    expect(result.passed).toBe(true);
    expect(result.sourceWarning).toBe(true);
  });

  test("INACTIVE → passed=false", () => {
    const result = computeShadowStatus({
      flagActive: false,
      flagSource: "default",
      latestTickMs: null,
      tickCount: 0,
      tickGapMs: null,
      nowMs: NOW,
    });
    expect(result.passed).toBe(false);
  });
});

// ─── threshold exports ────────────────────────────────────────────────────────

describe("exported threshold constants", () => {
  test("STALE_THRESHOLD_MS is >= 90_000 (plan: >90s)", () => {
    expect(STALE_THRESHOLD_MS).toBeGreaterThanOrEqual(90_000);
  });

  test("CONTIGUITY_GAP_THRESHOLD_MS is positive", () => {
    expect(CONTIGUITY_GAP_THRESHOLD_MS).toBeGreaterThan(0);
  });
});
