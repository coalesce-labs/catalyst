// linear-write-headroom.test.mjs — CTL-2027 Phase 2.
//
// Ask 2: publish Linear write-budget headroom "beside slotFree" on the board scan —
// the same place free slots are posted. `checkLinearWriteBudget` (write-budget-
// health.mjs) already answers this, but only when an operator runs `catalyst
// doctor` — it is a doctor-shaped check (mkCheck), not a reusable evaluator, so
// board-health could not call it without either importing a doctor check or
// hand-rolling a third copy of the same arithmetic. This module is that shared,
// zero-IO evaluator: both write-budget-health.mjs and board-health.mjs call it.
//
// Run: cd plugins/dev/scripts/execution-core && bun test linear-write-headroom.test.mjs

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { evaluateLinearWriteHeadroom, resolveWriteBudgetCaps, LINEAR_WRITE_HEADROOM_DEFAULTS } from "./linear-write-headroom.mjs";
import { resolveWriteBudgetCaps as proxyResolveWriteBudgetCaps } from "./linear-write-proxy.mjs";
import { utcDayOf } from "./linear-write-budget.mjs";

const NOW = Date.parse("2026-08-22T04:00:00Z");
const TODAY = utcDayOf(NOW);
const CAPS = { dailyBudget: 300, perTicketCap: 50 };

describe("evaluateLinearWriteHeadroom — pure, three-valued", () => {
  test("a healthy ledger reports ok with a shape of {state, remaining, remainingPct}", () => {
    // No per-ticket spend at all → the DAY total is the binding constraint.
    const r = evaluateLinearWriteHeadroom({
      ledger: { day: TODAY, total: 4, byTicket: {} },
      caps: CAPS,
      now: NOW,
    });
    expect(r).toMatchObject({ state: "ok", remaining: 296, remainingPct: expect.any(Number) });
  });

  test("the MORE CONSTRAINED of day-vs-ticket headroom is what's reported (per-ticket binds here)", () => {
    // Same host total, but this time it is all on ONE ticket — the per-ticket
    // limit (50) binds before the daily one (300) does.
    const r = evaluateLinearWriteHeadroom({
      ledger: { day: TODAY, total: 4, byTicket: { "CTL-1": 4 } },
      caps: CAPS,
      now: NOW,
    });
    expect(r).toMatchObject({ state: "ok", remaining: 46, remainingPct: 92 });
  });

  test("state is always one of ok|warn|capped|unknown", () => {
    const cases = [
      { day: TODAY, total: 0, byTicket: {} }, // ok
      { day: TODAY, total: 285, byTicket: {} }, // warn (95% of daily spent)
      { day: TODAY, total: 300, byTicket: {} }, // capped
    ];
    for (const ledger of cases) {
      const r = evaluateLinearWriteHeadroom({ ledger, caps: CAPS, now: NOW });
      expect(["ok", "warn", "capped", "unknown"]).toContain(r.state);
    }
    expect(evaluateLinearWriteHeadroom({ ledger: null, caps: CAPS, now: NOW }).state).toBe("unknown");
  });

  test("a per-ticket cap breach is CAPPED even when the host total is nowhere near exhausted", () => {
    // The live storm this ticket documents: CTL-2015 at its per-ticket cap while
    // the host as a whole has plenty of daily budget left.
    const r = evaluateLinearWriteHeadroom({
      ledger: { day: TODAY, total: 60, byTicket: { "CTL-2015": 50 } },
      caps: CAPS,
      now: NOW,
    });
    expect(r.state).toBe("capped");
    expect(r.remaining).toBe(0);
  });
});

describe("evaluateLinearWriteHeadroom — absent/unusable/stale ledgers report UNKNOWN, never ok", () => {
  test("absent ledger (null) → unknown", () => {
    expect(evaluateLinearWriteHeadroom({ ledger: null, caps: CAPS, now: NOW })).toMatchObject({
      state: "unknown",
      remaining: null,
      remainingPct: null,
    });
  });

  test("unparseable ledger (not an object — the shape a failed JSON.parse leaves a caller with) → unknown", () => {
    expect(evaluateLinearWriteHeadroom({ ledger: "not json", caps: CAPS, now: NOW }).state).toBe("unknown");
  });

  test("a ledger from a PREVIOUS UTC day → unknown (the caller must roll before calling, never this leaf)", () => {
    const r = evaluateLinearWriteHeadroom({
      ledger: { day: "2026-08-21", total: 5, byTicket: {} },
      caps: CAPS,
      now: NOW, // "today" is 2026-08-22
    });
    expect(r.state).toBe("unknown");
  });

  test("a ledger missing the counter field (`total`) → unknown", () => {
    const r = evaluateLinearWriteHeadroom({
      ledger: { day: TODAY, byTicket: {} },
      caps: CAPS,
      now: NOW,
    });
    expect(r.state).toBe("unknown");
  });

  test("POSITIVE CONTROL: the SAME shape with `total` present is NOT unknown — proving the missing-field case really bites", () => {
    const r = evaluateLinearWriteHeadroom({
      ledger: { day: TODAY, total: 0, byTicket: {} },
      caps: CAPS,
      now: NOW,
    });
    expect(r.state).not.toBe("unknown");
  });

  test("missing/invalid caps → unknown (a zero or negative cap must not be silently accepted)", () => {
    const ledger = { day: TODAY, total: 4, byTicket: {} };
    expect(evaluateLinearWriteHeadroom({ ledger, caps: {}, now: NOW }).state).toBe("unknown");
    expect(evaluateLinearWriteHeadroom({ ledger, caps: { dailyBudget: 0, perTicketCap: 50 }, now: NOW }).state).toBe(
      "unknown"
    );
    expect(evaluateLinearWriteHeadroom({ ledger, caps: { dailyBudget: 300, perTicketCap: -1 }, now: NOW }).state).toBe(
      "unknown"
    );
  });
});

