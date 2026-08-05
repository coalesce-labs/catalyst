// unstuck-escalate-seam.test.mjs — CTL-1641 unit tests for the production
// escalate seam factory. All IO is stubbed via deps injection; no real git/fs/Linear.

import { describe, test, expect } from "bun:test";
import { buildUnstuckEscalateSeam } from "./unstuck-escalate-seam.mjs";

function candidate(reason = "unknown", ticket = "CTL-1", phase = "implement") {
  return { ticket, phase, evidence: { reason, ticket, phase } };
}

function decision(category = "unknown") {
  return { category, action: "escalate" };
}

describe("buildUnstuckEscalateSeam — CTL-1641", () => {
  test("applies the label BEFORE posting the comment (label lands even when the comment throws)", () => {
    const order = [];
    const seam = buildUnstuckEscalateSeam({
      orchDir: "/tmp/orch",
      applyNeedsHuman: () => { order.push("label"); return true; },
      postComment: () => { order.push("comment"); throw new Error("linear down"); },
      captureEvidence: () => ({ reason: "unknown", porcelainLines: [], prState: null, remediateHistory: [] }),
      commitsAhead: () => 3,
    });
    const r = seam(candidate(), decision());
    expect(order).toEqual(["label", "comment"]);          // label first
    expect(r.labelApplied).toBe(true);                     // label still landed
    expect(r.commentPosted).toBe(false);
    expect(r.errors).toEqual([{ sideEffect: "comment", err: "linear down" }]);
  });

  test("comment body is authored from evidence — empty-branch dispatch when commitsAhead===0", () => {
    let postedBody = null;
    const seam = buildUnstuckEscalateSeam({
      orchDir: "/tmp/orch",
      applyNeedsHuman: () => true,
      postComment: (ticket, body) => { postedBody = body; return true; },
      captureEvidence: () => ({ reason: "unknown", porcelainLines: [], prState: null, remediateHistory: [] }),
      commitsAhead: () => 0,
    });
    const r = seam(candidate("unknown", "CTL-9", "implement"), decision("unknown"));
    expect(r.commentPosted).toBe(true);
    expect(postedBody).toContain("empty branch");
    expect(postedBody).toContain("CTL-9");
  });

  test("remediate-cap dispatch uses the authored cap write-up", () => {
    let body = null;
    const seam = buildUnstuckEscalateSeam({
      orchDir: "/tmp/orch",
      applyNeedsHuman: () => true,
      postComment: (t, b) => { body = b; return true; },
      captureEvidence: () => ({ reason: "remediate-cycle-cap-exhausted", porcelainLines: [], prState: null, remediateHistory: [] }),
      commitsAhead: () => 5,
    });
    seam(candidate("remediate-cycle-cap-exhausted"), decision("remediate-cap"));
    expect(body).toContain("verify/remediate cap exhausted");
  });

  test("a failed label apply (returns false) is NOT an error (belief-owner deferral is legitimate); comment still posts", () => {
    const seam = buildUnstuckEscalateSeam({
      orchDir: "/tmp/orch",
      applyNeedsHuman: () => false,          // belief-owner deferral or non-confirming apply
      postComment: () => true,
      captureEvidence: () => ({ reason: "unknown", porcelainLines: [], prState: null, remediateHistory: [] }),
      commitsAhead: () => 2,
    });
    const r = seam(candidate(), decision());
    expect(r.labelApplied).toBe(false);
    expect(r.commentPosted).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test("a THROWING label apply is recorded as a 'label' side-effect error; the comment still posts", () => {
    const seam = buildUnstuckEscalateSeam({
      orchDir: "/tmp/orch",
      applyNeedsHuman: () => { throw new Error("label API 429"); },
      postComment: () => true,
      captureEvidence: () => ({ reason: "unknown", porcelainLines: [], prState: null, remediateHistory: [] }),
      commitsAhead: () => 1,
    });
    const r = seam(candidate(), decision());
    expect(r.errors).toEqual([{ sideEffect: "label", err: "label API 429" }]);
    expect(r.commentPosted).toBe(true);      // independence: comment still attempted
  });

  test("evidence capture failure degrades — still authors a generic comment + applies the label", () => {
    const seam = buildUnstuckEscalateSeam({
      orchDir: "/tmp/orch",
      applyNeedsHuman: () => true,
      postComment: () => true,
      captureEvidence: () => { throw new Error("git unavailable"); },
      commitsAhead: () => { throw new Error("no head"); },
    });
    const r = seam(candidate("unknown", "CTL-5", "verify"), decision("unknown"));
    expect(r.labelApplied).toBe(true);
    expect(r.commentPosted).toBe(true);      // generic write-up authored from ticket/phase alone
  });

  test("postComment returning falsy records a 'comment' error", () => {
    const seam = buildUnstuckEscalateSeam({
      orchDir: "/tmp/orch",
      applyNeedsHuman: () => true,
      postComment: () => false,
      captureEvidence: () => ({ reason: "unknown", porcelainLines: [], prState: null, remediateHistory: [] }),
      commitsAhead: () => 1,
    });
    const r = seam(candidate(), decision());
    expect(r.commentPosted).toBe(false);
    expect(r.errors.some(e => e.sideEffect === "comment")).toBe(true);
  });

  test("returns { ticket, phase, labelApplied, commentPosted, errors } on the happy path", () => {
    const seam = buildUnstuckEscalateSeam({
      orchDir: "/tmp/orch",
      applyNeedsHuman: () => true,
      postComment: () => true,
      captureEvidence: () => ({ reason: "unknown", porcelainLines: [], prState: null, remediateHistory: [] }),
      commitsAhead: () => 2,
    });
    const r = seam(candidate("unknown", "CTL-42", "verify"), decision("unknown"));
    expect(r).toMatchObject({ ticket: "CTL-42", phase: "verify", labelApplied: true, commentPosted: true, errors: [] });
  });
});
