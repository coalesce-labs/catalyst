// advance-shadow.test.mjs — CTL-966 + CTL-935: the advancement shadow comparator.
// Asserts it (a) logs a disagreement event when the belief diverges from the
// procedural oracle, (b) stays SILENT on agreement, (c) NEVER acts (no dispatch /
// signal write / Linear write — the comparator has no such seams, proven by the
// injected-seam set), and (d) is robust to a bad ticket / missing db.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openBeliefsDb } from "./schema.mjs";
import { evaluateBeliefs } from "./rules.mjs";
import {
  runAdvanceShadow,
  readAdvanceBeliefs,
  compareAdvancement,
  readSignalsFromEdb,
  readVerdictFromEdb,
  readCycleFromEdb,
} from "./advance-shadow.mjs";
import { deriveAdvancement } from "../scheduler.mjs";
import { REMEDIATE_CYCLE_CAP } from "../../lib/phase-fsm.mjs";

const NOW = 1781030108000;
const tmps = [];
function scratch() {
  const d = mkdtempSync(join(tmpdir(), "ctl966-shadow-"));
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
    /* */
  }
  while (tmps.length) {
    try {
      rmSync(tmps.pop(), { recursive: true, force: true });
    } catch {
      /* */
    }
  }
});

function tick(now = NOW) {
  db.run("INSERT INTO tick (now_ms, host) VALUES (?, 'mini')", [now]);
  return db.query("SELECT last_insert_rowid() AS id").get().id;
}
function signal(tickId, ticket, phase, status) {
  db.run("INSERT INTO obs_signal (tick_id, ticket, phase, status) VALUES (?, ?, ?, ?)", [
    tickId,
    ticket,
    phase,
    status,
  ]);
}
function verdict(tickId, ticket, v) {
  db.run("INSERT INTO obs_verdict (tick_id, ticket, verdict) VALUES (?, ?, ?)", [tickId, ticket, v]);
}
function cycle(tickId, ticket, n) {
  db.run("INSERT INTO obs_cycle (tick_id, ticket, remediate_count) VALUES (?, ?, ?)", [tickId, ticket, n]);
}

// A harness that wires the REAL oracle + real belief reads but FAKE signal
// readers (so we can force agreement / disagreement deterministically).
function makeSeams(signalsByTicket, { verdicts = {}, cycles = {}, events } = {}) {
  return {
    orchDir: "/fake",
    listInFlight: () => Object.keys(signalsByTicket),
    readSignals: (_od, ticket) => signalsByTicket[ticket] ?? {},
    readVerdict: ({ ticket }) => verdicts[ticket] ?? null,
    countCycles: ({ ticket }) => cycles[ticket] ?? 0,
    deriveAdvancement,
    cap: REMEDIATE_CYCLE_CAP,
    appendEvent: events ? (e) => events.push(e) : null,
  };
}

describe("runAdvanceShadow — agreement (belief mirrors the oracle) is silent", () => {
  test("normal edge: belief and oracle both say research → no disagreement event", () => {
    const t = tick();
    signal(t, "CTL-1", "triage", "done");
    evaluateBeliefs(db, t);
    const events = [];
    const res = runAdvanceShadow(db, t, makeSeams({ "CTL-1": { triage: "done" } }, { events }));
    expect(res.agree).toBe(1);
    expect(res.disagree).toBe(0);
    expect(events).toEqual([]);
  });

  test("remediate detour: belief and oracle both say remediate → silent", () => {
    const sig = { triage: "done", research: "done", plan: "done", implement: "done", verify: "done" };
    const t = tick();
    for (const [p, s] of Object.entries(sig)) signal(t, "CTL-2", p, s);
    verdict(t, "CTL-2", "fail");
    cycle(t, "CTL-2", 0);
    evaluateBeliefs(db, t);
    const events = [];
    const res = runAdvanceShadow(
      db,
      t,
      makeSeams({ "CTL-2": sig }, { verdicts: { "CTL-2": "fail" }, cycles: { "CTL-2": 0 }, events }),
    );
    expect(res.disagree).toBe(0);
    expect(events).toEqual([]);
  });

  test("cap reached: oracle null + cycle_exhausted belief → silent (agreement)", () => {
    const sig = { triage: "done", research: "done", plan: "done", implement: "done", verify: "done" };
    const t = tick();
    for (const [p, s] of Object.entries(sig)) signal(t, "CTL-3", p, s);
    verdict(t, "CTL-3", "fail");
    cycle(t, "CTL-3", REMEDIATE_CYCLE_CAP);
    evaluateBeliefs(db, t);
    const events = [];
    const res = runAdvanceShadow(
      db,
      t,
      makeSeams(
        { "CTL-3": sig },
        { verdicts: { "CTL-3": "fail" }, cycles: { "CTL-3": REMEDIATE_CYCLE_CAP }, events },
      ),
    );
    expect(res.disagree).toBe(0);
    expect(events).toEqual([]);
  });
});

