// Unit tests for gc-startup.mjs (CTL-643).
// Boot-time GC pass over the broker interests Map — prunes interests whose
// owning orchestrator/ticket or session is no longer in-flight. Mirrors the
// bulk pattern at router.mjs handleOrchestratorTerminated.
// Run: bun test plugins/dev/scripts/broker/gc-startup.test.mjs

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gcStaleInterests } from "./gc-startup.mjs";

let tmpDir;
let execCoreOrchDir;
let runsRoot;
let statJob;
let log;
let saveInterests;
let persistBrokerState;
let deleteFilterState;
let appendEvent;

function writeSignal(orchDir, ticket, phase, status, extra = {}) {
  const dir = join(orchDir, "workers", ticket);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `phase-${phase}.json`),
    JSON.stringify({ ticket, phase, status, ...extra }),
  );
}

function makeInterests(records) {
  const map = new Map();
  for (const r of records) {
    map.set(r.id, {
      orchestrator: r.orchestrator ?? null,
      interest_type: r.interest_type ?? "ticket_lifecycle",
      session_id: r.session_id ?? null,
      ...r,
    });
  }
  return map;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "gc-startup-test-"));
  execCoreOrchDir = join(tmpDir, "execution-core");
  runsRoot = join(tmpDir, "runs");
  mkdirSync(execCoreOrchDir, { recursive: true });
  mkdirSync(runsRoot, { recursive: true });

  // Live ticket.
  writeSignal(execCoreOrchDir, "CTL-700", "implement", "running", {
    bg_job_id: "live-job",
  });
  // Terminal tickets (worker dir exists, all signals terminal).
  writeSignal(execCoreOrchDir, "CTL-701", "teardown", "done");
  writeSignal(execCoreOrchDir, "CTL-702", "verify", "failed");
  // CTL-999 has no dir at all → pure orphan.

  statJob = (sid) => (sid === "live-session" ? { mtime: 1, state: {} } : null);

  log = {
    info: mock(() => {}),
    warn: mock(() => {}),
  };
  saveInterests = mock(() => {});
  persistBrokerState = mock(() => {});
  deleteFilterState = mock(() => {});
  appendEvent = mock(() => {});
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("gcStaleInterests", () => {
  test("prunes terminal/orphan/dead-session interests and keeps live ones", () => {
    const interests = makeInterests([
      { id: "alive-1", orchestrator: "CTL-700" },
      { id: "dead-1", orchestrator: "CTL-701" },
      { id: "dead-2", orchestrator: "CTL-702" },
      { id: "orphan-1", orchestrator: "CTL-999" },
      {
        id: "pr-dead",
        orchestrator: "CTL-701",
        interest_type: "pr_lifecycle",
        session_id: "dead-session",
      },
      {
        id: "session-alive",
        orchestrator: null,
        interest_type: "pr_lifecycle",
        session_id: "live-session",
      },
    ]);

    const result = gcStaleInterests({
      interests,
      log,
      saveInterests,
      persistBrokerState,
      deleteFilterState,
      appendEvent,
      execCoreOrchDir,
      runsRoot,
      statJob,
    });

    expect(result.pruned).toBe(4);
    expect(result.byReason.orchestrator_terminal).toBe(3); // dead-1, dead-2, pr-dead
    expect(result.byReason.orchestrator_orphan).toBe(1); // orphan-1
    expect(result.beforeCount).toBe(6);
    expect(result.afterCount).toBe(2);

    // Map mutation
    expect(interests.has("alive-1")).toBe(true);
    expect(interests.has("session-alive")).toBe(true);
    expect(interests.size).toBe(2);

    // pr_lifecycle prune calls deleteFilterState once (pr-dead).
    expect(deleteFilterState).toHaveBeenCalledTimes(1);
    expect(deleteFilterState).toHaveBeenCalledWith("pr-dead");

    // Single saveInterests + persistBrokerState after the loop.
    expect(saveInterests).toHaveBeenCalledTimes(1);
    expect(persistBrokerState).toHaveBeenCalledTimes(1);

    // One audit event capturing the summary.
    expect(appendEvent).toHaveBeenCalledTimes(1);
    const ev = appendEvent.mock.calls[0][0];
    expect(ev.event).toBe("broker.daemon.gc");
    expect(ev.detail.pruned).toBe(4);
    expect(ev.detail.beforeCount).toBe(6);
    expect(ev.detail.afterCount).toBe(2);
    expect(ev.detail.byReason).toEqual({
      orchestrator_terminal: 3,
      orchestrator_orphan: 1,
    });
  });

  test("returns zero-pruned result and skips side effects on an empty interests Map", () => {
    const interests = new Map();
    const result = gcStaleInterests({
      interests,
      log,
      saveInterests,
      persistBrokerState,
      deleteFilterState,
      appendEvent,
      execCoreOrchDir,
      runsRoot,
      statJob,
    });

    expect(result.pruned).toBe(0);
    expect(saveInterests).not.toHaveBeenCalled();
    expect(persistBrokerState).not.toHaveBeenCalled();
    expect(appendEvent).not.toHaveBeenCalled();
    expect(deleteFilterState).not.toHaveBeenCalled();
  });

  test("returns zero-pruned result when every interest is alive", () => {
    const interests = makeInterests([
      { id: "alive-1", orchestrator: "CTL-700" },
      {
        id: "session-alive",
        orchestrator: null,
        interest_type: "pr_lifecycle",
        session_id: "live-session",
      },
    ]);
    const result = gcStaleInterests({
      interests,
      log,
      saveInterests,
      persistBrokerState,
      deleteFilterState,
      appendEvent,
      execCoreOrchDir,
      runsRoot,
      statJob,
    });

    expect(result.pruned).toBe(0);
    expect(interests.size).toBe(2);
    expect(saveInterests).not.toHaveBeenCalled();
    expect(persistBrokerState).not.toHaveBeenCalled();
    expect(appendEvent).not.toHaveBeenCalled();
  });

  test("prunes a pure dead-session pr_lifecycle interest as session_dead", () => {
    const interests = makeInterests([
      {
        id: "session-dead",
        orchestrator: null,
        interest_type: "pr_lifecycle",
        session_id: "dead-session",
      },
    ]);

    const result = gcStaleInterests({
      interests,
      log,
      saveInterests,
      persistBrokerState,
      deleteFilterState,
      appendEvent,
      execCoreOrchDir,
      runsRoot,
      statJob,
    });

    expect(result.pruned).toBe(1);
    expect(result.byReason).toEqual({ session_dead: 1 });
    expect(deleteFilterState).toHaveBeenCalledWith("session-dead");
    expect(interests.size).toBe(0);
  });

  test("deleteFilterState failure does not block remaining prunes", () => {
    const interests = makeInterests([
      {
        id: "pr-throws",
        orchestrator: "CTL-701",
        interest_type: "pr_lifecycle",
      },
      { id: "dead-1", orchestrator: "CTL-702" },
    ]);
    deleteFilterState = mock(() => {
      throw new Error("DB closed");
    });

    const result = gcStaleInterests({
      interests,
      log,
      saveInterests,
      persistBrokerState,
      deleteFilterState,
      appendEvent,
      execCoreOrchDir,
      runsRoot,
      statJob,
    });

    expect(result.pruned).toBe(2);
    expect(interests.size).toBe(0);
    expect(log.warn).toHaveBeenCalled();
    expect(saveInterests).toHaveBeenCalledTimes(1);
  });
});
