// queue-worker-grouping.test.ts — units for the CTL-947 in-flight worker
// activity-state grouping. Pure logic, no DOM — run from the ui package:
//   cd ui && bun test src/board/queue-worker-grouping.test.ts
//
// Scenarios:
//   • all-active fleet → single "active" group, no group headers needed
//   • mixed fleet → groups appear in display order (active→wou→waiting→stuck→blocked)
//   • blocked group always last even when it has the longest runtimeMs
//   • within a group workers are ordered by runtimeMs desc (longest-running first)
//   • empty input → zero sections
//   • waitingOnUser drives its own group regardless of activeState
import { describe, it, expect } from "bun:test";
import type { BoardWorker } from "./types";
import {
  groupWorkersByActivity,
  WORKER_GROUP_LABEL,
  type WorkerActivitySection,
} from "./queue-worker-grouping";

// Minimal worker fixture — only the fields the grouper reads.
function w(
  partial: Partial<BoardWorker> & { name: string; ticket: string },
): BoardWorker {
  return {
    tickets: [partial.ticket],
    phase: "implement",
    status: "running",
    activeState: "active",
    working: true,
    lastActiveMs: 100,
    repo: "catalyst",
    team: "CTL",
    runtimeMs: 1000,
    costUSD: null,
    ...partial,
  };
}

const noHeld: Record<string, "blocked" | "waiting" | null | undefined> = {};

// ── basic grouping ───────────────────────────────────────────────────────────

describe("groupWorkersByActivity — basic grouping", () => {
  it("empty workers → zero sections", () => {
    expect(groupWorkersByActivity([], noHeld)).toEqual([]);
  });

  it("all-active fleet → single 'active' section", () => {
    const workers = [
      w({ name: "w1", ticket: "CTL-1", activeState: "active" }),
      w({ name: "w2", ticket: "CTL-2", activeState: "active" }),
    ];
    const sections = groupWorkersByActivity(workers, noHeld);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.group).toBe("active");
    expect(sections[0]?.label).toBe(WORKER_GROUP_LABEL.active);
    expect(sections[0]?.workers).toHaveLength(2);
  });

  it("stuck + active → two sections in display order: active first, stuck last", () => {
    const workers = [
      w({ name: "stuck", ticket: "CTL-1", activeState: "stuck" }),
      w({ name: "live", ticket: "CTL-2", activeState: "active" }),
    ];
    const sections = groupWorkersByActivity(workers, noHeld);
    expect(sections.map((s) => s.group)).toEqual(["active", "stuck"]);
  });

  it("idle (null activeState) → 'waiting' group between active and stuck", () => {
    const workers = [
      w({ name: "idle", ticket: "CTL-1", activeState: null }),
    ];
    const sections = groupWorkersByActivity(workers, noHeld);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.group).toBe("waiting");
  });

  it("full mix → groups in canonical order: active→wou→waiting→stuck→blocked", () => {
    const held: Record<string, "blocked" | "waiting" | null> = {
      "CTL-5": "blocked",
    };
    const workers = [
      w({ name: "stuck-w", ticket: "CTL-4", activeState: "stuck" }),
      w({ name: "wou-w", ticket: "CTL-2", activeState: "active", waitingOnUser: true }),
      w({ name: "idle-w", ticket: "CTL-3", activeState: null }),
      w({ name: "active-w", ticket: "CTL-1", activeState: "active", waitingOnUser: false }),
      w({ name: "blocked-w", ticket: "CTL-5", activeState: null }),
    ];
    const sections = groupWorkersByActivity(workers, held);
    expect(sections.map((s) => s.group)).toEqual([
      "active",
      "waiting-on-user",
      "waiting",
      "stuck",
      "blocked",
    ]);
  });
});

// ── blocked group always last ────────────────────────────────────────────────

describe("groupWorkersByActivity — blocked group is always last", () => {
  it("blocked with the longest runtimeMs still appears last", () => {
    const held: Record<string, "blocked" | "waiting" | null> = {
      "CTL-1": "blocked",
    };
    const workers = [
      // blocked worker has the longest runtime
      w({ name: "blocked-w", ticket: "CTL-1", activeState: null, runtimeMs: 99999 }),
      w({ name: "active-w", ticket: "CTL-2", activeState: "active", runtimeMs: 1 }),
    ];
    const sections = groupWorkersByActivity(workers, held);
    expect(sections[0]?.group).toBe("active");
    expect(sections.at(-1)?.group).toBe("blocked");
  });

  it("blocked worker names the blockers (ticket held lookup passed through)", () => {
    // The grouper itself doesn't attach blockers — that's the view's job. But the
    // group key should be "blocked" when the ticket is held === "blocked".
    const held: Record<string, "blocked" | "waiting" | null> = {
      "CTL-X": "blocked",
    };
    const workers = [w({ name: "w1", ticket: "CTL-X", activeState: "active" })];
    const sections = groupWorkersByActivity(workers, held);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.group).toBe("blocked");
  });
});

