// ctl-1647-scheduler-transient-gate.test.mjs — CTL-1647.
//
// The LOAD-BEARING half of the fix: the terminal sweep must NOT apply
// `needs-human` to a ticket whose phase signal is a transient, retry-safe
// provider-capacity park — it must back off and re-arm the phase instead.
//
// This drives the REAL `schedulerTick`, not the classifier in isolation. The
// first round of this work only unit-tested `classifyTransientSignal`, and a
// reviewer's mutation (`if (false && …)` on the sweep gate) passed the entire
// 11k-test execution-core suite: the one line that actually stops the label had
// ZERO coverage. Every test below fails if that gate is removed.
//
// Run: cd plugins/dev/scripts/execution-core && bun test __tests__/ctl-1647-scheduler-transient-gate.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  schedulerTick,
  maybeRearmTransientSignal,
  __resetForTests,
  transientRearmMarkerPath,
  TRANSIENT_REARM_DELAY_MS,
  TRANSIENT_MAX_REARMS,
} from "../scheduler.mjs";

const TICKET = "CTL-1647T";
const PHASE = "implement";

let orchDir;
let catalystDir;
let prevCatalystDir;

beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "ctl1647-sched-"));
  prevCatalystDir = process.env.CATALYST_DIR;
  catalystDir = mkdtempSync(join(tmpdir(), "ctl1647-cat-"));
  process.env.CATALYST_DIR = catalystDir;
  writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
  // Clear the module-level worker.transition dedup, or an earlier test's
  // needs-human emit suppresses a later test's (order-coupled false green).
  __resetForTests();
});
afterEach(() => {
  rmSync(orchDir, { recursive: true, force: true });
  rmSync(catalystDir, { recursive: true, force: true });
  if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
  else process.env.CATALYST_DIR = prevCatalystDir;
});

function signalPath(phase = PHASE) {
  return join(orchDir, "workers", TICKET, `phase-${phase}.json`);
}

function writeSignal(phase, obj) {
  mkdirSync(join(orchDir, "workers", TICKET), { recursive: true });
  writeFileSync(signalPath(phase), JSON.stringify({ ticket: TICKET, phase, ...obj }));
}

function readSignal(phase = PHASE) {
  return JSON.parse(readFileSync(signalPath(phase), "utf8"));
}

/** The stalled overload signal the SDK backstop leaves on disk. */
function writeOverloadPark(over = {}) {
  // The whole prefix must be `done` — deleting the parked signal re-derives the
  // next phase from the latest DONE one, so the ticket resumes at PHASE and does
  // not walk backwards.
  writeSignal("triage", { status: "done" });
  writeSignal("research", { status: "done" });
  writeSignal("plan", { status: "done" });
  writeSignal(PHASE, {
    status: "stalled",
    generation: 1,
    attentionReason: "sdk-overloaded-exhausted",
    retrySafe: true,
    assertedBy: "sdk-backstop",
    updatedAt: new Date().toISOString(),
    ...over,
  });
}

/** Run one schedulerTick with every outbound write captured. */
function tick() {
  const labels = [];
  const transitions = [];
  schedulerTick(orchDir, {
    readEligible: () => [],
    dispatch: () => ({ code: 0, stdout: "", stderr: "" }),
    verifyDispatched: () => ({ ok: true }),
    writeStatus: {
      applyPhaseStatus() {},
      applyTerminalDone() {},
      applyLabel: (arg) => {
        labels.push(arg);
        return { applied: true, label: arg?.label };
      },
      removeLabel: () => ({ removed: false }),
    },
    appendWorkerTransitionEvent: (ev) => transitions.push(ev),
    env: {},
  });
  return {
    labels,
    transitions,
    needsHuman: labels.filter((l) => l?.label === "needs-human"),
    needsHumanTransitions: transitions.filter((e) => e.toDisposition === "needs-human"),
  };
}

