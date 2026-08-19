// triage-admission-observability.test.mjs — CTL-879.
//
// A ready ticket that lacks triage.json is held by the scheduler's ctl-1150
// gate, and the ONLY producer of that artifact is the triage admission path in
// monitor.mjs. On 2026-08-18 that path stopped producing fleet-wide at 15:00 CT
// and NOTHING recorded why: three bare `continue`s in sweepMissingTriage and two
// `log.debug` returns in dispatchTriage. Over the next three hours both hosts
// logged 315 sweep-source lines, ~4,000 ctl-1150 hold lines and 411 "board
// appears frozen" warnings — and ZERO dispatchTriage lines at any severity.
//
// ⚠️ THIS FILE IS DELIBERATELY NOT IN monitor.test.mjs. That suite is excluded
// from the CI allowlist (see the workflow's exclusion comment and CTL-1809's
// note: "because monitor.test.mjs is excluded, a monitor case added there would
// never run here"). A guard for a blindness defect that itself never runs would
// be the same defect one level up. This file is registered in the stable list.
//
// Run: cd plugins/dev/scripts/execution-core && bun test triage-admission-observability.test.mjs

import { describe, test, expect, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  noteTriageSkip,
  clearTriageSkip,
  pruneTriageSkips,
  _resetTriageSkipStreaks,
} from "./monitor.mjs";
import { CLAIM_REASON, isClaimFailure } from "./cluster-claim-sync.mjs";

beforeEach(() => _resetTriageSkipStreaks());

describe("CTL-879 streak accounting", () => {
  test("the same reason accumulates; a DIFFERENT reason starts a new episode", () => {
    expect(noteTriageSkip("CTL-1", "sweep-budget-exhausted")).toBe(1);
    expect(noteTriageSkip("CTL-1", "sweep-budget-exhausted")).toBe(2);
    // A changed reason is a different fault; resuming the old count would
    // escalate on evidence about a condition that no longer holds.
    expect(noteTriageSkip("CTL-1", "node-draining")).toBe(1);
  });

  test("streaks are per ticket, not global", () => {
    noteTriageSkip("CTL-1", "node-draining");
    noteTriageSkip("CTL-1", "node-draining");
    expect(noteTriageSkip("CTL-2", "node-draining")).toBe(1);
  });

  test("clearTriageSkip ends the episode so the next block logs its FIRST line", () => {
    noteTriageSkip("CTL-1", "node-draining");
    noteTriageSkip("CTL-1", "node-draining");
    clearTriageSkip("CTL-1");
    expect(noteTriageSkip("CTL-1", "node-draining")).toBe(1);
  });

  test("never throws on hostile input — an observability helper must not break admission", () => {
    expect(() => noteTriageSkip(undefined, undefined)).not.toThrow();
    expect(() => noteTriageSkip("CTL-1", "r", null)).not.toThrow();
    expect(() => clearTriageSkip(undefined)).not.toThrow();
  });
});

describe("CTL-879 prune (CAT-36's bug, avoided rather than repeated)", () => {
  test("drops tickets this sweep did not consider, keeps the ones it did", () => {
    noteTriageSkip("CTL-1", "node-draining");
    noteTriageSkip("CTL-2", "node-draining");
    pruneTriageSkips(new Set(["CTL-1"]));
    // CTL-1 survived → its streak continues.
    expect(noteTriageSkip("CTL-1", "node-draining")).toBe(2);
    // CTL-2 was pruned → a reappearance starts a fresh episode, so the first
    // diagnostic of the NEW episode is not suppressed by a stale streak.
    expect(noteTriageSkip("CTL-2", "node-draining")).toBe(1);
  });

  test("a non-Set argument is ignored rather than wiping every streak", () => {
    noteTriageSkip("CTL-1", "node-draining");
    pruneTriageSkips(undefined);
    pruneTriageSkips(["CTL-9"]);
    expect(noteTriageSkip("CTL-1", "node-draining")).toBe(2);
  });
});

