// CTL-889 (P12): unit tests for the cache-backed fuzzy ticket search. Pure logic
// — the descriptor reader is injected, so no DB / live Linear call. Encodes the
// Gherkin acceptance scenario:
//   • "Search is cache-backed and fuzzy" (fuzzy matches from the cached Linear
//      truth; NO per-keystroke live Linear API call is made)
import { describe, it, expect } from "bun:test";
import {
  searchDescriptors,
  readTicketSearch,
} from "../lib/ticket-search-reader.mjs";
import type { TicketDescriptor } from "../../broker/broker-state.d.mts";

function descriptor(partial: Partial<TicketDescriptor>): TicketDescriptor {
  return {
    ticket: partial.ticket ?? "CTL-1",
    state: partial.state ?? null,
    prNumber: null,
    relations: null,
    labels: partial.labels ?? null,
    priority: null,
    estimate: null,
    resolution: null,
    assignee: null,
    uuid: null,
    removed: false,
    removedAt: null,
    // CTL-923 (BFF11): fence projection + held-since from the durable cache.
    ownerHost: null,
    generation: null,
    fencePhase: null,
    claimedAt: null,
    heldSince: null,
    updatedAt: "2026-06-08T12:00:00.000Z",
  };
}

const fixtures: TicketDescriptor[] = [
  descriptor({ ticket: "CTL-845", state: "Implement", labels: ["monitor"] }),
  descriptor({
    ticket: "CTL-900",
    state: "Backlog",
    labels: ["rate-limit", "broker"],
  }),
  descriptor({ ticket: "CTL-901", state: "Done", labels: ["feature"] }),
];

describe("searchDescriptors — cache-backed fuzzy search (P12)", () => {
  it("matches on a label substring (e.g. 'rate-limit')", () => {
    const out = searchDescriptors("rate-limit", fixtures);
    expect(out.results[0].ticket).toBe("CTL-900");
    expect(out.source).toBe("filter-state.db");
  });

  it("matches a ticket id fragment", () => {
    const out = searchDescriptors("845", fixtures);
    expect(out.results.map((r) => r.ticket)).toContain("CTL-845");
  });

  it("fuzzy-matches a subsequence (chars in order, gapped)", () => {
    // "mntr" is a subsequence of "monitor" → CTL-845's label haystack.
    const out = searchDescriptors("mntr", fixtures);
    expect(out.results.map((r) => r.ticket)).toContain("CTL-845");
  });

  it("ranks an exact substring above a looser subsequence match", () => {
    const ds = [
      descriptor({ ticket: "CTL-100", labels: ["backoff"] }), // 'back' substring
      descriptor({ ticket: "CTL-200", labels: ["broker"] }), // 'b..k' subsequence
    ];
    const out = searchDescriptors("back", ds);
    expect(out.results[0].ticket).toBe("CTL-100");
  });

  it("returns no matches when nothing fuzzy-matches", () => {
    const out = searchDescriptors("zzzzqqqq", fixtures);
    expect(out.results).toEqual([]);
  });

  it("respects the limit", () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      descriptor({ ticket: `CTL-${i}`, labels: ["monitor"] }),
    );
    const out = searchDescriptors("monitor", many, { limit: 5 });
    expect(out.results).toHaveLength(5);
  });
});

describe("readTicketSearch — route-facing reader (P12)", () => {
  it("reads via an injected descriptor reader (NO live Linear call)", async () => {
    let calls = 0;
    const out = await readTicketSearch("rate-limit", {
      descriptorsReader: () => {
        calls++;
        return fixtures;
      },
    });
    // ONE cache read for the query — never a per-keystroke live Linear API call.
    expect(calls).toBe(1);
    expect(out.results[0].ticket).toBe("CTL-900");
  });

  it("degrades to an empty result set (never throws) when the reader rejects", async () => {
    const out = await readTicketSearch("anything", {
      descriptorsReader: () => {
        throw new Error("db locked");
      },
    });
    expect(out.results).toEqual([]);
    expect(out.query).toBe("anything");
  });
});
