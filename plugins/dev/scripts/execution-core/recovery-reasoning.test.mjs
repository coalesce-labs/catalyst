// recovery-reasoning.test.mjs — Tests for CTL-1176 recovery reasoning pass.
//
// Run: cd plugins/dev/scripts/execution-core && bun test recovery-reasoning.test.mjs

import { describe, test, expect, beforeEach } from "bun:test";
import {
  reasoningRecoveryPass,
  defaultClassifyTicket,
  checkDeterministicErrors,
  checkBoundedLlmFixes,
  determineEscalationReason,
  generateRemediateBrief,
} from "./recovery-reasoning.mjs";

describe("checkDeterministicErrors", () => {
  test("detects push_rejected_no_workflow_scope", () => {
    const result = checkDeterministicErrors(
      "Error: push rejected (no workflow scope) from GitHub",
      null,
    );
    expect(result).not.toBeNull();
    expect(result.fix_class).toBe("push_rejected_no_workflow_scope");
    expect(result.seam_id).toBe("workflow-token-fallback");
  });

  // Merge conflicts are NO LONGER deterministic (seam stub always returned success:false).
  // They are now BOUNDED-LLM so the agent reads both sides and resolves them.
  test("does NOT classify merge_conflict as deterministic (falls to bounded-LLM)", () => {
    const result = checkDeterministicErrors(
      "Merge conflict detected in merge tree analysis",
      null,
    );
    expect(result).toBeNull();
  });

  test("does NOT classify CONFLICT (content): output as deterministic", () => {
    const result = checkDeterministicErrors(
      "CONFLICT (content): Merge conflict in src/foo.ts",
      null,
    );
    expect(result).toBeNull();
  });

  test("does NOT classify rebase conflict output as deterministic", () => {
    const result = checkDeterministicErrors(
      "error: could not apply abc1234... feat: add thing",
      null,
    );
    expect(result).toBeNull();
  });

  test("detects orphan-sweep-stale via failureReason", () => {
    const result = checkDeterministicErrors(null, "orphan-sweep-stale");
    expect(result).not.toBeNull();
    expect(result.fix_class).toBe("orphan_stale");
  });

  // merge-conflict / rebase-failed failureReasons fall through to bounded-LLM
  test("returns null for merge-conflict failureReason (falls to bounded-LLM)", () => {
    const result = checkDeterministicErrors(null, "merge-conflict");
    expect(result).toBeNull();
  });

  test("returns null for rebase-failed failureReason (falls to bounded-LLM)", () => {
    const result = checkDeterministicErrors(null, "rebase-failed");
    expect(result).toBeNull();
  });

  test("returns null for unknown errors", () => {
    const result = checkDeterministicErrors("some random error", null);
    expect(result).toBeNull();
  });
});

