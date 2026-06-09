// worker-grouping.test.ts — units for the SURF1 Workers node grouping + filter
// (CTL-909). Pure logic, no DOM — run from the ui package:
//   cd ui && bun test src/board/worker-grouping.test.ts
//
// Each `describe` maps to a Gherkin scenario in the ticket (SURF1):
//   - "Worker cards are attributable to their host node"  → workerHostName / columns
//   - "selecting group-by Node lays out one column per host.name" → nodeColumns
//   - "a node filter lets the operator scope the grid to a single host" → filterWorkersByHost
//   - "Single-host cluster is an exact identity no-op" → the single-host collapse
import { describe, it, expect } from "bun:test";
import type { BoardWorker } from "./types";
import { sortWorkers } from "./list-order";
import {
  workerHostName,
  workerHostNames,
  filterWorkersByHost,
  nodeColumns,
  isMultiHost,
  HOST_FILTER_ALL,
  UNATTRIBUTED_HOST,
} from "./worker-grouping";

// Minimal worker factory — only the fields the grouping reads matter; the rest
// are filled with inert defaults so the BoardWorker shape is satisfied.
function w(
  over: Partial<BoardWorker> & Pick<BoardWorker, "name">,
): BoardWorker {
  return {
    ticket: over.name.split(":")[0] ?? over.name,
    tickets: [over.name.split(":")[0] ?? over.name],
    phase: "implement",
    status: "running",
    activeState: null,
    working: false,
    lastActiveMs: null,
    repo: "catalyst",
    team: "CTL",
    runtimeMs: null,
    costUSD: null,
    host: null,
    ...over,
  };
}

const host = (name: string) => ({ name, id: `id-${name}` });

describe("workerHostName — host attribution off the worker entity", () => {
  it("returns the worker's host.name when a host is named", () => {
    expect(workerHostName(w({ name: "CTL-1:1", host: host("mini") }))).toBe("mini");
  });

  it("returns null when the worker has no named host (never fabricates one)", () => {
    expect(workerHostName(w({ name: "CTL-1:1", host: null }))).toBeNull();
    expect(workerHostName(w({ name: "CTL-1:1" }))).toBeNull();
  });
});

describe("workerHostNames — distinct nodes in display order", () => {
  it("lists distinct real host names sorted alphabetically", () => {
    const workers = [
      w({ name: "CTL-1:1", host: host("zed") }),
      w({ name: "CTL-2:1", host: host("alpha") }),
      w({ name: "CTL-3:1", host: host("alpha") }),
      w({ name: "CTL-4:1", host: host("mini") }),
    ];
    expect(workerHostNames(workers)).toEqual(["alpha", "mini", "zed"]);
  });

  it("appends the unattributed bucket LAST when a worker has no host", () => {
    const workers = [
      w({ name: "CTL-1:1", host: host("mini") }),
      w({ name: "CTL-2:1", host: null }),
      w({ name: "CTL-3:1", host: host("alpha") }),
    ];
    expect(workerHostNames(workers)).toEqual(["alpha", "mini", UNATTRIBUTED_HOST]);
  });

  it("yields no columns for an empty worker set", () => {
    expect(workerHostNames([])).toEqual([]);
  });

  // Single-host identity no-op: exactly one column.
  it("collapses to a single entry when only one node exists", () => {
    const workers = [
      w({ name: "CTL-1:1", host: host("mini") }),
      w({ name: "CTL-2:1", host: host("mini") }),
    ];
    expect(workerHostNames(workers)).toEqual(["mini"]);
  });
});

describe("filterWorkersByHost — the node filter scopes the grid", () => {
  const workers = [
    w({ name: "CTL-1:1", host: host("mini") }),
    w({ name: "CTL-2:1", host: host("alpha") }),
    w({ name: "CTL-3:1", host: null }),
  ];

  it("is an identity no-op for the ALL sentinel (every node)", () => {
    expect(filterWorkersByHost(workers, HOST_FILTER_ALL).map((x) => x.name)).toEqual([
      "CTL-1:1",
      "CTL-2:1",
      "CTL-3:1",
    ]);
  });

  it("scopes to exactly one host when a host name is selected", () => {
    expect(filterWorkersByHost(workers, "alpha").map((x) => x.name)).toEqual([
      "CTL-2:1",
    ]);
  });

  it("scopes to the hostless workers under the unattributed sentinel", () => {
    expect(filterWorkersByHost(workers, UNATTRIBUTED_HOST).map((x) => x.name)).toEqual([
      "CTL-3:1",
    ]);
  });

  it("yields an empty list for a host with no workers (never throws)", () => {
    expect(filterWorkersByHost(workers, "ghost")).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const before = workers.map((x) => x.name);
    filterWorkersByHost(workers, "mini");
    expect(workers.map((x) => x.name)).toEqual(before);
  });
});

