// delegate-emit-wiring.test.mjs — CTL-1774 Phase 3: spy-based emit tests for all 6
// routeStuckTicketToDelegate call sites. Each test injects appendDelegateEvent as a spy
// via the new param (which doesn't exist yet → Red) and asserts it is called in shadow mode.
//
// Run: cd plugins/dev/scripts/execution-core && bun test delegate-emit-wiring.test.mjs
//
// Scrub CATALYST_* env before attributing failures to this change — see the
// scheduler-test-flaky-order-env memory for the known flaky-baseline family.

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { maybeEscalateDispatchFailures } from "./scheduler.mjs";
import { defaultEscalate } from "./stale-pr-rescue-timer.mjs";
import { sweepMissingTriage, reconcileAll, __resetForTests } from "./monitor.mjs";
import { dropProject } from "./eligible-set.mjs";

// ── common fixtures ───────────────────────────────────────────────────────────

let orchDir;
let catalystDir;
let prevCatalystDir;
let prevDelegateFirst;

const enrolledTeams = new Set();
const registryEntries = [];

function writeRegistry() {
  writeFileSync(
    join(catalystDir, "execution-core", "registry.json"),
    JSON.stringify({ projects: registryEntries }, null, 2)
  );
}

function enroll(team, eligibleQuery) {
  const repoRoot = mkdtempSync(join(catalystDir, `repo-${team}-`));
  registryEntries.push({ team, repoRoot, eligibleQuery: eligibleQuery ?? null });
  writeRegistry();
  enrolledTeams.add(team);
  return repoRoot;
}

function execReturning(nodesByTeam) {
  const fn = (_cmd, args) => {
    fn.calls += 1;
    const team = args[args.indexOf("--team") + 1];
    return { code: 0, stdout: JSON.stringify({ nodes: nodesByTeam[team] ?? [] }), stderr: "" };
  };
  fn.calls = 0;
  return fn;
}

const node = (identifier, priority = 2) => ({ identifier, state: { name: "Todo" }, priority });

// fakeWriteStatus — mirrors the scheduler.test.mjs helper so maybeEscalateDispatchFailures
// has a working applyLabel without shelling out to linearis.
const fakeWriteStatus = (applied = []) => ({
  applyLabel: ({ ticket, label }) => {
    applied.push({ ticket, label });
    return { applied: true };
  },
  transition: () => {},
  applyPhaseStatus: () => {},
});

beforeEach(() => {
  prevCatalystDir = process.env.CATALYST_DIR;
  prevDelegateFirst = process.env.CATALYST_DELEGATE_FIRST;
  orchDir = mkdtempSync(join(tmpdir(), "del-emit-orch-"));
  catalystDir = mkdtempSync(join(tmpdir(), "del-emit-cat-"));
  process.env.CATALYST_DIR = catalystDir;
  mkdirSync(join(catalystDir, "execution-core"), { recursive: true });
  __resetForTests();
  enrolledTeams.clear();
  registryEntries.length = 0;
});

afterEach(() => {
  for (const t of enrolledTeams) dropProject(t);
  __resetForTests();
  if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
  else process.env.CATALYST_DIR = prevCatalystDir;
  if (prevDelegateFirst === undefined) delete process.env.CATALYST_DELEGATE_FIRST;
  else process.env.CATALYST_DELEGATE_FIRST = prevDelegateFirst;
  rmSync(orchDir, { recursive: true, force: true });
  rmSync(catalystDir, { recursive: true, force: true });
});

// ── Site 1: maybeEscalateDispatchFailures (scheduler.mjs) ────────────────────

