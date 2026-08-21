// advance-rearm.test.mjs — CTL-2113.
//
// ADVANCE-GUARD DUPLICATE-EDGE WEDGE — LOST-SUCCESSOR RE-ARM.
//
// CTL-1805's advance guard makes an applied phase-edge a durable fact on disk
// (.advance-<from>-to-<to>.applied). The guard key is computed from the
// PREDECESSOR's identity, so it is byte-identical as long as the predecessor
// signal is unchanged. This is correct for the replay it was built to stop —
// but it has a permanent-wedge failure mode: if the SUCCESSOR signal is deleted
// by a path that does NOT retract the marker (CTL-695 failure-path reap, L3
// destroy+recreate, worker-dir GC), the predecessor is unchanged, the key stays
// byte-identical, and `isAdvanceAlreadyApplied` returns true FOREVER.
//
// This ticket closes the wedge with a check-side re-arm: if the marker is
// applied BUT the successor signal is absent (stale marker), retract the marker
// and fall through to re-dispatch. CTL-2113 also adds a daemon.log WARN and
// a phase.advance.rearmed event, and makes the CTL-695 failure-path deleter
// retraction-aware as defense in depth.
//
// TEST COVERAGE (mirrors clear-stall-advance-reentry.test.mjs's discipline):
//   T1  isAdvanceMarkerStale truth table (pure, zero-disk)
//   T2  Disk-level stale detection: marker present, successor absent → stale
//   T3  Disk-level not-stale: marker present, successor present → NOT stale
//   T4  Re-arm is one-shot: after retractAdvanceMarkersInto, isAdvanceAlreadyApplied
//       returns false (marker gone → next tick takes normal dispatch path)
//   T5  Behavioral sweep: seed the CTL-695 wedge shape (marker present, successor
//       deleted), drive 16 ticks with the new suppression logic, assert the edge
//       re-derives exactly once — never a replay storm (the two-sided property
//       CTL-2024's test established, now also verified for the stale path).
//
// CI-INCLUDED (to be registered in .github/workflows/execution-core-tests.yml).
//
// Run: cd plugins/dev/scripts/execution-core && bun test advance-rearm.test.mjs

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeAdvanceEdgeKey,
  isAdvanceAlreadyApplied,
  isAdvanceMarkerStale,
  recordAdvanceApplied,
  retractAdvanceMarkersInto,
} from "./advance-guard.mjs";

const TICKET = "CTL-56";
const FROM = "triage";
const TO = "research";
const PRED_RAW = { generation: 1, updatedAt: "2026-08-20T10:00:00Z" };

let orchDir;
let workerDir;
let successorPath;

beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "ctl2113-rearm-"));
  workerDir = join(orchDir, "workers", TICKET);
  mkdirSync(workerDir, { recursive: true });
  successorPath = join(workerDir, `phase-${TO}.json`);
});
afterEach(() => rmSync(orchDir, { recursive: true, force: true }));

const edgeKey = () => computeAdvanceEdgeKey({ ticket: TICKET, from: FROM, to: TO, predRaw: PRED_RAW });
const writePredecessor = () =>
  writeFileSync(join(workerDir, `phase-${FROM}.json`), JSON.stringify(PRED_RAW));
const writeSuccessor = () =>
  writeFileSync(successorPath, JSON.stringify({ phase: TO, status: "dispatched" }));
const deleteSuccessor = () => rmSync(successorPath, { force: true });

// ─── T1: isAdvanceMarkerStale — pure truth table ────────────────────────────
describe("isAdvanceMarkerStale — truth table (zero-disk)", () => {
  test("applied=true AND successorPresent=false → STALE (the wedge case)", () => {
    expect(isAdvanceMarkerStale({ applied: true, successorPresent: false })).toBe(true);
  });

  test("applied=true AND successorPresent=true → NOT stale (genuine idempotent duplicate)", () => {
    expect(isAdvanceMarkerStale({ applied: true, successorPresent: true })).toBe(false);
  });

  test("applied=false AND successorPresent=false → NOT stale (no marker at all — normal path)", () => {
    expect(isAdvanceMarkerStale({ applied: false, successorPresent: false })).toBe(false);
  });

  test("applied=false AND successorPresent=true → NOT stale", () => {
    expect(isAdvanceMarkerStale({ applied: false, successorPresent: true })).toBe(false);
  });
});

