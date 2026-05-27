// repo.test.mjs — CTL-675. Hermetic coverage for the shared repo-root resolver
// and the throwing, stderr-capturing git runner. Every external dependency
// (git, fs, registry) is injected — no real git is invoked.

import { describe, it, expect } from "bun:test";
import { resolveRepoRoot, runGitCapture } from "./repo.mjs";

describe("resolveRepoRoot", () => {
  const noGit = () => {
    throw new Error("not a repo");
  };

  it("returns the explicit --repo-root verbatim, ahead of everything", () => {
    expect(
      resolveRepoRoot({
        explicit: "/x/repo",
        env: { CATALYST_REPO_ROOT: "/y" },
        runGit: noGit,
        projects: [{ repoRoot: "/z" }],
      })
    ).toBe("/x/repo");
  });

  it("falls back to $CATALYST_REPO_ROOT when no explicit flag", () => {
    expect(
      resolveRepoRoot({
        env: { CATALYST_REPO_ROOT: "/y/repo" },
        runGit: noGit,
        projects: [],
      })
    ).toBe("/y/repo");
  });

  it("uses the current repo toplevel when in a repo and no flag/env", () => {
    const runGit = () => "/cwd/repo\n";
    expect(resolveRepoRoot({ env: {}, runGit, projects: [] })).toBe("/cwd/repo");
  });

  it("falls back to the first usable registry repoRoot outside any repo", () => {
    expect(
      resolveRepoRoot({
        env: {},
        runGit: noGit,
        projects: [{ repoRoot: "" }, { repoRoot: "/reg/repo" }],
        existsSync: () => true,
      })
    ).toBe("/reg/repo");
  });

  it("throws a clear, actionable error when nothing resolves", () => {
    expect(() => resolveRepoRoot({ env: {}, runGit: noGit, projects: [] })).toThrow(
      /cannot resolve a git repo root.*--repo-root/s
    );
  });
});

describe("runGitCapture", () => {
  it("returns stdout on success", () => {
    const run = () => "worktree /a\n";
    expect(runGitCapture(["worktree", "list", "--porcelain"], { cwd: "/r", run })).toBe(
      "worktree /a\n"
    );
  });

  it("throws a wrapped error carrying git's first stderr line (no leak)", () => {
    const run = () => {
      const e = new Error("Command failed");
      e.stderr = "fatal: not a git repository (or any of the parent directories): .git\n";
      throw e;
    };
    expect(() => runGitCapture(["worktree", "list", "--porcelain"], { cwd: "/r", run })).toThrow(
      /git worktree list --porcelain failed: fatal: not a git repository/
    );
  });
});
