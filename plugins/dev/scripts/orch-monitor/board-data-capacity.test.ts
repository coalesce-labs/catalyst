// CTL-764 Phase 7: unit tests for triage carve-out in deriveCapacity +
// deriveStatusCounts. All functions are PURE so tests need no filesystem.

import { describe, it, expect } from "bun:test";

const { deriveCapacity, deriveStatusCounts, synthesizeQueuedTicket, synthesizeOrphanTickets } =
  await import("./lib/board-data.mjs");

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

  // CTL764-VER-3: deriveAttention folds the needs-input label into
  // attention:'needs-human', so a needs-input ticket must be split back out by its
  // label BEFORE the needs-human short-circuit — else it is miscounted as needsHuman.
  it("a needs-input label (folded to attention='needs-human') counts as needsInput, not needsHuman", () => {
    // Mirrors what deriveAttention produces for a needs-input queued card.
    const t = ticket("CTL-8", { labels: ["needs-input"], attention: "needs-human" });
    const r = deriveStatusCounts([t], new Set());
    expect(r.needsInput).toBe(1);
    expect(r.needsHuman).toBe(0);
  });

  it("needs-human wins over needs-input when BOTH labels present (precedence)", () => {
    const t = ticket("CTL-9", {
      labels: ["needs-input", "needs-human"],
      attention: "needs-human",
    });
    const r = deriveStatusCounts([t], new Set());
    expect(r.needsHuman).toBe(1);
    expect(r.needsInput).toBe(0);
  });
});

// ── Integration: the REAL synthesizeQueuedTicket → deriveStatusCounts path ──────
// CTL764-VER-2 / VER-3: the earlier green tests hand-built ticket fixtures with a
// `.labels` key, masking the bug that the actual queued deck (synthesizeQueuedTicket)
// sets workerStatus:null and stashed its blocked/queued determination on `.held`
// (with no `.labels`), so the buckets counted ~0. This exercises the production
// synthesizer so a regression in either the synthesizer or the counter is caught.
describe("deriveStatusCounts over the real synthesizeQueuedTicket deck (CTL764-VER-2/3)", () => {
  function synth(id: string, labels: string[]) {
    // e = eligible entry (id is the only required field); linfo carries the labels.
    return synthesizeQueuedTicket({ id }, { [id]: { labels } });
  }

  it("a blocked queued card lands in the blocked bucket (not 0)", () => {
    const deck = [synth("CTL-100", ["blocked"])];
    const r = deriveStatusCounts(deck, new Set());
    expect(r.blocked).toBe(1);
    expect(r.queued).toBe(0);
  });

  it("a queued card lands in the queued bucket (not 0)", () => {
    const deck = [synth("CTL-101", ["queued"])];
    const r = deriveStatusCounts(deck, new Set());
    expect(r.queued).toBe(1);
    expect(r.blocked).toBe(0);
  });

  it("a needs-input queued card lands in needsInput, not needsHuman", () => {
    const deck = [synth("CTL-102", ["needs-input"])];
    const r = deriveStatusCounts(deck, new Set());
    expect(r.needsInput).toBe(1);
    expect(r.needsHuman).toBe(0);
  });

  it("a mixed deck tallies each disposition (the Phase-8 capacity badges)", () => {
    const deck = [
      synth("CTL-200", ["blocked"]),
      synth("CTL-201", ["blocked"]),
      synth("CTL-202", ["queued"]),
      synth("CTL-203", ["needs-input"]),
    ];
    const r = deriveStatusCounts(deck, new Set());
    expect(r).toEqual({ queued: 1, blocked: 2, needsInput: 1, needsHuman: 0 });
  });
});

// ── Codex finding 4: orphan-PR cards excluded from deriveStatusCounts ──────────
// synthesizeOrphanTickets documents its cards as having "no capacity/queue impact"
// (board-data.mjs ~2234), but they carry attention:"needs-human" like a real
// escalation, so deriveStatusCounts must skip type:"orphan-pr" explicitly or they
// inflate the needsHuman count the deck/badges derive from.
describe("deriveStatusCounts — orphan-PR cards excluded (Codex finding 4)", () => {
  it("a synthesized orphan-PR card does NOT inflate needsHuman", () => {
    const orphanState = {
      "catalyst#123": {
        repo: "catalyst",
        number: 123,
        title: "Orphan PR",
        notifiedAt: "2026-07-01T00:00:00Z",
        firstSeenAt: "2026-07-01T00:00:00Z",
        mergeStateStatus: "DIRTY",
      },
    };
    const orphanTickets = synthesizeOrphanTickets(orphanState, Date.now());
    expect(orphanTickets).toHaveLength(1);
    expect(orphanTickets[0].type).toBe("orphan-pr");
    expect(orphanTickets[0].attention).toBe("needs-human");

    const r = deriveStatusCounts(orphanTickets, new Set());
    expect(r.needsHuman).toBe(0);
  });

  it("a real needs-human ticket alongside an orphan-PR card: only the real one counts", () => {
    const realTicket = { id: "CTL-300", labels: [], attention: "needs-human", workerStatus: null };
    const orphanState = {
      "catalyst#124": {
        repo: "catalyst",
        number: 124,
        title: "Another orphan PR",
        notifiedAt: "2026-07-01T00:00:00Z",
      },
    };
    const orphanTickets = synthesizeOrphanTickets(orphanState, Date.now());
    const r = deriveStatusCounts([realTicket, ...orphanTickets], new Set());
    expect(r.needsHuman).toBe(1);
  });
});
