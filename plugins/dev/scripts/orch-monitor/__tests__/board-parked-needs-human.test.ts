// board-parked-needs-human.test.ts — surface PARKED needs-human tickets in the
// inbox from filter-state.db (the worker-dir-scoping gap fix).
//
// The board's ticket set is built from LIVE worker dirs (liveTickets +
// betweenPhases + recentDone + queued + orphan-PR synthetics). A needs-human /
// needs-input ticket whose worker dir was torn down (the PARKED case) is in NONE
// of those sets, so it never entered payload.tickets and never reached the inbox —
// even though deriveAttention already supported the label (~14 parked needs-human
// were invisible while the inbox showed ~1). These units lock in the cache-sourced
// fix, modeled on board-orphan-pr.test.ts + home-inbox-attention.test.ts:
//   • the PURE synthesizer emits one attention card per parked ticket, deduped
//     against the existing worker-dir / queued / orphan card set;
//   • classifyTicket / deriveInbox bucket that card into the "Needs you" section;
//   • the cache reader (readParkedNeedsHumanTickets) mirrors the broker's
//     countNeedsHumanTickets predicate (terminal/removed excluded) and fails open.

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { classifyTicket, deriveInbox } from "../ui/src/board/home-inbox";
import type { BoardPayload, BoardTicket } from "../ui/src/board/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(HERE, "..", rel), "utf8");
const boardDataSrc = read("lib/board-data.mjs");

// Dynamic imports so the pure helpers run without the filesystem reads
// assembleBoard triggers. Cast the modules to typed function shapes (same pattern
// as board-orphan-pr.test.ts) to keep the no-unsafe-call lint rule happy.
const boardMod = await import(join(HERE, "..", "lib", "board-data.mjs"));
const synthesizeParkedNeedsHumanTickets = (boardMod as Record<string, unknown>)
  .synthesizeParkedNeedsHumanTickets as (
  parked: unknown,
  existingIds: unknown,
  now: number,
) => BoardTicket[];

const cacheMod = await import(join(HERE, "..", "lib", "linear-cache-reader.mjs"));
const readParkedNeedsHumanTickets = (cacheMod as Record<string, unknown>)
  .readParkedNeedsHumanTickets as (opts?: {
  dbPath?: string;
  descriptorReader?: (dbPath: string) => Promise<unknown[]>;
}) => Promise<Array<Record<string, unknown>>>;

// One parked descriptor as readParkedNeedsHumanTickets emits it (the synthesizer's input).
const parked = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ticket: "CTL-700",
  labels: ["needs-human"],
  linearState: "Implement",
  priority: 2,
  updatedAt: new Date(120_000).toISOString(),
  ...over,
});

function mkPayload(tickets: BoardTicket[]): BoardPayload {
  return {
    generatedAt: "2026-06-26T00:00:00Z",
    config: { maxParallel: 0, inFlight: 0, freeSlots: 0, active: 0, working: 0, stuck: 0 },
    repos: ["catalyst"],
    workers: [],
    tickets,
    queue: [],
  };
}

describe("synthesizeParkedNeedsHumanTickets — the pure card builder", () => {
  it("(a) a parked needs-human ticket with NO worker-dir card becomes a needs-human attention card", () => {
    const cards = synthesizeParkedNeedsHumanTickets([parked()], new Set<string>(), 600_000);
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe("CTL-700");
    expect(cards[0].attention).toBe("needs-human");
    // attentionSince is anchored to the cache's updated_at (the "how long parked" stamp).
    expect(cards[0].attentionSince).toBe(new Date(120_000).toISOString());
    // classifyTicket buckets it into the inbox "Needs you" (attention) section.
    expect(classifyTicket(cards[0])).toBe("attention");
    // …and it shows up in the derived inbox attention section + needsYou count.
    const model = deriveInbox(mkPayload(cards));
    expect(model.counts.attention).toBe(1);
    expect(model.counts.needsYou).toBe(1);
    expect(model.sections.find((s) => s.kind === "attention")?.rows[0].id).toBe("CTL-700");
  });

  it("a needs-input (not needs-human) label also surfaces as a needs-human attention card", () => {
    const cards = synthesizeParkedNeedsHumanTickets(
      [parked({ ticket: "CTL-701", labels: ["needs-input"] })],
      new Set<string>(),
      600_000,
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].attention).toBe("needs-human");
    expect(String(cards[0].humanQuestion)).toContain("needs-input");
    expect(classifyTicket(cards[0])).toBe("attention");
  });

  it("(b) a parked ticket that already has a worker-dir card is NOT duplicated", () => {
    // CTL-700 already carded by a live/between-phases worker dir → in existingIds.
    const cards = synthesizeParkedNeedsHumanTickets([parked()], new Set(["CTL-700"]), 600_000);
    expect(cards).toHaveLength(0);
  });

  it("dedupes a duplicate descriptor within the input (one card per id)", () => {
    const cards = synthesizeParkedNeedsHumanTickets([parked(), parked()], new Set<string>(), 600_000);
    expect(cards).toHaveLength(1);
  });

  it("derives team/repo from the ticket id and never collides with a real worker card", () => {
    const cards = synthesizeParkedNeedsHumanTickets([parked()], new Set<string>(), 600_000);
    expect(cards[0].team).toBe("CTL");
    expect(cards[0].type).toBe("parked-needs-human");
    // a parked card is never classified done (status not done, linearState not Done).
    expect(classifyTicket(cards[0])).not.toBe("done");
  });

  it("empty / non-array input → no cards (never throws)", () => {
    expect(synthesizeParkedNeedsHumanTickets([], new Set<string>(), 600_000)).toHaveLength(0);
    expect(synthesizeParkedNeedsHumanTickets(null, new Set<string>(), 600_000)).toHaveLength(0);
    // existingIds may arrive as a plain array, too.
    expect(synthesizeParkedNeedsHumanTickets([parked()], ["CTL-700"], 600_000)).toHaveLength(0);
  });
});

