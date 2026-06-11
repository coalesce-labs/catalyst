// cross-team-title-fallback.test.ts — CTL-1046: the control-tower waiting / dead
// lists must show the Linear TITLE for EVERY team's rows, not just CTL.
//
// The bug: CTL tickets carry their Linear title via the eligible projection
// (eligible/CTL.json → eligibleIndex[id].title), but cross-team records (ADV)
// reach the payload only through ticket_state — which has NO title column — AND
// have no eligible entry (ADV's eligible/<TEAM>.json is empty). So linfo[id].title
// and eligibleIndex[id].title are BOTH null for ADV, and ticketTitle() falls
// through to triage.summary (the DESCRIPTION). That is exactly why ADV-1352
// rendered "The jobs calendar opens empty because…" (description) instead of
// "Demo data should stay current…" (title).
//
// The fix (data layer, not another component fallback): assembleBoard() now
// collects every board ID whose title is null from BOTH sources, batch-fetches the
// real Linear titles (cross-team aware, fail-open — see linear-title-description-
// fallback.test.ts for the fetch contract), and merges them into linfo so
// ticketTitle() returns the Linear title for ALL teams.
//
// This file drives the two NEW pure pieces CTL-1046 adds to assembleBoard()'s
// title-fallback block — collectNullTitleIds and mergeTitleFallback — and asserts
// the end-to-end title resolution through ticketTitle() for a MIXED CTL + ADV
// fixture. It deliberately exercises the merge with a pre-built `fetched` map
// (exactly the shape fillTitleDescriptionFallback returns) rather than swapping
// globalThis.fetch — the network path already has its own suite, and a global-fetch
// swap here would race other concurrently-running test files' fetch mocks.
import { describe, expect, it } from "bun:test";
import {
  collectNullTitleIds,
  mergeTitleFallback,
  ticketTitle,
} from "../lib/board-data.mjs";

// The per-ID shape fillTitleDescriptionFallback resolves to (title is the field
// the merge consumes; the rest ride along on the board-detail path).
function fetchedTitle(title: string | null) {
  return { title, description: null, labels: null, relations: null };
}

describe("collectNullTitleIds (CTL-1046) — only IDs missing a title in BOTH sources", () => {
  it("skips IDs covered by linfo OR eligible, flags the rest, de-dupes", () => {
    const linfo = { "CTL-700": { title: "CTL durable title" }, "ADV-1352": { title: null } };
    const eligibleIndex = { "CTL-764": { title: "CTL eligible title" } };
    const boardIds = ["CTL-700", "CTL-764", "ADV-1352", "ADV-1352"]; // dup ADV

    // CTL-700 (linfo title) and CTL-764 (eligible title) are covered; ADV-1352 is
    // not, and the duplicate collapses.
    expect(collectNullTitleIds(boardIds, linfo, eligibleIndex)).toEqual(["ADV-1352"]);
  });

  it("flags an ID with no linfo entry at all (eligible-only, no ticket_state row)", () => {
    expect(collectNullTitleIds(["ADV-999"], {}, {})).toEqual(["ADV-999"]);
  });

  it("treats an empty-string title as present (does not re-fetch a real-but-empty title)", () => {
    // ?? only coalesces null/undefined — an empty title is a value, left alone.
    expect(collectNullTitleIds(["CTL-1"], { "CTL-1": { title: "" } }, {})).toEqual([]);
  });
});

describe("mergeTitleFallback (CTL-1046) — merge fetched Linear titles into linfo", () => {
  it("writes a fetched title onto an existing linfo entry, preserving other fields", () => {
    const linfo: Record<string, { title: string | null; priority?: number }> = {
      "ADV-1352": { title: null, priority: 2 },
    };
    mergeTitleFallback(linfo, ["ADV-1352"], { "ADV-1352": fetchedTitle("Demo data should stay current") });
    expect(linfo["ADV-1352"].title).toBe("Demo data should stay current");
    expect(linfo["ADV-1352"].priority).toBe(2); // merge, not replace
  });

  it("creates a linfo entry for an eligible-only ticket with no ticket_state row", () => {
    const linfo: Record<string, { title: string | null }> = {};
    mergeTitleFallback(linfo, ["ADV-999"], { "ADV-999": fetchedTitle("ADV ticket, no local linfo") });
    expect(linfo["ADV-999"]).toBeDefined();
    expect(linfo["ADV-999"].title).toBe("ADV ticket, no local linfo");
  });

  it("is a no-op (honest null) when Linear had no title — fail-open, no throw", () => {
    const linfo: Record<string, { title: string | null }> = { "ADV-1352": { title: null } };
    expect(() => mergeTitleFallback(linfo, ["ADV-1352"], { "ADV-1352": fetchedTitle(null) })).not.toThrow();
    expect(linfo["ADV-1352"].title).toBeNull();
    // A totally absent fetched entry is tolerated too (whole-batch fetch failure).
    expect(() => mergeTitleFallback(linfo, ["ADV-1352"], {})).not.toThrow();
    expect(linfo["ADV-1352"].title).toBeNull();
  });
});

describe("end-to-end title resolution for a MIXED CTL + ADV fixture (CTL-1046)", () => {
  it("both teams render their Linear title after the fallback — the bug repro", () => {
    // ADV-1352: ticket_state row exists (so it's on the board) but title is null,
    // and it has no eligible entry. CTL-764 already has its title from eligible.
    const linfo: Record<string, { title: string | null }> = {
      "ADV-1352": { title: null }, // ticket_state row, no title column
      "CTL-764": { title: null }, // title comes from eligible, not linfo
    };
    const eligibleIndex = {
      "CTL-764": { title: "The daemon should record every worker state transition" },
    };
    const advTriage = {
      summary: "The jobs calendar opens empty because every demo job is scheduled in the past",
    };
    const ADV_TITLE = "Demo data should stay current: future jobs scheduled through September";

    // BEFORE: ADV-1352 falls through to its description (the CTL-1046 bug).
    expect(ticketTitle("ADV-1352", advTriage, eligibleIndex, linfo)).toBe(advTriage.summary);

    // The assembleBoard title-fallback block: collect → (fetch) → merge.
    const ids = collectNullTitleIds(["ADV-1352", "CTL-764"], linfo, eligibleIndex);
    expect(ids).toEqual(["ADV-1352"]); // CTL-764 already covered by eligible — not fetched
    // The fetched map is exactly what fillTitleDescriptionFallback returns for `ids`.
    mergeTitleFallback(linfo, ids, { "ADV-1352": fetchedTitle(ADV_TITLE) });

    // AFTER: both teams resolve to their real Linear title — neither a description.
    expect(ticketTitle("ADV-1352", advTriage, eligibleIndex, linfo)).toBe(ADV_TITLE);
    expect(ticketTitle("CTL-764", { summary: "irrelevant desc" }, eligibleIndex, linfo)).toBe(
      "The daemon should record every worker state transition",
    );
  });

  it("a record genuinely missing a title still falls back honestly (summary, not crash)", () => {
    const linfo: Record<string, { title: string | null }> = { "ADV-1352": { title: null } };
    const triage = { summary: "honest description fallback" };

    const ids = collectNullTitleIds(["ADV-1352"], linfo, {});
    // Linear returned nothing for it (not found) → honest null merge.
    mergeTitleFallback(linfo, ids, { "ADV-1352": fetchedTitle(null) });

    expect(linfo["ADV-1352"].title).toBeNull();
    expect(ticketTitle("ADV-1352", triage, {}, linfo)).toBe("honest description fallback");
  });
});
