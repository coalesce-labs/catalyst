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
  triageSkipSeverity,
  triageBudgetSkip,
  triageSkipWarnMessage,
  TRIAGE_SKIP_WARN_MESSAGES,
} from "./monitor.mjs";
import { CLAIM_REASON, isClaimFailure } from "./cluster-claim-sync.mjs";
// The SAME logger object monitor.mjs imports — module bindings share the instance, so
// replacing a method here is observed there. This is how the emitted SENTENCE is captured
// without parsing stdout (which would test whichever logger the environment installed).
import { log } from "./config.mjs";

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
    // CTL-879/INIT-34 grew the explanatory block between this anchor and its recorder,
    // and an 8-line window stopped covering the site — the same drift CTL-2033 hit two
    // rows down. Sized with headroom rather than to the current exact distance.
    ["sweep budget gate", "readTriageDispatchCount(orchDir, t.identifier) < TRIAGE_DISPATCH_CAP", "noteTriageSkip", 20],
    // ⛔ And the gate must CONSULT the two-mechanism discriminator, exactly as the claim
    // gate below must consult isClaimFailure. Without this row the site could record one
    // reason for both a busy fleet and a fail-closed hold — which is the pre-change
    // behaviour, and the whole defect.
    ["sweep budget gate discriminates", "readTriageDispatchCount(orchDir, t.identifier) < TRIAGE_DISPATCH_CAP", "triageBudgetSkip(budget)", 20],
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
    // The pure rule is only worth testing if the recorder actually consults it.
    ["noteTriageSkip routes through the pure severity rule", "const context = { ticket: identifier, reason, held_sweeps: streak", "triageSkipSeverity(streak", 4, 6],
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