describe("nodeColumns — one column (lane) per host.name", () => {
  it("lays out one column per node, in workerHostNames order", () => {
    const workers = [
      w({ name: "CTL-1:1", host: host("mini") }),
      w({ name: "CTL-2:1", host: host("alpha") }),
      w({ name: "CTL-3:1", host: host("alpha") }),
    ];
    const cols = nodeColumns(workers);
    expect(cols.map((c) => c.host)).toEqual(["alpha", "mini"]);
    expect(cols[0]!.workers.map((x) => x.name).sort()).toEqual(["CTL-2:1", "CTL-3:1"]);
    expect(cols[1]!.workers.map((x) => x.name)).toEqual(["CTL-1:1"]);
  });

  it("orders each column's workers by the shared sortWorkers comparator", () => {
    // active sorts before idle before stuck; within a rank, longer runtime first.
    const workers = [
      w({ name: "CTL-1:1", host: host("mini"), activeState: "stuck" }),
      w({ name: "CTL-2:1", host: host("mini"), activeState: "active", runtimeMs: 1000 }),
      w({ name: "CTL-3:1", host: host("mini"), activeState: "active", runtimeMs: 5000 }),
      w({ name: "CTL-4:1", host: host("mini"), activeState: null, runtimeMs: 2000 }),
    ];
    const col = nodeColumns(workers)[0]!;
    const expected = sortWorkers(workers).map((x) => x.name);
    expect(col.workers.map((x) => x.name)).toEqual(expected);
    // sanity: active (longest first) → idle → stuck
    expect(col.workers.map((x) => x.name)).toEqual([
      "CTL-3:1",
      "CTL-2:1",
      "CTL-4:1",
      "CTL-1:1",
    ]);
  });

  it("yields no columns for an empty worker set", () => {
    expect(nodeColumns([])).toEqual([]);
  });

  // ── Single-host cluster is an exact identity no-op ──────────────────────────
  it("collapses to ONE column whose order is the host-unaware sortWorkers order", () => {
    const workers = [
      w({ name: "CTL-1:1", host: host("mini"), activeState: "active", runtimeMs: 100 }),
      w({ name: "CTL-2:1", host: host("mini"), activeState: "stuck" }),
      w({ name: "CTL-3:1", host: host("mini"), activeState: "active", runtimeMs: 900 }),
    ];
    const cols = nodeColumns(workers);
    expect(cols).toHaveLength(1);
    expect(cols[0]!.host).toBe("mini");
    // byte-for-byte the host-unaware ordering — no extra chrome, no reordering.
    expect(cols[0]!.workers.map((x) => x.name)).toEqual(
      sortWorkers(workers).map((x) => x.name),
    );
  });
});

describe("isMultiHost — the node filter is only worth showing for N>1 nodes", () => {
  it("is false for a single-host fleet (the filter would be inert)", () => {
    expect(
      isMultiHost([
        w({ name: "CTL-1:1", host: host("mini") }),
        w({ name: "CTL-2:1", host: host("mini") }),
      ]),
    ).toBe(false);
  });

  it("is false for an empty fleet", () => {
    expect(isMultiHost([])).toBe(false);
  });

  it("is true once a second distinct node joins", () => {
    expect(
      isMultiHost([
        w({ name: "CTL-1:1", host: host("mini") }),
        w({ name: "CTL-2:1", host: host("alpha") }),
      ]),
    ).toBe(true);
  });

  it("counts the unattributed bucket as a distinct lane", () => {
    expect(
      isMultiHost([
        w({ name: "CTL-1:1", host: host("mini") }),
        w({ name: "CTL-2:1", host: null }),
      ]),
    ).toBe(true);
  });
});
