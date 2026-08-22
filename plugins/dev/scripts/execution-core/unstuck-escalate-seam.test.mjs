// unstuck-escalate-seam.test.mjs — CTL-1641 unit tests for the production
// escalate seam factory. All IO is stubbed via deps injection; no real git/fs/Linear.
//
// CTL-1871 COORD-29: comment posting is now atomic with the label (inside the gate);
// this seam no longer owns a separate postComment step.  Tests updated accordingly.

import { describe, test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildUnstuckEscalateSeam } from "./unstuck-escalate-seam.mjs";

function candidate(reason = "unknown", ticket = "CTL-1", phase = "implement") {
  return { ticket, phase, evidence: { reason, ticket, phase } };
}

function decision(category = "unknown") {
  return { category, action: "escalate" };
}

describe("buildUnstuckEscalateSeam — CTL-1641", () => {
  // CTL-1871: the seam now passes a coerced explanation (carrying the authored
  // escalation body as call_to_action) to _applyLabel.  Verify that the body
  // reaches the gate and that commentPosted mirrors labelApplied.
  test("explanation with authored body is passed to applyNeedsHuman; commentPosted mirrors labelApplied", () => {
    let capturedExpl = null;
    const seam = buildUnstuckEscalateSeam({
      orchDir: "/tmp/orch",
      applyNeedsHuman: (_ticket, explanation) => { capturedExpl = explanation; return true; },
      captureEvidence: () => ({ reason: "unknown", porcelainLines: [], prState: null, remediateHistory: [] }),
      commitsAhead: () => 3,
    });
    const r = seam(candidate(), decision());
    expect(capturedExpl).not.toBeNull();
    expect(typeof capturedExpl.call_to_action).toBe("string");
    expect(capturedExpl.call_to_action.length).toBeGreaterThan(0);
    expect(r.labelApplied).toBe(true);
    expect(r.commentPosted).toBe(true);   // mirrors labelApplied
    expect(r.errors).toEqual([]);
  });

  test("comment body is authored from evidence — empty-branch dispatch when commitsAhead===0", () => {
    let capturedExpl = null;
    const seam = buildUnstuckEscalateSeam({
      orchDir: "/tmp/orch",
      applyNeedsHuman: (_ticket, expl) => { capturedExpl = expl; return true; },
      captureEvidence: () => ({ reason: "unknown", porcelainLines: [], prState: null, remediateHistory: [] }),
      commitsAhead: () => 0,
    });
    const r = seam(candidate("unknown", "CTL-9", "implement"), decision("unknown"));
    expect(r.commentPosted).toBe(true);
    expect(capturedExpl?.call_to_action).toContain("empty branch");
    expect(capturedExpl?.call_to_action).toContain("CTL-9");
  });

  test("remediate-cap dispatch uses the authored cap write-up", () => {
    let capturedExpl = null;
    const seam = buildUnstuckEscalateSeam({
      orchDir: "/tmp/orch",
      applyNeedsHuman: (_t, expl) => { capturedExpl = expl; return true; },
      captureEvidence: () => ({ reason: "remediate-cycle-cap-exhausted", porcelainLines: [], prState: null, remediateHistory: [] }),
      commitsAhead: () => 5,
    });
    seam(candidate("remediate-cycle-cap-exhausted"), decision("remediate-cap"));
    expect(capturedExpl?.call_to_action).toContain("verify/remediate cap exhausted");
  });

  test("a label apply returning false (belief-owner deferral) leaves commentPosted false with no errors", () => {
    const seam = buildUnstuckEscalateSeam({
      orchDir: "/tmp/orch",
      applyNeedsHuman: () => false,
      captureEvidence: () => ({ reason: "unknown", porcelainLines: [], prState: null, remediateHistory: [] }),
      commitsAhead: () => 2,
    });
    const r = seam(candidate(), decision());
    expect(r.labelApplied).toBe(false);
    expect(r.commentPosted).toBe(false);  // mirrors labelApplied
    expect(r.errors).toEqual([]);
  });

  test("a THROWING label apply records a 'label' side-effect error; commentPosted is false", () => {
    const seam = buildUnstuckEscalateSeam({
      orchDir: "/tmp/orch",
      applyNeedsHuman: () => { throw new Error("label API 429"); },
      captureEvidence: () => ({ reason: "unknown", porcelainLines: [], prState: null, remediateHistory: [] }),
      commitsAhead: () => 1,
    });
    const r = seam(candidate(), decision());
    expect(r.errors).toEqual([{ sideEffect: "label", err: "label API 429" }]);
    expect(r.labelApplied).toBe(false);
    expect(r.commentPosted).toBe(false);
  });

  test("label returning { applied: false, error } surfaces as a 'label' error", () => {
    const seam = buildUnstuckEscalateSeam({
      orchDir: "/tmp/orch",
      applyNeedsHuman: () => ({ applied: false, error: "rate-limited" }),
      captureEvidence: () => ({ reason: "unknown", porcelainLines: [], prState: null, remediateHistory: [] }),
      commitsAhead: () => 1,
    });
    const r = seam(candidate(), decision());
    expect(r.labelApplied).toBe(false);
    expect(r.commentPosted).toBe(false);
    expect(r.errors.some((e) => e.sideEffect === "label")).toBe(true);
  });

  test("evidence capture failure degrades — still calls applyNeedsHuman with a degraded explanation", () => {
    let called = false;
    const seam = buildUnstuckEscalateSeam({
      orchDir: "/tmp/orch",
      applyNeedsHuman: () => { called = true; return true; },
      captureEvidence: () => { throw new Error("git unavailable"); },
      commitsAhead: () => { throw new Error("no head"); },
    });
    const r = seam(candidate("unknown", "CTL-5", "verify"), decision("unknown"));
    expect(called).toBe(true);
    expect(r.labelApplied).toBe(true);
    expect(r.commentPosted).toBe(true);
  });

  test("returns { ticket, phase, labelApplied, commentPosted, errors } on the happy path", () => {
    const seam = buildUnstuckEscalateSeam({
      orchDir: "/tmp/orch",
      applyNeedsHuman: () => true,
      captureEvidence: () => ({ reason: "unknown", porcelainLines: [], prState: null, remediateHistory: [] }),
      commitsAhead: () => 2,
    });
    const r = seam(candidate("unknown", "CTL-42", "verify"), decision("unknown"));
    expect(r).toMatchObject({ ticket: "CTL-42", phase: "verify", labelApplied: true, commentPosted: true, errors: [] });
  });
});

