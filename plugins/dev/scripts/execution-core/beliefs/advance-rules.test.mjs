// advance-rules.test.mjs — CTL-966 belief-store N4: the FSM advancement
// prediction beliefs (R16 advance_to, R17 cycle_exhausted) over the obs_signal +
// obs_verdict + obs_cycle EDB.
//
// THE PROOF (mirror contract): advance_to MUST equal deriveAdvancement(...) on
// every representative pipeline state. The fixture battery seeds obs_signal
// (+obs_verdict/obs_cycle) rows under one tick, runs evaluateBeliefs, and asserts
// the derived advance_to.value.to / cycle_exhausted match an INDEPENDENTLY
// HAND-COMPUTED expectation. The final cross-check block calls the REAL
// deriveAdvancement (imported from scheduler.mjs) with the SAME logical inputs and
// asserts belief.to === deriveAdvancement(...) (or both absent) — pinning the
// mirror so a future FSM/oracle edit that desyncs the belief fails loudly.
//
// DERIVE-ONLY: advance_to is a PREDICTION. These tests assert the belief value;
// nothing here dispatches, resets a cycle, or writes Linear (CTL-966 doctrine).

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openBeliefsDb } from "./schema.mjs";
import { evaluateBeliefs } from "./rules.mjs";
import { REMEDIATE_CYCLE_CAP, PHASES, NEXT_PHASE } from "../../lib/phase-fsm.mjs";
import { deriveAdvancement } from "../scheduler.mjs";

const NOW = 1781030108000;

