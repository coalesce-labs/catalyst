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

  const spy = (_url: string | URL | Request, init?: RequestInit) => {
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
  globalThis.fetch = (() => Promise.reject(new Error("network failure"))) as any;
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
      // CTL-976 guard: the FILTER must not use `identifier: { in }` (that 400s).
      // The query CAN use `identifier` as a FIELD name (e.g. relatedIssue.identifier).
      expect(call.query).not.toMatch(/filter[^}]*identifier/);
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
    globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      calls.push(body.variables as { teamKey?: string; numbers?: number[] });
      const teamKey = body.variables?.teamKey as string;
      const nodes =
        teamKey === "CTL"
          ? [{ number: 926, title: "CTL title", description: "ctl body", team: { key: "CTL" } }]
          : [{ number: 1, title: "ADV title", description: "adv body", team: { key: "ADV" } }];
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { issues: { nodes } } }) } as Response);
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

describe("CTL-996: fillTitleDescriptionFallback — labels + relations extension", () => {
  beforeEach(() => {
    _clearTitleDescCache();
  });

  // Helper: build a full mock node with labels and relations.
  // B3: relation nodes include title/state/priority/project on relatedIssue/issue.
  function makeNode(overrides: Record<string, unknown> = {}) {
    return {
      number: 996,
      title: "Ticket with labels",
      description: "body text",
      team: { key: "CTL" },
      state: { name: "In Progress", type: "started" },
      priority: 2,
      project: { name: "Orch Monitor" },
      estimate: 3,
      labels: { nodes: [{ name: "feature", color: "#8b5cf6" }, { name: "monitor", color: "#3b82f6" }] },
      relations: {
        nodes: [{
          type: "blocks",
          relatedIssue: {
            identifier: "CTL-997",
            title: "Blocked ticket",
            state: { name: "Todo", type: "unstarted" },
            priority: 3,
            project: { name: "Orch Monitor" },
          },
        }],
      },
      inverseRelations: {
        nodes: [{
          type: "blocks",
          issue: {
            identifier: "CTL-995",
            title: "Blocking ticket",
            state: { name: "Done", type: "completed" },
            priority: 1,
            project: { name: "Orch Monitor" },
          },
        }],
      },
      ...overrides,
    };
  }

  it("parses labels from the response node", async () => {
    const spy = mockFetch({
      data: { issues: { nodes: [makeNode()] } },
    });
    try {
      const result = await withToken(() => fillTitleDescriptionFallback(["CTL-996"]));
      expect(result["CTL-996"].labels).toEqual([
        { name: "feature", color: "#8b5cf6" },
        { name: "monitor", color: "#3b82f6" },
      ]);
    } finally {
      spy.restore();
    }
  });

  it("parses forward blocks relation into .blocks[] as RelationTarget objects", async () => {
    const spy = mockFetch({ data: { issues: { nodes: [makeNode()] } } });
    try {
      const result = await withToken(() => fillTitleDescriptionFallback(["CTL-996"]));
      const blocks = result["CTL-996"].relations?.blocks ?? [];
      expect(blocks.length).toBe(1);
      expect(blocks[0].identifier).toBe("CTL-997");
      expect(blocks[0].title).toBe("Blocked ticket");
      expect(blocks[0].state).toEqual({ name: "Todo", type: "unstarted" });
      expect(blocks[0].priority).toBe(3);
      expect(blocks[0].project).toBe("Orch Monitor");
    } finally {
      spy.restore();
    }
  });

  it("parses inverse blocks relation into .blockedBy[] as RelationTarget objects", async () => {
    const spy = mockFetch({ data: { issues: { nodes: [makeNode()] } } });
    try {
      const result = await withToken(() => fillTitleDescriptionFallback(["CTL-996"]));
      const blockedBy = result["CTL-996"].relations?.blockedBy ?? [];
      expect(blockedBy.length).toBe(1);
      expect(blockedBy[0].identifier).toBe("CTL-995");
      expect(blockedBy[0].title).toBe("Blocking ticket");
      expect(blockedBy[0].state).toEqual({ name: "Done", type: "completed" });
      expect(blockedBy[0].priority).toBe(1);
    } finally {
      spy.restore();
    }
  });

  it("parses duplicate relation into .duplicateOf[]", async () => {
    const spy = mockFetch({
      data: {
        issues: {
          nodes: [
            makeNode({
              relations: {
                nodes: [{
                  type: "duplicate",
                  relatedIssue: {
                    identifier: "CTL-990",
                    title: "Original",
                    state: { name: "Done", type: "completed" },
                    priority: 0,
                    project: null,
                  },
                }],
              },
              inverseRelations: { nodes: [] },
            }),
          ],
        },
      },
    });
    try {
      const result = await withToken(() => fillTitleDescriptionFallback(["CTL-996"]));
      const dups = result["CTL-996"].relations?.duplicateOf ?? [];
      expect(dups.length).toBe(1);
      expect(dups[0].identifier).toBe("CTL-990");
      expect(result["CTL-996"].relations?.blocks).toEqual([]);
    } finally {
      spy.restore();
    }
  });

  it("dedupes related from both forward and inverse relations by identifier", async () => {
    const spy = mockFetch({
      data: {
        issues: {
          nodes: [
            makeNode({
              relations: {
                nodes: [{
                  type: "related",
                  relatedIssue: {
                    identifier: "CTL-880",
                    title: "Related A",
                    state: { name: "Todo", type: "unstarted" },
                    priority: null,
                    project: null,
                  },
                }],
              },
              inverseRelations: {
                nodes: [
                  // dup of CTL-880 — should be deduped
                  {
                    type: "related",
                    issue: {
                      identifier: "CTL-880",
                      title: "Related A (inv)",
                      state: { name: "Todo", type: "unstarted" },
                      priority: null,
                      project: null,
                    },
                  },
                  {
                    type: "related",
                    issue: {
                      identifier: "CTL-881",
                      title: "Related B",
                      state: null,
                      priority: null,
                      project: null,
                    },
                  },
                ],
              },
            }),
          ],
        },
      },
    });
    try {
      const result = await withToken(() => fillTitleDescriptionFallback(["CTL-996"]));
      const related = result["CTL-996"].relations?.related ?? [];
      const identifiers = related.map((r: { identifier: string }) => r.identifier);
      expect(identifiers).toContain("CTL-880");
      expect(identifiers).toContain("CTL-881");
      // deduped — only one entry for CTL-880
      expect(identifiers.filter((x: string) => x === "CTL-880").length).toBe(1);
    } finally {
      spy.restore();
    }
  });

  it("fail-open: network failure → labels:null, relations:null, no throw", async () => {
    const spy = mockFetchFail();
    try {
      const result = await withToken(() => fillTitleDescriptionFallback(["CTL-996"]));
      expect(result["CTL-996"].labels).toBeNull();
      expect(result["CTL-996"].relations).toBeNull();
      // title/description still null-caching
      expect(result["CTL-996"].title).toBeNull();
    } finally {
      spy.restore();
    }
  });

  it("null-caching: fails-open within TTL (no re-fetch after network failure)", async () => {
    const spy1 = mockFetchFail();
    await withToken(() => fillTitleDescriptionFallback(["CTL-996"]));
    spy1.restore();

    // Second call: node NOT re-fetched (null-cached from failure).
    const spy2 = mockFetch({ data: { issues: { nodes: [makeNode()] } } });
    try {
      const result = await withToken(() => fillTitleDescriptionFallback(["CTL-996"]));
      expect(spy2.callCount).toBe(0); // served from null-cache
      expect(result["CTL-996"].labels).toBeNull(); // cached null persists
    } finally {
      spy2.restore();
    }
  });

  it("node with missing labels field → labels null", async () => {
    const spy = mockFetch({
      data: {
        issues: {
          nodes: [
            {
              number: 996,
              title: "T",
              description: "d",
              team: { key: "CTL" },
              // no labels field at all
              relations: { nodes: [] },
              inverseRelations: { nodes: [] },
            },
          ],
        },
      },
    });
    try {
      const result = await withToken(() => fillTitleDescriptionFallback(["CTL-996"]));
      expect(result["CTL-996"].labels).toBeNull();
    } finally {
      spy.restore();
    }
  });

  it("sends a query that includes labels, relations, inverseRelations, and relation-target detail fields", async () => {
    const spy = mockFetch({ data: { issues: { nodes: [makeNode()] } } });
    try {
      await withToken(() => fillTitleDescriptionFallback(["CTL-996"]));
      const query = spy.calls[0].query as string;
      expect(query).toContain("labels");
      expect(query).toContain("relations");
      expect(query).toContain("inverseRelations");
      expect(query).toContain("relatedIssue");
      // B3: relation-target detail fields
      expect(query).toContain("identifier");
      expect(query).toContain("title");
      expect(query).toContain("state");
      expect(query).toContain("priority");
      expect(query).toContain("project");
      // B3: own-ticket meta fields
      expect(query).toContain("estimate");
    } finally {
      spy.restore();
    }
  });
});

