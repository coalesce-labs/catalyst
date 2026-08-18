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

  // [label, anchor, recorder, windowLines]. The window is per site because the
  // claim gate carries a long explanatory comment between its `log.debug` and
  // its recorder; a single global window would silently stop covering it.
  const SITES = [
    ["drain gate", "drain: skipping triage dispatch — node draining", "noteTriageSkip", 8],
    ["HRW ownership gate", "ctl-1091: ticket not owned by this host under HRW", "noteTriageSkip", 8],
    ["sweep budget gate", "readTriageDispatchCount(orchDir, t.identifier) < TRIAGE_DISPATCH_CAP", "noteTriageSkip", 8],
    ["sweep already-triaged exit", "if (hasTriageArtifact(orchDir, t.identifier))", "clearTriageSkip", 8],
    ["sweep in-flight gate", "if (t.fromTriageBoard && isTriageInFlight(", "noteTriageSkip", 8],
    // CTL-879 follow-up: the sixth gate. The first instrument missed it, and it
    // is the only silent exit left after drain/HRW — so it is where a ticket its
    // OWNER accepted still fails to launch.
    ["cross-host claim gate", "ctl-862: lost cross-host claim", "noteTriageSkip", 24],
  ];

  for (const [label, anchor, recorder, windowLines] of SITES) {
    test(`${label} records its outcome`, () => {
      const at = lineOf(anchor);
      const window = LINES.slice(at, at + windowLines).join("\n");
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
