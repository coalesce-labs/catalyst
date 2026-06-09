// home-inbox.test.ts — units for the calm Inbox home's PURE core (CTL-899 /
// HOME1): the grouping, the flat j/k walk order, the default selection, and the
// calm one-sentence header. Encodes the CTL-899 Gherkin against the React-free
// module ui/src/board/home-inbox.ts (same pattern as list-order.test.ts /
// route-search.test.ts — no React/jotai/router runtime needed).
//
// The load-bearing acceptance criteria these lock in:
//   • "Selecting a row updates the reading pane … top item selected by default"
//     → defaultSelectedId is the head of the flat walk order, and moveSelection
//       walks j/k over that exact order.
//   • "a single calm header sentence summarizing running / needs-you counts"
//     → calmHeaderSentence is ONE sentence (never a KPI grid).
//   • "Inbox data comes from the read-model, never a live Linear call"
//     → deriveInbox takes a BoardPayload and reads only `held` off it (the broker
//       already folded filter-state.db labels into BoardTicket.held); no import
//       of any Linear/network module is even possible from this pure file.
import { describe, it, expect } from "bun:test";
import {
  deriveInbox,
  classifyTicket,
  calmHeaderSentence,
  moveSelection,
  rowById,
  isNeedsYouSection,
  type InboxRow,
} from "../ui/src/board/home-inbox";
import type { BoardPayload, BoardTicket } from "../ui/src/board/types";

// ── minimal fixtures (only the fields the inbox derivation reads) ───────────
function mkTicket(id: string, over: Partial<BoardTicket> = {}): BoardTicket {
  return {
    id,
    title: `${id} title`,
    type: "feature",
    repo: "catalyst",
    team: "CTL",
    phase: "implement",
    status: "active",
    model: null,
    linearState: "Implement",
    workerStatus: null,
    activeState: "active",
    working: true,
    lastActiveMs: null,
    priority: 2,
    estimate: null,
    scope: null,
    project: null,
    costUSD: null,
    tokens: null,
    turns: null,
    phaseCosts: null,
    phaseSummary: [],
    pr: null,
    updatedAt: "",
    held: null,
    blockers: [],
    ...over,
  };
}

function mkPayload(tickets: BoardTicket[]): BoardPayload {
  return {
    generatedAt: "2026-06-09T00:00:00Z",
    config: { maxParallel: 0, inFlight: 0, freeSlots: 0, active: 0, working: 0, stuck: 0 },
    repos: ["catalyst"],
    workers: [],
    tickets,
    queue: [],
  };
}

describe("classifyTicket — the needs-you split (held → section)", () => {
  it("a blocked ticket lands in 'blocked' (the needs-you, Unblock case)", () => {
    expect(classifyTicket(mkTicket("CTL-867", { held: "blocked" }))).toBe("blocked");
  });
  it("a waiting ticket lands in 'waiting' (the needs-you, Answer case)", () => {
    expect(classifyTicket(mkTicket("CTL-642", { held: "waiting" }))).toBe("waiting");
  });
  it("an un-held, not-done ticket is the reassurance set 'running'", () => {
    expect(classifyTicket(mkTicket("CTL-900", { held: null }))).toBe("running");
  });
  it("a done ticket is 'done' EVEN with a stale held label", () => {
    expect(classifyTicket(mkTicket("CTL-880", { status: "done", held: "blocked" }))).toBe("done");
    expect(classifyTicket(mkTicket("CTL-881", { linearState: "Done", held: "waiting" }))).toBe("done");
  });
});

describe("deriveInbox — grouped sections + flat walk order (CTL-899)", () => {
  // A realistic mixed snapshot: 1 blocked, 1 waiting, 2 running, 1 done.
  const tickets = [
    mkTicket("CTL-900", { held: null }), // running
    mkTicket("CTL-867", { held: "blocked", blockers: ["CTL-866"] }), // needs you
    mkTicket("CTL-880", { status: "done", linearState: "Done", held: null }), // done
    mkTicket("CTL-642", { held: "waiting" }), // needs you
    mkTicket("CTL-901", { held: null }), // running
  ];
  const model = deriveInbox(mkPayload(tickets));

  it("renders sections in fixed order blocked → waiting → running → done, dropping empties", () => {
    expect(model.sections.map((s) => s.kind)).toEqual(["blocked", "waiting", "running", "done"]);
  });

  it("drops a section that has no rows (the page only shows what exists)", () => {
    const m = deriveInbox(mkPayload([mkTicket("CTL-900", { held: null })]));
    expect(m.sections.map((s) => s.kind)).toEqual(["running"]);
  });

  it("the flat walk order is needs-you first, then running, then done", () => {
    expect(model.order.map((r) => r.id)).toEqual([
      "CTL-867", // blocked
      "CTL-642", // waiting
      "CTL-900", // running (payload order preserved within section)
      "CTL-901", // running
      "CTL-880", // done
    ]);
  });

  it("preserves the payload's array order WITHIN a section (no re-sort)", () => {
    const running = model.sections.find((s) => s.kind === "running")!;
    expect(running.rows.map((r) => r.id)).toEqual(["CTL-900", "CTL-901"]);
  });

  it("counts blocked/waiting/running/done and the single needsYou figure", () => {
    expect(model.counts).toEqual({
      blocked: 1,
      waiting: 1,
      running: 2,
      done: 1,
      needsYou: 2,
    });
  });

  it("the needs-you rows carry an accent section; running/done are neutral", () => {
    expect(isNeedsYouSection("blocked")).toBe(true);
    expect(isNeedsYouSection("waiting")).toBe(true);
    expect(isNeedsYouSection("running")).toBe(false);
    expect(isNeedsYouSection("done")).toBe(false);
  });

  it("a blocked row names its blocker ids; other rows carry none", () => {
    const blocked = model.order.find((r) => r.id === "CTL-867")!;
    expect(blocked.blockers).toEqual(["CTL-866"]);
    expect(blocked.verb).toBe("Unblock");
    const waiting = model.order.find((r) => r.id === "CTL-642")!;
    expect(waiting.blockers).toEqual([]);
    expect(waiting.verb).toBe("Answer");
    const running = model.order.find((r) => r.id === "CTL-900")!;
    expect(running.verb).toBeNull();
  });

  it("does not mutate the payload's ticket array", () => {
    const ids = tickets.map((t) => t.id);
    deriveInbox(mkPayload(tickets));
    expect(tickets.map((t) => t.id)).toEqual(ids);
  });
});