describe("CTL-1003 B3: fillTitleDescriptionFallback — parseTicketMeta + ttlMs + RelationTarget shape", () => {
  beforeEach(() => {
    _clearTitleDescCache();
  });

  function makeFullNode(overrides: Record<string, unknown> = {}) {
    return {
      number: 1003,
      title: "Full ticket",
      description: "A description",
      team: { key: "CTL" },
      state: { name: "In Progress", type: "started" },
      priority: 2,
      project: { name: "Orch Monitor" },
      estimate: 5,
      labels: { nodes: [] },
      relations: { nodes: [] },
      inverseRelations: { nodes: [] },
      ...overrides,
    };
  }

  it("returns own-ticket state/priority/project/estimate in the result entry", async () => {
    const spy = mockFetch({ data: { issues: { nodes: [makeFullNode()] } } });
    try {
      const result = await withToken(() => fillTitleDescriptionFallback(["CTL-1003"]));
      const entry = result["CTL-1003"];
      expect(entry.state).toEqual({ name: "In Progress", type: "started" });
      expect(entry.priority).toBe(2);
      expect(entry.project).toBe("Orch Monitor");
      expect(entry.estimate).toBe(5);
    } finally {
      spy.restore();
    }
  });

  it("NULL_ENTRY shape: state/priority/project/estimate are all null", async () => {
    // An ID that Linear returns no data for → null entry.
    const spy = mockFetch({ data: { issues: { nodes: [] } } });
    try {
      const result = await withToken(() => fillTitleDescriptionFallback(["CTL-9999"]));
      expect(result["CTL-9999"].state).toBeNull();
      expect(result["CTL-9999"].priority).toBeNull();
      expect(result["CTL-9999"].project).toBeNull();
      expect(result["CTL-9999"].estimate).toBeNull();
    } finally {
      spy.restore();
    }
  });

  it("completed ticket → 24h ttlMs (served from cache on second call within 24h)", async () => {
    const completedNode = makeFullNode({ state: { name: "Done", type: "completed" } });
    const spy1 = mockFetch({ data: { issues: { nodes: [completedNode] } } });
    await withToken(() => fillTitleDescriptionFallback(["CTL-1003"]));
    spy1.restore();

    // Second call immediately after — completed ticket should be served from 24h cache.
    const spy2 = mockFetch({ data: { issues: { nodes: [] } } });
    try {
      const result = await withToken(() => fillTitleDescriptionFallback(["CTL-1003"]));
      expect(spy2.callCount).toBe(0); // still cached (within 24h)
      expect(result["CTL-1003"].state?.type).toBe("completed");
    } finally {
      spy2.restore();
    }
  });

  it("canceled ticket → 24h ttlMs (served from cache)", async () => {
    const canceledNode = makeFullNode({ state: { name: "Cancelled", type: "canceled" } });
    const spy1 = mockFetch({ data: { issues: { nodes: [canceledNode] } } });
    await withToken(() => fillTitleDescriptionFallback(["CTL-1003"]));
    spy1.restore();

    const spy2 = mockFetch({ data: { issues: { nodes: [] } } });
    try {
      await withToken(() => fillTitleDescriptionFallback(["CTL-1003"]));
      expect(spy2.callCount).toBe(0); // cached for 24h
    } finally {
      spy2.restore();
    }
  });

  it("in-progress (started) ticket → 5m TTL (refetched after TTL)", async () => {
    const startedNode = makeFullNode({ state: { name: "In Progress", type: "started" } });
    const spy1 = mockFetch({ data: { issues: { nodes: [startedNode] } } });
    await withToken(() => fillTitleDescriptionFallback(["CTL-1003"]));
    spy1.restore();

    // Simulate TTL expiry by evicting cache.
    _clearTitleDescCache("CTL-1003");

    const spy2 = mockFetch({ data: { issues: { nodes: [startedNode] } } });
    try {
      await withToken(() => fillTitleDescriptionFallback(["CTL-1003"]));
      expect(spy2.callCount).toBe(1); // re-fetched after eviction
    } finally {
      spy2.restore();
    }
  });

  it("relation target missing title → title null in RelationTarget", async () => {
    const node = makeFullNode({
      relations: {
        nodes: [{
          type: "blocks",
          relatedIssue: {
            identifier: "CTL-100",
            // no title field
            state: { name: "Todo", type: "unstarted" },
            priority: 0,
            project: null,
          },
        }],
      },
    });
    const spy = mockFetch({ data: { issues: { nodes: [node] } } });
    try {
      const result = await withToken(() => fillTitleDescriptionFallback(["CTL-1003"]));
      const target = result["CTL-1003"].relations?.blocks?.[0];
      expect(target?.identifier).toBe("CTL-100");
      expect(target?.title).toBeNull();
      expect(target?.state?.type).toBe("unstarted");
    } finally {
      spy.restore();
    }
  });

  it("relation target with no state/project → both null in RelationTarget", async () => {
    const node = makeFullNode({
      relations: {
        nodes: [{
          type: "related",
          relatedIssue: {
            identifier: "CTL-200",
            title: "Minimal",
            // no state, no project
            priority: null,
            project: null,
          },
        }],
      },
      inverseRelations: { nodes: [] },
    });
    const spy = mockFetch({ data: { issues: { nodes: [node] } } });
    try {
      const result = await withToken(() => fillTitleDescriptionFallback(["CTL-1003"]));
      const target = result["CTL-1003"].relations?.related?.[0];
      expect(target?.identifier).toBe("CTL-200");
      expect(target?.state).toBeNull();
      expect(target?.project).toBeNull();
      expect(target?.priority).toBeNull();
    } finally {
      spy.restore();
    }
  });

  it("own-ticket with no state/project/estimate → all null", async () => {
    const node = {
      number: 1003,
      title: "Minimal ticket",
      description: "body",
      team: { key: "CTL" },
      // no state, no project, no estimate, no priority
      labels: { nodes: [] },
      relations: { nodes: [] },
      inverseRelations: { nodes: [] },
    };
    const spy = mockFetch({ data: { issues: { nodes: [node] } } });
    try {
      const result = await withToken(() => fillTitleDescriptionFallback(["CTL-1003"]));
      expect(result["CTL-1003"].state).toBeNull();
      expect(result["CTL-1003"].project).toBeNull();
      expect(result["CTL-1003"].estimate).toBeNull();
      expect(result["CTL-1003"].priority).toBeNull();
    } finally {
      spy.restore();
    }
  });
});
