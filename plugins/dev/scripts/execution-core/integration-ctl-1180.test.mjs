// integration-ctl-1180.test.mjs — CTL-1180 Phase 3 daemon test.
// Verifies that schedulerTick applies the needs-human label and
// .linear-label-needs-human.applied marker for a self-emitted phase failure,
// with the pipeline-done false-positive guard.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schedulerTick } from "./scheduler.mjs";

const NOW = Date.parse("2026-06-15T12:00:00Z");

let orchDir;
beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "ctl1180-int-"));
});
afterEach(() => {
  rmSync(orchDir, { recursive: true, force: true });
});

function writePhaseSignal(orchDir, ticket, phase, body) {
  const d = join(orchDir, "workers", ticket);
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, `phase-${phase}.json`),
    JSON.stringify({ ticket, phase, ...body }, null, 2) + "\n",
  );
}

function markerPath(orchDir, ticket) {
  return join(orchDir, "workers", ticket, ".linear-label-needs-human.applied");
}

function makeTickOpts({ events = [] } = {}) {
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
    watchdog: {
      mode: "enforce",
      transcriptAgeMs: () => 5_000, // fresh — NOT a watchdog kill candidate
      progressMark: () => 0,
      now: () => NOW,
      emit: (type, fields) => { events.push({ type, ...fields }); return Promise.resolve(true); },
      killEscalate: undefined,
    },
  };
}

describe("CTL-1180 Phase 3 — self-emitted failed → needs-human label", () => {
  test("self-emitted phase-pr.json failed (not pipeline-done) → .applied marker written", () => {
    const TICKET = "CTL-1180-FAIL";
    // Phases before pr done, pr itself is self-failed (no watchdog kill)
    writePhaseSignal(orchDir, TICKET, "triage", { status: "done" });
    writePhaseSignal(orchDir, TICKET, "research", { status: "done" });
    writePhaseSignal(orchDir, TICKET, "plan", { status: "done" });
    writePhaseSignal(orchDir, TICKET, "implement", { status: "done" });
    writePhaseSignal(orchDir, TICKET, "verify", { status: "done" });
    writePhaseSignal(orchDir, TICKET, "review", { status: "done" });
    writePhaseSignal(orchDir, TICKET, "pr", {
      status: "failed",
      explanation: {
        escalation_type: "manual",
        call_to_action: "Manually push the branch — push scope exceeded",
      },
    });
    schedulerTick(orchDir, makeTickOpts());
    expect(existsSync(markerPath(orchDir, TICKET))).toBe(true);
  });

  test("false-positive guard: phase-pr failed + teardown done → marker NOT applied", () => {
    const TICKET = "CTL-1180-DONE";
    writePhaseSignal(orchDir, TICKET, "triage", { status: "done" });
    writePhaseSignal(orchDir, TICKET, "pr", { status: "failed" });
    writePhaseSignal(orchDir, TICKET, "teardown", { status: "done" }); // TERMINAL_PHASE done
    schedulerTick(orchDir, makeTickOpts());
    // Terminal Done block clears the marker; apply gate checks !pipelineDone
    expect(existsSync(markerPath(orchDir, TICKET))).toBe(false);
  });

  test("no-regression: stalled phase still gets the marker (existing behavior)", () => {
    const TICKET = "CTL-1180-STALL";
    writePhaseSignal(orchDir, TICKET, "implement", { status: "stalled" });
    schedulerTick(orchDir, makeTickOpts());
    expect(existsSync(markerPath(orchDir, TICKET))).toBe(true);
  });

  test("idempotency: second tick on still-failed ticket does not change marker state", () => {
    const TICKET = "CTL-1180-IDEM";
    writePhaseSignal(orchDir, TICKET, "pr", { status: "failed" });
    schedulerTick(orchDir, makeTickOpts());
    const afterFirst = existsSync(markerPath(orchDir, TICKET));
    schedulerTick(orchDir, makeTickOpts());
    const afterSecond = existsSync(markerPath(orchDir, TICKET));
    expect(afterFirst).toBe(true);
    expect(afterSecond).toBe(true); // stable
  });
});
