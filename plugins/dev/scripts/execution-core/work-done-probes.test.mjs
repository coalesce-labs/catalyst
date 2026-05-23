// Unit tests for the CTL-574 per-phase work-done probe registry.
// Run: cd plugins/dev/scripts/execution-core && bun test work-done-probes.test.mjs

import { describe, test, expect } from "bun:test";
import { WORK_DONE_PROBES, hasProbe, defaultRunGit } from "./work-done-probes.mjs";

// makeRunGit — a deterministic `git` fake keyed on the trailing positional args.
// Returns { code, stdout, stderr } shaped like spawnSync's output.
function makeRunGit(responses) {
  return (args) => {
    const key = args.join(" ");
    if (responses[key]) return responses[key];
    // Match a known prefix so callers can ignore the cwd prefix in the key.
    for (const [k, v] of Object.entries(responses)) {
      if (key.endsWith(k)) return v;
    }
    return { code: 1, stdout: "", stderr: `fake runGit: no match for ${key}` };
  };
}

// porcelainFor — a `git worktree list --porcelain` block for one ticket bound to
// the given worktree path. Mirrors the real porcelain shape (blank-line-separated).
function porcelainFor(ticket, worktreePath) {
  return [
    "worktree /repo",
    "HEAD abcdef0",
    "branch refs/heads/main",
    "",
    `worktree ${worktreePath}`,
    "HEAD 1234567",
    `branch refs/heads/${ticket}`,
    "",
  ].join("\n");
}

describe("WORK_DONE_PROBES — registry shape", () => {
  test("implement is registered, other phases are not", () => {
    expect(hasProbe("implement")).toBe(true);
    for (const phase of [
      "triage", "research", "plan",
      "verify", "review", "pr", "monitor-merge", "monitor-deploy",
      "unknown-phase",
    ]) {
      expect(hasProbe(phase)).toBe(false);
    }
  });
});

describe("WORK_DONE_PROBES.implement — happy path", () => {
  test("returns true when worktree exists + commits-ahead > 0 + clean tree", () => {
    const wt = "/wt/CTL-1";
    const runGit = makeRunGit({
      "-C /repo worktree list --porcelain": { code: 0, stdout: porcelainFor("CTL-1", wt), stderr: "" },
      [`-C ${wt} rev-list --count origin/main..HEAD`]: { code: 0, stdout: "2\n", stderr: "" },
      [`-C ${wt} status --porcelain`]: { code: 0, stdout: "", stderr: "" },
    });
    expect(
      WORK_DONE_PROBES.implement({ ticket: "CTL-1", repoRoot: "/repo" }, { runGit }),
    ).toBe(true);
  });
});

describe("WORK_DONE_PROBES.implement — false (work not done)", () => {
  test("returns false when no commits ahead", () => {
    const wt = "/wt/CTL-1";
    const runGit = makeRunGit({
      "-C /repo worktree list --porcelain": { code: 0, stdout: porcelainFor("CTL-1", wt), stderr: "" },
      [`-C ${wt} rev-list --count origin/main..HEAD`]: { code: 0, stdout: "0\n", stderr: "" },
      [`-C ${wt} status --porcelain`]: { code: 0, stdout: "", stderr: "" },
    });
    expect(
      WORK_DONE_PROBES.implement({ ticket: "CTL-1", repoRoot: "/repo" }, { runGit }),
    ).toBe(false);
  });

  test("returns false when tree is dirty", () => {
    const wt = "/wt/CTL-1";
    const runGit = makeRunGit({
      "-C /repo worktree list --porcelain": { code: 0, stdout: porcelainFor("CTL-1", wt), stderr: "" },
      [`-C ${wt} rev-list --count origin/main..HEAD`]: { code: 0, stdout: "2\n", stderr: "" },
      [`-C ${wt} status --porcelain`]: { code: 0, stdout: " M plugins/dev/foo.mjs\n", stderr: "" },
    });
    expect(
      WORK_DONE_PROBES.implement({ ticket: "CTL-1", repoRoot: "/repo" }, { runGit }),
    ).toBe(false);
  });

  test("returns false when no worktree matches the ticket branch", () => {
    const runGit = makeRunGit({
      "-C /repo worktree list --porcelain": {
        code: 0,
        stdout: "worktree /repo\nHEAD abcdef0\nbranch refs/heads/main\n\n",
        stderr: "",
      },
    });
    expect(
      WORK_DONE_PROBES.implement({ ticket: "CTL-1", repoRoot: "/repo" }, { runGit }),
    ).toBe(false);
  });
});

describe("WORK_DONE_PROBES.implement — git failures are safe (return false)", () => {
  test("worktree list non-zero exit → false", () => {
    const runGit = makeRunGit({
      "-C /repo worktree list --porcelain": { code: 1, stdout: "", stderr: "not a git repo" },
    });
    expect(
      WORK_DONE_PROBES.implement({ ticket: "CTL-1", repoRoot: "/repo" }, { runGit }),
    ).toBe(false);
  });

  test("rev-list non-zero (e.g., origin/main missing) → false", () => {
    const wt = "/wt/CTL-1";
    const runGit = makeRunGit({
      "-C /repo worktree list --porcelain": { code: 0, stdout: porcelainFor("CTL-1", wt), stderr: "" },
      [`-C ${wt} rev-list --count origin/main..HEAD`]: { code: 128, stdout: "", stderr: "bad revision" },
    });
    expect(
      WORK_DONE_PROBES.implement({ ticket: "CTL-1", repoRoot: "/repo" }, { runGit }),
    ).toBe(false);
  });

  test("status non-zero → false", () => {
    const wt = "/wt/CTL-1";
    const runGit = makeRunGit({
      "-C /repo worktree list --porcelain": { code: 0, stdout: porcelainFor("CTL-1", wt), stderr: "" },
      [`-C ${wt} rev-list --count origin/main..HEAD`]: { code: 0, stdout: "1\n", stderr: "" },
      [`-C ${wt} status --porcelain`]: { code: 1, stdout: "", stderr: "permission denied" },
    });
    expect(
      WORK_DONE_PROBES.implement({ ticket: "CTL-1", repoRoot: "/repo" }, { runGit }),
    ).toBe(false);
  });
});

describe("WORK_DONE_PROBES.implement — input guards", () => {
  test("missing ticket → false (no git spawn)", () => {
    const runGit = () => {
      throw new Error("runGit must not be called");
    };
    expect(
      WORK_DONE_PROBES.implement({ ticket: null, repoRoot: "/repo" }, { runGit }),
    ).toBe(false);
  });

  test("missing repoRoot → false (no git spawn)", () => {
    const runGit = () => {
      throw new Error("runGit must not be called");
    };
    expect(
      WORK_DONE_PROBES.implement({ ticket: "CTL-1", repoRoot: null }, { runGit }),
    ).toBe(false);
  });
});

describe("defaultRunGit — spawn error is non-fatal", () => {
  test("a spawn error returns { code: 127, … } and never throws", () => {
    const r = defaultRunGit(["worktree", "list"], {
      spawn: () => ({ error: new Error("ENOENT") }),
    });
    expect(r.code).toBe(127);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("ENOENT");
  });
});
