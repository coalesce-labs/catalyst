// integration-ctl-701.test.mjs — end-to-end regression for the 2026-05-28
// incident: OS reboot with 4 in-flight tickets (2 × pr/running,
// 1 × monitor-deploy/running, 1 × implement/turn-cap-exhausted) stranded
// two tickets because signal-reader excluded monitor-deploy signals and
// classifyWorker short-circuited turn-cap-exhausted as terminal.
//
// This file exercises Phases 1-3 in composition:
//   Phase 1 fix: phase-monitor-deploy.json removed from ARTIFACT_NAMES
//   Phase 2 fix: turn-cap-exhausted removed from TERMINAL
//   Phase 3 fix: daemon-boot.json as exec-core epoch for detectColdStart
//
// Run: bun test plugins/dev/scripts/execution-core/integration-ctl-701.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileBootResume, bootResumePendingPath } from "./boot-resume.mjs";
import { detectColdStart, classifyWorker } from "./recovery.mjs";
import { reclaimDeadWorkIfPossible } from "./recovery.mjs";

let orchDir;

beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "ctl701-integ-"));
  mkdirSync(join(orchDir, "workers"), { recursive: true });
});

afterEach(() => {
  rmSync(orchDir, { recursive: true, force: true });
});

// write a phase signal under workers/<ticket>/phase-<phase>.json
function writePhaseSignal(ticket, phase, overrides = {}) {
  const dir = join(orchDir, "workers", ticket);
  mkdirSync(dir, { recursive: true });
  const sig = {
    ticket,
    phase,
    status: "running",
    bg_job_id: `job-${ticket.toLowerCase()}`,
    worktreePath: `/wt/${ticket}`,
    updatedAt: "2026-05-28T14:00:00Z",
    ...overrides,
  };
  writeFileSync(join(dir, `phase-${phase}.json`), JSON.stringify(sig, null, 2));
  return sig;
}

// Build the 4-ticket fixture: CTL-A, CTL-B (pr/running), CTL-C (monitor-deploy),
// CTL-D (implement/turn-cap-exhausted). All bg jobs have mtime T_OLD < T_BOOT.
const T_OLD = 1_000; // all job mtimes — before exec-core boot
const T_BOOT = 5_000; // daemon-boot.json bootedAt (exec-core epoch)

function buildFixture() {
  writePhaseSignal("CTL-A", "pr");
  writePhaseSignal("CTL-B", "pr");
  writePhaseSignal("CTL-C", "monitor-deploy");
  writePhaseSignal("CTL-D", "implement", { status: "turn-cap-exhausted" });

  // Write state.json for maxParallel so reconcileBootResume doesn't cap at 1
  writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 8 }));

  // Write daemon-boot.json — T_BOOT > T_OLD → exec-core epoch wins
  writeFileSync(
    join(orchDir, "daemon-boot.json"),
    JSON.stringify({ bootedAt: new Date(T_BOOT).toISOString() }),
  );
}

// statJob that maps known job ids to T_OLD mtimes — for detectColdStart, which
// checks mtime against the epoch. All jobs predate T_BOOT so the verdict is cold.
function makeStatJob() {
  const knownJobs = new Map([
    ["job-ctl-a", { exists: true, mtimeMs: T_OLD }],
    ["job-ctl-b", { exists: true, mtimeMs: T_OLD }],
    ["job-ctl-c", { exists: true, mtimeMs: T_OLD }],
    ["job-ctl-d", { exists: true, mtimeMs: T_OLD }],
  ]);
  return (id) => knownJobs.get(id) ?? null;
}

