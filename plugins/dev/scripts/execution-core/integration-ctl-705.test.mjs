// CTL-705 end-to-end integration tests — global priority+stage sort + preemption.
//
// Exercises the full preemption + resume loop through schedulerTick with
// injected seams (killBgJob, dispatch, liveBackgroundCount, resolveSession, now).
// Two scenarios cover the acceptance criteria from the plan:
//   1. maxParallel=2, 2 Low in-flight, 1 Urgent queued → CTL-2 (lower stage)
//      preempted on tick 2; re-dispatched with --resume-session on tick 3.
//   2. Only in-flight worker is at monitor-deploy → no preemption.
//
// Run: cd plugins/dev/scripts/execution-core && bun test integration-ctl-705.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  schedulerTick,
  __resetForTests,
  writeWorkerPriority,
  nextStarvationState,
} from "./scheduler.mjs";
import { log } from "./config.mjs";
import { ownedBy } from "./hrw.mjs";

let orchDir;
let catalystDir;
let prevCatalystDir;

beforeEach(() => {
  __resetForTests();
  prevCatalystDir = process.env.CATALYST_DIR;
  catalystDir = mkdtempSync(join(tmpdir(), "ctl705-int-"));
  if (!catalystDir.startsWith(tmpdir())) {
    throw new Error(`integration test refused: catalystDir not under tmpdir: ${catalystDir}`);
  }
  process.env.CATALYST_DIR = catalystDir;
  mkdirSync(join(catalystDir, "events"), { recursive: true });
  orchDir = join(catalystDir, "orch");
  mkdirSync(join(orchDir, "workers"), { recursive: true });
});

afterEach(() => {
  __resetForTests();
  if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
  else process.env.CATALYST_DIR = prevCatalystDir;
  rmSync(catalystDir, { recursive: true, force: true });
});

function seedWorker(ticket, phase, priority, startedAtMs, bgJobId, createdAt) {
  const dir = join(orchDir, "workers", ticket);
  mkdirSync(dir, { recursive: true });
  const startedAt = new Date(startedAtMs).toISOString();
  writeFileSync(
    join(dir, `phase-${phase}.json`),
    JSON.stringify({ ticket, phase, status: "running", bg_job_id: bgJobId, startedAt })
  );
  writeWorkerPriority(orchDir, ticket, {
    priority,
    createdAt: createdAt ?? "2026-05-01T00:00:00Z",
  });
}

