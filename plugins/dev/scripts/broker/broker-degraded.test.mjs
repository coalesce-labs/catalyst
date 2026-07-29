// broker-degraded.test.mjs — CTL-1523. The PURE core of the broker-degraded
// detector: the trip classifier (with its fleet-activity discriminator), the
// clear-side verdict, the sustained-tick debounce, and the edge state machine —
// table-driven; no disk, no clock, no event log — PLUS direct coverage of the
// `checkBrokerDegraded` driver (emit-then-advance retry semantics + hydrateLatch
// tolerance) with an injected emit stub and a CATALYST_DIR-isolated marker.
// The runWatchdogTick wiring is covered in broker-degraded-wiring.test.mjs.
// Idiom model: execution-core/fleet-health-probe.test.mjs.
//
// Run: cd plugins/dev/scripts/broker && bun test broker-degraded.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  classifyBrokerDegraded,
  classifyBrokerDegradedClear,
  nextBrokerDegradedSustained,
  nextBrokerDegradedLatch,
  checkBrokerDegraded,
  getBrokerDegradedLatchPath,
  __resetBrokerDegradedLatchForTest,
  __getBrokerDegradedLatchForTest,
  BROKER_DEGRADED_EVENT,
  BROKER_RECOVERED_EVENT,
} from "./broker-degraded.mjs";

const GRACE = 300_000;

describe("classifyBrokerDegraded — the trip classifier (CTL-1523)", () => {
  const cases = [
    // [name, readings, expectedAnomalous]
    [
      "THE REGRESSION: empty interests + past grace but IDLE fleet → not anomalous",
      { interestCount: 0, uptimeMs: GRACE + 60_000, fleetActive: false },
      false,
    ],
    [
      "empty interests + past grace + ACTIVE fleet → anomalous",
      { interestCount: 0, uptimeMs: GRACE + 60_000, fleetActive: true },
      true,
    ],
    [
      "inside the startup grace → not anomalous even with an active fleet",
      { interestCount: 0, uptimeMs: 60_000, fleetActive: true },
      false,
    ],
    [
      "boundary: uptime EXACTLY at the grace does not trip (strict >)",
      { interestCount: 0, uptimeMs: GRACE, fleetActive: true },
      false,
    ],
    [
      "boundary: one ms past the grace trips",
      { interestCount: 0, uptimeMs: GRACE + 1, fleetActive: true },
      true,
    ],
    [
      "interests present → not anomalous however active/old",
      { interestCount: 3, uptimeMs: GRACE + 600_000, fleetActive: true },
      false,
    ],
    [
      "fleetActive undefined (reader unavailable) → NOT anomalous (fail closed)",
      { interestCount: 0, uptimeMs: GRACE + 60_000, fleetActive: undefined },
      false,
    ],
    [
      // Review F2: null is the router's explicit UNKNOWN. Only a POSITIVE activity
      // reading is evidence of an anomaly — unknown must never trip.
      "fleetActive null (UNKNOWN — the activity read failed) → NOT anomalous",
      { interestCount: 0, uptimeMs: GRACE + 60_000, fleetActive: null },
      false,
    ],
    [
      "fleetActive truthy-but-not-true is not accepted (strict === true)",
      { interestCount: 0, uptimeMs: GRACE + 60_000, fleetActive: 1 },
      false,
    ],
    [
      "non-finite uptime → not anomalous",
      { interestCount: 0, uptimeMs: NaN, fleetActive: true },
      false,
    ],
  ];

  for (const [name, readings, expected] of cases) {
    test(name, () => {
      expect(classifyBrokerDegraded(readings, { graceMs: GRACE }).anomalous).toBe(expected);
    });
  }

  test("reports the three component predicates for forensics", () => {
    const v = classifyBrokerDegraded(
      { interestCount: 0, uptimeMs: GRACE + 1, fleetActive: true },
      { graceMs: GRACE },
    );
    expect(v).toEqual({
      anomalous: true,
      emptyInterests: true,
      pastGrace: true,
      fleetActive: true,
    });
  });

  test("no-arg call is safe (never throws) and does not trip", () => {
    expect(classifyBrokerDegraded().anomalous).toBe(false);
  });
});