// ─── T2: Disk-level stale detection ─────────────────────────────────────────
describe("disk-level stale detection", () => {
  test("marker present + successor absent → isAdvanceAlreadyApplied true AND isAdvanceMarkerStale true", () => {
    writePredecessor();
    const key = edgeKey();
    recordAdvanceApplied(orchDir, TICKET, FROM, TO, key);
    // Successor is absent (never created / deleted after dispatch)
    expect(isAdvanceAlreadyApplied(orchDir, TICKET, FROM, TO, key)).toBe(true);
    expect(isAdvanceMarkerStale({ applied: true, successorPresent: false })).toBe(true);
  });

  test("marker present + successor also present → applied true, NOT stale (suppress correctly)", () => {
    writePredecessor();
    const key = edgeKey();
    recordAdvanceApplied(orchDir, TICKET, FROM, TO, key);
    writeSuccessor();
    expect(isAdvanceAlreadyApplied(orchDir, TICKET, FROM, TO, key)).toBe(true);
    const successorPresent = existsSync(successorPath);
    expect(isAdvanceMarkerStale({ applied: true, successorPresent })).toBe(false);
  });
});

// ─── T3: Re-arm is one-shot ──────────────────────────────────────────────────
describe("re-arm is one-shot — retraction clears the gate for the normal dispatch path", () => {
  test("after retractAdvanceMarkersInto, isAdvanceAlreadyApplied returns false", () => {
    writePredecessor();
    const key = edgeKey();
    recordAdvanceApplied(orchDir, TICKET, FROM, TO, key);
    expect(isAdvanceAlreadyApplied(orchDir, TICKET, FROM, TO, key)).toBe(true);

    // Re-arm: retract the stale marker
    retractAdvanceMarkersInto(orchDir, TICKET, TO);

    // Next tick takes the normal path — guard is open
    expect(isAdvanceAlreadyApplied(orchDir, TICKET, FROM, TO, key)).toBe(false);
  });
});

