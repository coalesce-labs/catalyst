// ticket-title.test.ts — CTL-1041: the control tower / inbox must lead with the
// ticket TITLE (the outcome line), never the triage SUMMARY (the description).
//
// The bug: ticketTitle() preferred `triage.summary` over the authoritative Linear
// title, so an occupied slot card for CTL-1008 read "Live probe (2026-06-11)
// confirmed the unified event log…" (the description) instead of "Every event in
// the unified event log should reach OTel…" (the title). This locks the priority
// order: explicit triage.title → Linear title (linfo, then eligible) → triage
// summary (last-ditch) → the ticket key.
import { describe, it, expect } from "bun:test";
import { ticketTitle } from "../lib/board-data.mjs";

const KEY = "CTL-1008";
const LINEAR_TITLE = "Every event in the unified event log should reach OTel";
const SUMMARY = "Live probe (2026-06-11) confirmed the unified event log…";

describe("ticketTitle — title leads, description never stands in (CTL-1041)", () => {
  it("prefers the Linear title (linfo) over the triage summary", () => {
    const triage = { summary: SUMMARY };
    const linfo = { [KEY]: { title: LINEAR_TITLE } };
    expect(ticketTitle(KEY, triage, {}, linfo)).toBe(LINEAR_TITLE);
  });

  it("falls back to the eligible-projection title when linfo has none", () => {
    const triage = { summary: SUMMARY };
    const eligibleIndex = { [KEY]: { title: LINEAR_TITLE } };
    expect(ticketTitle(KEY, triage, eligibleIndex, {})).toBe(LINEAR_TITLE);
  });

  it("honors an explicit triage.title above everything", () => {
    const triage = { title: "Triage-recorded title", summary: SUMMARY };
    const linfo = { [KEY]: { title: LINEAR_TITLE } };
    expect(ticketTitle(KEY, triage, {}, linfo)).toBe("Triage-recorded title");
  });

  it("uses the triage summary ONLY when no Linear title exists at all", () => {
    const triage = { summary: SUMMARY };
    expect(ticketTitle(KEY, triage, {}, {})).toBe(SUMMARY);
  });

  it("falls back to the ticket key when nothing names a title", () => {
    expect(ticketTitle(KEY, null, {}, {})).toBe(KEY);
    expect(ticketTitle(KEY, {}, {}, {})).toBe(KEY);
  });

  it("never lets the summary win when a Linear title is present", () => {
    // The exact CTL-1008 repro: triage carries the description, Linear carries the
    // real title — the title must win.
    const triage = { summary: SUMMARY, dependencies: [] };
    const linfo = { [KEY]: { title: LINEAR_TITLE, priority: 2 } };
    const out = ticketTitle(KEY, triage, {}, linfo);
    expect(out).toBe(LINEAR_TITLE);
    expect(out).not.toBe(SUMMARY);
  });
});
