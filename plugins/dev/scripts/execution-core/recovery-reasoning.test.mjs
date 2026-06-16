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

  test("detects merge_conflict pattern", () => {
    const result = checkDeterministicErrors(
      "Merge conflict detected in merge tree analysis",
      null,
    );
    expect(result).not.toBeNull();
    expect(result.fix_class).toBe("merge_conflict");
  });

  test("detects orphan-sweep-stale via failureReason", () => {
    const result = checkDeterministicErrors(null, "orphan-sweep-stale");
    expect(result).not.toBeNull();
    expect(result.fix_class).toBe("orphan_stale");
  });

  test("returns null for unknown errors", () => {
    const result = checkDeterministicErrors("some random error", null);
    expect(result).toBeNull();
  });
});

describe("checkBoundedLlmFixes", () => {
  test("detects stale main pattern", () => {
    const result = checkBoundedLlmFixes("Your branch is stale with respect to main", null, {});
    expect(result).not.toBeNull();
    expect(result.reason).toContain("diverged from origin/main");
  });

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

  test("classifies bounded-LLM as fix", () => {
    const result = defaultClassifyTicket({
      logsOutput: "Your branch is stale with respect to main",
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
