// queue-grouping.test.ts — units for the SURF2 (CTL-910) per-node grouping of the
// waiting queue. Pure logic, no DOM — run from the ui package:
//   cd ui && bun test src/board/queue-grouping.test.ts
//
// These encode the SURF2 Gherkin scenarios that are testable without a renderer:
//   • "Queue ordering matches the scheduler's global rank" — global rank order is
//     preserved both flat and within each per-host group.
//   • "Queue entries are attributable to their owning node" — multi-host yields a
//     real node column / grouping.
//   • "Single-host cluster is an exact identity no-op" — one (or zero) distinct
//     host ⇒ no node column, one synthetic group, behaviourally identical to the
//     flat list.
import { describe, it, expect } from "bun:test";
import type { BoardQueueItem, BoardHostRef } from "./types";
import {
  queueHostMode,
  groupQueueByHost,
  UNATTRIBUTED_HOST_LABEL,
} from "./queue-grouping";

const host = (name: string): BoardHostRef => ({ name, id: `id-${name}` });

// Minimal queue item — only the fields the grouping reads matter; the rest are
// filled with inert defaults so the fixture stays a real BoardQueueItem.
function qi(partial: Partial<BoardQueueItem> & { id: string; rank: number }): BoardQueueItem {
  return {
    title: partial.id,
    priority: 3,
    createdAt: "2026-06-08T00:00:00.000Z",
    repo: "catalyst",
    team: "CTL",
    estimate: null,
    scope: null,
    project: null,
    host: null,
    ...partial,
  };
}

describe("queueHostMode (single-host identity no-op detector)", () => {
  it("reports single-host when the queue is empty", () => {
    // No rows ⇒ nothing to attribute ⇒ identity no-op (no node column).
    expect(queueHostMode([])).toBe("single");
  });

  it("reports single-host when every row resolves to the same host", () => {
    const q = [
      qi({ id: "CTL-1", rank: 1, host: host("mini") }),
      qi({ id: "CTL-2", rank: 2, host: host("mini") }),
    ];
    expect(queueHostMode(q)).toBe("single");
  });

  it("reports single-host when no row carries a host (un-stamped, single-node fleet)", () => {
    // hosts.json absent / length 1 ⇒ board-data stamps host:null; the column must
    // add no visual noise — exactly the non-cluster path.
    const q = [qi({ id: "CTL-1", rank: 1 }), qi({ id: "CTL-2", rank: 2 })];
    expect(queueHostMode(q)).toBe("single");
  });

  it("reports multi-host only when two or more DISTINCT hosts appear", () => {
    const q = [
      qi({ id: "CTL-1", rank: 1, host: host("mini") }),
      qi({ id: "CTL-2", rank: 2, host: host("mac-studio") }),
    ];
    expect(queueHostMode(q)).toBe("multi");
  });

  it("treats one named host + some un-stamped rows as multi-host (the named node is real)", () => {
    // A mixed payload during a roster rollout: one node names itself, the rest are
    // still un-stamped. That IS more than one bucket, so the column is meaningful.
    const q = [
      qi({ id: "CTL-1", rank: 1, host: host("mini") }),
      qi({ id: "CTL-2", rank: 2, host: null }),
    ];
    expect(queueHostMode(q)).toBe("multi");
  });

  it("dedupes hosts by id, not by name", () => {
    // Two refs with the same id are the same node even if a display name differs;
    // that must NOT trip multi-host.
    const q = [
      qi({ id: "CTL-1", rank: 1, host: { name: "mini", id: "shared" } }),
      qi({ id: "CTL-2", rank: 2, host: { name: "mini.local", id: "shared" } }),
    ];
    expect(queueHostMode(q)).toBe("single");
  });
});

describe("groupQueueByHost", () => {
  it("single-host: one group carrying every row in global-rank order", () => {
    const q = [
      qi({ id: "CTL-2", rank: 2, host: host("mini") }),
      qi({ id: "CTL-1", rank: 1, host: host("mini") }),
    ];
    const groups = groupQueueByHost(q);
    expect(groups).toHaveLength(1);
    expect(groups[0].host).toEqual(host("mini"));
    // global rank order preserved within the group (not re-sorted by id).
    expect(groups[0].items.map((i) => i.rank)).toEqual([2, 1]);
  });

  it("un-stamped single-host: one synthetic group with a null host ref", () => {
    const q = [qi({ id: "CTL-1", rank: 1 }), qi({ id: "CTL-2", rank: 2 })];
    const groups = groupQueueByHost(q);
    expect(groups).toHaveLength(1);
    expect(groups[0].host).toBeNull();
    expect(groups[0].label).toBe(UNATTRIBUTED_HOST_LABEL);
    expect(groups[0].items.map((i) => i.id)).toEqual(["CTL-1", "CTL-2"]);
  });

  it("multi-host: one group per distinct host, groups ordered by first appearance in rank order", () => {
    const q = [
      qi({ id: "CTL-1", rank: 1, host: host("mini") }),
      qi({ id: "CTL-2", rank: 2, host: host("studio") }),
      qi({ id: "CTL-3", rank: 3, host: host("mini") }),
    ];
    const groups = groupQueueByHost(q);
    expect(groups.map((g) => g.host?.name)).toEqual(["mini", "studio"]);
    // each group keeps the global ranks of ITS rows, in ascending rank order.
    expect(groups[0].items.map((i) => i.rank)).toEqual([1, 3]);
    expect(groups[1].items.map((i) => i.rank)).toEqual([2]);
  });

  it("multi-host: per-node depth = the group's row count", () => {
    const q = [
      qi({ id: "CTL-1", rank: 1, host: host("mini") }),
      qi({ id: "CTL-2", rank: 2, host: host("mini") }),
      qi({ id: "CTL-3", rank: 3, host: host("studio") }),
    ];
    const depthByHost = Object.fromEntries(
      groupQueueByHost(q).map((g) => [g.host?.name, g.items.length]),
    );
    expect(depthByHost).toEqual({ mini: 2, studio: 1 });
  });

  it("never drops or duplicates a row (flatten round-trips the input set)", () => {
    const q = [
      qi({ id: "CTL-1", rank: 1, host: host("mini") }),
      qi({ id: "CTL-2", rank: 2, host: null }),
      qi({ id: "CTL-3", rank: 3, host: host("studio") }),
    ];
    const flat = groupQueueByHost(q).flatMap((g) => g.items.map((i) => i.id));
    expect(flat.sort()).toEqual(["CTL-1", "CTL-2", "CTL-3"]);
  });
});
