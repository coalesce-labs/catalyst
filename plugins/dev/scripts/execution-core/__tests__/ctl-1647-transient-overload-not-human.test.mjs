// ctl-1647-transient-overload-not-human.test.mjs — CTL-1647.
//
// GUARD: a transient provider-capacity failure (429/529 overload, codex rate
// park) must NEVER be recorded as a plain terminal failure and must NEVER
// produce a per-ticket human-decision escalation. It must take the existing
// retry-safe path (CTL-1679) so the ticket resumes by itself.
//
// Measured 2026-08-21: 41 of 79 tickets parked as "a human must decide" died on
// this exact path — the SDK backstop wrote a terminal signal with no retry-safe
// marker, the scheduler's terminal sweep escalated it, and coerceExplanation
// fabricated "decide whether to retry, hand off, or cancel".
//
// EVERY assertion here is paired with a POSITIVE CONTROL that reproduces the
// PRE-FIX shape and proves the assertion fails on it — a guard test that cannot
// fail is worthless.
//
// Run: cd plugins/dev/scripts/execution-core && bun test __tests__/ctl-1647-transient-overload-not-human.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { defaultEmitBackstop } from "../sdk-run-phase-agent.mjs";
import { buildRecoveryItems } from "../recovery-evidence.mjs";
import { defaultClassifyTicket, buildRetrySafeExhaustionExplanation } from "../recovery-reasoning.mjs";
import {
  buildTransientExhaustedExplanation,
  classifyTransientSignal,
  coerceExplanation,
  isTransientInfraReason,
  validateExplanation,
  TRANSIENT_ESCALATION_BACKOFF_MS,
} from "../escalation-explanation.mjs";

const TICKET = "CTL-9647";
const PHASE = "implement";

let orchDir;
let spawnCalls;
const spawnStub = (bin, args) => {
  spawnCalls.push({ bin, args });
  return { status: 0, stdout: "", stderr: "", signal: null };
};

function signalPath() {
  return join(orchDir, "workers", TICKET, `phase-${PHASE}.json`);
}

/** Write the in-flight signal the pre-launch leaves on disk. */
function writeInFlightSignal() {
  mkdirSync(join(orchDir, "workers", TICKET), { recursive: true });
  writeFileSync(
    signalPath(),
    JSON.stringify({
      ticket: TICKET,
      phase: PHASE,
      status: "running",
      generation: 1,
      bg_job_id: "bg-1",
      updatedAt: new Date().toISOString(),
    }),
  );
}

function readSignal() {
  return JSON.parse(readFileSync(signalPath(), "utf8"));
}

/** The reader projection the scheduler/recovery see: on-disk JSON nested under `.raw`. */
function projection(raw) {
  return {
    ticket: raw.ticket,
    phase: raw.phase,
    status: raw.status,
    updatedAt: raw.updatedAt,
    signalPath: signalPath(),
    raw,
  };
}

/** Run the recovery classifier over a signal exactly as the daemon does. */
function classify(raw) {
  const items = buildRecoveryItems([projection(raw)]);
  return defaultClassifyTicket(items[0].evidence, {
    ticket: TICKET,
    readIntentAttempts: () => 0, // hermetic: fresh retry budget
    log: () => {},
  });
}

beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "ctl1647-"));
  spawnCalls = [];
});
afterEach(() => {
  rmSync(orchDir, { recursive: true, force: true });
});

describe("CTL-1647 — step 1: the overload backstop records a RETRY-SAFE terminal", () => {
  test("sdk-overloaded-exhausted → signal.retrySafe:true + retry_safe on the emitted event", () => {
    writeInFlightSignal();
    defaultEmitBackstop(
      {
        phase: PHASE,
        ticket: TICKET,
        status: "failed",
        reason: "sdk-overloaded-exhausted",
        orchDir,
        signalFile: signalPath(),
        retrySafe: true,
      },
      { spawn: spawnStub },
    );

    const sig = readSignal();
    // The terminal write itself is PRESERVED (CTL-1367 item 4 — an in-flight
    // signal strands the worker forever); what changes is the retry-safe marker.
    expect(sig.status).toBe("stalled");
    expect(sig.attentionReason).toBe("sdk-overloaded-exhausted");
    expect(sig.retrySafe).toBe(true);

    // Signal and EVENT must carry the same flag or the two records desync.
    const args = spawnCalls[0].args;
    expect(args).toContain("--payload-json");
    expect(args[args.indexOf("--payload-json") + 1]).toBe('{"retry_safe":true}');
  });

  // POSITIVE CONTROL — the PRE-FIX shape. A genuine (non-transient) backstop
  // still writes a bare terminal with NO retrySafe and NO retry_safe payload.
  // If the production call site ever loses `retrySafe: true`, the test above
  // produces exactly this shape and fails.
  test("POSITIVE CONTROL: a non-transient backstop writes NO retrySafe (pre-fix shape)", () => {
    writeInFlightSignal();
    defaultEmitBackstop(
      {
        phase: PHASE,
        ticket: TICKET,
        status: "failed",
        reason: "sdk-threw",
        orchDir,
        signalFile: signalPath(),
      },
      { spawn: spawnStub },
    );
    const sig = readSignal();
    expect(sig.status).toBe("stalled");
    expect(sig.retrySafe).toBeUndefined();
    expect(spawnCalls[0].args).not.toContain("--payload-json");
  });
});

