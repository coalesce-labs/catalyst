// clear-stall-advance-reentry.test.mjs — CTL-2024.
//
// A CLEARED STALL COULD NEVER RE-ENTER ITS PHASE.
//
// The stall-janitor's unstick deletes the successor's `phase-<to>.json` and its own
// header comment promises this "lets deriveAdvancement re-derive the next phase on the
// next tick". It re-derived. Then CTL-1805's advance guard suppressed the entire
// fanout — because that guard's edge key is computed from the PREDECESSOR signal
// (`phase-<from>.json`), which the unstick does not touch. Unchanged key → the marker
// written before the stall still matches byte-for-byte → suppressed. Forever.
//
// MEASURED ON mini, 2026-08-18 (the numbers these tests encode):
//   CTC-427  plan→implement    16 suppressed-duplicate advances after a janitor clear
//   CTC-55   research→plan     16
//   CTC-441  implement→verify   1  ⭐ never cleared — the control that says 16 is not
//                                    the normal idempotent case, 1 is.
//
// ⚠️ THE TWO-SIDED PROPERTY, and why "the marker is gone" would be a WEAK test.
// Retraction must un-stick the ticket WITHOUT re-opening CTL-1805, whose whole reason
// for existing is a 13-replay storm in 55 s. So the assertion is not "it advances
// again", it is "it advances again EXACTLY ONCE across a 16-tick sweep" — the same
// sweep length that produced the measured 16. A fix that simply stopped writing
// markers would pass a re-entry test and fail this one.
//
// CI-INCLUDED (registered in .github/workflows/execution-core-tests.yml).
//
// Run: cd plugins/dev/scripts/execution-core && bun test clear-stall-advance-reentry.test.mjs

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  advanceMarkerName,
  advanceMarkerPath,
  computeAdvanceEdgeKey,
  isAdvanceAlreadyApplied,
  recordAdvanceApplied,
  retractAdvanceMarkersInto,
} from "./advance-guard.mjs";
import { defaultClearStall } from "./scheduler.mjs";

// The real CTC-427 shape: a plan→implement edge whose predecessor never changes.
const TICKET = "CTC-427";
const FROM = "plan";
const TO = "implement";
const PRED_RAW = { generation: 1, updatedAt: "2026-08-18T13:10:00Z" };

let orchDir;
let workerDir;
let removals;

beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "ctl2024-reentry-"));
  workerDir = join(orchDir, "workers", TICKET);
  mkdirSync(workerDir, { recursive: true });
  removals = [];
});
afterEach(() => rmSync(orchDir, { recursive: true, force: true }));

const writeStatus = {
  removeLabel: (...args) => {
    removals.push(args);
    return { removed: true };
  },
};
const clear = (phase = TO) => defaultClearStall(orchDir, writeStatus)({ ticket: TICKET, phase });

// The predecessor signal the guard keys on. NOTHING in the clear path touches this
// file — that is the entire defect, so the test never touches it either.
const writePredecessor = () =>
  writeFileSync(join(workerDir, `phase-${FROM}.json`), JSON.stringify(PRED_RAW));
// The synthetic stalled signal the janitor deletes (its step 1, "the unstick").
const writeStalledSignal = () =>
  writeFileSync(join(workerDir, `phase-${TO}.json`), JSON.stringify({ status: "stalled" }));

const edgeKey = () =>
  computeAdvanceEdgeKey({ ticket: TICKET, from: FROM, to: TO, predRaw: PRED_RAW });

// The scheduler's guard decision, distilled: would this tick dispatch the advance?
// Mirrors the `isAdvanceAlreadyApplied(...) → continue` chokepoint in schedulerTick.
const wouldAdvance = () => !isAdvanceAlreadyApplied(orchDir, TICKET, FROM, TO, edgeKey());
const applyAdvance = () => recordAdvanceApplied(orchDir, TICKET, FROM, TO, edgeKey());

// One tick of the sweep: advance iff the guard allows, recording the marker on success
// exactly as the dv.ok branch does. Returns whether it advanced.
const tick = () => {
  if (!wouldAdvance()) return false;
  applyAdvance();
  return true;
};

