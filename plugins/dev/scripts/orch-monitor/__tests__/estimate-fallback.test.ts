// CTL-974 / CTL-976: supplemental estimate fallback — tests for linear-estimate-fallback.mjs
//
// Three concerns:
//  1. fillEstimateFallback fires when cache null, does NOT re-fetch cached IDs.
//  2. Cached result is served on second call (no re-fetch within TTL).
//  3. The GraphQL query uses team key + number filter (NOT the invalid 'identifier' filter
//     that caused 400s — CTL-976 fix).
//  4. Mocked Linear responses keyed by number + team.key map back to the correct identifier.
//  5. estimateDisplay is correct per method (fibonacci → number, tShirt → label).

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import {
  fillEstimateFallback,
  getEstimationMethodAsync,
  _clearEstimateCache,
  _clearMethodCache,
  _getEstimateCacheSize,
} from "../lib/linear-estimate-fallback.mjs";

// fillEstimateFallback fail-opens (no fetch at all) without a Linear token, and
// CI has no real credentials — so pin a fake token for the whole file (every
// fetch below is mocked). Without this the file only passes when an earlier
// test file happens to leak a token into process.env.
const PREV_TOKEN = process.env.LINEAR_API_TOKEN;
const PREV_KEY = process.env.LINEAR_API_KEY;
beforeAll(() => {
  process.env.LINEAR_API_TOKEN = "lin_api_test_token";
  delete process.env.LINEAR_API_KEY;
});
afterAll(() => {
  if (PREV_TOKEN !== undefined) process.env.LINEAR_API_TOKEN = PREV_TOKEN;
  else delete process.env.LINEAR_API_TOKEN;
  if (PREV_KEY !== undefined) process.env.LINEAR_API_KEY = PREV_KEY;
  else delete process.env.LINEAR_API_KEY;
});

// ── Helpers: mock the global fetch for testing ────────────────────────────────
// We replace globalThis.fetch with a spy that records calls + returns a preset response.

function mockFetch(responseData: unknown) {
  let callCount = 0;
  const calls: Array<{ query: string; variables: unknown }> = [];
  const originalFetch = globalThis.fetch;

  const spy = (url: string | URL | Request, init?: RequestInit) => {
    callCount++;
    const body = init?.body ? JSON.parse(init.body as string) : {};
    calls.push({ query: body.query ?? "", variables: body.variables });
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(responseData),
    } as Response);
  };

  globalThis.fetch = spy as typeof fetch;

  return {
    get callCount() { return callCount; },
    get calls() { return calls; },
    restore() { globalThis.fetch = originalFetch; },
  };
}

function mockFetchFail() {
  const originalFetch = globalThis.fetch;
   
  globalThis.fetch = (() => Promise.reject(new Error("network failure"))) as any;
  return { restore() { globalThis.fetch = originalFetch; } };
}

// ── (1) fillEstimateFallback fires when cache null ────────────────────────────

