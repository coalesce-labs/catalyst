// lane-claim-wiring.test.mjs — CTL-2068.
//
// ⭐ THE POINT OF THIS FILE. lane-claim.test.mjs proves the CLASSIFIER is right. That is
// worth nothing on its own: a guard that is never consulted is a check that cannot fail,
// which is the failure shape this repo keeps shipping. These tests assert the guard is
// reached from the real write entry point, that a REFUSE actually stops the write, and that
// the module-level install — the path production uses and no injected test exercises — is
// wired.
//
// Run: cd plugins/dev/scripts/execution-core && bun test lane-claim-wiring.test.mjs
import { afterEach, describe, expect, test } from "bun:test";
import { applyPhaseStatus } from "./linear-write.mjs";
import { setLaneClaimGuard, getLaneClaimGuard } from "./lane-claim-install.mjs";
import { buildLaneClaimGuard, VERDICT } from "./lane-claim.mjs";

const STATE_MAP = {
  research: "Research",
  planning: "Plan",
  inProgress: "Implement",
  verifying: "Validate",
  reviewing: "Validate",
  inReview: "PR",
};
const FLEET = "78f8f491-a980-4b99-91a3-8280821f0821";
const LANE = "c2a8cc92-cab6-4536-9500-0f24abdf702b";

function harness({ lastActor, currentState = "Implement" }) {
  const execCalls = [];
  const guard = buildLaneClaimGuard({
    stateMap: STATE_MAP,
    botUserIds: new Set([FLEET]),
    readLastStateChange: () => ({ actorId: lastActor, toState: currentState }),
  });
  const call = (phase = "research") =>
    applyPhaseStatus({
      ticket: "CTC-787",
      phase,
      resolveRepoRoot: () => "/tmp/repo",
      exec: (bin, args) => {
        execCalls.push({ bin, args });
        return {
          code: 0,
          stdout: JSON.stringify({ action: "transitioned", currentState, targetState: "Research" }),
        };
      },
      fetchState: () => currentState,
      laneClaim: guard,
    });
  return { call, execCalls };
}

afterEach(() => setLaneClaimGuard(null));

describe("the guard is reached from applyPhaseStatus", () => {
  test("⭐ a lane-claimed regression is REFUSED and the shell is never spawned", () => {
    const { call, execCalls } = harness({ lastActor: LANE });
    const res = call("research"); // implement(3) -> research(1)
    expect(res.applied).toBe(false);
    expect(res.skipped).toBe("lane-claimed-no-regression");
    expect(res.from_state).toBe("Implement");
    // ⛔ The load-bearing assertion. Asserting only the return shape would pass even if the
    // write had already gone to Linear and the refusal were cosmetic.
    expect(execCalls).toEqual([]);
  });

  test("⛔ CONTROL — the identical regression authored by the FLEET is written", () => {
    const { call, execCalls } = harness({ lastActor: FLEET });
    const res = call("research");
    expect(res.applied).toBe(true);
    expect(execCalls.length).toBeGreaterThan(0);
  });

  test("⛔ CONTROL — a FORWARD write under the same lane claim is written", () => {
    // Without this, a guard that refused every write would pass the first test.
    const { call, execCalls } = harness({ lastActor: LANE });
    const res = call("pr"); // implement(3) -> inReview(6)
    expect(res.applied).toBe(true);
    expect(execCalls.length).toBeGreaterThan(0);
  });

  test("⛔ CONTROL — an unranked current state (Todo) is written, so queued work still starts", () => {
    const { call, execCalls } = harness({ lastActor: LANE, currentState: "Todo" });
    const res = call("research");
    expect(res.applied).toBe(true);
    expect(execCalls.length).toBeGreaterThan(0);
  });
});

