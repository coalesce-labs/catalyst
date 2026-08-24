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
  // CTL-2192 (remediation): the preemptor-side bound.
  PREEMPTOR_MAX_LAPS,
  preemptorBudgetPath,
  isPreemptorBudgetExhausted,
  recordPreemptorLap,
  preemptorExhaustionAnnounced,
  recordPreemptorExhaustionAnnounced,
  prunePreemptorBudgets,
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

// ─── CTL-2192 (remediation): the PREEMPTOR-side bound ───────────────────────
//
// The victim budget bounds ONE victim, not the storm. scheduler.mjs scans
// inFlightRanked worst-ranked-first and only `break`s when topQueued stops
// out-ranking the candidate, so an exhausted victim hands the preemption to the
// next, BETTER-ranked in-flight worker. A preemptor that wins the ranking but
// can never dispatch (the CTC-829 / CTL-1550 / CTL-1681 shape this fleet has hit
// three times) therefore burns victim A's laps, then B's, then C's — evicting
// progressively more valuable work. maxLaps x |victims|, not maxLaps.
describe("preemptor budget (CTL-2192 remediation)", () => {
  function orchOnly() {
    return mkdtempSync(join(tmpdir(), "preemptor-budget-"));
  }

  test("the ledger does NOT live in workers/<ticket>/", () => {
    // Load-bearing: a preemptor is BY DEFINITION a ticket with no worker dir
    // (buildGlobalRanking's queued descriptors are exactly the eligible tickets
    // not in listStartedTickets). Creating one to hold the ledger would make
    // listStartedTickets read the ticket as in-flight — a damper that
    // manufactures a phantom dispatch.
    const dir = orchOnly();
    expect(preemptorBudgetPath(dir, "CTL-9")).not.toContain(join("workers", "CTL-9"));
    expect(preemptorBudgetPath(dir, "CTL-9")).toBe(join(dir, ".preempt-budget", "CTL-9.json"));
    rmSync(dir, { recursive: true, force: true });
  });

  test("records laps and exhausts at PREEMPTOR_MAX_LAPS inside the window — with no worker dir present", () => {
    const dir = orchOnly();
    expect(existsSync(join(dir, "workers"))).toBe(false);
    for (let i = 0; i < PREEMPTOR_MAX_LAPS; i++) {
      const r = recordPreemptorLap(dir, "CTL-9", { now: () => T0 + i * 1000 });
      expect(r.written).toBe(true); // the dir is created on demand
    }
    expect(isPreemptorBudgetExhausted(dir, "CTL-9", { now: () => T0 + 5000 }).exhausted).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("⛔ negative control — a preemptor that has never preempted is NOT exhausted", () => {
    const dir = orchOnly();
    expect(isPreemptorBudgetExhausted(dir, "CTL-9", { now: () => T0 }).exhausted).toBe(false);
    // …and one lap short of the cap is still allowed.
    for (let i = 0; i < PREEMPTOR_MAX_LAPS - 1; i++) recordPreemptorLap(dir, "CTL-9", { now: () => T0 + i });
    expect(isPreemptorBudgetExhausted(dir, "CTL-9", { now: () => T0 + 100 }).exhausted).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("expiry — the bound is DAMPING, not a permanent exemption", () => {
    const dir = orchOnly();
    for (let i = 0; i < PREEMPTOR_MAX_LAPS; i++) recordPreemptorLap(dir, "CTL-9", { now: () => T0 + i });
    expect(isPreemptorBudgetExhausted(dir, "CTL-9", { now: () => T0 + PREEMPT_BUDGET_WINDOW_MS + 1 }).exhausted).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("durable across a simulated daemon bounce (it is a FILE, not module state)", () => {
    const dir = orchOnly();
    for (let i = 0; i < PREEMPTOR_MAX_LAPS; i++) recordPreemptorLap(dir, "CTL-9", { now: () => T0 + i });
    // Nothing in-process is consulted: a fresh read of the same path answers.
    expect(readPreemptBudget(dir, "CTL-9", { pathFor: preemptorBudgetPath }).count).toBe(PREEMPTOR_MAX_LAPS);
    rmSync(dir, { recursive: true, force: true });
  });

  test("victim and preemptor ledgers are INDEPENDENT — one cannot be read for the other", () => {
    const dir = orchOnly();
    mkdirSync(join(dir, "workers", "CTL-1"), { recursive: true });
    for (let i = 0; i < PREEMPT_MAX_LAPS; i++) recordPreemption(dir, "CTL-1", { now: () => T0 + i });
    expect(isPreemptBudgetExhausted(dir, "CTL-1", { now: () => T0 + 10 }).exhausted).toBe(true);
    // The same ticket id has spent NOTHING as a preemptor.
    expect(isPreemptorBudgetExhausted(dir, "CTL-1", { now: () => T0 + 10 }).exhausted).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("⛔ an unsafe ticket id never becomes a path component, and reads INCONCLUSIVE not zero", () => {
    const dir = orchOnly();
    for (const bad of ["../escape", "a/b", "", ".hidden"]) {
      expect(preemptorBudgetPath(dir, bad)).toBe(null);
      // Unresolvable path => readable:false => fails toward today's behaviour
      // (preemption allowed), and NEVER toward a confident fresh zero.
      const v = isPreemptorBudgetExhausted(dir, bad, { now: () => T0 });
      expect(v.readable).toBe(false);
      expect(v.exhausted).toBe(false);
      expect(recordPreemptorLap(dir, bad, { now: () => T0 }).written).toBe(false);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("the announcement is once per WINDOW, keyed on the window anchor", () => {
    const dir = orchOnly();
    expect(preemptorExhaustionAnnounced(dir, "CTL-9", T0)).toBe(false);
    expect(recordPreemptorExhaustionAnnounced(dir, "CTL-9", T0)).toBe(true);
    expect(preemptorExhaustionAnnounced(dir, "CTL-9", T0)).toBe(true);
    // A NEW window announces again.
    expect(preemptorExhaustionAnnounced(dir, "CTL-9", T0 + 999)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("the ledger self-prunes — it has no worker dir to be GC'd with", () => {
    const dir = orchOnly();
    recordPreemptorLap(dir, "CTL-9", { now: () => T0 });
    expect(existsSync(preemptorBudgetPath(dir, "CTL-9"))).toBe(true);
    // Not yet: the entry is younger than 2x the window (mtime is real "now").
    prunePreemptorBudgets(dir, { now: () => Date.now() });
    expect(existsSync(preemptorBudgetPath(dir, "CTL-9"))).toBe(true);
    // Far enough in the future, it goes.
    const res = prunePreemptorBudgets(dir, { now: () => Date.now() + PREEMPT_BUDGET_WINDOW_MS * 3 });
    expect(res.pruned).toBeGreaterThan(0);
    expect(existsSync(preemptorBudgetPath(dir, "CTL-9"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("pruning an absent directory is a no-op, never a throw", () => {
    const dir = orchOnly();
    expect(() => prunePreemptorBudgets(dir, { now: () => Date.now() })).not.toThrow();
    expect(prunePreemptorBudgets(dir, { now: () => Date.now() }).pruned).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ─── CTL-2192 (remediation): an UNPERSISTED lap must be observable ──────────
describe("recordPreemption reports NON-DURABILITY rather than swallowing it", () => {
  test("⛔ an unwritable ledger returns written:false — the caller can announce it", () => {
    // The module fails toward today's behaviour on purpose (a damper is not a
    // safety interlock), but an unpersisted lap means the count reads zero
    // forever and the unbounded lap resumes with NO signal at all. The module's
    // own contract test asserted only not.toThrow(), never written === false —
    // so the field existed and nothing could have noticed if it stopped working.
    const dir = mkdtempSync(join(tmpdir(), "preempt-budget-nowrite-"));
    // No workers/CTL-1 dir at all => the write cannot land.
    const r = recordPreemption(dir, "CTL-1", { now: () => T0 });
    expect(r.written).toBe(false);
    // …and the count it would have written is still reported, so the caller can
    // log what was lost.
    expect(r.count).toBe(1);
    // The damper is now silently disarmed — this is the fact worth announcing.
    expect(isPreemptBudgetExhausted(dir, "CTL-1", { now: () => T0 }).count).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("positive control — a writable ledger reports written:true", () => {
    const dir = freshOrch();
    expect(recordPreemption(dir, "CTL-1", { now: () => T0 }).written).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