describe("CTL-1774 Phase 3 — Site 1: maybeEscalateDispatchFailures", () => {
  // DISPATCH_FAILURE_ESCALATION_THRESHOLD = 3 (not exported); 10 is safely above it
  const overThreshold = 10;

  test("shadow mode: appendDelegateEvent called with delegate.would-route (site: dispatch-failures)", () => {
    const delegateSpy = mock(() => {});
    const applied = [];
    const ws = fakeWriteStatus(applied);
    const marker = {
      ticket: "CTL-5",
      phase: "research",
      code: 2,
      consecutiveFailures: overThreshold,
    };

    maybeEscalateDispatchFailures(orchDir, marker, {
      writeStatus: ws,
      appendEvent: () => {},
      env: { CATALYST_DELEGATE_FIRST: "shadow" },
      // ↓ CTL-1774 Phase 3: new param — does not exist yet → spy never called → Red
      appendDelegateEvent: delegateSpy,
    });

    expect(delegateSpy).toHaveBeenCalledTimes(1);
    const evt = delegateSpy.mock.calls[0][0];
    expect(evt.name).toBe("delegate.would-route");
    expect(evt.ticket).toBe("CTL-5");
    expect(evt.site).toBe("dispatch-failures");
    // Shadow: label is still applied (no enqueue), spy was just an observer
    expect(applied).toEqual([expect.objectContaining({ ticket: "CTL-5", label: "needs-human" })]);
  });

  test("off mode: appendDelegateEvent NOT called (byte-identical to today)", () => {
    const delegateSpy = mock(() => {});
    const applied = [];
    const ws = fakeWriteStatus(applied);
    const marker = {
      ticket: "CTL-5",
      phase: "research",
      code: 2,
      consecutiveFailures: overThreshold,
    };

    maybeEscalateDispatchFailures(orchDir, marker, {
      writeStatus: ws,
      appendEvent: () => {},
      env: { CATALYST_DELEGATE_FIRST: "off" },
      appendDelegateEvent: delegateSpy,
    });

    expect(delegateSpy).not.toHaveBeenCalled();
  });

  test("enforce + runner disabled: appendDelegateEvent called with delegate.route-fallback", () => {
    const delegateSpy = mock(() => {});
    const applied = [];
    const ws = fakeWriteStatus(applied);
    const marker = {
      ticket: "CTL-5",
      phase: "research",
      code: 2,
      consecutiveFailures: overThreshold,
    };

    // enforce mode with no runner → fail-safe gate fires → route-fallback
    maybeEscalateDispatchFailures(orchDir, marker, {
      writeStatus: ws,
      appendEvent: () => {},
      env: { CATALYST_DELEGATE_FIRST: "enforce" },
      appendDelegateEvent: delegateSpy,
    });

    expect(delegateSpy).toHaveBeenCalledTimes(1);
    const evt = delegateSpy.mock.calls[0][0];
    expect(evt.name).toBe("delegate.route-fallback");
    expect(evt.ticket).toBe("CTL-5");
    expect(evt.reason).toBe("runner-disabled");
  });
});

// ── Site 6: defaultEscalate (stale-pr-rescue-timer.mjs) ──────────────────────

describe("CTL-1774 Phase 3 — Site 6: defaultEscalate", () => {
  test("shadow mode: appendDelegateEvent called with delegate.would-route (site: stale-pr-rescue)", () => {
    const delegateSpy = mock(() => {});
    const applyLabelMock = mock(() => ({ applied: true }));
    const linearWrite = {
      applyLabel: applyLabelMock,
      transition: () => {},
      applyPhaseStatus: () => {},
    };

    defaultEscalate(
      "CTL-6",
      { reason: "unresolvable-conflict" },
      {
        orchDir,
        linearWrite,
        env: { CATALYST_DELEGATE_FIRST: "shadow" },
        // ↓ CTL-1774 Phase 3: new param — does not exist yet → spy never called → Red
        appendDelegateEvent: delegateSpy,
      }
    );

    expect(delegateSpy).toHaveBeenCalledTimes(1);
    const evt = delegateSpy.mock.calls[0][0];
    expect(evt.name).toBe("delegate.would-route");
    expect(evt.ticket).toBe("CTL-6");
    expect(evt.site).toBe("stale-pr-rescue");
  });

  test("off mode: appendDelegateEvent NOT called", () => {
    const delegateSpy = mock(() => {});
    const linearWrite = fakeWriteStatus();

    defaultEscalate(
      "CTL-6",
      { reason: "unresolvable-conflict" },
      {
        orchDir,
        linearWrite,
        env: { CATALYST_DELEGATE_FIRST: "off" },
        appendDelegateEvent: delegateSpy,
      }
    );

    expect(delegateSpy).not.toHaveBeenCalled();
  });
});