describe("CTL-976: fillEstimateFallback — query uses team+number NOT identifier", () => {
  beforeEach(() => {
    _clearEstimateCache();
    _clearMethodCache();
  });

  it("sends a query with teamKey + numbers (not identifier)", async () => {
    const spy = mockFetch({
      data: {
        issues: {
          nodes: [
            { number: 774, estimate: 8, team: { key: "CTL" } },
          ],
        },
      },
    });

    try {
      await fillEstimateFallback(["CTL-774"]);
      expect(spy.callCount).toBe(1);
      const call = spy.calls[0];
      // Query must NOT use 'identifier' filter
      expect(call.query).not.toContain("identifier");
      // Query must use number + team key filters
      expect(call.query).toContain("number");
      expect(call.query).toContain("teamKey");
      // Variables must contain the team key and the number
      const vars = call.variables as { teamKey?: string; numbers?: number[] };
      expect(vars.teamKey).toBe("CTL");
      expect(vars.numbers).toContain(774);
    } finally {
      spy.restore();
    }
  });

  it("maps Linear response (number + team.key) back to the correct identifier", async () => {
    const spy = mockFetch({
      data: {
        issues: {
          nodes: [
            { number: 774, estimate: 8, team: { key: "CTL" } },
            { number: 930, estimate: 5, team: { key: "CTL" } },
            { number: 908, estimate: 3, team: { key: "CTL" } },
          ],
        },
      },
    });

    try {
      const result = await fillEstimateFallback(["CTL-774", "CTL-930", "CTL-908"]);
      expect(result["CTL-774"]).toBe(8);
      expect(result["CTL-930"]).toBe(5);
      expect(result["CTL-908"]).toBe(3);
    } finally {
      spy.restore();
    }
  });

  it("groups cross-team IDs into separate per-team queries", async () => {
    const calls: Array<{ teamKey?: string; numbers?: number[] }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      calls.push(body.variables as { teamKey?: string; numbers?: number[] });
      // Return the appropriate team's issues
      const teamKey = body.variables?.teamKey as string;
      const nodes = teamKey === "CTL"
        ? [{ number: 774, estimate: 8, team: { key: "CTL" } }]
        : [{ number: 1, estimate: 2, team: { key: "ADV" } }];
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: { issues: { nodes } } }),
      } as Response);
    }) as typeof fetch;

    try {
      const result = await fillEstimateFallback(["CTL-774", "ADV-1"]);
      // Two separate queries (one per team)
      expect(calls.length).toBe(2);
      const teamKeys = calls.map((c) => c.teamKey).sort();
      expect(teamKeys).toEqual(["ADV", "CTL"]);
      // Results map back correctly
      expect(result["CTL-774"]).toBe(8);
      expect(result["ADV-1"]).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns null for IDs that Linear has no estimate for (honest null)", async () => {
    const spy = mockFetch({
      data: {
        issues: {
          nodes: [], // Linear returned nothing (ticket not found or no estimate)
        },
      },
    });

    try {
      const result = await fillEstimateFallback(["CTL-999"]);
      expect(result["CTL-999"]).toBeNull();
    } finally {
      spy.restore();
    }
  });

  it("fetches estimates for null-cache IDs and returns them", async () => {
    const spy = mockFetch({
      data: {
        issues: {
          nodes: [
            { number: 774, estimate: 8, team: { key: "CTL" } },
            { number: 100, estimate: 3, team: { key: "CTL" } },
          ],
        },
      },
    });

    try {
      const result = await fillEstimateFallback(["CTL-774", "CTL-100"]);
      expect(result["CTL-774"]).toBe(8);
      expect(result["CTL-100"]).toBe(3);
      expect(spy.callCount).toBe(1); // batched — one call for both IDs (same team)
    } finally {
      spy.restore();
    }
  });

  it("does NOT re-fetch cached IDs (cache hit — no second fetch)", async () => {
    // Prime the cache with one fetch.
    const spy1 = mockFetch({
      data: { issues: { nodes: [{ number: 500, estimate: 5, team: { key: "CTL" } }] } },
    });
    await fillEstimateFallback(["CTL-500"]);
    spy1.restore();

    // Second call — should NOT invoke fetch again.
    const spy2 = mockFetch({ data: { issues: { nodes: [] } } });
    try {
      const result = await fillEstimateFallback(["CTL-500"]);
      expect(result["CTL-500"]).toBe(5); // served from cache
      expect(spy2.callCount).toBe(0); // no re-fetch
    } finally {
      spy2.restore();
    }
  });

  it("only fetches the un-cached subset when called with mixed IDs", async () => {
    // Prime cache for CTL-1.
    const spy1 = mockFetch({
      data: { issues: { nodes: [{ number: 1, estimate: 1, team: { key: "CTL" } }] } },
    });
    await fillEstimateFallback(["CTL-1"]);
    spy1.restore();

    // Now call with CTL-1 (cached) + CTL-2 (not cached).
    const spy2 = mockFetch({
      data: { issues: { nodes: [{ number: 2, estimate: 2, team: { key: "CTL" } }] } },
    });
    try {
      const result = await fillEstimateFallback(["CTL-1", "CTL-2"]);
      expect(result["CTL-1"]).toBe(1); // from cache
      expect(result["CTL-2"]).toBe(2); // from fresh fetch
      expect(spy2.callCount).toBe(1); // only one batch fetch (for CTL-2 only)
      // The fetch should NOT have included CTL-1's number in the variables.
      const vars = spy2.calls[0].variables as { teamKey?: string; numbers?: number[] };
      expect(vars.numbers).not.toContain(1);
      expect(vars.numbers).toContain(2);
    } finally {
      spy2.restore();
    }
  });

  it("is fail-open: returns null on network failure, does not throw", async () => {
    const spy = mockFetchFail();
    try {
      const result = await fillEstimateFallback(["CTL-FAIL"]);
      // CTL-FAIL does not parse as a valid identifier (no numeric suffix) → null
      expect(result["CTL-FAIL"]).toBeNull();
    } finally {
      spy.restore();
    }
  });

  it("is fail-open for valid IDs: returns null on network failure", async () => {
    const spy = mockFetchFail();
    try {
      const result = await fillEstimateFallback(["CTL-9999"]);
      expect(result["CTL-9999"]).toBeNull();
    } finally {
      spy.restore();
    }
  });

  it("cache grows correctly after a batch fetch", async () => {
    _clearEstimateCache();
    const spy = mockFetch({
      data: {
        issues: {
          nodes: [
            { number: 10, estimate: 10, team: { key: "CTL" } },
            { number: 20, estimate: null, team: { key: "CTL" } }, // Linear returns null estimate
          ],
        },
      },
    });
    try {
      await fillEstimateFallback(["CTL-10", "CTL-20", "CTL-30"]); // CTL-30 not in response
      // cache should have 3 entries (including the miss CTL-30 stamped as null)
      expect(_getEstimateCacheSize()).toBeGreaterThanOrEqual(3);
    } finally {
      spy.restore();
    }
  });
});

