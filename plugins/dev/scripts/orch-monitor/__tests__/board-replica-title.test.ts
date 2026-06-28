// board-replica-title.test.ts — CTL-1372: the Tickets board must lead with the
// real Linear TITLE for PARKED tickets, not the bare ticket id.
//
// THE BUG (live-diagnosed): filter-state.db ticket_state has NO title column, so a
// PARKED ticket (worker dir torn down, no eligible row) has no durable title source
// and its card rendered as "CTL-1214" instead of "Slim .catalyst/config.json…".
//
// THE FIX: the CTC replica (catalyst-replica.db — the SDK's live Linear mirror)
// carries every title. board-data sources a batched { id→title } map from it and
// slots it into title resolution right after the triage-recorded title. This file
// drives the PURE board helpers the wiring threads `replicaTitles` through —
// ticketTitle, collectNullTitleIds, synthesizeQueuedTicket, and
// synthesizeParkedNeedsHumanTickets — with an in-memory replica map (no DB).
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  collectNullTitleIds,
  resolveQueuedTitle,
  synthesizeQueuedTicket,
  ticketTitle,
} from "../lib/board-data.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// synthesizeParkedNeedsHumanTickets is dynamic-imported + cast (same pattern as
// board-parked-needs-human.test.ts) — it is not declared in board-data.d.mts.
const boardMod = await import(join(HERE, "..", "lib", "board-data.mjs"));
const synthesizeParkedNeedsHumanTickets = (boardMod as Record<string, unknown>)
  .synthesizeParkedNeedsHumanTickets as (
  parked: unknown,
  existingIds: unknown,
  now: number,
  replicaTitles?: Record<string, string>,
  linfo?: Record<string, { title?: string | null }>,
) => Array<{ id: string; title: string }>;

const KEY = "CTL-1214";
const REPLICA_TITLE = "Slim .catalyst/config.json down to the essentials";
const ELIGIBLE_TITLE = "Eligible-projection title";
const SUMMARY = "A description-y triage summary sentence that must never be the title";

describe("ticketTitle — replica title tier (CTL-1372)", () => {
  it("uses the replica title when the local caches have none (the parked-ticket fix)", () => {
    // No triage.title, no linfo title, no eligible title — exactly a parked ticket.
    expect(ticketTitle(KEY, { summary: SUMMARY }, {}, {}, { [KEY]: REPLICA_TITLE })).toBe(
      REPLICA_TITLE,
    );
  });

  it("prefers an explicit triage.title over the replica title", () => {
    expect(
      ticketTitle(KEY, { title: "Triage-recorded", summary: SUMMARY }, {}, {}, { [KEY]: REPLICA_TITLE }),
    ).toBe("Triage-recorded");
  });

  it("prefers the replica title over the existing linfo / eligible title", () => {
    const linfo = { [KEY]: { title: "Stale linfo title" } };
    const eligibleIndex = { [KEY]: { title: ELIGIBLE_TITLE } };
    expect(ticketTitle(KEY, null, eligibleIndex, linfo, { [KEY]: REPLICA_TITLE })).toBe(REPLICA_TITLE);
  });

  it("falls through to the existing chain unchanged when the replica has no hit", () => {
    // Replica map empty (absent/unreadable) → existing linfo/eligible wins.
    const eligibleIndex = { [KEY]: { title: ELIGIBLE_TITLE } };
    expect(ticketTitle(KEY, { summary: SUMMARY }, eligibleIndex, {}, {})).toBe(ELIGIBLE_TITLE);
    // …and with nothing anywhere it still falls to summary then the id (back-compat).
    expect(ticketTitle(KEY, { summary: SUMMARY }, {}, {}, {})).toBe(SUMMARY);
    expect(ticketTitle(KEY, null, {}, {}, {})).toBe(KEY);
  });

  it("ignores an empty-string replica title (treated as no hit, falls through)", () => {
    expect(ticketTitle(KEY, { summary: SUMMARY }, {}, {}, { [KEY]: "" })).toBe(SUMMARY);
  });

  it("is back-compat when called with the old 4-arg signature (no replica map)", () => {
    const linfo = { [KEY]: { title: "L" } };
    expect(ticketTitle(KEY, null, {}, linfo)).toBe("L");
  });
});

describe("collectNullTitleIds — replica-aware (CTL-1372)", () => {
  it("treats a replica HIT as 'covered' so the on-demand fetch is skipped", () => {
    // ADV-1352 has no linfo/eligible title but the replica resolves it → not fetched.
    const linfo = { "ADV-1352": { title: null } };
    expect(
      collectNullTitleIds(["ADV-1352"], linfo, {}, { "ADV-1352": "Demo data should stay current" }),
    ).toEqual([]);
  });

  it("still flags ids the replica MISSED (on-demand fetch is the last resort)", () => {
    const linfo = { "ADV-1352": { title: null }, "ADV-1353": { title: null } };
    // Only ADV-1352 is in the replica; ADV-1353 still needs the on-demand fetch.
    expect(
      collectNullTitleIds(["ADV-1352", "ADV-1353"], linfo, {}, { "ADV-1352": "covered" }),
    ).toEqual(["ADV-1353"]);
  });

  it("is back-compat with the old 3-arg signature (no replica map)", () => {
    expect(collectNullTitleIds(["ADV-999"], {}, {})).toEqual(["ADV-999"]);
  });
});