// ── Site 5: dispatchTriage → labelNeedsHuman (monitor.mjs) ───────────────────

describe("CTL-1774 Phase 3 — Site 5: sweepMissingTriage / dispatchTriage default labelNeedsHuman", () => {
  test("shadow mode: appendDelegateEvent called with delegate.would-route (site: triage-redispatch-cap)", () => {
    enroll("ENG", { status: "Ready" });
    const realOrchDir = join(catalystDir, "execution-core");

    // Seed the triage dispatch count at the cap limit (count: 3 = TRIAGE_DISPATCH_CAP default)
    const countsDir = join(realOrchDir, ".triage-dispatch-counts");
    mkdirSync(countsDir, { recursive: true });
    writeFileSync(join(countsDir, "ENG-9.json"), JSON.stringify({ count: 3 }));

    // Populate the eligible set for the ENG team
    const exec = execReturning({ ENG: [node("ENG-9")] });
    reconcileAll({ exec });

    const delegateSpy = mock(() => {});

    // Set CATALYST_DELEGATE_FIRST=shadow so the routeStuckTicketToDelegate inside
    // the default labelNeedsHuman closure activates shadow mode. The closure uses
    // process.env (the routeStuckTicketToDelegate default env).
    process.env.CATALYST_DELEGATE_FIRST = "shadow";

    sweepMissingTriage({
      orchDir: realOrchDir,
      dispatch: mock(() => ({ code: 0 })),
      applyTriageStatus: () => ({
        applied: false,
        verified: false,
        from_state: null,
        to_state: null,
        reason: null,
      }),
      appendEvent: () => {},
      readMaxParallelFn: () => 6,
      liveBackgroundCount: () => 0,
      // ↓ CTL-1774 Phase 3: new param — does not exist yet → spy never called → Red
      // After Green: sweepMissingTriage threads this to dispatchTriage, which passes
      // it to the default labelNeedsHuman closure via routeStuckTicketToDelegate.
      appendDelegateEvent: delegateSpy,
    });

    expect(delegateSpy).toHaveBeenCalledTimes(1);
    const evt = delegateSpy.mock.calls[0][0];
    expect(evt.name).toBe("delegate.would-route");
    expect(evt.site).toBe("triage-redispatch-cap");
  });

  test("off mode (CATALYST_DELEGATE_FIRST unset): appendDelegateEvent NOT called at triage cap", () => {
    enroll("ENG", { status: "Ready" });
    const realOrchDir = join(catalystDir, "execution-core");

    const countsDir = join(realOrchDir, ".triage-dispatch-counts");
    mkdirSync(countsDir, { recursive: true });
    writeFileSync(join(countsDir, "ENG-9.json"), JSON.stringify({ count: 3 }));

    const exec = execReturning({ ENG: [node("ENG-9")] });
    reconcileAll({ exec });

    delete process.env.CATALYST_DELEGATE_FIRST; // off (default)

    const delegateSpy = mock(() => {});
    sweepMissingTriage({
      orchDir: realOrchDir,
      dispatch: mock(() => ({ code: 0 })),
      applyTriageStatus: () => ({
        applied: false,
        verified: false,
        from_state: null,
        to_state: null,
        reason: null,
      }),
      appendEvent: () => {},
      readMaxParallelFn: () => 6,
      liveBackgroundCount: () => 0,
      appendDelegateEvent: delegateSpy,
    });

    expect(delegateSpy).not.toHaveBeenCalled();
  });
});