describe("CTL-1647 — step 2: recovery re-dispatches it instead of escalating", () => {
  test("the on-disk overload signal classifies as fix / retry_safe_redispatch", () => {
    writeInFlightSignal();
    defaultEmitBackstop(
      {
        phase: PHASE,
        ticket: TICKET,
        status: "failed",
        reason: "sdk-overloaded-exhausted",
        orchDir,
        signalFile: signalPath(),
        retrySafe: true,
      },
      { spawn: spawnStub },
    );

    const decision = classify(readSignal());
    expect(decision.decision).toBe("fix");
    expect(decision.fix_class).toBe("retry_safe_redispatch");
    expect(decision.details.seam_id).toBe("fence-stale-redispatch");
    // The cause is NAMED, not the anonymous "unrecognized-retry-safe".
    expect(decision.details.reason).toContain("sdk-overloaded-exhausted");
    // And it is emphatically NOT a human escalation.
    expect(decision.fix_class).not.toBe("human");
  });

  // POSITIVE CONTROL — the exact pre-fix signal (identical in every way except
  // the missing retrySafe marker) must NOT classify as a retry. This is the
  // regression detector: revert the producer change and the test above lands here.
  test("POSITIVE CONTROL: the same signal WITHOUT retrySafe does NOT auto-retry", () => {
    writeInFlightSignal();
    defaultEmitBackstop(
      {
        phase: PHASE,
        ticket: TICKET,
        status: "failed",
        reason: "sdk-overloaded-exhausted",
        orchDir,
        signalFile: signalPath(),
        // retrySafe omitted — the pre-CTL-1647 production call
      },
      { spawn: spawnStub },
    );
    const raw = readSignal();
    expect(raw.retrySafe).toBeUndefined(); // control is really the pre-fix shape
    const decision = classify(raw);
    expect(decision.fix_class).not.toBe("retry_safe_redispatch");
  });

  test("codex-rate-park-exhausted takes the same retry-safe path", () => {
    writeInFlightSignal();
    defaultEmitBackstop(
      {
        phase: PHASE,
        ticket: TICKET,
        status: "failed",
        reason: "codex-rate-park-exhausted",
        orchDir,
        signalFile: signalPath(),
        retrySafe: true,
      },
      { spawn: spawnStub },
    );
    const decision = classify(readSignal());
    expect(decision.decision).toBe("fix");
    expect(decision.fix_class).toBe("retry_safe_redispatch");
  });
});

