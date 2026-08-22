// label-budget-backoff.test.mjs — COORD-236.
//
// mini's admission converger re-issued `applyLabel` for the same three tickets
// ~220 times each in 20 minutes and spent the host's ENTIRE 300-write daily
// Linear budget by lunchtime on 2026-08-18. The exhausted budget then refused the
// cross-host CLAIM writes, and 36 held tickets across both minis reported a lost
// claim on tickets they owned (CTL-2033 / CTL-879). One retry loop froze fleet
// dispatch for the rest of the UTC day.
//
// ⛔ The 60-second cool-down that would have stopped it ALREADY EXISTED (CTL-834).
// It simply could not see a budget refusal: `UNRECOVERABLE_LABEL_REASONS` answers
// "can this EVER land?", and a budget refusal answers "not right now" — a
// different question. So the converger read "retryable next tick" and did exactly
// that, for hours.
//
// Run: cd plugins/dev/scripts/execution-core && bun test label-budget-backoff.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TERMINAL_LABEL_REASONS,
  THROTTLED_LABEL_REASONS,
  BUDGET_REASON_PREFIX,
  CLOUD_LABEL_REJECTION_REASONS,
  CLOUD_REASON_PREFIX,
  isTerminalLabelReason,
  isThrottledLabelReason,
  isCloudLabelRejection,
  isCloudReason,
  shouldCoolDownLabel,
} from "./label-failure-class.mjs";
import {
  convergeHeldLabel,
  convergeDispositionLabel,
  classifyLabelCooldownLog,
  labelCooldownPath,
  labelRetryState,
} from "./scheduler.mjs";
import { labelOnce } from "./label-guard.mjs";

let orchDir;
beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "coord236-"));
});

/** labelOnce writes its marker under workers/<ticket>/, which production always
 *  has by the time it runs. Create it, or every marker write silently ENOENTs
 *  inside labelOnce's try/catch and the test measures nothing. */