describe("the MODULE-LEVEL install — the path production uses", () => {
  test("no guard installed → writes proceed exactly as before CTL-2068", () => {
    expect(getLaneClaimGuard()).toBe(null);
    const execCalls = [];
    const res = applyPhaseStatus({
      ticket: "CTC-787",
      phase: "research",
      resolveRepoRoot: () => "/tmp/repo",
      exec: (bin, args) => {
        execCalls.push({ bin, args });
        return {
          code: 0,
          stdout: JSON.stringify({
            action: "transitioned",
            currentState: "Implement",
            targetState: "Research",
          }),
        };
      },
      fetchState: () => "Implement",
      // no laneClaim injected — this is the pre-CTL-2068 shape
    });
    expect(res.applied).toBe(true);
    expect(execCalls.length).toBe(1);
  });

  test("⭐ a guard installed via setLaneClaimGuard refuses WITHOUT being passed as an argument", () => {
    setLaneClaimGuard(
      buildLaneClaimGuard({
        stateMap: STATE_MAP,
        botUserIds: new Set([FLEET]),
        readLastStateChange: () => ({ actorId: LANE, toState: "Implement" }),
      })
    );
    const execCalls = [];
    const res = applyPhaseStatus({
      ticket: "CTC-787",
      phase: "research",
      resolveRepoRoot: () => "/tmp/repo",
      exec: (bin, args) => {
        execCalls.push({ bin, args });
        return { code: 0, stdout: "{}" };
      },
      fetchState: () => "Implement",
    });
    expect(res.skipped).toBe("lane-claimed-no-regression");
    expect(execCalls).toEqual([]);
  });

  test("the guard's botUserIds Set is held by REFERENCE, so a rotation is picked up live", () => {
    // daemon.mjs passes the stable Set that refreshBotIdentities fills in place. Mutating
    // it after construction must change the verdict, or a re-minted app-actor would read as
    // a lane and the fleet would refuse its own writes.
    const bots = new Set([FLEET]);
    const g = buildLaneClaimGuard({
      stateMap: STATE_MAP,
      botUserIds: bots,
      readLastStateChange: () => ({ actorId: "NEW-ACTOR", toState: "Implement" }),
    });
    const args = { ticket: "T-1", currentState: "Implement", targetKey: "research" };
    expect(g.evaluate(args).verdict).toBe(VERDICT.REFUSE); // NEW-ACTOR unknown → looks like a lane
    bots.add("NEW-ACTOR"); // the rotation lands
    expect(g.evaluate(args).verdict).toBe(VERDICT.ALLOW);
  });
});

// ── the DISPATCH veto, driven through the real schedulerTick ──────────────────
//
// ⛔ This block does NOT live in scheduler.test.mjs, which is where dispatchAndVerify's
// other tests are. That suite is EXCLUDED from execution-core-tests.yml (flaky fs.watch
// timers), so a veto test placed there would never run in CI — a guard nobody runs is a
// check that cannot fail, which is the same shape as the defect this ticket fixes. Both
// lane-claim files are added to the workflow's stable list in this PR.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schedulerTick } from "./scheduler.mjs";

describe("the DISPATCH veto, through schedulerTick", () => {
  let orchDir;

  const seed = () => {
    orchDir = mkdtempSync(join(tmpdir(), "ctl2068-"));
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    // A completed `research` signal, so the FSM's next owed phase is `plan`.
    const dir = join(orchDir, "workers", "CTC-787");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "phase-research.json"),
      JSON.stringify({ ticket: "CTC-787", phase: "research", status: "done" })
    );
  };

  const dispatchSpy = () => {
    const calls = [];
    const fn = ({ ticket, phase }) => {
      calls.push({ ticket, phase });
      return { code: 0, stdout: "", stderr: "" };
    };
    fn.calls = calls;
    return fn;
  };

  const install = ({ lastActor, currentState }) =>
    setLaneClaimGuard(
      buildLaneClaimGuard({
        stateMap: STATE_MAP,
        botUserIds: new Set([FLEET]),
        readLastStateChange: () => ({ actorId: lastActor, toState: currentState }),
        readCurrentState: () => currentState,
      })
    );

  afterEach(() => {
    setLaneClaimGuard(null);
    if (orchDir) rmSync(orchDir, { recursive: true, force: true });
  });

  test("⭐ a lane-claimed ticket is NOT dispatched — the spy is never called", () => {
    seed();
    // The lane holds it at `Implement` (rank 3); the owed phase is `plan` (rank 2).
    install({ lastActor: LANE, currentState: "Implement" });
    const dispatch = dispatchSpy();
    const r = schedulerTick(orchDir, { readEligible: () => [], dispatch, now: () => 70_000 });
    expect(dispatch.calls).toEqual([]);
    expect(r.advanced ?? []).toEqual([]);
  });

  test("⛔ CONTROL — the SAME tick dispatches when the FLEET made the last state change", () => {
    // Without this control, a veto that refused everything (or a harness that never
    // dispatches at all) would pass the test above and prove nothing.
    seed();
    install({ lastActor: FLEET, currentState: "Implement" });
    const dispatch = dispatchSpy();
    schedulerTick(orchDir, { readEligible: () => [], dispatch, now: () => 70_000 });
    expect(dispatch.calls).toContainEqual({ ticket: "CTC-787", phase: "plan" });
  });

  test("⛔ CONTROL — with NO guard installed the same tick dispatches (pre-CTL-2068 behaviour)", () => {
    seed();
    const dispatch = dispatchSpy();
    schedulerTick(orchDir, { readEligible: () => [], dispatch, now: () => 70_000 });
    expect(dispatch.calls).toContainEqual({ ticket: "CTC-787", phase: "plan" });
  });
});

