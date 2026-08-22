// unstuck-escalate-seam.test.mjs — CTL-1641 unit tests for the production
// escalate seam factory. All IO is stubbed via deps injection; no real git/fs/Linear.

import { describe, test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

// CTL-1641 Codex #3005 P2 remediation — the two masking cases the injected-stub tests
// above cannot reach: (1) a genuine non-confirming LABEL write must surface a `label`
// error (not be swallowed as benign like a belief-owner deferral), and (2) the escalation
// COMMENT must be idempotent per (ticket,category,phase) so a still-stuck candidate is not
// re-commented on every sweep. Both exercise the DEFAULT bindings against a real temp
// orchDir so the marker files and the labelOnce/onOutcome path actually run.
describe("buildUnstuckEscalateSeam — CTL-1641 Codex #3005 P2 remediation", () => {
  // ⛔ CTL-2159: "a genuine non-confirming LABEL write" is no longer reachable —
  // this seam publishes through the classifier and never calls applyLabel for
  // needs-human, so a Linear failure cannot manufacture a `label` error. The
  // surviving property is the one the seam exists for: the escalation is recorded
  // and the comment posts, regardless of what the Linear transport would return.
  test("CTL-2159 — a would-be-failing Linear transport neither blocks nor is consulted", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl1641-labelfail-"));
    mkdirSync(join(dir, "workers", "CTL-1"), { recursive: true });
    const applyCalls = [];
    const seam = buildUnstuckEscalateSeam({
      orchDir: dir,
      env: {},                                                     // not belief-owner → the real publish path
      writeStatus: {
        applyLabel: (a) => {
          applyCalls.push(a);
          return { applied: false, reason: "rate-limited" };
        },
      },
      // applyNeedsHuman intentionally NOT injected — exercise the default structured binding.
      postComment: () => true,
      captureEvidence: () => ({ reason: "unknown", porcelainLines: [], prState: null, remediateHistory: [] }),
      commitsAhead: () => 2,
    });
    const r = seam(candidate("unknown", "CTL-1", "verify"), decision("unknown"));
    expect(applyCalls).toEqual([]);
    expect(r.labelApplied).toBe(true);
    expect(r.errors.some((e) => e.sideEffect === "label")).toBe(false);
    expect(r.commentPosted).toBe(true);                            // independence: the comment still posts
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
      postComment: () => true,
      captureEvidence: () => ({ reason: "unknown", porcelainLines: [], prState: null, remediateHistory: [] }),
      commitsAhead: () => 1,
    });
    const r = seam(candidate("unknown", "CTL-2", "verify"), decision("unknown"));
    expect(r.labelApplied).toBe(false);
    expect(r.errors.some((e) => e.sideEffect === "label")).toBe(false);  // benign no-op — not a failure
  });

  test("the escalation comment posts once per (ticket,category,phase); a second sweep is suppressed by the marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl1641-commentonce-"));
    mkdirSync(join(dir, "workers", "CTL-3"), { recursive: true });
    let posts = 0;
    const seam = buildUnstuckEscalateSeam({
      orchDir: dir,
      env: {},
      applyNeedsHuman: () => true,
      postComment: () => { posts++; return true; },
      captureEvidence: () => ({ reason: "unknown", porcelainLines: [], prState: null, remediateHistory: [] }),
      commitsAhead: () => 2,
    });
    const c = candidate("unknown", "CTL-3", "verify");
    const d = decision("unknown");
    const r1 = seam(c, d);
    const r2 = seam(c, d);                                          // same still-stuck candidate, next sweep
    expect(posts).toBe(1);                                          // comment posted exactly once
    expect(r1.commentPosted).toBe(true);
    expect(r2.commentPosted).toBe(true);                           // second call satisfied by the marker
    expect(r2.errors).toEqual([]);
    expect(existsSync(join(dir, "workers", "CTL-3", ".unstuck-escalate-comment-unknown-verify.applied"))).toBe(true);
  });

  test("a failed comment post does NOT write the idempotency marker — the next sweep retries", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl1641-commentretry-"));
    mkdirSync(join(dir, "workers", "CTL-4"), { recursive: true });
    let posts = 0;
    const seam = buildUnstuckEscalateSeam({
      orchDir: dir,
      env: {},
      applyNeedsHuman: () => true,
      postComment: () => { posts++; return posts >= 2; },          // fail the first post, succeed the second
      captureEvidence: () => ({ reason: "unknown", porcelainLines: [], prState: null, remediateHistory: [] }),
      commitsAhead: () => 2,
    });
    const c = candidate("unknown", "CTL-4", "verify");
    const d = decision("unknown");
    const marker = join(dir, "workers", "CTL-4", ".unstuck-escalate-comment-unknown-verify.applied");
    const r1 = seam(c, d);
    expect(r1.commentPosted).toBe(false);
    expect(r1.errors.some((e) => e.sideEffect === "comment")).toBe(true);
    expect(existsSync(marker)).toBe(false);                        // no marker on failure
    const r2 = seam(c, d);                                          // retry on the next sweep
    expect(r2.commentPosted).toBe(true);
    expect(posts).toBe(2);
    expect(existsSync(marker)).toBe(true);                         // marker written after the confirmed post
  });
});

