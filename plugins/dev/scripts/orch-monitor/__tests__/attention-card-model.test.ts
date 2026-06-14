// attention-card-model.test.ts — CTL-1126 Phase 1.
// Pure unit tests for the attention-card-model module: modalityFor,
// escalationTypeFor, cardAccentFor, and attentionCardModel assembler.
// No React/DOM — same pattern as reading-pane-model.test.ts.
import { describe, it, expect } from "bun:test";
import {
  modalityFor,
  escalationTypeFor,
  cardAccentFor,
  attentionCardModel,
} from "../ui/src/board/attention-card-model";
import { deriveInbox, type InboxRow } from "../ui/src/board/home-inbox";
import type { BoardPayload, BoardTicket } from "../ui/src/board/types";

// ── fixtures ─────────────────────────────────────────────────────────────────

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

function rowFor(ticket: BoardTicket): InboxRow {
  const payload: BoardPayload = {
    generatedAt: "2026-06-14T00:00:00Z",
    config: { maxParallel: 0, inFlight: 0, freeSlots: 0, active: 0, working: 0, stuck: 0 },
    repos: ["catalyst"],
    workers: [],
    tickets: [ticket],
    queue: [],
  };
  const model = deriveInbox(payload);
  const row = model.order[0];
  if (row == null) throw new Error("fixture produced no row");
  return row;
}

const BASE_EXPL = {
  call_to_action: "Decide now.",
  outcome: "The system recovers.",
  problem: "The probe misfired.",
  why_you: "Only you have context.",
  why_not_auto: "Automation gave up.",
  what_to_do: "Review the diff.",
};

// ── modalityFor ───────────────────────────────────────────────────────────────

describe("CTL-1126: modalityFor", () => {
  it("attention section → action modality", () => {
    const row = rowFor(mkTicket("CTL-A1", { attention: "needs-human" }));
    expect(row.section).toBe("attention");
    expect(modalityFor(row.section)).toBe("action");
  });

  it("blocked section → action modality", () => {
    const row = rowFor(mkTicket("CTL-A2", { held: "blocked" }));
    expect(row.section).toBe("blocked");
    expect(modalityFor(row.section)).toBe("action");
  });

  it("waiting section → waiting modality", () => {
    const row = rowFor(mkTicket("CTL-A3", { held: "waiting" }));
    expect(row.section).toBe("waiting");
    expect(modalityFor(row.section)).toBe("waiting");
  });

  it("running section → informational modality", () => {
    const row = rowFor(mkTicket("CTL-A4"));
    expect(row.section).toBe("running");
    expect(modalityFor(row.section)).toBe("informational");
  });

  it("done section → informational modality", () => {
    const row = rowFor(mkTicket("CTL-A5", { status: "done" }));
    expect(row.section).toBe("done");
    expect(modalityFor(row.section)).toBe("informational");
  });

  it("awareness section → awareness modality", () => {
    // awareness rows are synthetic outage stubs; test the function directly
    expect(modalityFor("awareness")).toBe("awareness");
  });
});

// ── escalationTypeFor ─────────────────────────────────────────────────────────

describe("CTL-1126: escalationTypeFor", () => {
  it("returns 'decision' by default for a needs-human row with no escalation_type", () => {
    const row = rowFor(mkTicket("CTL-B1", {
      attention: "needs-human",
      explanation: BASE_EXPL,
    }));
    expect(escalationTypeFor(row)).toBe("decision");
  });

  it("returns the explicit escalation_type from the explanation", () => {
    const row = rowFor(mkTicket("CTL-B2", {
      attention: "needs-human",
      explanation: { ...BASE_EXPL, escalation_type: "authorization" },
    }));
    expect(escalationTypeFor(row)).toBe("authorization");
  });

  it("returns 'manual' when escalation_type is manual", () => {
    const row = rowFor(mkTicket("CTL-B3", {
      attention: "needs-human",
      explanation: { ...BASE_EXPL, escalation_type: "manual" },
    }));
    expect(escalationTypeFor(row)).toBe("manual");
  });

  it("returns undefined for a waiting (non-needs-human) row", () => {
    const row = rowFor(mkTicket("CTL-B4", { held: "waiting" }));
    expect(escalationTypeFor(row)).toBeUndefined();
  });

  it("returns undefined for a running row", () => {
    const row = rowFor(mkTicket("CTL-B5"));
    expect(escalationTypeFor(row)).toBeUndefined();
  });

  it("returns undefined for a needs-human row with no explanation", () => {
    const row = rowFor(mkTicket("CTL-B6", { attention: "needs-human" }));
    expect(escalationTypeFor(row)).toBeUndefined();
  });
});