// ── the PROXY rung: the guard re-applied to the fresher `--resolve-only` state ────────
//
// Both rungs exist for the same reason CTL-758's guard is applied twice. The first rung
// runs on `knownCurrentState ?? fetchState`, which is FAIL-OPEN: on an enforce host with no
// `linearis` and a cold cache that read returns null and the guard abstains. `--resolve-only`
// then reads the state from the replica and may well come back `Implement`. Without the
// second rung the enforce path — the one both minis actually run — would build and send the
// payload on evidence the first rung never saw.
import { setLinearWriteProxy, setLinearWriteProxyResolver } from "./linear-write-proxy-install.mjs";

describe("the PROXY rung — the guard on the fresher resolve-only evidence", () => {
  const ISSUE_ID = "11111111-1111-4111-8111-111111111111";
  const STATE_ID = "22222222-2222-4222-8222-222222222222";
  const resolver = {
    issue: () => ({ ok: true, issueId: ISSUE_ID, teamId: "team-1" }),
    stateId: () => ({ ok: true, stateId: STATE_ID }),
    labelIds: (names) => ({
      ok: true,
      labelIds: names.map(() => "33333333-3333-4333-8333-333333333333"),
    }),
  };
  const proxy = () => {
    const sends = [];
    return {
      mode: "enforce",
      sends,
      send: (r) => (sends.push(r), { handled: true, applied: true, reason: null }),
    };
  };

  afterEach(() => {
    setLinearWriteProxy(null);
    setLinearWriteProxyResolver(null);
    setLaneClaimGuard(null);
  });

  // The first rung cannot see the claim: fetchState returns null (the fail-open read).
  // Only `--resolve-only` knows the ticket is at `Implement`.
  const callWithBlindFirstRung = (lastActor) => {
    setLinearWriteProxyResolver(resolver);
    setLaneClaimGuard(
      buildLaneClaimGuard({
        stateMap: STATE_MAP,
        botUserIds: new Set([FLEET]),
        readLastStateChange: () => ({ actorId: lastActor, toState: "Implement" }),
      })
    );
    const p = proxy();
    const res = applyPhaseStatus({
      ticket: "CTC-787",
      phase: "research",
      resolveRepoRoot: () => "/tmp/repo",
      exec: () => ({
        code: 0,
        stdout: JSON.stringify({
          action: "transitioned",
          currentState: "Implement",
          targetState: "Research",
        }),
      }),
      fetchState: () => null, // ⛔ the fail-open first read — the blind spot this rung covers
      proxy: p,
    });
    return { res, sends: p.sends };
  };

  test("⭐ REFUSES on evidence the first rung never saw — and sends NOTHING to the cloud", () => {
    const { res, sends } = callWithBlindFirstRung(LANE);
    expect(res.applied).toBe(false);
    expect(res.reason).toBe("resolve:lane-claimed-no-regression");
    // The assertion that matters: no payload reached the transport.
    expect(sends).toEqual([]);
  });

  test("⛔ CONTROL — the same call with the FLEET as last actor DOES send", () => {
    const { res, sends } = callWithBlindFirstRung(FLEET);
    expect(res.applied).toBe(true);
    expect(sends.length).toBe(1);
  });
});

