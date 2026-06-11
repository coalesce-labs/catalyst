// integration-ctl-1004.test.mjs — CTL-1004 end-to-end: schedulerTick Pass 0j.
// Drives the real schedulerTick over a fixture worker dir, asserting the
// stall-janitor pass wires through to the injected seam boundary. Models
// integration-ctl-729.test.mjs (the watchdog Pass 0w integration).

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schedulerTick } from "./scheduler.mjs";

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
