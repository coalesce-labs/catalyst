// artifact-contradiction.test.mjs — CTL-2050.
//
// Run: cd plugins/dev/scripts/execution-core && bun test artifact-contradiction.test.mjs
//
// ── WHAT THIS FILE HAS TO PROVE, AND WHY THE OBVIOUS TESTS DO NOT ────────────
//
// The feature turns a terminal `failed` back into `done`. Its whole risk is
// WIDTH: a retraction that fires on one signal too many is a way to launder any
// failure into a success, and it would look exactly like this one working. So
// "it retracts the measured case" is the EASY half and proves almost nothing on
// its own. Three things carry the weight here:
//
//   1. NEGATIVE CONTROLS IN THE SAME SWEEP. The real-failure, absent-artifact
//      and unregistered-reason tickets sit in the SAME orchDir as the one that
//      must be retracted, so a widened predicate cannot pass by touching only
//      the file the test happens to read.
//   2. THE RELEASE, NOT THE WRITE. The acceptance criterion is that the ticket
//      ADVANCES — so the e2e asserts deriveAdvancement/isTicketInFlight after
//      the sweep, against the real functions. Asserting the JSON alone would
//      pass for a `done` the FSM still refuses to move (which is what gate 2
//      does today).
//   3. MUTATION CONTROLS. Each guard is deleted in turn and the suite must go
//      RED. A guard nothing exercises is a comment. (⛔ The revert must remove
//      the GUARD and keep the TEST — reverting both measures nothing and fails
//      green; that has happened twice on this lane.)

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyArtifactContradiction,
  isRetractableFailure,
  INFRA_FAILURE_REASONS,
  INFRA_FAILURE_REASON_RULES,
  CONTRADICTION_REASONS,
  RETRACTABLE_STATUS,
  CTL_2048_PRODUCER_FIX_MS,
} from "./artifact-contradiction.mjs";
import {
  WORK_DONE_PROBES,
  WORK_DONE_PROBE_DESCRIPTIONS,
  NETWORK_BOUND_PROBE_PHASES,
  probeIsLocal,
} from "./work-done-probes.mjs";
import { defaultRetractContradictedFailure } from "./recovery.mjs";
import {
  retractContradictedFailures,
  deriveAdvancement,
  isTicketInFlight,
  readPhaseSignals,
} from "./scheduler.mjs";
import { ASSERTED_BY, classifyAdvanceEvidence, EVIDENCE } from "./assertion-evidence.mjs";

const FENCE = "cluster_fence_stale";
// The two axes added by Codex's #3690 review, defaulted here so every test below
// states only the axis it is ABOUT. Both get their own describe blocks where
// they are varied explicitly — a default that is never varied is a constant, and
// a constant cannot fail.
const IN_WINDOW = CTL_2048_PRODUCER_FIX_MS - 60_000; // a signal from before CTL-2048
const AFTER_WINDOW = CTL_2048_PRODUCER_FIX_MS + 60_000; // the producer no longer conflates
const classify = (o = {}) =>
  classifyArtifactContradiction({ writtenAtMs: IN_WINDOW, probeIsLocal: true, ...o });

