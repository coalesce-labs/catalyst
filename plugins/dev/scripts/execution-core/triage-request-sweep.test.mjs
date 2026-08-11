// CAT-166 — coverage for the triage-request ESCALATION SWEEP inside
// sweepMissingTriage. The leaf module (triage-request.mjs) is unit-tested in
// triage-request.test.mjs; this file covers the monitor-side wiring that
// decides whether to ACT on a stale request — the seam where `enforce` routes
// a real delegate intent.
//
// Hermetic by construction: CATALYST_DIR points at a temp tree with NO
// registry.json, so listProjects() is empty and the per-project candidate loop
// is a no-op. Only the escalation sweep (which runs after that loop) executes,
// so these tests never touch the host's real registry or eligible sets.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepMissingTriage } from "./monitor.mjs";
import {
  markTriageRequestEscalated,
  readTriageRequest,
  recordTriageDecline,
  recordTriageRequest,
} from "./triage-request.mjs";

const ESCALATE_MS = 45 * 60_000;
const TICKET = "CAT-999";

let catalystDir;
let orchDir;
let prevCatalystDir;

beforeEach(() => {
  prevCatalystDir = process.env.CATALYST_DIR;
  catalystDir = mkdtempSync(join(tmpdir(), "cat166-sweep-"));
  process.env.CATALYST_DIR = catalystDir;
  orchDir = join(catalystDir, "execution-core");
  mkdirSync(orchDir, { recursive: true });
});

afterEach(() => {
  if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
  else process.env.CATALYST_DIR = prevCatalystDir;
  rmSync(catalystDir, { recursive: true, force: true });
});

// seedRequest — a request first seen at t=0, optionally carrying a recorded
// monitor decline (the stable reason the escalation is supposed to surface).
function seedRequest({ declineReason = null } = {}) {
  recordTriageRequest(
    orchDir,
    TICKET,
    { team: "CAT", class: "untriaged", reason: "untriaged-no-triage-artifact", holdStreak: 3 },
    { now: 0, hostName: "scheduler-host" },
  );
  if (declineReason) recordTriageDecline(orchDir, TICKET, declineReason, { now: 1, hostName: "monitor-host" });
}

// runSweep — drive only the escalation half; capture routes + emitted events.
function runSweep({ mode, now = ESCALATE_MS }) {
  const routed = [];
  const events = [];
  sweepMissingTriage({
    orchDir,
    dispatch: () => ({ code: 0 }),
    triageEscalateMode: mode,
    triageEscalateMs: ESCALATE_MS,
    now: () => now,
    routeTriageEscalation: (dir, ticket, opts) => {
      routed.push({ dir, ticket, site: opts.site, reason: opts.reason, explanation: opts.explanation });
      return { labelled: false };
    },
    appendTriageEscalatedEvent: (e) => events.push(e),
  });
  return { routed, events };
}

describe("CAT-166 triage-request escalation sweep", () => {
  test("an eligible-state request reaches dispatch without Triage-board revalidation", () => {
    writeFileSync(
      join(orchDir, "registry.json"),
      JSON.stringify({
        projects: [
          {
            team: "CAT",
            repoRoot: catalystDir,
            eligibleQuery: { status: "Todo", triageStatus: "Triage" },
          },
        ],
      }),
    );
    seedRequest();
    const dispatches = [];
    let liveStateReads = 0;

    sweepMissingTriage({
      orchDir,
      dispatch: (request) => {
        dispatches.push(request);
        return { code: 0 };
      },
      applyTriageStatus: () => ({ applied: false }),
      appendEvent: () => {},
      readMaxParallelFn: () => 1,
      liveBackgroundCount: () => 0,
      runTriageState: () => [],
      hosts: ["test-host"],
      hostName: "test-host",
      fetchLiveState: () => {
        liveStateReads += 1;
        return "Todo";
      },
      triageEscalateMode: "off",
    });

    expect(dispatches).toEqual([{ orchDir, ticket: TICKET, phase: "triage" }]);
    expect(liveStateReads).toBe(0);
  });

  test("off: never routes, never emits, never latches", () => {
    seedRequest({ declineReason: "no-free-slots" });
    const { routed, events } = runSweep({ mode: "off" });
    expect(routed).toHaveLength(0);
    expect(events).toHaveLength(0);
    expect(readTriageRequest(orchDir, TICKET).escalatedAt).toBeNull();
  });

  test("shadow: emits once, latches shadow separately, and leaves enforce actionable", () => {
    seedRequest({ declineReason: "no-free-slots" });
    const { routed, events } = runSweep({ mode: "shadow" });
    expect(routed).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ ticket: TICKET, shadow: true, reason: "no-free-slots", age_ms: ESCALATE_MS });
    const request = readTriageRequest(orchDir, TICKET);
    expect(request.shadowEscalatedAt).toBe(ESCALATE_MS);
    expect(request.escalatedAt).toBeNull();

    const repeated = runSweep({ mode: "shadow", now: ESCALATE_MS * 2 });
    expect(repeated.events).toHaveLength(0);

    const enforced = runSweep({ mode: "enforce", now: ESCALATE_MS * 3 });
    expect(enforced.routed).toHaveLength(1);
  });

  test("enforce: routes once through the delegate-first seam and latches the episode", () => {
    seedRequest({ declineReason: "not-owned-hrw" });
    const first = runSweep({ mode: "enforce" });
    expect(first.routed).toHaveLength(1);
    expect(first.routed[0]).toMatchObject({
      dir: orchDir,
      ticket: TICKET,
      site: "triage-request-escalation",
      reason: "not-owned-hrw",
    });
    expect(first.routed[0].explanation.call_to_action).toContain("not-owned-hrw");
    expect(first.events[0]).toMatchObject({ ticket: TICKET, shadow: false, reason: "not-owned-hrw" });
    expect(readTriageRequest(orchDir, TICKET).escalatedAt).toBe(ESCALATE_MS);

    // Episode idempotency: a later sweep must not re-route the same request.
    const second = runSweep({ mode: "enforce", now: ESCALATE_MS * 4 });
    expect(second.routed).toHaveLength(0);
    expect(second.events).toHaveLength(0);
  });

  test("a request younger than the window is never escalated in any mode", () => {
    seedRequest({ declineReason: "drain-active" });
    for (const mode of ["shadow", "enforce"]) {
      const { routed, events } = runSweep({ mode, now: ESCALATE_MS - 1 });
      expect(routed).toHaveLength(0);
      expect(events).toHaveLength(0);
    }
    expect(readTriageRequest(orchDir, TICKET).escalatedAt).toBeNull();
  });

  test("a request never seen by the monitor escalates with the never-considered reason", () => {
    seedRequest(); // no decline recorded — the monitor never even considered it
    const { routed, events } = runSweep({ mode: "enforce" });
    expect(routed[0].reason).toBe("never-considered");
    expect(events[0].reason).toBe("never-considered");
  });

  test("an already-escalated request is skipped even after the window widens", () => {
    seedRequest({ declineReason: "spawn-failed" });
    markTriageRequestEscalated(orchDir, TICKET, { now: 10 });
    const { routed, events } = runSweep({ mode: "enforce", now: ESCALATE_MS * 10 });
    expect(routed).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  test("no triage requests on disk → the sweep is a silent no-op", () => {
    const { routed, events } = runSweep({ mode: "enforce" });
    expect(routed).toHaveLength(0);
    expect(events).toHaveLength(0);
  });
});
