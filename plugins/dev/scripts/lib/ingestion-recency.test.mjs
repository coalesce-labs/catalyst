// Tests for ingestion-recency.mjs (CTL-1122). Run: bun test plugins/dev/scripts/lib/ingestion-recency.test.mjs

import { describe, test, expect } from "bun:test";
import { recencyAgeMs, classifyRecency, evaluateSource } from "./ingestion-recency.mjs";

const NOW = 1_750_000_000_000; // fixed epoch ms

describe("recencyAgeMs", () => {
  test("epoch-ms timestamp → age", () => {
    expect(recencyAgeMs(NOW - 5000, NOW)).toBe(5000);
  });
  test("ISO-string timestamp → age", () => {
    const iso = new Date(NOW - 60_000).toISOString();
    expect(recencyAgeMs(iso, NOW)).toBe(60_000);
  });
  test("null / undefined / unparseable → null (never seen)", () => {
    expect(recencyAgeMs(null, NOW)).toBeNull();
    expect(recencyAgeMs(undefined, NOW)).toBeNull();
    expect(recencyAgeMs("not-a-date", NOW)).toBeNull();
  });
  test("future timestamp (clock skew) clamps to 0, never negative", () => {
    expect(recencyAgeMs(NOW + 10_000, NOW)).toBe(0);
  });
});

describe("classifyRecency", () => {
  const TH = { degradedAfterMs: 3 * 60_000, downAfterMs: 10 * 60_000 };
  test("fresh → up", () => expect(classifyRecency(30_000, TH)).toBe("up"));
  test("at degraded boundary → degraded", () => expect(classifyRecency(3 * 60_000, TH)).toBe("degraded"));
  test("between → degraded", () => expect(classifyRecency(5 * 60_000, TH)).toBe("degraded"));
  test("at down boundary → down", () => expect(classifyRecency(10 * 60_000, TH)).toBe("down"));
  test("well past → down", () => expect(classifyRecency(60 * 60_000, TH)).toBe("down"));
  test("null age → unknown (FAIL-OPEN: never alarm on no evidence)", () => {
    expect(classifyRecency(null, TH)).toBe("unknown");
  });
  test("misconfigured thresholds → unknown (never silently alarm)", () => {
    expect(classifyRecency(99_999_999, { degradedAfterMs: 0, downAfterMs: 0 })).toBe("unknown");
  });
});

describe("evaluateSource", () => {
  const TH = { degradedAfterMs: 3 * 60_000, downAfterMs: 10 * 60_000 };
  test("seen recently → up", () => {
    expect(evaluateSource({ lastSeenTs: NOW - 1000, nowMs: NOW, ...TH })).toEqual({ ageMs: 1000, severity: "up" });
  });
  test("seen but stale → down (evidence of staleness)", () => {
    const r = evaluateSource({ lastSeenTs: NOW - 20 * 60_000, nowMs: NOW, ...TH });
    expect(r.severity).toBe("down");
    expect(r.ageMs).toBe(20 * 60_000);
  });
  test("NEVER seen → unknown, not down (the fail-open crux)", () => {
    expect(evaluateSource({ lastSeenTs: null, nowMs: NOW, ...TH })).toEqual({ ageMs: null, severity: "unknown" });
  });
});
