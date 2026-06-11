// home-inbox-attention.test.ts — units for the CTL-729 "Needs you" inbox section
// (operator-approved 2026-06-11). The single needs-attention bucket (waiting-on-you
// + needs-human escalations) surfaces at the HEAD of the inbox as a "Needs you"
// section, verb "Respond", folded into the NEEDS_YOU absorption so counts.needsYou,
// the all-clear gate, and the calm header sentence all account for it automatically.
//
// classifyTicket precedence: done → attention → blocked → waiting → running.
// rowDurationAnchor for an attention row → ticket.attentionSince ?? heldSince.
import { describe, it, expect } from "bun:test";
import {
  deriveInbox,
  classifyTicket,
  calmHeaderSentence,
  isNeedsYouSection,
  isAllClear,
  rowDurationAnchor,
  type InboxRow,
} from "../ui/src/board/home-inbox";
import type { BoardPayload, BoardTicket } from "../ui/src/board/types";

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
    attention: null,
    attentionSince: null,
    ...over,
  };
}

function mkPayload(tickets: BoardTicket[]): BoardPayload {
  return {
    generatedAt: "2026-06-11T00:00:00Z",
    config: { maxParallel: 0, inFlight: 0, freeSlots: 0, active: 0, working: 0, stuck: 0 },
    repos: ["catalyst"],
    workers: [],
    tickets,
    queue: [],
  };
}

describe("classifyTicket — attention is the new top needs-you case (CTL-729)", () => {
  it("an attention=waiting-on-you ticket lands in 'attention'", () => {
    expect(classifyTicket(mkTicket("CTL-729", { attention: "waiting-on-you" }))).toBe("attention");
  });
  it("an attention=needs-human ticket lands in 'attention'", () => {
    expect(classifyTicket(mkTicket("CTL-729", { attention: "needs-human" }))).toBe("attention");
  });
  it("attention beats a held blocked/waiting label (operator action outranks admission gate)", () => {
    expect(classifyTicket(mkTicket("CTL-729", { attention: "needs-human", held: "blocked" }))).toBe(
      "attention",
    );
    expect(classifyTicket(mkTicket("CTL-730", { attention: "waiting-on-you", held: "waiting" }))).toBe(
      "attention",
    );
  });
  it("done STILL wins over attention (a finished ticket needs nothing, even with a stale flag)", () => {
    expect(
      classifyTicket(mkTicket("CTL-729", { status: "done", attention: "needs-human" })),
    ).toBe("done");
    expect(
      classifyTicket(mkTicket("CTL-730", { linearState: "Done", attention: "waiting-on-you" })),
    ).toBe("done");
  });
  it("attention null falls through to the existing held/running classification", () => {
    expect(classifyTicket(mkTicket("CTL-867", { attention: null, held: "blocked" }))).toBe("blocked");
    expect(classifyTicket(mkTicket("CTL-900", { attention: null, held: null }))).toBe("running");
  });
});

describe("deriveInbox — the 'Needs you' attention section at the HEAD (CTL-729)", () => {
  const tickets = [
    mkTicket("CTL-900", { held: null }), // running
    mkTicket("CTL-867", { held: "blocked", blockers: ["CTL-866"] }), // blocked
    mkTicket("CTL-729", { attention: "waiting-on-you" }), // needs you (attention)
    mkTicket("CTL-880", { status: "done", linearState: "Done" }), // done
    mkTicket("CTL-642", { held: "waiting" }), // waiting
    mkTicket("CTL-731", { attention: "needs-human" }), // needs you (attention)
  ];
  const model = deriveInbox(mkPayload(tickets));

  it("renders sections in fixed order attention → blocked → waiting → running → done", () => {
    expect(model.sections.map((s) => s.kind)).toEqual([
      "attention",
      "blocked",
      "waiting",
      "running",
      "done",
    ]);
  });

  it("the attention section is labeled 'Needs you' with verb 'Respond'", () => {
    const attention = model.sections.find((s) => s.kind === "attention")!;
    expect(attention.label).toBe("Needs you");
    expect(attention.rows.every((r) => r.verb === "Respond")).toBe(true);
  });

  it("the attention sub-label names WHY (the operator-approved small sub-text)", () => {
    const waiting = model.order.find((r) => r.id === "CTL-729")!;
    const escalated = model.order.find((r) => r.id === "CTL-731")!;
    expect(waiting.subLabel).toBe("waiting on your answer");
    expect(escalated.subLabel).toBe("escalated — needs human");
  });

  it("attention rows lead the flat walk order (most-urgent first)", () => {
    expect(model.order.map((r) => r.id)).toEqual([
      "CTL-729", // attention (payload order preserved within section)
      "CTL-731", // attention
      "CTL-867", // blocked
      "CTL-642", // waiting
      "CTL-900", // running
      "CTL-880", // done
    ]);
    expect(model.defaultSelectedId).toBe("CTL-729");
  });

  it("attention is a needs-you section and is absorbed into counts.needsYou", () => {
    expect(isNeedsYouSection("attention")).toBe(true);
    expect(model.counts.attention).toBe(2);
    // needsYou = attention(2) + blocked(1) + waiting(1) = 4
    expect(model.counts.needsYou).toBe(4);
  });
});

describe("isAllClear — attention breaks the all-clear gate (CTL-729)", () => {
  it("an attention item alone keeps the inbox NOT all-clear", () => {
    const m = deriveInbox(mkPayload([mkTicket("CTL-729", { attention: "needs-human" })]));
    expect(isAllClear(m.counts)).toBe(false);
  });
  it("only running/done (no attention/held) is all-clear", () => {
    const m = deriveInbox(
      mkPayload([
        mkTicket("CTL-900", { held: null, attention: null }),
        mkTicket("CTL-880", { status: "done", linearState: "Done" }),
      ]),
    );
    expect(isAllClear(m.counts)).toBe(true);
  });
});

describe("calmHeaderSentence — attention folds into the 'need you' clause (CTL-729)", () => {
  it("counts an attention item in the 'need you' figure", () => {
    const m = deriveInbox(
      mkPayload([
        mkTicket("CTL-900", { held: null }),
        mkTicket("CTL-901", { held: null }),
        mkTicket("CTL-729", { attention: "needs-human" }),
      ]),
    );
    const s = calmHeaderSentence(m.counts);
    expect(s).toBe("2 running on their own · 1 needs you · nothing on fire");
  });
});

describe("rowDurationAnchor — attention rows anchor to attentionSince ?? heldSince (CTL-729)", () => {
  function mkRow(over: Partial<BoardTicket>): InboxRow {
    const t = mkTicket("CTL-729", over);
    return {
      id: t.id,
      title: t.title,
      section: "attention",
      subLabel: "x",
      verb: "Respond",
      blockers: [],
      ticket: t,
    };
  }
  it("anchors to attentionSince when present", () => {
    const row = mkRow({ attention: "waiting-on-you", attentionSince: "2026-06-11T08:00:00Z" });
    expect(rowDurationAnchor(row)).toBe("2026-06-11T08:00:00Z");
  });
  it("falls back to heldSince when attentionSince is absent", () => {
    const row = mkRow({ attention: "needs-human", attentionSince: null, heldSince: "2026-06-11T07:00:00Z" });
    expect(rowDurationAnchor(row)).toBe("2026-06-11T07:00:00Z");
  });
  it("is honest null when neither anchor exists", () => {
    const row = mkRow({ attention: "needs-human", attentionSince: null, heldSince: null });
    expect(rowDurationAnchor(row)).toBeNull();
  });
});
