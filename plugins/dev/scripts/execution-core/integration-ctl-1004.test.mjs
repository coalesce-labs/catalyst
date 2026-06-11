// integration-ctl-1004.test.mjs — CTL-1004 end-to-end: schedulerTick Pass 0j.
// Drives the real schedulerTick over a fixture worker dir, asserting the
// stall-janitor pass wires through to the injected seam boundary. Models
// integration-ctl-729.test.mjs (the watchdog Pass 0w integration).

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schedulerTick } from "./scheduler.mjs";
import { openBeliefsDb } from "./beliefs/schema.mjs";

const NOW = Date.parse("2026-06-11T12:00:00Z");

let orchDir;
beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "ctl1004-int-"));
});
afterEach(() => {
  rmSync(orchDir, { recursive: true, force: true });
});

// Minimal tick options: inert reclaim/watchdog so only the janitor pass acts.
function makeTickOpts({ mode, events = [], intents = [], collectOrphanCandidates, collectGhostCandidates } = {}) {
  return {
    readEligible: () => [],
    dispatch: () => ({ status: "dispatched" }),
    exec: () => ({ code: null }),
    reclaimDeadWork: () => ({ class: "alive-suppressed" }),
    writeStatus: {
      applyLabel: () => ({ applied: true }),
      removeLabel: () => ({ applied: true }),
      runTransition: () => ({ applied: false }),
    },
    now: () => NOW,
    // CTL-729 watchdog off so it never interferes with the janitor assertions.
    watchdog: { mode: "off" },
    // CTL-1004 stall-janitor seams.
    stallJanitor: {
      mode,
      collectOrphanCandidates:
        collectOrphanCandidates ?? (() => []),
      collectGhostCandidates:
        collectGhostCandidates ?? (() => []),
      emit: (type, fields) => {
        events.push({ type, ...fields });
        return Promise.resolve(true);
      },
      recordKillIntent: (intent) => {
        intents.push(intent);
        return true;
      },
    },
  };
}

describe("CTL-1004 integration — enforce mode", () => {
  test("J1: a terminal-Done orphan worktree yields a targeted orphans.reap-requested", () => {
    // The janitor census is fully injected (collectOrphanCandidates), so no
    // on-disk signal is needed; writing one would route the ticket through the
    // unrelated advance/new-work pull instead of isolating Pass 0j.
    const events = [];
    const result = schedulerTick(
      orchDir,
      makeTickOpts({
        mode: "enforce",
        events,
        collectOrphanCandidates: () => [
          {
            ticket: "CTL-1004T",
            teardownDone: true,
            terminalDoneApplied: true,
            worktreePath: "/wt/CTL-1004T",
            worktreeOnDisk: true,
            liveSessionInWorktree: false,
            treeClean: true,
            evidenceOk: true,
            alreadyReaped: false,
            inFlight: false,
            bgJobId: "wtjob",
            branch: "CTL-1004T",
          },
        ],
      }),
    );
    const reap = events.find((e) => e.type === "orphans.reap-requested");
    expect(reap).toBeDefined();
    expect(reap.ticket).toBe("CTL-1004T");
    expect(reap.worktreePath ?? reap.worktree_path).toBe("/wt/CTL-1004T");
    expect(result.janitorReaped).toEqual([
      { ticket: "CTL-1004T", worktreePath: "/wt/CTL-1004T" },
    ]);
  });

  test("J2: an idle ghost session yields a kill-intent (no claude stop)", () => {
    const intents = [];
    const result = schedulerTick(
      orchDir,
      makeTickOpts({
        mode: "enforce",
        intents,
        collectGhostCandidates: () => [
          {
            ticket: "CTL-1004G",
            phase: "monitor-deploy",
            bgJobId: "ghostjob",
            terminalForMs: 700_000,
            sessionKind: "background",
            sessionStatus: "idle",
          },
        ],
      }),
    );
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ subject: "CTL-1004G/monitor-deploy", bgJobId: "ghostjob" });
    expect(result.janitorKillIntents).toEqual([
      { ticket: "CTL-1004G", phase: "monitor-deploy", bgJobId: "ghostjob" },
    ]);
  });
});

