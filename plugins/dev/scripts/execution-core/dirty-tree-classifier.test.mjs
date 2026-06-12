// dirty-tree-classifier.test.mjs — CTL-1064 Category A pure classifier tests.

import { describe, test, expect } from "bun:test";
import {
  classifyDirtyTreeRecoverable,
  isNodeModulesDeletion,
  filterMachineLocalDirt,
  REBASE_NOISE_PATHS,
} from "./dirty-tree-classifier.mjs";

// ---------------------------------------------------------------------------
// isNodeModulesDeletion
// ---------------------------------------------------------------------------
describe("isNodeModulesDeletion (CTL-1064 catA helper)", () => {
  test("' D node_modules' → true (worktree deletion)", () => {
    expect(isNodeModulesDeletion(" D node_modules")).toBe(true);
  });

  test("' D node_modules/react/index.js' → true", () => {
    expect(isNodeModulesDeletion(" D node_modules/react/index.js")).toBe(true);
  });

  test("'D  node_modules' → true (index deletion)", () => {
    expect(isNodeModulesDeletion("D  node_modules")).toBe(true);
  });

  test("' M node_modules/react/index.js' → false (modification, not deletion)", () => {
    expect(isNodeModulesDeletion(" M node_modules/react/index.js")).toBe(false);
  });

  test("' D src/index.mjs' → false (not under node_modules)", () => {
    expect(isNodeModulesDeletion(" D src/index.mjs")).toBe(false);
  });

  test("'?? node_modules/' → false (untracked, not deletion)", () => {
    expect(isNodeModulesDeletion("?? node_modules/")).toBe(false);
  });

  test("empty string → false", () => {
    expect(isNodeModulesDeletion("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// filterMachineLocalDirt
// ---------------------------------------------------------------------------
describe("filterMachineLocalDirt (CTL-1064 catA helper)", () => {
  test("REBASE_NOISE_PATHS entries filtered out", () => {
    const lines = [
      " M .catalyst/config.json",
      " M .claude/settings.json",
      " M .trunk/logs",
      " M src/foo.mjs",
    ];
    const dirt = filterMachineLocalDirt(lines);
    expect(dirt).toHaveLength(1);
    expect(dirt[0]).toBe(" M src/foo.mjs");
  });

  test("deleted node_modules filtered out", () => {
    const lines = [" D node_modules", " D node_modules/react/index.js"];
    expect(filterMachineLocalDirt(lines)).toHaveLength(0);
  });

  test("noise + deleted node_modules → all filtered", () => {
    const lines = [" M .catalyst/config.json", " D node_modules"];
    expect(filterMachineLocalDirt(lines)).toHaveLength(0);
  });

  test("real source file survives", () => {
    const lines = [" M src/foo.mjs"];
    expect(filterMachineLocalDirt(lines)).toHaveLength(1);
  });

  test("untracked file survives", () => {
    const lines = ["?? scratch.json"];
    expect(filterMachineLocalDirt(lines)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// classifyDirtyTreeRecoverable
// ---------------------------------------------------------------------------
describe("classifyDirtyTreeRecoverable (CTL-1064 catA)", () => {
  const BASE = {
    stalledReason: "rebase_refused_dirty_tree",
    liveSessionInWorktree: false,
    linearTerminal: false,
    alreadyCleared: false,
  };

  test("empty porcelain after noise filtering → clear-retry", () => {
    expect(classifyDirtyTreeRecoverable({ ...BASE, porcelain: "" }).action).toBe("clear-retry");
  });

  test("only REBASE_NOISE_PATHS entries → clear-retry", () => {
    const p = " M .catalyst/config.json\n M .claude/settings.json\n M .trunk/logs";
    expect(classifyDirtyTreeRecoverable({ ...BASE, porcelain: p }).action).toBe("clear-retry");
  });

  test("only deleted node_modules → clear-retry", () => {
    const p = "D  node_modules\n D node_modules/foo/bar.js";
    expect(classifyDirtyTreeRecoverable({ ...BASE, porcelain: p }).action).toBe("clear-retry");
  });

  test("noise + deleted node_modules → clear-retry", () => {
    const p = " M .catalyst/config.json\n D node_modules";
    expect(classifyDirtyTreeRecoverable({ ...BASE, porcelain: p }).action).toBe("clear-retry");
  });

  test("real tracked source file ( M src/foo.mjs) → escalate", () => {
    expect(classifyDirtyTreeRecoverable({ ...BASE, porcelain: " M src/foo.mjs" }).action).toBe("escalate");
  });

  test("untracked file (?? scratch.json) → escalate", () => {
    expect(classifyDirtyTreeRecoverable({ ...BASE, porcelain: "?? scratch.json" }).action).toBe("escalate");
  });

  test("mix of real dirt + noise → escalate", () => {
    const p = " M .catalyst/config.json\n M src/foo.mjs";
    expect(classifyDirtyTreeRecoverable({ ...BASE, porcelain: p }).action).toBe("escalate");
  });

  test("stalledReason !== 'rebase_refused_dirty_tree' → skip", () => {
    const r = classifyDirtyTreeRecoverable({ ...BASE, stalledReason: "source_conflict_ctl708_unavailable", porcelain: "" });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("wrong-stall-reason");
  });

  test("liveSessionInWorktree → skip", () => {
    const r = classifyDirtyTreeRecoverable({ ...BASE, liveSessionInWorktree: true, porcelain: "" });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("live-session-in-worktree");
  });

  test("linearTerminal → skip", () => {
    const r = classifyDirtyTreeRecoverable({ ...BASE, linearTerminal: true, porcelain: "" });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("linear-terminal");
  });

  test("alreadyCleared → skip", () => {
    const r = classifyDirtyTreeRecoverable({ ...BASE, alreadyCleared: true, porcelain: "" });
    expect(r.action).toBe("skip");
    expect(r.reason).toBe("already-cleared");
  });

  test("porcelain===null → escalate (fail-closed)", () => {
    const r = classifyDirtyTreeRecoverable({ ...BASE, porcelain: null });
    expect(r.action).toBe("escalate");
    expect(r.reason).toBe("unreadable-porcelain");
  });

  test("same input twice → identical output (pure)", () => {
    const evidence = { ...BASE, porcelain: " M .catalyst/config.json" };
    const r1 = classifyDirtyTreeRecoverable(evidence);
    const r2 = classifyDirtyTreeRecoverable(evidence);
    expect(r1.action).toBe(r2.action);
  });
});

// ---------------------------------------------------------------------------
// REBASE_NOISE_PATHS
// ---------------------------------------------------------------------------
describe("REBASE_NOISE_PATHS (CTL-1064 catA)", () => {
  test("includes .catalyst/config.json", () => {
    expect(REBASE_NOISE_PATHS).toContain(".catalyst/config.json");
  });
  test("includes .claude/config.json and .claude/settings.json", () => {
    expect(REBASE_NOISE_PATHS).toContain(".claude/config.json");
    expect(REBASE_NOISE_PATHS).toContain(".claude/settings.json");
  });
  test("includes .trunk entries", () => {
    for (const p of [".trunk/actions", ".trunk/logs", ".trunk/notifications", ".trunk/out", ".trunk/tools"]) {
      expect(REBASE_NOISE_PATHS).toContain(p);
    }
  });
  test("is frozen", () => {
    expect(Object.isFrozen(REBASE_NOISE_PATHS)).toBe(true);
  });
});