// ── within-group ordering by runtimeMs desc ─────────────────────────────────

describe("groupWorkersByActivity — within-group runtimeMs desc ordering", () => {
  it("active workers sorted by runtimeMs descending within the group", () => {
    const workers = [
      w({ name: "short", ticket: "CTL-1", activeState: "active", runtimeMs: 100 }),
      w({ name: "long", ticket: "CTL-2", activeState: "active", runtimeMs: 9000 }),
      w({ name: "mid", ticket: "CTL-3", activeState: "active", runtimeMs: 500 }),
    ];
    const sections = groupWorkersByActivity(workers, noHeld);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.workers.map((x) => x.runtimeMs)).toEqual([9000, 500, 100]);
  });

  it("stuck workers sorted by runtimeMs descending within the stuck group", () => {
    const workers = [
      w({ name: "s1", ticket: "CTL-1", activeState: "stuck", runtimeMs: 200 }),
      w({ name: "s2", ticket: "CTL-2", activeState: "stuck", runtimeMs: 800 }),
    ];
    const sections = groupWorkersByActivity(workers, noHeld);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.group).toBe("stuck");
    expect(sections[0]?.workers.map((x) => x.runtimeMs)).toEqual([800, 200]);
  });
});

// ── waitingOnUser classification ─────────────────────────────────────────────

describe("groupWorkersByActivity — waitingOnUser", () => {
  it("waitingOnUser=true → 'waiting-on-user' group even when activeState='active'", () => {
    const workers = [
      w({ name: "wou", ticket: "CTL-1", activeState: "active", waitingOnUser: true }),
    ];
    const sections = groupWorkersByActivity(workers, noHeld);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.group).toBe("waiting-on-user");
  });

  it("waitingOnUser=false → not in waiting-on-user group", () => {
    const workers = [
      w({ name: "live", ticket: "CTL-1", activeState: "active", waitingOnUser: false }),
    ];
    const sections = groupWorkersByActivity(workers, noHeld);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.group).toBe("active");
  });

  it("waiting-on-user appears BEFORE waiting (idle) and AFTER active", () => {
    const workers = [
      w({ name: "idle", ticket: "CTL-1", activeState: null }),
      w({ name: "wou", ticket: "CTL-2", activeState: "active", waitingOnUser: true }),
      w({ name: "active", ticket: "CTL-3", activeState: "active" }),
    ];
    const sections = groupWorkersByActivity(workers, noHeld);
    expect(sections.map((s) => s.group)).toEqual(["active", "waiting-on-user", "waiting"]);
  });

  it("blocked overrides waitingOnUser (ticket held=blocked wins over worker waitingOnUser)", () => {
    const held: Record<string, "blocked" | "waiting" | null> = {
      "CTL-1": "blocked",
    };
    const workers = [
      w({ name: "wou-blocked", ticket: "CTL-1", activeState: "active", waitingOnUser: true }),
    ];
    const sections = groupWorkersByActivity(workers, held);
    // ticket-level blocked wins — the worker lands in the blocked group
    expect(sections[0]?.group).toBe("blocked");
  });
});

// ── dead group (CTL-978) ─────────────────────────────────────────────────────

