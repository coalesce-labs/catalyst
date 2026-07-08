// CTL-764 Phase 7: unit tests for triage carve-out in deriveCapacity +
// deriveStatusCounts. All functions are PURE so tests need no filesystem.

import { describe, it, expect } from "bun:test";

const { deriveCapacity, deriveStatusCounts } = await import("./lib/board-data.mjs");

// ── deriveCapacity: triage carve-out ──────────────────────────────────────────

describe("deriveCapacity — triage carve-out (CTL-764 Phase 7)", () => {
  function liveWorker(phase: string, extra: object = {}) {
    return { activeState: "active" as const, working: true, phase, ...extra };
  }
  function deadWorker(phase: string) {
    return { activeState: "dead" as const, working: false, phase };
  }

  it("a live triage worker is excluded from inFlight/freeSlots and counted as triage:1", () => {
    const workers = [liveWorker("triage")];
    const r = deriveCapacity(workers, 4);
    expect(r.inFlight).toBe(0);
    expect(r.freeSlots).toBe(4);
    expect(r.triage).toBe(1);
  });

  it("triage never reduces freeSlots (6 implement + 2 triage, maxParallel 6 → inFlight 6, freeSlots 0, triage 2)", () => {
    const workers = [
      ...Array(6)
        .fill(null)
        .map(() => liveWorker("implement")),
      liveWorker("triage"),
      liveWorker("triage"),
    ];
    const r = deriveCapacity(workers, 6);
    expect(r.inFlight).toBe(6);
    expect(r.freeSlots).toBe(0);
    expect(r.triage).toBe(2);
  });

  it("a dead triage worker counts in neither inFlight nor triage", () => {
    const workers = [deadWorker("triage")];
    const r = deriveCapacity(workers, 4);
    expect(r.inFlight).toBe(0);
    expect(r.freeSlots).toBe(4);
    expect(r.triage).toBe(0);
    expect(r.dead).toBe(1);
  });

  it("no triage → triage:0, inFlight/freeSlots unchanged (CTL-928 regression guard)", () => {
    const workers = [liveWorker("implement"), liveWorker("verify")];
    const r = deriveCapacity(workers, 4);
    expect(r.inFlight).toBe(2);
    expect(r.freeSlots).toBe(2);
    expect(r.triage).toBe(0);
  });

  it("existing fields (active, working, stuck, dead) are unaffected by triage carve-out", () => {
    const workers = [
      liveWorker("implement", { activeState: "active", working: true }),
      liveWorker("triage", { activeState: "active", working: false }),
      { activeState: "dead" as const, working: false, phase: "implement" },
    ];
    const r = deriveCapacity(workers, 4);
    expect(r.active).toBe(1);
    expect(r.dead).toBe(1);
    expect(r.triage).toBe(1);
    expect(r.inFlight).toBe(1);
  });
});

// ── deriveStatusCounts ────────────────────────────────────────────────────────

describe("deriveStatusCounts (CTL-764 Phase 7)", () => {
  function ticket(
    id: string,
    opts: {
      labels?: string[];
      attention?: string | null;
      workerStatus?: string | null;
    } = {}
  ) {
    return {
      id,
      labels: opts.labels ?? [],
      attention: opts.attention ?? null,
      workerStatus: opts.workerStatus ?? null,
    };
  }

  it("a needs-human label/attention → needsHuman bucket", () => {
    const t = ticket("CTL-1", { attention: "needs-human" });
    const r = deriveStatusCounts([t], new Set());
    expect(r.needsHuman).toBe(1);
    expect(r.queued).toBe(0);
  });

  it("a blocked label → blocked bucket", () => {
    const t = ticket("CTL-2", { labels: ["blocked"] });
    const r = deriveStatusCounts([t], new Set());
    expect(r.blocked).toBe(1);
    expect(r.queued).toBe(0);
  });

  it("a queued label → queued bucket", () => {
    const t = ticket("CTL-3", { labels: ["queued"] });
    const r = deriveStatusCounts([t], new Set());
    expect(r.queued).toBe(1);
    expect(r.blocked).toBe(0);
  });

  it("legacy 'waiting' label maps to queued via back-compat", () => {
    const t = ticket("CTL-4", { labels: ["waiting"] });
    const r = deriveStatusCounts([t], new Set());
    expect(r.queued).toBe(1);
  });

  it("a ticket owned by a live worker is excluded (no double-count vs deck)", () => {
    const t = ticket("CTL-5", { labels: ["blocked"] });
    const r = deriveStatusCounts([t], new Set(["CTL-5"]));
    expect(r.blocked).toBe(0);
    expect(r.queued).toBe(0);
  });

  it("needs-human wins over blocked when both present (precedence)", () => {
    const t = ticket("CTL-6", { labels: ["blocked"], attention: "needs-human" });
    const r = deriveStatusCounts([t], new Set());
    expect(r.needsHuman).toBe(1);
    expect(r.blocked).toBe(0);
  });

  it("workerStatus='queued' increments queued", () => {
    const t = ticket("CTL-7", { workerStatus: "queued" });
    const r = deriveStatusCounts([t], new Set());
    expect(r.queued).toBe(1);
  });

  it("empty tickets → all buckets zero", () => {
    const r = deriveStatusCounts([], new Set());
    expect(r).toEqual({ queued: 0, blocked: 0, needsInput: 0, needsHuman: 0 });
  });
});