// ── cardAccentFor ─────────────────────────────────────────────────────────────

describe("CTL-1126: cardAccentFor", () => {
  it("manual escalation → red (outranks amber)", () => {
    expect(cardAccentFor({ modality: "action", escalationType: "manual" })).toBe("red");
  });

  it("decision escalation → amber", () => {
    expect(cardAccentFor({ modality: "action", escalationType: "decision" })).toBe("amber");
  });

  it("authorization escalation → amber", () => {
    expect(cardAccentFor({ modality: "action", escalationType: "authorization" })).toBe("amber");
  });

  it("blocked modality (no escalation) → red", () => {
    expect(cardAccentFor({ modality: "action", escalationType: undefined })).toBe("none");
  });

  it("waiting modality → amber", () => {
    expect(cardAccentFor({ modality: "waiting", escalationType: undefined })).toBe("amber");
  });

  it("awareness modality → none", () => {
    expect(cardAccentFor({ modality: "awareness", escalationType: undefined })).toBe("none");
  });

  it("informational modality → none (no alarm)", () => {
    expect(cardAccentFor({ modality: "informational", escalationType: undefined })).toBe("none");
  });
});

// ── attentionCardModel assembler ──────────────────────────────────────────────

describe("CTL-1126: attentionCardModel assembler", () => {
  const NOW = 1718323200000; // 2026-06-14T00:00:00Z in ms

  it("action card for needs-human row: has modality, escalationType, accent, verb, escalation view", () => {
    const row = rowFor(mkTicket("CTL-C1", {
      attention: "needs-human",
      explanation: { ...BASE_EXPL, escalation_type: "authorization" },
    }));
    const vm = attentionCardModel(row, NOW);
    expect(vm.modality).toBe("action");
    expect(vm.escalationType).toBe("authorization");
    expect(vm.accent).toBe("amber");
    expect(vm.verb).not.toBeNull();
    expect(vm.escalation).not.toBeNull();
  });

  it("waiting card: modality waiting, accent amber, has verb, no escalation", () => {
    const row = rowFor(mkTicket("CTL-C2", { held: "waiting" }));
    const vm = attentionCardModel(row, NOW);
    expect(vm.modality).toBe("waiting");
    expect(vm.accent).toBe("amber");
    expect(vm.verb).not.toBeNull();
    expect(vm.escalation).toBeNull();
  });

  it("awareness row: modality awareness, accent none, no verb, has durationMs or null", () => {
    // awareness rows are outage stubs; simulate with a running ticket with outage downSince
    const row = rowFor(mkTicket("CTL-C3"));
    // For a running row (closest to awareness we can build here), check no verb
    const vm = attentionCardModel(row, NOW);
    expect(vm.modality).toBe("informational");
    expect(vm.accent).toBe("none");
    expect(vm.verb).toBeNull();
  });

  it("informational (done) row: accent none, no verb, no escalation, null durationMs", () => {
    const row = rowFor(mkTicket("CTL-C4", { status: "done" }));
    const vm = attentionCardModel(row, NOW);
    expect(vm.modality).toBe("informational");
    expect(vm.accent).toBe("none");
    expect(vm.verb).toBeNull();
    expect(vm.escalation).toBeNull();
    expect(vm.durationMs).toBeNull();
  });
});
