// sdk-child-discovery.test.mjs — CTL-2192 Phase 2. Mostly OFFLINE: the pure
// diff (`discoverSdkChildPid`) runs against injected tables. The ONE test that
// touches the machine is the process-enumerator positive control, which is the
// point — a `listChildPids` that returns nothing would make every discovery a
// silent "no child", and that reads as a false clean in exactly the direction
// that re-claims a live worker.
//
// Run: cd plugins/dev/scripts/execution-core && bun test sdk-child-discovery.test.mjs

import { describe, test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { discoverSdkChildPid, listChildPids, cwdOfPid } from "./sdk-child-discovery.mjs";

const MODULE_PATH = fileURLToPath(new URL("./sdk-child-discovery.mjs", import.meta.url));

describe("discoverSdkChildPid — the pure before/after diff", () => {
  test("returns the single NEW child whose cwd equals the worktreePath", () => {
    const got = discoverSdkChildPid({
      before: [10, 11],
      after: [10, 11, 42],
      cwdOf: (pid) => (pid === 42 ? "/wt/CTL-1" : "/somewhere/else"),
      worktreePath: "/wt/CTL-1",
    });
    expect(got).toBe(42);
  });

  test("ignores a PRE-EXISTING child even when its cwd matches", () => {
    // The previous generation's still-running orphan lives in the SAME worktree.
    // Attributing it to this run would record a pid we do not own.
    const got = discoverSdkChildPid({
      before: [10, 99],
      after: [10, 99, 42],
      cwdOf: () => "/wt/CTL-1",
      worktreePath: "/wt/CTL-1",
    });
    expect(got).toBe(42);
  });

  test("returns null — never a guess — when TWO new children share the cwd", () => {
    // Two generations racing in one worktree is the case this ticket is about.
    // Picking either one records a pid we cannot justify.
    const got = discoverSdkChildPid({
      before: [10],
      after: [10, 42, 43],
      cwdOf: () => "/wt/CTL-1",
      worktreePath: "/wt/CTL-1",
    });
    expect(got).toBe(null);
  });

  test("returns null when no new child matches the worktreePath", () => {
    expect(
      discoverSdkChildPid({
        before: [10],
        after: [10, 42],
        cwdOf: () => "/elsewhere",
        worktreePath: "/wt/CTL-1",
      }),
    ).toBe(null);
  });

  test("returns null when there are no new children at all", () => {
    expect(
      discoverSdkChildPid({ before: [10, 11], after: [10, 11], cwdOf: () => "/wt/CTL-1", worktreePath: "/wt/CTL-1" }),
    ).toBe(null);
  });

  test("a cwdOf that THROWS for one pid skips that pid — the scan still considers the others", () => {
    const got = discoverSdkChildPid({
      before: [],
      after: [42, 43],
      cwdOf: (pid) => {
        if (pid === 42) throw new Error("lsof exploded");
        return "/wt/CTL-1";
      },
      worktreePath: "/wt/CTL-1",
    });
    expect(got).toBe(43);
  });

  test("cwd match is EXACT — no trailing-slash normalisation (mirrors hasLiveBgWorker)", () => {
    expect(
      discoverSdkChildPid({
        before: [],
        after: [42],
        cwdOf: () => "/wt/CTL-1/",
        worktreePath: "/wt/CTL-1",
      }),
    ).toBe(null);
  });

  test("returns null on a missing/empty worktreePath rather than matching everything", () => {
    expect(discoverSdkChildPid({ before: [], after: [42], cwdOf: () => "", worktreePath: "" })).toBe(null);
    expect(discoverSdkChildPid({ before: [], after: [42], cwdOf: () => null, worktreePath: null })).toBe(null);
  });

  test("tolerates non-array inputs without throwing", () => {
    expect(discoverSdkChildPid({ before: null, after: null, cwdOf: () => "/x", worktreePath: "/x" })).toBe(null);
    expect(discoverSdkChildPid()).toBe(null);
  });
});

describe("listChildPids — the process enumerator", () => {
  // ⛔ POSITIVE CONTROL. A zero here fails the suite as INCONCLUSIVE, not as a
  // pass: an enumerator that can never see a child makes every discovery return
  // null, which is indistinguishable from "this worker has no child".
  test("POSITIVE CONTROL: finds a real child of this process", async () => {
    const child = spawn("/bin/sh", ["-c", "sleep 5"], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 250));
      const pids = listChildPids(process.pid);
      expect(Array.isArray(pids)).toBe(true);
      // The instrument must return SOMETHING before its answer means anything.
      expect(pids.length).toBeGreaterThan(0);
      expect(pids).toContain(child.pid);
    } finally {
      child.kill("SIGKILL");
    }
  });

  test("returns [] for a parent with no children (and never throws)", () => {
    // pid 1 is launchd/init; asking for children of an implausible pid must be
    // an empty answer, not a crash.
    expect(listChildPids(9_999_999)).toEqual([]);
    expect(listChildPids(null)).toEqual([]);
    expect(listChildPids(-1)).toEqual([]);
  });

  test("an enumerator that fails degrades to [] rather than throwing", () => {
    expect(listChildPids(process.pid, { ps: () => ({ status: 1, stdout: "" }) })).toEqual([]);
    expect(
      listChildPids(process.pid, {
        ps: () => {
          throw new Error("no ps");
        },
      }),
    ).toEqual([]);
  });

  test("parses whitespace-padded ps output (pid is RIGHT-ALIGNED by ps)", () => {
    // `ps -eo pid=,ppid=` left-pads the pid column. A `${line%% *}`-style split
    // yields the EMPTY string on a padded line and silently matches nothing.
    const pids = listChildPids(2556, {
      ps: () => ({ status: 0, stdout: "  42474  2556\n  77778  2556\n  31607  2556\n   1234     1\n" }),
    });
    expect(pids).toEqual([42474, 77778, 31607]);
  });
});

describe("cwdOfPid", () => {
  test("takes the n-prefixed line from lsof -Fn output", () => {
    const got = cwdOfPid(42, { lsof: () => ({ status: 0, stdout: "p42\nfcwd\nn/wt/CTL-1\n" }) });
    expect(got).toBe("/wt/CTL-1");
  });

  test("returns null on a non-zero exit, empty output, or a throw", () => {
    expect(cwdOfPid(42, { lsof: () => ({ status: 1, stdout: "" }) })).toBe(null);
    expect(cwdOfPid(42, { lsof: () => ({ status: 0, stdout: "p42\nfcwd\n" }) })).toBe(null);
    expect(
      cwdOfPid(42, {
        lsof: () => {
          throw new Error("boom");
        },
      }),
    ).toBe(null);
    expect(cwdOfPid(null)).toBe(null);
  });
});

describe("regression guards on the implementation itself", () => {
  // ⛔ MEASURED DEFECT, 2026-08-23, mini-2: `pgrep -P 2556` returned {42474,
  // 77778} and OMITTED 31607 — a live child whose parentage `ps -p 31607 -o
  // ppid=` independently confirmed as 2556. `ps -eo pid=,ppid= | awk '$2==2556'`
  // returned all three. A pgrep-based discovery is blind to a real child and
  // reports "no worker", which is a false clean in the direction that re-claims
  // a live worker.
  test("does NOT shell out to pgrep", () => {
    const src = readFileSync(MODULE_PATH, "utf8");
    const code = src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/pgrep/);
  });

  test("uses ABSOLUTE binary paths (a restricted PATH must not silently no-op)", () => {
    const src = readFileSync(MODULE_PATH, "utf8");
    expect(src).toContain("/bin/ps");
    expect(src).toContain("/usr/sbin/lsof");
  });
});
