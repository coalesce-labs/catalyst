// preempt-budget.test.mjs — CTL-2192 Phase 3. Fully OFFLINE: the budget is a
// small JSON in the worker dir, read and written through injected clocks.
//
// The bug this bounds: scheduler.mjs deletes the in-memory hysteresis key after
// each successful preemption, so the same (preemptor, victim) pair restarts a
// fresh 30 s clock forever. `rankedAboveSince` is MODULE state, so even that
// within-lap memory is erased by a daemon bounce. The budget is the cross-lap
// bound, and it has to be DURABLE or it is just another rankedAboveSince.
//
// Run: cd plugins/dev/scripts/execution-core && bun test preempt-budget.test.mjs

import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PREEMPT_MAX_LAPS,
  PREEMPT_BUDGET_WINDOW_MS,
  readPreemptBudget,
  isPreemptBudgetExhausted,
  recordPreemption,
  preemptBudgetPath,
  preemptBudgetAlertPath,
  budgetExhaustionAnnounced,
  recordBudgetExhaustionAnnounced,
} from "./preempt-budget.mjs";

const T0 = 1_700_000_000_000;

function freshOrch() {
  const dir = mkdtempSync(join(tmpdir(), "preempt-budget-"));
  mkdirSync(join(dir, "workers", "CTL-1"), { recursive: true });
  return dir;
}

describe("constants", () => {
  test("defaults are the plan's chosen values and are env-overridable in shape", () => {
    expect(PREEMPT_MAX_LAPS).toBeGreaterThan(0);
    expect(Number.isInteger(PREEMPT_MAX_LAPS)).toBe(true);
    expect(PREEMPT_BUDGET_WINDOW_MS).toBeGreaterThan(0);
  });
});

