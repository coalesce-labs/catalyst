// CTL-974 pattern: supplemental {title, description} fallback —
// tests for linear-title-description-fallback.mjs
//
// Concerns:
//  1. fillTitleDescriptionFallback fires when uncached; uses team+number
//     filter (NOT the invalid 'identifier' filter — CTL-976), queries
//     title+description fields.
//  2. Mocked Linear responses keyed by number + team.key map back to the
//     correct identifier (real title + raw markdown description).
//  3. Cross-team IDs are grouped into separate per-team queries.
//  4. Cached result served on second call (no re-fetch within TTL); mixed
//     calls only fetch the un-cached subset.
//  5. Honest null for IDs Linear returned nothing for; empty-string
//     description normalizes to null.
//  6. Fail-open: network failure → { title:null, description:null }, no throw.
//  7. _clearTitleDescCache(id) evicts a single entry (webhook invalidation).

import { describe, it, expect, beforeEach } from "bun:test";
import {
  fillTitleDescriptionFallback,
  _clearTitleDescCache,
  _getTitleDescCacheSize,
} from "../lib/linear-title-description-fallback.mjs";

// ── Helpers: mock the global fetch for testing ────────────────────────────────

function mockFetch(responseData: unknown) {
  let callCount = 0;
  const calls: Array<{ query: string; variables: unknown }> = [];
  const originalFetch = globalThis.fetch;

  const spy = async (_url: string | URL | Request, init?: RequestInit) => {
    callCount++;
    const body = init?.body ? JSON.parse(init.body as string) : {};
    calls.push({ query: body.query ?? "", variables: body.variables });
    return {
      ok: true,
      json: async () => responseData,
    } as Response;
  };

  globalThis.fetch = spy as typeof fetch;

  return {
    get callCount() {
      return callCount;
    },
    get calls() {
      return calls;
    },
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

function mockFetchFail() {
  const originalFetch = globalThis.fetch;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.fetch = (async () => {
    throw new Error("network failure");
  }) as any;
  return {
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

// A token must be present for graphql() to attempt a fetch; the spy intercepts
// the actual call so no real network traffic happens.
function withToken<T>(fn: () => T): T {
  const prevToken = process.env.LINEAR_API_TOKEN;
  const prevKey = process.env.LINEAR_API_KEY;
  process.env.LINEAR_API_TOKEN = "lin_api_test_token";
  delete process.env.LINEAR_API_KEY;
  try {
    return fn();
  } finally {
    if (prevToken !== undefined) process.env.LINEAR_API_TOKEN = prevToken;
    else delete process.env.LINEAR_API_TOKEN;
    if (prevKey !== undefined) process.env.LINEAR_API_KEY = prevKey;
  }
}

describe("CTL-974: fillTitleDescriptionFallback — title+description resolver", () => {
  beforeEach(() => {
    _clearTitleDescCache();
  });

  it("sends a query with teamKey + numbers (not identifier) and asks for title+description", async () => {
    const spy = mockFetch({
      data: {
        issues: {
          nodes: [
            { number: 926, title: "Real title", description: "## Body", team: { key: "CTL" } },
          ],
        },
      },
    });
    try {
      await withToken(() => fillTitleDescriptionFallback(["CTL-926"]));
      expect(spy.callCount).toBe(1);
      const call = spy.calls[0];
      expect(call.query).not.toContain("identifier");
      expect(call.query).toContain("number");
      expect(call.query).toContain("teamKey");
      expect(call.query).toContain("title");
      expect(call.query).toContain("description");
      const vars = call.variables as { teamKey?: string; numbers?: number[] };
      expect(vars.teamKey).toBe("CTL");
      expect(vars.numbers).toContain(926);
    } finally {
      spy.restore();
    }
  });

  it("maps Linear response (number + team.key) back to the correct identifier with real title + markdown", async () => {
    const spy = mockFetch({
      data: {
        issues: {
          nodes: [
            { number: 865, title: "Cluster board view", description: "When running...", team: { key: "CTL" } },
            { number: 926, title: "Eligible projection bug", description: "## Summary\n\nThe projection...", team: { key: "CTL" } },
          ],
        },
      },
    });
    try {
      const result = await withToken(() =>
        fillTitleDescriptionFallback(["CTL-865", "CTL-926"]),
      );
      expect(result["CTL-865"].title).toBe("Cluster board view");
      expect(result["CTL-865"].description).toBe("When running...");
      expect(result["CTL-926"].title).toBe("Eligible projection bug");
      expect(result["CTL-926"].description).toContain("## Summary");
      expect(spy.callCount).toBe(1); // batched — one call (same team)
    } finally {
      spy.restore();
    }
  });

  it("groups cross-team IDs into separate per-team queries", async () => {
    const calls: Array<{ teamKey?: string; numbers?: number[] }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      calls.push(body.variables as { teamKey?: string; numbers?: number[] });
      const teamKey = body.variables?.teamKey as string;
      const nodes =
        teamKey === "CTL"
          ? [{ number: 926, title: "CTL title", description: "ctl body", team: { key: "CTL" } }]
          : [{ number: 1, title: "ADV title", description: "adv body", team: { key: "ADV" } }];
      return { ok: true, json: async () => ({ data: { issues: { nodes } } }) } as Response;
    }) as typeof fetch;
    try {
      const result = await withToken(() =>
        fillTitleDescriptionFallback(["CTL-926", "ADV-1"]),
      );
      expect(calls.length).toBe(2);
      const teamKeys = calls.map((c) => c.teamKey).sort();
      expect(teamKeys).toEqual(["ADV", "CTL"]);
      expect(result["CTL-926"].title).toBe("CTL title");
      expect(result["ADV-1"].title).toBe("ADV title");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns honest null for IDs Linear has no record of", async () => {
    const spy = mockFetch({ data: { issues: { nodes: [] } } });
    try {
      const result = await withToken(() =>
        fillTitleDescriptionFallback(["CTL-99999"]),
      );
      expect(result["CTL-99999"].title).toBeNull();
      expect(result["CTL-99999"].description).toBeNull();
    } finally {
      spy.restore();
    }
  });

  it("normalizes an empty-string description to null (honest empty)", async () => {
    const spy = mockFetch({
      data: {
        issues: {
          nodes: [{ number: 500, title: "Has title no body", description: "", team: { key: "CTL" } }],
        },
      },
    });
    try {
      const result = await withToken(() =>
        fillTitleDescriptionFallback(["CTL-500"]),
      );
      expect(result["CTL-500"].title).toBe("Has title no body");
      expect(result["CTL-500"].description).toBeNull();
    } finally {
      spy.restore();
    }
  });

  it("does NOT re-fetch cached IDs (cache hit within TTL)", async () => {
    const spy1 = mockFetch({
      data: { issues: { nodes: [{ number: 1, title: "T1", description: "B1", team: { key: "CTL" } }] } },
    });
    await withToken(() => fillTitleDescriptionFallback(["CTL-1"]));
    spy1.restore();

    const spy2 = mockFetch({ data: { issues: { nodes: [] } } });
    try {
      const result = await withToken(() =>
        fillTitleDescriptionFallback(["CTL-1"]),
      );
      expect(result["CTL-1"].title).toBe("T1");
      expect(result["CTL-1"].description).toBe("B1");
      expect(spy2.callCount).toBe(0); // served from cache, no re-fetch
    } finally {
      spy2.restore();
    }
  });

  it("only fetches the un-cached subset when called with mixed IDs", async () => {
    const spy1 = mockFetch({
      data: { issues: { nodes: [{ number: 1, title: "T1", description: "B1", team: { key: "CTL" } }] } },
    });
    await withToken(() => fillTitleDescriptionFallback(["CTL-1"]));
    spy1.restore();

    const spy2 = mockFetch({
      data: { issues: { nodes: [{ number: 2, title: "T2", description: "B2", team: { key: "CTL" } }] } },
    });
    try {
      const result = await withToken(() =>
        fillTitleDescriptionFallback(["CTL-1", "CTL-2"]),
      );
      expect(result["CTL-1"].title).toBe("T1"); // cache
      expect(result["CTL-2"].title).toBe("T2"); // fresh
      expect(spy2.callCount).toBe(1);
      const vars = spy2.calls[0].variables as { numbers?: number[] };
      expect(vars.numbers).not.toContain(1);
      expect(vars.numbers).toContain(2);
    } finally {
      spy2.restore();
    }
  });

  it("is fail-open: network failure → { title:null, description:null }, no throw", async () => {
    const spy = mockFetchFail();
    try {
      const result = await withToken(() =>
        fillTitleDescriptionFallback(["CTL-9999"]),
      );
      expect(result["CTL-9999"].title).toBeNull();
      expect(result["CTL-9999"].description).toBeNull();
    } finally {
      spy.restore();
    }
  });

  it("is fail-open with no token: returns nulls, never calls fetch", async () => {
    const prevToken = process.env.LINEAR_API_TOKEN;
    const prevKey = process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_API_TOKEN;
    delete process.env.LINEAR_API_KEY;
    const spy = mockFetch({ data: { issues: { nodes: [] } } });
    try {
      const result = await fillTitleDescriptionFallback(["CTL-7"]);
      expect(result["CTL-7"].title).toBeNull();
      expect(result["CTL-7"].description).toBeNull();
      expect(spy.callCount).toBe(0); // no token → graphql returns early
    } finally {
      spy.restore();
      if (prevToken !== undefined) process.env.LINEAR_API_TOKEN = prevToken;
      if (prevKey !== undefined) process.env.LINEAR_API_KEY = prevKey;
    }
  });

  it("stores honest nulls for unparseable identifiers", async () => {
    const spy = mockFetch({ data: { issues: { nodes: [] } } });
    try {
      const result = await withToken(() =>
        fillTitleDescriptionFallback(["not-a-ticket", "CTL-FAIL"]),
      );
      expect(result["not-a-ticket"].title).toBeNull();
      expect(result["CTL-FAIL"].title).toBeNull(); // no numeric suffix
    } finally {
      spy.restore();
    }
  });

  it("cache grows after a batch fetch (hits + misses both cached)", async () => {
    _clearTitleDescCache();
    const spy = mockFetch({
      data: {
        issues: {
          nodes: [{ number: 10, title: "T10", description: "B10", team: { key: "CTL" } }],
        },
      },
    });
    try {
      await withToken(() =>
        fillTitleDescriptionFallback(["CTL-10", "CTL-20", "CTL-30"]),
      );
      // CTL-10 hit + CTL-20/CTL-30 misses → 3 cached entries.
      expect(_getTitleDescCacheSize()).toBeGreaterThanOrEqual(3);
    } finally {
      spy.restore();
    }
  });

  it("_clearTitleDescCache(id) evicts a single entry (webhook invalidation)", async () => {
    const spy1 = mockFetch({
      data: { issues: { nodes: [{ number: 42, title: "Old", description: "old body", team: { key: "CTL" } }] } },
    });
    await withToken(() => fillTitleDescriptionFallback(["CTL-42"]));
    spy1.restore();

    // Evict just CTL-42, as the issue webhook branch does.
    _clearTitleDescCache("CTL-42");

    const spy2 = mockFetch({
      data: { issues: { nodes: [{ number: 42, title: "New", description: "new body", team: { key: "CTL" } }] } },
    });
    try {
      const result = await withToken(() =>
        fillTitleDescriptionFallback(["CTL-42"]),
      );
      expect(result["CTL-42"].title).toBe("New"); // re-fetched fresh
      expect(spy2.callCount).toBe(1);
    } finally {
      spy2.restore();
    }
  });
});