describe("checkBoundedLlmFixes", () => {
  // ── Merge / rebase conflict patterns ───────────────────────────────────────
  test("detects conflict.*merge.*tree log pattern as bounded-LLM", () => {
    const result = checkBoundedLlmFixes("Merge conflict detected in merge tree analysis", null, {});
    expect(result).not.toBeNull();
    expect(result.reason).toContain("Merge/rebase conflict");
    expect(result.brief).toContain("Read both sides");
  });

  test("detects CONFLICT (content): git output as bounded-LLM", () => {
    const result = checkBoundedLlmFixes(
      "CONFLICT (content): Merge conflict in src/app/server.ts",
      null,
      {},
    );
    expect(result).not.toBeNull();
    expect(result.reason).toContain("Merge/rebase conflict");
  });

  test("detects 'merge conflict in' git output as bounded-LLM", () => {
    const result = checkBoundedLlmFixes(
      "Auto-merging src/foo.ts\nmerge conflict in src/foo.ts",
      null,
      {},
    );
    expect(result).not.toBeNull();
    expect(result.reason).toContain("Merge/rebase conflict");
  });

  test("detects 'could not apply' rebase failure as bounded-LLM", () => {
    const result = checkBoundedLlmFixes(
      "error: could not apply abc1234... feat: add thing",
      null,
      {},
    );
    expect(result).not.toBeNull();
    expect(result.reason).toContain("Merge/rebase conflict");
  });

  test("detects rebase.*conflict pattern as bounded-LLM", () => {
    const result = checkBoundedLlmFixes("rebase conflict encountered during merge", null, {});
    expect(result).not.toBeNull();
    expect(result.reason).toContain("Merge/rebase conflict");
  });

  test("detects merge-conflict failureReason via signal as bounded-LLM", () => {
    const result = checkBoundedLlmFixes(null, null, { failureReason: "merge-conflict" });
    expect(result).not.toBeNull();
    expect(result.reason).toContain("Merge/rebase conflict");
  });

  test("detects rebase-failed failureReason via signal as bounded-LLM", () => {
    const result = checkBoundedLlmFixes(null, null, { failureReason: "rebase-failed" });
    expect(result).not.toBeNull();
    expect(result.reason).toContain("Merge/rebase conflict");
  });

  // ── Stale branch / stale PR ────────────────────────────────────────────────
  test("detects stale main pattern", () => {
    const result = checkBoundedLlmFixes("Your branch is stale with respect to main", null, {});
    expect(result).not.toBeNull();
    expect(result.reason).toContain("diverged from origin/main");
    expect(result.brief).toContain("git fetch origin");
  });

  test("detects stale-pr failureReason via signal", () => {
    const result = checkBoundedLlmFixes(null, null, { failureReason: "stale-pr" });
    expect(result).not.toBeNull();
    expect(result.reason).toContain("diverged from origin/main");
  });

  // ── CI failure after rebase ────────────────────────────────────────────────
  test("detects CI failure pattern as bounded-LLM", () => {
    const result = checkBoundedLlmFixes("Check suite failed: CI tests failed on push", null, {});
    expect(result).not.toBeNull();
    expect(result.reason).toContain("CI failure");
    expect(result.brief).toContain("gh run view");
  });

  test("detects ci-failure-after-rebase failureReason via signal", () => {
    const result = checkBoundedLlmFixes(null, null, { failureReason: "ci-failure-after-rebase" });
    expect(result).not.toBeNull();
    expect(result.reason).toContain("CI failure");
  });

  // ── Package / TypeScript ───────────────────────────────────────────────────
  test("detects bun install pattern", () => {
    const result = checkBoundedLlmFixes(
      "Cannot find package pino; bun install required",
      null,
      {},
    );
    expect(result).not.toBeNull();
    expect(result.brief).toContain("bun install");
  });

  test("detects TypeScript errors", () => {
    const result = checkBoundedLlmFixes("TypeScript error: Property x does not exist", null, {});
    expect(result).not.toBeNull();
    expect(result.reason).toContain("TypeScript errors");
  });

  test("checks jobState.detail as fallback", () => {
    const result = checkBoundedLlmFixes(
      null,
      { detail: "stuck on bun install" },
      {},
    );
    expect(result).not.toBeNull();
  });

  test("returns null for unknown fixes", () => {
    const result = checkBoundedLlmFixes("mysterious error", null, {});
    expect(result).toBeNull();
  });
});

describe("generateRemediateBrief", () => {
  test("merge-conflict brief instructs agent to read both sides", () => {
    const brief = generateRemediateBrief("merge-conflict");
    expect(brief).toContain("Read both sides");
    expect(brief).toContain("Only return HUMAN if");
    expect(brief).toContain("already-merged feature");
  });

  test("stale-branch brief instructs rebase", () => {
    const brief = generateRemediateBrief("stale-branch");
    expect(brief).toContain("git fetch origin");
    expect(brief).toContain("git rebase");
  });

  test("ci-failure brief instructs reading CI logs", () => {
    const brief = generateRemediateBrief("ci-failure");
    expect(brief).toContain("gh run view");
  });

  test("bun-install brief is concise", () => {
    const brief = generateRemediateBrief("bun-install");
    expect(brief).toContain("bun install");
  });

  test("unknown category returns fallback string", () => {
    const brief = generateRemediateBrief("totally-unknown");
    expect(brief).toContain("totally-unknown");
    expect(brief).toContain("retry the phase");
  });
});