describe("CTL-1004 integration — shadow mode (default)", () => {
  test("janitor.would.* only; no real reap, no intents", () => {
    const events = [];
    const intents = [];
    const result = schedulerTick(
      orchDir,
      makeTickOpts({
        mode: "shadow",
        events,
        intents,
        collectOrphanCandidates: () => [
          {
            ticket: "CTL-1004T",
            teardownDone: true,
            terminalDoneApplied: true,
            worktreePath: "/wt/CTL-1004T",
            worktreeOnDisk: true,
            liveSessionInWorktree: false,
            treeClean: true,
            evidenceOk: true,
            alreadyReaped: false,
            inFlight: false,
            bgJobId: "wtjob",
          },
        ],
        collectGhostCandidates: () => [
          {
            ticket: "CTL-1004G",
            phase: "monitor-deploy",
            bgJobId: "ghostjob",
            terminalForMs: 700_000,
            sessionKind: "background",
            sessionStatus: "idle",
          },
        ],
      }),
    );
    expect(events.filter((e) => e.type === "orphans.reap-requested")).toHaveLength(0);
    expect(intents).toHaveLength(0);
    expect(events.some((e) => e.type === "janitor.would.reap-request")).toBe(true);
    expect(events.some((e) => e.type === "janitor.would.kill-intent")).toBe(true);
    expect(result.janitorReaped).toEqual([]);
    expect(result.janitorWouldReap).toEqual([
      { ticket: "CTL-1004T", worktreePath: "/wt/CTL-1004T" },
    ]);
    expect(result.janitorWouldKill).toEqual([
      { ticket: "CTL-1004G", phase: "monitor-deploy", bgJobId: "ghostjob" },
    ]);
  });
});

describe("CTL-1004 integration — off mode", () => {
  test("mode:off skips the pass entirely (census never collected)", () => {
    let collected = false;
    const result = schedulerTick(
      orchDir,
      makeTickOpts({
        mode: "off",
        collectOrphanCandidates: () => {
          collected = true;
          return [];
        },
      }),
    );
    expect(collected).toBe(false);
    expect(result.janitorReaped).toEqual([]);
    expect(result.janitorWouldReap).toEqual([]);
  });
});

describe("CTL-1004 integration — isolation", () => {
  test("a throwing janitor census does not abort the tick", () => {
    const opts = makeTickOpts({ mode: "enforce" });
    opts.stallJanitor.collectOrphanCandidates = () => {
      throw new Error("injected census failure");
    };
    expect(() => schedulerTick(orchDir, opts)).not.toThrow();
  });
});

// ── CTL-1004 J2 enforce DEFECT FIX (adversarial-review finding) ─────────────
//
// THE BUG: in enforce mode the J2 path only INSERTED a kill-intent row; nothing
// ever executed it. reconcileIntents (beliefs/intent.mjs) is a postcondition
// VERIFIER, not an executor — it never calls killBgJob. So the ghost session
// never died, and worse, the intent aged to 'ineffective' and (under
// CATALYST_INTENTS_ENFORCE=1) recovery.mjs's isIntentEffective guard would then
// SUPPRESS a later legitimate kill on the same subject.
//
// THE FIX (mirror recovery.mjs intentAwareKill EXACTLY): the enforce recorder
// must BOTH issue killBgJob({bgJobId}) AND record the pinned intent in the same
// call. These tests exercise the PRODUCTION recorder wiring — no injected
// recordKillIntent seam — so defaultJanitorKillIntentRecorder(intentDb,
// killBgJob) is what runs. The assertion is that a REAL stop seam fires (not
// merely that an intent row was written).
// Tick opts with the PRODUCTION recorder path (recordKillIntent NOT injected),
// a real intentDb, and a spy killBgJob so we can observe the stop seam.
// Module-scoped so CTL-1045 suppression tests can reuse it.
function prodTickOpts({ mode, killed, intentDb }) {
  return {
    readEligible: () => [],
    dispatch: () => ({ status: "dispatched" }),
    exec: () => ({ code: null }),
    reclaimDeadWork: () => ({ class: "alive-suppressed" }),
    writeStatus: {
      applyLabel: () => ({ applied: true }),
      removeLabel: () => ({ removed: true }),
      runTransition: () => ({ applied: false }),
    },
    now: () => NOW,
    watchdog: { mode: "off" },
    intentDb,
    // Spy stop seam — records every bgJobId killBgJob is asked to stop.
    killBgJob: ({ bgJobId }) => killed.push(bgJobId),
    stallJanitor: {
      mode,
      collectGhostCandidates: () => [
        {
          ticket: "CTL-1004G",
          phase: "monitor-deploy",
          bgJobId: "ghostjob",
          terminalForMs: 700_000,
          sessionKind: "background",
          sessionStatus: "idle",
        },
      ],
      // recordKillIntent intentionally NOT injected → production recorder.
    },
  };
}

