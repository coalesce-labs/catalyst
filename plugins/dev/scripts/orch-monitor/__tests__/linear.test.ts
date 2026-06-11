import { describe, it, expect } from "bun:test";
import {
  createLinearFetcher,
  createCacheBackedLinearFetcher,
  parseTicketJson,
  type LinearCacheReader,
  type Runner,
} from "../lib/linear";
import type { LinearCacheById } from "../lib/linear-cache-reader.d.mts";

const validPayload = JSON.stringify({
  identifier: "ADV-214",
  title: "brand_assignment import hard-fails on re-run instead of upserting",
  url: "https://linear.app/adva/issue/ADV-214/brand_assignment-import",
  state: { name: "Done" },
  project: { name: "Customer Data Import" },
  labels: {
    nodes: [
      { name: "Bug" },
      { name: "api" },
      { name: "onboarding" },
    ],
  },
});

function makeRunner(impls: {
  version?: () => Promise<{ stdout: string; ok: boolean }>;
  read?: (key: string) => Promise<{ stdout: string; ok: boolean }>;
}): Runner {
  return (args: string[]) => {
    if (args[0] === "--version") {
      return impls.version
        ? impls.version()
        : Promise.resolve({ stdout: "2026.4.4\n", ok: true });
    }
    if (args[0] === "issues" && args[1] === "read") {
      const key = args[2] ?? "";
      return impls.read
        ? impls.read(key)
        : Promise.resolve({ stdout: "", ok: false });
    }
    return Promise.resolve({ stdout: "", ok: false });
  };
}

describe("parseTicketJson", () => {
  it("parses a valid linearis issue payload", () => {
    const ticket = parseTicketJson(validPayload);
    expect(ticket).not.toBeNull();
    expect(ticket?.key).toBe("ADV-214");
    expect(ticket?.title).toContain("brand_assignment");
    expect(ticket?.state).toBe("Done");
    expect(ticket?.project).toBe("Customer Data Import");
    expect(ticket?.labels).toEqual(["Bug", "api", "onboarding"]);
    expect(ticket?.url).toContain("linear.app");
    expect(typeof ticket?.fetchedAt).toBe("string");
  });

  it("returns null for malformed JSON", () => {
    expect(parseTicketJson("not json")).toBeNull();
  });

  it("returns null when identifier is missing", () => {
    expect(parseTicketJson(JSON.stringify({ title: "x" }))).toBeNull();
  });
});

describe("createLinearFetcher", () => {
  it("returns null from cache when not yet fetched", () => {
    const fetcher = createLinearFetcher({
      runner: makeRunner({
        read: () => Promise.resolve({ stdout: "", ok: false }),
      }),
    });
    expect(fetcher.get("ADV-214")).toBeNull();
  });

  it("caches tickets after refreshAll", async () => {
    const fetcher = createLinearFetcher({
      runner: makeRunner({
        read: () => Promise.resolve({ stdout: validPayload, ok: true }),
      }),
    });
    await fetcher.refreshAll(["ADV-214"]);
    const t = fetcher.get("ADV-214");
    expect(t).not.toBeNull();
    expect(t?.title).toContain("brand_assignment");
  });

  it("degrades silently when linearis is unavailable (probe fails)", async () => {
    let readCalls = 0;
    const fetcher = createLinearFetcher({
      runner: makeRunner({
        version: () => Promise.resolve({ stdout: "", ok: false }),
        read: () => {
          readCalls++;
          return Promise.resolve({ stdout: validPayload, ok: true });
        },
      }),
    });
    await fetcher.refreshAll(["ADV-214", "ADV-215"]);
    expect(readCalls).toBe(0);
    expect(fetcher.get("ADV-214")).toBeNull();
  });

  it("respects the concurrency cap", async () => {
    let active = 0;
    let peak = 0;
    const fetcher = createLinearFetcher({
      concurrency: 3,
      runner: makeRunner({
        read: async (key: string) => {
          active++;
          if (active > peak) peak = active;
          await new Promise((r) => setTimeout(r, 15));
          active--;
          return {
            stdout: JSON.stringify({
              identifier: key,
              title: `t-${key}`,
              state: { name: "Todo" },
              labels: { nodes: [] },
            }),
            ok: true,
          };
        },
      }),
    });
    const keys = Array.from({ length: 12 }, (_, i) => `ADV-${i + 1}`);
    await fetcher.refreshAll(keys);
    expect(peak).toBeLessThanOrEqual(3);
    expect(fetcher.get("ADV-7")?.title).toBe("t-ADV-7");
  });

  it("skips tickets with unrecognized JSON shape (cache unchanged)", async () => {
    const fetcher = createLinearFetcher({
      runner: makeRunner({
        read: () => Promise.resolve({ stdout: "{}", ok: true }),
      }),
    });
    await fetcher.refreshAll(["ADV-999"]);
    expect(fetcher.get("ADV-999")).toBeNull();
  });

  it("dedupes keys and ignores blanks in refreshAll", async () => {
    let calls = 0;
    const fetcher = createLinearFetcher({
      runner: makeRunner({
        read: (key: string) => {
          calls++;
          return Promise.resolve({
            stdout: JSON.stringify({
              identifier: key,
              title: "t",
              state: { name: "Todo" },
              labels: { nodes: [] },
            }),
            ok: true,
          });
        },
      }),
    });
    await fetcher.refreshAll(["ADV-1", "ADV-1", "  ", "ADV-2"]);
    expect(calls).toBe(2);
  });
});