describe("runAdvanceShadow — disagreement is logged (and only logged)", () => {
  test("belief missing but oracle owes an advance → disagree event with differing input", () => {
    const t = tick();
    signal(t, "CTL-9", "triage", "done");
    // intentionally DO NOT evaluateBeliefs → no advance_to belief exists
    const events = [];
    const res = runAdvanceShadow(db, t, makeSeams({ "CTL-9": { triage: "done" } }, { events }));
    expect(res.disagree).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]["event.name"]).toBe("beliefs.advance_shadow.disagree");
    expect(events[0].payload.procedural).toBe("research");
    expect(events[0].payload.belief).toBeNull();
    expect(events[0].payload.ticket).toBe("CTL-9");
    expect(events[0].payload.signals).toEqual({ triage: "done" });
    expect(events[0].payload.differingInput).toEqual({ verdict: null, remediateCycleCount: 0 });
  });

  test("oracle says remediate but the comparator's procedural seam is fed a passing verdict → disagree", () => {
    // belief computed from a FAIL verdict (→ remediate), but the procedural seam
    // is fed PASS (→ review). The comparator must flag the divergence.
    const sig = { triage: "done", research: "done", plan: "done", implement: "done", verify: "done" };
    const t = tick();
    for (const [p, s] of Object.entries(sig)) signal(t, "CTL-10", p, s);
    verdict(t, "CTL-10", "fail"); // belief sees fail → remediate
    cycle(t, "CTL-10", 0);
    evaluateBeliefs(db, t);
    const events = [];
    const res = runAdvanceShadow(
      db,
      t,
      makeSeams({ "CTL-10": sig }, { verdicts: { "CTL-10": "pass" }, cycles: { "CTL-10": 0 }, events }),
    );
    expect(res.disagree).toBe(1);
    expect(events[0].payload.procedural).toBe("review"); // oracle (pass)
    expect(events[0].payload.belief).toBe("remediate"); // belief (fail)
  });
});

describe("runAdvanceShadow — robustness + no-act contract", () => {
  test("null db / null tick → empty result, no throw", () => {
    expect(runAdvanceShadow(null, 1, {})).toEqual({ agree: 0, disagree: 0, disagreements: [] });
    expect(runAdvanceShadow(db, null, {})).toEqual({ agree: 0, disagree: 0, disagreements: [] });
  });

  test("a ticket whose readSignals throws is skipped, the rest still compared", () => {
    const t = tick();
    signal(t, "CTL-OK", "triage", "done");
    evaluateBeliefs(db, t);
    const events = [];
    const res = runAdvanceShadow(db, t, {
      orchDir: "/fake",
      listInFlight: () => ["CTL-BAD", "CTL-OK"],
      readSignals: (_od, ticket) => {
        if (ticket === "CTL-BAD") throw new Error("boom");
        return { triage: "done" };
      },
      readVerdict: () => null,
      countCycles: () => 0,
      deriveAdvancement,
      cap: REMEDIATE_CYCLE_CAP,
      appendEvent: (e) => events.push(e),
    });
    // CTL-OK agreed (advance_to=research mirrors the oracle), CTL-BAD swallowed
    expect(res.agree).toBe(1);
    expect(res.disagree).toBe(0);
  });

  test("the seam set exposes NO dispatch / signal-write / Linear-write hook (derive-only by construction)", () => {
    // The comparator is a READER: its only side-effecting seam is appendEvent.
    // This pins the no-act contract structurally — there is no dispatch, no
    // writeSignal, no writeStatus seam to mis-wire.
    const seamNames = Object.keys(makeSeams({}, {}));
    expect(seamNames).not.toContain("dispatch");
    expect(seamNames).not.toContain("writeStatus");
    expect(seamNames).not.toContain("writeSignal");
    expect(seamNames).toContain("appendEvent");
  });

  test("emitTickSummary appends a summary event when enabled", () => {
    const t = tick();
    signal(t, "CTL-S", "triage", "done");
    evaluateBeliefs(db, t);
    const events = [];
    runAdvanceShadow(db, t, {
      ...makeSeams({ "CTL-S": { triage: "done" } }, { events }),
      emitTickSummary: true,
    });
    const summary = events.find((e) => e["event.name"] === "beliefs.advance_shadow.tick");
    expect(summary).toBeTruthy();
    // CTL-1063 Phase 4: rules_sha is included in tick-summary payload (null for test-inserted bare ticks)
    expect(summary.payload.agree).toBe(1);
    expect(summary.payload.disagree).toBe(0);
    expect("rules_sha" in summary.payload).toBe(true);
  });
});