function withWorkerDir(ticket) {
  mkdirSync(join(orchDir, "workers", ticket), { recursive: true });
  return ticket;
}
afterEach(() => {
  try {
    rmSync(orchDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/** a writeStatus double whose applyLabel always fails with `reason`, counting calls. */
function failingWriter(reason) {
  const calls = [];
  return {
    calls,
    applyLabel({ ticket, label }) {
      calls.push({ ticket, label });
      return { applied: false, reason };
    },
    removeLabel() {},
  };
}

describe("COORD-236 classification: 'never' and 'not right now' are different answers", () => {
  test("the terminal set is exactly the three CTL-834/CTL-1085 reasons", () => {
    expect([...TERMINAL_LABEL_REASONS].sort()).toEqual([
      "exclusive-conflict",
      "missing-label",
      "team-mismatch",
    ]);
  });

  test("every budget refusal the proxy can emit is THROTTLED, not terminal", () => {
    // The proxy's classifyWrite gate has grown twice; matching by prefix is what
    // keeps a NEW budget reason from silently reading as "retryable next tick".
    // The real constants are linear-write-budget.mjs's frozen REASONS. The last entry
    // is deliberately NOT one of them: an unknown budget reason must still classify,
    // which is the whole argument for matching by prefix. (FLEET's #3667 P3: this
    // list used to say `budget:per-ticket-cap`, a string that does not exist.)
    for (const r of ["budget:day-exhausted", "budget:ticket-cap", "budget:already-converged", "budget:something-nobody-has-written-yet"]) {
      expect(r.startsWith(BUDGET_REASON_PREFIX)).toBe(true);
      expect(isThrottledLabelReason(r)).toBe(true);
      expect(isTerminalLabelReason(r)).toBe(false);
      expect(shouldCoolDownLabel(r)).toBe(true);
    }
  });

  test("CTL-2043: every cloud-authored refusal is cool-down-eligible, matched by PREFIX", () => {
    // The mirror of the budget: prefix test above, and for the same reason: the
    // `cloud:<outcome>` reason set is authored BY THE CLOUD (`cloud:${parsed.outcome}`
    // in linear-write-proxy.mjs — CTC-509 lists rejected | failed | exhausted, and it
    // can grow), so an enumeration in THIS repo can never be complete by construction.
    // CTL-2052 enumerated one member; the reachable `cloud:exhausted` fell out of both
    // predicates and was re-issued every tick. The last entry is deliberately a string
    // nobody has written yet — AC3: a future cloud outcome classifies with NO code
    // change here.
    for (const r of [
      "cloud:label-rejected",
      "cloud:failed",
      "cloud:rejected",
      "cloud:exhausted",
      "cloud:something-nobody-has-written-yet",
    ]) {
      expect(r.startsWith(CLOUD_REASON_PREFIX)).toBe(true);
      expect(isCloudReason(r)).toBe(true);
      expect(shouldCoolDownLabel(r)).toBe(true);
      expect(isTerminalLabelReason(r)).toBe(false);
    }
  });

  test("CTL-2043: the prefix BOUNDARY — a near-miss non-cloud string is still NEITHER", () => {
    // Pins that widening to a prefix did not widen to a substring: only the
    // `cloud:` family (colon included) cools down. Without this, "cloudy" would
    // read as cloud-authored and a genuinely transient reason would be delayed 60 s.
    for (const r of ["cloudy", "cloud", "cloud-rejected", "not-cloud:failed"]) {
      expect(isCloudReason(r)).toBe(false);
      expect(shouldCoolDownLabel(r)).toBe(false);
    }
  });

  test("a 429 rate-limit is THROTTLED — re-issuing into it next tick is the same storm", () => {
    expect(THROTTLED_LABEL_REASONS.has("rate-limited")).toBe(true);
    expect(shouldCoolDownLabel("rate-limited")).toBe(true);
    expect(isTerminalLabelReason("rate-limited")).toBe(false);
  });

  test("⛔ a 403 `unauthorized` is THROTTLED, never TERMINAL — the marker would outlive the re-mint", () => {
    // FLEET's #3667 P2-b. It was in NEITHER class, so a 403 retried every tick and
    // each attempt spent a host budget unit. Terminal would be worse than the storm:
    // `.skipped` lives under workers/<ticket>/ and survives a restart, so it would
    // outlive the credential fix that clears the 403.
    expect(shouldCoolDownLabel("unauthorized")).toBe(true);
    expect(isThrottledLabelReason("unauthorized")).toBe(true);
    expect(isTerminalLabelReason("unauthorized")).toBe(false);
    expect(TERMINAL_LABEL_REASONS.has("unauthorized")).toBe(false);
  });

  test("⚠️ Object.freeze does not seal a Set — the exact-contents assertions are what pin these", () => {
    // Stated as a test rather than only as a comment, so the reassurance the
    // `Object.freeze` wrapper gives a reader is calibrated: it seals the object's own
    // properties, not the Set's contents. The two exact-contents cases above are the
    // real guard.
    expect(Object.isFrozen(TERMINAL_LABEL_REASONS)).toBe(true);
    const probe = new Set(TERMINAL_LABEL_REASONS);
    probe.add("x");
    expect(probe.has("x")).toBe(true); // a frozen Set would still have accepted this
  });

  test("a genuinely transient reason is NEITHER — it must keep retrying next tick", () => {
    // `transient` / `verify-failed` are cheap to retry and self-correct fast;
    // cooling them down for 60 s would delay every legitimate recovery.
    for (const r of ["transient", "verify-failed", null, undefined, "", 42]) {
      expect(shouldCoolDownLabel(r)).toBe(false);
    }
  });
});

describe("COORD-236: the converger backs off on a budget refusal", () => {
  // The measured storm: three tickets × ~220 applies in 20 minutes.
  test("convergeHeldLabel issues ONE apply, then makes ZERO writes for the cool-down window", () => {
    const w = failingWriter("budget:day-exhausted");
    let clock = 1_000_000;
    const opts = { orchDir, now: () => clock };
    // Tick 1: the write is attempted and fails.
    expect(convergeHeldLabel("CTL-1", [], "needs-human", w, opts)).toBe(1);
    expect(w.calls.length).toBe(1);
    // Ticks 2..60, one per second inside the 60 s window: ZERO further writes.
    for (let i = 0; i < 59; i++) {
      clock += 1_000;
      convergeHeldLabel("CTL-1", [], "needs-human", w, opts);
    }
    expect(w.calls.length).toBe(1);
  });

  test("...and retries once the window elapses — the back-off is time-boxed, never permanent", () => {
    // ⛔ The critical half. A budget refusal clears at 00:00 UTC without anyone
    // doing anything; a back-off that never expired would abandon the label.
    const w = failingWriter("budget:day-exhausted");
    let clock = 1_000_000;
    const opts = { orchDir, now: () => clock };
    convergeHeldLabel("CTL-1", [], "needs-human", w, opts);
    expect(w.calls.length).toBe(1);
    clock += 61_000;
    convergeHeldLabel("CTL-1", [], "needs-human", w, opts);
    expect(w.calls.length).toBe(2);
  });

  test("convergeDispositionLabel backs off on the same reason", () => {
    const w = failingWriter("budget:day-exhausted");
    let clock = 1_000_000;
    const opts = { orchDir, now: () => clock };
    expect(convergeDispositionLabel("CTL-2", [], "queued", w, opts)).toBe(1);
    for (let i = 0; i < 30; i++) {
      clock += 1_000;
      convergeDispositionLabel("CTL-2", [], "queued", w, opts);
    }
    expect(w.calls.length).toBe(1);
  });

  test("REGRESSION SHAPE: without the fix this is ~60 writes, not 1", () => {
    // The pre-COORD-236 behaviour, expressed as the number it produced. A
    // `transient` reason is NOT cooled down, so this is the storm the budget
    // reason used to be part of — and it doubles as a positive control that the
    // harness really does drive 60 ticks.
    const w = failingWriter("transient");
    let clock = 1_000_000;
    const opts = { orchDir, now: () => clock };
    for (let i = 0; i < 60; i++) {
      convergeHeldLabel("CTL-3", [], "needs-human", w, opts);
      clock += 1_000;
    }
    expect(w.calls.length).toBe(60);
  });

  test("a TERMINAL reason still cools down — the widening removed nothing", () => {
    const w = failingWriter("missing-label");
    let clock = 1_000_000;
    const opts = { orchDir, now: () => clock };
    convergeHeldLabel("CTL-4", [], "needs-human", w, opts);
    clock += 1_000;
    convergeHeldLabel("CTL-4", [], "needs-human", w, opts);
    expect(w.calls.length).toBe(1);
  });
});

describe("⛔ COORD-236: labelOnce must NOT treat a throttled reason as permanent", () => {
  // The asymmetry is the whole point of two predicates. `.skipped` is forever;
  // a budget refusal is not. Folding them would permanently abandon a
  // needs-human label refused during one exhausted minute — the operator it
  // exists to page would never be paged. That is strictly worse than the storm.
  test("a budget refusal writes NO .skipped marker, so a LATER tick still retries", () => {
    // ⚠️ CTL-2043 (P2-a) changed the CADENCE this test used to pin, not the property
    // it exists to defend. It asserted the retry happened on the very NEXT call —
    // which was the P2-a defect: labelOnce armed no cool-down at all and re-issued
    // every tick, spending a budget unit each time. What must survive is that the
    // refusal is never PERMANENT, and that is what is asserted here: zero writes
    // inside the window, and a real retry once it elapses.
    const w = failingWriter("budget:day-exhausted");
    withWorkerDir("CTL-5");
    let clock = 5_000_000;
    const opts = { now: () => clock };
    expect(labelOnce(orchDir, "CTL-5", "needs-human", w, opts)).toBe(true);
    expect(w.calls.length).toBe(1);
    // Still no PERMANENT marker — the whole COORD-236 asymmetry.
    expect(existsSync(join(orchDir, "workers", "CTL-5", ".linear-label-needs-human.skipped"))).toBe(
      false
    );
    // In-window: cooled down, zero further writes (CTL-2043 P2-a).
    for (let i = 0; i < 30; i++) {
      clock += 1_000;
      labelOnce(orchDir, "CTL-5", "needs-human", w, opts);
    }
    expect(w.calls.length).toBe(1);
    // Past the window: retried. The back-off is time-boxed, never permanent.
    clock += 61_000;
    expect(labelOnce(orchDir, "CTL-5", "needs-human", w, opts)).toBe(true);
    expect(w.calls.length).toBe(2);
  });

  test("a TERMINAL reason still writes .skipped and stops — unchanged", () => {
    const w = failingWriter("missing-label");
    withWorkerDir("CTL-6");
    expect(labelOnce(orchDir, "CTL-6", "needs-human", w)).toBe(true);
    expect(labelOnce(orchDir, "CTL-6", "needs-human", w)).toBe(false);
    expect(w.calls.length).toBe(1);
  });

  test("the two predicates are NOT the same function — a merge is caught here", () => {
    // If someone "simplifies" labelOnce onto shouldCoolDownLabel, this fails.
    expect(isTerminalLabelReason("budget:day-exhausted")).toBe(false);
    expect(shouldCoolDownLabel("budget:day-exhausted")).toBe(true);
  });
});

// ── WIRING GUARD ─────────────────────────────────────────────────────────────
// The classifier is worthless if a converger still consults the narrow set.
describe("COORD-236 wiring: the cool-down is armed by the WIDE predicate", () => {
  const SCHED = readFileSync(join(import.meta.dir, "scheduler.mjs"), "utf8");
  const GUARD = readFileSync(join(import.meta.dir, "label-guard.mjs"), "utf8");

  test("both converger arming sites call shouldCoolDownLabel", () => {
    const armings = SCHED.split("\n").filter((l) => l.includes("recordLabelCooldown(orchDir, ticket, desired"));
    expect(armings.length).toBe(2);
    // Each arming is guarded by the wide predicate on the line above it.
    const lines = SCHED.split("\n");
    for (const [i, l] of lines.entries()) {
      if (!l.includes("recordLabelCooldown(orchDir, ticket, desired")) continue;
      expect(lines.slice(Math.max(0, i - 3), i).join("\n")).toContain("shouldCoolDownLabel");
    }
  });

  test("neither file re-declares its own copy of the terminal set", () => {
    // The two files carried byte-identical hand-written copies; one owner now.
    for (const src of [SCHED, GUARD]) {
      expect(src).not.toContain('new Set([\n  "missing-label",');
      expect(src).toContain("TERMINAL_LABEL_REASONS");
    }
  });

  // CTL-2043: extract whole import STATEMENTS, not lines beginning with `import`.
  // The previous line filter had a hole big enough to drive the regression through:
  // a MULTI-LINE `import { ... } from "./label-failure-class.mjs"` puts every
  // specifier on a continuation line, so `shouldCoolDownLabel` could be imported here
  // and the guard would still pass. (It is not hypothetical — this file's import
  // became multi-line in CTL-2043, and prettier will re-wrap any single-line import
  // that outgrows the print width, so the hole opens on a formatting pass alone.)
  const importStatements = (src) => (src.match(/^import\s[\s\S]*?from\s+"[^"]+";/gm) ?? []).join("\n");

  test("the extraction itself sees multi-line imports (positive control)", () => {
    // Without this, an extraction that silently matched NOTHING would make every
    // `not.toContain` assertion below pass vacuously — the false-clean shape.
    const probe = importStatements(
      'import {\n  alpha,\n  beta,\n} from "./x.mjs";\nconst y = 1;\nimport z from "./z.mjs";'
    );
    expect(probe).toContain("alpha");
    expect(probe).toContain("beta");
    expect(probe).toContain("z");
    expect(probe).not.toContain("const y");
    // ...and it really finds this file's own multi-line import of the classifier.
    expect(importStatements(GUARD)).toContain("label-failure-class.mjs");
  });

  test("label-guard does not IMPORT the wide predicate — the asymmetry is structural", () => {
    // Asserted on the import statements, not on the file text: the header
    // deliberately NAMES `shouldCoolDownLabel` to explain why it is not used
    // here, and a prose match would make that explanation fail the build.
    const imports = importStatements(GUARD);
    expect(imports).toContain("TERMINAL_LABEL_REASONS");
    expect(imports).not.toContain("shouldCoolDownLabel");
    // ...and no code line calls it.
    const code = GUARD.split("\n").filter((l) => !l.trimStart().startsWith("//"));
    expect(code.join("\n")).not.toContain("shouldCoolDownLabel(");
  });

  test("CTL-2043: labelOnce composes the two NARROW predicates instead", () => {
    // Decision B. labelOnce's cool-down set is exactly `shouldCoolDownLabel MINUS
    // terminal` (a terminal reason writes .skipped and early-returns, so it never
    // reaches the cool-down arm). Composing the narrow predicates expresses that
    // precisely AND keeps the asymmetry structural — importing the wide predicate
    // would put the terminal class one careless edit away from a permanent .skipped
    // for a throttled reason, which is the strictly-worse-than-the-storm bug.
    const imports = importStatements(GUARD);
    expect(imports).toContain("isThrottledLabelReason");
    expect(imports).toContain("isCloudReason");
  });
});

// ── CTL-2043 Decision C — the primitives moved to a shared leaf ──────────────
describe("CTL-2043: the cool-down primitives live in a leaf BOTH callers can import", () => {
  test("label-cooldown.mjs owns them, and scheduler.mjs re-exports the two the tests read", async () => {
    // label-guard.mjs is a leaf scheduler.mjs imports, so a label-guard → scheduler
    // import would be the exact cycle the leaf placement exists to avoid. The
    // re-export keeps every existing `from "./scheduler.mjs"` import resolving —
    // asserted here so a future re-home fails loudly instead of breaking callers.
    const leaf = await import("./label-cooldown.mjs");
    expect(typeof leaf.labelCooldownPath).toBe("function");
    expect(typeof leaf.labelRetryState).toBe("function");
    expect(typeof leaf.inLabelCooldown).toBe("function");
    expect(typeof leaf.recordLabelCooldown).toBe("function");
    expect(typeof leaf.clearLabelCooldown).toBe("function");
    expect(typeof leaf.readLabelCooldownMarker).toBe("function");
    expect(typeof leaf.LABEL_COOLDOWN_MS).toBe("number");
    // Same function object through both specifiers — a re-export, not a copy.
    expect(labelCooldownPath).toBe(leaf.labelCooldownPath);
    expect(labelRetryState).toBe(leaf.labelRetryState);
  });

  test("the cap machinery stays converger-only — it is NOT in the shared leaf", async () => {
    // AC4 is the 60 s window alone; the cap (CTL-2052 AC3) is converger-specific and
    // deliberately not wired into labelOnce. Keeping it out of the leaf is what stops
    // it drifting in by import-convenience.
    const leaf = await import("./label-cooldown.mjs");
    expect(leaf.labelRetryCapBlocks).toBeUndefined();
    expect(leaf.maybeEscalateRetryExhausted).toBeUndefined();
  });
});

// ── CTL-2052 ─────────────────────────────────────────────────────────────────
// A DETERMINISTIC cloud rejection of a LABEL write (the enforce/proxy path's
// `cloud:failed`/`cloud:rejected`, normalized to `cloud:label-rejected`) is a
// THIRD class: cool-down-eligible (so the storm stops) but NOT terminal (so it
// never earns labelOnce's permanent `.skipped` — COORD-236) and NOT throttled
// (so the operator log names the right thing — AC2).
describe("CTL-2052 classification: the deterministic cloud label rejection is its own class", () => {
  test("the cloud-label-rejection set is EXACTLY { cloud:label-rejected }", () => {
    expect([...CLOUD_LABEL_REJECTION_REASONS].sort()).toEqual(["cloud:label-rejected"]);
    expect(isCloudLabelRejection("cloud:label-rejected")).toBe(true);
  });

  test("it cools down but is NEITHER terminal NOR throttled", () => {
    expect(shouldCoolDownLabel("cloud:label-rejected")).toBe(true); // AC1: back off
    expect(isTerminalLabelReason("cloud:label-rejected")).toBe(false); // no permanent .skipped
    expect(isThrottledLabelReason("cloud:label-rejected")).toBe(false); // not "budget/throttled"
  });

  test("CTL-2043 INVERTS this pin: the RAW proxy reasons now cool down on their OWN", () => {
    // ⚠️ DELIBERATE REVERSAL of the CTL-2052 property that stood here ("the raw
    // strings do NOT cool down by themselves — normalization is what classifies").
    // Under the `cloud:` prefix arm, storm-prevention no longer DEPENDS on the
    // normalization step: even if a future refactor drops normalizeLabelProxyVerdict,
    // the raw reason still backs off. That is strictly stronger than what the old pin
    // defended, which is why it is inverted rather than deleted.
    //
    // Normalization is KEPT and stays load-bearing for exactly one thing now:
    // operator-log reason fidelity (CTL-2052 AC2). So the exactness pin below stands —
    // only the NORMALIZED `cloud:label-rejected` is the deterministic-rejection LOG
    // class; a raw `cloud:failed` is cool-down-eligible but is not that class.
    for (const raw of ["cloud:failed", "cloud:rejected"]) {
      expect(shouldCoolDownLabel(raw)).toBe(true); // CTL-2043 — belt AND suspenders
      expect(isCloudLabelRejection(raw)).toBe(false); // CTL-2052 — log class stays EXACT
    }
  });

  test("cloud:exhausted cools down by prefix (CTL-2043) but is NOT the exact rejection class", () => {
    // `cloud:${outcome}` also produces cloud:exhausted (a budget exhaustion). CTL-2052
    // left it out of BOTH predicates, so it armed no cool-down and was re-issued every
    // tick — the enumeration gap CTL-2043 closes. It now cools down via the family
    // prefix while staying out of the exact rejection class, so the operator log says
    // "cloud" (family), never "cloud-rejection" (deterministic) and never "terminal".
    expect(isCloudLabelRejection("cloud:exhausted")).toBe(false);
    expect(shouldCoolDownLabel("cloud:exhausted")).toBe(true);
    expect(isTerminalLabelReason("cloud:exhausted")).toBe(false);
    expect(isThrottledLabelReason("cloud:exhausted")).toBe(false);
  });
});

describe("CTL-2052: the converger backs off on the normalized cloud label rejection (AC1)", () => {
  test("convergeDispositionLabel issues ONE apply, then ZERO for the cool-down window", () => {
    const w = failingWriter("cloud:label-rejected");
    let clock = 2_000_000;
    const opts = { orchDir, now: () => clock };
    expect(convergeDispositionLabel("CTL-20", [], "blocked", w, opts)).toBe(1);
    expect(w.calls.length).toBe(1);
    for (let i = 0; i < 30; i++) {
      clock += 1_000;
      convergeDispositionLabel("CTL-20", [], "blocked", w, opts);
    }
    expect(w.calls.length).toBe(1); // AC1: does NOT re-issue on the next tick
  });

  test("convergeHeldLabel backs off on the same normalized reason", () => {
    const w = failingWriter("cloud:label-rejected");
    let clock = 2_000_000;
    const opts = { orchDir, now: () => clock };
    expect(convergeHeldLabel("CTL-21", [], "blocked", w, opts)).toBe(1);
    for (let i = 0; i < 30; i++) {
      clock += 1_000;
      convergeHeldLabel("CTL-21", [], "blocked", w, opts);
    }
    expect(w.calls.length).toBe(1);
  });

  test("CTL-2043: an UNNORMALIZED family member (cloud:exhausted) also backs off — the PREFIX is what bites", () => {
    // Repointed from the CTL-2052 negative control, which fed a raw `cloud:failed`
    // to prove it stormed when normalization was absent. `cloud:exhausted` is never
    // normalized to anything (it is not a deterministic rejection), so it isolates
    // the prefix arm: ONE apply, then zero for the window. The positive control that
    // this harness really drives N ticks and can still observe a storm is the
    // `transient` case above ("REGRESSION SHAPE: ... ~60 writes, not 1").
    const w = failingWriter("cloud:exhausted");
    let clock = 2_000_000;
    const opts = { orchDir, now: () => clock };
    for (let i = 0; i < 10; i++) {
      convergeDispositionLabel("CTL-22", [], "blocked", w, opts);
      clock += 1_000;
    }
    expect(w.calls.length).toBe(1);
  });

  test("CTL-2043: convergeHeldLabel backs off on cloud:exhausted, and it is TIME-BOXED", () => {
    const w = failingWriter("cloud:exhausted");
    let clock = 2_000_000;
    const opts = { orchDir, now: () => clock };
    expect(convergeHeldLabel("CTL-25", [], "blocked", w, opts)).toBe(1);
    for (let i = 0; i < 30; i++) {
      clock += 1_000;
      convergeHeldLabel("CTL-25", [], "blocked", w, opts);
    }
    expect(w.calls.length).toBe(1);
    // ⛔ The critical half: a cloud budget exhaustion clears on its own, so the
    // back-off must expire — never permanently abandon the label (COORD-236).
    clock += 61_000;
    convergeHeldLabel("CTL-25", [], "blocked", w, opts);
    expect(w.calls.length).toBe(2);
  });

  test("CTL-2043: convergeDispositionLabel retries cloud:exhausted after the window too", () => {
    const w = failingWriter("cloud:exhausted");
    let clock = 2_000_000;
    const opts = { orchDir, now: () => clock };
    convergeDispositionLabel("CTL-26", [], "queued", w, opts);
    expect(w.calls.length).toBe(1);
    clock += 61_000;
    convergeDispositionLabel("CTL-26", [], "queued", w, opts);
    expect(w.calls.length).toBe(2);
  });

  test("CTL-2043: the operator log names the RIGHT class for each cloud reason (AC2 not regressed)", () => {
    // The three-way discriminator became four-way. A `cloud:exhausted` must read as
    // the cloud FAMILY, not as "terminal" (which sends an operator hunting a missing
    // label) and not as "cloud-rejection" (which claims a determinism it does not
    // have); the normalized `cloud:label-rejected` must keep its exact class.
    const msgs = {
      cloudMsg: "M-cloud-rejection",
      cloudFamilyMsg: "M-cloud",
      throttledMsg: "M-throttled",
      terminalMsg: "M-terminal",
    };
    expect(classifyLabelCooldownLog("cloud:label-rejected", msgs)).toEqual({
      cls: "cloud-rejection",
      message: "M-cloud-rejection",
    });
    expect(classifyLabelCooldownLog("cloud:exhausted", msgs)).toEqual({
      cls: "cloud",
      message: "M-cloud",
    });
    expect(classifyLabelCooldownLog("cloud:something-nobody-has-written-yet", msgs)).toEqual({
      cls: "cloud",
      message: "M-cloud",
    });
    expect(classifyLabelCooldownLog("budget:day-exhausted", msgs)).toEqual({
      cls: "throttled",
      message: "M-throttled",
    });
    expect(classifyLabelCooldownLog("rate-limited", msgs)).toEqual({
      cls: "throttled",
      message: "M-throttled",
    });
    expect(classifyLabelCooldownLog("missing-label", msgs)).toEqual({
      cls: "terminal",
      message: "M-terminal",
    });
  });
});

describe("⛔ CTL-2052: labelOnce must NOT write .skipped for the cloud label rejection (COORD-236 asymmetry)", () => {
  test("a cloud:label-rejected refusal leaves NO .skipped marker, so a later genuine apply is not abandoned", () => {
    // CTL-2043 (P2-a): the retry now waits out the cool-down window instead of
    // firing on the very next tick — but it still fires. Unprovable-terminal must
    // never be permanently abandoned.
    const w = failingWriter("cloud:label-rejected");
    withWorkerDir("CTL-23");
    let clock = 5_000_000;
    const opts = { now: () => clock };
    expect(labelOnce(orchDir, "CTL-23", "needs-human", w, opts)).toBe(true);
    expect(w.calls.length).toBe(1);
    expect(
      existsSync(join(orchDir, "workers", "CTL-23", ".linear-label-needs-human.skipped"))
    ).toBe(false);
    clock += 61_000;
    expect(labelOnce(orchDir, "CTL-23", "needs-human", w, opts)).toBe(true);
    expect(w.calls.length).toBe(2);
  });

  test("contrast: exclusive-conflict DOES write .skipped and stops — the asymmetry is preserved", () => {
    const w = failingWriter("exclusive-conflict");
    withWorkerDir("CTL-24");
    expect(labelOnce(orchDir, "CTL-24", "needs-human", w)).toBe(true);
    expect(labelOnce(orchDir, "CTL-24", "needs-human", w)).toBe(false);
    expect(w.calls.length).toBe(1);
  });
});

// ── CTL-2052 Phase 2 (AC3) — bound retries to N, then stop and say so ─────────
describe("CTL-2052 labelRetryState — the pure cap arithmetic", () => {
  const cfg = { cap: 3, exhaustedMs: 1_000 };
  test("below the cap → not blocked, not a probe", () => {
    expect(labelRetryState({ failedAt: 0, attempts: 2 }, 100, cfg)).toMatchObject({
      blocked: false,
      exhaustedProbe: false,
      attempts: 2,
    });
  });
  test("at the cap, inside the exhausted window → BLOCKED", () => {
    expect(labelRetryState({ failedAt: 0, attempts: 3 }, 500, cfg)).toMatchObject({
      blocked: true,
      exhaustedProbe: false,
    });
  });
  test("at the cap, PAST the exhausted window → a single self-heal probe (not blocked)", () => {
    expect(labelRetryState({ failedAt: 0, attempts: 3 }, 2_000, cfg)).toMatchObject({
      blocked: false,
      exhaustedProbe: true,
    });
  });
  test("a null / absent marker → nothing recorded yet, not blocked", () => {
    expect(labelRetryState(null, 0, cfg)).toMatchObject({ blocked: false, exhaustedProbe: false, attempts: 0 });
    expect(labelRetryState({}, 0, cfg)).toMatchObject({ blocked: false, attempts: 0 });
  });
});

describe("CTL-2052 Phase 2: the converger counts cool-down cycles, then stops", () => {
  const readAttempts = (ticket, label) =>
    JSON.parse(readFileSync(labelCooldownPath(orchDir, ticket, label), "utf8")).attempts;

  test("the attempt counter increments once per cool-down CYCLE, not per tick", () => {
    const w = failingWriter("cloud:label-rejected");
    let clock = 3_000_000;
    const opts = { orchDir, now: () => clock, retryCap: 100, retryExhaustedMs: 10_000_000 };
    convergeDispositionLabel("CTL-30", [], "blocked", w, opts); // apply 1 → attempts 1
    expect(readAttempts("CTL-30", "blocked")).toBe(1);
    clock += 1_000; // still inside the 60 s window: 0 applies, no increment
    convergeDispositionLabel("CTL-30", [], "blocked", w, opts);
    expect(readAttempts("CTL-30", "blocked")).toBe(1);
    clock += 61_000; // window elapsed → apply 2
    convergeDispositionLabel("CTL-30", [], "blocked", w, opts);
    expect(readAttempts("CTL-30", "blocked")).toBe(2);
    clock += 61_000; // apply 3
    convergeDispositionLabel("CTL-30", [], "blocked", w, opts);
    expect(readAttempts("CTL-30", "blocked")).toBe(3);
    expect(w.calls.length).toBe(3);
  });

  test("after the cap the converger stops re-issuing — the cap gate wins over the time gate", () => {
    const w = failingWriter("cloud:label-rejected");
    let clock = 3_000_000;
    const opts = { orchDir, now: () => clock, retryCap: 3, retryExhaustedMs: 1_800_000 };
    for (let i = 0; i < 3; i++) {
      convergeDispositionLabel("CTL-31", [], "blocked", w, opts);
      clock += 61_000;
    }
    expect(w.calls.length).toBe(3); // reached the cap
    // 4th convergence: the 60 s window has elapsed, but the cap gate short-circuits first.
    convergeDispositionLabel("CTL-31", [], "blocked", w, opts);
    expect(w.calls.length).toBe(3);
    clock += 61_000;
    convergeDispositionLabel("CTL-31", [], "blocked", w, opts);
    expect(w.calls.length).toBe(3);
  });

  test("convergeHeldLabel enforces the same cap", () => {
    const w = failingWriter("cloud:label-rejected");
    let clock = 3_000_000;
    const opts = { orchDir, now: () => clock, retryCap: 2, retryExhaustedMs: 1_800_000 };
    for (let i = 0; i < 2; i++) {
      convergeHeldLabel("CTL-35", [], "blocked", w, opts);
      clock += 61_000;
    }
    expect(w.calls.length).toBe(2);
    convergeHeldLabel("CTL-35", [], "blocked", w, opts);
    expect(w.calls.length).toBe(2);
  });

  test("the retry-exhausted escalation fires EXACTLY ONCE, on the cap crossing (edge-triggered)", () => {
    const w = failingWriter("cloud:label-rejected");
    const events = [];
    let clock = 3_000_000;
    const opts = {
      orchDir,
      now: () => clock,
      retryCap: 3,
      retryExhaustedMs: 1_800_000,
      onRetryExhausted: (info) => events.push(info),
    };
    for (let i = 0; i < 6; i++) {
      convergeDispositionLabel("CTL-32", [], "blocked", w, opts);
      clock += 61_000;
    }
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({
      ticket: "CTL-32",
      label: "blocked",
      attempts: 3,
      reason: "cloud:label-rejected",
    });
  });

  test("the stop SELF-HEALS: after the long window exactly one probe apply is allowed again", () => {
    const w = failingWriter("cloud:label-rejected");
    let clock = 3_000_000;
    const opts = { orchDir, now: () => clock, retryCap: 3, retryExhaustedMs: 1_800_000 };
    for (let i = 0; i < 3; i++) {
      convergeDispositionLabel("CTL-33", [], "blocked", w, opts);
      clock += 61_000;
    }
    expect(w.calls.length).toBe(3);
    convergeDispositionLabel("CTL-33", [], "blocked", w, opts); // still capped inside the long window
    expect(w.calls.length).toBe(3);
    clock += 1_800_001; // past the exhausted window → one self-heal probe
    convergeDispositionLabel("CTL-33", [], "blocked", w, opts);
    expect(w.calls.length).toBe(4);
  });

  test("a SUCCESSFUL apply resets the ledger — the counter starts fresh next time", () => {
    let mode = "fail";
    const calls = [];
    const w = {
      calls,
      applyLabel({ ticket, label }) {
        calls.push({ ticket, label });
        return mode === "fail"
          ? { applied: false, reason: "cloud:label-rejected" }
          : { applied: true, reason: null };
      },
      removeLabel() {},
    };
    let clock = 3_000_000;
    const opts = { orchDir, now: () => clock, retryCap: 10, retryExhaustedMs: 10_000_000 };
    convergeDispositionLabel("CTL-34", [], "blocked", w, opts); // fail → attempts 1
    clock += 61_000;
    convergeDispositionLabel("CTL-34", [], "blocked", w, opts); // fail → attempts 2
    expect(readAttempts("CTL-34", "blocked")).toBe(2);
    clock += 61_000;
    mode = "ok";
    convergeDispositionLabel("CTL-34", [], "blocked", w, opts); // success → ledger cleared
    expect(existsSync(labelCooldownPath(orchDir, "CTL-34", "blocked"))).toBe(false);
  });
});