describe("determineEscalationReason", () => {
  test("includes belief R12 escalate_human", () => {
    const reason = determineEscalationReason(null, null, null, { escalate_human: true });
    expect(reason).toContain("R12 escalate_human");
  });

  test("includes jobState.detail and needs", () => {
    const reason = determineEscalationReason(null, { detail: "stuck", needs: "human input" }, null, {});
    expect(reason).toContain("stuck");
    expect(reason).toContain("human input");
  });

  test("includes signal.failureReason", () => {
    const reason = determineEscalationReason(null, null, { failureReason: "unknown" }, {});
    expect(reason).toContain("unknown");
  });

  test("defaults to generic reason", () => {
    const reason = determineEscalationReason(null, null, null, {});
    expect(reason).toContain("Unclassified");
  });
});

describe("defaultClassifyTicket", () => {
  test("classifies deterministic error as fix", () => {
    const result = defaultClassifyTicket({
      logsOutput: "push rejected no workflow scope",
      failureReason: null,
    });
    expect(result.decision).toBe("fix");
    expect(result.fix_class).toBe("push_rejected_no_workflow_scope");
  });

  test("classifies stale-main as bounded-LLM fix", () => {
    const result = defaultClassifyTicket({
      logsOutput: "Your branch is stale with respect to main",
    });
    expect(result.decision).toBe("fix");
    expect(result.fix_class).toBe("bounded-llm");
  });

  // CTL-1176: merge conflicts → BOUNDED-LLM, not HUMAN
  test("classifies merge conflict log output as bounded-LLM fix (not escalate)", () => {
    const result = defaultClassifyTicket({
      logsOutput: "CONFLICT (content): Merge conflict in src/server.ts",
    });
    expect(result.decision).toBe("fix");
    expect(result.fix_class).toBe("bounded-llm");
    expect(result.details.brief).toContain("Read both sides");
  });

  test("classifies merge-conflict failureReason as bounded-LLM fix", () => {
    const result = defaultClassifyTicket({
      logsOutput: null,
      signal: { failureReason: "merge-conflict" },
    });
    expect(result.decision).toBe("fix");
    expect(result.fix_class).toBe("bounded-llm");
  });

  test("classifies rebase-failed failureReason as bounded-LLM fix", () => {
    const result = defaultClassifyTicket({
      logsOutput: null,
      signal: { failureReason: "rebase-failed" },
    });
    expect(result.decision).toBe("fix");
    expect(result.fix_class).toBe("bounded-llm");
  });

  test("classifies ci-failure-after-rebase as bounded-LLM fix", () => {
    const result = defaultClassifyTicket({
      logsOutput: null,
      signal: { failureReason: "ci-failure-after-rebase" },
    });
    expect(result.decision).toBe("fix");
    expect(result.fix_class).toBe("bounded-llm");
  });

  test("classifies unknown as escalate", () => {
    const result = defaultClassifyTicket({
      logsOutput: "unknown error",
      beliefState: { escalate_human: true },
    });
    expect(result.decision).toBe("escalate");
    expect(result.fix_class).toBe("human");
  });

  test("priority: deterministic > bounded-LLM > escalate", () => {
    // Same ticket with both patterns → deterministic wins
    const result = defaultClassifyTicket({
      logsOutput: "push rejected no workflow scope AND stale main",
    });
    expect(result.fix_class).toBe("push_rejected_no_workflow_scope");
  });
});