describe("deriveInbox — default selection (top item selected on load)", () => {
  it("default-selects the most-urgent needs-you row when any exists", () => {
    const m = deriveInbox(
      mkPayload([
        mkTicket("CTL-900", { held: null }),
        mkTicket("CTL-867", { held: "blocked" }),
      ]),
    );
    // blocked sorts ahead of running, so the head of the walk order is CTL-867.
    expect(m.defaultSelectedId).toBe("CTL-867");
    expect(m.order[0].id).toBe("CTL-867");
  });

  it("falls back to the first running row when nothing needs you", () => {
    const m = deriveInbox(
      mkPayload([
        mkTicket("CTL-900", { held: null }),
        mkTicket("CTL-901", { held: null }),
      ]),
    );
    expect(m.defaultSelectedId).toBe("CTL-900");
  });

  it("is null on a wholly empty inbox", () => {
    const m = deriveInbox(mkPayload([]));
    expect(m.defaultSelectedId).toBeNull();
    expect(m.order).toEqual([]);
    expect(m.sections).toEqual([]);
  });
});

describe("moveSelection — j / k walk over the flat order (CTL-899)", () => {
  const order: InboxRow[] = (
    deriveInbox(
      mkPayload([
        mkTicket("CTL-867", { held: "blocked" }),
        mkTicket("CTL-642", { held: "waiting" }),
        mkTicket("CTL-900", { held: null }),
      ]),
    )
  ).order;

  it("j (delta +1) moves the selection down the walk order", () => {
    expect(moveSelection(order, "CTL-867", +1)).toBe("CTL-642");
    expect(moveSelection(order, "CTL-642", +1)).toBe("CTL-900");
  });

  it("k (delta -1) moves the selection up the walk order", () => {
    expect(moveSelection(order, "CTL-900", -1)).toBe("CTL-642");
    expect(moveSelection(order, "CTL-642", -1)).toBe("CTL-867");
  });

  it("clamps at the ends (never wraps)", () => {
    expect(moveSelection(order, "CTL-867", -1)).toBe("CTL-867"); // already top
    expect(moveSelection(order, "CTL-900", +1)).toBe("CTL-900"); // already bottom
  });

  it("a null or stale selection resets to the head", () => {
    expect(moveSelection(order, null, +1)).toBe("CTL-867");
    expect(moveSelection(order, "CTL-vanished", +1)).toBe("CTL-867");
  });

  it("returns null on an empty order (never throws)", () => {
    expect(moveSelection([], "CTL-867", +1)).toBeNull();
  });
});

describe("rowById — the reading pane reads the selected row's full ticket", () => {
  const model = deriveInbox(
    mkPayload([mkTicket("CTL-867", { held: "blocked", title: "registry creds" })]),
  );
  it("returns the row (and its full ticket) for the selected id", () => {
    const row = rowById(model, "CTL-867");
    expect(row?.id).toBe("CTL-867");
    expect(row?.ticket.title).toBe("registry creds");
  });
  it("returns null for a cleared / unknown id", () => {
    expect(rowById(model, null)).toBeNull();
    expect(rowById(model, "CTL-nope")).toBeNull();
  });
});

describe("calmHeaderSentence — ONE sentence, never a KPI grid (CTL-899)", () => {
  it('reads "N running on their own · M need you · …"', () => {
    const s = calmHeaderSentence({ blocked: 0, waiting: 2, running: 4, done: 0, needsYou: 2 });
    expect(s).toBe("4 running on their own · 2 need you · nothing on fire");
    // It is ONE sentence: no newline, no metric-grid separators.
    expect(s).not.toContain("\n");
  });

  it("names the heat when something is genuinely blocked (never lies)", () => {
    const s = calmHeaderSentence({ blocked: 1, waiting: 0, running: 6, done: 3, needsYou: 1 });
    expect(s).toBe("6 running on their own · 1 needs you · 1 blocked");
  });

  it("drops the needs-you clause when nothing needs you", () => {
    const s = calmHeaderSentence({ blocked: 0, waiting: 0, running: 5, done: 0, needsYou: 0 });
    expect(s).toBe("5 running on their own · nothing on fire");
  });

  it("uses singular grammar for one running ticket", () => {
    const s = calmHeaderSentence({ blocked: 0, waiting: 0, running: 1, done: 0, needsYou: 0 });
    expect(s).toBe("1 running on its own · nothing on fire");
  });

  it("collapses to the celebratory empty-state line when the inbox is empty", () => {
    const s = calmHeaderSentence({ blocked: 0, waiting: 0, running: 0, done: 0, needsYou: 0 });
    expect(s).toBe("All clear — nothing needs you right now.");
  });
});