// ── CTL-1005 / CTL-1056 J3 — REAL emitter end-to-end (the live bug) ─────────
//
// THE LIVE BUG (daemon.log on mini, every tick): the J3 shadow path called the
// PRODUCTION emit seam (emitReapIntent, the scheduler's default) with the type
// "janitor.would.clear", but CTL-1005 never registered that type — nor the J3
// enforce type "janitor.stall.cleared" — in reap-intent.mjs's closed
// REAP_INTENT_TYPES. So emitReapIntent threw "unknown reap-intent event type:
// janitor.would.clear", the fire() seam swallowed it as "stall-janitor: emit
// failed (CTL-1004)", and EVERY J3 verdict was silently lost. These tests drive
// schedulerTick with the REAL emitter (emit NOT injected) so a regression
// resurfaces immediately: the verdict must land in the unified event log.
describe("CTL-1005/CTL-1056 J3 integration — the real emitter accepts janitor.would.clear / janitor.stall.cleared", () => {
  // J3 stall-clear candidate that classifies to "clear".
  const clearableStall = (ticket = "CTL-1005J") => ({
    ticket,
    phase: "implement",
    stalledReason: "prior-artifact-retry-exhausted",
    linearTerminal: false,
    liveSessionInWorktree: false,
    artifactPresent: true,
    artifactComplete: true,
    alreadyCleared: false,
    dispatchFailureCode: 2, // CTL-1045 Bug 2: prior-artifact-missing exit code (clearable)
    priorDoneSignalPresent: true, // CTL-1045 Bug 3
  });

  // Production-shaped tick opts: emit NOT injected → the scheduler default
  // (emitReapIntent) runs, writing to the CATALYST_DIR event log.
  function realEmitterTickOpts({ mode, candidate, clearStall = () => true }) {
    return {
      readEligible: () => [],
      dispatch: () => ({ status: "dispatched" }),
      exec: () => ({ code: null }),
      reclaimDeadWork: () => ({ class: "alive-suppressed" }),
      writeStatus: {
        applyLabel: () => ({ applied: true }),
        removeLabel: () => ({ removed: true }),
        runTransition: () => ({ applied: false }),
      },
      now: () => NOW,
      watchdog: { mode: "off" },
      stallJanitor: {
        mode,
        collectStallClearCandidates: () => [candidate],
        clearStall, // inject so the test never touches real signal files
        // emit + recordKillIntent intentionally NOT injected → production seams.
      },
    };
  }

  // Read every event the unified log captured under the redirected CATALYST_DIR.
  function readEvents() {
    const ym = new Date(NOW).toISOString().slice(0, 7);
    const logPath = join(orchDir, "events", `${ym}.jsonl`);
    if (!existsSync(logPath)) return [];
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
  }

  let prevCatalystDir;
  beforeEach(() => {
    prevCatalystDir = process.env.CATALYST_DIR;
    process.env.CATALYST_DIR = orchDir; // getEventLogPath → orchDir/events/<ym>.jsonl
  });
  afterEach(() => {
    if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
    else process.env.CATALYST_DIR = prevCatalystDir;
  });

  test("shadow: janitor.would.clear is emitted WITHOUT throwing 'unknown reap-intent event type'", () => {
    const result = schedulerTick(
      orchDir,
      realEmitterTickOpts({ mode: "shadow", candidate: clearableStall() }),
    );
    // The verdict reached the report (the in-memory side) …
    expect(result.janitorWouldClear).toEqual([{ ticket: "CTL-1005J", phase: "implement" }]);
    // … AND landed in the unified event log (the seam that threw before the fix).
    const ev = readEvents().find((e) => e.event === "janitor.would.clear");
    expect(ev).toBeDefined();
    expect(ev.ticket).toBe("CTL-1005J");
    expect(ev.phase).toBe("implement");
  });

  test("enforce: janitor.stall.cleared is emitted WITHOUT throwing", () => {
    let cleared = null;
    const result = schedulerTick(
      orchDir,
      realEmitterTickOpts({
        mode: "enforce",
        candidate: clearableStall("CTL-1005K"),
        clearStall: (arg) => {
          cleared = arg;
          return true;
        },
      }),
    );
    expect(cleared).toEqual({ ticket: "CTL-1005K", phase: "implement" });
    expect(result.janitorStallsCleared).toEqual([{ ticket: "CTL-1005K", phase: "implement" }]);
    const ev = readEvents().find((e) => e.event === "janitor.stall.cleared");
    expect(ev).toBeDefined();
    expect(ev.ticket).toBe("CTL-1005K");
    expect(ev.artifact_verified).toBe(true);
  });
});

