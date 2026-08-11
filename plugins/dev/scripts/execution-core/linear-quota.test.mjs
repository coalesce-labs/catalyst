import { describe, expect, test } from "bun:test";
import { evaluateLinearQuota, parseLinearQuotaHeaders } from "./linear-quota.mjs";

const nowMs = Date.parse("2026-08-11T00:00:00Z");
const raw = { "X-RateLimit-Requests-Limit": "5000", "x-ratelimit-requests-remaining": "4200", "x-ratelimit-requests-reset": "1786407000" };

describe("parseLinearQuotaHeaders", () => {
  test("normalizes case-insensitive object headers", () => expect(parseLinearQuotaHeaders(raw, { host: "a", nowMs })).toEqual({ requests: { limit: 5000, used: 800, remaining: 4200, resetAt: "2026-08-11T00:10:00.000Z" }, host: "a", sampledAt: "2026-08-11T00:00:00.000Z" }));
  test("accepts Headers and preserves zero", () => expect(parseLinearQuotaHeaders(new Headers({ "x-ratelimit-requests-limit": "5000", "x-ratelimit-requests-remaining": "0" }), { nowMs })?.requests.remaining).toBe(0));
  test("rejects missing headers", () => expect(parseLinearQuotaHeaders({}, { nowMs })).toBeNull());
  test("keeps an invalid reset as null", () => expect(parseLinearQuotaHeaders({ ...raw, "x-ratelimit-requests-reset": "no" }, { nowMs })?.requests.resetAt).toBeNull());
});

describe("evaluateLinearQuota", () => {
  const snap = parseLinearQuotaHeaders(raw, { nowMs });
  test("classifies ok, low, exhausted, and unknown", () => {
    expect(evaluateLinearQuota(snap, { nowMs, remainingPct: 10 }).state).toBe("ok");
    expect(evaluateLinearQuota(snap, { nowMs, remainingPct: 90 }).state).toBe("low");
    expect(evaluateLinearQuota(parseLinearQuotaHeaders({ ...raw, "x-ratelimit-requests-remaining": "0" }, { nowMs }), { nowMs }).state).toBe("exhausted");
    expect(evaluateLinearQuota(null, { nowMs }).state).toBe("unknown");
  });
  test("honors zero floor, rejects stale, and treats future samples as fresh", () => {
    expect(evaluateLinearQuota(snap, { nowMs, remainingPct: 0 }).state).toBe("ok");
    expect(evaluateLinearQuota(snap, { nowMs: nowMs + 1_000, stalenessMs: 1 }).state).toBe("unknown");
    expect(evaluateLinearQuota(snap, { nowMs: nowMs - 1_000 }).state).toBe("ok");
  });
});
