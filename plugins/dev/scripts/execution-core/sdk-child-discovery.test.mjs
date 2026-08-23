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
  test("returns the single NEW child whose cwd equals the worktreePath, CONCLUSIVELY", () => {
    const got = discoverSdkChildPid({
      before: [10, 11],
      after: [10, 11, 42],
      cwdOf: (pid) => (pid === 42 ? "/wt/CTL-1" : "/somewhere/else"),
      worktreePath: "/wt/CTL-1",
    });
    expect(got).toEqual({ pid: 42, conclusive: true, reason: "matched" });
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
    expect(got).toEqual({ pid: 42, conclusive: true, reason: "matched" });
  });

  test("⛔ AMBIGUOUS, not 'no child', when TWO new children share the cwd", () => {
    // Two generations racing in one worktree is the case this ticket is about.
    // Picking either one records a pid we cannot justify — and recording "no
    // child" would let the liveness oracle later read one of them as DEAD and
    // mint a third generation. Ambiguity must stay INCONCLUSIVE.
    const got = discoverSdkChildPid({
      before: [10],
      after: [10, 42, 43],
      cwdOf: () => "/wt/CTL-1",
      worktreePath: "/wt/CTL-1",
    });
    expect(got).toEqual({ pid: null, conclusive: false, reason: "ambiguous-multiple-matches" });
  });

  test("CONCLUSIVE 'no child' when new children exist, cwds are readable, and none match", () => {
    expect(
      discoverSdkChildPid({
        before: [10],
        after: [10, 42],
        cwdOf: () => "/elsewhere",
        worktreePath: "/wt/CTL-1",
      }),
    ).toEqual({ pid: null, conclusive: true, reason: "no-match" });
  });

  test("CONCLUSIVE 'no child' when there are no new children at all", () => {
    expect(
      discoverSdkChildPid({ before: [10, 11], after: [10, 11], cwdOf: () => "/wt/CTL-1", worktreePath: "/wt/CTL-1" }),
    ).toEqual({ pid: null, conclusive: true, reason: "no-new-children" });
  });

  test("⛔ INCONCLUSIVE when the enumerator itself failed (after === null)", () => {
    // `ps` unavailable is "I could not look", not "there is no child". Stamping
    // the latter would make every worker on such a host read DEAD after a bounce.
    expect(
      discoverSdkChildPid({ before: [10], after: null, cwdOf: () => "/wt/CTL-1", worktreePath: "/wt/CTL-1" }),
    ).toEqual({ pid: null, conclusive: false, reason: "enumerator-unusable" });
  });

  test("⛔ INCONCLUSIVE when EVERY new child's cwd is unreadable", () => {
    // The systematic case: no `lsof` on the host. Every cwd probe returns null,
    // so we learn nothing — and must not claim there was no child.
    expect(
      discoverSdkChildPid({
        before: [10],
        after: [10, 42, 43],
        cwdOf: () => null,
        worktreePath: "/wt/CTL-1",
      }),
    ).toEqual({ pid: null, conclusive: false, reason: "cwd-unreadable" });
  });

  test("a PARTIALLY readable scan still concludes when at least one cwd was read", () => {
    const got = discoverSdkChildPid({
      before: [],
      after: [42, 43],
      cwdOf: (pid) => (pid === 43 ? "/wt/CTL-1" : null),
      worktreePath: "/wt/CTL-1",
    });
    expect(got).toEqual({ pid: 43, conclusive: true, reason: "matched" });
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
    expect(got).toEqual({ pid: 43, conclusive: true, reason: "matched" });
  });

  test("cwd match is EXACT — no trailing-slash normalisation (mirrors hasLiveBgWorker)", () => {
    expect(
      discoverSdkChildPid({
        before: [],
        after: [42],
        cwdOf: () => "/wt/CTL-1/",
        worktreePath: "/wt/CTL-1",
      }),
    ).toEqual({ pid: null, conclusive: true, reason: "no-match" });
  });

  test("⛔ a missing/empty worktreePath is INCONCLUSIVE, never a match-everything", () => {
    expect(discoverSdkChildPid({ before: [], after: [42], cwdOf: () => "", worktreePath: "" })).toEqual({
      pid: null,
      conclusive: false,
      reason: "no-worktree-path",
    });
    expect(discoverSdkChildPid({ before: [], after: [42], cwdOf: () => null, worktreePath: null })).toEqual({
      pid: null,
      conclusive: false,
      reason: "no-worktree-path",
    });
  });

  // ── CTL-2192 remediation: the zero-match branch is the ONE place in this
  //    module that can manufacture a false CONCLUSIVE, and a conclusive
  //    "no child" is what stamps childPidResolved — which
  //    classifySdkWorkerLiveness branch 6 reads as DEAD.
  test("⛔ zero matches with ONE unreadable pid is INCONCLUSIVE, even when a sibling WAS readable", () => {
    // The pre-fix bug: the readability flag was SCAN-WIDE, so one readable
    // sibling licensed a conclusive `no-match` even when OUR child's own probe
    // was the one that failed. Evidence of absence requires that every fresh pid
    // was actually interrogated.
    expect(
      discoverSdkChildPid({
        before: [10],
        after: [10, 42, 43],
        cwdOf: (pid) => (pid === 42 ? "/somewhere/else" : null), // 43 — possibly ours — unreadable
        worktreePath: "/wt/CTL-1",
      }),
    ).toEqual({ pid: null, conclusive: false, reason: "cwd-unreadable" });
  });

  test("⛔ same, when the unreadable pid THREW rather than returning null", () => {
    expect(
      discoverSdkChildPid({
        before: [10],
        after: [10, 42, 43],
        cwdOf: (pid) => {
          if (pid === 43) throw new Error("lsof exploded");
          return "/somewhere/else";
        },
        worktreePath: "/wt/CTL-1",
      }),
    ).toEqual({ pid: null, conclusive: false, reason: "cwd-unreadable" });
  });

  test("⛔ an empty-string cwd counts as UNREADABLE, not as an interrogated non-match", () => {
    expect(
      discoverSdkChildPid({
        before: [10],
        after: [10, 42, 43],
        cwdOf: (pid) => (pid === 42 ? "/somewhere/else" : ""),
        worktreePath: "/wt/CTL-1",
      }),
    ).toEqual({ pid: null, conclusive: false, reason: "cwd-unreadable" });
  });

  // POSITIVE CONTROL for the two above: the same shape with every cwd readable
  // MUST still conclude, or the fix would have simply disabled the conclusion.
  test("positive control — every fresh pid readable and none matching is still CONCLUSIVE", () => {
    expect(
      discoverSdkChildPid({
        before: [10],
        after: [10, 42, 43],
        cwdOf: () => "/somewhere/else",
        worktreePath: "/wt/CTL-1",
      }),
    ).toEqual({ pid: null, conclusive: true, reason: "no-match" });
  });

  test("a POSITIVE match stands even when another pid's probe failed", () => {
    // Asymmetric on purpose: we READ that pid's cwd and it is this worktree, so
    // a sibling's unreadable probe cannot make the match wrong.
    expect(
      discoverSdkChildPid({
        before: [10],
        after: [10, 42, 43],
        cwdOf: (pid) => (pid === 43 ? "/wt/CTL-1" : null),
        worktreePath: "/wt/CTL-1",
      }),
    ).toEqual({ pid: 43, conclusive: true, reason: "matched" });
  });

  test("⛔ a null BEFORE snapshot is INCONCLUSIVE, never an empty set", () => {
    // listChildPids returns null SPECIFICALLY to mean "I could not look". Folded
    // into an empty Set it asserts the daemon had no children, promoting every
    // pre-existing sibling into the `fresh` set — at best losing the stamp, at
    // worst attributing a previous generation's orphan to this run.
    expect(
      discoverSdkChildPid({ before: null, after: [10, 42], cwdOf: () => "/wt/CTL-1", worktreePath: "/wt/CTL-1" }),
    ).toEqual({ pid: null, conclusive: false, reason: "before-unavailable" });
    // …and the pre-fix behaviour would have been a CONFIDENT (wrong) match here:
    expect(
      discoverSdkChildPid({ before: undefined, after: [10], cwdOf: () => "/wt/CTL-1", worktreePath: "/wt/CTL-1" })
        .conclusive,
    ).toBe(false);
  });

  test("tolerates malformed inputs without throwing, and stays INCONCLUSIVE", () => {
    expect(discoverSdkChildPid({ before: null, after: null, cwdOf: () => "/x", worktreePath: "/x" }).conclusive).toBe(false);
    expect(discoverSdkChildPid().conclusive).toBe(false);
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

  test("returns [] — a CONCLUSIVE empty — for a real parent with no children", () => {
    expect(listChildPids(9_999_999)).toEqual([]);
  });

  test("⛔ returns null (not []) when it COULD NOT LOOK — invalid input or a failing ps", () => {
    // [] means "ps ran and this pid has no children"; null means "I could not
    // look". Collapsing them is how a host without a usable process table would
    // stamp every live worker as childless, and therefore reapable.
    expect(listChildPids(null)).toBe(null);
    expect(listChildPids(-1)).toBe(null);
    expect(listChildPids(process.pid, { ps: () => ({ status: 1, stdout: "" }) })).toBe(null);
    expect(
      listChildPids(process.pid, {
        ps: () => {
          throw new Error("no ps");
        },
      }),
    ).toBe(null);
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