// ⛔ THE SEVERITY IS TESTED THROUGH A PURE FUNCTION, NOT THROUGH THE LOGGER.
// The first version of these cases captured `process.stdout/stderr.write` and
// matched config.mjs's console-shim prefix `[execution-core:<level>]`. That
// passed locally — pino is not a dependency of this repo — and FAILED in CI,
// where pino IS installed and emits `{"level":40,...}` JSON through a
// destination it captured at construction, so the monkeypatch saw nothing.
// A severity rule asserted through whichever logger happens to be installed is
// a test of the environment. `triageSkipSeverity` is the rule itself.

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

  test("a normal skip is INFO on its first sweep", () => {
    expect(triageSkipSeverity(1, { alwaysWarn: false })).toBe("info");
  });

  test("a FAILED claim warns on sweep ONE — not after TRIAGE_SKIP_ESCALATE_AFTER sweeps", () => {
    // At the measured 5-10 min sweep cadence, waiting for the streak escalation
    // is 75-150 minutes of silence on a condition that is abnormal immediately.
    expect(triageSkipSeverity(1, { alwaysWarn: true })).toBe("warn");
  });

  test("alwaysWarn raises SEVERITY, never FREQUENCY — the sparse gate still bounds the write", () => {
    // Sweeps 2..9 are neither first, periodic, nor the escalation edge, so a
    // 20-candidate sweep on a budget-exhausted host cannot flood the log.
    for (let streak = 2; streak <= 9; streak++) {
      expect(triageSkipSeverity(streak, { alwaysWarn: true })).toBeNull();
      expect(triageSkipSeverity(streak, { alwaysWarn: false })).toBeNull();
    }
    // ...and the sweeps that ARE written are written for both.
    for (const streak of [1, 10, 15, 20]) {
      expect(triageSkipSeverity(streak, { alwaysWarn: true })).not.toBeNull();
    }
  });

  test("the persistence escalation still wins on its own, with or without alwaysWarn", () => {
    // A long streak is a WARN even for a normal lost race — the pre-existing
    // CTL-879 ladder, which this change must not have removed.
    expect(triageSkipSeverity(15, { alwaysWarn: false })).toBe("warn");
    expect(triageSkipSeverity(20, { alwaysWarn: false })).toBe("warn");
  });

  test("noteTriageSkip still returns the streak and still never throws", () => {
    expect(noteTriageSkip("CTL-A", "lost-cross-host-claim", { claim_reason: CLAIM_REASON.PEER_WON })).toBe(1);
    expect(() =>
      noteTriageSkip("CTL-B", "claim-write-failed", { claim_reason: CLAIM_REASON.BUDGET_REFUSED }, { alwaysWarn: true }),
    ).not.toThrow();
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


// ── CTL-879 / INIT-34: `remaining: 0` had two producers and one observable ──────
//
// `computeTriageBudget` answers 0 from the fail-closed yielded-occupancy hold AND from
// genuine capacity. Their prognoses are OPPOSITE — capacity is recomputed every sweep and
// frees itself when a worker finishes; the hold NEVER clears on its own — yet both printed
// the identical `sweep-budget-exhausted / budget_remaining: 0`. An operator could not tell
// a busy fleet from a host that will produce no triage.json for the rest of the night.
//
// ⛔ WHAT EACH LAYER HERE PROVES, STATED PLAINLY. `sweepMissingTriage` cannot be driven
// without the project registry and the eligible set, and `dispatchTriage` is not exported —
// so there is no way to observe the sweep's call directly. Instead the decision was
// EXTRACTED into `triageBudgetSkip`, which these tests exercise as ordinary code, and the
// single-source test below pins that the reason literals exist nowhere else in monitor.mjs,
// so no call site can hand-roll one past this function. That is a real constraint, not a
// mention-scan: it fails if someone re-inlines the ternary.
describe("triageBudgetSkip — the two zero-budget mechanisms", () => {
  test("⭐ a HELD budget gets its own reason, the held reason, and warns immediately", () => {
    const s = triageBudgetSkip({ remaining: 0, held: true, heldReason: "workers/ unreadable: EACCES" });
    expect(s.reason).toBe("sweep-budget-held-scan-failed");
    expect(s.detail).toEqual({ budget_remaining: 0, held_reason: "workers/ unreadable: EACCES" });
    expect(s.alwaysWarn).toBe(true);
  });

  test("⛔ capacity-zero keeps the pre-existing reason and does NOT warn immediately", () => {
    const s = triageBudgetSkip({ remaining: 0, held: false, heldReason: null });
    expect(s.reason).toBe("sweep-budget-exhausted");
    expect(s.detail).toEqual({ budget_remaining: 0 });
    expect(s.alwaysWarn).toBe(false);
    // ⛔ and it carries NO held_reason key — a null one would render in Loki as a held
    // budget with an unknown cause, which is the confusion this change removes.
    expect("held_reason" in s.detail).toBe(false);
  });

  test("a budget from a caller that predates `held` reads as healthy, never as held", () => {
    // sweepMissingTriage's sibling call site accepts an INJECTED budget; an older shape
    // must keep its exact previous behaviour rather than silently escalating.
    for (const b of [{ remaining: 0 }, { remaining: 3 }, {}, undefined, null]) {
      expect(triageBudgetSkip(b).reason).toBe("sweep-budget-exhausted");
      expect(triageBudgetSkip(b).alwaysWarn).toBe(false);
    }
  });

  test("only the boolean true holds — a truthy value is not a hold", () => {
    for (const held of ["true", 1, {}, []]) {
      expect(triageBudgetSkip({ remaining: 0, held }).reason).toBe("sweep-budget-exhausted");
    }
  });

  test("⭐ the two reasons produce DIFFERENT severities on sweep 1 — the answer changes, not just the label", () => {
    const held = triageBudgetSkip({ remaining: 0, held: true, heldReason: "x" });
    const busy = triageBudgetSkip({ remaining: 0, held: false });
    // This is the composition that matters: alwaysWarn is only meaningful if it reaches
    // triageSkipSeverity and changes what comes out on the very first sweep.
    expect(triageSkipSeverity(1, { alwaysWarn: held.alwaysWarn })).toBe("warn");
    expect(triageSkipSeverity(1, { alwaysWarn: busy.alwaysWarn })).not.toBe("warn");
  });

  test("the two reasons keep SEPARATE streaks — a host flipping between them does not read as one episode", () => {
    _resetTriageSkipStreaks();
    const held = triageBudgetSkip({ remaining: 0, held: true, heldReason: "x" }).reason;
    const busy = triageBudgetSkip({ remaining: 0, held: false }).reason;
    expect(noteTriageSkip("CTL-1", busy)).toBe(1);
    expect(noteTriageSkip("CTL-1", busy)).toBe(2);
    // Switching mechanism must RESET the streak — the escalation sentence claims
    // persistence of one cause, and it would be a false statement across a switch.
    expect(noteTriageSkip("CTL-1", held)).toBe(1);
  });
});

describe("the reason literals have exactly one home", () => {
  // ⛔ This is the wiring half, and it is a CONSTRAINT rather than a mention-scan: if the
  // ternary is ever re-inlined at a call site, that literal appears a second time and this
  // fails. It does not prove the sweep calls triageBudgetSkip — nothing available here can —
  // but it does prove no OTHER code can emit these reasons behind its back.
  const src = readFileSync(join(import.meta.dirname, "monitor.mjs"), "utf8");
  // ⛔ The reason strings legitimately have TWO homes: `triageBudgetSkip`, which PRODUCES
  // them, and TRIAGE_SKIP_WARN_MESSAGES, which is KEYED by them. The registry is a lookup
  // table, not a call site, so it is excised before counting rather than being allowed to
  // relax the count to "2" — a bare `toBe(2)` would then silently accept a genuine
  // hand-rolled third occurrence at a call site.
  const registryStart = src.indexOf("export const TRIAGE_SKIP_WARN_MESSAGES");
  const registryEnd = src.indexOf("});", registryStart) + 3;
  const outsideRegistry = src.slice(0, registryStart) + src.slice(registryEnd);
  test("the registry block was actually located (else the excision is a no-op)", () => {
    // Positive control: without this, a renamed registry would make every count below
    // pass for the wrong reason.
    expect(registryStart).toBeGreaterThan(-1);
    expect(registryEnd).toBeGreaterThan(registryStart);
    expect(src.length - outsideRegistry.length).toBeGreaterThan(100);
  });
  for (const literal of ['"sweep-budget-held-scan-failed"', '"sweep-budget-exhausted"']) {
    test(`${literal} appears exactly once outside the message registry`, () => {
      expect(outsideRegistry.split(literal).length - 1).toBe(1);
    });
  }
  test("...and both occurrences are inside triageBudgetSkip", () => {
    const start = src.indexOf("export function triageBudgetSkip");
    const end = src.indexOf("\n}", src.indexOf("return { reason: \"sweep-budget-exhausted\""));
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, end);
    expect(body).toContain('"sweep-budget-held-scan-failed"');
    expect(body).toContain('"sweep-budget-exhausted"');
  });
});


// ── Codex P2 on #3682: the first-sweep WARN sentence must match the REASON ───────
//
// ⛔ `alwaysWarn` was introduced by CTL-2033 when the claim failure was its only caller, so
// the branch it selects hardcoded that cause. The moment CTL-2047's scan hold set
// `alwaysWarn`, it inherited "the cross-host claim never landed … read claim_reason" — a
// confident, specific, WRONG attribution, pointing at a `claim_reason` its payload does not
// even carry. That is worse than the ambiguity CTL-2047 removes: an operator can act on
// "I cannot tell"; they cannot act on a misattribution.
//
// ⚠️ MY OWN TESTS MISSED THIS. They asserted `alwaysWarn === true` and that
// triageSkipSeverity(1, {alwaysWarn:true}) is "warn" — the SEVERITY — and never once looked
// at the SENTENCE that severity selects. Pinning a flag is not pinning the output.
describe("triageSkipWarnMessage — the sentence follows the reason", () => {
  test("each registered reason gets its OWN sentence, and they are distinct", () => {
    const claim = triageSkipWarnMessage("claim-write-failed");
    const held = triageSkipWarnMessage("sweep-budget-held-scan-failed");
    expect(claim).not.toBe(held);
    expect(claim).toContain("cross-host claim never landed");
    expect(claim).toContain("claim_reason");
    expect(held).toContain("yielded-occupancy scan failed host-wide");
    expect(held).toContain("held_reason");
  });

  test("⛔ the scan hold must NEVER be described as a claim failure", () => {
    const held = triageSkipWarnMessage("sweep-budget-held-scan-failed");
    expect(held).not.toContain("cross-host claim");
    expect(held).not.toContain("claim_reason");
    // It must also say the thing an operator needs: this is not a busy fleet.
    expect(held).toContain("does NOT refill");
  });

  test("an UNREGISTERED reason gets a vague-but-true default, never a concrete cause", () => {
    const d = triageSkipWarnMessage("some-future-reason");
    expect(d).not.toContain("cross-host claim");
    expect(d).not.toContain("yielded-occupancy");
    // It must point the reader at the field that actually distinguishes.
    expect(d).toContain("reason");
    // …and every unregistered reason gets the same default, so this cannot silently
    // become a per-reason guess.
    expect(triageSkipWarnMessage("another-one")).toBe(d);
    expect(triageSkipWarnMessage(undefined)).toBe(d);
  });

  test("every reason that triageBudgetSkip flags alwaysWarn HAS a registered sentence", () => {
    // The rule that keeps the default from being reached in production: if a producer
    // raises severity, it owes the reader an explanation.
    const held = triageBudgetSkip({ remaining: 0, held: true, heldReason: "x" });
    expect(held.alwaysWarn).toBe(true);
    expect(Object.keys(TRIAGE_SKIP_WARN_MESSAGES)).toContain(held.reason);
  });
});

describe("the claim sentence has exactly one home", () => {
  // Same constraint as the reason literals: if the warn branch ever hardcodes a cause
  // again, that sentence appears twice and this fails.
  test("'the cross-host claim never landed' appears once in monitor.mjs", () => {
    const src = readFileSync(join(import.meta.dirname, "monitor.mjs"), "utf8");
    expect(src.split("the cross-host claim never landed").length - 1).toBe(1);
  });
});


describe("noteTriageSkip EMITS the reason-specific sentence", () => {
  // ⛔⛔ THE MUTATION THAT SURVIVED EVERYTHING ELSE. With the pure selector fully tested and
  // the literals single-homed, reverting the warn branch to
  // `log.warn(context, TRIAGE_SKIP_WARN_MESSAGES["claim-write-failed"])` — i.e. exactly the
  // pre-fix misattribution — still passed 45/45. Every test proved the selector was CORRECT
  // and none proved it was CALLED. That is "asserting a discriminator is READ is not
  // asserting the answer CHANGES", one level up from where it was caught before, in the fix
  // for a defect of that same shape.
  const capture = (fn) => {
    const seen = [];
    const orig = log.warn;
    log.warn = (ctx, msg) => seen.push({ ctx, msg });
    try {
      fn();
    } finally {
      log.warn = orig; // restored in `finally` — a leaked stub silently mutes every later suite
    }
    return seen;
  };

  test("the scan hold emits the HOLD sentence, not the claim one", () => {
    _resetTriageSkipStreaks();
    const seen = capture(() =>
      noteTriageSkip("CTL-H", "sweep-budget-held-scan-failed", { held_reason: "EACCES" }, { alwaysWarn: true })
    );
    expect(seen.length).toBe(1);
    expect(seen[0].msg).toContain("yielded-occupancy scan failed host-wide");
    expect(seen[0].msg).not.toContain("cross-host claim");
    expect(seen[0].ctx.held_reason).toBe("EACCES");
  });

  test("the claim failure still emits the CLAIM sentence — the fix must not break the first caller", () => {
    _resetTriageSkipStreaks();
    const seen = capture(() =>
      noteTriageSkip("CTL-C", "claim-write-failed", { claim_reason: "cli-failed" }, { alwaysWarn: true })
    );
    expect(seen.length).toBe(1);
    expect(seen[0].msg).toContain("cross-host claim never landed");
    expect(seen[0].ctx.claim_reason).toBe("cli-failed");
  });

  test("the two callers get DIFFERENT sentences from the same code path", () => {
    _resetTriageSkipStreaks();
    const held = capture(() => noteTriageSkip("CTL-H", "sweep-budget-held-scan-failed", {}, { alwaysWarn: true }));
    _resetTriageSkipStreaks();
    const claim = capture(() => noteTriageSkip("CTL-C", "claim-write-failed", {}, { alwaysWarn: true }));
    expect(held[0].msg).not.toBe(claim[0].msg);
  });
});
