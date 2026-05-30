// CTL-587 end-to-end integration tests.
//
// Exercises the full revive loop through schedulerTick + the real
// reclaimDeadWorkIfPossible, with the daemon-side I/O seams (statJob,
// emitComplete, applyStalledLabel, dispatch, killBgJob) stubbed. The intent is
// to pin the wiring: a dead worker on first strike → 'revived' + new dispatch;
// budget exhausted → 'escalated' + needs-human; storm-breaker open →
// 'revive-suppressed' + no dispatch. The earlier per-module unit tests cover
// the branch matrix; this file proves the seams compose.
//
// Run: cd plugins/dev/scripts/execution-core && bun test integration-ctl-587.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schedulerTick } from "./scheduler.mjs";
import { reclaimDeadWorkIfPossible } from "./recovery.mjs";
import { countReviveEvents } from "./event-scan.mjs";

let orchDir;
let catalystDir;
let prevCatalystDir;
let eventLogPath;

beforeEach(() => {
  prevCatalystDir = process.env.CATALYST_DIR;
  catalystDir = mkdtempSync(join(tmpdir(), "ctl587-int-"));
  // Safety: refuse to run if the temp path somehow escaped tmpdir() — the
  // test writes through default-real event-log paths and a misconfigured
  // CATALYST_DIR could dirty the host's real ~/.catalyst/events/. Pin the
  // contract loudly rather than silently corrupting an operator's log.
  if (!catalystDir.startsWith(tmpdir())) {
    throw new Error(`integration test refused: catalystDir not under tmpdir: ${catalystDir}`);
  }
  process.env.CATALYST_DIR = catalystDir;
  // Pre-create the events dir so appends in the recovery audit path land
  // somewhere predictable. The default event-log path resolves under
  // CATALYST_DIR/events/<YYYY-MM>.jsonl — we seed it explicitly for the
  // budget-exhaustion test.
  mkdirSync(join(catalystDir, "events"), { recursive: true });
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  eventLogPath = join(catalystDir, "events", `${ym}.jsonl`);
  orchDir = join(catalystDir, "orch");
  mkdirSync(join(orchDir, "workers"), { recursive: true });
});

afterEach(() => {
  if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
  else process.env.CATALYST_DIR = prevCatalystDir;
  rmSync(catalystDir, { recursive: true, force: true });
});

function seedSignal(ticket, phase, body) {
  const dir = join(orchDir, "workers", ticket);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `phase-${phase}.json`), JSON.stringify({ ticket, phase, ...body }));
}

function appendEvent(envelope) {
  appendFileSync(eventLogPath, JSON.stringify(envelope) + "\n");
}

function makeReviveEnvelope({ ticket, ts }) {
  return {
    ts,
    attributes: {
      "event.name": `phase.implement.revive.${ticket}`,
      "event.entity": "phase",
      "event.action": "revive",
      "event.label": ticket,
      "catalyst.orchestration": ticket,
      "linear.issue.identifier": ticket,
    },
    body: { payload: { phase: "implement", ticket, status: "revive" } },
  };
}

