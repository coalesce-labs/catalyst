import { describe, it, expect } from "bun:test";
import {
  createLinearFetcher,
  parseTicketJson,
  type Runner,
} from "../lib/linear";

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