// ─── T4–T5: Behavioral sweep ────────────────────────────────────────────────
//
// Models the NEW suppression logic in schedulerTick:
//   if applied AND !successorPresent → re-arm (retract + fall-through to dispatch)
//   if applied AND successorPresent  → suppress (genuine duplicate)
//   if !applied                      → advance (normal path)
//
// Successful dispatch: creates successor signal + records new marker. This is the
// same two-sided property CTL-2024's clear-stall-advance-reentry.test.mjs asserts:
// "re-derives exactly once across N ticks" (a fix that stopped writing markers
// would pass a weak re-entry test but produce a replay storm here).
describe("CTL-2113 — stale-marker re-arm: two-sided behavioral sweep", () => {
  // Simulates one tick of the new schedulerTick suppression block.
  // On the re-arm path it also simulates a successful dispatch (creates the
  // successor signal and records the marker), so a second re-arm cannot fire.
  function tick() {
    const key = edgeKey();
    const applied = isAdvanceAlreadyApplied(orchDir, TICKET, FROM, TO, key);
    if (applied) {
      const successorPresent = existsSync(successorPath);
      if (isAdvanceMarkerStale({ applied, successorPresent })) {
        // Re-arm path: retract the stale marker, then fall through to dispatch.
        retractAdvanceMarkersInto(orchDir, TICKET, TO);
        // Simulate dispatchAndVerify success: successor created + marker re-recorded.
        writeSuccessor();
        recordAdvanceApplied(orchDir, TICKET, FROM, TO, key);
        return true;
      }
      return false; // suppress — genuine idempotent duplicate
    }
    // Normal advance path (no marker yet).
    recordAdvanceApplied(orchDir, TICKET, FROM, TO, key);
    writeSuccessor();
    return true;
  }

  test("⛔ THE WEDGE, reproduced: marker present + successor absent → always suppressed (positive control)", () => {
    // Positive control: without the re-arm, the stale marker permanently suppresses.
    // This asserts the PREMISE of CTL-2113; the fix makes only the stale path
    // re-arm, so if this test breaks, the premise no longer holds and the fix is
    // solving a different problem.
    writePredecessor();
    const key = edgeKey();
    recordAdvanceApplied(orchDir, TICKET, FROM, TO, key);
    deleteSuccessor(); // CTL-695 wedge: successor deleted, marker not retracted
    expect(isAdvanceAlreadyApplied(orchDir, TICKET, FROM, TO, key)).toBe(true);
    // Without the fix (isAdvanceMarkerStale absent), every tick suppresses.
    const rawWouldAdvance = () => !isAdvanceAlreadyApplied(orchDir, TICKET, FROM, TO, key);
    let rawAdvances = 0;
    for (let i = 0; i < 16; i++) if (rawWouldAdvance()) rawAdvances++;
    expect(rawAdvances).toBe(0); // ⛔ stuck forever without the fix
  });

  test("⭐ 16 ticks after CTL-695 wedge: re-arm fires EXACTLY ONCE, never a replay storm", () => {
    writePredecessor();
    // The normal initial advance — creates the marker and the successor.
    expect(tick()).toBe(true); // advance into `research`
    // Simulate CTL-695 failure-path: successor deleted, marker left behind.
    deleteSuccessor();
    // Verify the wedge shape is in place (positive control for the re-arm).
    expect(isAdvanceAlreadyApplied(orchDir, TICKET, FROM, TO, edgeKey())).toBe(true);
    expect(existsSync(successorPath)).toBe(false);

    // Drive 16 ticks with the new suppression logic.
    let advances = 0;
    for (let i = 0; i < 16; i++) if (tick()) advances++;
    expect(advances).toBe(1); // ⭐ re-arm fires exactly once
  });

  test("⭐ after the re-arm: successor present → marker suppresses genuinely (no second re-arm)", () => {
    writePredecessor();
    tick(); // initial advance
    deleteSuccessor(); // CTL-695 wedge
    tick(); // re-arm tick (1 advance, creates successor)
    // Now: marker present AND successor present → genuine idempotent duplicate.
    let suppressedCount = 0;
    for (let i = 0; i < 16; i++) {
      if (!tick()) suppressedCount++;
    }
    expect(suppressedCount).toBe(16); // ⭐ all suppressed — re-arm was one-shot
  });

  test("⭐ CTL-1805 regression: an UNCLEARED (non-stale) edge still suppresses every replay", () => {
    // The regression guard. A non-stale marker (successor present) must never
    // be re-armed. If this count becomes > 1, the CTL-1805 storm protection is broken.
    writePredecessor();
    let advances = 0;
    for (let i = 0; i < 16; i++) if (tick()) advances++;
    expect(advances).toBe(1); // normal case: advance once, then suppress forever
  });

  test("⭐ a legitimate re-advance at a newer predecessor generation bypasses the guard entirely", () => {
    // A CTL-1660 backward re-dispatch presents a DIFFERENT key → not applied → advance.
    // The stale check never fires because the marker's key doesn't match.
    writePredecessor();
    tick(); // initial advance, generation 1
    writeSuccessor();
    const newerKey = computeAdvanceEdgeKey({
      ticket: TICKET,
      from: FROM,
      to: TO,
      predRaw: { ...PRED_RAW, generation: 2 },
    });
    expect(isAdvanceAlreadyApplied(orchDir, TICKET, FROM, TO, newerKey)).toBe(false);
  });
});