describe("CTL-879 escalation edge", () => {
  test("the crossing sweep is reached and is neither the first nor a periodic sweep", () => {
    // Guards the off-by-one that would have hidden the WARN until sweep 20:
    // with RELOG_EVERY=10 and ESCALATE_AFTER=15, sweep 15 is neither, so the
    // helper needs an explicit escalation-edge branch. If either constant moves
    // and 15 becomes periodic, this assertion tells the next author to re-check
    // that the branch still earns its place.
    const RELOG_EVERY = 10;
    const ESCALATE_AFTER = 15;
    expect(ESCALATE_AFTER % RELOG_EVERY).not.toBe(0);
    expect(ESCALATE_AFTER).not.toBe(1);
    let streak = 0;
    for (let i = 0; i < ESCALATE_AFTER; i++) streak = noteTriageSkip("CTL-1", "node-draining");
    expect(streak).toBe(ESCALATE_AFTER);
  });
});

// ── WIRING GUARD ─────────────────────────────────────────────────────────────
// The helpers above are worthless if no gate calls them — and "the helper exists
// but is unwired" is precisely the failure shape this ticket is about. The five
// sites below are the ones that recorded NOTHING on 2026-08-18. Assert each is
// still accompanied by a recorder, so a future edit cannot quietly restore the
// blindness. Anchors match on the GATE, never on the recorder, so deleting the
// recorder fails the test rather than the anchor disappearing with it.
describe("CTL-879 wiring: every blind triage-admission gate records a reason", () => {
  const SRC = readFileSync(join(import.meta.dir, "monitor.mjs"), "utf8");
  const LINES = SRC.split("\n");

  /** index of the single line containing `needle` (asserts uniqueness). */
  function lineOf(needle) {
    const hits = LINES.map((l, i) => (l.includes(needle) ? i : -1)).filter((i) => i >= 0);
    expect(hits.length).toBe(1);
    return hits[0];
  }

  // [label, anchor, recorder, after, before]. The window is per site because the
  // claim gate carries a long explanatory comment between its `log.debug` and
  // its recorder; a single global window would silently stop covering it. `before`
  // exists because CTL-2033's discriminator is READ above the gate's log line —
  // a forward-only window cannot see it, and a guard that cannot see the thing it
  // guards is the failure mode this whole file is about.
  const SITES = [
    ["drain gate", "drain: skipping triage dispatch — node draining", "noteTriageSkip", 8],
    ["HRW ownership gate", "ctl-1091: ticket not owned by this host under HRW", "noteTriageSkip", 8],
    ["sweep budget gate", "readTriageDispatchCount(orchDir, t.identifier) < TRIAGE_DISPATCH_CAP", "noteTriageSkip", 8],
    ["sweep already-triaged exit", "if (hasTriageArtifact(orchDir, t.identifier))", "clearTriageSkip", 8],
    ["sweep in-flight gate", "if (t.fromTriageBoard && isTriageInFlight(", "noteTriageSkip", 8],
    // CTL-879 follow-up: the sixth gate. The first instrument missed it, and it
    // is the only silent exit left after drain/HRW — so it is where a ticket its
    // OWNER accepted still fails to launch.
    // CTL-2033 grew the explanatory block between the anchor and the recorder by
    // six lines. The window is sized with headroom rather than to the current
    // exact distance, so the next comment does not silently un-cover the site.
    ["cross-host claim gate", "ctl-862: lost cross-host claim", "noteTriageSkip", 36],
    // CTL-2033: the gate must also CONSULT the discriminator — a recorder that
    // writes the same reason for both outcomes is the defect, one level in.
    ["cross-host claim gate discriminates", "ctl-862: lost cross-host claim", "isClaimFailure", 36, 8],
    // ⚠️ MUTATION-DRIVEN. Asserting `isClaimFailure` is READ is not enough: a gate
    // can consult the discriminator and then record the same reason either way,
    // which is the pre-CTL-2033 behaviour exactly. Mutating the gate to a single
    // literal passed all 84 tests until these two rows existed. Both literals must
    // survive in the window, so collapsing either direction fails here.
    ["claim gate keeps the FAILURE reason", "ctl-862: lost cross-host claim", '"claim-write-failed"', 36, 8],
    ["claim gate keeps the RACE reason", "ctl-862: lost cross-host claim", '"lost-cross-host-claim"', 36, 8],
    ["claim gate raises severity only for the failure", "ctl-862: lost cross-host claim", "alwaysWarn: failed", 36, 8],
  ];

  for (const [label, anchor, recorder, after, before = 0] of SITES) {
    test(`${label} records its outcome`, () => {
      const at = lineOf(anchor);
      const window = LINES.slice(Math.max(0, at - before), at + after).join("\n");
      expect(window).toContain(recorder);
    });
  }

  test("the per-sweep prune runs OUTSIDE the per-project loop", () => {
    // The streak table is keyed by ticket across ALL projects. Pruning inside
    // the loop would drop every other project's streaks on each iteration,
    // pinning every streak at 1 — the escalation could then never fire and this
    // whole guard would be present but unable to trigger.
    const prune = lineOf("pruneTriageSkips(consideredThisSweep)");
    const accumulate = lineOf("for (const id of seen) consideredThisSweep.add(id)");
    expect(prune).toBeGreaterThan(accumulate);
    // Between the accumulator and the prune there must be a closing brace at
    // the per-project loop's indentation — i.e. the loop ended first.
    const between = LINES.slice(accumulate + 1, prune);
    expect(between.some((l) => /^ {2}\}/.test(l))).toBe(true);
  });
});