describe("CTL-701 incident integration (2026-05-28 scenario)", () => {
  test("boot-resume reconciles all four in-flight tickets on logical cold start", () => {
    buildFixture();

    // Prove detectColdStart with exec-core epoch returns coldStart:true for our
    // fixture: runtime epoch is LOW (daemon not restarted), exec-core is HIGH.
    const coldReport = detectColdStart({
      readEpoch: () => ({ epoch: T_OLD / 2, epochSource: "daemon", bootEpoch: 0, daemonEpoch: T_OLD / 2 }),
      readDir: () => ["job-ctl-a", "job-ctl-b", "job-ctl-c", "job-ctl-d"],
      statJob: makeStatJob(),
      orchDir,
    });
    expect(coldReport.coldStart).toBe(true);
    expect(coldReport.epochSource).toBe("exec-core");

    // CTL-644: all 4 fixture phases (pr, pr, monitor-deploy, implement) are expensive →
    // gated behind operator approval, NOT auto-dispatched on cold start.
    const dispatched = [];
    const gatedEvents = [];
    const res = reconcileBootResume({
      orchDir,
      report: { coldStart: true },
      agents: [], // no live bg workers
      reviveDispatch: (a) => {
        dispatched.push({ ticket: a.ticket, phase: a.phase });
        return { code: 0 };
      },
      resolveSession: () => null,
      appendEvent: () => {},
      appendGatedEvent: (e) => gatedEvents.push(e),
    });

    // All 4 are expensive phases — gated, not auto-dispatched.
    expect(res.dispatched).toBe(0);
    expect(res.gated).toBe(4);
    expect(res.failed).toBe(0);
    expect(dispatched).toHaveLength(0);
    expect(gatedEvents).toHaveLength(4);

    // Pending markers exist for all 4 tickets
    for (const ticket of ["CTL-A", "CTL-B", "CTL-C", "CTL-D"]) {
      expect(existsSync(bootResumePendingPath(orchDir, ticket))).toBe(true);
    }
  });

  test("per-tick reclaim sweep does NOT short-circuit monitor-deploy or turn-cap-exhausted", () => {
    buildFixture();
    // deadStatJob simulates all bg jobs having exited (no state.json present)
    const deadStatJob = () => null;

    // Build canonical WorkerSignal shapes for all four tickets
    function makeSig(ticket, phase, status = "running") {
      return {
        ticket,
        phase,
        status,
        liveness: { kind: "bg", value: `job-${ticket.toLowerCase()}` },
        signalPath: join(orchDir, "workers", ticket, `phase-${phase}.json`),
        raw: { ticket, phase, orchestrator: ticket, status, bg_job_id: `job-${ticket.toLowerCase()}` },
      };
    }

    const signals = [
      makeSig("CTL-A", "pr"),
      makeSig("CTL-B", "pr"),
      makeSig("CTL-C", "monitor-deploy"),
      makeSig("CTL-D", "implement", "turn-cap-exhausted"),
    ];

    // classifyWorker must return "dead" (not "terminal") for all four,
    // including monitor-deploy (Phase 1 fix) and turn-cap-exhausted (Phase 2 fix)
    for (const sig of signals) {
      const klass = classifyWorker(sig, { statJob: deadStatJob });
      expect(klass).toBe("dead");
    }

    // reclaimDeadWorkIfPossible must NOT return "noop" for any of the four
    const results = signals.map((sig) =>
      reclaimDeadWorkIfPossible(orchDir, sig, {
        statJob: deadStatJob,
        probes: { pr: () => false, "monitor-deploy": () => false, implement: () => false },
        emitComplete: () => ({ code: 0 }),
        appendEvent: () => undefined,
        appendReviveEvent: () => undefined,
        reviveDispatch: () => ({ code: 0 }),
        countReviveEvents: () => 0,
        countDistinctRevivingTickets: () => 1,
        writeReviveMarker: () => undefined,
        killBgJob: () => undefined,
        applyStalledLabel: () => ({ applied: true }),
        liveness: () => "absent",
        postReclaimMirror: () => {},
      }),
    );

    for (let i = 0; i < results.length; i++) {
      expect(results[i]).not.toBe("noop");
    }
    // All four should enter the revive path (probe=false → revived)
    expect(results.every((r) => r === "revived")).toBe(true);
  });
});