describe("classifyBrokerDegradedClear — the clear-side verdict (CTL-1523)", () => {
  const cases = [
    [
      "interests came back → clear, reason 'interests registered'",
      { interestCount: 2, fleetActive: true },
      { clear: true, reason: "interests registered" },
    ],
    [
      "fleet went idle → clear, reason 'fleet idle' (an idle fleet CLOSES an episode)",
      { interestCount: 0, fleetActive: false },
      { clear: true, reason: "fleet idle" },
    ],
    [
      "both conditions → 'interests registered' wins (affirmative proof of life)",
      { interestCount: 5, fleetActive: false },
      { clear: true, reason: "interests registered" },
    ],
    [
      "still empty AND still active → NOT clear (hold the episode)",
      { interestCount: 0, fleetActive: true },
      { clear: false, reason: null },
    ],
    // Review F2: UNKNOWN activity is not "idle". Both edges demand positive
    // evidence, so null/undefined can neither trip nor clear — a latched episode
    // holds until the reading is trustworthy again.
    [
      "UNKNOWN activity (null) with empty interests → NOT clear (the latch holds)",
      { interestCount: 0, fleetActive: null },
      { clear: false, reason: null },
    ],
    [
      "UNKNOWN activity (undefined) with empty interests → NOT clear",
      { interestCount: 0, fleetActive: undefined },
      { clear: false, reason: null },
    ],
    [
      "UNKNOWN activity but interests came back → still clear (affirmative proof of life)",
      { interestCount: 4, fleetActive: null },
      { clear: true, reason: "interests registered" },
    ],
  ];

  for (const [name, readings, expected] of cases) {
    test(name, () => {
      expect(classifyBrokerDegradedClear(readings)).toEqual(expected);
    });
  }

  test("trip and clear are mutually exclusive across the whole tri-state input grid", () => {
    for (const interestCount of [0, 1]) {
      for (const fleetActive of [true, false, null]) {
        for (const uptimeMs of [0, GRACE + 1]) {
          const { anomalous } = classifyBrokerDegraded(
            { interestCount, uptimeMs, fleetActive },
            { graceMs: GRACE },
          );
          const { clear } = classifyBrokerDegradedClear({ interestCount, fleetActive });
          expect(anomalous && clear).toBe(false);
        }
      }
    }
  });

  // Review F2: the tri-state contract as one explicit statement — UNKNOWN activity
  // with an empty table is the ONE grid cell where NEITHER edge holds. (Every other
  // cell resolves to a trip, a clear, or a below-grace hold.)
  test("UNKNOWN activity + empty interests past grace → NEITHER trip NOR clear", () => {
    for (const unknown of [null, undefined]) {
      const { anomalous } = classifyBrokerDegraded(
        { interestCount: 0, uptimeMs: GRACE + 1, fleetActive: unknown },
        { graceMs: GRACE },
      );
      const { clear } = classifyBrokerDegradedClear({ interestCount: 0, fleetActive: unknown });
      expect(anomalous, `unknown: ${String(unknown)}`).toBe(false);
      expect(clear, `unknown: ${String(unknown)}`).toBe(false);
    }
  });
});

describe("nextBrokerDegradedSustained — the debounce counter (CTL-1523)", () => {
  test("counts consecutive anomalous ticks", () => {
    let n = 0;
    for (const expected of [1, 2, 3]) {
      n = nextBrokerDegradedSustained(n, true);
      expect(n).toBe(expected);
    }
  });

  test("any non-anomalous tick resets the run to 0 (must be contiguous)", () => {
    let n = nextBrokerDegradedSustained(nextBrokerDegradedSustained(0, true), true);
    expect(n).toBe(2);
    n = nextBrokerDegradedSustained(n, false);
    expect(n).toBe(0);
    expect(nextBrokerDegradedSustained(n, true)).toBe(1);
  });

  test("a non-finite prior is treated as 0", () => {
    expect(nextBrokerDegradedSustained(undefined, true)).toBe(1);
    expect(nextBrokerDegradedSustained(NaN, false)).toBe(0);
  });
});

describe("nextBrokerDegradedLatch — the edge state machine (CTL-1523)", () => {
  const cases = [
    ["unlatched + trip → degraded edge", false, { trip: true, clear: false }, { latched: true, emit: "degraded" }],
    ["unlatched + nothing → no emit", false, { trip: false, clear: false }, { latched: false, emit: null }],
    ["unlatched + clear → no emit (nothing to recover)", false, { trip: false, clear: true }, { latched: false, emit: null }],
    ["latched + still tripping → NO re-emit", true, { trip: true, clear: false }, { latched: true, emit: null }],
    ["latched + clear → recovered edge", true, { trip: false, clear: true }, { latched: false, emit: "recovered" }],
    ["latched + neither → hold", true, { trip: false, clear: false }, { latched: true, emit: null }],
  ];

  for (const [name, prev, verdict, expected] of cases) {
    test(name, () => {
      expect(nextBrokerDegradedLatch(prev, verdict)).toEqual(expected);
    });
  }

  test("a full episode emits exactly one degraded and one recovered", () => {
    const emitted = [];
    let latched = false;
    // trip, hold ×3, then clear, then stay clear ×2
    for (const v of [
      { trip: true, clear: false },
      { trip: true, clear: false },
      { trip: true, clear: false },
      { trip: false, clear: true },
      { trip: false, clear: true },
      { trip: false, clear: true },
    ]) {
      const r = nextBrokerDegradedLatch(latched, v);
      latched = r.latched;
      if (r.emit) emitted.push(r.emit);
    }
    expect(emitted).toEqual(["degraded", "recovered"]);
  });

  test("no-verdict call is safe and holds", () => {
    expect(nextBrokerDegradedLatch(true)).toEqual({ latched: true, emit: null });
  });
});