// ── CTL-2070: the TIMELY source, wired end-to-end through applyPhaseStatus ─────────────
//
// These prove the write-ledger source actually reaches the real write entry point and that a
// REFUSE stops the shell — timing PINNED via injected nowMs/updatedAt, and with a NEGATIVE
// CONTROL asserting the refusal DISAPPEARS when the source is removed (the dead-branch class).
describe("CTL-2070 — the timely source reaches applyPhaseStatus", () => {
  const T = 1_000_000_000_000;

  // Build a guard whose ONLY discriminator is the timely write-ledger, drive a regress through
  // the real applyPhaseStatus, and capture whether the shell spawned.
  const timelyCall = ({
    readFleetWrite, // omit → the source is REMOVED (undefined wrapper)
    currentUpdatedAt = () => T,
    now = () => T + 60_000, // 60 s after the observation → inside the window
    recencyMs = 300_000,
    botUserIds = new Set([FLEET]),
    readLastStateChange = () => null,
    phase = "research", // Implement(3) -> Research(1): a regress
    currentState = "Implement",
  }) => {
    const execCalls = [];
    const guard = buildLaneClaimGuard({
      stateMap: STATE_MAP,
      botUserIds,
      readLastStateChange,
      readFleetWrite,
      readCurrentUpdatedAt: currentUpdatedAt,
      nowMs: now,
      recencyMs,
    });
    const res = applyPhaseStatus({
      ticket: "CTC-787",
      phase,
      resolveRepoRoot: () => "/tmp/repo",
      exec: (bin, args) => {
        execCalls.push({ bin, args });
        return {
          code: 0,
          stdout: JSON.stringify({ action: "transitioned", currentState, targetState: "Research" }),
        };
      },
      fetchState: () => currentState,
      laneClaim: guard,
    });
    return { res, execCalls };
  };

  afterEach(() => setLaneClaimGuard(null));

  test("1. AC#1 — a lane-owned regression within 60 s is REFUSED; the shell never spawns", () => {
    const { res, execCalls } = timelyCall({ readFleetWrite: () => null });
    expect(res.applied).toBe(false);
    expect(res.skipped).toBe("lane-claimed-no-regression");
    expect(execCalls).toEqual([]); // the load-bearing assertion
  });

  test("2. AC#2 — history-less: null ledger AND no history → STILL refused (needs no history)", () => {
    const { res, execCalls } = timelyCall({
      readFleetWrite: () => null,
      readLastStateChange: () => null, // no issue_history rows at all
    });
    expect(res.applied).toBe(false);
    expect(execCalls).toEqual([]);
  });

  test("⛔ 3. NEGATIVE CONTROL — remove the timely source and the SAME regress proceeds to the shell", () => {
    // Asserts the wiring genuinely DEPENDS on the source. readFleetWrite omitted → the wrapper
    // yields undefined → the timely block no-ops → a STALE history row falls to STALE_HISTORY
    // (INCONCLUSIVE) → the write proceeds and the shell IS spawned. If it still refused, the
    // source would be dead and the coverage above a lie.
    const { res, execCalls } = timelyCall({
      readFleetWrite: undefined,
      readLastStateChange: () => ({ actorId: LANE, toState: "Research" }), // stale (≠ current)
    });
    expect(res.applied).toBe(true);
    expect(execCalls.length).toBeGreaterThan(0);
  });

  test("4. botUserIds INDEPENDENCE — an EMPTY set still refuses (timely runs before NO_BOT_IDS)", () => {
    const { res, execCalls } = timelyCall({
      readFleetWrite: () => null,
      botUserIds: new Set(),
    });
    expect(res.applied).toBe(false);
    expect(execCalls).toEqual([]);
  });

  test("5. FAIL-OPEN — throwing readers degrade to INCONCLUSIVE, the write proceeds, no throw escapes", () => {
    const { res, execCalls } = timelyCall({
      readFleetWrite: () => {
        throw new Error("ledger read failed");
      },
      currentUpdatedAt: () => {
        throw new Error("replica read failed");
      },
      // no history either → the ladder abstains (NO_HISTORY) → write proceeds
      readLastStateChange: () => null,
    });
    expect(res.applied).toBe(true);
    expect(execCalls.length).toBeGreaterThan(0);
  });

  test("6. fleet recovery is ALLOWED — a ledger entry matching the current state does NOT refuse", () => {
    const { res, execCalls } = timelyCall({
      readFleetWrite: () => ({ toState: "Implement", atMs: T }),
      currentUpdatedAt: () => T,
    });
    expect(res.applied).toBe(true);
    expect(execCalls.length).toBeGreaterThan(0);
  });
});