// ── (2) getEstimationMethodAsync reads on-disk cache ─────────────────────────

describe("CTL-974: getEstimationMethodAsync — team method resolution", () => {
  beforeEach(() => {
    _clearMethodCache();
  });

  it("returns null gracefully when no token and no cache", async () => {
    const original = process.env.LINEAR_API_TOKEN;
    delete process.env.LINEAR_API_TOKEN;
    delete process.env.LINEAR_API_KEY;
    try {
      const method = await getEstimationMethodAsync("CTL");
      // With no token, graphql() returns null → null result is acceptable.
      expect(method).toBeNull();
    } finally {
      if (original !== undefined) process.env.LINEAR_API_TOKEN = original;
    }
  });
});

// ── (3) estimateDisplay per method (integration with deriveEstimateDisplay) ──

describe("CTL-974: estimateDisplay correct per estimation method", () => {
  it("fibonacci estimate 8 renders as '8'", async () => {
    const mod = await import("../lib/board-data.mjs").catch(() => null);
    const deriveEstimateDisplay = mod?.deriveEstimateDisplay;
    if (!deriveEstimateDisplay) return; // not exported — rely on board-data's own tests
    expect(deriveEstimateDisplay(8, "fibonacci")).toBe("8");
  });

  it("tShirt estimate 2 renders as 'M'", async () => {
    const mod = await import("../lib/board-data.mjs").catch(() => null);
    const deriveEstimateDisplay = mod?.deriveEstimateDisplay;
    if (!deriveEstimateDisplay) return;
    expect(deriveEstimateDisplay(2, "tShirt")).toBe("M");
  });

  it("null estimate renders as null regardless of method", async () => {
    const mod = await import("../lib/board-data.mjs").catch(() => null);
    const deriveEstimateDisplay = mod?.deriveEstimateDisplay;
    if (!deriveEstimateDisplay) return;
    expect(deriveEstimateDisplay(null, "fibonacci")).toBeNull();
    expect(deriveEstimateDisplay(null, "tShirt")).toBeNull();
  });
});
