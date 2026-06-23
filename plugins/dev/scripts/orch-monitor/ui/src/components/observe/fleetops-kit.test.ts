// fleetops-kit.test.ts — units for the OBS-18 FLEETOPS pure logic:
//   1. fleetHero      — the worst-state-first host-health roll-up
//   2. shortIdFromSessionId / reapCommand — the `claude stop <shortId>` target
//   3. reapList       — the stuck/dead/silent reap rows
//   4. hostWorkerCount / shortHostName — the host-matrix helpers
//
// All pure (no React render), so they run under the ui package's `bun test`:
//   cd ui && bun test src/components/observe/fleetops-kit.test.ts
import { describe, it, expect } from "bun:test";
import type { ClusterSignalNode } from "@/lib/cluster-signal";
import {
  fleetHero,
  shortIdFromSessionId,
  reapCommand,
  reapList,
  hostWorkerCount,
  shortHostName,
  nodeStatusVar,
  daemonCell,
  SILENCE_STALL_MS,
  type ReapWorkerInput,
} from "./fleetops-kit";

function node(over: Partial<ClusterSignalNode>): ClusterSignalNode {
  return { host: "RyansMini250233.rozich", status: "live", ...over };
}

describe("fleetHero — the worst-state-first roll-up", () => {
  it("ALL SYSTEMS GO when every host is live and nothing is stuck/dead (the live ground truth)", () => {
    // The LIVE Mini state (2026-06-10): 1 live host, 0 stuck, 0 dead. The calm,
    // correct success case — NOT an empty state.
    const h = fleetHero([node({ status: "live" })], 0, 0);
    expect(h.tone).toBe("go");
    expect(h.label).toBe("ALL SYSTEMS GO");
    expect(h.detail).toBe("1/1 hosts live · 0 stuck · 0 dead");
    expect(h.liveHosts).toBe(1);
    expect(h.totalHosts).toBe(1);
  });

  it("ALERT (red) when a host is offline — names the offline count and reap suffix", () => {
    const h = fleetHero([node({ status: "offline" })], 0, 2);
    expect(h.tone).toBe("alert");
    expect(h.label).toBe("1 HOST OFFLINE · 2 dead to reap");
    expect(h.detail).toBe("0/1 hosts live · 0 stuck · 2 dead");
  });

  it("ALERT (red) when a worker is stuck even if all hosts are live", () => {
    const h = fleetHero([node({ status: "live" })], 1, 0);
    expect(h.tone).toBe("alert");
    expect(h.label).toBe("1 STUCK WORKER · 1 stuck to reap");
  });

  it("offline beats stuck — leads with the offline host, still names stuck+dead", () => {
    const h = fleetHero([node({ status: "offline" })], 3, 1);
    expect(h.tone).toBe("alert");
    expect(h.label).toBe("1 HOST OFFLINE · 3 stuck · 1 dead to reap");
  });

  it("WARN (amber) when a host is degraded (no offline/stuck)", () => {
    const h = fleetHero([node({ status: "degraded" })], 0, 0);
    expect(h.tone).toBe("warn");
    expect(h.label).toBe("1 HOST DEGRADED");
    expect(h.detail).toBe("0/1 hosts live · 0 stuck · 0 dead");
  });

  it("WARN (amber) when a worker is dead but every host is live and nothing is stuck", () => {
    // The design §3.4 example: "● ... · 0 stuck · 1 dead worker to reap" → amber.
    const h = fleetHero([node({ status: "live" })], 0, 1);
    expect(h.tone).toBe("warn");
    expect(h.label).toBe("1 DEAD WORKER · 1 dead to reap");
  });

  it("degraded host beats a dead worker, names the dead in the reap suffix", () => {
    const h = fleetHero([node({ status: "degraded" })], 0, 2);
    expect(h.tone).toBe("warn");
    expect(h.label).toBe("1 HOST DEGRADED · 2 dead to reap");
  });

  it("UNAVAILABLE (never 'all live') when the cluster signal is unreachable", () => {
    const h = fleetHero(null, 0, 0);
    expect(h.tone).toBe("unavailable");
    expect(h.label).toBe("HOST STATUS UNAVAILABLE");
    expect(h.detail).toBe("cluster signal unreachable");
  });

  it("pluralizes hosts and clamps negative counters", () => {
    const h = fleetHero(
      [node({ host: "a.rozich", status: "offline" }), node({ host: "b.rozich", status: "offline" })],
      -1,
      -3,
    );
    expect(h.label).toBe("2 HOSTS OFFLINE");
    expect(h.detail).toBe("0/2 hosts live · 0 stuck · 0 dead");
  });

  it("multi-host: live count reflects only the live nodes", () => {
    const h = fleetHero(
      [node({ host: "a.rozich", status: "live" }), node({ host: "b.rozich", status: "live" })],
      0,
      0,
    );
    expect(h.tone).toBe("go");
    expect(h.detail).toBe("2/2 hosts live · 0 stuck · 0 dead");
  });
});