// ─── CTL-2033 ────────────────────────────────────────────────────────────────
// The claim gate above records a reason — but until this ticket the reason it
// recorded was the SAME STRING whether a peer legitimately won the fence or our
// claim write never landed, because `claimDispatchSync` returned one
// `{won:false, generation:null}` for both. Measured 2026-08-18: 36 of 36 held
// tickets logged `lost-cross-host-claim` on tickets their own host OWNS under
// HRW — a race that cannot happen — with `claim_reason: null` on every line.

/**
 * captureLogLevels — read the LEVEL a log line was written at.
 *
 * ⚠️ This depends on config.mjs's console shim, which prefixes each line with
 * `[execution-core:<level>]`. pino is not a dependency of this repo, so the shim
 * is what runs under `bun test`. The suite does NOT silently degrade if that ever
 * changes: the info case below asserts a POSITIVE marker, so a world where no
 * marker is emitted fails loudly instead of passing on an unobserved branch.
 */
function captureLogLevels(fn) {
  const chunks = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = (x) => {
    chunks.push(typeof x === "string" ? x : x.toString());
    return true;
  };
  process.stderr.write = (x) => {
    chunks.push(typeof x === "string" ? x : x.toString());
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return chunks.join("");
}

describe("CTL-2033: a FAILED claim and a LOST race are different outcomes", () => {
  test("the claim result's reasons are all distinct values — none may collapse into another", () => {
    const values = Object.values(CLAIM_REASON);
    expect(values.length).toBeGreaterThanOrEqual(6);
    expect(new Set(values).size).toBe(values.length);
  });

  test("only an explicit peer-win counts as normal; an unknown or absent reason is a FAILURE", () => {
    expect(isClaimFailure(CLAIM_REASON.PEER_WON)).toBe(false);
    expect(isClaimFailure(CLAIM_REASON.WON)).toBe(false);
    expect(isClaimFailure(CLAIM_REASON.BUDGET_REFUSED)).toBe(true);
    expect(isClaimFailure(null)).toBe(true);
  });

  test("POSITIVE CONTROL: a normal skip is written at INFO on its first sweep", () => {
    const text = captureLogLevels(() => noteTriageSkip("CTL-A", "lost-cross-host-claim", { claim_reason: CLAIM_REASON.PEER_WON }));
    // If this marker is absent the capture (or the shim) is not working, and
    // every other assertion in this describe would be vacuous.
    expect(text).toContain("[execution-core:info]");
    expect(text).not.toContain("[execution-core:warn]");
  });

  test("a FAILED claim warns on sweep ONE — not after TRIAGE_SKIP_ESCALATE_AFTER sweeps", () => {
    // At the measured 5-10 min sweep cadence, waiting for the streak escalation
    // is 75-150 minutes of silence on a condition that is abnormal immediately.
    const text = captureLogLevels(() =>
      noteTriageSkip(
        "CTL-B",
        "claim-write-failed",
        { claim_reason: CLAIM_REASON.BUDGET_REFUSED, claim_detail: "budget:day-exhausted" },
        { alwaysWarn: true },
      ),
    );
    expect(text).toContain("[execution-core:warn]");
    expect(text).toContain("claim-write-failed");
    expect(text).toContain("budget:day-exhausted");
  });

  test("alwaysWarn raises SEVERITY, never FREQUENCY — the sparse gate still bounds the write", () => {
    // Sweeps 2..9 are neither first, periodic, nor the escalation edge, so a
    // 20-candidate sweep on a budget-exhausted host cannot flood the log.
    noteTriageSkip("CTL-C", "claim-write-failed", {}, { alwaysWarn: true }); // sweep 1 — logs
    const text = captureLogLevels(() => {
      for (let i = 2; i <= 9; i++) noteTriageSkip("CTL-C", "claim-write-failed", {}, { alwaysWarn: true });
    });
    expect(text).toBe("");
  });

  test("the two outcomes use DIFFERENT gate reasons, so a streak of one never masquerades as the other", () => {
    // A shared reason string would also merge the two into one streak, so a host
    // alternating between them would escalate on evidence about neither.
    expect(noteTriageSkip("CTL-D", "lost-cross-host-claim")).toBe(1);
    expect(noteTriageSkip("CTL-D", "lost-cross-host-claim")).toBe(2);
    expect(noteTriageSkip("CTL-D", "claim-write-failed", {}, { alwaysWarn: true })).toBe(1);
  });
});

// ── WIRING GUARD: the other two claim gates ──────────────────────────────────
// The triage gate is not the only caller of the soft-CAS. scheduler.mjs's
// new-work dispatch and recovery.mjs's dead-host takeover had the SAME
// blindness — a log.debug and a bare `continue` respectively — and a fix that
// covered only the gate we happened to be looking at would leave two silent
// stalls behind. Anchors match on the GATE, never on the recorder.
describe("CTL-2033 wiring: every claim gate reads the discriminator", () => {
  const CASES = [
    ["scheduler new-work claim", "scheduler.mjs", "ctl-850: lost cross-host claim", 8, 20],
    ["recovery takeover claim", "recovery.mjs", "Soft-CAS claim: bump generation to take ownership", 28, 0],
  ];
  for (const [label, file, anchor, after, before] of CASES) {
    test(`${label} distinguishes a failed claim from a lost race`, () => {
      const lines = readFileSync(join(import.meta.dir, file), "utf8").split("\n");
      const hits = lines.map((l, i) => (l.includes(anchor) ? i : -1)).filter((i) => i >= 0);
      expect(hits.length).toBe(1);
      const window = lines.slice(Math.max(0, hits[0] - before), hits[0] + after).join("\n");
      expect(window).toContain("isClaimFailure");
      // BOTH branches must survive: a gate that warns unconditionally is as blind
      // as one that debugs unconditionally — it just fails in the noisy direction.
      expect(window).toContain("log.warn");
      expect(window).toContain("log.debug");
    });
  }
});