describe("CTL-2024 — a cleared stall re-enters its phase, exactly once", () => {
  test("⛔ THE DEFECT, reproduced: the predecessor key survives the unstick, so the guard still matches", () => {
    // This is the positive control for the whole ticket. It asserts the MECHANISM
    // (an unchanged predecessor ⇒ a byte-identical key ⇒ a matching marker), which is
    // true with or without the fix — the fix removes the marker, it does not change
    // the key. If this ever fails, the premise of CTL-2024 has changed and the
    // retraction below is solving a problem that no longer exists.
    writePredecessor();
    applyAdvance();
    const keyBefore = edgeKey();
    writeStalledSignal();
    rmSync(join(workerDir, `phase-${TO}.json`), { force: true }); // the unstick, alone
    expect(edgeKey()).toBe(keyBefore); // ⛔ the successor's death changes nothing
    expect(isAdvanceAlreadyApplied(orchDir, TICKET, FROM, TO, keyBefore)).toBe(true);
  });

  test("⭐ 16 ticks after a janitor clear advance EXACTLY ONCE (measured: 0 before the fix, 16 suppressed)", () => {
    writePredecessor();
    expect(tick()).toBe(true); // the original advance into `implement`
    writeStalledSignal(); // ... which then stalls (529 exhaustion, per CTL-2015)

    expect(clear()).toBe(true); // the janitor's clear — steps 1..7

    // The sweep that measured 16 on mini. Before the fix every one of these is
    // suppressed and the count is 0; a marker-less "fix" would make it 16.
    let advances = 0;
    for (let i = 0; i < 16; i++) if (tick()) advances++;
    expect(advances).toBe(1);
  });

  test("⭐ the re-entry is durable across the daemon restart the marker exists to survive", () => {
    // The marker is file-backed precisely so a restart cannot replay the edge. Re-entry
    // must inherit that property: after the one re-advance, a fresh guard read (no
    // in-process state at all) still suppresses.
    writePredecessor();
    tick();
    writeStalledSignal();
    clear();
    expect(tick()).toBe(true);
    // Nothing in-process carries over; every read below hits the disk fresh.
    expect(isAdvanceAlreadyApplied(orchDir, TICKET, FROM, TO, edgeKey())).toBe(true);
    expect(existsSync(advanceMarkerPath(orchDir, TICKET, FROM, TO))).toBe(true);
  });

  test("⛔ a SECOND stall+clear re-enters again — the janitor is not a one-shot", () => {
    // CTC-427 stalled more than once. A retraction that only worked on the first clear
    // would look correct in a single-episode test and strand the ticket on episode two.
    writePredecessor();
    tick();
    for (let episode = 0; episode < 3; episode++) {
      writeStalledSignal();
      expect(clear()).toBe(true);
      expect(tick()).toBe(true); // re-enters
      expect(tick()).toBe(false); // and is immediately idempotent again
    }
  });
});

describe("CTL-2024 — the retraction's blast radius", () => {
  test("⛔ NEAR MISS: retracting `merge` must not match `-to-monitor-merge.applied`", () => {
    // The `-to-` infix is the anchor that makes this safe. Without it, a suffix match on
    // the bare phase name silently retracts a longer phase's marker and re-opens the
    // CTL-1805 storm on an edge nobody cleared.
    const decoy = advanceMarkerName("pr", "monitor-merge");
    writeFileSync(join(workerDir, decoy), JSON.stringify({ key: "decoy" }));
    expect(retractAdvanceMarkersInto(orchDir, TICKET, "merge")).toEqual([]);
    expect(existsSync(join(workerDir, decoy))).toBe(true);
    // ... and the exact-phase retraction DOES match it — the other half of the control,
    // without which an inert matcher would also pass the assertion above.
    expect(retractAdvanceMarkersInto(orchDir, TICKET, "monitor-merge")).toEqual([decoy]);
    expect(existsSync(join(workerDir, decoy))).toBe(false);
  });

  test("⛔ only edges INTO the cleared phase are retracted — unrelated markers survive", () => {
    writePredecessor();
    const intoImplement = advanceMarkerName(FROM, TO);
    const unrelated = advanceMarkerName("implement", "verify");
    const alsoIntoImplement = advanceMarkerName("remediate", TO); // the CTL-653 detour edge
    for (const n of [intoImplement, unrelated, alsoIntoImplement]) {
      writeFileSync(join(workerDir, n), JSON.stringify({ key: `k-${n}` }));
    }
    writeStalledSignal();
    clear();
    const left = readdirSync(workerDir).filter((n) => n.startsWith(".advance-"));
    expect(left).toEqual([unrelated]); // ⭐ the downstream edge is untouched
  });

  test("⛔ the janitor's OTHER phases retract their own edge, not `implement`'s", () => {
    const intoImplement = advanceMarkerName(FROM, TO);
    writeFileSync(join(workerDir, intoImplement), JSON.stringify({ key: "k" }));
    writeFileSync(join(workerDir, `phase-verify.json`), JSON.stringify({ status: "stalled" }));
    writePredecessor();
    clear("verify");
    expect(existsSync(join(workerDir, intoImplement))).toBe(true);
  });

  test("a missing worker dir returns [] and never throws (fail direction: leave, don't storm)", () => {
    expect(retractAdvanceMarkersInto(orchDir, "NO-SUCH-TICKET", TO)).toEqual([]);
  });

  test("an unremovable marker is reported as NOT retracted rather than claimed", () => {
    writeFileSync(join(workerDir, advanceMarkerName(FROM, TO)), JSON.stringify({ key: "k" }));
    const out = retractAdvanceMarkersInto(orchDir, TICKET, TO, {
      rmSync: () => {
        throw new Error("EPERM");
      },
    });
    expect(out).toEqual([]); // the caller logs what it DID, not what it attempted
  });
});

describe("CTL-2024 — CTL-1805's storm property is preserved", () => {
  test("⭐ CTC-441's control: an UNCLEARED edge still suppresses every replay (1 advance in 16)", () => {
    // The regression guard on the fix itself. CTC-441 was never cleared and emitted a
    // single suppression — the normal idempotent case. If retraction ever leaked into
    // the ordinary tick path, this count becomes 16 and CTL-1805 is undone.
    writePredecessor();
    let advances = 0;
    for (let i = 0; i < 16; i++) if (tick()) advances++;
    expect(advances).toBe(1);
  });

  test("a legitimate re-advance at a NEWER predecessor generation is still allowed", () => {
    // Unchanged CTL-1805 behaviour, asserted here because the retraction sits on the
    // same seam: a differing key must pass the guard without any clear at all.
    writePredecessor();
    tick();
    const newerKey = computeAdvanceEdgeKey({
      ticket: TICKET,
      from: FROM,
      to: TO,
      predRaw: { ...PRED_RAW, generation: 2 },
    });
    expect(isAdvanceAlreadyApplied(orchDir, TICKET, FROM, TO, newerKey)).toBe(false);
  });
});
