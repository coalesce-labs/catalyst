// integration-ctl-1240.test.mjs — CTL-1240: wire gateway tier into startScheduler tick.
//
// Five sites in scheduler.mjs silently drop the `gateway` reader that the daemon
// correctly threads into startScheduler. These tests drive startScheduler (the
// real production path) and assert the gateway spy is consulted on the initial
// synchronous tick — proving the threading is live, not dead.
//
// Test structure mirrors the CTL-537 forwarding test (scheduler.test.mjs:6808) and
// the CTL-1191 terminal-filter test (scheduler.test.mjs:8906).
//
// CTL-2141 removed "Phase 1" (site #3 of the original five: the Pass 0r terminal
// filter at the old scheduler.mjs:3464-3471) along with the rest of Pass 0r —
// that call site no longer exists, so there is nothing left to thread gateway
// into there. Phase 2 (sites 4 and 5, the census closures) is mechanical and
// unaffected.

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
//
// The spy also records each call's stack so a test can assert WHICH census
// consulted the gateway. A bare `calls.toContain(ticket)` does not discriminate:
// several passes in one tick resolve the same ticket's state (the terminal sweep
// via isTicketTerminalOrMerged, for one), so that assertion stays green even when
// the census under test never ran at all. calledFrom() pins it to the caller.
function makeGatewaySpy(descriptors = {}) {
  const calls = [];
  const stacks = [];
  const spy = {
    getDescriptor: (id) => {
      calls.push(id);
      stacks.push({ id, stack: new Error().stack ?? "" });
      return descriptors[id] ?? null;
    },
    get calls() { return calls; },
    // True iff `id` was resolved through a call originating in `sourceFile`.
    calledFrom: (id, sourceFile) =>
      stacks.some((s) => s.id === id && s.stack.includes(sourceFile)),
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
    // Must be a canonical TEAM-123 key: CTL-1504 added an isTicketKey guard to the
    // worker-dir censuses (stall-janitor.mjs, unstuck-sweep.mjs), so a descriptive
    // id like "CTL-1240-STALL" is skipped as debris and the closure under test never
    // runs — the spy stays empty and the assertion fails for the wrong reason.
    // Codex #3148 P1: use the canonical PROJ-<n> placeholder prefix — AGENTS.md
    // "Version Control" keeps portable fixtures on PROJ rather than committing a
    // real team's prefix.
    const STALL_TICKET = "PROJ-1240";

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
    //
    // Codex #3148 P2: pinned to the EXACT collector frame, not the module. Both the
    // J3 stall-clear census and the J4 terminal-signal GC census live in
    // stall-janitor.mjs and resolve this same worker through separately wired gateway
    // closures, so a "stall-janitor.mjs" pin can be satisfied by J4 on J3's behalf —
    // leaving the test green through the very regression it exists to catch.
    //
    // Scope of what was verified: mutating J3 back to bare fetchTicketState(id) fails
    // this test. It also failed under the OLD module-name pin in an isolated run, so
    // the blindness did NOT reproduce here — Codex reported it under a preloaded fresh
    // liveness snapshot (as occurs in the full suite), which this file does not set up.
    // The frame pin is applied regardless: it is strictly tighter than the module pin,
    // cannot be satisfied by a sibling census, and is the assertion this test means.
    expect(
      gateway.calledFrom(STALL_TICKET, "defaultCollectStallClearCandidates"),
    ).toBe(true);
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
    // Canonical TEAM-123 key for the same CTL-1504 isTicketKey reason as above.
    // "CTL-1240-STUCK" was likewise skipped by the census; this assertion only
    // passed because another pass in the same tick happened to consult the spy,
    // so it was not actually exercising the unstuck census closure.
    const STUCK_TICKET = "PROJ-1241";

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
    // Pinned to unstuck-sweep.mjs for the same reason as the stall-clear case.
    expect(
      gateway.calledFrom(STUCK_TICKET, "defaultCollectUnstuckCandidates"),
    ).toBe(true);
  });
});
