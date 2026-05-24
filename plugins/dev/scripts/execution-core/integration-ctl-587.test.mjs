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

let orchDir;
let catalystDir;
let prevCatalystDir;
let eventLogPath;

beforeEach(() => {
  prevCatalystDir = process.env.CATALYST_DIR;
  catalystDir = mkdtempSync(join(tmpdir(), "ctl587-int-"));
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
      liveness: { kind: "bg", value: "nonexistent-bg-id" },
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
      // Capture the call but defer to the real reclaim function via injected
      // seams. We exercise the wiring here, not the internal branch matrix
      // (covered exhaustively in recovery.test.mjs).
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
  });

  test("budget exhausted: 2 prior revive events → 'escalated' + needs-human label", () => {
    seedSignal("CTL-587-B", "implement", {
      status: "running",
      bg_job_id: "nonexistent-bg-id",
      liveness: { kind: "bg", value: "nonexistent-bg-id" },
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

  test("storm-breaker open: 4 distinct tickets reviving → 'revive-suppressed', no dispatch", () => {
    seedSignal("CTL-587-C", "implement", {
      status: "running",
      bg_job_id: "nonexistent-bg-id",
      liveness: { kind: "bg", value: "nonexistent-bg-id" },
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

  test("no-probe phase (pr) on a dead worker → 'escalated' immediately", () => {
    seedSignal("CTL-587-D", "pr", {
      status: "running",
      bg_job_id: "nonexistent-bg-id",
      liveness: { kind: "bg", value: "nonexistent-bg-id" },
      orchestrator: "CTL-587-D",
    });

    const labelCalls = [];
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
          // Default probes registry — only 'implement' has a probe; pr does not.
          applyStalledLabel: ({ ticket }) => {
            labelCalls.push(ticket);
            return { applied: true };
          },
          reviveDispatch: () => {
            throw new Error("revive must not be called for no-probe escalation");
          },
        }),
    });

    expect(result.escalated).toEqual([{ ticket: "CTL-587-D", phase: "pr" }]);
    expect(labelCalls).toEqual(["CTL-587-D"]);
  });
});