// ── CTL-2070: the DISPATCH veto uses the timely source, through the real schedulerTick ──
describe("CTL-2070 — the timely source vetoes DISPATCH", () => {
  let orchDir;
  const seed = () => {
    orchDir = mkdtempSync(join(tmpdir(), "ctl2070-"));
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dir = join(orchDir, "workers", "CTC-787");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "phase-research.json"),
      JSON.stringify({ ticket: "CTC-787", phase: "research", status: "done" })
    );
  };
  const dispatchSpy = () => {
    const calls = [];
    const fn = ({ ticket, phase }) => (calls.push({ ticket, phase }), { code: 0, stdout: "", stderr: "" });
    fn.calls = calls;
    return fn;
  };
  afterEach(() => {
    setLaneClaimGuard(null);
    if (orchDir) rmSync(orchDir, { recursive: true, force: true });
  });

  test("⭐ a lane-owned ticket (timely source, NO history) is NOT dispatched", () => {
    seed();
    const T = 1_000_000_000_000;
    setLaneClaimGuard(
      buildLaneClaimGuard({
        stateMap: STATE_MAP,
        botUserIds: new Set([FLEET]),
        readCurrentState: () => "Implement", // owed phase plan(2) regresses Implement(3)
        readLastStateChange: () => null, // NO history — the timely source alone must veto
        readFleetWrite: () => null, // lane owns it
        readCurrentUpdatedAt: () => T,
        nowMs: () => T + 60_000,
        recencyMs: 300_000,
      })
    );
    const dispatch = dispatchSpy();
    schedulerTick(orchDir, { readEligible: () => [], dispatch, now: () => 70_000 });
    expect(dispatch.calls).toEqual([]);
  });

  test("⛔ CONTROL — a fleet-owned ledger entry lets the same tick dispatch", () => {
    seed();
    const T = 1_000_000_000_000;
    setLaneClaimGuard(
      buildLaneClaimGuard({
        stateMap: STATE_MAP,
        botUserIds: new Set([FLEET]),
        readCurrentState: () => "Implement",
        readLastStateChange: () => null,
        readFleetWrite: () => ({ toState: "Implement", atMs: T }), // fleet owns → allow
        readCurrentUpdatedAt: () => T,
        nowMs: () => T + 60_000,
        recencyMs: 300_000,
      })
    );
    const dispatch = dispatchSpy();
    schedulerTick(orchDir, { readEligible: () => [], dispatch, now: () => 70_000 });
    expect(dispatch.calls).toContainEqual({ ticket: "CTC-787", phase: "plan" });
  });
});

// ── CTL-2070: the write-seam records the ledger on an APPLIED transition ────────────────
describe("CTL-2070 — emitStateWrite records the fleet write-ledger", () => {
  let orchDir;
  const seed = () => {
    orchDir = mkdtempSync(join(tmpdir(), "ctl2070-seam-"));
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dir = join(orchDir, "workers", "CTC-787");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "phase-research.json"),
      JSON.stringify({ ticket: "CTC-787", phase: "research", status: "done" })
    );
  };
  afterEach(() => {
    if (orchDir) rmSync(orchDir, { recursive: true, force: true });
  });

  // A dispatch that leaves a runnable successor signal, so dispatchAndVerify confirms the advance
  // (CTL-1789: the scheduler-advance status write fires only inside the dv.ok branch).
  const verifyingDispatch = () => ({ ticket, phase }) => {
    const dir = join(orchDir, "workers", ticket);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `phase-${phase}.json`),
      JSON.stringify({ ticket, phase, status: "running", bg_job_id: "bg-plan-1" })
    );
    return { code: 0, stdout: "", stderr: "" };
  };

  test("an APPLIED transition calls recordFleetWrite(ticket, to_state, ms)", () => {
    seed();
    const recorded = [];
    const recordFleetWrite = (ticket, toState, atMs) => recorded.push({ ticket, toState, atMs });
    // writeStatus.applyPhaseStatus returns an APPLIED transition to Plan; the advance's
    // emitStateWrite must fan that into recordFleetWrite.
    const writeStatus = {
      applyPhaseStatus: () => ({ applied: true, to_state: "Plan", action: "transitioned" }),
      applyTerminalDone: () => ({ applied: false }),
      applyLabel: () => ({ applied: false }),
    };
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: verifyingDispatch(),
      writeStatus,
      recordFleetWrite,
      liveBackgroundCount: () => 0,
      isBgJobAlive: () => true,
      now: () => 70_000,
    });
    const plan = recorded.find((r) => r.toState === "Plan");
    expect(plan).toBeTruthy();
    expect(plan.ticket).toBe("CTC-787");
    expect(typeof plan.atMs).toBe("number");
    // Only Plan is recorded — a non-applied writerResult never records (guarded in emitStateWrite).
    expect(recorded.every((r) => r.toState === "Plan")).toBe(true);
  });

  test("⛔ CONTROL — a NON-applied transition records NOTHING", () => {
    seed();
    const recorded = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0, stdout: "", stderr: "" }),
      writeStatus: {
        applyPhaseStatus: () => ({ applied: false, to_state: "Plan" }), // NOT applied
        applyTerminalDone: () => ({ applied: false }),
        applyLabel: () => ({ applied: false }),
      },
      recordFleetWrite: (ticket, toState, atMs) => recorded.push({ ticket, toState, atMs }),
      now: () => 70_000,
    });
    expect(recorded).toEqual([]);
  });
});
