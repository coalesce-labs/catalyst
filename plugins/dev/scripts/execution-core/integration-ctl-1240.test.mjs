// integration-ctl-1240.test.mjs — CTL-1240: wire gateway tier into startScheduler tick.
//
// Five sites in scheduler.mjs silently drop the `gateway` reader that the daemon
// correctly threads into startScheduler. These tests drive startScheduler (the
// real production path) and assert the gateway spy is consulted on the initial
// synchronous tick — proving the threading is live, not dead.
//
// Test structure mirrors the CTL-537 forwarding test (scheduler.test.mjs:6808) and
// the CTL-1191 terminal-filter test (scheduler.test.mjs:8906).

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startScheduler,
  stopScheduler,
  __resetForTests,
} from "./scheduler.mjs";

let orchDir;
let prevCatalystDir;
let catalystDir;

beforeEach(() => {
  __resetForTests();
  orchDir = mkdtempSync(join(tmpdir(), "ctl1240-int-"));
  // Redirect CATALYST_DIR so getEventLogPath() resolves under a fixture (mirrors scheduler.test.mjs)
  prevCatalystDir = process.env.CATALYST_DIR;
  catalystDir = mkdtempSync(join(tmpdir(), "ctl1240-cat-"));
  process.env.CATALYST_DIR = catalystDir;
  // Ensure no ambient env vars bleed in from the outer shell
  delete process.env.CATALYST_RECOVERY_PASS;
  delete process.env.CATALYST_UNSTUCK_SWEEP;
});

afterEach(() => {
  stopScheduler();
  __resetForTests();
  rmSync(orchDir, { recursive: true, force: true });
  rmSync(catalystDir, { recursive: true, force: true });
  if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
  else process.env.CATALYST_DIR = prevCatalystDir;
  delete process.env.CATALYST_RECOVERY_PASS;
  delete process.env.CATALYST_UNSTUCK_SWEEP;
});

// ── Helpers ──

function writeSignal(ticket, phase, status, extra = {}) {
  const dir = join(orchDir, "workers", ticket);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `phase-${phase}.json`),
    JSON.stringify({ ticket, phase, status, ...extra }),
  );
}

function fakeDispatch({ code = 0 } = {}) {
  const calls = [];
  const fn = (opts) => {
    calls.push(opts);
    return { code, stdout: "", stderr: "" };
  };
  fn.calls = calls;
  return fn;
}

// Recording gateway spy: tracks every getDescriptor call.
function makeGatewaySpy(descriptors = {}) {
  const calls = [];
  const spy = {
    getDescriptor: (id) => {
      calls.push(id);
      return descriptors[id] ?? null;
    },
    get calls() { return calls; },
  };
  return spy;
}

// Minimal writeStatus that prevents any real Linear write from firing during the tick.
const noopWriteStatus = {
  applyPhaseStatus: () => {},
  applyTerminalDone: () => {},
  applyLabel: () => ({ applied: true }),
  removeLabel: () => ({ removed: true }),
  runTransition: () => ({ applied: false }),
};

// Recovery-intent marker path (mirrors CTL-1191 test at scheduler.test.mjs:8903).
const recoveryIntentMarker = (ticket) =>
  join(orchDir, ".recovery-intents", `${ticket}.json`);

// ── Phase 1 ────────────────────────────────────────────────────────────────────
//
// Drives ONE synchronous startScheduler tick with CATALYST_RECOVERY_PASS=shadow.
// The Pass 0r terminal filter (scheduler.mjs:3464–3471) resolves Linear state via
// fetchTicketState(id, { cache, gateway }) using the in-scope schedulerTick gateway.
//
// PRE-FIX: gateway is dropped at startScheduler → spy.getDescriptor never called,
//          and the Done ticket is NOT filtered (linearis exec falls through to null
//          → fail-open non-terminal → both tickets processed).
// POST-FIX: spy consulted; Done ticket filtered (terminal), In-Progress ticket kept.