const failed = (over = {}) => ({
  ticket: "CTC-239",
  phase: "triage",
  status: "failed",
  failureReason: FENCE,
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
describe("classifyArtifactContradiction — conjunct (a), the reason", () => {
  test("both conjuncts satisfied → the ONLY retracting verdict", () => {
    const v = classify({
      signal: failed(),
      hasProbe: true,
      artifactPresent: true,
    });
    expect(v).toEqual({ retract: true, reason: "contradicted", failureReason: FENCE });
  });

  test.each(INFRA_FAILURE_REASONS)("registered infra reason %s retracts", (reason) => {
    expect(
      classify({
        signal: failed({ failureReason: reason }),
        hasProbe: true,
        artifactPresent: true,
      }).retract
    ).toBe(true);
  });

  // ⛔ The core narrowness control. These are REAL failures of the phase's own
  // work; retracting any of them is the laundering the ticket forbids.
  test.each([
    "test_failed",
    "turn-cap-exhausted",
    "yield-expired",
    "escalation-ask-cap",
    "dispatch-circuit-breaker",
    "phantom-ticket",
    // near-misses on the registered strings — a substring/prefix match would pass these
    "cluster_fence",
    "cluster_fence_stale_but_not_really",
    "not_cluster_fence_stale",
    "CLUSTER_FENCE_STALE",
  ])("a real failure reason (%s) is NEVER retracted", (reason) => {
    const v = classify({
      signal: failed({ failureReason: reason }),
      hasProbe: true,
      artifactPresent: true, // artifact present and it STILL must not retract
    });
    expect(v.retract).toBe(false);
    expect(v.reason).toBe("reason-not-infra-class");
  });

  test.each([
    ["stalled", "not-failed"],
    ["done", "not-failed"],
    ["running", "not-failed"],
    ["needs-human", "not-failed"],
    ["awaiting-work", "not-failed"],
  ])("status %s is never retracted (%s)", (status, reason) => {
    const v = classify({
      signal: failed({ status }),
      hasProbe: true,
      artifactPresent: true,
    });
    expect(v.retract).toBe(false);
    expect(v.reason).toBe(reason);
  });

  test.each([[null], [undefined], [""], ["   "], [42], [{}], [["cluster_fence_stale"]]])(
    "a non-string / empty failureReason (%p) is reason-absent, not reason-not-infra-class",
    (failureReason) => {
      const v = classify({
        signal: failed({ failureReason }),
        hasProbe: true,
        artifactPresent: true,
      });
      expect(v.retract).toBe(false);
      // The two diagnose different things: only one of them suggests a producer bug.
      expect(v.reason).toBe("reason-absent");
    }
  );

  test.each([[null], [undefined], [42], ["failed"], [[]]])(
    "an unreadable signal (%p) holds",
    (signal) => {
      const v = classify({ signal, hasProbe: true, artifactPresent: true });
      expect(v).toEqual({ retract: false, reason: "unreadable-signal", failureReason: null });
    }
  );

  test("no arguments at all holds rather than throwing", () => {
    expect(classifyArtifactContradiction().retract).toBe(false);
    expect(classify({}).retract).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("classifyArtifactContradiction — conjunct (b), the artifact", () => {
  test("artifact absent → hold, and the reason NAMES the absence", () => {
    const v = classify({
      signal: failed(),
      hasProbe: true,
      artifactPresent: false,
    });
    expect(v).toEqual({ retract: false, reason: "artifact-absent", failureReason: FENCE });
  });

  // ⭐ The three-valued point. "I could not look" must be its own answer: a
  // probe that threw and a probe that found nothing are different facts, and
  // this repo's false zeros are built out of collapsing them.
  test.each([[null], [undefined]])(
    "artifact %p (probe could not answer) is INCONCLUSIVE, not absent",
    (artifactPresent) => {
      const v = classify({ signal: failed(), hasProbe: true, artifactPresent });
      expect(v.retract).toBe(false);
      expect(v.reason).toBe("artifact-inconclusive");
      expect(v.reason).not.toBe("artifact-absent");
    }
  );

  test("a truthy-but-not-true artifactPresent does NOT retract", () => {
    for (const v of [1, "yes", {}, []]) {
      expect(
        classify({ signal: failed(), hasProbe: true, artifactPresent: v })
          .retract
      ).toBe(false);
    }
  });

  test("a phase with no registered probe holds as no-probe (cannot look ≠ absent)", () => {
    const v = classify({
      signal: failed(),
      hasProbe: false,
      artifactPresent: true, // even a caller claiming true cannot override a missing probe
    });
    expect(v).toEqual({ retract: false, reason: "no-probe", failureReason: FENCE });
  });

  test("every verdict reason produced is a registered CONTRADICTION_REASONS member", () => {
    const produced = new Set();
    for (const signal of [null, failed({ status: "done" }), failed({ failureReason: null }),
      failed({ failureReason: "test_failed" }), failed()]) {
      for (const hasProbe of [true, false]) {
        for (const artifactPresent of [true, false, null]) {
          produced.add(
            classify({ signal, hasProbe, artifactPresent }).reason
          );
        }
      }
    }
    for (const r of produced) expect(CONTRADICTION_REASONS).toContain(r);
    // and the sweep is wide enough to have exercised every branch but one
    expect(produced.size).toBeGreaterThanOrEqual(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⛔ THE AMBIGUITY WINDOW (Codex #3690 P1). `cluster_fence_stale` is ALSO the
// string a GENUINE ownership loss writes — and the losing worker still leaves a
// valid artifact, because phase-triage writes triage.json BEFORE it takes the
// fence. So conjunct (b) does not exclude a real bow-out, and the only thing
// that does is WHEN the signal was written.
describe("the cluster_fence_stale ambiguity window", () => {
  const both = { hasProbe: true, probeIsLocal: true, artifactPresent: true };

  test("⭐ inside the window (pre-CTL-2048 producer) it retracts", () => {
    const v = classify({ signal: failed(), writtenAtMs: IN_WINDOW, ...both });
    expect(v.retract).toBe(true);
    expect(v.reason).toBe("contradicted");
  });

  // ⛔ THE DEFECT ITSELF. A genuine takeover, artifact and all.
  test("⛔ AFTER the window a genuine takeover is NOT retracted, artifact or not", () => {
    const v = classify({ signal: failed(), writtenAtMs: AFTER_WINDOW, ...both });
    expect(v.retract).toBe(false);
    expect(v.reason).toBe("reason-window-expired");
  });

  test("the cutoff instant itself is OUTSIDE the window (>=, not >)", () => {
    const v = classify({ signal: failed(), writtenAtMs: CTL_2048_PRODUCER_FIX_MS, ...both });
    expect(v.retract).toBe(false);
    expect(v.reason).toBe("reason-window-expired");
  });

  // ⚠️ "I could not date it" is its own answer. Collapsing it into either edge
  // is the false-clean shape: to 0 and every undatable signal retracts, to now()
  // and none do while the feature reads as working.
  test.each([[null], [undefined], ["2026-08-18"], [NaN], [Infinity], [{}], ["nonsense"]])(
    "an undatable signal (%p) HOLDS as signal-age-unknown, not as either edge",
    (writtenAtMs) => {
      const v = classify({ signal: failed(), writtenAtMs, ...both });
      expect(v.retract).toBe(false);
      expect(v.reason).toBe("signal-age-unknown");
      expect(v.reason).not.toBe("reason-window-expired");
    }
  );

  // The unwindowed reason must be unaffected by every one of those dates — it is
  // CTL-2048's own string and says nothing about ownership at any time.
  test.each([[IN_WINDOW], [AFTER_WINDOW], [CTL_2048_PRODUCER_FIX_MS], [null], [undefined]])(
    "cluster_fence_unverified carries no window and retracts at date %p",
    (writtenAtMs) => {
      const v = classify({
        signal: failed({ failureReason: "cluster_fence_unverified" }),
        writtenAtMs,
        ...both,
      });
      expect(v.retract).toBe(true);
    }
  );

  test("every registered reason declares a window explicitly (null counts, absent does not)", () => {
    for (const reason of INFRA_FAILURE_REASONS) {
      const rule = INFRA_FAILURE_REASON_RULES[reason];
      expect(rule).toBeDefined();
      expect(Object.prototype.hasOwnProperty.call(rule, "ambiguousBeforeMs")).toBe(true);
      const w = rule.ambiguousBeforeMs;
      expect(w === null || Number.isFinite(w)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ⛔ NETWORK-BOUND PROBES (Codex #3690 P1). This classifier is consulted from a
// scheduler TICK, and a `failed` signal is never cleared by its probe answering
// false — so a registered network probe is an unbounded poll, not a one-off.
describe("probe locality — the sweep may not poll GitHub", () => {
  test.each(NETWORK_BOUND_PROBE_PHASES)(
    "%s holds as probe-not-local even with everything else satisfied",
    () => {
      const v = classify({
        signal: failed(),
        hasProbe: true,
        probeIsLocal: false,
        artifactPresent: true,
      });
      expect(v.retract).toBe(false);
      expect(v.reason).toBe("probe-not-local");
    }
  );

  test("an unanswered locality question holds — the default is not permissive", () => {
    const v = classifyArtifactContradiction({
      signal: failed(),
      writtenAtMs: IN_WINDOW,
      hasProbe: true,
      artifactPresent: true,
    });
    expect(v.retract).toBe(false);
    expect(v.reason).toBe("probe-not-local");
  });

  test("no-probe is reported BEFORE probe-not-local — they are different facts", () => {
    const v = classify({ signal: failed(), hasProbe: false, probeIsLocal: false });
    expect(v.reason).toBe("no-probe");
  });

  // ⭐ The parity control: adding a probe forces the locality question, and the
  // answer must agree with what the probe DESCRIBES itself as checking. A new
  // GitHub-backed probe left unclassified fails HERE rather than on the fleet.
  test("every registered probe is classified, and the classification matches its description", () => {
    for (const phase of Object.keys(WORK_DONE_PROBES)) {
      const desc = WORK_DONE_PROBE_DESCRIPTIONS[phase] ?? "";
      const describesNetwork = /github/i.test(desc);
      expect(probeIsLocal(phase)).toBe(!describesNetwork);
      expect(NETWORK_BOUND_PROBE_PHASES.includes(phase)).toBe(describesNetwork);
    }
    // and the set names nothing that is not a probe
    for (const phase of NETWORK_BOUND_PROBE_PHASES) {
      expect(Object.prototype.hasOwnProperty.call(WORK_DONE_PROBES, phase)).toBe(true);
    }
  });

  test("an unregistered phase is never local", () => {
    expect(probeIsLocal("not-a-phase")).toBe(false);
    expect(probeIsLocal(undefined)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("isRetractableFailure — the cheap gate agrees with the full classifier", () => {
  // The gate exists so the sweep can skip an expensive probe. If it ever
  // disagreed with the classifier about eligibility, the sweep would either
  // probe uselessly or — far worse — skip a genuinely retractable signal and
  // the whole feature would silently stop firing.
  test("eligibility matches the classifier's non-(a) holds, exhaustively", () => {
    const signals = [
      null, undefined, 42, [], {},
      failed(), failed({ status: "stalled" }), failed({ status: "done" }),
      failed({ failureReason: null }), failed({ failureReason: "" }),
      failed({ failureReason: "test_failed" }),
      failed({ failureReason: "cluster_fence_unverified" }),
    ];
    for (const signal of signals) {
      const cheap = isRetractableFailure({ signal, writtenAtMs: IN_WINDOW });
      const full = classify({ signal, hasProbe: true, artifactPresent: true });
      if (cheap.eligible) {
        expect(full.retract).toBe(true);
        expect(full.failureReason).toBe(cheap.failureReason);
      } else {
        expect(full.retract).toBe(false);
        expect(full.reason).toBe(cheap.reason);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
function scenario() {
  const orch = mkdtempSync(join(tmpdir(), "ctl2050-"));
  const w = (ticket, file, obj) => {
    mkdirSync(join(orch, "workers", ticket), { recursive: true });
    writeFileSync(join(orch, "workers", ticket, file), JSON.stringify(obj));
  };
  // ⚠️ Every phase signal carries an explicit date, because the sweep's fallback
  // is the FILE's mtime — and a fixture written just now is dated NOW, which is
  // outside the ambiguity window. Without this the whole e2e would hold on
  // `reason-window-expired` and its "nothing was retracted" assertions would
  // still read as a healthy pass. (They did: 13 tests went red the moment the
  // window landed, which is how this fixture was found.)
  const at = (ms) => new Date(ms).toISOString();
  // ⭐ THE MEASURED SHAPE (mini-2, 2026-08-18): triage worked, its artifact is on
  // disk, and the fence guard falsified the record at the emit step.
  w("CTC-239", "triage.json", { classification: "bug", summary: "real triage output" });
  w("CTC-239", "phase-triage.json", {
    ticket: "CTC-239",
    phase: "triage",
    status: "failed",
    failureReason: FENCE,
    completedAt: at(IN_WINDOW),
    orchestrator: "orch-1",
    assertedBy: null,
  });
  w("CTC-239", "phase-recovery-pass.json", { ticket: "CTC-239", phase: "recovery-pass", status: "needs-human" });

  // NEGATIVE CONTROL 1 — same infra reason, NO artifact. A genuine fence bow-out
  // (the other host did the work) looks exactly like this.
  w("CTC-900", "phase-triage.json", {
    ticket: "CTC-900", phase: "triage", status: "failed", failureReason: FENCE,
    completedAt: at(IN_WINDOW),
  });
  // NEGATIVE CONTROL 2 — artifact present, but the phase's OWN work failed.
  w("CTC-901", "triage.json", { classification: "bug" });
  w("CTC-901", "phase-triage.json", {
    ticket: "CTC-901", phase: "triage", status: "failed", failureReason: "test_failed",
    completedAt: at(IN_WINDOW),
  });
  // NEGATIVE CONTROL 3 — infra reason, artifact present but STRUCTURALLY INVALID
  // (empty classification). The probe validates content, not existence.
  w("CTC-902", "triage.json", { classification: "   " });
  w("CTC-902", "phase-triage.json", {
    ticket: "CTC-902", phase: "triage", status: "failed", failureReason: FENCE,
    completedAt: at(IN_WINDOW),
  });
  // NEGATIVE CONTROL 4 — a real ESCALATION: stalled, not failed.
  w("CTC-903", "triage.json", { classification: "bug" });
  w("CTC-903", "phase-triage.json", {
    ticket: "CTC-903", phase: "triage", status: "stalled", failureReason: FENCE,
    completedAt: at(IN_WINDOW),
  });
  // ⛔ NEGATIVE CONTROL 5 — Codex #3690 P1, THE defect this window exists for: a
  // GENUINE fence takeover, dated AFTER CTL-2048 closed the ambiguity. The
  // losing worker wrote a complete, valid triage.json before it lost the fence,
  // so this ticket is byte-identical to CTC-239 on every axis EXCEPT its date.
  // Retracting it would advance a ticket from output the fence deliberately
  // refused to publish — the double-act the fence exists to prevent, produced by
  // the recovery meant to be safe.
  w("CTC-904", "triage.json", { classification: "bug", summary: "real triage output" });
  w("CTC-904", "phase-triage.json", {
    ticket: "CTC-904", phase: "triage", status: "failed", failureReason: FENCE,
    completedAt: at(AFTER_WINDOW),
  });
  return { orch, read: (t, f = "phase-triage.json") =>
    JSON.parse(readFileSync(join(orch, "workers", t, f), "utf8")) };
}

// ─────────────────────────────────────────────────────────────────────────────
// ⛔ Codex #3690 P2, and the ONE fix in this round that no existing test could
// see. The e2e above exercises `triage`, whose probe reads the WORKER dir — so
// the recorded worktree path is irrelevant there and deleting the pass-through
// left the suite fully green (measured: mutation M3, 79 pass / 0 fail). The
// worktree-backed phases are where it decides the answer, and `resolveWorktree`
// matches ONLY an exact `refs/heads/<ticket>` branch: the real fleet's branches
// are `ryan/<ticket>-slug`, so without the recorded path a complete research doc
// probes FALSE and the sweep's hold reads as a correct decline.
// ⛔ Codex #3690 P1 (the second one), at the SWEEP rather than the classifier.
// The classifier's `probe-not-local` hold prevents a wrong VERDICT; it does not
// prevent the cost, because by the time the classifier is consulted the probe
// has already run. The guard that matters is on the CALL — and nothing else in
// this file could see it: hardcoding `local = true` in the sweep left the suite
// 81 pass / 0 fail (measured, mutation M4). This is the test that makes the
// per-tick `gh api` impossible rather than merely pointless.
describe("the sweep never RUNS a network-bound probe", () => {
  test("a failed monitor-merge signal holds as probe-not-local, and the probe is never invoked", () => {
    const orch = mkdtempSync(join(tmpdir(), "ctl2050-net-"));
    mkdirSync(join(orch, "workers", "CTC-906"), { recursive: true });
    writeFileSync(
      join(orch, "workers", "CTC-906", "phase-monitor-merge.json"),
      JSON.stringify({
        ticket: "CTC-906",
        phase: "monitor-merge",
        status: "failed",
        failureReason: FENCE,
        completedAt: new Date(IN_WINDOW).toISOString(),
      })
    );
    let calls = 0;
    const res = retractContradictedFailures(orch, {
      // The REAL registry's monitor-merge probe shells out to `gh api`. Here it
      // is replaced by a counter that also throws, so a regression fails loudly
      // instead of quietly spending an authenticated request per tick forever.
      probes: {
        ...WORK_DONE_PROBES,
        "monitor-merge": () => {
          calls += 1;
          throw new Error("network probe must not be reached from a scheduler tick");
        },
      },
      retract: () => {
        throw new Error("must not be reached");
      },
    });
    expect(res.ok).toBe(true);
    expect(calls).toBe(0); // ⭐ the assertion the classifier-level test cannot make
    expect(res.retracted).toBe(0);
    expect(res.heldReasons["probe-not-local"]).toBe(1);
    // and NOT the reason a thrown probe would have produced — the two are
    // different facts and only one of them means "we did not spend the request"
    expect(res.heldReasons["artifact-inconclusive"]).toBeUndefined();
  });
});

describe("the sweep passes the RECORDED worktree path to worktree-backed probes", () => {
  const researchFixture = () => {
    const orch = mkdtempSync(join(tmpdir(), "ctl2050-wt-"));
    const tree = mkdtempSync(join(tmpdir(), "ctl2050-tree-"));
    mkdirSync(join(tree, "thoughts", "shared", "research"), { recursive: true });
    writeFileSync(
      join(tree, "thoughts", "shared", "research", "2026-08-18-ctc-905-fence.md"),
      "# CTC-905 research\n\n## Summary\n" + "x".repeat(300) + "\n\n## Code References\n- a.mjs:1\n"
    );
    mkdirSync(join(orch, "workers", "CTC-905"), { recursive: true });
    writeFileSync(
      join(orch, "workers", "CTC-905", "phase-research.json"),
      JSON.stringify({
        ticket: "CTC-905",
        phase: "research",
        status: "failed",
        failureReason: FENCE,
        completedAt: new Date(IN_WINDOW).toISOString(),
        // ⭐ the canonical recorded path — and the branch it came from is a shape
        // resolveWorktree cannot match, which is the whole point.
        worktreePath: tree,
      })
    );
    return { orch, tree };
  };

  const sweep = (orch) =>
    retractContradictedFailures(orch, {
      // repoRoot must be non-null (the probe rejects a missing one before it
      // ever consults the path) and deliberately is NOT a git repo, so branch
      // resolution CANNOT succeed: the recorded path is the only way through.
      resolveRepoRoot: () => "/nonexistent/repo/root",
      retract: (o, sig, v) => defaultRetractContradictedFailure(o, sig, v, { appendEventLog: () => {} }),
    });

  test("⭐ a complete research artifact under a real-shaped branch IS retracted", () => {
    const { orch } = researchFixture();
    const res = sweep(orch);
    expect(res.eligible).toBe(1);
    expect(res.retracted).toBe(1);
    const after = JSON.parse(
      readFileSync(join(orch, "workers", "CTC-905", "phase-research.json"), "utf8")
    );
    expect(after.status).toBe("done");
    expect(after.assertedBy).toBe(ASSERTED_BY.RECOVERY_ARTIFACT_CONTRADICTION);
  });

  // The negative half: strip the recorded path and the identical artifact must
  // become UNREACHABLE — proving the retraction above went through that path and
  // not through branch resolution or some other accident of the fixture.
  test("without the recorded path the same artifact probes absent (the pre-fix behaviour)", () => {
    const { orch } = researchFixture();
    const sigPath = join(orch, "workers", "CTC-905", "phase-research.json");
    const sig = JSON.parse(readFileSync(sigPath, "utf8"));
    delete sig.worktreePath;
    writeFileSync(sigPath, JSON.stringify(sig));
    const res = sweep(orch);
    expect(res.eligible).toBe(1);
    expect(res.retracted).toBe(0);
    expect(res.heldReasons["artifact-absent"]).toBe(1);
  });
});

describe("the sweep — end to end over a real worker directory", () => {
  test("⭐ the measured ticket is retracted and NO negative control is touched", () => {
    const { orch, read } = scenario();
    const before = Object.fromEntries(
      ["CTC-900", "CTC-901", "CTC-902", "CTC-903", "CTC-904"].map((t) => [t, JSON.stringify(read(t))])
    );

    // Real sweep, real probes, real writer. Only the event log is silenced (it
    // would write to the operator's live ~/catalyst).
    const res = retractContradictedFailures(orch, {
      retract: (o, s, v) =>
        defaultRetractContradictedFailure(o, s, v, { appendEventLog: () => {} }),
    });

    expect(res.ok).toBe(true);
    expect(res.retracted).toBe(1);
    // ⭐ Each control must be held for ITS OWN reason, not merely be untouched:
    // a sweep that declined everything for one wrong reason would satisfy every
    // "unchanged" assertion in this test. CTC-904 in particular must be held by
    // the WINDOW — if it were held because its artifact failed to probe, the
    // control would be measuring the fixture, not the guard.
    expect(res.heldReasons["reason-window-expired"]).toBe(1); // CTC-904, the genuine takeover
    expect(res.heldReasons["artifact-absent"]).toBe(2); // CTC-900 (none) + CTC-902 (invalid)

    const after = read("CTC-239");
    expect(after.status).toBe("done");
    // ⭐ CTL-1789: FABRICATED, never declared.
    expect(after.assertedBy).toBe(ASSERTED_BY.RECOVERY_ARTIFACT_CONTRADICTION);
    expect(classifyAdvanceEvidence(after)).toBe(EVIDENCE.FABRICATED);
    expect(classifyAdvanceEvidence(after)).not.toBe(EVIDENCE.DECLARED);
    // The original failure is DEMOTED, never erased.
    expect(after.retractedFailureReason).toBe(FENCE);
    expect(after.failureReason).toBeNull();
    expect(after.retractedBy).toBe("artifact-contradiction");
    expect(typeof after.retractedAt).toBe("string");

    // ⛔ NOT ONE BYTE of any negative control changed.
    for (const t of Object.keys(before)) expect(JSON.stringify(read(t))).toBe(before[t]);
  });

  // ⭐⭐ THE ACTUAL ACCEPTANCE CRITERION. A `done` the FSM still refuses to move
  // would satisfy every assertion above and leave the ticket exactly as stuck.
  test("⭐ after the sweep the ticket is RELEASED — in flight and advance-eligible", () => {
    const { orch } = scenario();

    const stuck = readPhaseSignals(orch, "CTC-239");
    expect(isTicketInFlight(stuck)).toBe(false); // gate 2 of the deadlock, reproduced
    expect(deriveAdvancement(stuck)).toBeNull(); //  "

    retractContradictedFailures(orch, {
      retract: (o, s, v) =>
        defaultRetractContradictedFailure(o, s, v, { appendEventLog: () => {} }),
    });

    const released = readPhaseSignals(orch, "CTC-239");
    expect(isTicketInFlight(released)).toBe(true);
    expect(deriveAdvancement(released)).toBe("research");
    // …and the negative controls stay held, from the same seam.
    expect(deriveAdvancement(readPhaseSignals(orch, "CTC-900"))).toBeNull();
    expect(deriveAdvancement(readPhaseSignals(orch, "CTC-901"))).toBeNull();
  });

  test("the sweep is idempotent — a second pass retracts nothing", () => {
    const { orch, read } = scenario();
    const opts = {
      retract: (o, s, v) =>
        defaultRetractContradictedFailure(o, s, v, { appendEventLog: () => {} }),
    };
    retractContradictedFailures(orch, opts);
    const once = JSON.stringify(read("CTC-239"));
    const second = retractContradictedFailures(orch, opts);
    expect(second.retracted).toBe(0);
    // Hand-counted, not read off a run: CTC-900 (no artifact) and CTC-902
    // (structurally invalid artifact) are still `failed` with an infra reason.
    // CTC-901 is a real failure and CTC-903 is `stalled` — neither is eligible.
    expect(second.eligible).toBe(2);
    expect(JSON.stringify(read("CTC-239"))).toBe(once);
  });

  test("a probe that THROWS holds the ticket and does not wedge the sweep", () => {
    const { orch, read } = scenario();
    const before = JSON.stringify(read("CTC-239"));
    const res = retractContradictedFailures(orch, {
      probes: { triage: () => { throw new Error("probe exploded"); } },
      probeExists: () => true,
      retract: () => { throw new Error("must not be reached"); },
    });
    expect(res.ok).toBe(true);
    expect(res.retracted).toBe(0);
    expect(JSON.stringify(read("CTC-239"))).toBe(before);
  });

  test("an unreadable signal directory is LOUD, not a silent clean pass", () => {
    const res = retractContradictedFailures("/nonexistent/orch/dir", {
      readAll: () => { throw new Error("EACCES"); },
    });
    // ⚠️ ok:false is the whole point — `{eligible:0, retracted:0}` alone is
    // byte-identical to a healthy quiet tick.
    expect(res.ok).toBe(false);
    expect(res.retracted).toBe(0);
  });

  test("one bad signal does not stop the others", () => {
    const { orch, read } = scenario();
    // Throw for a NAMED ticket, not for the first call: directory iteration order
    // is not a contract, and a test that depends on it proves whatever the
    // filesystem felt like that morning.
    const res = retractContradictedFailures(orch, {
      probeExists: (phase) => {
        if (phase === "triage") return true;
        throw new Error("boom");
      },
      probes: {
        triage: ({ ticket }) => {
          if (ticket === "CTC-900") throw new Error("boom");
          return ticket === "CTC-239";
        },
      },
      retract: (o, s, v) =>
        defaultRetractContradictedFailure(o, s, v, { appendEventLog: () => {} }),
    });
    expect(res.ok).toBe(true);
    // Hand-counted: CTC-239, CTC-900, CTC-902 are `failed` with an infra reason.
    expect(res.eligible).toBe(3);
    // ⭐ CTC-900's probe threw, and CTC-239 — evaluated in the same sweep — still landed.
    expect(res.retracted).toBe(1);
    // and the held population is named, per reason — CTC-902's artifact really is
    // absent (invalid), CTC-900's probe really did throw.
    expect(res.heldReasons["artifact-absent"]).toBe(1);
    expect(res.heldReasons["artifact-inconclusive"]).toBe(1);
    expect(read("CTC-239").status).toBe("done");
    expect(read("CTC-900").status).toBe("failed"); // the thrower is held, not retracted
    expect(read("CTC-901").status).toBe("failed"); // negative control still intact
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("the writer — what it refuses", () => {
  const v = { retract: true, reason: "contradicted", failureReason: FENCE };

  test("declines when the on-disk signal is no longer `failed` (a real completion landed)", () => {
    const { orch, read } = scenario();
    // A redispatched worker declared a genuine completion between the tick's read
    // and this write. Applying the stale verdict would destroy it.
    writeFileSync(
      join(orch, "workers", "CTC-239", "phase-triage.json"),
      JSON.stringify({ ticket: "CTC-239", phase: "triage", status: "done",
        assertedBy: ASSERTED_BY.PHASE_AGENT })
    );
    const wrote = defaultRetractContradictedFailure(orch, failed(), v, { appendEventLog: () => {} });
    expect(wrote).toBe(false);
    // ⭐ the agent's OWN declaration survives untouched
    expect(read("CTC-239").assertedBy).toBe(ASSERTED_BY.PHASE_AGENT);
    expect(classifyAdvanceEvidence(read("CTC-239"))).toBe(EVIDENCE.DECLARED);
  });

  // ⛔ M4 CONTROL. The `done`-with-no-failureReason case above is caught by the
  // REASON re-check, not the STATUS one — so with only that case, deleting the
  // status guard survived the whole suite. This is the shape that discriminates:
  // a terminal writer that spreads `...cur` and flips `status` while leaving
  // `failureReason` in place, which several of them do. Without the status guard
  // the retraction overwrites a real terminal whose reason merely matches.
  test("declines when the on-disk status changed but the failureReason did NOT", () => {
    const { orch, read } = scenario();
    writeFileSync(
      join(orch, "workers", "CTC-239", "phase-triage.json"),
      JSON.stringify({
        ticket: "CTC-239", phase: "triage", status: "stalled",
        failureReason: FENCE, stalledReason: "escalated-by-operator",
      })
    );
    expect(defaultRetractContradictedFailure(orch, failed(), v, { appendEventLog: () => {} })).toBe(false);
    expect(read("CTC-239").status).toBe("stalled");
    expect(read("CTC-239").stalledReason).toBe("escalated-by-operator");
  });

  test("declines when the on-disk failureReason changed under it", () => {
    const { orch, read } = scenario();
    writeFileSync(
      join(orch, "workers", "CTC-239", "phase-triage.json"),
      JSON.stringify({ ticket: "CTC-239", phase: "triage", status: "failed",
        failureReason: "test_failed" })
    );
    expect(defaultRetractContradictedFailure(orch, failed(), v, { appendEventLog: () => {} })).toBe(false);
    expect(read("CTC-239").status).toBe("failed");
  });

  test("refuses a verdict that does not authorize a retraction", () => {
    const { orch, read } = scenario();
    for (const bad of [{ retract: false, failureReason: FENCE }, {}, null, undefined,
      { retract: "true", failureReason: FENCE }]) {
      expect(defaultRetractContradictedFailure(orch, failed(), bad, { appendEventLog: () => {} })).toBe(false);
    }
    expect(read("CTC-239").status).toBe("failed");
  });

  test("refuses rather than building a nonsense path when identity is missing or mistyped", () => {
    const { orch } = scenario();
    for (const sig of [
      { status: "failed", failureReason: FENCE },
      { ticket: "", phase: "triage", status: "failed", failureReason: FENCE },
      // ⚠️ a NON-EMPTY but non-string ticket: `??` would keep it and the write
      // would target `workers/[object Object]/…` forever.
      { ticket: {}, phase: "triage", status: "failed", failureReason: FENCE },
      { ticket: 239, phase: "triage", status: "failed", failureReason: FENCE },
    ]) {
      expect(defaultRetractContradictedFailure(orch, sig, v, { appendEventLog: () => {} })).toBe(false);
    }
  });

  test("falls back to PATH-DERIVED identity when the record omits it", () => {
    const { orch, read } = scenario();
    const wrote = defaultRetractContradictedFailure(
      orch,
      { status: "failed", failureReason: FENCE, derivedTicket: "CTC-239", derivedPhase: "triage" },
      v,
      { appendEventLog: () => {} }
    );
    expect(wrote).toBe(true);
    expect(read("CTC-239").status).toBe("done");
  });

  test("the audit event is NOT a routing name — it can wake no phase-lifecycle subscriber", () => {
    const { orch } = scenario();
    const seen = [];
    defaultRetractContradictedFailure(orch, failed(), v, { appendEventLog: (e) => seen.push(e) });
    expect(seen).toHaveLength(1);
    expect(seen[0].status).toBe("failure-retracted");
    // ⛔ re-emitting the phase's own terminal name would fire that event's
    // wait-for subscribers and the broker's lifecycle router on a terminal the
    // agent never declared.
    expect(["complete", "failed", "turn-cap-exhausted", "skipped"]).not.toContain(seen[0].status);
    expect(seen[0].phase).toBe("triage");
    expect(seen[0].ticket).toBe("CTC-239");
  });

  test("a throwing event emitter does not undo a committed retraction", () => {
    const { orch, read } = scenario();
    const wrote = defaultRetractContradictedFailure(orch, failed(), v, {
      appendEventLog: () => { throw new Error("event log full"); },
    });
    expect(wrote).toBe(true);
    expect(read("CTC-239").status).toBe("done");
  });

  test("a failed write leaves no debris and reports false", () => {
    const { orch, read } = scenario();
    const wrote = defaultRetractContradictedFailure(orch, failed(), v, {
      writeFile: () => { throw new Error("ENOSPC"); },
      appendEventLog: () => {},
    });
    expect(wrote).toBe(false);
    expect(read("CTC-239").status).toBe("failed"); // canonical file never truncated
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("contract invariants", () => {
  test("RETRACTABLE_STATUS is `failed` and `stalled` is deliberately excluded", () => {
    expect(RETRACTABLE_STATUS).toBe("failed");
    expect(RETRACTABLE_STATUS).not.toBe("stalled");
  });

  test("the registry is frozen and holds only the two measured infra reasons", () => {
    expect(Object.isFrozen(INFRA_FAILURE_REASONS)).toBe(true);
    // Pinned deliberately: widening it is a decision, not a refactor. If this
    // fails, the widening was intended — say so on the ticket and update the row.
    expect([...INFRA_FAILURE_REASONS].sort()).toEqual([
      "cluster_fence_stale",
      "cluster_fence_unverified",
    ]);
  });

  // ⛔ The code comment claims this event "can wake no phase-lifecycle
  // subscriber". A claim like that rots silently the moment someone adds a
  // status to the terminal set, so it is ASSERTED against the real contract
  // module — with a positive control, because a regex that matches nothing at
  // all would satisfy the negative assertion just as well.
  test("the audit event name is outside every routing namespace (positive-controlled)", async () => {
    const ns = await import("../broker/namespace-contract.mjs");
    const mine = "phase.triage.failure-retracted.CTC-239";
    expect(ns.PHASE_EVENT_PATTERN.test(mine)).toBe(false);
    expect(ns.PHASE_EVENT_PATTERN.test("phase.triage.complete.CTC-239")).toBe(true); // control
    expect(ns.isBrokerProtectedName(mine)).toBe(false);
    expect(ns.isBrokerProtectedName("filter.wake.x")).toBe(true); // control
  });

  test("the new writer id is registered and classifies FABRICATED", () => {
    expect(ASSERTED_BY.RECOVERY_ARTIFACT_CONTRADICTION).toBe("recovery-artifact-contradiction");
    expect(
      classifyAdvanceEvidence({ assertedBy: ASSERTED_BY.RECOVERY_ARTIFACT_CONTRADICTION })
    ).toBe(EVIDENCE.FABRICATED);
    // and it is its OWN string — an operator asking "why is this done?" must not
    // get the dead-worker reclaim's answer.
    expect(ASSERTED_BY.RECOVERY_ARTIFACT_CONTRADICTION).not.toBe(ASSERTED_BY.RECOVERY_RECLAIM);
  });
});