// ─── checkBrokerDegraded — the driver (CTL-1523) ─────────────────────────────
// Direct coverage of the parts the pure-fn tables cannot reach: the EMIT-THEN-ADVANCE
// contract (a failed or throwing append must NOT advance the latch, so the edge
// retries next tick), the `if (!ok) return null` guard, and hydrateLatch()'s
// tolerance of an absent/corrupt marker. No DB, no router, no event log — the emit
// side effect is an injected stub and CATALYST_DIR points at an mkdtemp so the
// durable marker is isolated. Idiom model: execution-core/fleet-health-probe.test.mjs
// ("a failed emit (append returns false) does NOT advance the latch").
describe("checkBrokerDegraded — the driver's failure semantics (CTL-1523)", () => {
  let dir;
  let prevCatalystDir;
  let prevEnabled;

  // Readings that trip the gate (empty interests, past grace, fleet working) and the
  // readings that clear it (fleet went idle).
  const ANOMALOUS = { interestCount: 0, uptimeMs: GRACE + 1, fleetActive: true };
  const IDLE = { interestCount: 0, uptimeMs: GRACE + 1, fleetActive: false };
  // Every call pins the two knobs so the run does not depend on the deployed defaults.
  const run = (readings, emit, { sustainedTicks = 1 } = {}) =>
    checkBrokerDegraded({ ...readings, graceMs: GRACE, sustainedTicks, emit });

  beforeEach(() => {
    prevCatalystDir = process.env.CATALYST_DIR;
    prevEnabled = process.env.FILTER_BROKER_DEGRADED_ENABLED;
    dir = mkdtempSync(join(tmpdir(), "broker-degraded-driver-"));
    process.env.CATALYST_DIR = dir;
    // The detector is OPT-IN and dormant by default — arm it for these cases.
    process.env.FILTER_BROKER_DEGRADED_ENABLED = "1";
    __resetBrokerDegradedLatchForTest();
  });
  afterEach(() => {
    __resetBrokerDegradedLatchForTest();
    if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
    else process.env.CATALYST_DIR = prevCatalystDir;
    if (prevEnabled === undefined) delete process.env.FILTER_BROKER_DEGRADED_ENABLED;
    else process.env.FILTER_BROKER_DEGRADED_ENABLED = prevEnabled;
    rmSync(dir, { recursive: true, force: true });
  });

  test("dormant by default: with the env UNSET the driver evaluates nothing", () => {
    delete process.env.FILTER_BROKER_DEGRADED_ENABLED;
    const calls = [];
    expect(run(ANOMALOUS, (a) => (calls.push(a), true))).toBeNull();
    expect(calls).toHaveLength(0);
    expect(existsSync(getBrokerDegradedLatchPath())).toBe(false);
  });

  test("(1) a degraded edge whose emit RETURNS FALSE does not advance the latch — it retries", () => {
    let ok = false;
    const calls = [];
    const emit = (payload) => {
      calls.push(payload);
      return ok;
    };
    // sustainedTicks=2 so the retry tick has a LIVE counter of 3 while the run that
    // actually crossed the gate was 2 — the honest-`sustainedTicks` regression.
    expect(run(ANOMALOUS, emit, { sustainedTicks: 2 })).toBeNull(); // tick 1: below threshold
    expect(calls).toHaveLength(0);

    expect(run(ANOMALOUS, emit, { sustainedTicks: 2 })).toBeNull(); // tick 2: edge, append FAILS
    expect(calls).toHaveLength(1);
    expect(calls[0].action).toBe("degraded");
    expect(__getBrokerDegradedLatchForTest().latched).toBe(false); // latch did NOT advance
    expect(existsSync(getBrokerDegradedLatchPath())).toBe(false); // and nothing persisted

    ok = true;
    expect(run(ANOMALOUS, emit, { sustainedTicks: 2 })).toBe("degraded"); // tick 3: retried
    expect(calls).toHaveLength(2);
    expect(calls[1].action).toBe("degraded");
    // The reported run length is the one that CROSSED the gate, not the live counter
    // (which is 3 by now) — a retry must not inflate the forensic detail.
    expect(calls[1].detail.sustainedTicks).toBe(2);
    expect(__getBrokerDegradedLatchForTest().latched).toBe(true);
    expect(existsSync(getBrokerDegradedLatchPath())).toBe(true);
  });

  test("(2) a degraded edge whose emit THROWS is swallowed — null, latch unchanged, retries", () => {
    const calls = [];
    const throwing = (payload) => {
      calls.push(payload);
      throw new Error("ENOSPC: event log append failed");
    };
    expect(() => run(ANOMALOUS, throwing)).not.toThrow();
    expect(run(ANOMALOUS, throwing)).toBeNull();
    expect(__getBrokerDegradedLatchForTest().latched).toBe(false);
    expect(existsSync(getBrokerDegradedLatchPath())).toBe(false);
    expect(calls.length).toBeGreaterThanOrEqual(2); // attempted on every tick

    const good = [];
    expect(run(ANOMALOUS, (p) => (good.push(p), true))).toBe("degraded");
    expect(good).toHaveLength(1);
    expect(__getBrokerDegradedLatchForTest().latched).toBe(true);
  });

  test("(3) the CLEAR edge retries too: a throwing recovered leaves the episode LATCHED", () => {
    expect(run(ANOMALOUS, () => true)).toBe("degraded");
    expect(__getBrokerDegradedLatchForTest().latched).toBe(true);

    const thrown = [];
    const throwing = (payload) => {
      thrown.push(payload);
      throw new Error("append failed");
    };
    expect(() => run(IDLE, throwing)).not.toThrow();
    expect(run(IDLE, throwing)).toBeNull();
    expect(thrown[0].action).toBe("recovered");
    // Still latched → the recovered is owed and will be re-attempted next tick.
    expect(__getBrokerDegradedLatchForTest().latched).toBe(true);

    const good = [];
    expect(run(IDLE, (p) => (good.push(p), true))).toBe("recovered");
    expect(good[0].detail.reason).toBe("fleet idle");
    expect(__getBrokerDegradedLatchForTest().latched).toBe(false);
    // …and it does not emit a second time.
    expect(run(IDLE, () => true)).toBeNull();
  });

  test("(4a) an ABSENT marker hydrates as unlatched and produces no orphan recovered", () => {
    expect(existsSync(getBrokerDegradedLatchPath())).toBe(false);
    const calls = [];
    // Clear-side readings on a fresh process: nothing was latched, so nothing recovers.
    expect(run(IDLE, (p) => (calls.push(p), true))).toBeNull();
    expect(calls).toHaveLength(0);
    expect(__getBrokerDegradedLatchForTest().latched).toBe(false);
  });

  test("(4b) a CORRUPT marker is tolerated: unlatched, never throws, no orphan recovered", () => {
    for (const garbage of ["{not json", "", "null", '{"latched":"yes"}', "[1,2,3]"]) {
      __resetBrokerDegradedLatchForTest();
      const path = getBrokerDegradedLatchPath();
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, garbage);

      const calls = [];
      let result;
      expect(() => {
        result = run(IDLE, (p) => (calls.push(p), true));
      }).not.toThrow();
      expect(result, `garbage: ${garbage}`).toBeNull();
      expect(calls, `garbage: ${garbage}`).toHaveLength(0); // NO orphan "recovered"
      expect(__getBrokerDegradedLatchForTest().latched).toBe(false);
    }
  });

  test("(4c) a VALID latched marker hydrates the open episode — the recovered still fires", () => {
    writeFileSync(
      getBrokerDegradedLatchPath(),
      JSON.stringify({ latched: true, latchedAtMs: Date.now() - 60_000, ts: Date.now() }),
    );
    const calls = [];
    expect(run(IDLE, (p) => (calls.push(p), true))).toBe("recovered");
    expect(calls[0].detail.reason).toBe("fleet idle");
    expect(typeof calls[0].detail.degradedForMs).toBe("number");
  });
});