describe("CTL-1240 Phase 1 — gateway threaded through startScheduler spine", () => {
  const DONE_TICKET = "CTL-1240-DONE";
  const LIVE_TICKET = "CTL-1240-LIVE";

  test("startScheduler threads gateway into the reasoning-pass terminal filter", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    writeSignal(DONE_TICKET, "implement", "stalled");
    writeSignal(LIVE_TICKET, "implement", "stalled");

    const fresh = new Date().toISOString(); // within the 60s gateway-fresh window
    const gateway = makeGatewaySpy({
      [DONE_TICKET]: { state: "Done", removed: false, updatedAt: fresh },
      [LIVE_TICKET]: { state: "In Progress", removed: false, updatedAt: fresh },
    });

    process.env.CATALYST_RECOVERY_PASS = "shadow";

    startScheduler({
      orchDir,
      dispatch: fakeDispatch({ code: 0 }),
      readEligible: () => [],
      gateway,
      liveBackgroundCount: () => 0,
      tickIntervalMs: 60_000,
      debounceMs: 5,
      writeStatus: noopWriteStatus,
    });

    // Threading proof: the gateway spy must be consulted on the initial synchronous tick.
    // PRE-FIX: gateway is dropped at startScheduler → this assertion fails (calls.length === 0).
    expect(gateway.calls.length).toBeGreaterThan(0);

    // Behavioral proof: Done ticket was filtered (terminal → not processed);
    // In-Progress ticket was processed (non-terminal). CTL-1157 F #5 retired the
    // recovery-intent MARKER as the observable — shadow mode no longer writes a
    // cooldown marker for a DEFERRED (untyped stuck) item (it would mutate enforce
    // scheduler state). The processing observable is now the recovery.would-defer
    // EVENT in the unified log (under the redirected CATALYST_DIR): the non-terminal
    // LIVE ticket emits it; the terminal DONE ticket is filtered by Pass 0r → no
    // recovery event names it.
    const eventsDir = join(catalystDir, "events");
    const eventLines = existsSync(eventsDir)
      ? readdirSync(eventsDir)
          .flatMap((f) => readFileSync(join(eventsDir, f), "utf8").split("\n"))
          .filter(Boolean)
      : [];
    // LIVE (non-terminal) was PROCESSED by the reasoning pass → per-item would-defer.
    expect(eventLines.some((l) => l.includes(LIVE_TICKET) && l.includes("would-defer"))).toBe(true);
    // DONE (terminal) was FILTERED by Pass 0r before the reasoning pass → it has NO
    // per-item reasoning event (recovery.decision / recovery.would-*). It legitimately
    // appears in the whole-board recovery.board-scan snapshot — that is a census, not
    // processing — so match only the per-item event names, not a bare "recovery.".
    const donePerItem = eventLines.some(
      (l) => l.includes(DONE_TICKET) && (l.includes("recovery.decision") || l.includes("would-")),
    );
    expect(donePerItem).toBe(false);
    // And the DONE ticket is still never cooled down (terminal → filtered before processing).
    expect(existsSync(recoveryIntentMarker(DONE_TICKET))).toBe(false);
  });
});

// ── Phase 2 ────────────────────────────────────────────────────────────────────
//
// Sites 4 and 5: the default census closures in runTick call fetchTicketState(id)
// bare (no cache, no gateway). After the fix they pass { cache, gateway }.

describe("CTL-1240 Phase 2 — census closures use { cache, gateway }", () => {
  // ── Site 4: default stall-clear census (scheduler.mjs:5334–5345) ─────────────
  //
  // Seed a prior-artifact-retry-exhausted stalled signal so the DEFAULT
  // collectStallClearCandidates closure fires and calls isLinearTerminal(ticket).
  //
  // PRE-FIX: isLinearTerminal closure calls fetchTicketState(id) bare →
  //          gateway spy never consulted.
  // POST-FIX: fetchTicketState(id, { cache: runningOpts.cache, gateway: runningOpts.gateway })
  //           → spy consulted.

  test("default stall-clear census uses { cache, gateway } via runningOpts", () => {
    const STALL_TICKET = "CTL-1240-STALL";

    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    // Seed the stalled signal — stalledReason triggers the J3 isLinearTerminal probe.
    writeSignal(STALL_TICKET, "implement", "stalled", {
      stalledReason: "prior-artifact-retry-exhausted",
      dispatchFailureCode: 2,
    });
    // Prior-phase done signal required by defaultCollectStallClearCandidates
    // to check priorDoneSignalPresent (CTL-1045 Bug 3).
    writeSignal(STALL_TICKET, "plan", "done");

    const fresh = new Date().toISOString();
    const gateway = makeGatewaySpy({
      [STALL_TICKET]: { state: "Done", removed: false, updatedAt: fresh },
    });

    startScheduler({
      orchDir,
      dispatch: fakeDispatch({ code: 0 }),
      readEligible: () => [],
      gateway,
      liveBackgroundCount: () => 0,
      tickIntervalMs: 60_000,
      debounceMs: 5,
      writeStatus: noopWriteStatus,
    });

    // The stall-clear census isLinearTerminal closure must have consulted the gateway.
    // PRE-FIX: fetchTicketState(id) bare → spy never called → assertion fails.
    expect(gateway.calls).toContain(STALL_TICKET);
  });

  // ── Site 5: default unstuck census (scheduler.mjs:5356–5361) ─────────────────
  //
  // Set CATALYST_UNSTUCK_SWEEP=shadow to arm Pass 0u, then seed a stalled worker
  // so defaultCollectUnstuckCandidates calls isLinearTerminal(ticket).
  //
  // PRE-FIX: isLinearTerminal closure calls fetchTicketState(id) bare →
  //          gateway spy never consulted.
  // POST-FIX: fetchTicketState(id, { cache: runningOpts.cache, gateway: runningOpts.gateway })
  //           → spy consulted.

  test("default unstuck census uses { cache, gateway } via runningOpts", () => {
    const STUCK_TICKET = "CTL-1240-STUCK";

    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    writeSignal(STUCK_TICKET, "implement", "stalled", {
      stalledReason: "work-not-done-after-stale-bg",
    });

    const fresh = new Date().toISOString();
    const gateway = makeGatewaySpy({
      [STUCK_TICKET]: { state: "In Progress", removed: false, updatedAt: fresh },
    });

    process.env.CATALYST_UNSTUCK_SWEEP = "shadow";

    startScheduler({
      orchDir,
      dispatch: fakeDispatch({ code: 0 }),
      readEligible: () => [],
      gateway,
      liveBackgroundCount: () => 0,
      tickIntervalMs: 60_000,
      debounceMs: 5,
      writeStatus: noopWriteStatus,
    });

    // The unstuck census isLinearTerminal closure must have consulted the gateway.
    // PRE-FIX: fetchTicketState(id) bare → spy never called → assertion fails.
    expect(gateway.calls).toContain(STUCK_TICKET);
  });
});
