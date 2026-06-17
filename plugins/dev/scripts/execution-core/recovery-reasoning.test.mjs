// recovery-reasoning.test.mjs — Tests for CTL-1176 recovery reasoning pass.
//
// Run: cd plugins/dev/scripts/execution-core && bun test recovery-reasoning.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  reasoningRecoveryPass,
  defaultClassifyTicket,
  checkDeterministicErrors,
  checkBoundedLlmFixes,
  determineEscalationReason,
  generateRemediateBrief,
  buildRecoveryEnvelope,
  defaultRecordIntent,
  defaultShouldSkipItem,
  defaultInvokeRemediateCapped,
  defaultInvokeRecoveryPass,
  RECOVERY_PASS_CYCLE_CAP,
  RECOVERY_PASS_PHASE,
  RECOVERY_MAX_ATTEMPTS,
  RECOVERY_COOLDOWN_MS,
} from "./recovery-reasoning.mjs";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { tmpdir } from "node:os";

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

  // CTL-1186: the push_rejected_no_workflow_scope failureReason shortcut must
  // classify as FIX (re-dispatch via the workflow-token-redispatch seam) even
  // when there is NO log buffer — the signal failureReason alone is enough.
  test("detects push_rejected_no_workflow_scope via failureReason (no logs)", () => {
    const result = checkDeterministicErrors(null, "push_rejected_no_workflow_scope");
    expect(result).not.toBeNull();
    expect(result.fix_class).toBe("push_rejected_no_workflow_scope");
    expect(result.seam_id).toBe("workflow-token-redispatch");
  });

  test("push_rejected_no_workflow_scope failureReason → classifyTicket decision=fix", () => {
    const result = defaultClassifyTicket({
      logsOutput: null,
      failureReason: "push_rejected_no_workflow_scope",
    });
    expect(result.decision).toBe("fix");
    expect(result.fix_class).toBe("push_rejected_no_workflow_scope");
    expect(result.details.seam_id).toBe("workflow-token-redispatch");
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

  // CTL-1243: stalled tickets carry stalledReason, not failureReason
  test("source_conflict stalledReason → bounded-LLM (not null)", () => {
    const result = checkBoundedLlmFixes(
      null,
      null,
      { stalledReason: "source_conflict_ctl708_unavailable" },
    );
    expect(result).not.toBeNull();
    expect(result.brief).toContain("git rebase --continue");
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

  // CTL-1243: source_conflict stall → decision:fix, fix_class:bounded-llm
  test("defaultClassifyTicket: source_conflict stall → decision:fix, fix_class:bounded-llm", () => {
    const result = defaultClassifyTicket({
      logsOutput: null,
      jobState: null,
      signal: { stalledReason: "source_conflict_ctl708_unavailable" },
    });
    expect(result.decision).toBe("fix");
    expect(result.fix_class).toBe("bounded-llm");
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
      postComment: () => {}, // no-op: avoid real linear-comment-post.sh shell-out
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
      postComment: () => {}, // no-op: avoid real linear-comment-post.sh shell-out
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

  // CTL-1243: never post the give-up comment on tickets that are already terminal
  test("linearTerminal:true item is skipped — no comment, no escalation", () => {
    const posted = [];
    const events = [];
    const result = reasoningRecoveryPass(
      [
        {
          ticket: "CTL-999",
          phase: "implement",
          evidence: {
            linearTerminal: true,
            signal: { stalledReason: "source_conflict_ctl708_unavailable" },
          },
        },
      ],
      {
        mode: "enforce",
        postComment: (t, body) => posted.push({ t, body }),
        emitEvent: (event) => events.push(event),
        recordIntent: () => {},
        invokeRemediateCapped: () => ({ success: true, reason: "fixed", details: {} }),
      },
    );
    expect(posted.length).toBe(0);
    const r = result.results.find((r) => r.ticket === "CTL-999");
    expect(r?.decision).not.toBe("escalate");
  });
});

// ─── CTL-1176: per-tick fix cap (anti-storm) ────────────────────────────────
describe("reasoningRecoveryPass maxFixesPerTick cap", () => {
  // Build N fixable items (bounded-llm stale-main) so each would be a FIX action.
  function fixableItems(n) {
    return Array.from({ length: n }, (_, i) => ({
      ticket: `CTL-${100 + i}`,
      evidence: { logsOutput: "stale main" },
    }));
  }

  test("caps fix-actions at maxFixesPerTick; rest are deferred (no action)", () => {
    let remediateCalls = 0;
    const result = reasoningRecoveryPass(fixableItems(5), {
      mode: "enforce",
      maxFixesPerTick: 2,
      invokeRemediateCapped: () => {
        remediateCalls += 1;
        return { success: true, dispatched: true, attempts: 1, reason: "dispatched", details: {} };
      },
      recordIntent: () => {},
      postComment: () => {},
      emitEvent: () => {},
    });

    expect(result.processed).toBe(5);
    // Only 2 actually invoked the remediate seam.
    expect(remediateCalls).toBe(2);
    // The remaining 3 are deferred — no action, no cooldown burn.
    const deferred = result.results.filter((r) => r.decision === "deferred");
    expect(deferred.length).toBe(3);
    expect(deferred[0].reason).toContain("per-tick fix cap");
  });

  test("deferred items do NOT record intent (no cooldown burn)", () => {
    const intents = [];
    reasoningRecoveryPass(fixableItems(4), {
      mode: "enforce",
      maxFixesPerTick: 1,
      invokeRemediateCapped: () => ({ success: true, dispatched: true, attempts: 1, details: {} }),
      recordIntent: (ticket, intent) => intents.push({ ticket, intent }),
      postComment: () => {},
      emitEvent: () => {},
    });
    // Only the 1 acted item records an intent; the 3 deferred do not.
    expect(intents.length).toBe(1);
  });

  test("env CATALYST_RECOVERY_MAX_FIXES_PER_TICK is honored by default", () => {
    const prev = process.env.CATALYST_RECOVERY_MAX_FIXES_PER_TICK;
    process.env.CATALYST_RECOVERY_MAX_FIXES_PER_TICK = "1";
    try {
      let calls = 0;
      const result = reasoningRecoveryPass(fixableItems(3), {
        mode: "enforce",
        invokeRemediateCapped: () => {
          calls += 1;
          return { success: true, dispatched: true, attempts: 1, details: {} };
        },
        recordIntent: () => {},
        postComment: () => {},
        emitEvent: () => {},
      });
      expect(calls).toBe(1);
      expect(result.results.filter((r) => r.decision === "deferred").length).toBe(2);
    } finally {
      if (prev === undefined) delete process.env.CATALYST_RECOVERY_MAX_FIXES_PER_TICK;
      else process.env.CATALYST_RECOVERY_MAX_FIXES_PER_TICK = prev;
    }
  });
});

// ─── CTL-1176: cooldown skip (injected shouldSkipItem) ──────────────────────
describe("reasoningRecoveryPass cooldown skip", () => {
  test("a ticket in cooldown is skipped and takes NO action", () => {
    const events = [];
    let acted = false;
    const result = reasoningRecoveryPass(
      [{ ticket: "CTL-9", evidence: { logsOutput: "stale main" } }],
      {
        mode: "enforce",
        shouldSkipItem: (ticket) => ticket === "CTL-9",
        invokeRemediateCapped: () => {
          acted = true;
          return { success: true, dispatched: true, attempts: 1, details: {} };
        },
        emitEvent: (e) => events.push(e),
        recordIntent: () => {},
        postComment: () => {},
      },
    );
    expect(result.processed).toBe(0);
    expect(acted).toBe(false);
    expect(events.length).toBe(0);
  });
});

// ─── CTL-1176: DIAGNOSE evidence capture wiring ─────────────────────────────
describe("reasoningRecoveryPass DIAGNOSE capture", () => {
  test("captures evidence via captureEvidenceFn when logsOutput is missing", () => {
    const captured = [];
    reasoningRecoveryPass([{ ticket: "CTL-7", bgJobId: "abc123", evidence: {} }], {
      mode: "shadow",
      captureEvidenceFn: (subject, bgJobId) => {
        captured.push({ subject, bgJobId });
        return { logsOutput: "stale main", jobState: { detail: "idle" } };
      },
      postComment: () => {},
      emitEvent: () => {},
    });
    expect(captured.length).toBe(1);
    expect(captured[0].bgJobId).toBe("abc123");
    expect(captured[0].subject).toContain("CTL-7");
  });

  test("does NOT capture when logsOutput already present", () => {
    let called = false;
    reasoningRecoveryPass(
      [{ ticket: "CTL-7", bgJobId: "abc123", evidence: { logsOutput: "stale main" } }],
      {
        mode: "shadow",
        captureEvidenceFn: () => {
          called = true;
          return {};
        },
        postComment: () => {},
        emitEvent: () => {},
      },
    );
    expect(called).toBe(false);
  });

  test("captured logsOutput drives classification (stale-main → bounded-llm fix)", () => {
    const result = reasoningRecoveryPass(
      [{ ticket: "CTL-7", bgJobId: "abc123", evidence: {} }],
      {
        mode: "shadow",
        captureEvidenceFn: () => ({ logsOutput: "stale main", jobState: null }),
        postComment: () => {},
        emitEvent: () => {},
      },
    );
    expect(result.results[0].decision).toBe("fix");
    expect(result.results[0].fix_class).toBe("bounded-llm");
  });
});

// ─── CTL-1220: emit shape matches the board reader contract ─────────────────
describe("buildRecoveryEnvelope (emit↔read contract)", () => {
  test("recovery.fixed → event.name + event.label, INFO severity", () => {
    const env = buildRecoveryEnvelope(
      { type: "recovery.fixed", ticket: "CTL-50", fix_class: "x", reason: "r", details: {} },
      { now: () => "2026-06-16T00:00:00Z" },
    );
    expect(env.attributes["event.name"]).toBe("recovery.fixed");
    expect(env.attributes["event.label"]).toBe("CTL-50");
    expect(env.body.payload.ticket).toBe("CTL-50"); // reader fallback key
    expect(env.severityText).toBe("INFO");
    expect(env.ts).toBe("2026-06-16T00:00:00Z");
    expect(env.attributes["recovery.fix_class"]).toBe("x");
  });

  test("recovery.would-fix → INFO; recovery.escalated → WARN", () => {
    const wouldFix = buildRecoveryEnvelope({ type: "recovery.would-fix", ticket: "CTL-51" });
    expect(wouldFix.severityText).toBe("INFO");
    const escal = buildRecoveryEnvelope({ type: "recovery.escalated", ticket: "CTL-52" });
    expect(escal.severityText).toBe("WARN");
    expect(escal.severityNumber).toBe(13);
  });

  test("event.action strips the recovery. prefix", () => {
    const env = buildRecoveryEnvelope({ type: "recovery.would-escalate", ticket: "CTL-53" });
    expect(env.attributes["event.action"]).toBe("would-escalate");
  });

  test("omits recovery.fix_class when fix_class is null", () => {
    const env = buildRecoveryEnvelope({ type: "recovery.escalated", ticket: "CTL-54" });
    expect(env.attributes["recovery.fix_class"]).toBeUndefined();
  });

  test("carries OTel resource (service.name execution-core)", () => {
    const env = buildRecoveryEnvelope({ type: "recovery.fixed", ticket: "CTL-55" });
    expect(env.resource["service.name"]).toBe("catalyst.execution-core");
    expect(env.resource["host.name"]).toBeDefined();
    expect(typeof env.id).toBe("string");
  });
});

// ─── CTL-1176: host-local cooldown + intent ledger ──────────────────────────
describe("recovery-intent ledger (cooldown + max-attempts + escalated)", () => {
  let orchDir;
  beforeEach(() => {
    orchDir = mkdtempSync(pathJoin(tmpdir(), "rec-intent-"));
  });
  afterEach(() => {
    try {
      rmSync(orchDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  test("record then shouldSkip within cooldown window → skip", () => {
    const now = 1_000_000_000_000;
    defaultRecordIntent("CTL-300", { decision: "fix", fix_class: "bounded-llm" }, {
      orchDir,
      now: () => now,
    });
    // 1 minute later — well inside the 30-min default window.
    expect(defaultShouldSkipItem("CTL-300", { orchDir, now: () => now + 60_000 })).toBe(true);
  });

  test("after cooldown window elapses → no skip (attempts still under cap)", () => {
    const now = 1_000_000_000_000;
    defaultRecordIntent("CTL-301", { decision: "fix", fix_class: "x" }, {
      orchDir,
      now: () => now,
    });
    const after = now + RECOVERY_COOLDOWN_MS + 1;
    expect(defaultShouldSkipItem("CTL-301", { orchDir, now: () => after })).toBe(false);
  });

  test("attempts >= max_attempts → skip (terminal, stops self-healing)", () => {
    const now = 1_000_000_000_000;
    // Record max_attempts passes (each call accrues +1).
    for (let i = 0; i < RECOVERY_MAX_ATTEMPTS; i++) {
      defaultRecordIntent("CTL-302", { decision: "fix", fix_class: "x" }, {
        orchDir,
        now: () => now + i,
      });
    }
    // Far past the cooldown window — attempts cap is what skips it now.
    const after = now + RECOVERY_COOLDOWN_MS * 10;
    expect(defaultShouldSkipItem("CTL-302", { orchDir, now: () => after })).toBe(true);
  });

  test("escalate decision latches escalated → skip forever", () => {
    const now = 1_000_000_000_000;
    defaultRecordIntent("CTL-303", { decision: "escalate" }, { orchDir, now: () => now });
    const after = now + RECOVERY_COOLDOWN_MS * 100;
    expect(defaultShouldSkipItem("CTL-303", { orchDir, now: () => after })).toBe(true);
  });

  test("escalated latch survives a later fix-pass write", () => {
    const now = 1_000_000_000_000;
    defaultRecordIntent("CTL-304", { decision: "escalate" }, { orchDir, now: () => now });
    // A subsequent fix-pass must NOT un-latch escalated.
    const entry = defaultRecordIntent("CTL-304", { decision: "fix", fix_class: "x" }, {
      orchDir,
      now: () => now + 1,
    });
    expect(entry.escalated).toBe(true);
  });

  test("first-action ts preserved across writes; attempts accrue", () => {
    const t0 = 1_000_000_000_000;
    defaultRecordIntent("CTL-305", { decision: "fix", fix_class: "x" }, {
      orchDir,
      now: () => t0,
    });
    const second = defaultRecordIntent("CTL-305", { decision: "fix", fix_class: "x" }, {
      orchDir,
      now: () => t0 + 5000,
    });
    expect(second.ts).toBe(t0); // first-action timestamp preserved
    expect(second.lastTs).toBe(t0 + 5000); // most-recent action
    expect(second.attempts).toBe(2);
  });

  test("fail-open: no ledger → shouldSkip returns false", () => {
    expect(defaultShouldSkipItem("CTL-999", { orchDir, now: () => Date.now() })).toBe(false);
  });

  test("no orchDir → record no-ops, shouldSkip fail-open false", () => {
    // resolveOrchDir() returns null when CATALYST_ORCHESTRATOR_DIR is unset and
    // none is injected. Force that by passing orchDir: null explicitly.
    expect(defaultRecordIntent("CTL-998", { decision: "fix" }, { orchDir: null })).toBeNull();
    expect(defaultShouldSkipItem("CTL-998", { orchDir: null })).toBe(false);
  });
});

// ─── CTL-1176: capped remediate dispatch (cap enforcement) ──────────────────
describe("defaultInvokeRemediateCapped cap enforcement", () => {
  let orchDir;
  beforeEach(() => {
    orchDir = mkdtempSync(pathJoin(tmpdir(), "rec-rem-"));
  });
  afterEach(() => {
    try {
      rmSync(orchDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  test("refuses dispatch when remediate cycle count is already at cap", () => {
    const result = defaultInvokeRemediateCapped(
      "CTL-400",
      { brief: "fix it", reason: "ci-failure" },
      {
        orchDir,
        // Inject module stubs so no real dispatch graph is loaded.
        eventScanMod: { countRemediateCycles: () => 3 },
        fsmMod: { REMEDIATE_PHASE: "remediate", REMEDIATE_CYCLE_CAP: 3 },
        dispatchMod: { dispatchTicket: () => ({ code: 0 }) },
      },
    );
    expect(result.success).toBe(false);
    expect(result.reason).toBe("remediate-cycle-cap-exhausted");
    expect(result.dispatched).toBe(false);
  });

  test("dispatches ONE remediate and returns dispatched:true, attempts:1", () => {
    let dispatchCalls = 0;
    const result = defaultInvokeRemediateCapped(
      "CTL-401",
      { brief: "fix it", reason: "ci-failure" },
      {
        orchDir,
        eventScanMod: { countRemediateCycles: () => 0 },
        fsmMod: { REMEDIATE_PHASE: "remediate", REMEDIATE_CYCLE_CAP: 3 },
        dispatchMod: {
          dispatchTicket: (od, ticket, phase) => {
            dispatchCalls += 1;
            return { code: 0, worktreePath: "/tmp/wt", signal: { bg_job_id: "bg1" } };
          },
        },
      },
    );
    expect(dispatchCalls).toBe(1);
    expect(result.success).toBe(true);
    expect(result.dispatched).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.details.bg_job_id).toBe("bg1");
  });

  test("dispatch failure (non-zero code) → success:false, dispatched:false", () => {
    const result = defaultInvokeRemediateCapped(
      "CTL-402",
      { brief: "fix it", reason: "ci-failure" },
      {
        orchDir,
        eventScanMod: { countRemediateCycles: () => 0 },
        fsmMod: { REMEDIATE_PHASE: "remediate", REMEDIATE_CYCLE_CAP: 3 },
        dispatchMod: { dispatchTicket: () => ({ code: 1, stderr: "boom" }) },
      },
    );
    expect(result.success).toBe(false);
    expect(result.dispatched).toBe(false);
    expect(result.reason).toContain("boom");
  });

  test("no orchDir → returns success:false without dispatching", () => {
    const result = defaultInvokeRemediateCapped("CTL-403", { brief: "x" }, { orchDir: null });
    expect(result.success).toBe(false);
    expect(result.reason).toBe("no orchDir");
  });
});

// ─── CTL-1176: storm-guard wiring (shadow burns the cooldown ledger) ─────────
//
// The production bug: shadow mode posted a diagnosis comment + emitted a .would-*
// event for every qualifying item, but NEVER recorded an intent — so the cooldown
// marker was never written and the SAME items re-spammed every ~14s tick forever.
// Combined with the daemon never setting CATALYST_ORCHESTRATOR_DIR (so the bare
// default ledger resolved orchDir=null and skipped nothing), shadow was an
// unconditional 19-comments-per-tick spammer. These tests pin the fix: shadow now
// writes a real cooldown intent through the SAME default ledger the scheduler
// binds to the tick's orchDir, so a second tick within the cooldown window skips.
describe("reasoningRecoveryPass shadow cooldown wiring (CTL-1176)", () => {
  let orchDir;
  beforeEach(() => {
    orchDir = mkdtempSync(pathJoin(tmpdir(), "rec-shadow-"));
  });
  afterEach(() => {
    try {
      rmSync(orchDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  test("shadow mode records a cooldown intent for each acted item", () => {
    const intents = [];
    const result = reasoningRecoveryPass(
      [
        {
          ticket: "CTL-1",
          evidence: { logsOutput: "stale main" },
        },
      ],
      {
        mode: "shadow",
        recordIntent: (ticket, intent) => intents.push({ ticket, intent }),
        postComment: () => {}, // no real shell-out
        emitEvent: () => {},
      },
    );
    expect(result.processed).toBe(1);
    // The headline fix: shadow now writes a cooldown marker.
    expect(intents.length).toBe(1);
    expect(intents[0].ticket).toBe("CTL-1");
    expect(intents[0].intent.type).toBe("recovery-pass");
    expect(intents[0].intent.decision).toBe("shadow"); // fix-class item → "shadow"
  });

  test("shadow escalation records a terminal (escalated) intent", () => {
    const intents = [];
    reasoningRecoveryPass(
      [
        {
          ticket: "CTL-2",
          evidence: { logsOutput: "unknown error", beliefState: { escalate_human: true } },
        },
      ],
      {
        mode: "shadow",
        recordIntent: (ticket, intent) => intents.push({ ticket, intent }),
        postComment: () => {},
        emitEvent: () => {},
      },
    );
    expect(intents.length).toBe(1);
    expect(intents[0].intent.decision).toBe("escalate");
    expect(intents[0].intent.escalated).toBe(true);
  });

  test("two consecutive shadow ticks: 2nd skips via the real default ledger (orchDir bound)", () => {
    // This is the production scenario: the scheduler BINDS the default ledger to
    // the tick's orchDir. Tick 1 acts + records; tick 2 within the cooldown window
    // must skip — proving the storm guard is real, not inert.
    const t0 = Date.now();
    const items = [{ ticket: "CTL-3", evidence: { logsOutput: "stale main" } }];

    const comments1 = [];
    const r1 = reasoningRecoveryPass(items, {
      mode: "shadow",
      // Bind exactly like scheduler.mjs does — orchDir threaded into the defaults.
      shouldSkipItem: (ticket) => defaultShouldSkipItem(ticket, { orchDir, now: () => t0 }),
      recordIntent: (ticket, intent) =>
        defaultRecordIntent(ticket, intent, { orchDir, now: () => t0 }),
      postComment: (ticket, c) => comments1.push(c),
      emitEvent: () => {},
    });
    expect(r1.processed).toBe(1);
    expect(comments1.length).toBe(1); // tick 1 posts a diagnosis

    // Tick 2: 1 second later, well inside the 30-min cooldown window.
    const t1 = t0 + 1000;
    const comments2 = [];
    const r2 = reasoningRecoveryPass(items, {
      mode: "shadow",
      shouldSkipItem: (ticket) => defaultShouldSkipItem(ticket, { orchDir, now: () => t1 }),
      recordIntent: (ticket, intent) =>
        defaultRecordIntent(ticket, intent, { orchDir, now: () => t1 }),
      postComment: (ticket, c) => comments2.push(c),
      emitEvent: () => {},
    });
    expect(r2.processed).toBe(0); // skipped via cooldown — NO re-spam
    expect(comments2.length).toBe(0); // zero new comments on the 2nd tick
  });
});

// ─── CTL-1176 rung 3: defaultInvokeRecoveryPass (the phase-remediate replacement) ─
//
// The bounded-LLM path now dispatches the goal-driven recovery-pass skill instead
// of disguising a brief as a fake verify finding. These pin the contract: cap
// enforcement, the FIRST-CLASS recovery-pass.json brief (with diagnosis + the
// failed-seam history off disk), and the dispatch of phase `recovery-pass`.
describe("defaultInvokeRecoveryPass (CTL-1176 rung 3)", () => {
  let orchDir;
  beforeEach(() => {
    orchDir = mkdtempSync(pathJoin(tmpdir(), "rec-pass-"));
  });
  afterEach(() => {
    try {
      rmSync(orchDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  test("refuses dispatch when recovery-pass cycle count is already at cap", () => {
    const result = defaultInvokeRecoveryPass(
      "CTL-500",
      { brief: "unstick it", reason: "merge-conflict" },
      {
        orchDir,
        eventScanMod: { countRecoveryPassCycles: () => RECOVERY_PASS_CYCLE_CAP },
        dispatchMod: { dispatchTicket: () => ({ code: 0 }) },
      },
    );
    expect(result.success).toBe(false);
    expect(result.reason).toBe("recovery-pass-cycle-cap-exhausted");
    expect(result.dispatched).toBe(false);
  });

  test("dispatches phase `recovery-pass` (NOT remediate) and writes a first-class brief", () => {
    // Seed two unstuck idempotency markers so the brief's deterministicSeamsTried
    // proves it consumed the hands' history off disk.
    const wdir = pathJoin(orchDir, "workers", "CTL-501");
    mkdirSync(wdir, { recursive: true });
    writeFileSync(pathJoin(wdir, ".unstuck-cleared-pr.applied"), "");
    writeFileSync(pathJoin(wdir, ".unstuck-force-pushed-pr.applied"), "");

    let dispatchedPhase = null;
    const result = defaultInvokeRecoveryPass(
      "CTL-501",
      {
        brief: "read both sides of the conflict and resolve",
        reason: "merge-conflict",
        evidence: { logsOutput: "CONFLICT (content): foo.ts", beliefState: { x: 1 } },
        phase: "pr",
        bgJobId: "bg501",
        failureReason: "merge-conflict",
      },
      {
        orchDir,
        eventScanMod: { countRecoveryPassCycles: () => 0 },
        dispatchMod: {
          dispatchTicket: (od, ticket, phase) => {
            dispatchedPhase = phase;
            return { code: 0, worktreePath: "/tmp/wt", signal: { bg_job_id: "bg501" } };
          },
        },
      },
    );

    expect(result.success).toBe(true);
    expect(result.dispatched).toBe(true);
    expect(dispatchedPhase).toBe(RECOVERY_PASS_PHASE); // "recovery-pass", NOT "remediate"
    expect(result.details.seamsTriedCount).toBe(2);

    // The first-class brief was written (NOT verify.json).
    const briefPath = pathJoin(wdir, "recovery-pass.json");
    expect(existsSync(briefPath)).toBe(true);
    const brief = JSON.parse(readFileSync(briefPath, "utf8"));
    expect(brief.schema).toBe("recovery-pass-brief/v1");
    expect(brief.ticket).toBe("CTL-501");
    expect(brief.failureReason).toBe("merge-conflict");
    expect(brief.diagnosis.logsOutput).toContain("CONFLICT");
    expect(brief.diagnosis.beliefState).toEqual({ x: 1 });
    // Consumed the hands' history — the two markers, not redone.
    const categories = brief.deterministicSeamsTried.map((s) => s.category).sort();
    expect(categories).toEqual(["dirty-tree", "source-conflict"]);
    expect(brief.guidance).toContain("resolve");
    // No verify.json fake-finding injection.
    expect(existsSync(pathJoin(wdir, "verify.json"))).toBe(false);
  });

  test("dispatch failure (non-zero code) → success:false, dispatched:false", () => {
    const result = defaultInvokeRecoveryPass(
      "CTL-502",
      { brief: "x", reason: "stale-branch" },
      {
        orchDir,
        eventScanMod: { countRecoveryPassCycles: () => 0 },
        dispatchMod: { dispatchTicket: () => ({ code: 1, stderr: "boom" }) },
      },
    );
    expect(result.success).toBe(false);
    expect(result.dispatched).toBe(false);
    expect(result.reason).toContain("boom");
  });

  test("no orchDir → returns success:false without dispatching", () => {
    const result = defaultInvokeRecoveryPass("CTL-503", { brief: "x" }, { orchDir: null });
    expect(result.success).toBe(false);
    expect(result.reason).toBe("no orchDir");
  });
});

// CTL-1176 rung 3: the bounded-LLM branch dispatches recovery-pass (the injected
// invokeRecoveryPass), and threads the diagnostician evidence into it.
describe("reasoningRecoveryPass bounded-LLM → recovery-pass dispatch (CTL-1176)", () => {
  test("enforce mode calls invokeRecoveryPass with the evidence threaded in", () => {
    const items = [
      {
        ticket: "CTL-600",
        phase: "pr",
        bgJobId: "bg600",
        evidence: { logsOutput: "merge conflict in foo.ts", beliefState: { r: 1 } },
      },
    ];
    const calls = [];
    const events = [];
    const result = reasoningRecoveryPass(items, {
      mode: "enforce",
      invokeRecoveryPass: (ticket, briefObj) => {
        calls.push({ ticket, briefObj });
        return { success: true, reason: "recovery-pass dispatched", details: {} };
      },
      recordIntent: () => {},
      postComment: () => {},
      emitEvent: (e) => events.push(e),
    });

    expect(result.results[0].decision).toBe("fix");
    expect(result.results[0].fix_class).toBe("bounded-llm");
    expect(calls.length).toBe(1);
    expect(calls[0].ticket).toBe("CTL-600");
    // Evidence threaded through (the eyes' output the skill consumes).
    expect(calls[0].briefObj.evidence.logsOutput).toContain("merge conflict");
    expect(calls[0].briefObj.phase).toBe("pr");
    expect(calls[0].briefObj.bgJobId).toBe("bg600");
    expect(events.some((e) => e.type === "recovery.fixed")).toBe(true);
  });

  test("back-compat: a caller that injects only invokeRemediateCapped still drives the fix", () => {
    // Legacy wiring/tests that stub the remediate dispatch directly must stay green.
    const items = [
      { ticket: "CTL-601", phase: "pr", bgJobId: "bg601", evidence: { logsOutput: "stale main" } },
    ];
    let remediateCalled = false;
    const result = reasoningRecoveryPass(items, {
      mode: "enforce",
      invokeRemediateCapped: () => {
        remediateCalled = true;
        return { success: true, reason: "fixed", details: {} };
      },
      recordIntent: () => {},
      postComment: () => {},
      emitEvent: () => {},
    });
    expect(remediateCalled).toBe(true);
    expect(result.results[0].decision).toBe("fix");
  });
});
