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
  readDeferredBoardHealthIntents,
  defaultShouldSkipItem,
  defaultForgetIntent,
  defaultInvokeRemediateCapped,
  defaultInvokeRecoveryPass,
  defaultWriteEscalationSignal,
  RECOVERY_PASS_CYCLE_CAP,
  RECOVERY_PASS_PHASE,
  RECOVERY_MAX_ATTEMPTS,
  RECOVERY_COOLDOWN_MS,
  RECOVERY_TERMINAL_INTENT_TTL_MS,
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

  // CTL-1157 F #5 (Codex round-4): a `defer` decision must NOT write the cooldown
  // marker in SHADOW mode — defaultShouldSkipItem honors a defer marker in enforce too,
  // so a shadow-written marker would silently suppress the ticket after an operator
  // flips shadow→enforce (shadow mutating enforce scheduler state). Enforce still writes.
  const deferClassifier = () => ({
    decision: "defer",
    fix_class: "board-health",
    details: { reason: "untyped stuck item" },
  });

  test("defer in SHADOW emits would-defer but writes NO cooldown marker", () => {
    const intents = [];
    const events = [];
    const result = reasoningRecoveryPass([baseItem], {
      mode: "shadow",
      classifyTicket: deferClassifier,
      recordIntent: (ticket, intent) => intents.push({ ticket, intent }),
      emitEvent: (e) => events.push(e),
      postComment: () => {},
    });
    expect(result.results[0].decision).toBe("defer");
    expect(intents).toEqual([]); // shadow mutates NO scheduler state
    expect(events.some((e) => e.type === "recovery.would-defer")).toBe(true);
  });

  test("defer in ENFORCE writes the cooldown-only defer marker", () => {
    const intents = [];
    const events = [];
    reasoningRecoveryPass([baseItem], {
      mode: "enforce",
      classifyTicket: deferClassifier,
      recordIntent: (ticket, intent) => intents.push({ ticket, intent }),
      emitEvent: (e) => events.push(e),
      postComment: () => {},
    });
    expect(intents).toHaveLength(1);
    expect(intents[0].intent).toMatchObject({ decision: "defer" });
    expect(events.some((e) => e.type === "recovery.deferred")).toBe(true);
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
    // CTL-1287: the pass now emits ONE recovery.tick rollup per invocation even
    // when every item is skipped (that's the whole point — a silently-skipped
    // board is no longer invisible). The skipped ticket appears in ledgerSkipped,
    // and NO action event (recovery.fixed/escalated/decision) is emitted.
    const actionEvents = events.filter((e) => e.type !== "recovery.tick");
    expect(actionEvents.length).toBe(0);
    const tick = events.find((e) => e.type === "recovery.tick");
    expect(tick.details.ledgerSkipped).toEqual(["CTL-9"]);
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

// ─── CTL-1291: chartable numeric/enum attribute promotion ───────────────────
// The forwarder ships ONLY OTel attributes (+ event.name) to Loki; body.payload
// is dropped from the log line. So the numbers a recovery.tick/decision carries
// are unqueryable until they ride out as attributes. Promote bounded numerics +
// bounded enums; arrays promote as LENGTH (never the roster — cardinality).
describe("buildRecoveryEnvelope numeric/enum promotion (CTL-1291)", () => {
  test("recovery.tick promotes counts + mode enum to attributes", () => {
    const details = {
      mode: "enforce",
      queueSize: 12,
      processed: 3,
      decisions: { fix_seam: 1, fix_bounded_llm: 1, escalate: 1, defer: 4 },
      actions: { fixed: 2, fixFailed: 0, escalated: 1, deferred: 0, errors: 0 },
      ledgerSkipped: ["CTL-1", "CTL-2"],
      terminalSkipped: ["CTL-3"],
    };
    const env = buildRecoveryEnvelope({ type: "recovery.tick", ticket: null, reason: "r", details });
    const a = env.attributes;
    expect(a["recovery.queue_size"]).toBe(12);
    expect(a["recovery.processed"]).toBe(3);
    expect(a["recovery.decisions.fix_seam"]).toBe(1);
    expect(a["recovery.decisions.fix_bounded_llm"]).toBe(1);
    expect(a["recovery.decisions.escalate"]).toBe(1);
    // CTL-1157 GROUP B: the defer counter must be promoted so defer volume is
    // queryable after otel-forward (else it's left only in body.payload.details).
    expect(a["recovery.decisions.defer"]).toBe(4);
    expect(a["recovery.actions.fixed"]).toBe(2);
    expect(a["recovery.actions.fix_failed"]).toBe(0);
    expect(a["recovery.actions.escalated"]).toBe(1);
    expect(a["recovery.actions.deferred"]).toBe(0);
    expect(a["recovery.actions.errors"]).toBe(0);
    // arrays promote as LENGTH, never the roster
    expect(a["recovery.ledger_skipped"]).toBe(2);
    expect(a["recovery.terminal_skipped"]).toBe(1);
    expect(a["recovery.mode"]).toBe("enforce");
    // the rosters themselves must NOT become attributes (cardinality)
    expect(Array.isArray(a["recovery.ledger_skipped"])).toBe(false);
    expect(a["recovery.ledgerSkipped"]).toBeUndefined();
  });

  test("recovery.decision promotes rule (num) + decision/mode (enum)", () => {
    const env = buildRecoveryEnvelope({
      type: "recovery.decision",
      ticket: "CTL-1029",
      fix_class: "bounded-llm",
      details: { rule: 2, decision: "fix", mode: "shadow" },
    });
    const a = env.attributes;
    expect(a["recovery.rule"]).toBe(2);
    expect(a["recovery.decision"]).toBe("fix");
    expect(a["recovery.mode"]).toBe("shadow");
    expect(a["event.label"]).toBe("CTL-1029"); // unchanged canonical attr
  });

  test("body.payload.details stays intact (back-compat / dual-write)", () => {
    const details = {
      mode: "enforce",
      queueSize: 7,
      processed: 1,
      decisions: { fix_seam: 0, fix_bounded_llm: 0, escalate: 0 },
      actions: { fixed: 0, fixFailed: 0, escalated: 0, deferred: 0, errors: 0 },
      ledgerSkipped: [],
      terminalSkipped: [],
    };
    const env = buildRecoveryEnvelope({ type: "recovery.tick", ticket: null, details });
    expect(env.body.payload.details).toEqual(details);
  });

  test("null / malformed details → no promoted attrs, never throws", () => {
    const env1 = buildRecoveryEnvelope({ type: "recovery.tick", ticket: null, details: null });
    expect(env1.attributes["recovery.queue_size"]).toBeUndefined();
    const env2 = buildRecoveryEnvelope({ type: "recovery.tick", ticket: null, details: "nope" });
    expect(env2.attributes["recovery.queue_size"]).toBeUndefined();
  });

  test("non-finite numbers and over-long strings are dropped", () => {
    const env = buildRecoveryEnvelope({
      type: "recovery.tick",
      ticket: null,
      details: { mode: "x".repeat(100), queueSize: Infinity, processed: NaN },
    });
    expect(env.attributes["recovery.queue_size"]).toBeUndefined();
    expect(env.attributes["recovery.processed"]).toBeUndefined();
    expect(env.attributes["recovery.mode"]).toBeUndefined(); // >64 chars dropped
  });

  test("unknown recovery.* type promotes nothing (e.g. recovery.fixed)", () => {
    const env = buildRecoveryEnvelope({ type: "recovery.fixed", ticket: "CTL-9", details: { foo: 1 } });
    expect(env.attributes["recovery.queue_size"]).toBeUndefined();
    expect(env.attributes["recovery.rule"]).toBeUndefined();
    expect(env.attributes["event.name"]).toBe("recovery.fixed"); // canonical attrs intact
  });

  // ─── CTL-1290: the recovery.board-scan branch ───────────────────────────────
  test("recovery.board-scan promotes board scalars, gate enums, and per-invariant failed counts", () => {
    const details = {
      mode: "shadow",
      invariantsFailed: 2,
      gateDecision: "proceed",
      gateReason: "2 invariant(s) flagged",
      proposedTier1: 1,
      proposedTier2: 0,
      proposedTier3: 1,
      invariants: {
        dispatchLiveness: { ok: false, failed: 1, observable: true },
        projectSilence: { ok: false, failed: 1, observable: true },
        workerAge: { ok: true, failed: 0, observable: true },
      },
      flagged: ["CTL-1", "CTL-2"],
      tier1Moves: [{ move: "kick-dispatch" }],
      tier3Moves: [{ project: "P1", move: "escalate-project-silence" }],
    };
    const env = buildRecoveryEnvelope({ type: "recovery.board-scan", ticket: null, reason: "r", details });
    const a = env.attributes;
    expect(a["recovery.invariants_failed"]).toBe(2);
    expect(a["recovery.proposed.tier1"]).toBe(1);
    expect(a["recovery.proposed.tier2"]).toBe(0);
    expect(a["recovery.proposed.tier3"]).toBe(1);
    expect(a["recovery.gate_decision"]).toBe("proceed");
    expect(a["recovery.gate_reason"]).toBe("2 invariant(s) flagged");
    expect(a["recovery.mode"]).toBe("shadow");
    // per-invariant failed counts chart individually
    expect(a["recovery.inv.dispatchLiveness.failed"]).toBe(1);
    expect(a["recovery.inv.projectSilence.failed"]).toBe(1);
    expect(a["recovery.inv.workerAge.failed"]).toBe(0);
    // board-scoped → event.label is null (the board reader ignores it; no per-ticket fold)
    expect(a["event.label"]).toBeNull();
  });

  // CTL-1157 SLICE 3 (OTEL turn-56): the three stuck-cohort failed-counts promote
  // under the AGREED underscored top-level names (queryable structured metadata, not
  // body-buried), in ADDITION to the camelCase recovery.inv.<key>.failed mirror.
  test("recovery.board-scan promotes the three cohort failed-counts under cohort_* names", () => {
    const details = {
      mode: "shadow",
      invariantsFailed: 3,
      gateDecision: "proceed",
      gateReason: "3 invariant(s) flagged",
      proposedTier1: 0, proposedTier2: 0, proposedTier3: 0,
      invariants: {
        phantomMergedPr: { ok: false, failed: 2, observable: true },
        orphanedOpenPr: { ok: false, failed: 1, observable: true },
        frozenNeedsHuman: { ok: false, failed: 4, observable: true },
        needsHumanPile: { ok: true, failed: 0, observable: true },
      },
    };
    const a = buildRecoveryEnvelope({ type: "recovery.board-scan", ticket: null, details }).attributes;
    expect(a.cohort_phantom_merged_pr).toBe(2);
    expect(a.cohort_orphaned_pr).toBe(1);
    expect(a.cohort_frozen_needs_human).toBe(4);
    // the camelCase per-invariant mirror still rides alongside (back-compat)
    expect(a["recovery.inv.phantomMergedPr.failed"]).toBe(2);
  });

  test("recovery.board-scan never promotes rosters/move arrays (cardinality)", () => {
    const details = {
      mode: "shadow",
      invariantsFailed: 1,
      gateDecision: "proceed",
      gateReason: "1 invariant(s) flagged",
      proposedTier1: 1, proposedTier2: 0, proposedTier3: 0,
      invariants: { dispatchLiveness: { ok: false, failed: 1, observable: true } },
      flagged: ["CTL-1", "CTL-2", "CTL-3"],
      tier1Moves: [{ move: "kick-dispatch" }],
    };
    const env = buildRecoveryEnvelope({ type: "recovery.board-scan", ticket: null, details });
    const a = env.attributes;
    // no attribute value is an array, and the raw rosters are not lifted by key
    for (const v of Object.values(a)) expect(Array.isArray(v)).toBe(false);
    expect(a["recovery.flagged"]).toBeUndefined();
    expect(a["recovery.tier1Moves"]).toBeUndefined();
    expect(a.flagged).toBeUndefined();
    // back-compat: the full details object still rides in body.payload
    expect(env.body.payload.details).toEqual(details);
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

  // CTL-1242 (corrected scope): forget the latch when a ticket goes terminal.
  test("forgetIntent removes the ledger entry → a later shouldSkip is false", () => {
    const now = 1_000_000_000_000;
    defaultRecordIntent("CTL-306", { decision: "escalate" }, { orchDir, now: () => now });
    // Escalated latch would skip forever…
    expect(defaultShouldSkipItem("CTL-306", { orchDir, now: () => now + 1 })).toBe(true);
    // …until the terminal sweep forgets it.
    expect(defaultForgetIntent("CTL-306", { orchDir })).toBe(true);
    expect(defaultShouldSkipItem("CTL-306", { orchDir, now: () => now + 2 })).toBe(false);
  });

  test("forgetIntent on an absent ledger → false (idempotent no-op, never throws)", () => {
    expect(defaultForgetIntent("CTL-307", { orchDir })).toBe(false);
    // Re-running after a real forget is also a no-op.
    defaultRecordIntent("CTL-308", { decision: "fix", fix_class: "x" }, { orchDir, now: () => 1 });
    expect(defaultForgetIntent("CTL-308", { orchDir })).toBe(true);
    expect(defaultForgetIntent("CTL-308", { orchDir })).toBe(false);
  });

  test("forgetIntent with no orchDir / no ticket → false (fail-soft)", () => {
    expect(defaultForgetIntent("CTL-309", { orchDir: null })).toBe(false);
    expect(defaultForgetIntent("", { orchDir })).toBe(false);
  });
});

// CTL-1431: the escalated latch is TTL-bounded. Within the terminal TTL it still
// skips (hand off to human); once it ages past RECOVERY_TERMINAL_INTENT_TTL_MS the
// ticket re-enters the recovery triage funnel. The critical invariant is the DIRECT
// return false on expiry — the escalated branch must short-circuit, never fall
// through to the attempts-exhausted branch (which has no age gate and would re-latch).
describe("recovery-intent terminal TTL (CTL-1431)", () => {
  let orchDir;
  beforeEach(() => {
    orchDir = mkdtempSync(pathJoin(tmpdir(), "rec-ttl-"));
  });
  afterEach(() => {
    try {
      rmSync(orchDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  test("(a) escalated intent younger than TTL still skips (returns true)", () => {
    const t0 = 1_000_000_000_000;
    defaultRecordIntent("CTL-1431-A", { decision: "escalate" }, { orchDir, now: () => t0 });
    const within = t0 + RECOVERY_TERMINAL_INTENT_TTL_MS - 1;
    expect(defaultShouldSkipItem("CTL-1431-A", { orchDir, now: () => within })).toBe(true);
  });

  test("(b) escalated intent older than TTL re-enters triage (returns false)", () => {
    const t0 = 1_000_000_000_000;
    defaultRecordIntent("CTL-1431-B", { decision: "escalate" }, { orchDir, now: () => t0 });
    const past = t0 + RECOVERY_TERMINAL_INTENT_TTL_MS + 1;
    expect(defaultShouldSkipItem("CTL-1431-B", { orchDir, now: () => past })).toBe(false);
  });

  test("(c) escalated + attempts ≥ MAX but older than TTL still returns false (short-circuit, not fall-through)", () => {
    const t0 = 1_000_000_000_000;
    // attempts pinned well above RECOVERY_MAX_ATTEMPTS: if the escalated branch fell
    // THROUGH to the attempts-exhausted branch (which has no age gate), this expired
    // intent would skip (true). It must short-circuit to false instead.
    defaultRecordIntent(
      "CTL-1431-C",
      { decision: "escalate", attempts: RECOVERY_MAX_ATTEMPTS + 3 },
      { orchDir, now: () => t0 },
    );
    const past = t0 + RECOVERY_TERMINAL_INTENT_TTL_MS + 1;
    expect(defaultShouldSkipItem("CTL-1431-C", { orchDir, now: () => past })).toBe(false);
  });

  test("(d) keys off lastTs not ts: fresh lastTs with a stale ts is NOT expired (returns true)", () => {
    const t0 = 1_000_000_000_000;
    const TTL = RECOVERY_TERMINAL_INTENT_TTL_MS;
    // First escalate sets ts = lastTs = t0.
    defaultRecordIntent("CTL-1431-D", { decision: "escalate" }, { orchDir, now: () => t0 });
    // A later write advances lastTs to t1 but PRESERVES the first-action ts at t0.
    const t1 = t0 + TTL;
    defaultRecordIntent("CTL-1431-D", { decision: "fix", fix_class: "x" }, { orchDir, now: () => t1 });
    // Evaluate at t1 + TTL/2: age off lastTs is TTL/2 (< TTL → skip), but age off the
    // stale ts would be 1.5·TTL (> TTL → would re-enter). Keying off lastTs → true.
    const nowT = t1 + TTL / 2;
    expect(defaultShouldSkipItem("CTL-1431-D", { orchDir, now: () => nowT })).toBe(true);
  });

  test("(F3) escalated with NO timestamp stays terminal (clear-cooldown case, returns true)", () => {
    const t0 = 1_000_000_000_000;
    defaultRecordIntent("CTL-1431-F3", { decision: "escalate" }, { orchDir, now: () => t0 });
    // Delete both timestamps, mimicking defaultClearIntentCooldown (which keeps
    // `escalated` as a deliberate terminal latch). Such an entry can't be aged out.
    const p = pathJoin(orchDir, ".recovery-intents", "CTL-1431-F3.json");
    const data = JSON.parse(readFileSync(p, "utf8"));
    delete data.ts;
    delete data.lastTs;
    writeFileSync(p, JSON.stringify(data));
    expect(defaultShouldSkipItem("CTL-1431-F3", { orchDir, now: () => t0 + 1 })).toBe(true);
  });

  test("(F2) a fix recorded AFTER TTL expiry drops the escalated latch (no silent re-latch)", () => {
    const t0 = 1_000_000_000_000;
    defaultRecordIntent("CTL-1431-F2", { decision: "escalate" }, { orchDir, now: () => t0 });
    const past = t0 + RECOVERY_TERMINAL_INTENT_TTL_MS + 1;
    const entry = defaultRecordIntent(
      "CTL-1431-F2",
      { decision: "fix", fix_class: "x" },
      { orchDir, now: () => past },
    );
    // The ticket has re-entered triage; a follow-up fix must NOT re-latch it for
    // another 7 days. escalated is cleared → the entry is governed by attempts/cooldown.
    expect(entry.escalated).toBe(false);
  });

  test("(F2) a fix recorded WITHIN the TTL preserves the escalated latch", () => {
    const t0 = 1_000_000_000_000;
    defaultRecordIntent("CTL-1431-F2b", { decision: "escalate" }, { orchDir, now: () => t0 });
    const within = t0 + RECOVERY_TERMINAL_INTENT_TTL_MS - 1;
    const entry = defaultRecordIntent(
      "CTL-1431-F2b",
      { decision: "fix", fix_class: "x" },
      { orchDir, now: () => within },
    );
    expect(entry.escalated).toBe(true);
  });
});

// ─── CTL-1432 (B2): readDeferredBoardHealthIntents ──────────────────────────
describe("readDeferredBoardHealthIntents (CTL-1432 B2)", () => {
  let orchDir;
  beforeEach(() => {
    orchDir = mkdtempSync(pathJoin(tmpdir(), "rec-defer-"));
  });
  afterEach(() => {
    try {
      rmSync(orchDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  test("returns ONLY defer + fix_class=board-health tickets", () => {
    const t0 = 1_000_000_000_000;
    defaultRecordIntent("ADV-1403", { decision: "defer", fix_class: "board-health" }, { orchDir, now: () => t0 });
    defaultRecordIntent("CTL-900", { decision: "defer", fix_class: "bounded-llm" }, { orchDir, now: () => t0 });
    defaultRecordIntent("CTL-901", { decision: "fix", fix_class: "board-health" }, { orchDir, now: () => t0 });
    const out = readDeferredBoardHealthIntents(orchDir);
    expect(out).toEqual(["ADV-1403"]);
  });

  test("fail-open: absent dir / no orchDir → []", () => {
    expect(readDeferredBoardHealthIntents(pathJoin(orchDir, "does-not-exist"))).toEqual([]);
    expect(readDeferredBoardHealthIntents(null)).toEqual([]);
  });

  test("(Codex P1 r3) a deferred intent still inside its 30-min cooldown is NOT returned", () => {
    const t0 = 1_000_000_000_000;
    defaultRecordIntent("ADV-COOL", { decision: "defer", fix_class: "board-health" }, { orchDir, now: () => t0 });
    // within cooldown → excluded (it would proceed the gate then be skipped at the act site)
    expect(readDeferredBoardHealthIntents(orchDir, { now: () => t0 + 1_000 })).toEqual([]);
    // past cooldown → included
    expect(readDeferredBoardHealthIntents(orchDir, { now: () => t0 + RECOVERY_COOLDOWN_MS + 1 })).toContain("ADV-COOL");
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
    expect(brief.schema).toBe("recovery-pass-brief/v2");
    expect(brief.ticket).toBe("CTL-501");
    expect(brief.failureReason).toBe("merge-conflict");
    // CTL-1290: boardContext present (null here — no board scan attached by this caller)
    expect(brief.boardContext).toBeNull();
    expect(brief.diagnosis.logsOutput).toContain("CONFLICT");
    expect(brief.diagnosis.beliefState).toEqual({ x: 1 });
    // Consumed the hands' history — the two markers, not redone.
    const categories = brief.deterministicSeamsTried.map((s) => s.category).sort();
    expect(categories).toEqual(["dirty-tree", "source-conflict"]);
    expect(brief.guidance).toContain("resolve");
    // No verify.json fake-finding injection.
    expect(existsSync(pathJoin(wdir, "verify.json"))).toBe(false);
  });

  test("CTL-1290: boardContext from briefObj is written into the v2 brief", () => {
    const boardContext = {
      schema: "recovery-board-context/v1",
      slots: { capacity: 4, inUse: 3, free: 1 },
      eligibleQueue: { depth: 2, topTickets: ["CTL-1", "CTL-2"] },
      stuckWorkers: [{ ticket: "CTL-9", phase: "implement", status: "running", ageSeconds: 18000 }],
      strandedNodes: [],
      invariants: { dispatchLiveness: { ok: false, failed: 1 } },
    };
    const result = defaultInvokeRecoveryPass(
      "CTL-503",
      { brief: "x", reason: "stuck", boardContext },
      {
        orchDir,
        eventScanMod: { countRecoveryPassCycles: () => 0 },
        dispatchMod: { dispatchTicket: () => ({ code: 0, worktreePath: "/tmp/wt", signal: {} }) },
      },
    );
    expect(result.dispatched).toBe(true);
    const brief = JSON.parse(readFileSync(pathJoin(orchDir, "workers", "CTL-503", "recovery-pass.json"), "utf8"));
    expect(brief.schema).toBe("recovery-pass-brief/v2");
    expect(brief.boardContext).toEqual(boardContext);
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

// ─── CTL-1241: R12 belief state → escalation reason text end-to-end ──────────
describe("CTL-1241 — R12 escalate_human belief wired into recovery evidence", () => {
  test("determineEscalationReason with beliefState.escalate_human=true includes R12 text", () => {
    const reason = determineEscalationReason(
      null,
      null,
      {},
      { escalate_human: true, why: "R10+R11 co-occur" }
    );
    expect(reason).toContain("Rule belief R12 escalate_human fired");
  });

  test("determineEscalationReason without beliefState does NOT include R12 text", () => {
    const reason = determineEscalationReason(null, null, {}, undefined);
    expect(reason).not.toContain("R12");
  });

  test("defaultClassifyTicket with beliefState escalates and reason includes R12 text", () => {
    const result = defaultClassifyTicket({
      logsOutput: "some unknown stuck state",
      beliefState: { escalate_human: true, why: "R10+R11 co-occur" },
    });
    expect(result.decision).toBe("escalate");
    expect(result.fix_class).toBe("human");
    expect(result.details.reason).toContain("Rule belief R12 escalate_human fired");
  });
});

// ─── CTL-1287: per-tick decision visibility (recovery.tick / recovery.decision) ─
describe("reasoningRecoveryPass decision visibility (CTL-1287)", () => {
  // Common injections that keep the pass pure (no shell-out, no real ledger).
  const inert = {
    postComment: () => {},
    recordIntent: () => {},
    invokeRemediateCapped: () => ({ success: true, reason: "fixed", details: {} }),
  };

  test("emits exactly one recovery.tick rollup per invocation, with queueSize", () => {
    const events = [];
    reasoningRecoveryPass(
      [
        { ticket: "CTL-1", evidence: { logsOutput: "stale main" } },
        { ticket: "CTL-2", evidence: { logsOutput: "unknown error" } },
      ],
      { mode: "enforce", emitEvent: (e) => events.push(e), ...inert },
    );
    const ticks = events.filter((e) => e.type === "recovery.tick");
    expect(ticks.length).toBe(1);
    expect(ticks[0].details.queueSize).toBe(2);
    expect(ticks[0].details.mode).toBe("enforce");
  });

  test("recovery.tick details carry decision + action counters", () => {
    const events = [];
    reasoningRecoveryPass(
      [
        { ticket: "CTL-1", evidence: { logsOutput: "stale main" } }, // bounded-llm fix
        { ticket: "CTL-2", evidence: { logsOutput: "unknown error", beliefState: { escalate_human: true } } }, // escalate
      ],
      { mode: "enforce", emitEvent: (e) => events.push(e), ...inert },
    );
    const tick = events.find((e) => e.type === "recovery.tick").details;
    expect(tick.processed).toBe(2);
    expect(tick.decisions.fix_bounded_llm).toBe(1);
    expect(tick.decisions.escalate).toBe(1);
    expect(tick.actions.fixed).toBe(1);
    expect(tick.actions.escalated).toBe(1);
  });

  test("ledger-skipped items land in ledgerSkipped[] and are NOT processed", () => {
    const events = [];
    reasoningRecoveryPass(
      [
        { ticket: "CTL-1", evidence: { logsOutput: "stale main" } }, // processed
        { ticket: "CTL-2", evidence: { logsOutput: "stale main" } }, // skipped
      ],
      {
        mode: "enforce",
        shouldSkipItem: (t) => t === "CTL-2",
        emitEvent: (e) => events.push(e),
        ...inert,
      },
    );
    const tick = events.find((e) => e.type === "recovery.tick").details;
    expect(tick.ledgerSkipped).toEqual(["CTL-2"]);
    expect(tick.processed).toBe(1);
    // a skipped item never reaches the classifier → no recovery.decision for it
    expect(events.some((e) => e.type === "recovery.decision" && e.ticket === "CTL-2")).toBe(false);
  });

  test("linear-terminal items land in terminalSkipped[]", () => {
    const events = [];
    reasoningRecoveryPass(
      [{ ticket: "CTL-999", evidence: { linearTerminal: true, signal: {} } }],
      { mode: "enforce", emitEvent: (e) => events.push(e), ...inert },
    );
    const tick = events.find((e) => e.type === "recovery.tick").details;
    expect(tick.terminalSkipped).toEqual(["CTL-999"]);
    expect(tick.processed).toBe(0);
  });

  test("emits a recovery.decision per classified item with the routing rule", () => {
    const events = [];
    reasoningRecoveryPass(
      [
        { ticket: "CTL-1", evidence: { logsOutput: "push rejected no workflow scope" } }, // seam → rule 1
        { ticket: "CTL-2", evidence: { logsOutput: "stale main" } }, // bounded-llm → rule 2
        { ticket: "CTL-3", evidence: { logsOutput: "unknown error", beliefState: { escalate_human: true } } }, // escalate → rule 3
      ],
      { mode: "shadow", emitEvent: (e) => events.push(e), postComment: () => {} },
    );
    const decisions = events.filter((e) => e.type === "recovery.decision");
    expect(decisions.length).toBe(3);
    expect(decisions.find((d) => d.ticket === "CTL-1").details.rule).toBe(1);
    expect(decisions.find((d) => d.ticket === "CTL-2").details.rule).toBe(2);
    expect(decisions.find((d) => d.ticket === "CTL-3").details.rule).toBe(3);
  });

  test("deferred items (fix cap) are counted in actions.deferred", () => {
    const events = [];
    reasoningRecoveryPass(
      Array.from({ length: 4 }, (_, i) => ({ ticket: `CTL-${10 + i}`, evidence: { logsOutput: "stale main" } })),
      { mode: "enforce", maxFixesPerTick: 2, emitEvent: (e) => events.push(e), ...inert },
    );
    const tick = events.find((e) => e.type === "recovery.tick").details;
    expect(tick.actions.fixed).toBe(2);
    expect(tick.actions.deferred).toBe(2);
  });

  test("mode=off emits no recovery.tick (the pass short-circuits)", () => {
    const events = [];
    reasoningRecoveryPass([{ ticket: "CTL-1", evidence: {} }], {
      mode: "off",
      emitEvent: (e) => events.push(e),
    });
    expect(events.length).toBe(0);
  });

  test("buildRecoveryEnvelope shapes a ticket-less recovery.tick (label null, action 'tick')", () => {
    const env = buildRecoveryEnvelope({
      type: "recovery.tick",
      details: { mode: "enforce", queueSize: 3 },
    });
    expect(env.attributes["event.name"]).toBe("recovery.tick");
    expect(env.attributes["event.action"]).toBe("tick");
    expect(env.attributes["event.label"]).toBeNull();
    expect(env.severityText).toBe("INFO");
    expect(env.body.payload.details.queueSize).toBe(3);
  });
});

// ─── CTL-1157 F #6 (Codex round-4): escalation signal must carry `ticket` ─────
// signal-reader parseSignal keys off raw.ticket and status:"needs-human" is
// non-terminal, so this fresh recovery-pass signal wins over the failed phase.
// Without a ticket, readWorkerSignals() reports ticket:null and scheduler-recovery /
// board-health consumers lose the escalated ticket after the first pass.
describe("defaultWriteEscalationSignal (CTL-1157 F #6)", () => {
  test("the written phase-recovery-pass.json carries the ticket", () => {
    const orchDir = mkdtempSync(pathJoin(tmpdir(), "esc-"));
    try {
      defaultWriteEscalationSignal(
        "CTL-42",
        { escalation_type: "manual", problem: "stuck", call_to_action: "look" },
        { orchDir },
      );
      const p = pathJoin(orchDir, "workers", "CTL-42", "phase-recovery-pass.json");
      expect(existsSync(p)).toBe(true);
      const signal = JSON.parse(readFileSync(p, "utf8"));
      expect(signal.ticket).toBe("CTL-42"); // the fix: never null
      expect(signal.status).toBe("needs-human");
      expect(signal.explanation).toBeDefined();
    } finally {
      rmSync(orchDir, { recursive: true, force: true });
    }
  });
});