describe("shortIdFromSessionId / reapCommand — the reap target", () => {
  it("truncates a full CC-UUID to the 8-char hex short id", () => {
    expect(shortIdFromSessionId("97e5c3a1-1234-5678-9abc-def012345678")).toBe(
      "97e5c3a1",
    );
  });

  it("passes an already-short 8-char hex id through", () => {
    expect(shortIdFromSessionId("97e5c3a1")).toBe("97e5c3a1");
  });

  it("lowercases the id (claude stop expects lowercase hex)", () => {
    expect(shortIdFromSessionId("97E5C3A1-1234-5678-9ABC-DEF012345678")).toBe(
      "97e5c3a1",
    );
  });

  it("returns null (NOT a fabricated id) for empty / null / malformed input", () => {
    expect(shortIdFromSessionId(null)).toBeNull();
    expect(shortIdFromSessionId(undefined)).toBeNull();
    expect(shortIdFromSessionId("")).toBeNull();
    expect(shortIdFromSessionId("not-a-uuid")).toBeNull();
    expect(shortIdFromSessionId("zzzzzzzz")).toBeNull();
  });

  it("reapCommand builds the exact `claude stop <shortId>` string", () => {
    expect(reapCommand("97e5c3a1-1234-5678-9abc-def012345678")).toBe(
      "claude stop 97e5c3a1",
    );
  });

  it("reapCommand returns null when no honest shortId exists (caller omits the hint)", () => {
    expect(reapCommand(null)).toBeNull();
    expect(reapCommand("garbage")).toBeNull();
  });
});