describe("CTL-1647 — schedulerTick does NOT park a transient provider outage", () => {
  test("a fresh retry-safe overload park applies NO needs-human label and records NO transition", () => {
    writeOverloadPark();
    const r = tick();
    expect(r.needsHuman).toEqual([]);
    expect(r.needsHumanTransitions).toEqual([]);
    // The marker file the label path writes must be absent too.
    expect(existsSync(join(orchDir, "workers", TICKET, ".linear-label-needs-human.applied"))).toBe(
      false,
    );
  });

  // POSITIVE CONTROL 1 — a GENUINE failure on the SAME code path still parks.
  // Without this the test above could pass because the sweep never ran at all.
  test("POSITIVE CONTROL: a genuine (non-transient) stall STILL applies needs-human", () => {
    writeSignal("research", { status: "done" });
    writeSignal(PHASE, {
      status: "failed",
      generation: 1,
      failureReason: "ended-without-declaration",
      updatedAt: new Date().toISOString(),
    });
    const r = tick();
    expect(r.needsHuman.length).toBeGreaterThan(0);
    expect(r.needsHumanTransitions.length).toBeGreaterThan(0);
  });

  // POSITIVE CONTROL 2 — a transient reason with NO retrySafe stamp has no route
  // that would re-dispatch it, so suppressing it would be a silent stall. It parks.
  test("POSITIVE CONTROL: a transient reason WITHOUT retrySafe still parks", () => {
    writeOverloadPark({ retrySafe: undefined });
    const r = tick();
    expect(r.needsHuman.length).toBeGreaterThan(0);
  });

  // POSITIVE CONTROL 3 — the suppression is BOUNDED. Once the phase has re-armed
  // itself TRANSIENT_MAX_REARMS times the sweep escalates, because a silently
  // stranded ticket is strictly worse than a false page.
  test("POSITIVE CONTROL: past the re-arm budget the sweep DOES park it", () => {
    writeOverloadPark({ updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
    writeFileSync(
      transientRearmMarkerPath(orchDir, TICKET, PHASE),
      JSON.stringify({ count: TRANSIENT_MAX_REARMS }),
    );
    const r = tick();
    expect(r.needsHuman.length).toBeGreaterThan(0);
  });

  test("an aged transient park is RE-ARMED (signal dropped) instead of parked", () => {
    writeOverloadPark({
      updatedAt: new Date(Date.now() - TRANSIENT_REARM_DELAY_MS - 60_000).toISOString(),
    });
    const r = tick();
    expect(r.needsHuman).toEqual([]);
    // ⚠️ The terminal signal is DELETED, not rewritten to "pending":
    // deriveAdvancement advances only when the latest LIVE phase is `done`, so a
    // pending signal would make this phase latest and the ticket would sit
    // forever. Dropping it makes `research: done` latest again → implement is
    // re-derived and dispatched.
    expect(existsSync(signalPath())).toBe(false);
    const marker = JSON.parse(readFileSync(transientRearmMarkerPath(orchDir, TICKET, PHASE), "utf8"));
    expect(marker.count).toBe(1);
  });

  // The re-arm must actually produce a DISPATCH — a reset that no phase picks up
  // is a silent stall wearing a fix's clothes.
  test("after the re-arm the next tick DISPATCHES the phase again", () => {
    writeOverloadPark({
      updatedAt: new Date(Date.now() - TRANSIENT_REARM_DELAY_MS - 60_000).toISOString(),
    });
    tick(); // re-arm
    const dispatched = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: (args) => {
        dispatched.push(args);
        return { code: 0, stdout: "", stderr: "" };
      },
      verifyDispatched: () => ({ ok: true }),
      writeStatus: {
        applyPhaseStatus() {},
        applyTerminalDone() {},
        applyLabel: () => ({ applied: true }),
        removeLabel: () => ({ removed: false }),
      },
      env: {},
    });
    expect(dispatched.some((d) => d?.ticket === TICKET && d?.phase === PHASE)).toBe(true);
  });

  test("a park younger than the back-off delay is left alone (real wall-clock back-off)", () => {
    writeOverloadPark();
    const r = tick();
    expect(r.needsHuman).toEqual([]);
    // NOT re-armed yet — the whole point is to wait for capacity to return rather
    // than re-fire on the next tick into a provider that is still returning 529.
    expect(readSignal().status).toBe("stalled");
  });
});

