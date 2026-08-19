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
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TERMINAL_LABEL_REASONS,
  THROTTLED_LABEL_REASONS,
  BUDGET_REASON_PREFIX,
  isTerminalLabelReason,
  isThrottledLabelReason,
  shouldCoolDownLabel,
} from "./label-failure-class.mjs";
import { convergeHeldLabel, convergeDispositionLabel } from "./scheduler.mjs";
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

/** CTL-2083: a writeStatus double whose removeLabel always fails with `reason`,
 *  counting calls. applyLabel is a no-op success so ONLY the remove path is
 *  exercised. `async:true` returns a Promise (the production removeLabel shape) so
 *  the thenable arm path is covered; the default sync shape matches the test doubles
 *  the existing settle branch also handles. */
function failingRemover(reason, { async = false } = {}) {
  const calls = [];
  return {
    calls,
    applyLabel() {
      return { applied: true };
    },
    removeLabel(ticket, label) {
      calls.push({ ticket, label });
      const res = { removed: false, wrote: false, reason };
      return async ? Promise.resolve(res) : res;
    },
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

// ── CTL-2083: the REMOVE side backs off too ──────────────────────────────────
// The apply side got its cool-down in COORD-236; the remove loops did not. A
// scheduler admission pass calls removeLabel on the stale `queued` label roughly
// every 2–5 s with no backoff and no already-converged guard — on mini-2 that was
// 2,919 of 3,069 budget:ticket-cap write-proxy refusals in a 4h window. The fix
// mirrors the apply-side (ticket,label) cool-down onto the remove path of BOTH
// convergers. `desired:null` is the clear-on-pickup case that fires for `queued`
// and skips the top-of-function apply gate entirely — the exact path the incident
// took.
const RC_COOLDOWN_MARKER = (dir, ticket, label) =>
  join(dir, ".label-cooldowns", `${ticket}-${label}.json`);

/** flush the microtask queue so an async removeLabel's .then arm runs before the
 *  next tick observes the cool-down marker. */
const flush = () => Promise.resolve();

describe("CTL-2083: convergeHeldLabel's REMOVE loop backs off on a budget refusal", () => {
  test("storm → ONE removeLabel then ZERO for the window (sync remover)", () => {
    const w = failingRemover("budget:ticket-cap");
    let clock = 1_000_000;
    const opts = { orchDir, now: () => clock };
    // desired:null = clear-on-pickup; the stale `queued` label must be removed.
    expect(convergeHeldLabel("CTL-R1", ["queued"], null, w, opts)).toBe(1);
    expect(w.calls.length).toBe(1);
    for (let i = 0; i < 59; i++) {
      clock += 1_000;
      convergeHeldLabel("CTL-R1", ["queued"], null, w, opts);
    }
    expect(w.calls.length).toBe(1);
  });

  test("...and re-issues once the window elapses — never permanent", () => {
    const w = failingRemover("budget:ticket-cap");
    let clock = 1_000_000;
    const opts = { orchDir, now: () => clock };
    convergeHeldLabel("CTL-R2", ["queued"], null, w, opts);
    expect(w.calls.length).toBe(1);
    clock += 61_000;
    convergeHeldLabel("CTL-R2", ["queued"], null, w, opts);
    expect(w.calls.length).toBe(2);
  });

  test("ASYNC remover arms the cool-down after resolution (the production shape)", async () => {
    const w = failingRemover("budget:ticket-cap", { async: true });
    let clock = 1_000_000;
    const opts = { orchDir, now: () => clock };
    convergeHeldLabel("CTL-R3", ["queued"], null, w, opts);
    expect(w.calls.length).toBe(1);
    // The removeLabel promise must resolve (and arm the marker) before the next tick.
    await flush();
    expect(readFileSync(RC_COOLDOWN_MARKER(orchDir, "CTL-R3", "queued"), "utf8")).toContain(
      "failedAt"
    );
    clock += 1_000;
    convergeHeldLabel("CTL-R3", ["queued"], null, w, opts);
    expect(w.calls.length).toBe(1);
  });

  test("a TERMINAL remove reason also cools (missing-label)", () => {
    const w = failingRemover("missing-label");
    let clock = 1_000_000;
    const opts = { orchDir, now: () => clock };
    convergeHeldLabel("CTL-R4", ["queued"], null, w, opts);
    clock += 1_000;
    convergeHeldLabel("CTL-R4", ["queued"], null, w, opts);
    expect(w.calls.length).toBe(1);
  });

  test("POSITIVE CONTROL: a transient reason keeps retrying (60 ticks → 60 calls)", () => {
    const w = failingRemover("transient");
    let clock = 1_000_000;
    const opts = { orchDir, now: () => clock };
    for (let i = 0; i < 60; i++) {
      convergeHeldLabel("CTL-R5", ["queued"], null, w, opts);
      clock += 1_000;
    }
    expect(w.calls.length).toBe(60);
  });

  test("`blocked` and `queued` use INDEPENDENT keys — one cool-down never suppresses the other", () => {
    const w = failingRemover("budget:ticket-cap");
    let clock = 1_000_000;
    const opts = { orchDir, now: () => clock };
    // Both present, desired:null → both attempted on tick 1.
    expect(convergeHeldLabel("CTL-R6", ["blocked", "queued"], null, w, opts)).toBe(2);
    expect(w.calls.length).toBe(2);
    // Tick 2 in-window → both cooled → 0 further calls.
    clock += 1_000;
    convergeHeldLabel("CTL-R6", ["blocked", "queued"], null, w, opts);
    expect(w.calls.length).toBe(2);
    // Distinct markers exist for each label.
    expect(readFileSync(RC_COOLDOWN_MARKER(orchDir, "CTL-R6", "blocked"), "utf8")).toContain(
      "failedAt"
    );
    expect(readFileSync(RC_COOLDOWN_MARKER(orchDir, "CTL-R6", "queued"), "utf8")).toContain(
      "failedAt"
    );
  });

  test("onRemoveResult still fires with removed:false on a refusal (no spurious cleared transition)", () => {
    const w = failingRemover("budget:ticket-cap");
    let clock = 1_000_000;
    const seen = [];
    const opts = {
      orchDir,
      now: () => clock,
      onRemoveResult: (label, removed) => seen.push({ label, removed }),
    };
    convergeHeldLabel("CTL-R7", ["queued"], null, w, opts);
    expect(seen).toEqual([{ label: "queued", removed: false }]);
  });
});

describe("CTL-2083: convergeDispositionLabel's REMOVE loop backs off (stops discarding the reason)", () => {
  test("disposition remove storm → ONE write then ZERO for the window", () => {
    const w = failingRemover("budget:ticket-cap");
    let clock = 1_000_000;
    const opts = { orchDir, now: () => clock };
    expect(convergeDispositionLabel("CTL-R8", ["queued"], null, w, opts)).toBe(1);
    expect(w.calls.length).toBe(1);
    for (let i = 0; i < 30; i++) {
      clock += 1_000;
      convergeDispositionLabel("CTL-R8", ["queued"], null, w, opts);
    }
    expect(w.calls.length).toBe(1);
  });

  test("time-boxed re-issue after the window elapses", () => {
    const w = failingRemover("budget:ticket-cap");
    let clock = 1_000_000;
    const opts = { orchDir, now: () => clock };
    convergeDispositionLabel("CTL-R9", ["queued"], null, w, opts);
    expect(w.calls.length).toBe(1);
    clock += 61_000;
    convergeDispositionLabel("CTL-R9", ["queued"], null, w, opts);
    expect(w.calls.length).toBe(2);
  });

  test("ASYNC remover arms after resolution", async () => {
    const w = failingRemover("budget:ticket-cap", { async: true });
    let clock = 1_000_000;
    const opts = { orchDir, now: () => clock };
    convergeDispositionLabel("CTL-R10", ["queued"], null, w, opts);
    await flush();
    expect(readFileSync(RC_COOLDOWN_MARKER(orchDir, "CTL-R10", "queued"), "utf8")).toContain(
      "failedAt"
    );
    clock += 1_000;
    convergeDispositionLabel("CTL-R10", ["queued"], null, w, opts);
    expect(w.calls.length).toBe(1);
  });

  test("POSITIVE CONTROL: a transient reason keeps retrying (30 ticks → 30 calls)", () => {
    const w = failingRemover("transient");
    let clock = 1_000_000;
    const opts = { orchDir, now: () => clock };
    for (let i = 0; i < 30; i++) {
      convergeDispositionLabel("CTL-R11", ["queued"], null, w, opts);
      clock += 1_000;
    }
    expect(w.calls.length).toBe(30);
  });

  test("`needs-human` is NEVER in the removable set — zero removeLabel calls against it", () => {
    const w = failingRemover("budget:ticket-cap");
    let clock = 1_000_000;
    const opts = { orchDir, now: () => clock };
    // needs-human present + desired a lower disposition → precedence suppression.
    convergeDispositionLabel("CTL-R12", ["needs-human"], "queued", w, opts);
    expect(w.calls.filter((c) => c.label === "needs-human").length).toBe(0);
  });
});

describe("⛔ COORD-236: labelOnce must NOT treat a throttled reason as permanent", () => {
  // The asymmetry is the whole point of two predicates. `.skipped` is forever;
  // a budget refusal is not. Folding them would permanently abandon a
  // needs-human label refused during one exhausted minute — the operator it
  // exists to page would never be paged. That is strictly worse than the storm.
  test("a budget refusal writes NO .skipped marker, so the next tick retries", () => {
    const w = failingWriter("budget:day-exhausted");
    withWorkerDir("CTL-5");
    expect(labelOnce(orchDir, "CTL-5", "needs-human", w)).toBe(true);
    expect(w.calls.length).toBe(1);
    // No terminal marker ⇒ labelOnce runs the write again.
    expect(labelOnce(orchDir, "CTL-5", "needs-human", w)).toBe(true);
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

  test("both APPLY arming sites call shouldCoolDownLabel", () => {
    // The apply arms key on `desired`; the CTL-2083 remove arm keys on `label`, so
    // this count of the `…, desired` sites stays exactly two — a proof that neither
    // remove-side change accidentally re-keyed an apply arm onto `label`.
    const armings = SCHED.split("\n").filter((l) => l.includes("recordLabelCooldown(orchDir, ticket, desired"));
    expect(armings.length).toBe(2);
    // Each arming is guarded by the wide predicate on the line above it.
    const lines = SCHED.split("\n");
    for (const [i, l] of lines.entries()) {
      if (!l.includes("recordLabelCooldown(orchDir, ticket, desired")) continue;
      expect(lines.slice(Math.max(0, i - 3), i).join("\n")).toContain("shouldCoolDownLabel");
    }
  });

  // ── CTL-2083 ────────────────────────────────────────────────────────────────
  // The remove side re-issued a doomed removeLabel every ~2–5 s with no cool-down.
  // The remove arms live in ONE shared helper (maybeArmRemoveCooldown) called from
  // both convergers, and each converger gates its remove loop on the SAME per-label
  // window. Pin BOTH so a future refactor cannot silently drop exactly the backoff
  // this ticket adds — the same defense the two apply arms above already have.
  test("CTL-2083: the REMOVE path arms the SAME cool-down via the shared helper", () => {
    const lines = SCHED.split("\n");
    // The single arm CALL site inside maybeArmRemoveCooldown keys on `label`,
    // guarded by shouldCoolDownLabel just above it. Exclude the `function
    // recordLabelCooldown(orchDir, ticket, label, now)` DEFINITION line — it
    // carries the same token but is not an arm site.
    const isArmCall = (l) =>
      l.includes("recordLabelCooldown(orchDir, ticket, label") &&
      !l.trimStart().startsWith("function ");
    const armLines = lines.filter(isArmCall);
    expect(armLines.length).toBe(1);
    const armIdx = lines.findIndex(isArmCall);
    expect(armIdx).toBeGreaterThan(-1);
    expect(lines.slice(Math.max(0, armIdx - 4), armIdx).join("\n")).toContain(
      "shouldCoolDownLabel"
    );
    // Both convergers gate their remove loop on the per-`label` cool-down window.
    // Exclude the `function inLabelCooldown(...)` definition line (same token).
    const gateCount = lines.filter(
      (l) =>
        l.includes("inLabelCooldown(orchDir, ticket, label") &&
        !l.trimStart().startsWith("function ")
    ).length;
    expect(gateCount).toBe(2);
    // Both convergers route their refused remove through the shared helper (≥2 call
    // sites — held has a sync + thenable branch, disposition has its own two).
    const helperRefs = lines.filter(
      (l) =>
        l.includes("maybeArmRemoveCooldown(orchDir, ticket, label") &&
        !l.trimStart().startsWith("function ")
    ).length;
    expect(helperRefs).toBeGreaterThanOrEqual(2);
  });

  test("neither file re-declares its own copy of the terminal set", () => {
    // The two files carried byte-identical hand-written copies; one owner now.
    for (const src of [SCHED, GUARD]) {
      expect(src).not.toContain('new Set([\n  "missing-label",');
      expect(src).toContain("TERMINAL_LABEL_REASONS");
    }
  });

  test("label-guard does not IMPORT the wide predicate — the asymmetry is structural", () => {
    // Asserted on the import statement, not on the file text: the header
    // deliberately NAMES `shouldCoolDownLabel` to explain why it is not used
    // here, and a prose match would make that explanation fail the build.
    const imports = GUARD.split("\n").filter((l) => /^import /.test(l));
    expect(imports.join("\n")).toContain("TERMINAL_LABEL_REASONS");
    expect(imports.join("\n")).not.toContain("shouldCoolDownLabel");
    // ...and no code line calls it.
    const code = GUARD.split("\n").filter((l) => !l.trimStart().startsWith("//"));
    expect(code.join("\n")).not.toContain("shouldCoolDownLabel(");
  });
});