describe("readPreemptBudget", () => {
  test("an ABSENT budget reads as a zero count with a null window", () => {
    const dir = freshOrch();
    const b = readPreemptBudget(dir, "CTL-1");
    expect(b.count).toBe(0);
    expect(b.windowStartedAt).toBe(null);
    expect(b.readable).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a CORRUPT budget reads as unreadable — never as a fresh zero", () => {
    // A zero from a corrupt file would silently restore the unbounded lap. The
    // caller must be able to tell "no preemptions yet" from "I could not look".
    const dir = freshOrch();
    writeFileSync(preemptBudgetPath(dir, "CTL-1"), "{{{not json");
    const b = readPreemptBudget(dir, "CTL-1");
    expect(b.readable).toBe(false);
    expect(b.count).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("non-numeric fields are rejected rather than coerced", () => {
    // Number(null) === 0 and Number([]) === 0, so an untyped coercion turns a
    // bogus field into "nothing spent yet" — the ledger disarmed by its own
    // corruption.
    const dir = freshOrch();
    writeFileSync(preemptBudgetPath(dir, "CTL-1"), JSON.stringify({ count: null, windowStartedAt: [] }));
    const b = readPreemptBudget(dir, "CTL-1");
    expect(b.readable).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a well-formed budget round-trips", () => {
    const dir = freshOrch();
    writeFileSync(preemptBudgetPath(dir, "CTL-1"), JSON.stringify({ count: 2, windowStartedAt: T0 }));
    const b = readPreemptBudget(dir, "CTL-1");
    expect(b).toMatchObject({ count: 2, windowStartedAt: T0, readable: true });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("isPreemptBudgetExhausted", () => {
  test("under the cap inside a live window → NOT exhausted", () => {
    const dir = freshOrch();
    writeFileSync(
      preemptBudgetPath(dir, "CTL-1"),
      JSON.stringify({ count: PREEMPT_MAX_LAPS - 1, windowStartedAt: T0 }),
    );
    expect(isPreemptBudgetExhausted(dir, "CTL-1", { now: () => T0 + 1000 }).exhausted).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("at the cap inside a live window → exhausted", () => {
    const dir = freshOrch();
    writeFileSync(preemptBudgetPath(dir, "CTL-1"), JSON.stringify({ count: PREEMPT_MAX_LAPS, windowStartedAt: T0 }));
    const v = isPreemptBudgetExhausted(dir, "CTL-1", { now: () => T0 + 1000 });
    expect(v.exhausted).toBe(true);
    expect(v.count).toBe(PREEMPT_MAX_LAPS);
    rmSync(dir, { recursive: true, force: true });
  });

  test("at the cap but PAST the window → not exhausted (damping, not a permanent exemption)", () => {
    const dir = freshOrch();
    writeFileSync(preemptBudgetPath(dir, "CTL-1"), JSON.stringify({ count: 99, windowStartedAt: T0 }));
    expect(
      isPreemptBudgetExhausted(dir, "CTL-1", { now: () => T0 + PREEMPT_BUDGET_WINDOW_MS + 1 }).exhausted,
    ).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("⛔ NEGATIVE CONTROL: a victim that has NEVER been preempted is never exhausted", () => {
    // Without this, a fix that simply disables preemption outright would pass
    // every "the lap stopped" assertion.
    const dir = freshOrch();
    expect(isPreemptBudgetExhausted(dir, "CTL-1", { now: () => T0 }).exhausted).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("an UNREADABLE ledger does not exhaust the budget (fail toward today's behaviour)", () => {
    // The bound is a damper on a working mechanism, not a safety interlock:
    // failing closed here would let one corrupt file freeze priority preemption
    // for a ticket indefinitely.
    const dir = freshOrch();
    writeFileSync(preemptBudgetPath(dir, "CTL-1"), "garbage");
    const v = isPreemptBudgetExhausted(dir, "CTL-1", { now: () => T0 });
    expect(v.exhausted).toBe(false);
    expect(v.readable).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("recordPreemption", () => {
  test("the FIRST preemption opens a window at count 1", () => {
    const dir = freshOrch();
    const b = recordPreemption(dir, "CTL-1", { now: () => T0 });
    expect(b).toMatchObject({ count: 1, windowStartedAt: T0 });
    expect(readPreemptBudget(dir, "CTL-1")).toMatchObject({ count: 1, windowStartedAt: T0 });
    rmSync(dir, { recursive: true, force: true });
  });

  test("later preemptions inside the window increment WITHOUT moving the window", () => {
    // A window that slid forward on every write could never expire under a
    // sustained lap — the bound would be unreachable exactly when it matters.
    const dir = freshOrch();
    recordPreemption(dir, "CTL-1", { now: () => T0 });
    recordPreemption(dir, "CTL-1", { now: () => T0 + 60_000 });
    const b = recordPreemption(dir, "CTL-1", { now: () => T0 + 120_000 });
    expect(b.count).toBe(3);
    expect(b.windowStartedAt).toBe(T0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a preemption past the window starts a FRESH window at count 1", () => {
    const dir = freshOrch();
    recordPreemption(dir, "CTL-1", { now: () => T0 });
    const later = T0 + PREEMPT_BUDGET_WINDOW_MS + 1;
    const b = recordPreemption(dir, "CTL-1", { now: () => later });
    expect(b).toMatchObject({ count: 1, windowStartedAt: later });
    rmSync(dir, { recursive: true, force: true });
  });

  test("a corrupt ledger is REPLACED by a fresh window rather than incremented from a bogus base", () => {
    const dir = freshOrch();
    writeFileSync(preemptBudgetPath(dir, "CTL-1"), "not json");
    const b = recordPreemption(dir, "CTL-1", { now: () => T0 });
    expect(b).toMatchObject({ count: 1, windowStartedAt: T0 });
    rmSync(dir, { recursive: true, force: true });
  });

  test("the write is atomic (tmp+rename) and leaves no .tmp residue", () => {
    const dir = freshOrch();
    recordPreemption(dir, "CTL-1", { now: () => T0 });
    const files = readdirSync(join(dir, "workers", "CTL-1"));
    expect(files.some((f) => f.includes(".tmp"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("an unwritable worker dir is swallowed — the budget is a damper, never a gate", () => {
    const dir = freshOrch();
    // No workers/CTL-404 dir at all; recordPreemption must not throw.
    expect(() => recordPreemption(dir, "CTL-404", { now: () => T0 })).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  test("DURABILITY: the ledger survives a simulated daemon bounce (it is a file, not module state)", () => {
    // rankedAboveSince is module state and a bounce erases it. The whole point
    // of this ledger is that it does not.
    const dir = freshOrch();
    for (let i = 0; i < PREEMPT_MAX_LAPS; i++) recordPreemption(dir, "CTL-1", { now: () => T0 + i });
    // Nothing in-process is consulted here — a fresh read off disk sees the cap.
    expect(isPreemptBudgetExhausted(dir, "CTL-1", { now: () => T0 + 1000 }).exhausted).toBe(true);
    expect(existsSync(preemptBudgetPath(dir, "CTL-1"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("the ledger lives in the ticket's worker dir, so it is GC'd with the ticket", () => {
    const dir = freshOrch();
    expect(preemptBudgetPath(dir, "CTL-1")).toBe(join(dir, "workers", "CTL-1", ".preempt-budget.json"));
    rmSync(dir, { recursive: true, force: true });
  });

  test("round trip: exhausted after MAX laps, preemptable again after the window", () => {
    const dir = freshOrch();
    for (let i = 0; i < PREEMPT_MAX_LAPS; i++) recordPreemption(dir, "CTL-1", { now: () => T0 });
    expect(isPreemptBudgetExhausted(dir, "CTL-1", { now: () => T0 }).exhausted).toBe(true);
    expect(
      isPreemptBudgetExhausted(dir, "CTL-1", { now: () => T0 + PREEMPT_BUDGET_WINDOW_MS + 1 }).exhausted,
    ).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("once-per-window announcement guard", () => {
  test("the first announcement for a window is not yet recorded; the second is", () => {
    const dir = freshOrch();
    expect(budgetExhaustionAnnounced(dir, "CTL-1", T0)).toBe(false);
    expect(recordBudgetExhaustionAnnounced(dir, "CTL-1", T0)).toBe(true);
    expect(budgetExhaustionAnnounced(dir, "CTL-1", T0)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a NEW window announces again — the guard is keyed on the window, not a timestamp", () => {
    const dir = freshOrch();
    recordBudgetExhaustionAnnounced(dir, "CTL-1", T0);
    expect(budgetExhaustionAnnounced(dir, "CTL-1", T0 + PREEMPT_BUDGET_WINDOW_MS + 1)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("an absent or malformed marker reads as NOT announced (missing an alert beats repeating one)", () => {
    const dir = freshOrch();
    expect(budgetExhaustionAnnounced(dir, "CTL-1", T0)).toBe(false);
    writeFileSync(preemptBudgetAlertPath(dir, "CTL-1"), "garbage");
    expect(budgetExhaustionAnnounced(dir, "CTL-1", T0)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("an unwritable dir is swallowed", () => {
    const dir = freshOrch();
    expect(recordBudgetExhaustionAnnounced(dir, "CTL-404", T0)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
