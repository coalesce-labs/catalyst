// unstuck-sweep.test.mjs — CTL-1064 pure router, action driver, census.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyStalledTicket,
  STALL_CATEGORY_MAP,
  UNSTUCK_SWEEP_INTENT_KIND,
  UNSTUCK_SWEEP_EVENT_TYPES,
  defaultCollectUnstuckCandidates,
  runUnstuckSweepPass,
  buildAuditComment,
  defaultPostUnstuckComment,
  emitUnstuckEvent,
} from "./unstuck-sweep.mjs";
import { buildUnstuckActSeams } from "./unstuck-act-seams.mjs";

// ---------------------------------------------------------------------------
// classifyStalledTicket — pure top-level router (CTL-1064)
// ---------------------------------------------------------------------------
describe("classifyStalledTicket — pure top-level router (CTL-1064)", () => {
  test("escalation-ask-cap stalls are SKIPPED — already terminally escalated by CTL-1442 (no re-ask loop)", () => {
    const r = classifyStalledTicket({ reason: "escalation-ask-cap" });
    expect(r).toEqual({ category: "skip", action: "skip" });
  });

  test("rebase_refused_dirty_tree → dirty-tree/clear-noise-and-retry", () => {
    const r = classifyStalledTicket({ reason: "rebase_refused_dirty_tree" });
    expect(r.category).toBe("dirty-tree");
    expect(r.action).toBe("clear-noise-and-retry");
  });

  test("source_conflict_ctl708_unavailable → source-conflict/force-push-if-clean", () => {
    const r = classifyStalledTicket({ reason: "source_conflict_ctl708_unavailable" });
    expect(r.category).toBe("source-conflict");
    expect(r.action).toBe("force-push-if-clean");
  });

  test("orphan-sweep-stale (normalized from failureReason) → orphan-stale", () => {
    const r = classifyStalledTicket({ reason: "orphan-sweep-stale" });
    expect(r.category).toBe("orphan-stale");
    expect(r.action).toBe("emit-phase-complete-if-merged");
  });

  test("remediate-cycle-cap-exhausted → remediate-cap/escalate", () => {
    const r = classifyStalledTicket({ reason: "remediate-cycle-cap-exhausted" });
    expect(r.category).toBe("remediate-cap");
    expect(r.action).toBe("escalate");
  });

  test("unknown/unrecognized reason → unknown/escalate", () => {
    const r = classifyStalledTicket({ reason: "some-unknown-reason" });
    expect(r.category).toBe("unknown");
    expect(r.action).toBe("escalate");
  });

  test("empty-branch-like reason (unrecognized) → unknown/escalate", () => {
    const r = classifyStalledTicket({ reason: "empty_branch:0_commits_ahead_of_origin/main" });
    expect(r.category).toBe("unknown");
    expect(r.action).toBe("escalate");
  });

  test("null reason → unknown/escalate", () => {
    const r = classifyStalledTicket({ reason: null });
    expect(r.category).toBe("unknown");
    expect(r.action).toBe("escalate");
  });

  test("undefined reason → unknown/escalate", () => {
    const r = classifyStalledTicket({ reason: undefined });
    expect(r.category).toBe("unknown");
    expect(r.action).toBe("escalate");
  });

  test("liveSessionInWorktree:true → action:skip regardless of reason", () => {
    const r = classifyStalledTicket({ reason: "rebase_refused_dirty_tree", liveSessionInWorktree: true });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("live-session");
  });

  test("linearTerminal:true → action:skip regardless of reason", () => {
    const r = classifyStalledTicket({ reason: "source_conflict_ctl708_unavailable", linearTerminal: true });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("linear-terminal");
  });

  test("liveSession takes precedence over linearTerminal", () => {
    const r = classifyStalledTicket({ reason: "rebase_refused_dirty_tree", liveSessionInWorktree: true, linearTerminal: true });
    expect(r.reason).toBe("live-session");
  });
});