// ─── Review F2: UNKNOWN activity must not move the latch ─────────────────────
// The defect: fleetActivity() collapsed a failed worker-table read into `false`, so a
// transient SQLite outage looked exactly like a proven-idle fleet — the detector
// emitted a FALSE `recovered` (reason "fleet idle"), PERSISTED the cleared latch, and
// then re-tripped the same uninterrupted episode once the DB came back. Driven here
// end-to-end through checkBrokerDegraded, latch marker and all.
describe("checkBrokerDegraded — UNKNOWN activity holds the latch (CTL-1523 review F2)", () => {
  let dir;
  let prevCatalystDir;
  let prevEnabled;

  const ANOMALOUS = { interestCount: 0, uptimeMs: GRACE + 1, fleetActive: true };
  const IDLE = { interestCount: 0, uptimeMs: GRACE + 1, fleetActive: false };
  const UNKNOWN = { interestCount: 0, uptimeMs: GRACE + 1, fleetActive: null };
  const run = (readings, emit, { sustainedTicks = 1 } = {}) =>
    checkBrokerDegraded({ ...readings, graceMs: GRACE, sustainedTicks, emit });

  beforeEach(() => {
    prevCatalystDir = process.env.CATALYST_DIR;
    prevEnabled = process.env.FILTER_BROKER_DEGRADED_ENABLED;
    dir = mkdtempSync(join(tmpdir(), "broker-degraded-tristate-"));
    process.env.CATALYST_DIR = dir;
    process.env.FILTER_BROKER_DEGRADED_ENABLED = "1";
    __resetBrokerDegradedLatchForTest();
  });
  afterEach(() => {
    __resetBrokerDegradedLatchForTest();
    if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
    else process.env.CATALYST_DIR = prevCatalystDir;
    if (prevEnabled === undefined) delete process.env.FILTER_BROKER_DEGRADED_ENABLED;
    else process.env.FILTER_BROKER_DEGRADED_ENABLED = prevEnabled;
    rmSync(dir, { recursive: true, force: true });
  });

  test("(a) LATCHED + activity UNKNOWN → no event, and the episode stays latched", () => {
    expect(run(ANOMALOUS, () => true)).toBe("degraded");
    expect(__getBrokerDegradedLatchForTest().latched).toBe(true);

    // The DB read starts failing. Many ticks of pure ignorance must change nothing.
    const calls = [];
    for (let i = 0; i < 10; i++) {
      expect(run(UNKNOWN, (p) => (calls.push(p), true))).toBeNull();
    }
    expect(calls).toHaveLength(0); // NO false "recovered"
    expect(__getBrokerDegradedLatchForTest().latched).toBe(true);
    // …and the DURABLE marker still records the open episode, so a restart mid-outage
    // resumes it rather than re-emitting a duplicate degraded.
    expect(JSON.parse(readFileSync(getBrokerDegradedLatchPath(), "utf8")).latched).toBe(true);
  });

  test("(b) LATCHED + activity PROVEN idle → exactly one recovered", () => {
    expect(run(ANOMALOUS, () => true)).toBe("degraded");

    const calls = [];
    const emit = (p) => (calls.push(p), true);
    expect(run(IDLE, emit)).toBe("recovered");
    expect(calls).toHaveLength(1);
    expect(calls[0].detail.reason).toBe("fleet idle");
    expect(__getBrokerDegradedLatchForTest().latched).toBe(false);
    // Idempotent: further idle ticks do not re-emit.
    for (let i = 0; i < 3; i++) expect(run(IDLE, emit)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test("(b') the DB recovers to idle after an unknown window → ONE recovered, not two edges", () => {
    expect(run(ANOMALOUS, () => true)).toBe("degraded");
    const calls = [];
    const emit = (p) => (calls.push(p), true);
    for (let i = 0; i < 5; i++) run(UNKNOWN, emit); // outage
    expect(calls).toHaveLength(0);
    expect(run(IDLE, emit)).toBe("recovered"); // DB back, fleet genuinely idle
    expect(calls.map((c) => c.action)).toEqual(["recovered"]);
  });

  test("(b'') the DB recovers to STILL-ANOMALOUS → no duplicate degraded (still latched)", () => {
    expect(run(ANOMALOUS, () => true)).toBe("degraded");
    const calls = [];
    const emit = (p) => (calls.push(p), true);
    for (let i = 0; i < 5; i++) run(UNKNOWN, emit);
    // The condition never actually went away — the latch held through the blind
    // window, so the reappearing anomaly is the SAME episode, not a new edge.
    for (let i = 0; i < 5; i++) expect(run(ANOMALOUS, emit)).toBeNull();
    expect(calls).toHaveLength(0);
    expect(__getBrokerDegradedLatchForTest().latched).toBe(true);
  });

  test("(c) UNLATCHED + activity UNKNOWN + empty interests past grace → NEVER trips", () => {
    const calls = [];
    const emit = (p) => (calls.push(p), true);
    // sustainedTicks=1 (the most trip-happy setting there is) and 50 ticks: unknown
    // activity is not evidence, so no number of ticks can manufacture an alarm.
    for (let i = 0; i < 50; i++) {
      expect(run(UNKNOWN, emit, { sustainedTicks: 1 })).toBeNull();
    }
    expect(calls).toHaveLength(0);
    expect(__getBrokerDegradedLatchForTest().latched).toBe(false);
    expect(existsSync(getBrokerDegradedLatchPath())).toBe(false);
  });
});

// ─── Review F4: the debounce must not survive a disabled interval ────────────
describe("checkBrokerDegraded — disabling discards the debounce run (CTL-1523 review F4)", () => {
  let dir;
  let prevCatalystDir;
  let prevEnabled;

  const ANOMALOUS = { interestCount: 0, uptimeMs: GRACE + 1, fleetActive: true };
  const IDLE = { interestCount: 0, uptimeMs: GRACE + 1, fleetActive: false };
  const SUSTAINED = 5;
  const run = (readings, emit) =>
    checkBrokerDegraded({ ...readings, graceMs: GRACE, sustainedTicks: SUSTAINED, emit });

  beforeEach(() => {
    prevCatalystDir = process.env.CATALYST_DIR;
    prevEnabled = process.env.FILTER_BROKER_DEGRADED_ENABLED;
    dir = mkdtempSync(join(tmpdir(), "broker-degraded-f4-"));
    process.env.CATALYST_DIR = dir;
    process.env.FILTER_BROKER_DEGRADED_ENABLED = "1";
    __resetBrokerDegradedLatchForTest();
  });
  afterEach(() => {
    __resetBrokerDegradedLatchForTest();
    if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
    else process.env.CATALYST_DIR = prevCatalystDir;
    if (prevEnabled === undefined) delete process.env.FILTER_BROKER_DEGRADED_ENABLED;
    else process.env.FILTER_BROKER_DEGRADED_ENABLED = prevEnabled;
    rmSync(dir, { recursive: true, force: true });
  });

  // The exact reported sequence: 4 anomalous ticks (one short of the threshold) →
  // DISABLE → conditions clear → RE-ENABLE during a NEW anomaly. Before the fix the
  // stale counter carried over and the very first tick of the new condition emitted
  // degraded after ONE observed tick instead of five.
  test("4 anomalous ticks → disable → clear → re-enable: the new run re-earns all 5 ticks", () => {
    const calls = [];
    const emit = (p) => (calls.push(p), true);

    for (let i = 0; i < SUSTAINED - 1; i++) expect(run(ANOMALOUS, emit)).toBeNull();
    expect(__getBrokerDegradedLatchForTest().sustained).toBe(SUSTAINED - 1);

    // Operator flips the detector off. The unfinished run is discarded on the spot.
    process.env.FILTER_BROKER_DEGRADED_ENABLED = "0";
    expect(run(ANOMALOUS, emit)).toBeNull();
    expect(__getBrokerDegradedLatchForTest().sustained).toBe(0);
    expect(__getBrokerDegradedLatchForTest().tripRunLength).toBeNull();

    // Conditions clear while disabled, then a NEW anomaly begins and the detector is
    // re-enabled part-way into it.
    run(IDLE, emit);
    process.env.FILTER_BROKER_DEGRADED_ENABLED = "1";

    // The first four ticks of the NEW condition must stay silent…
    for (let i = 0; i < SUSTAINED - 1; i++) expect(run(ANOMALOUS, emit)).toBeNull();
    expect(calls).toHaveLength(0);
    // …and only the fifth trips, reporting an honest run length of 5.
    expect(run(ANOMALOUS, emit)).toBe("degraded");
    expect(calls).toHaveLength(1);
    expect(calls[0].detail.sustainedTicks).toBe(SUSTAINED);
  });

  test("a single disabled tick mid-run resets the counter (the run must be contiguous AND armed)", () => {
    const emit = () => true;
    for (let i = 0; i < SUSTAINED - 1; i++) run(ANOMALOUS, emit);
    process.env.FILTER_BROKER_DEGRADED_ENABLED = "0";
    run(ANOMALOUS, emit);
    process.env.FILTER_BROKER_DEGRADED_ENABLED = "1";
    // Immediately re-armed and still anomalous: this is tick 1 of a fresh run, so the
    // next SUSTAINED-1 ticks must remain silent.
    for (let i = 0; i < SUSTAINED - 1; i++) expect(run(ANOMALOUS, emit)).toBeNull();
    expect(run(ANOMALOUS, emit)).toBe("degraded");
  });

  test("an OPEN episode SURVIVES a disabled interval — the durable latch is untouched", () => {
    const emit = () => true;
    for (let i = 0; i < SUSTAINED; i++) run(ANOMALOUS, emit);
    expect(__getBrokerDegradedLatchForTest().latched).toBe(true);

    process.env.FILTER_BROKER_DEGRADED_ENABLED = "0";
    const whileOff = [];
    for (let i = 0; i < 5; i++) {
      expect(run(IDLE, (p) => (whileOff.push(p), true))).toBeNull();
    }
    expect(whileOff).toHaveLength(0); // inert while off
    expect(__getBrokerDegradedLatchForTest().latched).toBe(true); // episode preserved
    expect(JSON.parse(readFileSync(getBrokerDegradedLatchPath(), "utf8")).latched).toBe(true);

    // Re-armed: the owed `recovered` still fires, so the ledger stays balanced.
    process.env.FILTER_BROKER_DEGRADED_ENABLED = "1";
    const calls = [];
    expect(run(IDLE, (p) => (calls.push(p), true))).toBe("recovered");
    expect(calls[0].detail.reason).toBe("fleet idle");
  });
});

describe("event names (CTL-1523)", () => {
  test("both live in the broker.daemon protected space", () => {
    expect(BROKER_DEGRADED_EVENT).toBe("broker.daemon.degraded");
    expect(BROKER_RECOVERED_EVENT).toBe("broker.daemon.recovered");
    for (const n of [BROKER_DEGRADED_EVENT, BROKER_RECOVERED_EVENT]) {
      expect(n.startsWith("broker.daemon")).toBe(true);
    }
  });
});

// Codex P2 (#2740): the marker write can fail AFTER the event append succeeded and
// `_latched` advanced. Swallowing that left memory and disk disagreeing with nothing
// to reconcile them, so a restart hydrated a stale/absent marker and re-emitted a
// duplicate edge for the same episode — defeating the durable latch entirely.
describe("checkBrokerDegraded — a failed latch persist is retried (review round 2)", () => {
  let dir;
  let prevCatalystDir;
  let prevEnabled;
  beforeEach(() => {
    prevCatalystDir = process.env.CATALYST_DIR;
    prevEnabled = process.env.FILTER_BROKER_DEGRADED_ENABLED;
    dir = mkdtempSync(join(tmpdir(), "broker-degraded-persist-"));
    process.env.CATALYST_DIR = dir;
    process.env.FILTER_BROKER_DEGRADED_ENABLED = "1";
    __resetBrokerDegradedLatchForTest();
  });
  afterEach(() => {
    if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
    else process.env.CATALYST_DIR = prevCatalystDir;
    if (prevEnabled === undefined) delete process.env.FILTER_BROKER_DEGRADED_ENABLED;
    else process.env.FILTER_BROKER_DEGRADED_ENABLED = prevEnabled;
    rmSync(dir, { recursive: true, force: true });
    __resetBrokerDegradedLatchForTest();
  });

  const anomalousTick = (emit) =>
    checkBrokerDegraded({
      interestCount: 0,
      uptimeMs: 6 * 60 * 1000,
      fleetActive: true,
      emit,
      sustainedTicks: 1,
    });

  test("a persist failure is remembered and retried until it lands", () => {
    // Make the marker directory unwritable by planting a DIRECTORY where the marker
    // file must go — writeFileSync/renameSync then fail while the append succeeds.
    const markerPath = getBrokerDegradedLatchPath();
    mkdirSync(markerPath, { recursive: true });

    const emitted = [];
    expect(anomalousTick((e) => (emitted.push(e.action), true))).toBe("degraded");
    expect(emitted).toEqual(["degraded"]);
    // In-memory latch advanced (the edge really was emitted) but disk did NOT.
    expect(__getBrokerDegradedLatchForTest().latched).toBe(true);
    expect(__getBrokerDegradedLatchForTest().persistPending).toBe(true);

    // Still failing → still pending, and no duplicate edge is emitted meanwhile.
    expect(anomalousTick(() => true)).toBeNull();
    expect(__getBrokerDegradedLatchForTest().persistPending).toBe(true);
    expect(emitted).toEqual(["degraded"]);

    // Clear the obstruction: the very next tick reconciles disk with memory.
    rmSync(markerPath, { recursive: true, force: true });
    expect(anomalousTick(() => true)).toBeNull();
    expect(__getBrokerDegradedLatchForTest().persistPending).toBe(false);

    // And the marker now reflects the OPEN episode, so a restart resumes it
    // instead of re-emitting — which is the whole point.
    const marker = JSON.parse(readFileSync(getBrokerDegradedLatchPath(), "utf8"));
    expect(marker.latched).toBe(true);
  });

  test("a successful persist leaves nothing pending", () => {
    expect(anomalousTick(() => true)).toBe("degraded");
    expect(__getBrokerDegradedLatchForTest().persistPending).toBe(false);
    expect(JSON.parse(readFileSync(getBrokerDegradedLatchPath(), "utf8")).latched).toBe(true);
  });

  // Codex round 3 (T1): persistLatch writes a UNIQUELY-NAMED tmp file and then
  // renames it. If the rename throws, that tmp file is orphaned — and because the
  // round-2 retry re-calls persistLatch on EVERY watchdog tick, a PERSISTENT
  // obstruction leaked one hidden tmp file per minute forever (inode/disk
  // exhaustion). The cleanup must run in the catch, and must never itself throw.
  test("a persistently failing rename leaves NO orphan .tmp files (the inode leak)", () => {
    const markerPath = getBrokerDegradedLatchPath();
    mkdirSync(markerPath, { recursive: true }); // rename onto a DIRECTORY always fails

    const emitted = [];
    expect(() => anomalousTick((e) => (emitted.push(e.action), true))).not.toThrow();
    expect(emitted).toEqual(["degraded"]);
    expect(__getBrokerDegradedLatchForTest().persistPending).toBe(true);

    // Several more ticks: each one retries the persist and fails the same way.
    for (let i = 0; i < 5; i++) {
      expect(() => anomalousTick(() => true)).not.toThrow();
    }
    expect(__getBrokerDegradedLatchForTest().persistPending).toBe(true);

    const leftovers = readdirSync(dir).filter(
      (f) => f.startsWith(".broker-degraded-latch.") && f.endsWith(".tmp"),
    );
    expect(leftovers, `orphaned tmp files: ${leftovers.join(", ")}`).toEqual([]);
  });
});

// Codex round 3 (T3): hydrateLatch's failure taxonomy. A CONFIRMED unlatched state
// (marker absent, or present-but-unparseable) is final; any OTHER read failure is
// merely UNKNOWN and must stay retryable — the old broad catch turned one transient
// EIO on a restart into the permanent loss of a real open episode, whose continuing
// anomaly then re-earned the debounce and emitted a DUPLICATE degraded.
describe("hydrateLatch — a TRANSIENT read failure stays retryable (Codex round 3)", () => {
  let dir;
  let prevCatalystDir;
  let prevEnabled;

  const IDLE = { interestCount: 0, uptimeMs: GRACE + 1, fleetActive: false };
  const run = (readings, emit) =>
    checkBrokerDegraded({ ...readings, graceMs: GRACE, sustainedTicks: 1, emit });

  beforeEach(() => {
    prevCatalystDir = process.env.CATALYST_DIR;
    prevEnabled = process.env.FILTER_BROKER_DEGRADED_ENABLED;
    dir = mkdtempSync(join(tmpdir(), "broker-degraded-hydrate-"));
    process.env.CATALYST_DIR = dir;
    process.env.FILTER_BROKER_DEGRADED_ENABLED = "1";
    __resetBrokerDegradedLatchForTest();
  });
  afterEach(() => {
    __resetBrokerDegradedLatchForTest();
    if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
    else process.env.CATALYST_DIR = prevCatalystDir;
    if (prevEnabled === undefined) delete process.env.FILTER_BROKER_DEGRADED_ENABLED;
    else process.env.FILTER_BROKER_DEGRADED_ENABLED = prevEnabled;
    rmSync(dir, { recursive: true, force: true });
  });

  test("EISDIR (marker path obstructed) is NOT confirmed-unlatched — and it retries", () => {
    // A DIRECTORY at the marker path makes readFileSync throw EISDIR, not ENOENT:
    // the same shape as a transient EIO / permission loss.
    const markerPath = getBrokerDegradedLatchPath();
    mkdirSync(markerPath, { recursive: true });

    const calls = [];
    const emit = (p) => (calls.push(p), true);
    expect(() => run(IDLE, emit)).not.toThrow();
    // Nothing was learned: hydration is NOT closed, so the next tick re-reads.
    expect(__getBrokerDegradedLatchForTest().hydrated).toBe(false);
    expect(__getBrokerDegradedLatchForTest().latched).toBe(false);
    expect(calls).toHaveLength(0); // and no orphan `recovered` was invented

    // The obstruction clears, revealing the REAL open episode that was behind it.
    // With the old broad catch this episode was already permanently discarded.
    rmSync(markerPath, { recursive: true, force: true });
    writeFileSync(
      markerPath,
      JSON.stringify({ latched: true, latchedAtMs: Date.now() - 60_000, ts: Date.now() }),
    );

    expect(run(IDLE, emit)).toBe("recovered"); // the owed recovery still fires
    expect(__getBrokerDegradedLatchForTest().hydrated).toBe(true);
    expect(calls[0].detail.reason).toBe("fleet idle");
    expect(typeof calls[0].detail.degradedForMs).toBe("number");
  });

  test("ENOENT (absent) and a malformed body stay CONFIRMED unlatched — no retry", () => {
    // (a) absent
    expect(existsSync(getBrokerDegradedLatchPath())).toBe(false);
    expect(run(IDLE, () => true)).toBeNull();
    expect(__getBrokerDegradedLatchForTest().hydrated).toBe(true);

    // (b) present but unparseable — a marker we cannot trust is no marker
    __resetBrokerDegradedLatchForTest();
    writeFileSync(getBrokerDegradedLatchPath(), "{not json");
    expect(run(IDLE, () => true)).toBeNull();
    expect(__getBrokerDegradedLatchForTest().hydrated).toBe(true);
    expect(__getBrokerDegradedLatchForTest().latched).toBe(false);
  });
});