describe("reapList — the stuck/dead/silent reap rows (P2)", () => {
  function w(over: Partial<ReapWorkerInput>): ReapWorkerInput {
    return {
      name: "catalyst-CTL-1",
      ticket: "CTL-1",
      phase: "implement",
      activeState: "active",
      working: true,
      lastActiveMs: 1000,
      host: { name: "RyansMini250233.rozich", id: "h1" },
      sessionId: "97e5c3a1-1234-5678-9abc-def012345678",
      ...over,
    };
  }

  it("is EMPTY when there are no workers (the live ground-truth zero)", () => {
    expect(reapList([])).toEqual([]);
  });

  it("is EMPTY when every worker is healthy active (0 stuck/dead → nothing to reap)", () => {
    expect(reapList([w({ activeState: "active", working: true })])).toEqual([]);
  });

  it("includes a dead worker with reason 'dead' and the inline reap command", () => {
    const rows = reapList([w({ ticket: "CTL-696", activeState: "dead" })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe("dead");
    expect(rows[0]!.ticket).toBe("CTL-696");
    expect(rows[0]!.reapCommand).toBe("claude stop 97e5c3a1");
    expect(rows[0]!.host).toBe("RyansMini250233"); // .rozich stripped
  });

  it("includes a stuck worker with reason 'stuck'", () => {
    const rows = reapList([w({ activeState: "stuck" })]);
    expect(rows[0]!.reason).toBe("stuck");
  });

  it("includes a running-with-silence worker (working=false, quiet past the stall threshold)", () => {
    const rows = reapList([
      w({ activeState: null, working: false, lastActiveMs: SILENCE_STALL_MS + 1 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe("silent");
  });

  it("EXCLUDES a quiet worker that has NOT yet crossed the silence stall threshold", () => {
    const rows = reapList([
      w({ activeState: null, working: false, lastActiveMs: SILENCE_STALL_MS - 1 }),
    ]);
    expect(rows).toEqual([]);
  });

  it("EXCLUDES a quiet worker with no honest lastActiveMs (never fabricated stall)", () => {
    const rows = reapList([w({ activeState: null, working: false, lastActiveMs: null })]);
    expect(rows).toEqual([]);
  });

  it("emits a null reapCommand (caller omits the hint) when the sessionId is missing", () => {
    const rows = reapList([w({ activeState: "dead", sessionId: undefined })]);
    expect(rows[0]!.reapCommand).toBeNull();
  });

  it("sorts worst-first: dead before stuck before silent", () => {
    const rows = reapList([
      w({ name: "a", activeState: null, working: false, lastActiveMs: SILENCE_STALL_MS + 5 }),
      w({ name: "b", activeState: "stuck" }),
      w({ name: "c", activeState: "dead" }),
    ]);
    expect(rows.map((r) => r.reason)).toEqual(["dead", "stuck", "silent"]);
  });

  it("within a reason, sorts longest-idle first", () => {
    const rows = reapList([
      w({ name: "a", activeState: "dead", lastActiveMs: 1000 }),
      w({ name: "b", activeState: "dead", lastActiveMs: 9000 }),
    ]);
    expect(rows.map((r) => r.name)).toEqual(["b", "a"]);
  });
});

describe("hostWorkerCount / shortHostName / nodeStatusVar — host-matrix helpers", () => {
  it("counts only non-dead workers on the matching host", () => {
    const workers = [
      { activeState: "active" as const, host: { name: "mini.rozich", id: "1" } },
      { activeState: "stuck" as const, host: { name: "mini.rozich", id: "1" } },
      { activeState: "dead" as const, host: { name: "mini.rozich", id: "1" } }, // excluded
      { activeState: "active" as const, host: { name: "other.rozich", id: "2" } }, // other host
    ];
    expect(hostWorkerCount(workers, "mini.rozich")).toBe(2);
  });

  it("is 0 when no worker is on the host (the live single-host idle case)", () => {
    expect(hostWorkerCount([], "mini.rozich")).toBe(0);
  });

  it("strips the .rozich suffix for the short host name", () => {
    expect(shortHostName("RyansMini250233.rozich")).toBe("RyansMini250233");
    expect(shortHostName("bare-host")).toBe("bare-host");
  });

  it("maps node status to its status color var (green/amber/red)", () => {
    expect(nodeStatusVar("live")).toBe("var(--chart-2)");
    expect(nodeStatusVar("degraded")).toBe("var(--chart-3)");
    expect(nodeStatusVar("offline")).toBe("var(--chart-4)");
  });
});

describe("daemonCell — admission-aware Daemon cell (CTL-1322)", () => {
  it("a live node accepting work reads 'live' (green), no title", () => {
    const cell = daemonCell(node({ status: "live", accepting: true, holdReason: null }));
    expect(cell.label).toBe("live");
    expect(cell.color).toBe("var(--chart-2)");
    expect(cell.title).toBeUndefined();
  });

  it("a live-but-holding node reads 'holding (<reason>)' in amber — the blind spot", () => {
    const drain = daemonCell(node({ status: "live", accepting: false, holdReason: "drain" }));
    expect(drain.label).toBe("holding (drain)");
    expect(drain.color).toBe("var(--chart-3)"); // amber/warn, NOT red
    expect(drain.title).toContain("not accepting");
    const cold = daemonCell(node({ status: "live", accepting: false, holdReason: "liveness-cold" }));
    expect(cold.label).toBe("holding (liveness-cold)");
  });

  it("holding with no reason falls back to bare 'holding'", () => {
    const cell = daemonCell(node({ status: "live", accepting: false, holdReason: null }));
    expect(cell.label).toBe("holding");
  });

  it("offline ALWAYS wins — a dead daemon is 'OFFLINE', never 'holding'", () => {
    const cell = daemonCell(node({ status: "offline", accepting: false, holdReason: "drain" }));
    expect(cell.label).toBe("OFFLINE");
    expect(cell.color).toBe("var(--chart-4)");
  });

  it("absent accepting (remote peer / unknown) → plain liveness word, never a false hold", () => {
    expect(daemonCell(node({ status: "live" })).label).toBe("live");
    expect(daemonCell(node({ status: "degraded" })).label).toBe("degraded");
  });

  it("a degraded node holding work shows the liveness word 'degraded' (liveness wins, matches footer)", () => {
    const cell = daemonCell(node({ status: "degraded", accepting: false, holdReason: "drain" }));
    expect(cell.label).toBe("degraded");
    expect(cell.color).toBe("var(--chart-3)"); // degraded is amber too, but it's the liveness word
    expect(cell.title).toBeUndefined();
  });
});