describe("reasoningRecoveryPass", () => {
  const baseItem = {
    ticket: "CTL-1",
    evidence: {
      logsOutput: null,
      jobState: null,
      signal: {},
      beliefState: {},
    },
  };

  test("mode=off returns processed=0", () => {
    const result = reasoningRecoveryPass([baseItem], { mode: "off" });
    expect(result.processed).toBe(0);
    expect(result.mode).toBe("off");
  });

  test("mode=shadow classifies without acting", () => {
    const items = [
      {
        ...baseItem,
        ticket: "CTL-1",
        evidence: { logsOutput: "push rejected no workflow scope" },
      },
    ];

    const comments = [];
    const events = [];

    const result = reasoningRecoveryPass(items, {
      mode: "shadow",
      postComment: (ticket, comment) => comments.push(comment),
      emitEvent: (event) => events.push(event),
    });

    expect(result.processed).toBe(1);
    expect(result.results[0].decision).toBe("fix");
    expect(comments.length).toBe(1); // diagnosis posted
    expect(comments[0]).toContain("CTL-1176 Diagnosis");
    expect(events.some((e) => e.type === "recovery.would-fix")).toBe(true);
  });

  test("mode=enforce attempts to fix and records intent", () => {
    const items = [
      {
        ...baseItem,
        ticket: "CTL-1",
        evidence: { logsOutput: "stale main" },
      },
    ];

    const intents = [];
    const comments = [];
    const events = [];
    let seamInvoked = false;

    const result = reasoningRecoveryPass(items, {
      mode: "enforce",
      invokeRemediateCapped: (ticket, brief) => {
        return { success: true, reason: "fixed", details: {} };
      },
      recordIntent: (ticket, intent) => intents.push({ ticket, intent }),
      postComment: (ticket, comment) => comments.push({ ticket, comment }),
      emitEvent: (event) => events.push(event),
    });

    expect(result.processed).toBe(1);
    expect(result.results[0].decision).toBe("fix");
    expect(intents.length).toBe(1);
    expect(intents[0].intent.type).toBe("recovery-pass");
    expect(comments.length).toBe(1); // audit comment
    expect(events.some((e) => e.type === "recovery.fixed")).toBe(true);
  });

  test("mode=enforce escalates with payload", () => {
    const items = [
      {
        ...baseItem,
        ticket: "CTL-1",
        evidence: { logsOutput: "unknown error", beliefState: { escalate_human: true } },
      },
    ];

    const intents = [];
    const events = [];

    const result = reasoningRecoveryPass(items, {
      mode: "enforce",
      recordIntent: (ticket, intent) => intents.push({ ticket, intent }),
      emitEvent: (event) => events.push(event),
    });

    expect(result.processed).toBe(1);
    expect(result.results[0].decision).toBe("escalate");
    expect(intents.length).toBe(1);
    expect(intents[0].intent.decision).toBe("escalate");
    expect(intents[0].intent.escalation).toBeDefined();
    expect(events.some((e) => e.type === "recovery.escalated")).toBe(true);
  });

  test("skips items via shouldSkipItem cooldown", () => {
    const items = [baseItem];

    const result = reasoningRecoveryPass(items, {
      mode: "shadow",
      shouldSkipItem: (ticket) => ticket === "CTL-1", // skip this one
    });

    expect(result.processed).toBe(0);
  });

  test("handles classification errors gracefully", () => {
    const items = [baseItem];

    const result = reasoningRecoveryPass(items, {
      mode: "shadow",
      classifyTicket: () => {
        throw new Error("classification failed");
      },
    });

    expect(result.processed).toBe(1);
    expect(result.results[0].decision).toBe("error");
  });

  test("batches multiple items", () => {
    const items = [
      {
        ticket: "CTL-1",
        evidence: { logsOutput: "push rejected no workflow scope" },
      },
      {
        ticket: "CTL-2",
        evidence: { logsOutput: "stale main" },
      },
      {
        ticket: "CTL-3",
        evidence: { logsOutput: "unknown error", beliefState: { escalate_human: true } },
      },
    ];

    const events = [];

    const result = reasoningRecoveryPass(items, {
      mode: "shadow",
      emitEvent: (event) => events.push(event),
    });

    expect(result.processed).toBe(3);
    expect(result.results[0].fix_class).toBe("push_rejected_no_workflow_scope");
    expect(result.results[1].fix_class).toBe("bounded-llm");
    expect(result.results[2].fix_class).toBe("human");
    expect(events.filter((e) => e.type === "recovery.would-fix").length).toBe(2);
    expect(events.filter((e) => e.type === "recovery.would-escalate").length).toBe(1);
  });

  test("format diagnosis comment correctly", () => {
    const items = [
      {
        ticket: "CTL-1",
        evidence: { logsOutput: "stale main" },
      },
    ];

    const comments = [];

    reasoningRecoveryPass(items, {
      mode: "shadow",
      postComment: (ticket, comment) => comments.push(comment),
    });

    expect(comments[0]).toContain("CTL-1176 Diagnosis");
    expect(comments[0]).toContain("Decision:");
    expect(comments[0]).toContain("bounded-llm");
  });
});