describe("synthesizeParkedNeedsHumanTickets — replica title (CTL-1372 — the repro)", () => {
  const parked = (over: Record<string, unknown> = {}) => ({
    ticket: KEY,
    labels: ["needs-human"],
    linearState: "Implement",
    priority: 2,
    updatedAt: new Date(120_000).toISOString(),
    ...over,
  });

  it("renders the replica title instead of the bare ticket id", () => {
    const cards = synthesizeParkedNeedsHumanTickets([parked()], new Set<string>(), 600_000, {
      [KEY]: REPLICA_TITLE,
    });
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe(REPLICA_TITLE); // NOT "CTL-1214"
    expect(cards[0].title).not.toBe(KEY);
  });

  it("falls back to the bare id when the replica has no hit (honest last resort)", () => {
    const cards = synthesizeParkedNeedsHumanTickets([parked()], new Set<string>(), 600_000, {});
    expect(cards[0].title).toBe(KEY); // unchanged pre-replica behavior, never crashes
  });

  it("is back-compat when called without a replica map", () => {
    const cards = synthesizeParkedNeedsHumanTickets([parked()], new Set<string>(), 600_000);
    expect(cards[0].title).toBe(KEY);
  });

  // CTL-1378 (#2421 edge): on a replica MISS, the parked card now uses the on-demand
  // title the board fetched into linfo (parked IDs are included in the title fallback)
  // before falling through to the bare id.
  it("on a replica MISS, uses the on-demand title fetched into linfo (CTL-1378)", () => {
    const linfo = { [KEY]: { title: "On-demand fetched title" } };
    const cards = synthesizeParkedNeedsHumanTickets([parked()], new Set<string>(), 600_000, {}, linfo);
    expect(cards[0].title).toBe("On-demand fetched title");
    expect(cards[0].title).not.toBe(KEY);
  });

  it("prefers the replica title over the linfo fallback (CTL-1378)", () => {
    const linfo = { [KEY]: { title: "linfo title" } };
    const cards = synthesizeParkedNeedsHumanTickets(
      [parked()],
      new Set<string>(),
      600_000,
      { [KEY]: REPLICA_TITLE },
      linfo,
    );
    expect(cards[0].title).toBe(REPLICA_TITLE);
  });

  it("ignores an empty linfo title and falls through to the bare id (CTL-1378)", () => {
    const cards = synthesizeParkedNeedsHumanTickets(
      [parked()],
      new Set<string>(),
      600_000,
      {},
      { [KEY]: { title: "" } },
    );
    expect(cards[0].title).toBe(KEY);
  });
});

describe("resolveQueuedTitle — shared queue/card title resolver (CTL-1378, #2421 edge)", () => {
  it("prefers the replica title", () => {
    expect(resolveQueuedTitle({ id: KEY, title: ELIGIBLE_TITLE }, { [KEY]: REPLICA_TITLE })).toBe(
      REPLICA_TITLE,
    );
  });

  it("falls back to e.title on a replica miss, then the bare id", () => {
    expect(resolveQueuedTitle({ id: KEY, title: ELIGIBLE_TITLE }, {})).toBe(ELIGIBLE_TITLE);
    expect(resolveQueuedTitle({ id: KEY }, {})).toBe(KEY);
  });

  it("ignores an empty replica title (treated as a miss)", () => {
    expect(resolveQueuedTitle({ id: KEY, title: ELIGIBLE_TITLE }, { [KEY]: "" })).toBe(ELIGIBLE_TITLE);
  });

  it("the Todo card AND the dispatch-queue payload both resolve titles through this same path", () => {
    // Source-scan guard: synthesizeQueuedTicket (the Tickets card) and the `queue`
    // payload both call resolveQueuedTitle(e, replicaTitles), so they can never disagree.
    const src = readFileSync(join(HERE, "..", "lib", "board-data.mjs"), "utf8");
    const occurrences = src.split("resolveQueuedTitle(e, replicaTitles)").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });
});

describe("synthesizeQueuedTicket — replica title (CTL-1372)", () => {
  it("prefers the replica title over the eligible projection's title", () => {
    const e = { id: KEY, title: ELIGIBLE_TITLE };
    const card = synthesizeQueuedTicket(e, {}, new Map(), {}, { [KEY]: REPLICA_TITLE });
    expect(card.title).toBe(REPLICA_TITLE);
  });

  it("falls back to the eligible title, then the id, when the replica has no hit", () => {
    expect(synthesizeQueuedTicket({ id: KEY, title: ELIGIBLE_TITLE }, {}, new Map(), {}, {}).title).toBe(
      ELIGIBLE_TITLE,
    );
    expect(synthesizeQueuedTicket({ id: KEY }, {}, new Map(), {}, {}).title).toBe(KEY);
  });

  it("is back-compat without a replica map", () => {
    expect(synthesizeQueuedTicket({ id: KEY, title: ELIGIBLE_TITLE }, {}).title).toBe(ELIGIBLE_TITLE);
  });
});