const tmps = [];
function scratch() {
  const d = mkdtempSync(join(tmpdir(), "ctl966-advance-"));
  tmps.push(d);
  return d;
}
let db;
beforeEach(() => {
  db = openBeliefsDb({ path: join(scratch(), "b.db") });
});
afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  while (tmps.length) {
    try {
      rmSync(tmps.pop(), { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// ── fixture builders ─────────────────────────────────────────────────────────
function tick(now = NOW, host = "mini") {
  db.run("INSERT INTO tick (now_ms, host) VALUES (?, ?)", [now, host]);
  return db.query("SELECT last_insert_rowid() AS id").get().id;
}
function signal(tickId, ticket, phase, status) {
  db.run(
    "INSERT INTO obs_signal (tick_id, ticket, phase, status) VALUES (?, ?, ?, ?)",
    [tickId, ticket, phase, status],
  );
  return db.query("SELECT last_insert_rowid() AS id").get().id;
}
function verdict(tickId, ticket, v) {
  db.run("INSERT INTO obs_verdict (tick_id, ticket, verdict) VALUES (?, ?, ?)", [tickId, ticket, v]);
  return db.query("SELECT last_insert_rowid() AS id").get().id;
}
function cycle(tickId, ticket, n) {
  db.run("INSERT INTO obs_cycle (tick_id, ticket, remediate_count) VALUES (?, ?, ?)", [
    tickId,
    ticket,
    n,
  ]);
  return db.query("SELECT last_insert_rowid() AS id").get().id;
}

// seedSignals — write one obs_signal per (phase→status) entry of `sigMap` under a
// fresh tick, optionally a verdict + cycle row, evaluate beliefs, return tickId.
// `sigMap` is the SAME { phase: status } shape deriveAdvancement consumes.
function seed(sigMap, { ticket = "CTL-966", verdictVal, cycleCount } = {}) {
  const tickId = tick();
  for (const [phase, status] of Object.entries(sigMap)) signal(tickId, ticket, phase, status);
  if (verdictVal !== undefined) verdict(tickId, ticket, verdictVal);
  if (cycleCount !== undefined) cycle(tickId, ticket, cycleCount);
  evaluateBeliefs(db, tickId);
  return tickId;
}

// readers ─────────────────────────────────────────────────────────────────────
function advanceTo(tickId, ticket = "CTL-966") {
  const row = db
    .query("SELECT value FROM belief WHERE tick_id = ? AND name = 'advance_to' AND subject = ?")
    .get(tickId, ticket);
  return row ? JSON.parse(row.value) : null;
}
function cycleExhausted(tickId, ticket = "CTL-966") {
  const row = db
    .query("SELECT value FROM belief WHERE tick_id = ? AND name = 'cycle_exhausted' AND subject = ?")
    .get(tickId, ticket);
  return row ? JSON.parse(row.value) : null;
}
function advanceToProvenance(tickId, ticket = "CTL-966") {
  const row = db
    .query(
      "SELECT source_fact_ids FROM belief WHERE tick_id = ? AND name = 'advance_to' AND subject = ?",
    )
    .get(tickId, ticket);
  return row ? JSON.parse(row.source_fact_ids) : null;
}

// ── 1. each normal transition triage..monitor-deploy ──────────────────────────
describe("R16 advance_to — normal FSM transitions (latest done → successor)", () => {
  // build the cumulative-done prefix for each phase from the FSM order so the
  // fixture is derived from PHASES, not a hand-listed sequence.
  const order = PHASES; // triage..teardown
  for (let i = 0; i < order.length; i++) {
    const cur = order[i];
    const next = NEXT_PHASE[cur];
    const sigMap = {};
    for (let k = 0; k <= i; k++) sigMap[order[k]] = "done";
    if (next === "done") {
      // teardown done → terminal → NO advance (covered in the terminal block)
      continue;
    }
    test(`${cur} done (prefix) → advance_to.to = ${next}`, () => {
      const t = seed(sigMap);
      expect(advanceTo(t)).toEqual({ from: cur, to: next });
      // and it agrees with the oracle
      expect(advanceTo(t).to).toBe(deriveAdvancement(sigMap));
    });
  }

  test("monitor-deploy skipped → teardown (CTL-703 carve-out)", () => {
    const sigMap = {};
    for (const p of PHASES) {
      if (p === "teardown") break;
      sigMap[p] = p === "monitor-deploy" ? "skipped" : "done";
    }
    const t = seed(sigMap);
    expect(advanceTo(t)).toEqual({ from: "monitor-deploy", to: "teardown" });
    expect(advanceTo(t).to).toBe(deriveAdvancement(sigMap));
  });
});

// ── 2. terminal / no-advance cases ────────────────────────────────────────────
describe("R16 advance_to — no advance (terminal / not-eligible / already-dispatched)", () => {
  test("teardown done → NO belief (pipeline terminal)", () => {
    const sigMap = {};
    for (const p of PHASES) sigMap[p] = "done";
    const t = seed(sigMap);
    expect(advanceTo(t)).toBeNull();
    expect(deriveAdvancement(sigMap)).toBeNull();
  });

  test("latest phase running → NO belief (not eligible)", () => {
    const sigMap = { triage: "done", research: "running" };
    const t = seed(sigMap);
    expect(advanceTo(t)).toBeNull();
    expect(deriveAdvancement(sigMap)).toBeNull();
  });

  test("latest phase failed → NO belief", () => {
    const sigMap = { implement: "failed" };
    const t = seed(sigMap);
    expect(advanceTo(t)).toBeNull();
    expect(deriveAdvancement(sigMap)).toBeNull();
  });

  test("successor already dispatched → NO belief", () => {
    const sigMap = { research: "done", plan: "dispatched" };
    const t = seed(sigMap);
    expect(advanceTo(t)).toBeNull();
    expect(deriveAdvancement(sigMap)).toBeNull();
  });

  test("skipped on a NON monitor-deploy phase → NO belief (holds the slot)", () => {
    for (const sigMap of [{ implement: "skipped" }, { verify: "skipped" }, { triage: "done", research: "skipped" }]) {
      const t = seed(sigMap);
      expect(advanceTo(t)).toBeNull();
      expect(deriveAdvancement(sigMap)).toBeNull();
    }
  });

  test("no signals → NO belief", () => {
    const t = seed({});
    expect(advanceTo(t)).toBeNull();
    expect(deriveAdvancement({})).toBeNull();
  });
});

// ── 3. verify → review / remediate verdict routing ────────────────────────────
describe("R16 advance_to — verify verdict routing", () => {
  const base = { triage: "done", research: "done", plan: "done", implement: "done" };

  test("verify done, NO verdict row → review (absent verdict = conservative pass)", () => {
    const sigMap = { ...base, verify: "done" };
    const t = seed(sigMap); // no verdict row
    expect(advanceTo(t)).toEqual({ from: "verify", to: "review" });
    expect(advanceTo(t).to).toBe(deriveAdvancement(sigMap, { verifyVerdict: null }));
  });

  test("verify done, verdict pass → review", () => {
    const sigMap = { ...base, verify: "done" };
    const t = seed(sigMap, { verdictVal: "pass" });
    expect(advanceTo(t)).toEqual({ from: "verify", to: "review" });
    expect(advanceTo(t).to).toBe(deriveAdvancement(sigMap, { verifyVerdict: "pass" }));
  });

  test("verify done, verdict fail, cycle 0 (< cap) → remediate", () => {
    const sigMap = { ...base, verify: "done" };
    const t = seed(sigMap, { verdictVal: "fail", cycleCount: 0 });
    expect(advanceTo(t)).toEqual({ from: "verify", to: "remediate" });
    expect(advanceTo(t).to).toBe(
      deriveAdvancement(sigMap, { verifyVerdict: "fail", remediateCycleCount: 0 }),
    );
    expect(cycleExhausted(t)).toBeNull();
  });

  test("verify done, verdict fail, remediate already dispatched → NO advance (no double dispatch)", () => {
    const sigMap = { ...base, verify: "done", remediate: "running" };
    const t = seed(sigMap, { verdictVal: "fail", cycleCount: 0 });
    expect(advanceTo(t)).toBeNull();
    expect(
      deriveAdvancement(sigMap, { verifyVerdict: "fail", remediateCycleCount: 0 }),
    ).toBeNull();
  });

  test("remediate done signal is invisible to latest-selection → still verify-routed (verdict pass → review)", () => {
    const sigMap = { ...base, verify: "done", remediate: "done" };
    const t = seed(sigMap, { verdictVal: "pass" });
    expect(advanceTo(t)).toEqual({ from: "verify", to: "review" });
    expect(advanceTo(t).to).toBe(deriveAdvancement(sigMap, { verifyVerdict: "pass" }));
  });
});

// ── 4. THE HARD CASE: the remediate-cycle cap boundary ────────────────────────
describe("R17 cycle_exhausted + cap boundary (count == cap-1 advances; count == cap does not)", () => {
  const base = { triage: "done", research: "done", plan: "done", implement: "done", verify: "done" };

  test(`cycle == cap-1 (${REMEDIATE_CYCLE_CAP - 1}) → advance_to remediate, NO cycle_exhausted`, () => {
    const t = seed(base, { verdictVal: "fail", cycleCount: REMEDIATE_CYCLE_CAP - 1 });
    expect(advanceTo(t)).toEqual({ from: "verify", to: "remediate" });
    expect(cycleExhausted(t)).toBeNull();
    // oracle agreement at the boundary
    expect(advanceTo(t).to).toBe(
      deriveAdvancement(base, { verifyVerdict: "fail", remediateCycleCount: REMEDIATE_CYCLE_CAP - 1 }),
    );
  });

  test(`cycle == cap (${REMEDIATE_CYCLE_CAP}) → NO advance_to, cycle_exhausted fires`, () => {
    const t = seed(base, { verdictVal: "fail", cycleCount: REMEDIATE_CYCLE_CAP });
    expect(advanceTo(t)).toBeNull();
    expect(cycleExhausted(t)).toEqual({
      phase: "verify",
      remediate_count: REMEDIATE_CYCLE_CAP,
      cap: REMEDIATE_CYCLE_CAP,
    });
    // oracle: deriveAdvancement returns null at the cap (the sweep stalls it)
    expect(
      deriveAdvancement(base, { verifyVerdict: "fail", remediateCycleCount: REMEDIATE_CYCLE_CAP }),
    ).toBeNull();
  });

  test(`cycle > cap (${REMEDIATE_CYCLE_CAP + 1}) → NO advance_to, cycle_exhausted still fires`, () => {
    const t = seed(base, { verdictVal: "fail", cycleCount: REMEDIATE_CYCLE_CAP + 1 });
    expect(advanceTo(t)).toBeNull();
    expect(cycleExhausted(t)?.remediate_count).toBe(REMEDIATE_CYCLE_CAP + 1);
    expect(
      deriveAdvancement(base, { verifyVerdict: "fail", remediateCycleCount: REMEDIATE_CYCLE_CAP + 1 }),
    ).toBeNull();
  });

  test("verdict fail but verify NOT done (running) → neither belief (not advance-eligible)", () => {
    const sigMap = { ...base, verify: "running" };
    const t = seed(sigMap, { verdictVal: "fail", cycleCount: REMEDIATE_CYCLE_CAP });
    expect(advanceTo(t)).toBeNull();
    expect(cycleExhausted(t)).toBeNull();
    expect(
      deriveAdvancement(sigMap, { verifyVerdict: "fail", remediateCycleCount: REMEDIATE_CYCLE_CAP }),
    ).toBeNull();
  });

  test("verdict pass at cap → NO cycle_exhausted (cap only bites on a fail verdict)", () => {
    const t = seed(base, { verdictVal: "pass", cycleCount: REMEDIATE_CYCLE_CAP });
    expect(cycleExhausted(t)).toBeNull();
    expect(advanceTo(t)).toEqual({ from: "verify", to: "review" });
  });
});

// ── 5. provenance: advance_to cites the obs_signal / obs_verdict / obs_cycle facts
describe("R16 provenance", () => {
  test("remediate-arm advance_to cites the verify signal + verdict + cycle facts", () => {
    const base = { triage: "done", research: "done", plan: "done", implement: "done", verify: "done" };
    const t = seed(base, { verdictVal: "fail", cycleCount: 0 });
    const refs = advanceToProvenance(t);
    expect(Array.isArray(refs)).toBe(true);
    // one 's' (verify signal), one 'v' (verdict), one 'c' (cycle)
    expect(refs.some((r) => typeof r === "string" && r.startsWith("s"))).toBe(true);
    expect(refs.some((r) => typeof r === "string" && r.startsWith("v"))).toBe(true);
    expect(refs.some((r) => typeof r === "string" && r.startsWith("c"))).toBe(true);
  });

  test("normal-edge advance_to cites the latest done signal", () => {
    const t = seed({ triage: "done" });
    const refs = advanceToProvenance(t);
    expect(refs.some((r) => typeof r === "string" && r.startsWith("s"))).toBe(true);
  });
});

// ── 6. the cross-check battery — belief.to === deriveAdvancement(...) for a wide
// set of (signals, verdict, cycle) tuples. Each tuple's expectation is the REAL
// oracle, so this pins the mirror across the whole representative state space.
describe("CROSS-CHECK: advance_to.to === deriveAdvancement(...) for every fixture", () => {
  // Build the cumulative-done prefixes for the normal edges from the FSM order.
  const prefixCases = [];
  for (let i = 0; i < PHASES.length; i++) {
    const sigMap = {};
    for (let k = 0; k <= i; k++) sigMap[PHASES[k]] = "done";
    prefixCases.push({ sig: sigMap, opts: {} });
  }

  const fixtures = [
    ...prefixCases,
    // monitor-deploy skipped carve-out
    {
      sig: (() => {
        const m = {};
        for (const p of PHASES) {
          if (p === "teardown") break;
          m[p] = p === "monitor-deploy" ? "skipped" : "done";
        }
        return m;
      })(),
      opts: {},
    },
    // not-eligible / failed / already-dispatched
    { sig: { triage: "done", research: "running" }, opts: {} },
    { sig: { implement: "failed" }, opts: {} },
    { sig: { research: "done", plan: "dispatched" }, opts: {} },
    { sig: { implement: "skipped" }, opts: {} },
    { sig: { verify: "skipped" }, opts: {} },
    { sig: {}, opts: {} },
    // verdict routing
    { sig: { implement: "done", verify: "done" }, opts: { verifyVerdict: "pass" } },
    { sig: { implement: "done", verify: "done" }, opts: { verifyVerdict: null } },
    { sig: { implement: "done", verify: "done" }, opts: { verifyVerdict: "fail", remediateCycleCount: 0 } },
    {
      sig: { implement: "done", verify: "done", remediate: "running" },
      opts: { verifyVerdict: "fail", remediateCycleCount: 0 },
    },
    {
      sig: { implement: "done", verify: "done", remediate: "done" },
      opts: { verifyVerdict: "pass" },
    },
    // cap boundary
    {
      sig: { implement: "done", verify: "done" },
      opts: { verifyVerdict: "fail", remediateCycleCount: REMEDIATE_CYCLE_CAP - 1 },
    },
    {
      sig: { implement: "done", verify: "done" },
      opts: { verifyVerdict: "fail", remediateCycleCount: REMEDIATE_CYCLE_CAP },
    },
    {
      sig: { implement: "done", verify: "done" },
      opts: { verifyVerdict: "fail", remediateCycleCount: REMEDIATE_CYCLE_CAP + 2 },
    },
  ];

  for (const [idx, fx] of fixtures.entries()) {
    test(`fixture #${idx}: ${JSON.stringify(fx.sig)} | ${JSON.stringify(fx.opts)}`, () => {
      // Map the oracle opts onto the EDB facts the rule consumes:
      //   verifyVerdict → obs_verdict row (undefined/null → no row)
      //   remediateCycleCount → obs_cycle row (undefined → no row, rule COALESCEs 0)
      const seedOpts = {};
      if (fx.opts.verifyVerdict != null) seedOpts.verdictVal = fx.opts.verifyVerdict;
      if (fx.opts.remediateCycleCount !== undefined) seedOpts.cycleCount = fx.opts.remediateCycleCount;
      const t = seed(fx.sig, seedOpts);

      const oracle = deriveAdvancement(fx.sig, fx.opts);
      const belief = advanceTo(t);

      if (oracle === null) {
        // oracle owes nothing → advance_to must be ABSENT (the "remediate" oracle
        // value is the only non-phase string; null maps to no belief)
        expect(belief).toBeNull();
      } else if (oracle === "remediate") {
        expect(belief?.to).toBe("remediate");
      } else {
        // a normal next-phase string
        expect(belief?.to).toBe(oracle);
      }
    });
  }
});