// CTL-211 — event-driven cache invalidation. Today the fetcher polls every
// 5 minutes (linear.start interval). With CTL-210 emitting linear.issue.*
// webhook events to the unified log, we can refresh on-demand the moment a
// ticket changes state, in addition to (not instead of) the polling fallback.
describe("createLinearFetcher — event-driven invalidation (CTL-211)", () => {
  it("exposes invalidate(key) that refreshes the cached entry on demand", async () => {
    const reads: string[] = [];
    const fetcher = createLinearFetcher({
      runner: makeRunner({
        read: (key) => {
          reads.push(key);
          return Promise.resolve({
            stdout: JSON.stringify({
              identifier: key,
              title: `t-${key}-${reads.length}`,
              state: { name: reads.length === 1 ? "Todo" : "In Review" },
              labels: { nodes: [] },
            }),
            ok: true,
          });
        },
      }),
    });

    // Prime the cache.
    await fetcher.refreshAll(["ADV-100"]);
    expect(fetcher.get("ADV-100")?.state).toBe("Todo");
    expect(reads).toEqual(["ADV-100"]);

    // Webhook arrived → invalidate the entry.
    await fetcher.invalidate("ADV-100");
    expect(reads).toEqual(["ADV-100", "ADV-100"]);
    expect(fetcher.get("ADV-100")?.state).toBe("In Review");
  });

  it("invalidate is a no-op for blank keys", async () => {
    const reads: string[] = [];
    const fetcher = createLinearFetcher({
      runner: makeRunner({
        read: (key) => {
          reads.push(key);
          return Promise.resolve({ stdout: "", ok: false });
        },
      }),
    });
    await fetcher.invalidate("");
    await fetcher.invalidate("   ");
    expect(reads).toEqual([]);
  });

  it("invalidate degrades silently when linearis is unavailable", async () => {
    const reads: string[] = [];
    const fetcher = createLinearFetcher({
      runner: makeRunner({
        version: () => Promise.resolve({ stdout: "", ok: false }),
        read: (key) => {
          reads.push(key);
          return Promise.resolve({ stdout: validPayload, ok: true });
        },
      }),
    });
    await fetcher.invalidate("ADV-999");
    expect(reads).toEqual([]);
    expect(fetcher.get("ADV-999")).toBeNull();
  });
});

