// integration-ctl-701.test.mjs — end-to-end regression for the 2026-05-28
// incident: OS reboot with 4 in-flight tickets (2 × pr/running,
// 1 × monitor-deploy/running, 1 × implement/turn-cap-exhausted) stranded
// two tickets because signal-reader excluded monitor-deploy signals and
// classifyWorker short-circuited turn-cap-exhausted as terminal.
//
// This file exercises Phases 1-3 in composition:
//   Phase 1 fix: phase-monitor-deploy.json removed from ARTIFACT_NAMES
//   Phase 2 fix (REVERSED by CTL-830): CTL-748 (2026-06-02) disabled per-phase
//     turn caps — turn-cap-exhausted is now unambiguously TERMINAL again.
//     CTL-D (implement/turn-cap-exhausted) is excluded from boot-resume and
//     short-circuits reclaim/revive to noop (CTL-830).
//   Phase 3 fix: daemon-boot.json as exec-core epoch for detectColdStart
//
// Run: bun test plugins/dev/scripts/execution-core/integration-ctl-701.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileBootResume } from "./boot-resume.mjs";
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
  test("boot-resume reconciles the three resumable tickets; turn-cap-exhausted is terminal (CTL-830)", () => {
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

    // reconcileBootResume should dispatch the 3 non-terminal tickets (CTL-D is terminal)
    const dispatched = [];
    const events = [];
    const res = reconcileBootResume({
      orchDir,
      report: { coldStart: true },
      agents: [], // no live bg workers
      reviveDispatch: (a) => {
        dispatched.push({ ticket: a.ticket, phase: a.phase });
        return { code: 0 };
      },
      resolveSession: () => null, // no resume UUIDs available
      appendEvent: (e) => events.push(e),
    });

    expect(res.dispatched).toBe(3);
    expect(res.failed).toBe(0);

    const tickets = dispatched.map((d) => d.ticket).sort();
    expect(tickets).toEqual(["CTL-A", "CTL-B", "CTL-C"]);

    // Monitor-deploy must be in the dispatch list; turn-cap-exhausted must be excluded
    const phases = Object.fromEntries(dispatched.map((d) => [d.ticket, d.phase]));
    expect(phases["CTL-C"]).toBe("monitor-deploy");
    expect(phases["CTL-D"]).toBeUndefined();
  });

  test("per-tick reclaim sweep does NOT short-circuit monitor-deploy; turn-cap-exhausted IS terminal (CTL-830)", () => {
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

    // CTL-A/B/C must classify as "dead"; CTL-D (turn-cap-exhausted) must classify as "terminal"
    for (const sig of signals.slice(0, 3)) {
      expect(classifyWorker(sig, { statJob: deadStatJob })).toBe("dead");
    }
    expect(classifyWorker(signals[3], { statJob: deadStatJob })).toBe("terminal");

    // reclaimDeadWorkIfPossible: CTL-A/B/C enter revive path; CTL-D short-circuits to noop
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

    // CTL-A, CTL-B, CTL-C revive; CTL-D is noop (terminal)
    expect(results[0]).toBe("revived");
    expect(results[1]).toBe("revived");
    expect(results[2]).toBe("revived");
    expect(results[3]).toBe("noop");
  });
});