function readSignal(ticket, phase) {
  const p = join(orchDir, "workers", ticket, `phase-${phase}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

function makeKillStub() {
  const calls = [];
  const fn = (args) => calls.push(args);
  fn.calls = calls;
  return fn;
}

// dispatch that writes a real signal file so verifyDispatched passes
function makeRealDispatch() {
  const calls = [];
  const fn = ({ orchDir: od, ticket, phase, resumeSession }) => {
    calls.push({ ticket, phase, resumeSession });
    const dir = join(od, "workers", ticket);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `phase-${phase}.json`),
      JSON.stringify({ ticket, phase, status: "dispatched", bg_job_id: "new-bg-" + ticket })
    );
    return { code: 0, stdout: "", stderr: "" };
  };
  fn.calls = calls;
  return fn;
}

function seedTriagedWaiter(baseDir, ticket) {
  const dir = join(baseDir, "workers", ticket);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "phase-triage.json"),
    JSON.stringify({ ticket, phase: "triage", status: "done" })
  );
}

function admissionOpts({
  eligible = [],
  fetchBatch = (ids) =>
    new Map(
      ids.map((id) => [
        id,
        {
          state: "In Progress",
          priority: 1,
          labels: [],
          relations: { nodes: [] },
          inverseRelations: { nodes: [] },
        },
      ])
    ),
  hasTriageArtifact = () => true,
} = {}) {
  return {
    readEligible: () => eligible,
    reclaimDeadWork: noopReclaim,
    liveBackgroundCount: () => 0,
    dispatch: makeRealDispatch(),
    hasTriageArtifact,
    listStartedTickets: () => new Set(),
    fetchBatch,
    livenessIsFresh: () => false,
    isDraining: () => false,
    recoveryPass: { mode: "off" },
    boardHealth: { mode: "off" },
    writeStatus: {
      applyPhaseStatus: () => {},
      applyTerminalDone: () => {},
      applyLabel: () => {},
      removeLabel: () => ({ removed: true }),
    },
  };
}

const noopReclaim = () => "noop";

describe("CAT-36 new-work admission", () => {
  test("a triage-probe error on the admission path is logged, not swallowed", () => {
    const warnings = [];
    const realWarn = log.warn;
    seedTriagedWaiter(orchDir, "CTL-WAIT");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    const probeError = Object.assign(new Error("EACCES"), { code: "EACCES" });
    try {
      log.warn = (...args) => warnings.push(args);
      schedulerTick(
        orchDir,
        admissionOpts({
          eligible: [
            { identifier: "CTL-BROKEN", priority: 1, createdAt: "2026-05-01T00:00:00Z" },
          ],
          hasTriageArtifact: (_dir, ticket) => {
            if (ticket === "CTL-BROKEN") throw probeError;
            return true;
          },
        })
      );
      const warning = warnings.find((args) =>
        args.some(
          (a) => typeof a === "string" && a.includes("admission triage artifact probe failed")
        )
      );
      expect(warning).toBeDefined();
      expect(warning.find((a) => a && typeof a === "object")).toMatchObject({
        ticket: "CTL-BROKEN",
        reason: "triage-probe-error",
        held_ticks: 1,
      });
      expect(warning.find((a) => a && typeof a === "object")?.error).toContain("EACCES");
    } finally {
      log.warn = realWarn;
    }
  });

  test("admission probe-error cadence is independent from the new-work hold cadence", () => {
    const warnings = [];
    const realWarn = log.warn;
    seedTriagedWaiter(orchDir, "CTL-WAIT");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    try {
      log.warn = (...args) => warnings.push(args);
      for (let tick = 0; tick < 12; tick += 1) {
        schedulerTick(
          orchDir,
          admissionOpts({
            eligible: [
              { identifier: "CTL-BROKEN", priority: 1, createdAt: "2026-05-01T00:00:00Z" },
            ],
            hasTriageArtifact: (_dir, ticket) => {
              if (ticket === "CTL-BROKEN") throw new Error("EACCES");
              return true;
            },
          })
        );
      }
      const streaksFor = (fragment) =>
        warnings
          .filter((args) =>
            args.some((a) => typeof a === "string" && a.includes(fragment))
          )
          .map((args) => args.find((a) => a && typeof a === "object")?.held_ticks);
      expect(streaksFor("admission triage artifact probe failed")).toEqual([1, 10]);
      expect(streaksFor("triage artifact probe failed — holding new-work")).toEqual([1, 10]);
    } finally {
      log.warn = realWarn;
    }
  });

  test("an admission probe-error streak restarts after a non-probed tick", () => {
    const warnings = [];
    const realWarn = log.warn;
    seedTriagedWaiter(orchDir, "CTL-WAIT");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    const broken = { identifier: "CTL-BROKEN", priority: 1, createdAt: "2026-05-01T00:00:00Z" };
    const throwingProbe = (_dir, ticket) => {
      if (ticket === "CTL-BROKEN") throw new Error("EACCES");
      return true;
    };
    try {
      log.warn = (...args) => warnings.push(args);
      schedulerTick(
        orchDir,
        admissionOpts({ eligible: [broken], hasTriageArtifact: throwingProbe })
      );
      const blocked = {
        ...broken,
        relations: {
          nodes: [{ type: "blocked_by", relatedIssue: { identifier: "CTL-DEP" } }],
        },
        inverseRelations: { nodes: [] },
      };
      const blockedBatch = (ids) =>
        new Map(
          ids.map((id) => [
            id,
            {
              state: "In Progress",
              priority: 1,
              labels: [],
              relations:
                id === "CTL-BROKEN"
                  ? blocked.relations
                  : { nodes: [] },
              inverseRelations: { nodes: [] },
            },
          ])
        );
      schedulerTick(
        orchDir,
        admissionOpts({ eligible: [blocked], fetchBatch: blockedBatch })
      );
      schedulerTick(
        orchDir,
        admissionOpts({ eligible: [broken], hasTriageArtifact: throwingProbe })
      );
      const heldTicks = warnings
        .filter((args) =>
          args.some(
            (a) => typeof a === "string" && a.includes("admission triage artifact probe failed")
          )
        )
        .map((args) => args.find((a) => a && typeof a === "object")?.held_ticks);
      expect(heldTicks).toEqual([1, 1]);
    } finally {
      log.warn = realWarn;
    }
  });

  // CAT-36 (Codex P2, #3140): the hold-streak map self-cleaned only on the
  // "became ready" path, so a ticket that LEFT `ready` (removed, reassigned,
  // newly dependency-blocked) kept its entry for the daemon's lifetime — and a
  // later reappearance resumed the obsolete streak, swallowing the first
  // diagnostic of the new hold episode. The map must track this tick's ready
  // set, so the re-appearance logs at held_ticks:1 again.
  test("a held ticket that leaves the ready set restarts its hold streak", () => {
    const testOrchDir = mkdtempSync(join(tmpdir(), "cat36-holdmap-"));
    const infos = [];
    const realInfo = log.info;
    try {
      mkdirSync(join(testOrchDir, "workers"), { recursive: true });
      writeFileSync(join(testOrchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
      __resetForTests();
      log.info = (...args) => infos.push(args);
      const opts = (eligible) => ({
        readEligible: () => eligible,
        reclaimDeadWork: noopReclaim,
        liveBackgroundCount: () => 0,
        dispatch: makeRealDispatch(),
        hasTriageArtifact: () => false, // always held
        listStartedTickets: () => new Set(),
        // Single-host roster: HRW is a strict no-op, so this host owns the
        // ticket and it actually reaches the hold filter.
        hosts: ["test-host"],
        hostName: "test-host",
        isDraining: () => false,
        recoveryPass: { mode: "off" },
        boardHealth: { mode: "off" },
        writeStatus: {
          applyPhaseStatus: () => {},
          applyTerminalDone: () => {},
          applyLabel: () => {},
        },
      });
      const present = [{ identifier: "CTL-HOLD", priority: 1, createdAt: "2026-05-01T00:00:00Z" }];
      schedulerTick(testOrchDir, opts(present)); // held, streak 1 → logs
      schedulerTick(testOrchDir, opts(present)); // held, streak 2 → silent
      schedulerTick(testOrchDir, opts([])); // LEAVES ready → entry must be pruned
      schedulerTick(testOrchDir, opts(present)); // reappears → streak 1 → logs again

      const heldTicks = infos
        .filter((args) =>
          args.some((a) => typeof a === "string" && a.includes("not yet triaged"))
        )
        .map((args) => args.find((a) => a && typeof a === "object")?.held_ticks);
      // Pre-fix the second episode resumed at 3 and never logged at all.
      expect(heldTicks).toEqual([1, 1]);
    } finally {
      log.info = realInfo;
      __resetForTests();
      rmSync(testOrchDir, { recursive: true, force: true });
    }
  });

  test("an untriaged top-ranked ticket does not consume the only free slot", () => {
    const testOrchDir = mkdtempSync(join(tmpdir(), "cat36-admission-"));
    try {
      mkdirSync(join(testOrchDir, "workers"), { recursive: true });
      writeFileSync(join(testOrchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
      __resetForTests();
      const dispatch = makeRealDispatch();
      schedulerTick(testOrchDir, {
        readEligible: () => [
          { identifier: "CTL-BLOCK", priority: 1, createdAt: "2026-05-01T00:00:00Z" },
          { identifier: "CTL-READY", priority: 2, createdAt: "2026-05-02T00:00:00Z" },
        ],
        reclaimDeadWork: noopReclaim,
        liveBackgroundCount: () => 0,
        dispatch,
        hasTriageArtifact: (_dir, ticket) => ticket === "CTL-READY",
        listStartedTickets: () => new Set(),
        hosts: ["test-host"],
        hostName: "test-host",
        isDraining: () => false,
        recoveryPass: { mode: "off" },
        boardHealth: { mode: "off" },
        writeStatus: {
          applyPhaseStatus: () => {},
          applyTerminalDone: () => {},
          applyLabel: () => {},
        },
      });
      expect(dispatch.calls.map((call) => call.ticket)).toEqual(["CTL-READY"]);
    } finally {
      __resetForTests();
      rmSync(testOrchDir, { recursive: true, force: true });
    }
  });

  // CAT-36 (Codex P1, #3140): the budget guard belongs to the new-work and
  // admission sweeps ONLY — it must not reach the preemption sweep. There, the
  // freed slot is spent by the MONITOR's triage dispatch (computeTriageBudget is
  // just computeFreeSlots), so an untriaged urgent ticket is precisely who needs
  // it. Gating preemption on triage.json also could never be satisfied:
  // buildGlobalRanking's queued descriptors are by construction the tickets with
  // no workers/<t>/ dir, which is where triage.json would have to live.
  test("an untriaged urgent queued ticket still triggers preemption", () => {
    const T0 = 200_000;
    seedWorker("CTL-LIVE", "research", 4, T0 - 90_000, "bg-live");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const kill = makeKillStub();
    const opts = {
      readEligible: () => [
        { identifier: "CTL-BLOCK", priority: 1, createdAt: "2026-05-01T00:00:00Z" },
      ],
      reclaimDeadWork: noopReclaim,
      liveBackgroundCount: () => 1,
      killBgJob: kill,
      hasTriageArtifact: () => false,
    };
    schedulerTick(orchDir, { ...opts, now: () => T0 }); // opens hysteresis
    schedulerTick(orchDir, { ...opts, now: () => T0 + 35_000 }); // preempts
    expect(kill.calls.map((c) => c.bgJobId)).toContain("bg-live");
    expect(readSignal("CTL-LIVE", "research")?.status).toBe("preempted");
  });
});

describe("CAT-36 starvation warning cadence", () => {
  const idle = {
    didWork: false,
    freeSlots: 1,
    hasWaitingWork: true,
    livenessFresh: true,
    draining: false,
  };

  test("warns at the threshold and then only at the re-warn interval", () => {
    let state = 0;
    const warnings = [];
    for (let tick = 1; tick <= 14; tick += 1) {
      const result = nextStarvationState(state, idle);
      state = result.streak;
      if (result.warn) warnings.push(tick);
    }
    expect(warnings).toEqual([3, 13]);
  });

  test("resets after successful work", () => {
    expect(nextStarvationState(2, { ...idle, didWork: true }).streak).toBe(0);
  });

  test("does not count an empty queue", () => {
    expect(nextStarvationState(2, { ...idle, hasWaitingWork: false }).streak).toBe(0);
  });

  test("counts queued work blocked by stale liveness with a distinct reason", () => {
    const result = nextStarvationState(2, { ...idle, freeSlots: 0, livenessFresh: false });
    expect(result).toEqual({ streak: 3, warn: true, reason: "stale-liveness" });
  });

  test("the frozen-board warn names each admission-held waiter and its reason", () => {
    const warnings = [];
    const realWarn = log.warn;
    seedTriagedWaiter(orchDir, "CTL-WAIT-A");
    seedTriagedWaiter(orchDir, "CTL-WAIT-B");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    try {
      log.warn = (...args) => warnings.push(args);
      for (let tick = 0; tick < 3; tick += 1) schedulerTick(orchDir, admissionOpts());
      const frozen = warnings.find((args) =>
        args.some((a) => typeof a === "string" && a.includes("board appears frozen"))
      );
      expect(frozen).toBeDefined();
      expect(frozen.find((a) => a && typeof a === "object")?.admission_held).toEqual(
        expect.arrayContaining([
          { ticket: "CTL-WAIT-A", reason: "awaiting-capacity-or-priority" },
          { ticket: "CTL-WAIT-B", reason: "awaiting-capacity-or-priority" },
        ])
      );
    } finally {
      log.warn = realWarn;
    }
  });

  test("the frozen-board warn distinguishes dependency-blocked admission waiters", () => {
    const warnings = [];
    const realWarn = log.warn;
    seedTriagedWaiter(orchDir, "CTL-READY");
    seedTriagedWaiter(orchDir, "CTL-BLOCKED");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    const fetchBatch = (ids) =>
      new Map(
        ids.map((id) => [
          id,
          {
            state: "In Progress",
            priority: 1,
            labels: [],
            relations:
              id === "CTL-BLOCKED"
                ? { nodes: [{ type: "blocked_by", relatedIssue: { identifier: "CTL-DEP" } }] }
                : { nodes: [] },
            inverseRelations: { nodes: [] },
          },
        ])
      );
    try {
      log.warn = (...args) => warnings.push(args);
      for (let tick = 0; tick < 3; tick += 1) {
        schedulerTick(orchDir, admissionOpts({ fetchBatch }));
      }
      const frozen = warnings.find((args) =>
        args.some((a) => typeof a === "string" && a.includes("board appears frozen"))
      );
      expect(frozen).toBeDefined();
      expect(frozen.find((a) => a && typeof a === "object")?.admission_held).toContainEqual({
        ticket: "CTL-BLOCKED",
        reason: "blocked-by-open-dependency",
      });
    } finally {
      log.warn = realWarn;
    }
  });

  test("admission-held details are capped on a large frozen board", () => {
    const warnings = [];
    const realWarn = log.warn;
    for (let i = 1; i <= 25; i += 1) seedTriagedWaiter(orchDir, `CTL-WAIT-${i}`);
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 25 }));
    try {
      log.warn = (...args) => warnings.push(args);
      for (let tick = 0; tick < 3; tick += 1) schedulerTick(orchDir, admissionOpts());
      const frozen = warnings.find((args) =>
        args.some((a) => typeof a === "string" && a.includes("board appears frozen"))
      );
      expect(frozen).toBeDefined();
      expect(frozen.find((a) => a && typeof a === "object")?.admission_held).toHaveLength(20);
    } finally {
      log.warn = realWarn;
    }
  });

  // Regression guard for the phase-review finding: hasWaitingWork must be derived
  // from `ready` (eligible minus dependency-blocked minus not-HRW-owned), not from
  // `eligible`. Deriving it from `eligible` warns forever on a HEALTHY cluster node
  // whose peers own every currently-eligible slice — didWork stays false and free
  // slots exist, so the streak never resets.
  test("a cluster node owning none of the eligible slices never warns", () => {
    const testOrchDir = mkdtempSync(join(tmpdir(), "cat36-starve-"));
    const warnings = [];
    const realWarn = log.warn;
    try {
      mkdirSync(join(testOrchDir, "workers"), { recursive: true });
      writeFileSync(join(testOrchDir, "state.json"), JSON.stringify({ maxParallel: 4 }));
      __resetForTests();
      const hosts = ["host-a", "host-b"];
      // Pick identifiers this host does NOT own, so `ready` is empty while
      // `eligible` is not. Resolved via the real HRW hash so the test cannot
      // drift from ownedBy's behavior.
      const foreign = [];
      for (let i = 1; foreign.length < 2 && i < 200; i += 1) {
        const id = `CTL-${i}`;
        if (!ownedBy(id, hosts, "host-a")) foreign.push(id);
      }
      expect(foreign).toHaveLength(2);

      log.warn = (...args) => warnings.push(args);
      for (let tick = 0; tick < 5; tick += 1) {
        schedulerTick(testOrchDir, {
          readEligible: () =>
            foreign.map((identifier) => ({
              identifier,
              priority: 1,
              createdAt: "2026-05-01T00:00:00Z",
            })),
          reclaimDeadWork: noopReclaim,
          liveBackgroundCount: () => 0,
          dispatch: makeRealDispatch(),
          hasTriageArtifact: () => true,
          listStartedTickets: () => new Set(),
          hosts,
          hostName: "host-a",
          isDraining: () => false,
          recoveryPass: { mode: "off" },
          boardHealth: { mode: "off" },
          writeStatus: {
            applyPhaseStatus: () => {},
            applyTerminalDone: () => {},
            applyLabel: () => {},
          },
        });
      }
      const frozen = warnings.filter((args) =>
        args.some((a) => typeof a === "string" && a.includes("board appears frozen"))
      );
      expect(frozen).toHaveLength(0);
    } finally {
      log.warn = realWarn;
      __resetForTests();
      rmSync(testOrchDir, { recursive: true, force: true });
    }
  });

  // CAT-36 (Codex P2, #3140): the same false-positive class, one pool over.
  // triagedWaitingCount is captured BEFORE dependency readiness is applied, so a
  // triaged waiter parked behind an open dependency kept hasWaitingWork true and
  // warned "board appears frozen" on a board that is correctly idle. The streak
  // must be gated on the dependency-READY subset.
  test("a triaged waiter blocked by an open dependency never warns", () => {
    const testOrchDir = mkdtempSync(join(tmpdir(), "cat36-blocked-"));
    const warnings = [];
    const realWarn = log.warn;
    try {
      // A triaged-waiting candidate: triage done, no research signal.
      const waiterDir = join(testOrchDir, "workers", "CTL-WAIT");
      mkdirSync(waiterDir, { recursive: true });
      writeFileSync(
        join(waiterDir, "phase-triage.json"),
        JSON.stringify({ ticket: "CTL-WAIT", phase: "triage", status: "done" })
      );
      writeFileSync(join(testOrchDir, "state.json"), JSON.stringify({ maxParallel: 4 }));
      __resetForTests();

      // CTL-WAIT is blocked_by CTL-DEP, and CTL-DEP is NOT terminal → the
      // admission graph drops CTL-WAIT from readyIds.
      const fetchBatch = (ids) => {
        const m = new Map();
        for (const id of ids) {
          if (id === "CTL-WAIT") {
            m.set(id, {
              state: "In Progress",
              priority: 1,
              labels: [],
              // buildDependencyEdges reads relations.nodes[].relatedIssue
              // (inverseRelations is the one that uses `.issue`).
              relations: { nodes: [{ type: "blocked_by", relatedIssue: { identifier: "CTL-DEP" } }] },
              inverseRelations: { nodes: [] },
            });
          } else {
            m.set(id, {
              state: "In Progress", // non-terminal blocker
              priority: null,
              labels: [],
              relations: { nodes: [] },
              inverseRelations: { nodes: [] },
            });
          }
        }
        return m;
      };

      log.warn = (...args) => warnings.push(args);
      for (let tick = 0; tick < 5; tick += 1) {
        schedulerTick(testOrchDir, {
          // CTL-WAIT is eligible but dependency-blocked, so `ready` is empty
          // while the triaged-waiting pool is not — exactly the shape that made
          // the pre-fix streak advance on a correctly-idle board. The eligible
          // projection carries the relations in production, so the new-work
          // readiness graph sees the same edge the admission graph does.
          readEligible: () => [
            {
              identifier: "CTL-WAIT",
              priority: 1,
              createdAt: "2026-05-01T00:00:00Z",
              relations: {
                nodes: [{ type: "blocked_by", relatedIssue: { identifier: "CTL-DEP" } }],
              },
              inverseRelations: { nodes: [] },
            },
          ],
          reclaimDeadWork: noopReclaim,
          liveBackgroundCount: () => 0, // free slots exist
          dispatch: makeRealDispatch(),
          hasTriageArtifact: () => true,
          listStartedTickets: () => new Set(),
          fetchBatch,
          isDraining: () => false,
          recoveryPass: { mode: "off" },
          boardHealth: { mode: "off" },
          writeStatus: {
            applyPhaseStatus: () => {},
            applyTerminalDone: () => {},
            applyLabel: () => {},
            removeLabel: () => ({ removed: true }),
          },
        });
      }
      const frozen = warnings.filter((args) =>
        args.some((a) => typeof a === "string" && a.includes("board appears frozen"))
      );
      expect(frozen).toHaveLength(0);
    } finally {
      log.warn = realWarn;
      __resetForTests();
      rmSync(testOrchDir, { recursive: true, force: true });
    }
  });
});

describe("CTL-705 acceptance scenario — preemption + resume", () => {
  test("Tick 1+2+3: Urgent queued + 2 Low in-flight → CTL-2 preempted (tick 2), resumed (tick 3)", () => {
    const T0 = 200_000;
    // Two Low (priority 4) in-flight workers, both >60s old
    seedWorker("CTL-1", "verify", 4, T0 - 90_000, "bg-1"); // verify = stage 5
    seedWorker("CTL-2", "research", 4, T0 - 90_000, "bg-2"); // research = stage 1 — lowest

    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    const kill = makeKillStub();

    const baseOpts = {
      readEligible: () => [{ identifier: "CTL-9", priority: 1, createdAt: "2026-05-01T00:00:00Z" }],
      reclaimDeadWork: noopReclaim,
      hasTriageArtifact: () => true,
      writeStatus: {
        applyPhaseStatus: () => {},
        applyTerminalDone: () => {},
        applyLabel: () => {},
      },
    };

    // Tick 1 (T0): first observation — hysteresis window opens, no preemption
    schedulerTick(orchDir, {
      ...baseOpts,
      dispatch: makeRealDispatch(), // would dispatch CTL-9 if slot free — but slots are full
      liveBackgroundCount: () => 2,
      now: () => T0,
      killBgJob: kill,
    });
    expect(kill.calls).toHaveLength(0);
    expect(readSignal("CTL-2", "research")?.status).toBe("running"); // not yet preempted

    // Tick 2 (T0+35s): hysteresis window passed → CTL-2 preempted
    const dispatch2 = makeRealDispatch();
    schedulerTick(orchDir, {
      ...baseOpts,
      dispatch: dispatch2,
      liveBackgroundCount: () => 2, // still saturated
      now: () => T0 + 35_000,
      killBgJob: kill,
    });
    expect(kill.calls.map((c) => c.bgJobId)).toContain("bg-2"); // CTL-2 stopped
    expect(kill.calls.map((c) => c.bgJobId)).not.toContain("bg-1"); // CTL-1 not stopped
    const preemptedSig = readSignal("CTL-2", "research");
    expect(preemptedSig?.status).toBe("preempted");
    expect(preemptedSig?.parkedFrom).toBe("research");

    // Verify the event log contains a preemption event for CTL-2
    const now2 = new Date();
    const ym = `${now2.getUTCFullYear()}-${String(now2.getUTCMonth() + 1).padStart(2, "0")}`;
    const eventLog = readFileSync(join(catalystDir, "events", `${ym}.jsonl`), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const preemptEvent = eventLog.find(
      (e) => e.attributes?.["event.name"] === "phase.research.preempted.CTL-2"
    );
    expect(preemptEvent).toBeDefined();

    // Tick 3: slot frees (liveCount drops to 1) → CTL-2 resumed with --resume-session
    const dispatch3 = makeRealDispatch();
    schedulerTick(orchDir, {
      ...baseOpts,
      dispatch: dispatch3,
      liveBackgroundCount: () => 1, // one slot free
      now: () => T0 + 36_000,
      killBgJob: makeKillStub(),
      resolveSession: () => "resume-uuid-ctL2", // injectable — returns a valid resume UUID
    });
    const resumeCall = dispatch3.calls.find((c) => c.ticket === "CTL-2");
    expect(resumeCall).toBeDefined();
    expect(resumeCall.phase).toBe("research"); // parkedFrom
    expect(resumeCall.resumeSession).toBe("resume-uuid-ctL2");

    // CTL-2 signal should no longer be "preempted" (dispatched by resume sweep)
    const resumedSig = readSignal("CTL-2", "research");
    expect(resumedSig?.status).toBe("dispatched");

    // resumed-after-preemption event in log
    const eventLog3 = readFileSync(join(catalystDir, "events", `${ym}.jsonl`), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const resumeEvent = eventLog3.find(
      (e) => e.attributes?.["event.name"] === "phase.research.resumed-after-preemption.CTL-2"
    );
    expect(resumeEvent).toBeDefined();
    expect(resumeEvent.body.payload.resume_session).toBe("resume-uuid-ctL2");
  });
});

describe("CTL-705 reclaim-guard scenario — real reclaimDeadWork, no stub", () => {
  // The acceptance scenario above injects reclaimDeadWork: noopReclaim, which
  // masks the reclaim-guard regression entirely. This test deliberately does
  // NOT stub reclaimDeadWork (schedulerTick falls back to the real
  // reclaimDeadWorkIfPossible from recovery.mjs), so the guard is the only thing
  // standing between a parked-with-dead-bg signal and a false revive.
  function seedPreempted(ticket, phase, bgJobId, priority) {
    const dir = join(orchDir, "workers", ticket);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `phase-${phase}.json`),
      JSON.stringify({
        ticket,
        phase,
        status: "preempted",
        parkedFrom: phase,
        bg_job_id: bgJobId, // a now-dead bg job — what classifyWorker would treat as dead
        attentionReason: "preempted-by-priority",
      })
    );
    writeWorkerPriority(orchDir, ticket, { priority, createdAt: "2026-05-01T00:00:00Z" });
  }

  test("parked-with-dead-bg signal is NOT revived by the real reclaim sweep; only the resume sweep re-dispatches it", () => {
    const T0 = 200_000;
    // CTL-Park is the ONLY in-flight worker, parked at research with a dead
    // bg_job_id. It is the only signal the real reclaim sweep would iterate.
    seedPreempted("CTL-Park", "research", "bg-park-dead", 4);
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));

    const writeStatus = {
      applyPhaseStatus: () => {},
      applyTerminalDone: () => {},
      applyLabel: () => {},
    };

    // Tick A — saturated (liveBackgroundCount=1). The resume sweep (1.5) sees 0
    // free slots and skips. With NO reclaim stub, the real reclaim sweep runs
    // first; without the CTL-705 guard it would route the parked-dead-bg signal
    // through the death trigger and revive it (a duplicate spawn). The guard
    // makes the parked signal untouched.
    const dispatchA = makeRealDispatch();
    schedulerTick(orchDir, {
      readEligible: () => [],
      // reclaimDeadWork intentionally omitted → real reclaimDeadWorkIfPossible
      dispatch: dispatchA,
      liveBackgroundCount: () => 1,
      now: () => T0,
      killBgJob: makeKillStub(),
      writeStatus,
    });
    // The parked signal must be untouched — no revive, no advancement, status
    // still "preempted", bg_job_id unchanged.
    const afterA = readSignal("CTL-Park", "research");
    expect(afterA?.status).toBe("preempted");
    expect(afterA?.bg_job_id).toBe("bg-park-dead");
    expect(dispatchA.calls.find((c) => c.ticket === "CTL-Park")).toBeUndefined();

    // Tick B — a slot frees (liveBackgroundCount=0). NOW the resume sweep owns
    // the re-dispatch (not the reclaim sweep), at parkedFrom=research.
    const dispatchB = makeRealDispatch();
    schedulerTick(orchDir, {
      readEligible: () => [],
      // reclaimDeadWork still omitted → real reclaim
      dispatch: dispatchB,
      liveBackgroundCount: () => 0,
      now: () => T0 + 1_000,
      killBgJob: makeKillStub(),
      resolveSession: () => null, // cold re-dispatch (no --resume-session)
      writeStatus,
    });
    const resumeCall = dispatchB.calls.find((c) => c.ticket === "CTL-Park");
    expect(resumeCall).toBeDefined();
    expect(resumeCall.phase).toBe("research"); // re-dispatched at parkedFrom
    expect(readSignal("CTL-Park", "research")?.status).toBe("dispatched");
  });
});

describe("CTL-705 guard scenario — monitor-deploy not preemptable", () => {
  test("Only in-flight worker at monitor-deploy → no preemption even with Urgent queued", () => {
    const T0 = 200_000;
    seedWorker("CTL-MD", "monitor-deploy", 4, T0 - 90_000, "bg-md");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const kill = makeKillStub();

    const baseOpts = {
      readEligible: () => [{ identifier: "CTL-9", priority: 1, createdAt: "2026-05-01T00:00:00Z" }],
      hasTriageArtifact: () => true,
      reclaimDeadWork: noopReclaim,
      liveBackgroundCount: () => 1, // saturated
      now: () => T0 + 35_000, // past hysteresis
      killBgJob: kill,
    };

    // Two ticks — first to open hysteresis, second to confirm no preemption
    schedulerTick(orchDir, { ...baseOpts, now: () => T0 });
    schedulerTick(orchDir, { ...baseOpts, now: () => T0 + 35_000 });

    expect(kill.calls).toHaveLength(0); // monitor-deploy is non-preemptable
    expect(readSignal("CTL-MD", "monitor-deploy")?.status).toBe("running"); // unchanged
  });
});
