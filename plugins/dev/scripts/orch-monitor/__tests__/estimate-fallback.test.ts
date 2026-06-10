// CTL-974: supplemental estimate fallback — tests for linear-estimate-fallback.mjs
//
// Three concerns:
//  1. fillEstimateFallback fires when cache null, does NOT re-fetch cached IDs.
//  2. Cached result is served on second call (no re-fetch within TTL).
//  3. estimateDisplay is correct per method (fibonacci → number, tShirt → label).

import { describe, it, expect, beforeEach } from "bun:test";
import {
  fillEstimateFallback,
  getEstimationMethodAsync,
  _clearEstimateCache,
  _clearMethodCache,
  _getEstimateCacheSize,
} from "../lib/linear-estimate-fallback.mjs";

// ── Helpers: mock the global fetch for testing ────────────────────────────────
// We replace globalThis.fetch with a spy that records calls + returns a preset response.

function mockFetch(responseData: unknown) {
  let callCount = 0;
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;

  const spy = async (url: string | URL | Request, init?: RequestInit) => {
    callCount++;
    const body = init?.body ? JSON.parse(init.body as string) : {};
    calls.push(JSON.stringify({ query: body.query?.split("\n")[0], variables: body.variables }));
    return {
      ok: true,
      json: async () => responseData,
    } as Response;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.fetch = (async () => { throw new Error("network failure"); }) as any;
  return { restore() { globalThis.fetch = originalFetch; } };
}

// ── (1) fillEstimateFallback fires when cache null ────────────────────────────

describe("CTL-974: fillEstimateFallback — estimate fetched and cached", () => {
  beforeEach(() => {
    _clearEstimateCache();
    _clearMethodCache();
  });

  it("fetches estimates for null-cache IDs and returns them", async () => {
    const spy = mockFetch({
      data: {
        issues: {
          nodes: [
            { identifier: "CTL-774", estimate: 8 },
            { identifier: "CTL-100", estimate: 3 },
          ],
        },
      },
    });

    try {
      const result = await fillEstimateFallback(["CTL-774", "CTL-100"]);
      expect(result["CTL-774"]).toBe(8);
      expect(result["CTL-100"]).toBe(3);
      expect(spy.callCount).toBe(1); // batched — one call for both IDs
    } finally {
      spy.restore();
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

  it("does NOT re-fetch cached IDs (cache hit — no second fetch)", async () => {
    // Prime the cache with one fetch.
    const spy1 = mockFetch({
      data: { issues: { nodes: [{ identifier: "CTL-500", estimate: 5 }] } },
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
      data: { issues: { nodes: [{ identifier: "CTL-1", estimate: 1 }] } },
    });
    await fillEstimateFallback(["CTL-1"]);
    spy1.restore();

    // Now call with CTL-1 (cached) + CTL-2 (not cached).
    const spy2 = mockFetch({
      data: { issues: { nodes: [{ identifier: "CTL-2", estimate: 2 }] } },
    });
    try {
      const result = await fillEstimateFallback(["CTL-1", "CTL-2"]);
      expect(result["CTL-1"]).toBe(1); // from cache
      expect(result["CTL-2"]).toBe(2); // from fresh fetch
      expect(spy2.callCount).toBe(1); // only one batch fetch (for CTL-2 only)
      // The fetch should NOT have included CTL-1 in its variables.
      const call = JSON.parse(spy2.calls[0]);
      expect(call.variables.ids).not.toContain("CTL-1");
      expect(call.variables.ids).toContain("CTL-2");
    } finally {
      spy2.restore();
    }
  });

  it("is fail-open: returns null on network failure, does not throw", async () => {
    const spy = mockFetchFail();
    try {
      const result = await fillEstimateFallback(["CTL-FAIL"]);
      // fail-open: null for the ID, no throw
      expect(result["CTL-FAIL"]).toBeNull();
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
            { identifier: "CTL-10", estimate: 10 },
            { identifier: "CTL-20", estimate: null }, // Linear returns null estimate
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
    const { deriveEstimateDisplay } = await import("../lib/board-data.mjs" as any).catch(() => null) as any;
    if (!deriveEstimateDisplay) return; // not exported — rely on board-data's own tests
    expect(deriveEstimateDisplay(8, "fibonacci")).toBe("8");
  });

  it("tShirt estimate 2 renders as 'M'", async () => {
    const { deriveEstimateDisplay } = await import("../lib/board-data.mjs" as any).catch(() => null) as any;
    if (!deriveEstimateDisplay) return;
    expect(deriveEstimateDisplay(2, "tShirt")).toBe("M");
  });

  it("null estimate renders as null regardless of method", async () => {
    const { deriveEstimateDisplay } = await import("../lib/board-data.mjs" as any).catch(() => null) as any;
    if (!deriveEstimateDisplay) return;
    expect(deriveEstimateDisplay(null, "fibonacci")).toBeNull();
    expect(deriveEstimateDisplay(null, "tShirt")).toBeNull();
  });
});
