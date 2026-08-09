import { describe, expect, test } from "bun:test";
import {
  GITHUB_QUOTA_DEFAULTS,
  evaluateQuotaHeadroom,
  parseRateLimitBody,
} from "./github-quota.mjs";

const NOW = Date.parse("2026-08-08T12:00:00.000Z");
const body = JSON.stringify({ resources: {
  core: { limit: 5000, used: 125, remaining: 4875, reset: 1786194000 },
  graphql: { limit: 5000, used: 25, remaining: 4975, reset: 1786194060 },
  search: { limit: 30, used: 2, remaining: 28, reset: 1786194120 },
} });

describe("parseRateLimitBody", () => {
  test("normalizes core, graphql, and search quota resources", () => {
    expect(parseRateLimitBody(body, { host: "mini-1", nowMs: NOW })).toEqual({
      core: { limit: 5000, used: 125, remaining: 4875, resetAt: "2026-08-08T13:00:00.000Z" },
      graphql: { limit: 5000, used: 25, remaining: 4975, resetAt: "2026-08-08T13:01:00.000Z" },
      search: { limit: 30, used: 2, remaining: 28, resetAt: "2026-08-08T13:02:00.000Z" },
      host: "mini-1",
      sampledAt: "2026-08-08T12:00:00.000Z",
    });
  });

  test("returns null for missing core or invalid input", () => {
    expect(parseRateLimitBody('{"resources":{}}', { host: "h", nowMs: NOW })).toBeNull();
    expect(parseRateLimitBody('{"resources":{"core":{"limit":null,"used":0,"remaining":null,"reset":null}}}', { host: "h", nowMs: NOW })).toBeNull();
    for (const value of ["not json", "", null]) {
      expect(parseRateLimitBody(value, { host: "h", nowMs: NOW })).toBeNull();
    }
  });

  test("keeps a resource with an invalid reset but sets resetAt null", () => {
    const input = JSON.stringify({ resources: { core: { limit: 10, used: 1, remaining: 9, reset: "later" } } });
    expect(parseRateLimitBody(input, { host: "h", nowMs: NOW })?.core).toEqual({
      limit: 10, used: 1, remaining: 9, resetAt: null,
    });
  });
});

describe("evaluateQuotaHeadroom", () => {
  const snapshot = (remaining, limit = 5000, sampledAt = new Date(NOW).toISOString()) => ({
    core: { remaining, limit, used: limit - remaining, resetAt: "2026-08-08T13:00:00.000Z" },
    sampledAt,
  });

  test("null, invalid limit, and stale samples are unknown", () => {
    expect(evaluateQuotaHeadroom(null, {}, NOW)).toMatchObject({ state: "unknown" });
    expect(evaluateQuotaHeadroom(snapshot(0, 0), {}, NOW)).toMatchObject({ state: "unknown" });
    expect(evaluateQuotaHeadroom(snapshot(0, 5000, new Date(NOW - 900_001).toISOString()), { stalenessMs: 900_000 }, NOW))
      .toMatchObject({ state: "unknown", stale: true, ageMs: 900_001 });
  });

  test("pins the default ten-percent boundary", () => {
    const expected = [[5000, "ok"], [501, "ok"], [500, "low"], [499, "low"], [1, "low"], [0, "exhausted"]];
    for (const [remaining, state] of expected) {
      expect(evaluateQuotaHeadroom(snapshot(remaining), {}, NOW)).toMatchObject({ state, remaining, limit: 5000 });
    }
  });

  test("returns the display fields and respects an explicit percentage floor", () => {
    expect(evaluateQuotaHeadroom(snapshot(1000), { coreRemainingPct: 25 }, NOW)).toEqual({
      state: "low", remaining: 1000, limit: 5000, remainingPct: 20,
      resetAt: "2026-08-08T13:00:00.000Z", ageMs: 0, stale: false,
    });
  });

  test("exports finite positive defaults", () => {
    expect(GITHUB_QUOTA_DEFAULTS.coreRemainingPct).toBeGreaterThan(0);
    expect(GITHUB_QUOTA_DEFAULTS.stalenessMs).toBeGreaterThan(0);
  });

  // Codex P2 (CAT-40): an explicit 0 floor means "only total exhaustion blocks
  // dispatch". `Number(x) || default` swallowed it and applied the 10% default,
  // so 1-10% remaining tripped Gate 3 against the operator's configuration.
  test("an explicit zero percentage floor is honoured, not replaced by the default", () => {
    expect(evaluateQuotaHeadroom(snapshot(1), { coreRemainingPct: 0 }, NOW)).toMatchObject({ state: "ok" });
    expect(evaluateQuotaHeadroom(snapshot(500), { coreRemainingPct: 0 }, NOW)).toMatchObject({ state: "ok" });
    // Total exhaustion still trips — the zero floor narrows the band, it does not disable the check.
    expect(evaluateQuotaHeadroom(snapshot(0), { coreRemainingPct: 0 }, NOW)).toMatchObject({ state: "exhausted" });
  });

  test("an explicit zero staleness threshold marks any aged sample stale", () => {
    expect(evaluateQuotaHeadroom(snapshot(5000, 5000, new Date(NOW - 1).toISOString()), { stalenessMs: 0 }, NOW))
      .toMatchObject({ state: "unknown", stale: true });
  });

  test("unusable threshold values fall back to the defaults instead of NaN-comparing", () => {
    for (const bad of [null, undefined, "", "  ", "abc", {}, NaN, -5]) {
      expect(evaluateQuotaHeadroom(snapshot(5000), { coreRemainingPct: bad }, NOW)).toMatchObject({ state: "ok" });
      expect(evaluateQuotaHeadroom(snapshot(1), { coreRemainingPct: bad }, NOW)).toMatchObject({ state: "low" });
    }
  });
});