describe("CTL-1647 — step 3: the classifier is a CLOSED SET, not a prose match", () => {
  const overloadRaw = (over = {}) => ({
    ticket: TICKET,
    phase: PHASE,
    status: "stalled",
    attentionReason: "sdk-overloaded-exhausted",
    retrySafe: true,
    updatedAt: new Date().toISOString(),
    ...over,
  });

  test("a fresh retry-safe transient signal is inside the back-off window", () => {
    const v = classifyTransientSignal(projection(overloadRaw()));
    expect(v.transient).toBe(true);
    expect(v.retrySafe).toBe(true);
    expect(v.withinBackoff).toBe(true);
  });

  // POSITIVE CONTROL 1 — a GENUINE failure must still escalate.
  test("POSITIVE CONTROL: a genuine failure is NOT transient → still escalates", () => {
    const v = classifyTransientSignal(
      projection({
        ticket: TICKET,
        phase: PHASE,
        status: "failed",
        failureReason: "ended-without-declaration",
        updatedAt: new Date().toISOString(),
      }),
    );
    expect(v.transient).toBe(false);
    expect(v.withinBackoff).toBe(false);
  });

  // POSITIVE CONTROL 2 — the skip is BOUNDED.
  test("POSITIVE CONTROL: past the backoff window the transient skip expires", () => {
    const stale = overloadRaw({
      updatedAt: new Date(Date.now() - TRANSIENT_ESCALATION_BACKOFF_MS - 60_000).toISOString(),
    });
    const v = classifyTransientSignal(projection(stale));
    expect(v.transient).toBe(true);
    expect(v.withinBackoff).toBe(false);
  });

  // Codex R1: a transient-looking reason with NO retrySafe stamp has no route
  // that re-dispatches it, so suppressing its escalation would be a pure silent
  // stall. It must fall OUT of the window.
  test("a transient reason WITHOUT retrySafe is never inside the window", () => {
    const v = classifyTransientSignal(projection(overloadRaw({ retrySafe: undefined })));
    expect(v.transient).toBe(true);
    expect(v.retrySafe).toBe(false);
    expect(v.withinBackoff).toBe(false);
  });

  // Codex R2 P3: an unreadable/absent timestamp can never age. Treating it as
  // "fresh" would suppress the escalation on EVERY tick, forever.
  test("an unreadable updatedAt does NOT buy an unbounded suppression", () => {
    for (const stamp of [undefined, null, "not-a-date"]) {
      const v = classifyTransientSignal(projection(overloadRaw({ updatedAt: stamp })));
      expect(v.transient).toBe(true);
      expect(v.ageMs).toBeNull();
      expect(v.withinBackoff).toBe(false);
    }
  });

  test("the reason classifier accepts ONLY the producer literals", () => {
    for (const r of ["sdk-overloaded-exhausted", "codex-rate-park-exhausted"]) {
      expect(isTransientInfraReason(r)).toBe(true);
    }
    for (const r of [
      "ended-without-declaration",
      "cluster_fence_stale",
      "pr_not_merged",
      "tests failed",
      null,
      undefined,
      "",
    ]) {
      expect(isTransientInfraReason(r)).toBe(false);
    }
  });

  // POSITIVE CONTROL — the anti-over-match guard. Agent-authored prose reaches
  // this predicate through escalation-explain.mjs / label-guard.mjs, so a
  // GENUINE human escalation that merely MENTIONS a rate limit must not match.
  // The pre-review draft used a substring regex and silently swallowed these.
  test("POSITIVE CONTROL: prose that merely MENTIONS overload/429 is NOT transient", () => {
    for (const r of [
      "the API client we're building has no rate limit handling",
      "provider returned 529 overloaded",
      "HTTP 429 rate limit",
      "the test run overloaded the box",
      "CTL-9 has a stalled phase signal (sdk-overloaded-exhausted) and is not terminal",
      "service unavailable",
    ]) {
      expect(isTransientInfraReason(r)).toBe(false);
    }
  });
});