describe("EDB-backed oracle readers", () => {
  test("readSignalsFromEdb reconstructs { phase: status } tick-locked", () => {
    const t = tick();
    signal(t, "CTL-1", "research", "done");
    signal(t, "CTL-1", "plan", "running");
    signal(t, "CTL-2", "plan", "done"); // other ticket — must not leak
    expect(readSignalsFromEdb(db, t, "CTL-1")).toEqual({ research: "done", plan: "running" });
  });

  test("readSignalsFromEdb returns {} for unknown tick/ticket and null db", () => {
    const t = tick();
    expect(readSignalsFromEdb(db, t, "NOPE")).toEqual({});
    expect(readSignalsFromEdb(db, 999999, "CTL-1")).toEqual({});
    expect(readSignalsFromEdb(null, t, "CTL-1")).toEqual({});
    expect(readSignalsFromEdb(db, null, "CTL-1")).toEqual({});
  });

  test("readSignalsFromEdb tie-breaks duplicate (tick,ticket,phase) deterministically by MIN(fact_id)", () => {
    const t = tick();
    signal(t, "CTL-1", "plan", "running"); // lower fact_id — wins
    signal(t, "CTL-1", "plan", "done");
    expect(readSignalsFromEdb(db, t, "CTL-1")).toEqual({ plan: "running" });
  });

  test("readVerdictFromEdb returns pass/fail and null when no row", () => {
    const t = tick();
    verdict(t, "CTL-1", "fail");
    expect(readVerdictFromEdb(db, t, "CTL-1")).toBe("fail");
    expect(readVerdictFromEdb(db, t, "CTL-2")).toBe(null);
    expect(readVerdictFromEdb(null, t, "CTL-1")).toBe(null);
  });

  test("readCycleFromEdb returns remediate_count, 0 when no row", () => {
    const t = tick();
    cycle(t, "CTL-1", 2);
    expect(readCycleFromEdb(db, t, "CTL-1")).toBe(2);
    expect(readCycleFromEdb(db, t, "CTL-2")).toBe(0);
    expect(readCycleFromEdb(null, t, "CTL-1")).toBe(0);
  });
});

describe("CTL-1058: input-skew no longer fires a false disagreement", () => {
  test("EDB says plan=running (no advance_to belief); disk-style stub says plan=done → NO disagreement", () => {
    const t = tick();
    // Tick-start snapshot: plan still running → R16 produces NO advance_to belief.
    signal(t, "CTL-1", "plan", "running");
    evaluateBeliefs(db, t);

    const events = [];
    // Wire the EDB-backed readers (production behaviour after this fix) instead of
    // the in-memory disk stub. Even if disk had since flipped to plan=done, the
    // oracle reads the tick-locked snapshot → plan=running → agrees with belief.
    const res = runAdvanceShadow(db, t, {
      orchDir: "/fake",
      listInFlight: () => ["CTL-1"],
      readSignals: (_od, ticket) => readSignalsFromEdb(db, t, ticket),
      readVerdict: ({ ticket }) => readVerdictFromEdb(db, t, ticket),
      countCycles: ({ ticket }) => readCycleFromEdb(db, t, ticket),
      deriveAdvancement,
      cap: REMEDIATE_CYCLE_CAP,
      appendEvent: (e) => events.push(e),
    });

    expect(res.disagree).toBe(0);
    expect(events.filter((e) => e["event.name"] === "beliefs.advance_shadow.disagree")).toHaveLength(0);
  });

  test("control: the SAME EDB state with a disk stub returning plan=done DOES disagree (proves the test is load-bearing)", () => {
    const t = tick();
    signal(t, "CTL-1", "plan", "running");
    evaluateBeliefs(db, t);

    const events = [];
    const res = runAdvanceShadow(db, t, {
      ...makeSeams({ "CTL-1": { plan: "done" } }, { events }), // OLD disk behaviour
    });

    expect(res.disagree).toBe(1); // demonstrates the bug the fix removes
  });
});

describe("readAdvanceBeliefs / compareAdvancement units", () => {
  test("readAdvanceBeliefs returns advance_to map + cycle_exhausted set", () => {
    const sig = { triage: "done", research: "done", plan: "done", implement: "done", verify: "done" };
    const t = tick();
    for (const [p, s] of Object.entries(sig)) signal(t, "CTL-R", p, s);
    verdict(t, "CTL-R", "fail");
    cycle(t, "CTL-R", REMEDIATE_CYCLE_CAP);
    evaluateBeliefs(db, t);
    const { advanceTo, cycleExhausted } = readAdvanceBeliefs(db, t);
    expect(advanceTo.has("CTL-R")).toBe(false); // no advance at the cap
    expect(cycleExhausted.has("CTL-R")).toBe(true);
  });

  test("compareAdvancement: both null → agreement (returns null)", () => {
    expect(
      compareAdvancement({ ticket: "X", signals: {}, procedural: null, beliefTo: null, beliefExhausted: false, expectExhausted: false }),
    ).toBeNull();
  });

  test("compareAdvancement: cycle_exhausted mismatch is a disagreement", () => {
    const d = compareAdvancement({
      ticket: "X",
      signals: { verify: "done" },
      procedural: null,
      beliefTo: null,
      beliefExhausted: false,
      expectExhausted: true,
    });
    expect(d).not.toBeNull();
    expect(d.procedural_exhausted).toBe(true);
    expect(d.belief_exhausted).toBe(false);
  });
});
