// board-durable-escalations.test.ts — CTL-1643: surface durable escalation records
// on the board even when the worker dir has been GC'd and even when the Linear label
// never confirmed (Hole 1 + Hole 2 in combination).
//
// Pattern mirrors board-parked-needs-human.test.ts:
//   • the PURE synthesizer emits one attention card per durable record, deduped
//     against the existing worker-dir / queued / orphan / parked card set;
//   • labelConfirmed:false records surface identically to labelConfirmed:true
//     (that is the whole point of Hole 1 — the store survives even when the label
//     never landed in Linear, so the operator still sees the escalation);
//   • terminal-aware: linfo or an explicit terminalIds set excludes tickets already
//     at Done/Canceled;
//   • malformed / empty input → [] (fail-open, never throws).

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { classifyTicket, deriveInbox } from "../ui/src/board/home-inbox";
import type { BoardPayload, BoardTicket } from "../ui/src/board/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(HERE, "..", rel), "utf8");
const boardDataSrc = read("lib/board-data.mjs");

const boardMod = await import(join(HERE, "..", "lib", "board-data.mjs"));
const synthesizeDurableEscalations = (boardMod as Record<string, unknown>)
  .synthesizeDurableEscalations as (
  records: unknown,
  existingIds: unknown,
  now: number,
  replicaTitles?: unknown,
  linfo?: unknown,
  terminalIds?: unknown,
) => BoardTicket[];

// Minimal durable record as recordDurableEscalation writes it.
const durableRec = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ticket: "CTL-9",
  phase: "implement",
  reason: "Worker stuck > 24h, no progress",
  escalatedAt: new Date(100_000).toISOString(),
  labelConfirmed: false,
  commentPosted: true,
  labelAttempts: 3,
  source: "scheduler",
  lastTs: new Date(200_000).toISOString(),
  ...over,
});

function mkPayload(tickets: BoardTicket[]): BoardPayload {
  return {
    generatedAt: "2026-08-05T00:00:00Z",
    config: { maxParallel: 0, inFlight: 0, freeSlots: 0, active: 0, working: 0, stuck: 0 },
    repos: ["catalyst"],
    workers: [],
    tickets,
    queue: [],
  };
}