// CTL-1641 Codex #3005 P2 remediation — these tests cover the DEFAULT label binding
// (not injected): (1) a genuine non-confirming write must surface a `label` error, and
// (2) an already-applied marker is a benign no-op.
//
// CTL-1871: comment idempotency is now owned by label-guard.mjs (the .needs-human-ask.applied
// marker), so the old per-seam comment-marker tests are removed.
describe("buildUnstuckEscalateSeam — CTL-1641 Codex #3005 P2 remediation", () => {
  test("a genuine non-confirming label write (applyLabel ran, applied:false) surfaces a 'label' error", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl1641-labelfail-"));
    mkdirSync(join(dir, "workers", "CTL-1"), { recursive: true });
    const seam = buildUnstuckEscalateSeam({
      orchDir: dir,
      env: {},                                                     // not belief-owner → real labelOnce path
      writeStatus: { applyLabel: () => ({ applied: false, reason: "rate-limited" }) },
      // applyNeedsHuman intentionally NOT injected — exercise the default structured binding.
      captureEvidence: () => ({ reason: "unknown", porcelainLines: [], prState: null, remediateHistory: [] }),
      commitsAhead: () => 2,
    });
    const r = seam(candidate("unknown", "CTL-1", "verify"), decision("unknown"));
    expect(r.labelApplied).toBe(false);
    expect(r.errors.some((e) => e.sideEffect === "label")).toBe(true);
    // commentPosted mirrors labelApplied (atomic — gate handles both)
    expect(r.commentPosted).toBe(false);
  });

  test("an already-applied needs-human marker (labelOnce no-op) is NOT a label error", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl1641-labelnoop-"));
    const wdir = join(dir, "workers", "CTL-2");
    mkdirSync(wdir, { recursive: true });
    writeFileSync(join(wdir, ".linear-label-needs-human.applied"), "");  // a prior lifetime already landed it
    const seam = buildUnstuckEscalateSeam({
      orchDir: dir,
      env: {},
      writeStatus: { applyLabel: () => { throw new Error("applyLabel must not run on a marker no-op"); } },
      captureEvidence: () => ({ reason: "unknown", porcelainLines: [], prState: null, remediateHistory: [] }),
      commitsAhead: () => 1,
    });
    const r = seam(candidate("unknown", "CTL-2", "verify"), decision("unknown"));
    expect(r.labelApplied).toBe(false);
    expect(r.errors.some((e) => e.sideEffect === "label")).toBe(false);  // benign no-op — not a failure
  });
});