describe("readParkedNeedsHumanTickets — the cache reader (broker predicate parity)", () => {
  // Stand in for getAllTicketDescriptors rows (rowToTicketDescriptor shape).
  const descriptors = [
    { ticket: "CTL-700", state: "Implement", labels: ["needs-human"], priority: 2, removed: false, updatedAt: "t1" },
    { ticket: "CTL-701", state: "Triage", labels: ["needs-input"], priority: 1, removed: false, updatedAt: "t2" },
    { ticket: "CTL-800", state: "Implement", labels: ["bug"], priority: 0, removed: false, updatedAt: "t3" }, // no label → excluded
    { ticket: "CTL-900", state: "Done", labels: ["needs-human"], priority: 0, removed: false, updatedAt: "t4" }, // terminal → excluded
    { ticket: "CTL-901", state: "Canceled", labels: ["needs-human"], priority: 0, removed: false, updatedAt: "t5" }, // terminal → excluded
    { ticket: "CTL-902", state: "Implement", labels: ["needs-human"], priority: 0, removed: true, updatedAt: "t6" }, // removed → excluded
  ];

  it("returns only non-terminal, non-removed tickets carrying needs-human/needs-input", async () => {
    const out = await readParkedNeedsHumanTickets({ descriptorReader: () => Promise.resolve(descriptors) });
    expect(out.map((d) => d.ticket).sort()).toEqual(["CTL-700", "CTL-701"]);
    const seven = out.find((d) => d.ticket === "CTL-700");
    expect(seven?.linearState).toBe("Implement");
    expect(seven?.updatedAt).toBe("t1");
    expect(seven?.priority).toBe(2);
  });

  it("(c) terminal (Done/Canceled) and removed needs-human tickets are excluded", async () => {
    const out = await readParkedNeedsHumanTickets({ descriptorReader: () => Promise.resolve(descriptors) });
    const ids = new Set(out.map((d) => d.ticket));
    expect(ids.has("CTL-900")).toBe(false); // Done
    expect(ids.has("CTL-901")).toBe(false); // Canceled
    expect(ids.has("CTL-902")).toBe(false); // removed
  });

  it("(d) a filter-state.db read failure degrades gracefully to [] (never throws)", async () => {
    const out = await readParkedNeedsHumanTickets({
      descriptorReader: () => Promise.reject(new Error("db locked")),
    });
    expect(out).toEqual([]);
  });

  it("a non-array descriptor result degrades to [] (defensive)", async () => {
    const out = await readParkedNeedsHumanTickets({
      descriptorReader: () => Promise.resolve(null as unknown as unknown[]),
    });
    expect(out).toEqual([]);
  });
});

// Static wiring guard — ensures assembleBoard appends the parked cards, sourced
// from the cache reader, deduped against the existing card-id set.
describe("assembleBoard wiring — parked needs-human synthetic tickets", () => {
  it("board-data.mjs exports synthesizeParkedNeedsHumanTickets", () => {
    expect(boardDataSrc).toContain("export function synthesizeParkedNeedsHumanTickets");
  });

  it("board-data.mjs reads the parked set via readParkedNeedsHumanTickets (cache-sourced)", () => {
    expect(boardDataSrc).toContain("readParkedNeedsHumanTickets");
  });

  it("assembleBoard dedupes against existing card ids and appends parkedTickets", () => {
    expect(boardDataSrc).toContain("synthesizeParkedNeedsHumanTickets(parkedNeedsHuman, existingCardIds, now, replicaTitles, linfo)");
    expect(boardDataSrc).toContain("...parkedTickets");
  });
});