describe("CTL-587 end-to-end (schedulerTick + recovery)", () => {
  test("first-strike: dead worker → 'revived' on next schedulerTick", () => {
    seedSignal("CTL-587-A", "implement", {
      status: "running",
      bg_job_id: "nonexistent-bg-id",
      orchestrator: "test-orch",
    });

    const reviveDispatchCalls = [];
    const result = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      writeStatus: {
        applyPhaseStatus: () => {},
        applyTerminalDone: () => {},
        applyLabel: () => ({ applied: true }),
      },
      teardownWorktree: () => true,
      // Defer to the real reclaim function — the per-tick I/O seams that
      // would touch the filesystem are stubbed, but the real
      // defaultAppendReviveEvent runs against the temp events.jsonl. The
      // round-trip assertion at the end of the test confirms the envelope
      // shape this writes matches what countReviveEvents reads.
      reclaimDeadWork: (od, sig, opts) =>
        reclaimDeadWorkIfPossible(od, sig, {
          ...opts,
          // bg job dir is gone — classifyWorker → 'dead' → effectivelyDead
          statJob: () => null,
          probes: { implement: () => false }, // work NOT done
          reviveDispatch: (args) => {
            reviveDispatchCalls.push(args);
            return { code: 0 };
          },
          applyStalledLabel: () => ({ applied: true }),
          killBgJob: () => {},
          // No prior revive events.
          countReviveEvents: () => 0,
          countDistinctRevivingTickets: () => 1,
        }),
    });

    expect(result.revived).toEqual([{ ticket: "CTL-587-A", phase: "implement" }]);
    expect(result.escalated).toEqual([]);
    expect(reviveDispatchCalls).toHaveLength(1);
    expect(reviveDispatchCalls[0].ticket).toBe("CTL-587-A");
    expect(reviveDispatchCalls[0].phase).toBe("implement");
    // Marker file was written (operator-friendly forensic crumb).
    expect(existsSync(join(orchDir, "workers", "CTL-587-A", ".revive-1.applied"))).toBe(true);
    // Envelope round-trip: the real defaultAppendReviveEvent wrote a
    // phase.implement.revive.CTL-587-A envelope; countReviveEvents reads it
    // back. A field-name regression in buildEventEnvelope would break this.
    expect(countReviveEvents({ ticket: "CTL-587-A", path: eventLogPath })).toBe(1);
  });

  test("budget exhausted: 2 prior revive events → 'escalated' + needs-human label", () => {
    seedSignal("CTL-587-B", "implement", {
      status: "running",
      bg_job_id: "nonexistent-bg-id",
      orchestrator: "CTL-587-B",
    });
    // Pre-seed events.jsonl with two prior revives so the budget is exhausted.
    appendEvent(makeReviveEnvelope({ ticket: "CTL-587-B", ts: "2026-05-23T00:00:00Z" }));
    appendEvent(makeReviveEnvelope({ ticket: "CTL-587-B", ts: "2026-05-23T00:05:00Z" }));

    const labelCalls = [];
    const reviveDispatchCalls = [];
    const result = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      writeStatus: {
        applyPhaseStatus: () => {},
        applyTerminalDone: () => {},
        applyLabel: () => ({ applied: true }),
      },
      teardownWorktree: () => true,
      reclaimDeadWork: (od, sig, opts) =>
        reclaimDeadWorkIfPossible(od, sig, {
          ...opts,
          statJob: () => null, // bg dead
          probes: { implement: () => false }, // work NOT done
          reviveDispatch: (args) => {
            reviveDispatchCalls.push(args);
            return { code: 0 };
          },
          applyStalledLabel: ({ ticket }) => {
            labelCalls.push(ticket);
            return { applied: true };
          },
          killBgJob: () => {},
          // Use the default countReviveEvents → reads the real events.jsonl
          // we seeded above (no override).
        }),
    });

    expect(result.escalated).toEqual([{ ticket: "CTL-587-B", phase: "implement" }]);
    expect(result.revived).toEqual([]);
    expect(reviveDispatchCalls).toHaveLength(0);
    expect(labelCalls).toEqual(["CTL-587-B"]);
  });

  // CTL-655: a daemon-boot.json marker windows the budget to the current run.
  // Two revives that PRE-DATE the boot fall outside the window → the ticket is
  // revived (budget reset), exercising the real readBootSince + countReviveEvents.
  test("budget resets after restart — pre-boot revives are not counted → 'revived'", () => {
    seedSignal("CTL-587-RESET", "implement", {
      status: "running",
      bg_job_id: "nonexistent-bg-id",
      orchestrator: "CTL-587-RESET",
    });
    // Two prior revives, both BEFORE the boot time T.
    appendEvent(makeReviveEnvelope({ ticket: "CTL-587-RESET", ts: "2026-05-23T00:00:00Z" }));
    appendEvent(makeReviveEnvelope({ ticket: "CTL-587-RESET", ts: "2026-05-23T00:05:00Z" }));
    // Boot marker newer than both revives → they fall outside the window.
    writeFileSync(
      join(orchDir, "daemon-boot.json"),
      JSON.stringify({ bootedAt: "2026-05-24T00:00:00Z" }),
    );

    const labelCalls = [];
    const reviveDispatchCalls = [];
    const result = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      writeStatus: {
        applyPhaseStatus: () => {},
        applyTerminalDone: () => {},
        applyLabel: () => ({ applied: true }),
      },
      teardownWorktree: () => true,
      reclaimDeadWork: (od, sig, opts) =>
        reclaimDeadWorkIfPossible(od, sig, {
          ...opts,
          statJob: () => null, // bg dead
          probes: { implement: () => false }, // work NOT done
          reviveDispatch: (args) => {
            reviveDispatchCalls.push(args);
            return { code: 0 };
          },
          applyStalledLabel: ({ ticket }) => {
            labelCalls.push(ticket);
            return { applied: true };
          },
          killBgJob: () => {},
          // Default countReviveEvents + default readBootSince (reads the marker
          // we wrote in orchDir) — the real windowing path under test.
        }),
    });

    expect(result.revived).toEqual([{ ticket: "CTL-587-RESET", phase: "implement" }]);
    expect(result.escalated).toEqual([]);
    expect(reviveDispatchCalls).toHaveLength(1);
    expect(labelCalls).toEqual([]); // no needs-human escalation
  });

  // CTL-655 guard against an over-aggressive window: revives AT/AFTER the boot
  // time ARE counted, so the budget still exhausts within a single daemon run.
  test("budget still exhausts within one run — post-boot revives ARE counted → 'escalated'", () => {
    seedSignal("CTL-587-INRUN", "implement", {
      status: "running",
      bg_job_id: "nonexistent-bg-id",
      orchestrator: "CTL-587-INRUN",
    });
    const bootedAt = "2026-05-24T00:00:00Z";
    // Two revives at/after the boot time → inside the window.
    appendEvent(makeReviveEnvelope({ ticket: "CTL-587-INRUN", ts: "2026-05-25T00:00:00Z" }));
    appendEvent(makeReviveEnvelope({ ticket: "CTL-587-INRUN", ts: "2026-05-25T00:05:00Z" }));
    writeFileSync(join(orchDir, "daemon-boot.json"), JSON.stringify({ bootedAt }));

    const labelCalls = [];
    const reviveDispatchCalls = [];
    const result = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      writeStatus: {
        applyPhaseStatus: () => {},
        applyTerminalDone: () => {},
        applyLabel: () => ({ applied: true }),
      },
      teardownWorktree: () => true,
      reclaimDeadWork: (od, sig, opts) =>
        reclaimDeadWorkIfPossible(od, sig, {
          ...opts,
          statJob: () => null,
          probes: { implement: () => false },
          reviveDispatch: (args) => {
            reviveDispatchCalls.push(args);
            return { code: 0 };
          },
          applyStalledLabel: ({ ticket }) => {
            labelCalls.push(ticket);
            return { applied: true };
          },
          killBgJob: () => {},
        }),
    });

    expect(result.escalated).toEqual([{ ticket: "CTL-587-INRUN", phase: "implement" }]);
    expect(result.revived).toEqual([]);
    expect(reviveDispatchCalls).toHaveLength(0);
    expect(labelCalls).toEqual(["CTL-587-INRUN"]);
  });

  test("storm-breaker open: 4 distinct tickets reviving → 'revive-suppressed', no dispatch", () => {
    seedSignal("CTL-587-C", "implement", {
      status: "running",
      bg_job_id: "nonexistent-bg-id",
      orchestrator: "CTL-587-C",
    });

    const reviveDispatchCalls = [];
    const result = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      writeStatus: {
        applyPhaseStatus: () => {},
        applyTerminalDone: () => {},
        applyLabel: () => ({ applied: true }),
      },
      teardownWorktree: () => true,
      reclaimDeadWork: (od, sig, opts) =>
        reclaimDeadWorkIfPossible(od, sig, {
          ...opts,
          statJob: () => null,
          probes: { implement: () => false },
          reviveDispatch: (args) => {
            reviveDispatchCalls.push(args);
            return { code: 0 };
          },
          applyStalledLabel: () => ({ applied: true }),
          killBgJob: () => {},
          countReviveEvents: () => 0,
          countDistinctRevivingTickets: () => 4, // > STORM_THRESHOLD=3
        }),
    });

    expect(result.reviveSuppressed).toEqual([{ ticket: "CTL-587-C", phase: "implement" }]);
    expect(reviveDispatchCalls).toHaveLength(0);
    expect(existsSync(join(orchDir, "workers", "CTL-587-C", ".revive-1.applied"))).toBe(false); // no marker on suppression
  });

  // CTL-641 + CTL-604: pr now has a probe, but a dead pr worker whose
  // phase-pr.json carries no .pr.number reads as not-done → branch (C). CTL-604
  // made branch (C) phase-agnostic, so (with budget available) the worker is
  // re-dispatched fresh rather than dead-ended — 'revived', reviveDispatch fires.
  test("not-done pr phase on a dead worker → 'revived' (budget available)", () => {
    seedSignal("CTL-587-D", "pr", {
      status: "running",
      bg_job_id: "nonexistent-bg-id",
      orchestrator: "CTL-587-D",
    });

    const reviveDispatchCalls = [];
    const result = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      writeStatus: {
        applyPhaseStatus: () => {},
        applyTerminalDone: () => {},
        applyLabel: () => ({ applied: true }),
      },
      teardownWorktree: () => true,
      reclaimDeadWork: (od, sig, opts) =>
        reclaimDeadWorkIfPossible(od, sig, {
          ...opts,
          statJob: () => null, // bg dead
          // Default probes registry: pr's real probe reads .pr.number from
          // phase-pr.json; the seeded signal has none → not-done → branch (C).
          reviveDispatch: (args) => {
            reviveDispatchCalls.push(args);
            return { code: 0 };
          },
          killBgJob: () => {},
          // No prior revive events for CTL-587-D → budget available (0 < 2).
        }),
    });

    expect(result.revived).toEqual([{ ticket: "CTL-587-D", phase: "pr" }]);
    expect(result.escalated).toEqual([]);
    expect(reviveDispatchCalls).toHaveLength(1);
  });

  // CTL-658: end-to-end resume-on-revive. A dead-by-stale-mtime implement worker
  // whose bg_job_id has a resolvable state.json → the revive carries
  // resumeSession AND skips the defensive kill. Exercises the REAL
  // resolvePhaseSessionId against a fixture jobsDir (CATALYST_REVIVE_JOBS_DIR)
  // rather than a stub, so the daemon→dispatch resume wiring is proven end-to-end.
  test("resumable dead worker → dispatch carries resumeSession, kill skipped", () => {
    const jobsDir = join(catalystDir, "jobs");
    mkdirSync(join(jobsDir, "cafe1234"), { recursive: true });
    writeFileSync(
      join(jobsDir, "cafe1234", "state.json"),
      JSON.stringify({ linkScanPath: "/p/abcd-uuid.jsonl" }),
    );
    const prevJobsDir = process.env.CATALYST_REVIVE_JOBS_DIR;
    process.env.CATALYST_REVIVE_JOBS_DIR = jobsDir;
    try {
      seedSignal("CTL-658-E", "implement", {
        status: "running",
        bg_job_id: "cafe1234",
        worktreePath: "/wt/CTL/CTL-658-E",
        orchestrator: "CTL-658-E",
      });

      const reviveDispatchCalls = [];
      const killCalls = [];
      const result = schedulerTick(orchDir, {
        readEligible: () => [],
        dispatch: () => ({ code: 0 }),
        writeStatus: {
          applyPhaseStatus: () => {},
          applyTerminalDone: () => {},
          applyLabel: () => ({ applied: true }),
        },
        teardownWorktree: () => true,
        reclaimDeadWork: (od, sig, opts) =>
          reclaimDeadWorkIfPossible(od, sig, {
            ...opts,
            // 'running' classification + ancient mtime → effectively dead via the
            // staleness path (also past hungCutoffMs so pidAlive is never read).
            statJob: () => ({ exists: true, mtimeMs: 1000 }),
            probes: { implement: () => false }, // work NOT done → revive territory
            reviveDispatch: (args) => {
              reviveDispatchCalls.push(args);
              return { code: 0 };
            },
            killBgJob: (args) => killCalls.push(args),
            applyStalledLabel: () => ({ applied: true }),
            countReviveEvents: () => 0,
            countDistinctRevivingTickets: () => 1,
            // resolveSession left at the real default → reads CATALYST_REVIVE_JOBS_DIR.
          }),
      });

      expect(result.revived).toEqual([{ ticket: "CTL-658-E", phase: "implement" }]);
      expect(reviveDispatchCalls).toHaveLength(1);
      expect(reviveDispatchCalls[0].resumeSession).toBe("abcd-uuid");
      // Resume viable → the defensive kill must NOT fire (the session's jsonl
      // must stay intact for `--resume`).
      expect(killCalls).toHaveLength(0);
    } finally {
      if (prevJobsDir === undefined) delete process.env.CATALYST_REVIVE_JOBS_DIR;
      else process.env.CATALYST_REVIVE_JOBS_DIR = prevJobsDir;
    }
  });

  // CTL-658 companion: same fixture but NO state.json for the bg_job_id →
  // resolvePhaseSessionId returns null → unchanged behaviour: the defensive kill
  // fires and the dispatch carries no resumeSession (fresh re-dispatch).
  test("unresumable dead worker → kill fires, no resumeSession (fresh dispatch)", () => {
    const jobsDir = join(catalystDir, "jobs-empty");
    mkdirSync(jobsDir, { recursive: true }); // no <bgJobId>/state.json inside
    const prevJobsDir = process.env.CATALYST_REVIVE_JOBS_DIR;
    process.env.CATALYST_REVIVE_JOBS_DIR = jobsDir;
    try {
      seedSignal("CTL-658-F", "implement", {
        status: "running",
        bg_job_id: "feedface",
        worktreePath: "/wt/CTL/CTL-658-F",
        orchestrator: "CTL-658-F",
      });

      const reviveDispatchCalls = [];
      const killCalls = [];
      const result = schedulerTick(orchDir, {
        readEligible: () => [],
        dispatch: () => ({ code: 0 }),
        writeStatus: {
          applyPhaseStatus: () => {},
          applyTerminalDone: () => {},
          applyLabel: () => ({ applied: true }),
        },
        teardownWorktree: () => true,
        reclaimDeadWork: (od, sig, opts) =>
          reclaimDeadWorkIfPossible(od, sig, {
            ...opts,
            statJob: () => ({ exists: true, mtimeMs: 1000 }),
            probes: { implement: () => false },
            reviveDispatch: (args) => {
              reviveDispatchCalls.push(args);
              return { code: 0 };
            },
            killBgJob: (args) => killCalls.push(args),
            applyStalledLabel: () => ({ applied: true }),
            countReviveEvents: () => 0,
            countDistinctRevivingTickets: () => 1,
          }),
      });

      expect(result.revived).toEqual([{ ticket: "CTL-658-F", phase: "implement" }]);
      expect(reviveDispatchCalls).toHaveLength(1);
      expect(reviveDispatchCalls[0].resumeSession).toBeNull();
      // Unresumable → the defensive kill fires (free the abandoned bg worker).
      expect(killCalls).toHaveLength(1);
      expect(killCalls[0].bgJobId).toBe("feedface");
    } finally {
      if (prevJobsDir === undefined) delete process.env.CATALYST_REVIVE_JOBS_DIR;
      else process.env.CATALYST_REVIVE_JOBS_DIR = prevJobsDir;
    }
  });

  // CTL-735 Guard 2 — the storm bound. Many dead-bg signals in ONE tick (the
  // ~85-dir mass-revive scenario the de-starved fast loop hit) must NOT all
  // revive at once: the per-tick cap bounds revives so a fast loop cannot outrun
  // the event-count-lagged storm-breaker. With EXECUTION_CORE_PER_TICK_REVIVE_CAP=2,
  // exactly 2 of 5 revivable workers revive this tick; the other 3 are
  // `revive-capped` (deferred, no dispatch) and re-evaluated next tick. (No
  // startedAt on the signals → Guard 1's grace window does not defer them, so the
  // CAP is what bounds the count.)
  test("per-tick revive cap bounds a mass-revive tick (5 dead → 2 revived, 3 capped)", () => {
    for (let i = 0; i < 5; i++) {
      seedSignal(`CTL-735-S${i}`, "implement", {
        status: "running",
        bg_job_id: `dead-bg-${i}`,
        orchestrator: `CTL-735-S${i}`,
      });
    }

    const reviveDispatchCalls = [];
    const result = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      perTickReviveCap: 2, // injected — bound revives to 2 this tick
      writeStatus: {
        applyPhaseStatus: () => {},
        applyTerminalDone: () => {},
        applyLabel: () => ({ applied: true }),
      },
      teardownWorktree: () => true,
      reclaimDeadWork: (od, sig, opts) =>
        reclaimDeadWorkIfPossible(od, sig, {
          ...opts, // carries the scheduler's per-tick reviveBudgetRemaining
          statJob: () => null, // bg dead
          probes: { implement: () => false }, // work NOT done → branch (C)
          reviveDispatch: (args) => {
            reviveDispatchCalls.push(args);
            return { code: 0 };
          },
          applyStalledLabel: () => ({ applied: true }),
          killBgJob: () => {},
          countReviveEvents: () => 0, // per-ticket budget available for all
          countDistinctRevivingTickets: () => 1, // storm-breaker NOT tripped
        }),
    });

    // The cap — not the per-ticket budget or storm-breaker — is what bounds this.
    expect(result.revived).toHaveLength(2);
    expect(result.reviveCapped).toHaveLength(3);
    expect(reviveDispatchCalls).toHaveLength(2); // only the uncapped revives dispatched
  });
});