// CTL-1641 verify LOW: every test above injects postComment, so the production
// DEFAULT _post binding (helper-path resolution + spawn) is 0% exercised — the
// exact path where the verify HIGH bug lived (PLUGIN_ROOT/cwd-relative resolution
// that silently missed for the daemon). These guard the default binding directly.
describe("buildUnstuckEscalateSeam default _post binding — CTL-1641 verify LOW", () => {
  test("the module's sibling-relative helper path resolves to a real file (guards the URL fallback the HIGH bug missed)", () => {
    // The source module resolves `new URL('../lib/linear-comment-post.sh', import.meta.url)`.
    // This test file sits in the same directory (execution-core/), so `../lib/...` from here
    // resolves identically — it must point at a file that actually exists (cwd/env-independent),
    // which the old `process.env.PLUGIN_ROOT ?? process.cwd()` + 'scripts/lib/...' did not.
    const expected = fileURLToPath(new URL("../lib/linear-comment-post.sh", import.meta.url));
    expect(existsSync(expected)).toBe(true);
    expect(expected.endsWith("plugins/dev/scripts/lib/linear-comment-post.sh")).toBe(true);
  });

  test("default _post (no postComment injection) spawns the resolved helper with [ticket, body] and reports its exit status", () => {
    // Bind a hermetic stub as the helper via the CATALYST_COMMENT_POST_HELPER seam — the same
    // env override the sibling daemon modules honor — and exercise the REAL default _post path
    // (spawnSync of COMMENT_HELPER), which no other test covers.
    const dir = mkdtempSync(join(tmpdir(), "ctl1641-escalate-"));
    const argvOut = join(dir, "argv.txt");
    const stub = join(dir, "stub-comment-post.sh");
    writeFileSync(stub, `#!/usr/bin/env bash\nprintf '%s\\n' "$1" "$2" > "${argvOut}"\nexit 0\n`);
    chmodSync(stub, 0o755);

    const prev = process.env.CATALYST_COMMENT_POST_HELPER;
    process.env.CATALYST_COMMENT_POST_HELPER = stub;
    try {
      const seam = buildUnstuckEscalateSeam({
        orchDir: dir,
        applyNeedsHuman: () => true,           // label still injected (not under test here)
        captureEvidence: () => ({ reason: "unknown", porcelainLines: [], prState: null, remediateHistory: [] }),
        commitsAhead: () => 2,
        // postComment intentionally NOT injected — exercise the production default.
      });
      const r = seam(candidate("unknown", "CTL-77", "verify"), decision("unknown"));
      expect(r.commentPosted).toBe(true);
      expect(r.errors).toEqual([]);
      const [ticketArg, bodyArg] = readFileSync(argvOut, "utf8").split("\n");
      expect(ticketArg).toBe("CTL-77");
      expect(bodyArg).toContain("CTL-77");   // the authored escalation body reached the helper
    } finally {
      if (prev === undefined) delete process.env.CATALYST_COMMENT_POST_HELPER;
      else process.env.CATALYST_COMMENT_POST_HELPER = prev;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CTL-2159 — the class gate on the authored Linear comment.
// ─────────────────────────────────────────────────────────────────────────────
//
// ⛔ WHY. With the needs-human label deleted, THIS comment became the surviving
// contradiction of the epic's central promise ("SYSTEM → zero per-ticket
// artifacts"): it posted on EVERY escalation, gated only by a per-(ticket,
// category, phase) idempotency marker and never by the stall class. A provider
// outage across N tickets wrote N authored comments into a 300-writes/day budget
// for a condition the ONE fleet alert already names and that clears itself.
describe("CTL-2159 — the comment is gated on the stall CLASS", () => {
  const seamWith = (labelResult, posted) =>
    buildUnstuckEscalateSeam({
      orchDir: "/tmp/orch-ctl2159",
      applyNeedsHuman: () => labelResult,
      postComment: (t, b) => { posted.push([t, b]); return true; },
      captureEvidence: () => ({ reason: "unknown", porcelainLines: [], prState: null, remediateHistory: [] }),
      commitsAhead: () => 0,
    });

  test("a SYSTEM verdict posts NO per-ticket comment", () => {
    const posted = [];
    const r = seamWith({ applied: true, stallClass: "system" }, posted)(
      candidate("attempts-exhausted", "CTL-800", "implement"),
      decision("remediate-cap"),
    );
    expect(posted).toEqual([]);
    expect(r.commentPosted).toBe(false);
    expect(r.stallClass).toBe("system");
    expect(r.errors).toEqual([]); // a withheld comment is NOT a side-effect failure
  });

  test("a MOOT verdict posts NO per-ticket comment", () => {
    const posted = [];
    seamWith({ applied: true, stallClass: "moot" }, posted)(
      candidate("empty-branch", "CTL-801", "implement"),
      decision("empty-branch"),
    );
    expect(posted).toEqual([]);
  });

  test("POSITIVE CONTROL: HELD and ASK still comment — silence is not the default", () => {
    // HELD means "a person must look"; silencing it would ship the plan's named
    // worst outcome (no label, no ask, no alert, no comment).
    for (const klass of ["held", "ask"]) {
      const posted = [];
      seamWith({ applied: true, stallClass: klass }, posted)(
        candidate("unknown", `CTL-80${klass.length}`, "implement"),
        decision("unknown"),
      );
      expect(posted).toHaveLength(1);
    }
  });

  test("FAIL-OPEN: an unknown/absent class still comments", () => {
    // An injected label stub returns a bare boolean and a belief-owner deferral
    // publishes nothing. Absence of evidence is not a SYSTEM verdict.
    const posted = [];
    seamWith(true, posted)(candidate("unknown", "CTL-804", "implement"), decision("unknown"));
    expect(posted).toHaveLength(1);
  });

  test("the sweep's reason REACHES the label seam (it was structurally unreachable)", () => {
    // The default _applyLabel closure was built at seam-construction time as
    // `(ticket) => …` while `reason` was computed inside escalate(), so every
    // unstuck-sweep escalation classified HELD via the no-reason rule.
    const seen = [];
    buildUnstuckEscalateSeam({
      orchDir: "/tmp/orch-ctl2159",
      applyNeedsHuman: (ticket, reason) => { seen.push({ ticket, reason }); return true; },
      postComment: () => true,
      captureEvidence: () => ({ reason: "unknown", porcelainLines: [], prState: null, remediateHistory: [] }),
      commitsAhead: () => 0,
    })(candidate("remediate-cycle-cap-exhausted", "CTL-805", "verify"), decision("remediate-cap"));
    expect(seen).toEqual([{ ticket: "CTL-805", reason: "remediate-cycle-cap-exhausted" }]);
  });
});

// ⛔ THE SECOND SWEEP. A still-stuck SYSTEM ticket is re-censused on the next
// interval, and by then publishEscalation early-returns on its own once-marker.
// If that no-op reported no class, the gate would fail open and post the comment
// it withheld the first time — "zero per-ticket artifacts, except on sweep two".
describe("CTL-2159 — the class survives a marker-guarded re-publish", () => {
  test("a SYSTEM ticket already published stays comment-free on the next sweep", () => {
    const orchDir = mkdtempSync(join(tmpdir(), "ctl2159-resweep-"));
    mkdirSync(join(orchDir, "workers", "CTL-810"), { recursive: true });
    const posted = [];
    const seam = buildUnstuckEscalateSeam({
      orchDir,
      writeStatus: { applyLabel: () => ({ applied: true }) },
      env: { CATALYST_ESCALATION_ASK: "off" },
      log: { info: () => {}, warn: () => {} },
      postComment: (t, b) => { posted.push([t, b]); return true; },
      captureEvidence: () => ({ reason: "attempts-exhausted", porcelainLines: [], prState: null, remediateHistory: [] }),
      commitsAhead: () => 0,
    });
    const cand = candidate("attempts-exhausted", "CTL-810", "implement");
    const dec = decision("remediate-cap");
    const first = seam(cand, dec);
    const second = seam(cand, dec);
    expect(first.stallClass).toBe("system");
    // POSITIVE CONTROL: the second call really did take the marker-guarded no-op
    // path — it applied nothing — and STILL knew the class.
    expect(second.labelApplied).toBe(false);
    expect(second.stallClass).toBe("system");
    expect(posted).toEqual([]);
    rmSync(orchDir, { recursive: true, force: true });
  });
});