describe("synthesizeDurableEscalations — the pure card builder", () => {
  it("a fence-standoff durable record round-trips as needs-human attention (CAT-173)", () => {
    const cards = synthesizeDurableEscalations(
      [durableRec({
        ticket: "CAT-53",
        reason: "fence-standoff: superseded on 2 hosts",
        escalatedAt: "2026-08-11T00:00:00Z",
        source: "fence-standoff",
      })],
      new Set<string>(),
      Date.now(),
    );
    expect(cards[0].attention).toBe("needs-human");
    expect(cards[0].humanQuestion).toMatch(/fence-standoff/);
    expect(cards[0].attentionSince).toBe("2026-08-11T00:00:00Z");
  });

  it("(a) a durable record with labelConfirmed:false and no existing card → attention card (Hole 1)", () => {
    const cards = synthesizeDurableEscalations([durableRec()], new Set<string>(), 600_000);
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe("CTL-9");
    expect(cards[0].attention).toBe("needs-human");
    // attentionSince anchored to the original escalatedAt (not lastTs / now).
    expect(cards[0].attentionSince).toBe(new Date(100_000).toISOString());
    // humanQuestion carries the escalation reason from the record.
    expect(String(cards[0].humanQuestion)).toContain("Worker stuck");
    // classifyTicket buckets it into the inbox "Needs you" section.
    expect(classifyTicket(cards[0])).toBe("attention");
    const model = deriveInbox(mkPayload(cards));
    expect(model.counts.attention).toBe(1);
    expect(model.counts.needsYou).toBe(1);
    expect(model.sections.find((s) => s.kind === "attention")?.rows[0].id).toBe("CTL-9");
  });

  it("(b) a durable record with labelConfirmed:true surfaces identically to labelConfirmed:false", () => {
    const cards = synthesizeDurableEscalations(
      [durableRec({ ticket: "CTL-10", labelConfirmed: true })],
      new Set<string>(),
      600_000,
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe("CTL-10");
    expect(cards[0].attention).toBe("needs-human");
    expect(classifyTicket(cards[0])).toBe("attention");
  });

  it("(c) a ticket already carded (worker-dir / parked / queued) is NOT duplicated", () => {
    const cards = synthesizeDurableEscalations(
      [durableRec()],
      new Set(["CTL-9"]),
      600_000,
    );
    expect(cards).toHaveLength(0);
  });

  it("dedupes a duplicate record in the input (one card per ticket id)", () => {
    const cards = synthesizeDurableEscalations(
      [durableRec(), durableRec()],
      new Set<string>(),
      600_000,
    );
    expect(cards).toHaveLength(1);
  });

  it("(d) terminal-aware: linfo carries Done linearState → NO card", () => {
    const linfo: Record<string, { linearState?: string }> = {
      "CTL-9": { linearState: "Done" },
    };
    const cards = synthesizeDurableEscalations(
      [durableRec()],
      new Set<string>(),
      600_000,
      {},
      linfo,
    );
    expect(cards).toHaveLength(0);
  });

  it("terminal-aware: terminalIds Set excludes the ticket even without linfo", () => {
    const cards = synthesizeDurableEscalations(
      [durableRec()],
      new Set<string>(),
      600_000,
      {},
      {},
      new Set(["CTL-9"]),
    );
    expect(cards).toHaveLength(0);
  });

  it("terminal-aware: Canceled linearState → NO card", () => {
    const cards = synthesizeDurableEscalations(
      [durableRec()],
      new Set<string>(),
      600_000,
      {},
      { "CTL-9": { linearState: "Canceled" } },
    );
    expect(cards).toHaveLength(0);
  });

  it("non-terminal linearState (Implement) → card is emitted", () => {
    const cards = synthesizeDurableEscalations(
      [durableRec()],
      new Set<string>(),
      600_000,
      {},
      { "CTL-9": { linearState: "Implement" } },
    );
    expect(cards).toHaveLength(1);
  });

  it("title resolution: replicaTitles > linfo > bare ticket id", () => {
    const replica = synthesizeDurableEscalations(
      [durableRec()],
      new Set<string>(),
      600_000,
      { "CTL-9": "Replica title" },
      { "CTL-9": { title: "Linfo title" } },
    );
    expect(replica[0].title).toBe("Replica title");

    const linfoOnly = synthesizeDurableEscalations(
      [durableRec()],
      new Set<string>(),
      600_000,
      {},
      { "CTL-9": { title: "Linfo title" } },
    );
    expect(linfoOnly[0].title).toBe("Linfo title");

    const bareId = synthesizeDurableEscalations([durableRec()], new Set<string>(), 600_000);
    expect(bareId[0].title).toBe("CTL-9");
  });

  it("card has the correct type, team, and repo fields", () => {
    const cards = synthesizeDurableEscalations([durableRec()], new Set<string>(), 600_000);
    expect(cards[0].type).toBe("durable-escalation");
    expect(cards[0].team).toBe("CTL");
    expect(classifyTicket(cards[0])).not.toBe("done");
  });

  it("existingIds may arrive as a plain array (also deduped)", () => {
    const cards = synthesizeDurableEscalations([durableRec()], ["CTL-9"], 600_000);
    expect(cards).toHaveLength(0);
  });

  it("empty / non-array records → [] (never throws)", () => {
    expect(synthesizeDurableEscalations([], new Set<string>(), 600_000)).toHaveLength(0);
    expect(synthesizeDurableEscalations(null, new Set<string>(), 600_000)).toHaveLength(0);
    expect(
      synthesizeDurableEscalations(undefined, new Set<string>(), 600_000),
    ).toHaveLength(0);
  });

  it("malformed record without ticket field is skipped (never throws)", () => {
    const cards = synthesizeDurableEscalations(
      [{ reason: "bad", escalatedAt: "t" }],
      new Set<string>(),
      600_000,
    );
    expect(cards).toHaveLength(0);
  });
});

// ── Static wiring guard ───────────────────────────────────────────────────────
describe("assembleBoard wiring — durable escalation cards", () => {
  it("board-data.mjs exports synthesizeDurableEscalations", () => {
    expect(boardDataSrc).toContain("export function synthesizeDurableEscalations");
  });

  it("board-data.mjs imports readDurableEscalations from durable-escalation.mjs", () => {
    expect(boardDataSrc).toContain("readDurableEscalations");
    expect(boardDataSrc).toContain("durable-escalation.mjs");
  });

  it("assembleBoard calls synthesizeDurableEscalations and spreads the result", () => {
    const nospace = (s: string) => s.replace(/\s+/g, "");
    expect(nospace(boardDataSrc)).toContain(nospace("synthesizeDurableEscalations("));
    expect(boardDataSrc).toContain("...durableTickets");
  });
});