describe("CTL-1647 — step 4: the template refuses to fabricate a human decision", () => {
  test("a STRUCTURED transient reason yields NO fabricated options / why_you / decision", () => {
    const e = coerceExplanation(
      {
        problem: `${TICKET} has a stalled phase signal (sdk-overloaded-exhausted) and is not terminal`,
        call_to_action: `decide whether to retry ${TICKET} or close it`,
        reason: "sdk-overloaded-exhausted",
      },
      { ticket: TICKET, canExecute: false },
    );
    expect(e.escalation_type).not.toBe("decision");
    expect(e.transient).toBe(true);
    expect(e.options).toBeUndefined();
    expect(e.why_you).toBeUndefined();
    expect(e.call_to_action).not.toContain("decide whether to retry, hand off, or cancel");
    expect(JSON.stringify(e)).not.toContain("priority call the agent cannot make unilaterally");
  });

  // Codex R2 P2 (demonstrated defect in the pre-review draft): the card must NOT
  // claim "no decision is required / it will re-dispatch itself". Every site that
  // reaches an explanation has ALREADY spent its automatic window, so that text
  // is a false all-clear on a still-parked ticket.
  test("the transient card never claims the ticket needs nothing", () => {
    const e = buildTransientExhaustedExplanation(TICKET, "sdk-overloaded-exhausted", 3);
    const text = JSON.stringify(e).toLowerCase();
    expect(text).not.toContain("no decision is required");
    expect(text).not.toContain("do not retry");
    expect(text).toContain("re-dispatch");
    expect(e.call_to_action.toLowerCase()).toContain("already passed");
    // It is a VALID manual escalation (act-then-confirm), which is what it now is.
    expect(validateExplanation(e, { canExecute: false })).toMatchObject({ valid: true });
  });

  // It must survive coerceExplanation untouched (valid → early return), so the
  // terminal sweep's truthful card is not re-degraded into the decision template.
  test("the transient card passes coerceExplanation unchanged", () => {
    const e = buildTransientExhaustedExplanation(TICKET, "sdk-overloaded-exhausted", 3);
    const c = coerceExplanation(e, { ticket: TICKET, canExecute: false });
    expect(c.escalation_type).toBe("manual");
    expect(c.degraded).toBeUndefined();
    expect(c.call_to_action).toBe(e.call_to_action);
  });

  // POSITIVE CONTROL — the template's LEGITIMATE use is untouched.
  test("POSITIVE CONTROL: a genuine unexplained failure STILL gets the decision template", () => {
    const e = coerceExplanation(
      {
        problem: `${TICKET} has a failed phase signal (ended-without-declaration) and is not terminal`,
        call_to_action: `decide whether to retry ${TICKET} or close it`,
      },
      { ticket: TICKET, canExecute: false },
    );
    expect(e.escalation_type).toBe("decision");
    expect(Array.isArray(e.options)).toBe(true);
    expect(e.why_you).toContain("priority call the agent cannot make unilaterally");
  });

  // POSITIVE CONTROL — an agent-authored escalation whose PROSE mentions a rate
  // limit still gets its human decision card. This is the over-match regression
  // detector: gate the arm on prose again and this fails.
  test("POSITIVE CONTROL: prose mentioning a rate limit still gets the decision card", () => {
    const e = coerceExplanation(
      { problem: "the API client we're building has no rate limit handling and 429s" },
      { ticket: TICKET, canExecute: false },
    );
    expect(e.escalation_type).toBe("decision");
    expect(e.transient).toBeUndefined();
    expect(e.call_to_action).toContain("decide whether to retry, hand off, or cancel");
  });

  // POSITIVE CONTROL — the coverage-gap ask CTL-1679 raises after its budget is
  // spent must not be swallowed by the transient arm.
  test("POSITIVE CONTROL: the retry-safe exhaustion ask is not rewritten as transient", () => {
    const e = coerceExplanation(
      buildRetrySafeExhaustionExplanation(TICKET, "sdk-overloaded-exhausted", 2),
      { ticket: TICKET, canExecute: false },
    );
    expect(e.transient).toBeUndefined();
  });
});

describe("CTL-1647 — step 5: recovery never escalates a transient cause", () => {
  const overload = () => {
    writeInFlightSignal();
    defaultEmitBackstop(
      {
        phase: PHASE,
        ticket: TICKET,
        status: "failed",
        reason: "sdk-overloaded-exhausted",
        orchDir,
        signalFile: signalPath(),
        retrySafe: true,
      },
      { spawn: spawnStub },
    );
    return readSignal();
  };

  function classifyWithAttempts(raw, attempts) {
    const items = buildRecoveryItems([projection(raw)]);
    return defaultClassifyTicket(items[0].evidence, {
      ticket: TICKET,
      readIntentAttempts: () => attempts,
      log: () => {},
    });
  }

  // ROUTE A / A': RECOVERY_MAX_ATTEMPTS defaults to 2 and the counter is the
  // ticket's GENERIC recovery-intent counter — a ticket that already took two
  // unrelated recovery fixes got ZERO retries and escalated on the FIRST overload.
  test("an EXHAUSTED retry budget defers a transient cause — it never escalates", () => {
    const d = classifyWithAttempts(overload(), 99);
    expect(d.decision).toBe("defer");
    expect(d.fix_class).not.toBe("human");
    expect(d.details.reason).toContain("transient");
  });

  // POSITIVE CONTROL — a NON-transient retry-safe failure with the same exhausted
  // budget still escalates with the CTL-1679 coverage-gap ask. Widen the gate and
  // this fails.
  test("POSITIVE CONTROL: a non-transient retry-safe failure still escalates at budget end", () => {
    writeInFlightSignal();
    defaultEmitBackstop(
      {
        phase: PHASE,
        ticket: TICKET,
        status: "failed",
        reason: "cluster_fence_stale_unrecognized",
        orchDir,
        signalFile: signalPath(),
        retrySafe: true,
      },
      { spawn: spawnStub },
    );
    const d = classifyWithAttempts(readSignal(), 99);
    expect(d.decision).toBe("escalate");
    expect(d.fix_class).toBe("human");
  });
});
