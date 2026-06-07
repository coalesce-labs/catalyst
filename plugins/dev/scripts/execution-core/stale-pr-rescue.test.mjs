// stale-pr-rescue.test.mjs — unit tests for CTL-782 pure decision core.
// Run: bun test plugins/dev/scripts/execution-core/stale-pr-rescue.test.mjs

import { describe, test, expect } from "bun:test";
import { classifyMergeTree, decideRescue } from "./stale-pr-rescue.mjs";

describe("classifyMergeTree", () => {
  test("exit 0 → resolvable, no conflicts (clean rebase case)", () => {
    const r = classifyMergeTree({ exitCode: 0, output: "abc123\n" });
    expect(r).toEqual({ resolvable: true, conflictFiles: [], conflictTypes: [] });
  });

  test("content + add/add conflicts within cap → resolvable", () => {
    const output = [
      "deadbeef",
      "a.mjs",
      "b.mjs",
      "",
      "CONFLICT (content): Merge conflict in a.mjs",
      "CONFLICT (add/add): Merge conflict in b.mjs",
    ].join("\n");
    const r = classifyMergeTree({ exitCode: 1, output });
    expect(r.resolvable).toBe(true);
    expect(r.conflictFiles).toEqual(["a.mjs", "b.mjs"]);
    expect(r.conflictTypes).toContain("content");
    expect(r.conflictTypes).toContain("add/add");
  });

  test("modify/delete → NOT resolvable (semantic)", () => {
    const output = "deadbeef\nx.mjs\n\nCONFLICT (modify/delete): x.mjs deleted in HEAD";
    expect(classifyMergeTree({ exitCode: 1, output }).resolvable).toBe(false);
  });

  test("rename/add → NOT resolvable", () => {
    const output = "deadbeef\ny.mjs\n\nCONFLICT (rename/add): y.mjs renamed in HEAD";
    expect(classifyMergeTree({ exitCode: 1, output }).resolvable).toBe(false);
  });

  test("more than maxConflictFiles → NOT resolvable", () => {
    const files = ["a.mjs", "b.mjs", "c.mjs", "d.mjs", "e.mjs", "f.mjs"];
    const conflicts = files.map((f) => `CONFLICT (content): Merge conflict in ${f}`);
    const output = ["deadbeef", ...files, "", ...conflicts].join("\n");
    const r = classifyMergeTree({ exitCode: 1, output }, { maxConflictFiles: 5 });
    expect(r.resolvable).toBe(false);
  });

  test("exit >1 or unparsable output → NOT resolvable (fail-safe)", () => {
    expect(classifyMergeTree({ exitCode: 128, output: "fatal: bad rev" }).resolvable).toBe(false);
  });

  test("exit 1 with no CONFLICT lines → resolvable with empty conflict lists", () => {
    const r = classifyMergeTree({ exitCode: 1, output: "deadbeef\n" });
    expect(r.resolvable).toBe(true);
    expect(r.conflictFiles).toEqual([]);
  });
});

describe("decideRescue", () => {
  const base = {
    ticket: "CTL-900",
    pr: { number: 12, url: "https://github.com/coalesce-labs/catalyst/pull/12" },
    prState: "OPEN",
    mergeStateStatus: "DIRTY",
    behindBy: 3,
    anyJobAlive: false,
    worktreeExists: true,
    rescueState: {},
    nowMs: 1_000_000_000,
    config: { stableSeconds: 300, behindThreshold: 10, maxAttempts: 1 },
    classification: { resolvable: true, conflictFiles: ["a.mjs"], conflictTypes: ["content"] },
  };

  test("live worker anywhere on the ticket → skip", () =>
    expect(decideRescue({ ...base, anyJobAlive: true }).action).toBe("skip"));

  test("PR merged/closed → skip and clear rescue state", () =>
    expect(decideRescue({ ...base, prState: "MERGED" }).action).toBe("skip"));

  test("CLEAN and not behind → skip", () =>
    expect(decideRescue({ ...base, mergeStateStatus: "CLEAN", behindBy: 0 }).action).toBe("skip"));

  test("first DIRTY observation → wait (stamps firstSeen, no dispatch)", () => {
    const d = decideRescue({ ...base, rescueState: {} });
    expect(d.action).toBe("wait");
    expect(d.detail?.stampFirstSeen).toBe(true);
  });

  test("DIRTY but younger than stableSeconds → wait", () => {
    const d = decideRescue({
      ...base,
      rescueState: { firstSeenAt: new Date(base.nowMs - 60_000).toISOString() },
    });
    expect(d.action).toBe("wait");
  });

  test("stable DIRTY + resolvable + budget left → dispatch", () => {
    const d = decideRescue({
      ...base,
      rescueState: { firstSeenAt: new Date(base.nowMs - 600_000).toISOString() },
    });
    expect(d.action).toBe("dispatch");
  });

  test("stable DIRTY + NOT resolvable → escalate with files + behindBy", () => {
    const d = decideRescue({
      ...base,
      classification: {
        resolvable: false,
        conflictFiles: ["x.mjs"],
        conflictTypes: ["modify/delete"],
      },
      rescueState: { firstSeenAt: new Date(base.nowMs - 600_000).toISOString() },
    });
    expect(d.action).toBe("escalate");
    expect(d.detail.conflictFiles).toEqual(["x.mjs"]);
    expect(d.detail.behindBy).toBe(3);
  });

  test("budget exhausted → escalate once", () => {
    const d = decideRescue({
      ...base,
      rescueState: { firstSeenAt: "2026-01-01T00:00:00Z", rescueAttempts: 1 },
    });
    expect(d.action).toBe("escalate");
    expect(d.reason).toBe("rescue_budget_exhausted");
  });

  test("already escalated (rescueState.escalatedAt) → skip (no re-escalation loop)", () => {
    const d = decideRescue({
      ...base,
      rescueState: {
        firstSeenAt: new Date(base.nowMs - 600_000).toISOString(),
        escalatedAt: new Date(base.nowMs - 100_000).toISOString(),
      },
    });
    expect(d.action).toBe("skip");
  });

  test("worktree missing → escalate reason worktree_missing", () =>
    expect(decideRescue({ ...base, worktreeExists: false }).reason).toBe("worktree_missing"));

  test("BEHIND but under threshold → skip", () =>
    expect(
      decideRescue({ ...base, mergeStateStatus: "BEHIND", behindBy: 4, classification: null }).action
    ).toBe("skip"));

  test("BEHIND > threshold → dispatch (no merge-tree needed)", () => {
    const d = decideRescue({
      ...base,
      mergeStateStatus: "BEHIND",
      behindBy: 25,
      classification: null,
      rescueState: { firstSeenAt: new Date(base.nowMs - 600_000).toISOString() },
    });
    expect(d.action).toBe("dispatch");
  });

  test("null classification on DIRTY → escalate (cannot classify)", () => {
    const d = decideRescue({
      ...base,
      classification: null,
      rescueState: { firstSeenAt: new Date(base.nowMs - 600_000).toISOString() },
    });
    expect(d.action).toBe("escalate");
    expect(d.reason).toBe("unclassified_dirty");
  });
});
