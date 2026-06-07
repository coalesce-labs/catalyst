// board-todo-column.test.ts — CTL-767 regression guard.
// Locks the Triage and Todo columns into the data layer + UI, and verifies
// that synthesizeQueuedTicket() produces the right shape for eligible-queue
// board cards.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PHASE_TO_LINEAR } from "../lib/board-data.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const boardSrc = readFileSync(join(HERE, "..", "ui", "src", "board", "Board.tsx"), "utf8");

// ── Requirement A: triage phase maps to "Triage", not "Research" ─────────────
test("PHASE_TO_LINEAR maps triage phase to 'Triage' column (not 'Research')", () => {
  expect(PHASE_TO_LINEAR.triage).toBe("Triage");
});

// ── Requirement B: PHASE_TO_LINEAR has queued → "Todo" for eligible synthesis ─
test("PHASE_TO_LINEAR has queued → 'Todo' for eligible queue synthesis", () => {
  expect(PHASE_TO_LINEAR.queued).toBe("Todo");
});

// ── Requirement C: Board.tsx LINEAR_COLS includes Triage and Todo columns ─────
test("Board.tsx LINEAR_COLS includes 'Triage' column key", () => {
  // Extract the LINEAR_COLS initializer and check it contains the Triage key
  const re = /const\s+LINEAR_COLS\b[^=]*=\s*\[[\s\S]*?\];/;
  const m = re.exec(boardSrc);
  expect(m).not.toBeNull();
  expect(m![0]).toContain('"Triage"');
});

test("Board.tsx LINEAR_COLS includes 'Todo' column key", () => {
  const re = /const\s+LINEAR_COLS\b[^=]*=\s*\[[\s\S]*?\];/;
  const m = re.exec(boardSrc);
  expect(m).not.toBeNull();
  expect(m![0]).toContain('"Todo"');
});

// ── Requirement D: synthesizeQueuedTicket shape ───────────────────────────────
test("synthesizeQueuedTicket produces a BoardTicket-compatible object with linearState 'Todo'", async () => {
  const mod = await import("../lib/board-data.mjs");
  const fn = (mod as Record<string, unknown>).synthesizeQueuedTicket as ((e: unknown, linfo: unknown) => Record<string, unknown>) | undefined;
  if (!fn) throw new Error("synthesizeQueuedTicket is not exported from board-data.mjs");

  const eligible = {
    id: "CTL-900", title: "Test ticket", priority: 2,
    createdAt: "2026-06-07T00:00:00Z", state: "Todo", repo: "catalyst", team: "CTL",
  };
  const linfo: Record<string, { priority?: number; estimate?: number | null; project?: string | null; labels?: string[] }> = {
    "CTL-900": { priority: 2, estimate: 3, project: null, labels: ["feature"] },
  };

  const t = fn(eligible, linfo);

  expect(t.id).toBe("CTL-900");
  expect(t.phase).toBe("queued");
  expect(t.linearState).toBe("Todo");
  expect(t.status).toBe("queued");
  expect(t.working).toBe(false);
  expect(t.workerStatus).toBeNull();
  expect(t.activeState).toBeNull();
  expect(t.phaseSummary).toEqual([]);
  expect(t.priority).toBe(2);
  expect(t.estimate).toBe(3);
  expect(t.held).toBeNull();
});

test("synthesizeQueuedTicket surfaces held state from linfo labels", async () => {
  const mod = await import("../lib/board-data.mjs");
  const fn = (mod as Record<string, unknown>).synthesizeQueuedTicket as ((e: unknown, linfo: unknown) => Record<string, unknown>) | undefined;
  if (!fn) throw new Error("synthesizeQueuedTicket not exported");

  const eligible = {
    id: "CTL-901", title: "Blocked ticket", priority: 1,
    createdAt: "2026-06-07T00:00:00Z", state: "Todo", repo: "catalyst", team: "CTL",
  };
  const linfo = { "CTL-901": { priority: 1, estimate: null, project: null, labels: ["blocked"] } };

  const t = fn(eligible, linfo);
  expect(t.held).toBe("blocked");
});
