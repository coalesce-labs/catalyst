// board-held-indicator.test.ts — CTL-755 SLICE 4 (board surfacing).
//
// The admission-control gate (scheduler STEP A) holds a triaged-waiting ticket
// before the triage→research promotion and tags it with a Linear label:
//   • `blocked` — ≥1 non-terminal blocked_by dependency.
//   • `waiting` — deps satisfied, but it lost the priority/capacity selection.
// This board slice reads those labels (already returned by the cached
// `linearis issues list` call) and renders a distinct held chip so an operator
// sees at a glance the ticket is HELD, not silently mid-triage.
//
// This file pins:
//   1. heldFor() label-classification (pure data-layer helper).
//   2. The held label constants do NOT drift across the three copies:
//      scheduler.mjs (daemon writer) ⇄ board-data.mjs (reader) ⇄ Board.tsx (UI).
//   3. Board.tsx actually wires the held indicator into the ticket card.

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { heldFor, HELD_LABEL_BLOCKED, HELD_LABEL_WAITING } from "../lib/board-data.mjs";

// Source of truth: the daemon-side label writer (execution-core/scheduler.mjs).
// We read it as TEXT rather than import it — the scheduler is a large daemon
// module with no .d.mts, so importing it under the typechecked test package
// would trip TS7016. This mirrors how board-phase-drift.test.ts reads Board.tsx
// as text. We extract the two `export const HELD_LABEL_* = "…"` literals.
const HERE = dirname(fileURLToPath(import.meta.url));
const SCHED_SRC = readFileSync(
  join(HERE, "..", "..", "execution-core", "scheduler.mjs"),
  "utf8",
);
function schedLabel(name: string): string {
  // eslint-disable-next-line security/detect-non-literal-regexp
  const m = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*"([^"]+)"`).exec(SCHED_SRC);
  if (!m) throw new Error(`board-held-indicator: could not locate \`export const ${name}\` in scheduler.mjs`);
  return m[1];
}
const SCHED_BLOCKED = schedLabel("HELD_LABEL_BLOCKED");
const SCHED_WAITING = schedLabel("HELD_LABEL_WAITING");

// ── 1. heldFor() classification ──────────────────────────────────────────────
test("heldFor → 'blocked' when the blocked label is present", () => {
  expect(heldFor(["blocked"])).toBe("blocked");
  expect(heldFor(["feature", "orchestrator", "blocked"])).toBe("blocked");
});

test("heldFor → 'queued' when the queued label is present (Phase 4 rename)", () => {
  expect(heldFor(["queued"])).toBe("queued");
  expect(heldFor(["chore", "queued"])).toBe("queued");
});

test("heldFor → back-compat: legacy 'waiting' label maps to 'queued'", () => {
  // CTL-764 Phase 4: HELD_LABEL_WAITING value changed from "waiting" to "queued".
  // The HUD back-compat-maps the old label so a mid-rollout board is never blank.
  expect(heldFor(["waiting"])).toBe("queued");
  expect(heldFor(["chore", "waiting"])).toBe("queued");
});

test("heldFor → 'blocked' wins when both labels are somehow present (more severe)", () => {
  expect(heldFor(["waiting", "blocked"])).toBe("blocked");
  expect(heldFor(["blocked", "waiting"])).toBe("blocked");
});

test("heldFor → null for a ticket with no held label", () => {
  expect(heldFor(["feature", "orchestrator"])).toBeNull();
  expect(heldFor([])).toBeNull();
});

test("heldFor → null for missing / non-array input (graceful)", () => {
  expect(heldFor(undefined)).toBeNull();
  expect(heldFor(null)).toBeNull();
  // A bare (non-array) string is NOT a label set → not held (no throw).
  expect(heldFor("blocked")).toBeNull();
});

// ── 2. cross-copy drift guard ────────────────────────────────────────────────
test("board-data held labels equal scheduler.mjs source of truth (no drift)", () => {
  if (HELD_LABEL_BLOCKED !== SCHED_BLOCKED || HELD_LABEL_WAITING !== SCHED_WAITING) {
    throw new Error(
      `DRIFT: lib/board-data.mjs held labels diverged from execution-core/scheduler.mjs.\n` +
        `  scheduler:  blocked=${JSON.stringify(SCHED_BLOCKED)} waiting=${JSON.stringify(SCHED_WAITING)}\n` +
        `  board-data: blocked=${JSON.stringify(HELD_LABEL_BLOCKED)} waiting=${JSON.stringify(HELD_LABEL_WAITING)}\n` +
        `The daemon writes these labels and the board reads them — they must match. ` +
        `scheduler.mjs is the source of truth.`,
    );
  }
  expect(HELD_LABEL_BLOCKED).toBe(SCHED_BLOCKED);
  expect(HELD_LABEL_WAITING).toBe(SCHED_WAITING);
});

// ── Board.tsx text extraction (cannot import — pulls React + "@/…" aliases) ───
const BOARD_TSX = readFileSync(join(HERE, "..", "ui", "src", "board", "Board.tsx"), "utf8");

test("Board.tsx held label constants equal scheduler.mjs source of truth (no drift)", () => {
  const grab = (name: string) => {
    // eslint-disable-next-line security/detect-non-literal-regexp
    const m = new RegExp(`const\\s+${name}\\s*=\\s*"([^"]+)"`).exec(BOARD_TSX);
    if (!m) throw new Error(`board-held-indicator: could not locate \`const ${name}\` in Board.tsx`);
    return m[1];
  };
  expect(grab("HELD_LABEL_BLOCKED")).toBe(SCHED_BLOCKED);
  // CTL-764 Phase 4: value renamed from "waiting" to "queued". Both scheduler.mjs
  // (daemon writer) and Board.tsx (display) must carry the same value.
  expect(grab("HELD_LABEL_WAITING")).toBe(SCHED_WAITING);
});

// ── 3. Board.tsx renders the held indicator ──────────────────────────────────
test("Board.tsx defines a HeldBadge and wires it from the ticket's held field", () => {
  expect(BOARD_TSX).toContain("function HeldBadge");
  // The chip is rendered in TicketCard from t.held (+ t.blockers).
  expect(BOARD_TSX).toContain("<HeldBadge held={t.held} blockers={t.blockers} />");
  // It distinguishes blocked vs queued (was "waiting") with the pause glyph.
  expect(BOARD_TSX).toContain("⏸ blocked");
  // CTL-764 Phase 4: display text updated from "⏸ waiting" to "⏸ queued".
  expect(BOARD_TSX).toContain("⏸ queued");
});