describe("evaluateLinearWriteHeadroom — boundary arithmetic", () => {
  test("at total = 301 against a 300 budget: capped, remaining is 0, NOT -1", () => {
    const r = evaluateLinearWriteHeadroom({
      ledger: { day: TODAY, total: 301, byTicket: {} },
      caps: CAPS,
      now: NOW,
    });
    expect(r.state).toBe("capped");
    expect(r.remaining).toBe(0);
  });

  test("one unit BELOW the cap is not yet capped (boundary is >=, not >)", () => {
    const r = evaluateLinearWriteHeadroom({
      ledger: { day: TODAY, total: 299, byTicket: {} },
      caps: CAPS,
      now: NOW,
    });
    expect(r.state).not.toBe("capped");
    expect(r.remaining).toBe(1);
  });

  test("exactly AT the cap is capped", () => {
    const r = evaluateLinearWriteHeadroom({
      ledger: { day: TODAY, total: 300, byTicket: {} },
      caps: CAPS,
      now: NOW,
    });
    expect(r.state).toBe("capped");
    expect(r.remaining).toBe(0);
  });
});

describe("resolveWriteBudgetCaps — cap resolution MATCHES the proxy's own resolver (no re-typed literal)", () => {
  test("it is literally the proxy's resolver, re-exported — not a second implementation", () => {
    expect(resolveWriteBudgetCaps).toBe(proxyResolveWriteBudgetCaps);
  });

  test("env overrides resolve identically through both import paths", () => {
    const env = { CATALYST_LINEAR_WRITE_DAILY_BUDGET: "2000", CATALYST_LINEAR_WRITE_TICKET_CAP: "77" };
    expect(resolveWriteBudgetCaps(env)).toEqual(proxyResolveWriteBudgetCaps(env));
    expect(resolveWriteBudgetCaps(env)).toEqual({ dailyBudget: 2000, perTicketCap: 77 });
  });

  test("an invalid override (non-positive) falls back to the default on both paths identically", () => {
    const env = { CATALYST_LINEAR_WRITE_DAILY_BUDGET: "-5" };
    expect(resolveWriteBudgetCaps(env)).toEqual(proxyResolveWriteBudgetCaps(env));
  });
});

describe("LINEAR_WRITE_HEADROOM_DEFAULTS.warnPct is a finite positive number", () => {
  test("has a sane default", () => {
    expect(Number.isFinite(LINEAR_WRITE_HEADROOM_DEFAULTS.warnPct)).toBe(true);
    expect(LINEAR_WRITE_HEADROOM_DEFAULTS.warnPct).toBeGreaterThan(0);
  });
});

// ── No IO in the leaf ──────────────────────────────────────────────────────────
describe("linear-write-headroom.mjs is a zero-IO leaf", () => {
  const SRC = readFileSync(join(import.meta.dir, "linear-write-headroom.mjs"), "utf8");

  test("the module source performs no filesystem/subprocess IO of its own", () => {
    expect(SRC).not.toMatch(/readFileSync|writeFileSync|existsSync|spawnSync|spawn\(/);
  });

  test("the ledger is PASSED IN — the evaluator never resolves its own path", () => {
    expect(SRC).not.toContain("defaultBudgetPath()");
  });

  test("importable under BARE NODE (not bun) — matches the lib/ zero-npm-import discipline", () => {
    const out = execFileSync(
      process.execPath,
      ["-e", 'import("./linear-write-headroom.mjs").then(() => console.log("OK")).catch((e) => { console.error(e); process.exit(1); })'],
      { cwd: import.meta.dir, encoding: "utf8" }
    );
    expect(out.trim()).toBe("OK");
  });
});