describe("CTL-1647 — maybeRearmTransientSignal (the back-off actuator)", () => {
  const projection = (raw) => ({
    ticket: TICKET,
    phase: raw.phase,
    status: raw.status,
    updatedAt: raw.updatedAt,
    signalPath: signalPath(raw.phase),
    raw,
  });

  function park(over = {}) {
    writeOverloadPark(over);
    return projection(readSignal());
  }

  test("waits while fresh, re-arms once aged, and gives up after the budget", () => {
    const now = Date.now();
    // fresh → waiting
    let sig = park({ updatedAt: new Date(now).toISOString() });
    expect(maybeRearmTransientSignal(orchDir, TICKET, sig, { now })).toMatchObject({
      handled: true,
      action: "waiting",
    });
    expect(readSignal().status).toBe("stalled");

    // aged → rearmed
    sig = park({ updatedAt: new Date(now - TRANSIENT_REARM_DELAY_MS - 1).toISOString() });
    expect(maybeRearmTransientSignal(orchDir, TICKET, sig, { now })).toMatchObject({
      handled: true,
      action: "rearmed",
      attempts: 1,
    });
    expect(existsSync(signalPath())).toBe(false);

    // budget spent → NOT handled, the sweep escalates
    sig = park({ updatedAt: new Date(now - TRANSIENT_REARM_DELAY_MS - 1).toISOString() });
    writeFileSync(
      transientRearmMarkerPath(orchDir, TICKET, PHASE),
      JSON.stringify({ count: TRANSIENT_MAX_REARMS }),
    );
    expect(maybeRearmTransientSignal(orchDir, TICKET, sig, { now })).toMatchObject({
      handled: false,
      action: "exhausted",
    });
    expect(existsSync(signalPath())).toBe(true);
  });

  // The counter must OUTLIVE the signal it deletes, or the bound is fictional.
  test("the re-arm budget is cause-scoped and survives the deleted signal", () => {
    const now = Date.now();
    const aged = () => new Date(now - TRANSIENT_REARM_DELAY_MS - 1).toISOString();
    for (let i = 1; i <= TRANSIENT_MAX_REARMS; i++) {
      const sig = park({ updatedAt: aged() });
      expect(maybeRearmTransientSignal(orchDir, TICKET, sig, { now })).toMatchObject({
        action: "rearmed",
        attempts: i,
      });
    }
    const sig = park({ updatedAt: aged() });
    expect(maybeRearmTransientSignal(orchDir, TICKET, sig, { now })).toMatchObject({
      handled: false,
      action: "exhausted",
    });
  });

  test("an unreadable timestamp re-arms (bounded) rather than waiting forever", () => {
    const sig = park({ updatedAt: "not-a-date" });
    const out = maybeRearmTransientSignal(orchDir, TICKET, sig, { now: Date.now() });
    expect(out).toMatchObject({ handled: true, action: "rearmed", attempts: 1 });
  });

  test("the stale claim tombstone and the dispatch cooldown are cleared", () => {
    const claim = join(orchDir, "workers", TICKET, `phase-${PHASE}.claim.1`);
    const cooldown = join(orchDir, ".dispatch-cooldowns", `${TICKET}-${PHASE}.json`);
    const sig = park({ updatedAt: new Date(Date.now() - TRANSIENT_REARM_DELAY_MS - 1).toISOString() });
    mkdirSync(join(orchDir, ".dispatch-cooldowns"), { recursive: true });
    writeFileSync(claim, "");
    writeFileSync(cooldown, "{}");
    maybeRearmTransientSignal(orchDir, TICKET, sig, { now: Date.now() });
    // A leftover tombstone collides on the next O_EXCL claim create → silent stall.
    expect(existsSync(claim)).toBe(false);
    // A live cooldown would suppress the very re-dispatch we just armed.
    expect(existsSync(cooldown)).toBe(false);
  });

  test("a missing signal file is not handled — the sweep falls through to escalate", () => {
    const out = maybeRearmTransientSignal(
      orchDir,
      TICKET,
      { signalPath: join(orchDir, "workers", TICKET, "phase-nope.json"), raw: {} },
      { now: Date.now() },
    );
    expect(out.handled).toBe(false);
  });
});
