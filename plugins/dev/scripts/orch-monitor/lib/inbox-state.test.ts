// inbox-state.test.ts — Phase 1 TDD: compact worker-state collection for the
// inbox-summary BFF (CTL-1042). All paths are injected via CollectOptions so
// tests run against temp fixtures, never real worker dirs or ~/.claude/projects.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectInboxItemState, computeQuestionHash } from "./inbox-state";

// ── fixture helpers ───────────────────────────────────────────────────────────

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "inbox-state-test-"));
});

afterEach(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

interface FixtureOpts {
  workersDir: string;
  projectsDir: string;
  jobsDir: string;
  title: string | null;
}

/** Create a temp worker dir with phase signal files (and optionally triage.json). */
function makeWorkerFixture(
  ticket: string,
  signals: Record<string, object>,
): FixtureOpts {
  const workersDir = join(root, "workers");
  const projectsDir = join(root, "projects");
  const jobsDir = join(root, "jobs");
  const ticketDir = join(workersDir, ticket);
  mkdirSync(ticketDir, { recursive: true });
  mkdirSync(projectsDir, { recursive: true });
  mkdirSync(jobsDir, { recursive: true });
  for (const [fname, content] of Object.entries(signals)) {
    writeFileSync(join(ticketDir, fname), JSON.stringify(content));
  }
  return { workersDir, projectsDir, jobsDir, title: null };
}

/** Like makeWorkerFixture but also wires a bg_job_id → sessionId → transcript. */
function makeWorkerFixtureWithTranscript(
  ticket: string,
  transcriptText: string,
  triageSummary?: string,
): FixtureOpts {
  const bgJobId = "testjob1";
  const sessionId = "aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee";

  const opts = makeWorkerFixture(ticket, {
    "phase-implement.json": {
      status: "needs-input",
      phase: "implement",
      parkedFrom: "implement",
      bg_job_id: bgJobId,
      failureReason: null,
      handoffPath: null,
    },
    ...(triageSummary
      ? { "triage.json": { summary: triageSummary } }
      : {}),
  });

  // Wire bg_job_id → sessionId via jobs/<id>/state.json
  const jobDir = join(opts.jobsDir, bgJobId);
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, "state.json"), JSON.stringify({ state: "working", sessionId }));

  // Create a project dir with the transcript JSONL
  const projectDir = join(opts.projectsDir, "my-project");
  mkdirSync(projectDir, { recursive: true });
  const transcriptLine = JSON.stringify({
    type: "assistant",
    timestamp: "2026-06-11T00:00:00Z",
    message: {
      content: [{ type: "text", text: transcriptText }],
    },
  });
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), transcriptLine + "\n");

  return opts;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("collectInboxItemState — state collection from fixtures", () => {
  test("collects status, phase, parkedFrom from the held phase signal", async () => {
    const opts = makeWorkerFixture("CTL-1042", {
      "phase-implement.json": {
        status: "needs-input",
        phase: "implement",
        parkedFrom: "implement",
        bg_job_id: "abc123",
        failureReason: null,
        handoffPath: "thoughts/shared/handoffs/CTL-1042/handoff.md",
      },
      "triage.json": { summary: "Add an AI summary to the inbox." },
    });

    const state = await collectInboxItemState("CTL-1042", {
      ...opts,
      title: "Stuck workers should explain themselves",
    });

    expect(state).not.toBeNull();
    expect(state!.phase).toBe("implement");
    expect(state!.status).toBe("needs-input");
    expect(state!.parkedFrom).toBe("implement");
    expect(state!.handoffPath).toBe("thoughts/shared/handoffs/CTL-1042/handoff.md");
    expect(state!.triageSummary).toContain("AI summary");
    expect(state!.title).toContain("Stuck workers");
    expect(state!.ticket).toBe("CTL-1042");
    expect(state!.bgJobId).toBe("abc123");
  });

  test("extracts the raised question from the transcript tail", async () => {
    const opts = makeWorkerFixtureWithTranscript(
      "CTL-1042",
      "I need a decision: should the cache key include the model id?",
    );

    const state = await collectInboxItemState("CTL-1042", opts);

    expect(state).not.toBeNull();
    expect(state!.raisedQuestion).not.toBeNull();
    expect(state!.raisedQuestion).toContain("should the cache key include");
  });

  test("returns null when no stuck phase signal exists (all running)", async () => {
    const opts = makeWorkerFixture("CTL-1042", {
      "phase-implement.json": { status: "running", phase: "implement" },
    });

    expect(await collectInboxItemState("CTL-1042", opts)).toBeNull();
  });

  test("returns null when the ticket has no worker dir at all", async () => {
    const opts = makeWorkerFixture("CTL-OTHER", {}); // creates workers root but no CTL-1042 dir
    expect(await collectInboxItemState("CTL-1042", opts)).toBeNull();
  });

  test("picks needs-input over stalled when both exist", async () => {
    const opts = makeWorkerFixture("CTL-1042", {
      "phase-research.json": { status: "stalled", phase: "research" },
      "phase-implement.json": { status: "needs-input", phase: "implement" },
    });

    const state = await collectInboxItemState("CTL-1042", opts);
    expect(state!.phase).toBe("implement");
    expect(state!.status).toBe("needs-input");
  });

  test("falls back to stalled when no needs-input signal exists", async () => {
    const opts = makeWorkerFixture("CTL-1042", {
      "phase-implement.json": { status: "stalled", phase: "implement" },
    });

    const state = await collectInboxItemState("CTL-1042", opts);
    expect(state).not.toBeNull();
    expect(state!.status).toBe("stalled");
  });

  test("missing triage.json degrades triageSummary to null, never throws", async () => {
    const opts = makeWorkerFixture("CTL-1042", {
      "phase-plan.json": { status: "needs-input", phase: "plan" },
    });

    const state = await collectInboxItemState("CTL-1042", opts);
    expect(state).not.toBeNull();
    expect(state!.triageSummary).toBeNull();
  });

  test("missing transcript degrades raisedQuestion/transcriptTail to null, never throws", async () => {
    const opts = makeWorkerFixture("CTL-1042", {
      "phase-plan.json": { status: "needs-input", phase: "plan", bg_job_id: "deadbeef" },
    });
    // No job dir, no transcript

    const state = await collectInboxItemState("CTL-1042", opts);
    expect(state).not.toBeNull();
    expect(state!.raisedQuestion).toBeNull();
    expect(state!.transcriptTail).toBeNull();
  });

  test("transcript tail is capped at ~1500 chars", async () => {
    const longText = "A".repeat(3000) + " Is this too long?";
    const opts = makeWorkerFixtureWithTranscript("CTL-1042", longText);

    const state = await collectInboxItemState("CTL-1042", opts);
    expect(state!.transcriptTail).not.toBeNull();
    expect(state!.transcriptTail!.length).toBeLessThanOrEqual(1501);
  });
});

describe("computeQuestionHash — stable cache key", () => {
  test("identical phase+question produces identical hash", () => {
    const a = computeQuestionHash("implement", "pick A or B?");
    const b = computeQuestionHash("implement", "pick A or B?");
    expect(a).toBe(b);
  });

  test("different question produces different hash", () => {
    const a = computeQuestionHash("implement", "pick A or B?");
    const c = computeQuestionHash("implement", "pick C or D?");
    expect(a).not.toBe(c);
  });

  test("different phase produces different hash", () => {
    const a = computeQuestionHash("implement", "pick A?");
    const b = computeQuestionHash("plan", "pick A?");
    expect(a).not.toBe(b);
  });

  test("null question is stable (same as empty string)", () => {
    const a = computeQuestionHash("implement", null);
    const b = computeQuestionHash("implement", null);
    expect(a).toBe(b);
  });

  test("hash is a 12-char hex string", () => {
    const h = computeQuestionHash("implement", "question");
    expect(h).toMatch(/^[0-9a-f]{12}$/);
  });
});
