// board-orphan-pr.test.ts — CTL-1175: orphan-PR Needs-You inbox row.
// Tests the pure synthesizeOrphanTickets helper + deriveInbox integration.

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(HERE, "..", rel), "utf8");
const boardDataSrc = read("lib/board-data.mjs");

// Dynamic import so the pure helper can be exercised without the filesystem reads
// that assembleBoard triggers (EC = homedir path).
const { synthesizeOrphanTickets } = await import(join(HERE, "..", "lib", "board-data.mjs"));

// Helpers
const notified = (over: Record<string, unknown> = {}) => ({
  "org/repo#2061": {
    repo: "org/repo", number: 2061,
    url: "https://github.com/org/repo/pull/2061", title: "Hand-made PR", headRefName: "b",
    mergeStateStatus: "BLOCKED", firstSeenAt: new Date(0).toISOString(),
    notifiedAt: new Date(300_000).toISOString(), ...over,
  },
});

describe("synthesizeOrphanTickets", () => {
  it("emits one needs-human card per NOTIFIED orphan", () => {
    const cards = synthesizeOrphanTickets(notified(), 600_000);
    expect(cards).toHaveLength(1);
    expect(cards[0].attention).toBe("needs-human");
    expect(cards[0].pr).toBe(2061);
    expect(cards[0].mergeStateStatus).toBe("BLOCKED");
    expect(cards[0].attentionSince).toBe(new Date(0).toISOString()); // firstSeenAt anchor
  });

  it("sub-label reason comes from prStuckReason (mentions the PR number + blocker)", () => {
    const cards = synthesizeOrphanTickets(notified(), 600_000);
    expect(cards[0].humanQuestion).toContain("#2061");
    expect(cards[0].prStuckReason).toBeTruthy();
  });

  it("does NOT emit a card for an entry that has firstSeenAt but no notifiedAt (still in window)", () => {
    const state = notified();
    delete (state["org/repo#2061"] as Record<string, unknown>).notifiedAt;
    expect(synthesizeOrphanTickets(state, 600_000)).toHaveLength(0);
  });

  it("uses a synthetic, collision-free id and never overlaps real ticket ids", () => {
    const cards = synthesizeOrphanTickets(notified(), 600_000);
    expect(cards[0].id).toBe("orphan:org/repo#2061");
    expect(cards[0].id).not.toMatch(/^[A-Z]+-\d+$/); // not a real Linear ticket id
  });

  it("empty / missing state → no cards (never throws)", () => {
    expect(synthesizeOrphanTickets({}, 600_000)).toHaveLength(0);
    expect(synthesizeOrphanTickets(null, 600_000)).toHaveLength(0);
  });
});

// Static wiring guard — ensures assembleBoard appends synthesizeOrphanTickets output.
describe("CTL-1175: assembleBoard wiring — orphan-PR synthetic tickets", () => {
  it("board-data.mjs exports synthesizeOrphanTickets", () => {
    expect(boardDataSrc).toContain("export function synthesizeOrphanTickets");
  });

  it("board-data.mjs reads orphan-prs.json via readOrphanPrState", () => {
    expect(boardDataSrc).toContain("readOrphanPrState");
  });

  it("assembleBoard appends orphanTickets to the final tickets array", () => {
    expect(boardDataSrc).toContain("synthesizeOrphanTickets(readOrphanPrState()");
    expect(boardDataSrc).toContain("...orphanTickets");
  });
});
