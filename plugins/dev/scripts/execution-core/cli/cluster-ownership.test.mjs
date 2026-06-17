// cluster-ownership.test.mjs — CTL-1211. The HRW no-contention proof: every
// ticket is owned by exactly one host, deterministically.
import { describe, test, expect } from "bun:test";
import { buildOwnership, runOwnership } from "./cluster.mjs";

describe("buildOwnership (CTL-1211)", () => {
  test("each ticket owned by exactly one host — zero overlap", () => {
    const tickets = ["CTL-1", "CTL-2", "CTL-3", "SLI-4", "OTL-9", "EVR-2", "ADV-7"];
    const o = buildOwnership(tickets, ["mini", "mini-2"]);
    expect(o.total).toBe(7);
    const assigned = Object.values(o.byHost).reduce((n, a) => n + a.length, 0);
    expect(assigned).toBe(7);
    expect(o.unassigned).toBe(0);
    // a ticket can never appear under two hosts
    const all = Object.values(o.byHost).flat();
    expect(new Set(all).size).toBe(all.length);
  });

  test("deterministic — identical split on every call (no coordination needed)", () => {
    const a = buildOwnership(["A", "B", "C", "D"], ["x", "y"]);
    const b = buildOwnership(["A", "B", "C", "D"], ["x", "y"]);
    expect(a.byHost).toEqual(b.byHost);
  });

  test("single-host roster owns everything (the N=1 identity)", () => {
    const o = buildOwnership(["A", "B", "C"], ["solo"]);
    expect(o.byHost.solo.length).toBe(3);
    expect(o.unassigned).toBe(0);
  });

  test("empty roster → every ticket unassigned (no owner can exist)", () => {
    const o = buildOwnership(["A", "B"], []);
    expect(o.unassigned).toBe(2);
  });

  test("adding a host re-homes only ~1/N (minimal churn)", () => {
    const tickets = Array.from({ length: 200 }, (_, i) => `CTL-${i}`);
    const before = buildOwnership(tickets, ["mini"]);
    const after = buildOwnership(tickets, ["mini", "mini-2"]);
    // HRW minimal churn: adding mini-2 only moves tickets mini→mini-2; the
    // tickets mini keeps are a strict subset of what it owned at N=1.
    const movedToMini2 = after.byHost["mini-2"].length;
    // with 2 hosts, mini-2 should take roughly half — bounded sanity (20%..80%)
    expect(movedToMini2).toBeGreaterThan(40);
    expect(movedToMini2).toBeLessThan(160);
    // mini's remaining tickets are a strict subset of what it had at N=1
    const beforeSet = new Set(before.byHost["mini"]);
    expect(after.byHost["mini"].every((t) => beforeSet.has(t))).toBe(true);
  });
});

describe("runOwnership (CTL-1211)", () => {
  test("injected ticket lister → exit 0", () => {
    const code = runOwnership(["--roster=mini,mini-2", "--json"], {
      listTickets: () => ["CTL-1", "CTL-2"],
    });
    expect(code).toBe(0);
  });

  test("lister failure → exit 1 (graceful)", () => {
    const code = runOwnership(["--roster=mini,mini-2"], {
      listTickets: () => {
        throw new Error("linearis down");
      },
    });
    expect(code).toBe(1);
  });
});