describe("groupWorkersByActivity — dead workers (CTL-978)", () => {
  it("dead worker → 'dead' group, not 'waiting' or any in-flight group", () => {
    const workers = [
      w({ name: "d1", ticket: "CTL-1", activeState: "dead" }),
    ];
    const sections = groupWorkersByActivity(workers, noHeld);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.group).toBe("dead");
  });

  it("dead worker is excluded from in-flight count (live workers only)", () => {
    const workers = [
      w({ name: "live-w", ticket: "CTL-1", activeState: "active" }),
      w({ name: "dead-w", ticket: "CTL-2", activeState: "dead" }),
    ];
    const sections = groupWorkersByActivity(workers, noHeld);
    // two sections: active + dead
    expect(sections.map((s) => s.group)).toEqual(["active", "dead"]);
    // in-flight count = only live workers (activeState !== "dead")
    const liveCount = workers.filter((wk) => wk.activeState !== "dead").length;
    const inflightSectionWorkers = sections
      .filter((s) => s.group !== "dead")
      .flatMap((s) => s.workers);
    expect(inflightSectionWorkers).toHaveLength(liveCount);
    expect(inflightSectionWorkers.every((wk) => wk.activeState !== "dead")).toBe(true);
  });

  it("dead group appears after blocked (rank 5 > rank 4)", () => {
    const held: Record<string, "blocked" | "waiting" | null> = {
      "CTL-2": "blocked",
    };
    const workers = [
      w({ name: "dead-w", ticket: "CTL-1", activeState: "dead", runtimeMs: 9999 }),
      w({ name: "blocked-w", ticket: "CTL-2", activeState: null }),
      w({ name: "active-w", ticket: "CTL-3", activeState: "active" }),
    ];
    const sections = groupWorkersByActivity(workers, held);
    const groups = sections.map((s) => s.group);
    // dead must come after blocked
    const deadIdx = groups.indexOf("dead");
    const blockedIdx = groups.indexOf("blocked");
    expect(deadIdx).toBeGreaterThan(blockedIdx);
    // dead is last
    expect(groups.at(-1)).toBe("dead");
  });

  it("dead worker with longest runtimeMs still lands in dead group (not active)", () => {
    const workers = [
      w({ name: "dead-fast", ticket: "CTL-1", activeState: "dead", runtimeMs: 99999 }),
      w({ name: "active-slow", ticket: "CTL-2", activeState: "active", runtimeMs: 1 }),
    ];
    const sections = groupWorkersByActivity(workers, noHeld);
    expect(sections[0]?.group).toBe("active");
    expect(sections.at(-1)?.group).toBe("dead");
    // active section has only the live worker
    expect(sections[0]?.workers[0]?.name).toBe("active-slow");
    // dead section has the dead worker
    expect(sections.at(-1)?.workers[0]?.name).toBe("dead-fast");
  });

  it("all-dead fleet → single 'dead' section", () => {
    const workers = [
      w({ name: "d1", ticket: "CTL-1", activeState: "dead" }),
      w({ name: "d2", ticket: "CTL-2", activeState: "dead" }),
      w({ name: "d3", ticket: "CTL-3", activeState: "dead" }),
    ];
    const sections = groupWorkersByActivity(workers, noHeld);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.group).toBe("dead");
    expect(sections[0]?.workers).toHaveLength(3);
  });

  it("dead section label is 'Dead / stale'", () => {
    expect(WORKER_GROUP_LABEL.dead).toBe("Dead / stale");
  });
});

// ── labels ───────────────────────────────────────────────────────────────────

describe("WORKER_GROUP_LABEL — human-readable group labels", () => {
  it("all groups have a non-empty label", () => {
    const labels = Object.values(WORKER_GROUP_LABEL);
    expect(labels.every((l) => l.length > 0)).toBe(true);
  });
  it("'waiting-on-user' label is 'Waiting on you'", () => {
    expect(WORKER_GROUP_LABEL["waiting-on-user"]).toBe("Waiting on you");
  });
  it("'blocked' label is 'Blocked'", () => {
    expect(WORKER_GROUP_LABEL.blocked).toBe("Blocked");
  });
});

// ── no drops or dups ─────────────────────────────────────────────────────────

describe("groupWorkersByActivity — invariants", () => {
  it("every input worker appears in exactly one section (no drops, no dups)", () => {
    const held: Record<string, "blocked" | "waiting" | null> = { "CTL-5": "blocked" };
    const workers = [
      w({ name: "a", ticket: "CTL-1", activeState: "active" }),
      w({ name: "b", ticket: "CTL-2", activeState: "active", waitingOnUser: true }),
      w({ name: "c", ticket: "CTL-3", activeState: null }),
      w({ name: "d", ticket: "CTL-4", activeState: "stuck" }),
      w({ name: "e", ticket: "CTL-5", activeState: null }),
    ];
    const sections = groupWorkersByActivity(workers, held);
    const flat = sections.flatMap((s) => s.workers.map((x) => x.name)).sort();
    expect(flat).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("dead workers are in exactly one section and not duplicated in live sections", () => {
    const held: Record<string, "blocked" | "waiting" | null> = { "CTL-5": "blocked" };
    const workers = [
      w({ name: "a", ticket: "CTL-1", activeState: "active" }),
      w({ name: "b", ticket: "CTL-2", activeState: null }),
      w({ name: "c", ticket: "CTL-3", activeState: "stuck" }),
      w({ name: "d", ticket: "CTL-4", activeState: "dead" }),
      w({ name: "e", ticket: "CTL-5", activeState: null }),
      w({ name: "f", ticket: "CTL-6", activeState: "dead" }),
    ];
    const sections = groupWorkersByActivity(workers, held);
    const flat = sections.flatMap((s) => s.workers.map((x) => x.name)).sort();
    // all 6 workers present exactly once
    expect(flat).toEqual(["a", "b", "c", "d", "e", "f"]);
    // dead section holds exactly the dead workers
    const deadSection = sections.find((s) => s.group === "dead");
    expect(deadSection?.workers.map((x) => x.name).sort()).toEqual(["d", "f"]);
    // no live section contains a dead worker
    const liveWorkers = sections
      .filter((s) => s.group !== "dead")
      .flatMap((s) => s.workers);
    expect(liveWorkers.every((wk) => wk.activeState !== "dead")).toBe(true);
  });
});