// ---------------------------------------------------------------------------
// UNSTUCK_SWEEP_INTENT_KIND constant
// ---------------------------------------------------------------------------
describe("UNSTUCK_SWEEP_INTENT_KIND (CTL-1064)", () => {
  test("equals 'unstuck-sweep'", () => {
    expect(UNSTUCK_SWEEP_INTENT_KIND).toBe("unstuck-sweep");
  });
});

// ---------------------------------------------------------------------------
// UNSTUCK_SWEEP_EVENT_TYPES — 10 unique strings, all starting with 'unstuck.'
// ---------------------------------------------------------------------------
describe("UNSTUCK_SWEEP_EVENT_TYPES (CTL-1064)", () => {
  test("has exactly 10 strings", () => {
    expect(UNSTUCK_SWEEP_EVENT_TYPES.length).toBe(10);
  });
  test("all start with 'unstuck.'", () => {
    for (const t of UNSTUCK_SWEEP_EVENT_TYPES) {
      expect(t.startsWith("unstuck.")).toBe(true);
    }
  });
  test("all are unique", () => {
    const uniq = new Set(UNSTUCK_SWEEP_EVENT_TYPES);
    expect(uniq.size).toBe(10);
  });
  test("is frozen", () => {
    expect(Object.isFrozen(UNSTUCK_SWEEP_EVENT_TYPES)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runUnstuckSweepPass — action driver (CTL-1064)
// ---------------------------------------------------------------------------
describe("runUnstuckSweepPass — action driver (CTL-1064)", () => {
  function makeCandidate(overrides = {}) {
    return {
      ticket: "CTL-TEST",
      phase: "implement",
      evidence: {
        reason: "rebase_refused_dirty_tree",
        ticket: "CTL-TEST",
        phase: "implement",
        liveSessionInWorktree: false,
        linearTerminal: false,
      },
      ...overrides,
    };
  }

  test("mode:'off' → pass entirely skipped (census never called, no events, no intents)", () => {
    let censusCount = 0;
    let emitCount = 0;
    let intentCount = 0;
    const report = runUnstuckSweepPass({
      mode: "off",
      collectCandidates: () => { censusCount++; return [makeCandidate()]; },
      emit: () => { emitCount++; },
      recordIntent: () => { intentCount++; },
    });
    expect(censusCount).toBe(0);
    expect(emitCount).toBe(0);
    expect(intentCount).toBe(0);
    expect(report.acted).toEqual([]);
    expect(report.wouldAct).toEqual([]);
  });

  test("mode:'shadow' → emits would.* only; no act seam, no intent, no comment", () => {
    const emitted = [];
    const actCalled = [];
    const intentCalled = [];
    const commentCalled = [];
    const report = runUnstuckSweepPass({
      mode: "shadow",
      collectCandidates: () => [makeCandidate()],
      actByCategory: { "dirty-tree": () => { actCalled.push(1); } },
      emit: (type, fields) => { emitted.push({ type, fields }); },
      recordIntent: () => { intentCalled.push(1); },
      postComment: () => { commentCalled.push(1); },
    });
    expect(actCalled).toHaveLength(0);
    expect(intentCalled).toHaveLength(0);
    expect(commentCalled).toHaveLength(0);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].type).toBe("unstuck.would.clear-noise");
    expect(report.wouldAct).toHaveLength(1);
    expect(report.acted).toHaveLength(0);
    expect(report.escalated).toHaveLength(0);
  });

  test("mode:'shadow' for escalate category → emits unstuck.would.escalate", () => {
    const emitted = [];
    const report = runUnstuckSweepPass({
      mode: "shadow",
      collectCandidates: () => [makeCandidate({
        evidence: { reason: "remediate-cycle-cap-exhausted", ticket: "CTL-TEST", phase: "implement", liveSessionInWorktree: false, linearTerminal: false },
      })],
      emit: (type) => { emitted.push(type); },
    });
    expect(emitted).toContain("unstuck.would.escalate");
    expect(report.wouldEscalate).toHaveLength(1);
  });

  test("mode:'enforce' + clearable → calls act seam + recordIntent + postComment + emits enforce event", () => {
    const actCalled = [];
    const intentCalled = [];
    const commentCalled = [];
    const emitted = [];
    runUnstuckSweepPass({
      mode: "enforce",
      collectCandidates: () => [makeCandidate()],
      actByCategory: { "dirty-tree": (c, d) => { actCalled.push({ c, d }); } },
      emit: (type) => { emitted.push(type); },
      recordIntent: (kind, subject) => { intentCalled.push({ kind, subject }); },
      isIntentEffective: () => false,
      postComment: (t, cat, p) => { commentCalled.push({ t, cat, p }); },
    });
    expect(actCalled).toHaveLength(1);
    expect(intentCalled).toHaveLength(1);
    expect(intentCalled[0].kind).toBe("unstuck-sweep");
    expect(intentCalled[0].subject).toBe("CTL-TEST/implement");
    expect(commentCalled).toHaveLength(1);
    expect(commentCalled[0].cat).toBe("dirty-tree");
    expect(emitted).toContain("unstuck.cleared.noise");
  });

  test("mode:'enforce' + escalate category → calls escalate seam + postComment + emits unstuck.escalated", () => {
    const escalateCalled = [];
    const commentCalled = [];
    const emitted = [];
    runUnstuckSweepPass({
      mode: "enforce",
      collectCandidates: () => [makeCandidate({
        evidence: { reason: "remediate-cycle-cap-exhausted", ticket: "CTL-TEST", phase: "implement", liveSessionInWorktree: false, linearTerminal: false },
      })],
      escalate: (c) => { escalateCalled.push(c.ticket); },
      emit: (type) => { emitted.push(type); },
      postComment: (t) => { commentCalled.push(t); },
    });
    expect(escalateCalled).toContain("CTL-TEST");
    expect(emitted).toContain("unstuck.escalated");
    expect(commentCalled).toContain("CTL-TEST");
  });

  test("mode:'enforce' + skip (live session) → no act, no emit, no intent", () => {
    const actCalled = [];
    const emitted = [];
    const intentCalled = [];
    runUnstuckSweepPass({
      mode: "enforce",
      collectCandidates: () => [makeCandidate({
        evidence: { reason: "rebase_refused_dirty_tree", ticket: "CTL-TEST", phase: "implement", liveSessionInWorktree: true, linearTerminal: false },
      })],
      actByCategory: { "dirty-tree": () => { actCalled.push(1); } },
      emit: () => { emitted.push(1); },
      recordIntent: () => { intentCalled.push(1); },
    });
    expect(actCalled).toHaveLength(0);
    expect(emitted).toHaveLength(0);
    expect(intentCalled).toHaveLength(0);
  });

  test("mode:'enforce' + isIntentEffective=true → skips action (storm-prevention)", () => {
    const actCalled = [];
    const report = runUnstuckSweepPass({
      mode: "enforce",
      collectCandidates: () => [makeCandidate()],
      actByCategory: { "dirty-tree": () => { actCalled.push(1); } },
      isIntentEffective: () => true,
      emit: () => {},
    });
    expect(actCalled).toHaveLength(0);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0].reason).toBe("intent-effective");
  });

  test("records intent with kind:'unstuck-sweep' and subject:'<ticket>/<phase>'", () => {
    const intents = [];
    runUnstuckSweepPass({
      mode: "enforce",
      collectCandidates: () => [makeCandidate()],
      actByCategory: { "dirty-tree": () => {} },
      emit: () => {},
      recordIntent: (kind, subject) => { intents.push({ kind, subject }); },
      isIntentEffective: () => false,
    });
    expect(intents[0].kind).toBe("unstuck-sweep");
    expect(intents[0].subject).toBe("CTL-TEST/implement");
  });

  test("a throwing census never aborts the pass (degrades to empty list)", () => {
    const report = runUnstuckSweepPass({
      mode: "enforce",
      collectCandidates: () => { throw new Error("census failed"); },
      emit: () => {},
    });
    expect(report.acted).toHaveLength(0);
    expect(report.failed).toHaveLength(0);
  });

  test("a throwing per-candidate seam does not abort the rest", () => {
    const actCalled = [];
    const report = runUnstuckSweepPass({
      mode: "enforce",
      collectCandidates: () => [
        makeCandidate({ ticket: "T1" }),
        makeCandidate({ ticket: "T2" }),
      ],
      actByCategory: {
        "dirty-tree": (c) => {
          if (c.ticket === "T1") throw new Error("T1 failed");
          actCalled.push(c.ticket);
        },
      },
      emit: () => {},
      isIntentEffective: () => false,
    });
    expect(actCalled).toContain("T2");
    expect(report.failed.some(f => f.ticket === "T1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// defaultCollectUnstuckCandidates — shared census builder (CTL-1064)
// ---------------------------------------------------------------------------
describe("defaultCollectUnstuckCandidates — shared census builder (CTL-1064)", () => {
  let orchDir;
  beforeEach(() => {
    orchDir = mkdtempSync(join(tmpdir(), "ctl1064-census-"));
  });
  afterEach(() => {
    rmSync(orchDir, { recursive: true, force: true });
  });

  function makeWorker(ticket, signalOverrides = {}) {
    const d = join(orchDir, "workers", ticket);
    mkdirSync(d, { recursive: true });
    const signal = {
      ticket,
      phase: "implement",
      status: "stalled",
      stalledReason: "rebase_refused_dirty_tree",
      ...signalOverrides,
    };
    writeFileSync(join(d, "phase-implement.json"), JSON.stringify(signal));
    return d;
  }

  test("reads stalledReason from status:stalled phase signals", () => {
    makeWorker("CTL-STALLED");
    const candidates = defaultCollectUnstuckCandidates({ orchDir });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].ticket).toBe("CTL-STALLED");
    expect(candidates[0].evidence.reason).toBe("rebase_refused_dirty_tree");
  });

  test("reads failureReason from status:failed + failureReason:orphan-sweep-stale", () => {
    makeWorker("CTL-ORPHAN", {
      status: "failed",
      failureReason: "orphan-sweep-stale",
      stalledReason: undefined,
    });
    const candidates = defaultCollectUnstuckCandidates({ orchDir });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].evidence.reason).toBe("orphan-sweep-stale");
  });

  test("skips running/done signals and tickets with wrong status", () => {
    makeWorker("CTL-RUNNING", { status: "running" });
    makeWorker("CTL-DONE", { status: "done" });
    const candidates = defaultCollectUnstuckCandidates({ orchDir });
    expect(candidates).toHaveLength(0);
  });

  test("liveSessionInWorktree set from agentsSnapshot", () => {
    makeWorker("CTL-LIVE");
    const candidates = defaultCollectUnstuckCandidates({
      orchDir,
      agentsSnapshot: [{ cwd: "/some/worktree/CTL-LIVE" }],
      resolveWorktreePath: () => "/some/worktree/CTL-LIVE",
    });
    expect(candidates[0].evidence.liveSessionInWorktree).toBe(true);
  });

  test("linearTerminal set from injected isLinearTerminal seam", () => {
    makeWorker("CTL-TERMINAL");
    const candidates = defaultCollectUnstuckCandidates({
      orchDir,
      isLinearTerminal: (t) => t === "CTL-TERMINAL",
    });
    expect(candidates[0].evidence.linearTerminal).toBe(true);
  });

  test("worktreePath from resolveWorktreePath seam (null when absent)", () => {
    makeWorker("CTL-NOPATH");
    const candidates = defaultCollectUnstuckCandidates({ orchDir });
    expect(candidates[0].evidence.worktreePath).toBeNull();
  });

  test("a throwing probe for one ticket does not abort enumeration of others", () => {
    const d1 = join(orchDir, "workers", "CTL-OK");
    mkdirSync(d1, { recursive: true });
    writeFileSync(
      join(d1, "phase-implement.json"),
      JSON.stringify({ ticket: "CTL-OK", phase: "implement", status: "stalled", stalledReason: "rebase_refused_dirty_tree" }),
    );
    // malformed json for second ticket
    const d2 = join(orchDir, "workers", "CTL-BAD");
    mkdirSync(d2, { recursive: true });
    writeFileSync(join(d2, "phase-implement.json"), "{ not json");

    const candidates = defaultCollectUnstuckCandidates({ orchDir });
    // CTL-OK still found despite CTL-BAD being malformed
    expect(candidates.some(c => c.ticket === "CTL-OK")).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// CTL-1064 remediation (verify⇄remediate) — regression coverage for the verify
// findings against the original Pass 0u landing.
// ───────────────────────────────────────────────────────────────────────────

describe("runUnstuckSweepPass — enforce false-success when no act seam (CTL-1064)", () => {
  test("clearable category with NO act seam: skipped (no-act-seam), no intent/comment/emit/acted", () => {
    const emitted = [];
    const recordCalls = [];
    const commentCalls = [];
    const report = runUnstuckSweepPass({
      mode: "enforce",
      collectCandidates: () => [{
        ticket: "CTL-X", phase: "implement",
        evidence: { reason: "rebase_refused_dirty_tree", ticket: "CTL-X", phase: "implement" },
      }],
      actByCategory: {}, // no seam for 'dirty-tree' — the production default
      emit: (type, fields) => { emitted.push({ type, ...fields }); return Promise.resolve(true); },
      recordIntent: (kind, subject) => recordCalls.push({ kind, subject }),
      postComment: (t, c, p) => commentCalls.push({ t, c, p }),
    });

    expect(report.acted).toHaveLength(0);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]).toMatchObject({ ticket: "CTL-X", reason: "no-act-seam" });
    expect(recordCalls).toHaveLength(0);
    expect(commentCalls).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });

  test("clearable category WITH an act seam still acts, records, comments, emits", () => {
    const emitted = [];
    const recordCalls = [];
    const commentCalls = [];
    const acted = [];
    const report = runUnstuckSweepPass({
      mode: "enforce",
      collectCandidates: () => [{
        ticket: "CTL-Y", phase: "implement",
        evidence: { reason: "rebase_refused_dirty_tree", ticket: "CTL-Y", phase: "implement" },
      }],
      actByCategory: { "dirty-tree": (c) => acted.push(c.ticket) },
      emit: (type, fields) => { emitted.push({ type, ...fields }); return Promise.resolve(true); },
      recordIntent: (kind, subject) => recordCalls.push({ kind, subject }),
      postComment: (t, c, p) => commentCalls.push({ t, c, p }),
    });

    expect(acted).toEqual(["CTL-Y"]);
    expect(report.acted).toHaveLength(1);
    expect(recordCalls).toHaveLength(1);
    expect(commentCalls).toHaveLength(1);
    expect(emitted.find((e) => e.type === "unstuck.cleared.noise")).toBeDefined();
  });
});

describe("emitUnstuckEvent — dedicated unified-log emitter (CTL-1064)", () => {
  let SCRATCH, LOG_PATH, prevDir;
  beforeEach(() => {
    SCRATCH = mkdtempSync(join(tmpdir(), "unstuck-emit-"));
    const ym = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}`;
    LOG_PATH = join(SCRATCH, "events", `${ym}.jsonl`);
    prevDir = process.env.CATALYST_DIR;
    process.env.CATALYST_DIR = SCRATCH;
  });
  afterEach(() => {
    if (prevDir === undefined) delete process.env.CATALYST_DIR;
    else process.env.CATALYST_DIR = prevDir;
    rmSync(SCRATCH, { recursive: true, force: true });
  });

  test("appends a valid unstuck.* line to the unified log (does NOT throw like emitReapIntent)", async () => {
    const ok = await emitUnstuckEvent("unstuck.would.clear-noise", {
      ticket: "CTL-Z", phase: "implement", category: "dirty-tree",
    });
    expect(ok).toBe(true);
    expect(existsSync(LOG_PATH)).toBe(true);
    const last = JSON.parse(readFileSync(LOG_PATH, "utf8").trim().split("\n").pop());
    expect(last.event).toBe("unstuck.would.clear-noise");
    expect(last.ticket).toBe("CTL-Z");
    expect(last.category).toBe("dirty-tree");
    expect(last.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test("accepts every type in the sweep vocabulary", async () => {
    for (const t of UNSTUCK_SWEEP_EVENT_TYPES) {
      expect(await emitUnstuckEvent(t, { ticket: "CTL-Z" })).toBe(true);
    }
  });

  test("rejects an event type outside the sweep vocabulary", async () => {
    await expect(emitUnstuckEvent("phase.yield.reap-requested", {})).rejects.toThrow(/unknown unstuck-sweep event type/);
  });
});

describe("defaultPostUnstuckComment — success-gated idempotency marker (CTL-1064)", () => {
  let orchDir, ticket, markerPath;
  beforeEach(() => {
    orchDir = mkdtempSync(join(tmpdir(), "unstuck-comment-"));
    ticket = "CTL-CM";
    mkdirSync(join(orchDir, "workers", ticket), { recursive: true });
    markerPath = join(orchDir, "workers", ticket, ".unstuck-comment-dirty-tree-implement.applied");
  });
  afterEach(() => rmSync(orchDir, { recursive: true, force: true }));

  test("poster returns {status:0} → marker written", () => {
    defaultPostUnstuckComment(ticket, "dirty-tree", "implement", "body", {
      runCommentPost: () => ({ status: 0 }), orchDir,
    });
    expect(existsSync(markerPath)).toBe(true);
  });

  test("poster returns null → marker ABSENT (next pass retries) — the fixed branch", () => {
    defaultPostUnstuckComment(ticket, "dirty-tree", "implement", "body", {
      runCommentPost: () => null, orchDir,
    });
    expect(existsSync(markerPath)).toBe(false);
  });

  test("poster returns {status:1} → marker ABSENT", () => {
    defaultPostUnstuckComment(ticket, "dirty-tree", "implement", "body", {
      runCommentPost: () => ({ status: 1 }), orchDir,
    });
    expect(existsSync(markerPath)).toBe(false);
  });

  test("marker already present → idempotent skip (poster never called)", () => {
    writeFileSync(markerPath, "");
    let called = 0;
    defaultPostUnstuckComment(ticket, "dirty-tree", "implement", "body", {
      runCommentPost: () => { called++; return { status: 0 }; }, orchDir,
    });
    expect(called).toBe(0);
  });
});

describe("buildAuditComment — three-section assembler (CTL-1064)", () => {
  test("renders all three sections when provided", () => {
    const out = buildAuditComment({ found: "F", done: "D", verified: "V" });
    expect(out).toContain("**What was found**");
    expect(out).toContain("F");
    expect(out).toContain("**What was done**");
    expect(out).toContain("D");
    expect(out).toContain("**What was verified after**");
    expect(out).toContain("V");
  });

  test("falls back to _unavailable_ for missing sections", () => {
    const out = buildAuditComment({});
    expect(out.match(/_unavailable_/g)).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// CTL-1219 — the wired act-seam registry plugs into the real driver
// ---------------------------------------------------------------------------
describe("CTL-1219 — buildUnstuckActSeams wired into runUnstuckSweepPass", () => {
  // candidate builders with the driver shape (defaultCollectUnstuckCandidates).
  function dirtyTreeCandidate() {
    return {
      ticket: "CTL-1",
      phase: "implement",
      signal: { phase: "implement", status: "stalled", stalledReason: "rebase_refused_dirty_tree" },
      worktreePath: "/wt/CTL-1",
      evidence: { reason: "rebase_refused_dirty_tree", ticket: "CTL-1", phase: "implement", liveSessionInWorktree: false, linearTerminal: false },
    };
  }
  function sourceConflictCandidate(porcelainDirty = false) {
    return {
      ticket: "CTL-2",
      phase: "implement",
      signal: { phase: "implement", status: "stalled", stalledReason: "source_conflict_ctl708_unavailable" },
      worktreePath: "/wt/CTL-2",
      evidence: { reason: "source_conflict_ctl708_unavailable", ticket: "CTL-2", phase: "implement", liveSessionInWorktree: false, linearTerminal: false, _dirty: porcelainDirty },
    };
  }
  function orphanStaleCandidate() {
    return {
      ticket: "CTL-3",
      phase: "monitor-merge",
      signal: { phase: "monitor-merge", status: "failed", failureReason: "orphan-sweep-stale", bg_job_id: "job-abc", updatedAt: "2020-01-01T00:00:00Z" },
      worktreePath: "/wt/CTL-3",
      evidence: { reason: "orphan-sweep-stale", ticket: "CTL-3", phase: "monitor-merge", liveSessionInWorktree: false, linearTerminal: false },
    };
  }
  function remediateCapCandidate() {
    return {
      ticket: "CTL-9",
      phase: "verify",
      evidence: { reason: "remediate-cycle-cap-exhausted", ticket: "CTL-9", phase: "verify", liveSessionInWorktree: false, linearTerminal: false },
    };
  }

  // a clean rebased branch git responder (for source-conflict success).
  function cleanBranchGit(args) {
    const a = args.join(" ");
    if (a.includes("status --porcelain")) return { status: 0, stdout: "", stderr: "" };
    if (a.includes("log") && a.includes("origin/main..HEAD")) return { status: 0, stdout: "CTL-2: fix\n", stderr: "" };
    if (a.includes("merge-base") && a.includes("--is-ancestor")) return { status: 0, stdout: "", stderr: "" };
    if (a.includes("push")) return { status: 0, stdout: "", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  }

  test("enforce + dirty-tree + wired registry → fires unstuck.cleared.noise + records intent", () => {
    const emitted = [];
    const intents = [];
    let porcelainReads = 0;
    const registry = buildUnstuckActSeams({
      orchDir: "/tmp/orch",
      markerExists: () => false,
      writeMarker: () => {},
      runGit: () => ({ status: 0, stdout: "", stderr: "" }),
      readPorcelain: () => (++porcelainReads === 1 ? " M .catalyst/config.json" : ""),
      clearStall: () => true,
    });
    const report = runUnstuckSweepPass({
      mode: "enforce",
      collectCandidates: () => [dirtyTreeCandidate()],
      actByCategory: registry,
      emit: (type) => { emitted.push(type); },
      recordIntent: (kind, subject) => { intents.push({ kind, subject }); },
      postComment: () => {},
      isIntentEffective: () => false,
    });
    expect(emitted).toContain("unstuck.cleared.noise");
    expect(report.acted).toHaveLength(1);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toEqual({ kind: UNSTUCK_SWEEP_INTENT_KIND, subject: "CTL-1/implement" });
  });

  test("enforce + source-conflict on a CLEAN rebased branch → fires unstuck.pushed.force-with-lease", () => {
    const emitted = [];
    const registry = buildUnstuckActSeams({
      orchDir: "/tmp/orch",
      markerExists: () => false,
      writeMarker: () => {},
      runGit: cleanBranchGit,
    });
    const report = runUnstuckSweepPass({
      mode: "enforce",
      collectCandidates: () => [sourceConflictCandidate()],
      actByCategory: registry,
      emit: (type) => { emitted.push(type); },
      isIntentEffective: () => false,
    });
    expect(emitted).toContain("unstuck.pushed.force-with-lease");
    expect(report.acted).toHaveLength(1);
  });

  test("enforce + source-conflict on a DIRTY branch → seam throws → report.failed, NO push event", () => {
    const emitted = [];
    const registry = buildUnstuckActSeams({
      orchDir: "/tmp/orch",
      markerExists: () => false,
      writeMarker: () => {},
      runGit: (args) => {
        if (args.join(" ").includes("status --porcelain")) return { status: 0, stdout: " M src/real.ts", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    const report = runUnstuckSweepPass({
      mode: "enforce",
      collectCandidates: () => [sourceConflictCandidate(true)],
      actByCategory: registry,
      emit: (type) => { emitted.push(type); },
      isIntentEffective: () => false,
    });
    expect(emitted).not.toContain("unstuck.pushed.force-with-lease");
    expect(report.acted).toHaveLength(0);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].category).toBe("source-conflict");
  });

  test("enforce + orphan-stale MERGED → fires unstuck.emitted.phase-complete", () => {
    const emitted = [];
    const phaseCompletes = [];
    const registry = buildUnstuckActSeams({
      orchDir: "/tmp/orch",
      markerExists: () => false,
      writeMarker: () => {},
      resolvePrState: () => "MERGED",
      jobLifecycle: () => false,
      nowMs: () => Date.parse("2020-01-01T01:00:00Z"),
      emitPhaseComplete: (a) => { phaseCompletes.push(a); return true; },
    });
    const report = runUnstuckSweepPass({
      mode: "enforce",
      collectCandidates: () => [orphanStaleCandidate()],
      actByCategory: registry,
      emit: (type) => { emitted.push(type); },
      isIntentEffective: () => false,
    });
    expect(emitted).toContain("unstuck.emitted.phase-complete");
    expect(report.acted).toHaveLength(1);
    expect(phaseCompletes).toEqual([{ ticket: "CTL-3", phase: "monitor-merge" }]);
  });

  test("shadow + any wired category → emits ONLY the would-* twin; no seam fn invoked", () => {
    const emitted = [];
    const called = [];
    // a registry whose dirty-tree fn records its invocation.
    const registry = {
      ...buildUnstuckActSeams({ orchDir: "/tmp/orch" }),
      "dirty-tree": () => { called.push("dirty-tree"); },
    };
    runUnstuckSweepPass({
      mode: "shadow",
      collectCandidates: () => [dirtyTreeCandidate()],
      actByCategory: registry,
      emit: (type) => { emitted.push(type); },
    });
    expect(called).toHaveLength(0);
    expect(emitted).toContain("unstuck.would.clear-noise");
    expect(emitted).not.toContain("unstuck.cleared.noise");
  });

  test("unknown / remediate-cap → escalate seam (NOT the registry); registry fns never called", () => {
    const escalated = [];
    const called = [];
    const registry = {
      "dirty-tree": () => { called.push(1); },
      "source-conflict": () => { called.push(1); },
      "orphan-stale": () => { called.push(1); },
      "stale-label": () => { called.push(1); },
    };
    const report = runUnstuckSweepPass({
      mode: "enforce",
      collectCandidates: () => [remediateCapCandidate()],
      actByCategory: registry,
      escalate: (c) => { escalated.push(c.ticket); },
      emit: () => {},
    });
    expect(called).toHaveLength(0);
    expect(report.escalated).toHaveLength(1);
    expect(escalated).toContain("CTL-9");
  });

  test("off mode + wired registry → fully inert (no seam, no event)", () => {
    const emitted = [];
    const called = [];
    const registry = { ...buildUnstuckActSeams({ orchDir: "/tmp/orch" }), "dirty-tree": () => { called.push(1); } };
    const report = runUnstuckSweepPass({
      mode: "off",
      collectCandidates: () => [dirtyTreeCandidate()],
      actByCategory: registry,
      emit: (type) => { emitted.push(type); },
    });
    expect(called).toHaveLength(0);
    expect(emitted).toHaveLength(0);
    expect(report.acted).toHaveLength(0);
  });
});