// BFF9 / CTL-921 — the cache-backed LinearFetcher that retires the live
// `linearis issues read` poller behind /api/linear + /api/briefing. It serves
// every key from the broker's durable filter-state.db ticket_state (via
// readLinearCache) and spawns NOTHING. These tests assert the three Gherkin
// scenarios:
//   1. /api/linear + /api/briefing read from the durable cache (no linearis).
//   2. The live poller is removed, not merely shadowed (no spawn on start/poll).
//   3. Cache miss degrades, never blocks (partial/empty, no live fan-out).
describe("createCacheBackedLinearFetcher (BFF9 — durable-cache LinearFetcher)", () => {
  // A reader that records its calls and returns a canned durable-cache map. It
  // stands in for readLinearCache (which reads filter-state.db ticket_state +
  // the eligible projection); a real `linearis` spawn would NOT route through
  // it, so counting calls here proves "served from cache, no live call".
  function makeCacheReader(
    byId: LinearCacheById,
  ): { reader: LinearCacheReader; calls: () => number } {
    let calls = 0;
    const reader: LinearCacheReader = () => {
      calls++;
      return Promise.resolve(byId);
    };
    return { reader, calls: () => calls };
  }

  const cacheEntry = {
    priority: 2,
    estimate: null,
    project: "Web UI",
    labels: ["monitor", "feature"],
    relations: null,
    assignee: "uuid-bot",
    linearState: "Implement",
    title: "Retire legacy linearis poller",
    ownerHost: null,
    generation: null,
  } satisfies LinearCacheById[string];

  it("Scenario 1: serves /api/linear shape from the durable cache (no linearis spawn)", async () => {
    const { reader, calls } = makeCacheReader({ "CTL-921": cacheEntry });
    const fetcher = createCacheBackedLinearFetcher({ cacheReader: reader });

    // Before any refresh the cache is empty → miss.
    expect(fetcher.get("CTL-921")).toBeNull();

    await fetcher.refreshAll(["CTL-921"]);
    const t = fetcher.get("CTL-921");
    expect(t).not.toBeNull();
    expect(t?.key).toBe("CTL-921");
    expect(t?.title).toBe("Retire legacy linearis poller");
    expect(t?.state).toBe("Implement"); // linearState → LinearTicket.state
    expect(t?.project).toBe("Web UI");
    expect(t?.labels).toEqual(["monitor", "feature"]);
    // url is derived from the key (no durable url source).
    expect(t?.url).toBe("https://linear.app/issue/CTL-921");
    expect(typeof t?.fetchedAt).toBe("string");
    // Exactly one durable-cache read satisfied the request — no per-key fan-out.
    expect(calls()).toBe(1);
  });

  it("Scenario 2: start() reloads the durable cache on the interval — never spawns linearis", async () => {
    const { reader, calls } = makeCacheReader({ "CTL-921": cacheEntry });
    const fetcher = createCacheBackedLinearFetcher({ cacheReader: reader });

    // start() does an immediate bulk reload from the cache (not a linearis poll).
    fetcher.start(() => ["CTL-921"], 60_000);
    // Let the immediate void reload() settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(fetcher.get("CTL-921")?.state).toBe("Implement");
    expect(calls()).toBeGreaterThanOrEqual(1);
    fetcher.stop();
  });

  it("Scenario 2: invalidate() bulk-reloads the durable cache (webhook freshness, no spawn)", async () => {
    let state = "Plan";
    let calls = 0;
    const reader: LinearCacheReader = () => {
      calls++;
      return Promise.resolve({
        "CTL-921": { ...cacheEntry, linearState: state },
      });
    };
    const fetcher = createCacheBackedLinearFetcher({ cacheReader: reader });
    await fetcher.refreshAll([]);
    expect(fetcher.get("CTL-921")?.state).toBe("Plan");

    // Broker wrote the new state into ticket_state; webhook → invalidate reloads.
    state = "PR";
    await fetcher.invalidate("CTL-921");
    expect(fetcher.get("CTL-921")?.state).toBe("PR");
    expect(calls).toBe(2); // one refreshAll + one invalidate, both cache reads
  });

  it("invalidate is a no-op for blank keys (parity with legacy contract)", async () => {
    let calls = 0;
    const reader: LinearCacheReader = () => {
      calls++;
      return Promise.resolve({});
    };
    const fetcher = createCacheBackedLinearFetcher({ cacheReader: reader });
    await fetcher.invalidate("");
    await fetcher.invalidate("   ");
    expect(calls).toBe(0);
  });

  it("Scenario 3: cache miss returns null (partial/empty), never a live fan-out", async () => {
    const { reader } = makeCacheReader({ "CTL-921": cacheEntry });
    const fetcher = createCacheBackedLinearFetcher({ cacheReader: reader });
    await fetcher.refreshAll([]);
    // A key the broker has not yet seen via webhook → null, no live read.
    expect(fetcher.get("CTL-999")).toBeNull();
  });

  it("degrades title/state to empty string when the durable cache lacks them", async () => {
    const { reader } = makeCacheReader({
      "CTL-7": {
        priority: 0,
        estimate: null,
        project: null,
        labels: [],
        relations: null,
        assignee: null,
        linearState: null,
        title: null,
        ownerHost: null,
        generation: null,
      },
    });
    const fetcher = createCacheBackedLinearFetcher({ cacheReader: reader });
    await fetcher.refreshAll([]);
    const t = fetcher.get("CTL-7");
    expect(t).not.toBeNull();
    expect(t?.title).toBe("");
    expect(t?.state).toBe("");
    expect(t?.labels).toEqual([]);
    expect(t?.url).toBe("https://linear.app/issue/CTL-7");
  });

  it("never throws when the cache reader rejects — keeps the last snapshot (read-model never blocks)", async () => {
    let ok = true;
    const reader: LinearCacheReader = () =>
      ok
        ? Promise.resolve({ "CTL-921": cacheEntry })
        : Promise.reject(new Error("db locked"));
    const fetcher = createCacheBackedLinearFetcher({ cacheReader: reader });

    // First reload succeeds and primes the snapshot.
    await fetcher.refreshAll([]);
    expect(fetcher.get("CTL-921")?.state).toBe("Implement");

    // A later reload rejects (locked DB). reload() swallows so refreshAll does
    // NOT reject and the previous good snapshot survives.
    ok = false;
    await fetcher.refreshAll([]);
    expect(true).toBe(true); // refreshAll resolved without throwing
    expect(fetcher.get("CTL-921")?.state).toBe("Implement"); // last good snapshot
  });
});