describe("CTL-1004 J2 enforce — a real stop seam fires (killBgJob), not just an intent row", () => {
  // A real beliefs.db with a single tick row (defaultJanitorKillIntentRecorder
  // needs the latest tick_id to anchor the intent insert).
  function makeIntentDb() {
    const db = openBeliefsDb({ path: join(orchDir, "beliefs.db") });
    db.run("INSERT INTO tick (now_ms, host) VALUES (?, 'testhost')", [NOW]);
    return db;
  }

  test("enforce: killBgJob IS called with the ghost's bgJobId AND an intent row is recorded", () => {
    const killed = [];
    const intentDb = makeIntentDb();
    const result = schedulerTick(orchDir, prodTickOpts({ mode: "enforce", killed, intentDb }));

    // The REAL stop seam fired against the ghost session (the keystone assertion).
    expect(killed).toEqual(["ghostjob"]);
    // The pinned intent was ALSO recorded (mirrors intentAwareKill: stop + record).
    const row = intentDb
      .query("SELECT subject, postcondition FROM intent WHERE kind = 'kill' AND subject = ?")
      .get("CTL-1004G/monitor-deploy");
    expect(row).toBeDefined();
    expect(JSON.parse(row.postcondition)).toMatchObject({ bgJobId: "ghostjob", sessionNotRegistered: true });
    expect(result.janitorKillIntents).toEqual([
      { ticket: "CTL-1004G", phase: "monitor-deploy", bgJobId: "ghostjob" },
    ]);
  });

  test("shadow: killBgJob is NEVER called (no real stop), only janitor.would.kill-intent", () => {
    const killed = [];
    const intentDb = makeIntentDb();
    schedulerTick(orchDir, prodTickOpts({ mode: "shadow", killed, intentDb }));

    expect(killed).toEqual([]);
    const row = intentDb
      .query("SELECT subject FROM intent WHERE kind = 'kill' AND subject = ?")
      .get("CTL-1004G/monitor-deploy");
    expect(row == null).toBe(true); // no intent row recorded in shadow
  });
});

// ── CTL-1045 Bug 1 — isIntentEffective suppression in the J2 kill recorder ─
describe("CTL-1045 Bug 1 — J2 kill-storm: ineffective-intent suppression in defaultJanitorKillIntentRecorder", () => {
  function makeIntentDbWithSeededIntent(attempts) {
    const db = openBeliefsDb({ path: join(orchDir, "beliefs.db") });
    db.run("INSERT INTO tick (now_ms, host) VALUES (?, 'testhost')", [NOW]);
    const tickRow = db.query("SELECT tick_id FROM tick ORDER BY tick_id DESC LIMIT 1").get();
    db.run(
      "INSERT INTO intent (tick_id, kind, subject, postcondition, attempts, outcome) VALUES (?, 'kill', ?, ?, ?, NULL)",
      [
        tickRow.tick_id,
        "CTL-1004G/monitor-deploy",
        JSON.stringify({ kind: "kill", subject: "CTL-1004G/monitor-deploy", bgJobId: "ghostjob", sessionNotRegistered: true }),
        attempts,
      ],
    );
    return db;
  }

  test("enforce: a plateaued ineffective kill intent (attempts >= max) suppresses killBgJob", () => {
    const killed = [];
    // Seed an intent already at cap (attempts=2, outcome IS NULL — the plateaued state).
    const intentDb = makeIntentDbWithSeededIntent(2);
    schedulerTick(orchDir, prodTickOpts({ mode: "enforce", killed, intentDb }));

    expect(killed).toEqual([]); // guard suppressed the stop
  });

  test("enforce: a still-effective kill intent (attempts < max) DOES call killBgJob", () => {
    const killed = [];
    // Seed an intent at attempts=1 (below default maxAttempts=2 → still effective).
    const intentDb = makeIntentDbWithSeededIntent(1);
    schedulerTick(orchDir, prodTickOpts({ mode: "enforce", killed, intentDb }));

    expect(killed).toEqual(["ghostjob"]); // guard must not over-suppress
  });

  test("enforce: intentDb=null bypasses the guard entirely — kill still fires", () => {
    const killed = [];
    // intentDb omitted → null default → isIntentEffective check is skipped
    // entirely; killBgJob must still be called (fail-open when beliefs db absent).
    schedulerTick(orchDir, prodTickOpts({ mode: "enforce", killed, intentDb: null }));

    expect(killed).toEqual(["ghostjob"]);
  });
});
