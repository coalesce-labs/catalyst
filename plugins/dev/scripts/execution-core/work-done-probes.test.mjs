// Unit tests for the CTL-574 per-phase work-done probe registry.
// Run: cd plugins/dev/scripts/execution-core && bun test work-done-probes.test.mjs

import { describe, test, expect } from "bun:test";
import {
  WORK_DONE_PROBES,
  hasProbe,
  defaultRunGit,
  resolveWorktree,
} from "./work-done-probes.mjs";

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

// makeListArtifacts — a deterministic `readdir` fake. `map` keys are directory
// suffixes (so a test can ignore the worktree prefix); the value is the array of
// filenames in that directory. Unmatched directories return [] (the empty-dir
// case), mirroring defaultListArtifacts' safe default.
function makeListArtifacts(map) {
  return (dir) => {
    for (const [k, v] of Object.entries(map)) {
      if (dir.endsWith(k)) return v;
    }
    return [];
  };
}

// makeReadArtifact — a deterministic file-read fake keyed on a path suffix.
// Unmatched paths return "" (the read-error default).
function makeReadArtifact(map) {
  return (p) => {
    for (const [k, v] of Object.entries(map)) {
      if (p.endsWith(k)) return v;
    }
    return "";
  };
}

// A research body comfortably above the completeness size floor that carries the
// schema's closing `## Code References` section.
const RESEARCH_BODY_COMPLETE = `# Research: CTL-604

## Summary
${"Investigated the silent-stall path. ".repeat(8)}

## Code References
- recovery.mjs:462 — reclaimDeadWorkIfPossible
`;

// A plan body above the floor carrying both required markers.
const PLAN_BODY_COMPLETE = `# Plan: CTL-604

${"Overview prose to clear the size floor. ".repeat(8)}

## Phase 1 — do the thing

### Success Criteria
- [ ] tests pass
`;

describe("WORK_DONE_PROBES — registry shape", () => {
  test("implement, research, and plan are registered; other phases are not", () => {
    for (const phase of ["implement", "research", "plan"]) {
      expect(hasProbe(phase)).toBe(true);
    }
    for (const phase of [
      "triage",
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

describe("resolveWorktree — shared worktree resolution", () => {
  test("returns the worktree path bound to the ticket branch", () => {
    const wt = "/wt/CTL-604";
    const runGit = makeRunGit({
      "-C /repo worktree list --porcelain": { code: 0, stdout: porcelainFor("CTL-604", wt), stderr: "" },
    });
    expect(resolveWorktree({ ticket: "CTL-604", repoRoot: "/repo" }, { runGit })).toBe(wt);
  });

  test("returns null on git failure, missing match, or input gaps (no spawn)", () => {
    const fail = makeRunGit({
      "-C /repo worktree list --porcelain": { code: 1, stdout: "", stderr: "boom" },
    });
    expect(resolveWorktree({ ticket: "CTL-604", repoRoot: "/repo" }, { runGit: fail })).toBe(null);

    const noMatch = makeRunGit({
      "-C /repo worktree list --porcelain": {
        code: 0,
        stdout: "worktree /repo\nHEAD abcdef0\nbranch refs/heads/main\n\n",
        stderr: "",
      },
    });
    expect(resolveWorktree({ ticket: "CTL-604", repoRoot: "/repo" }, { runGit: noMatch })).toBe(null);

    const throwGit = () => {
      throw new Error("runGit must not be called");
    };
    expect(resolveWorktree({ ticket: null, repoRoot: "/repo" }, { runGit: throwGit })).toBe(null);
    expect(resolveWorktree({ ticket: "CTL-604", repoRoot: null }, { runGit: throwGit })).toBe(null);
  });
});

describe("WORK_DONE_PROBES.research — happy path", () => {
  test("true when worktree resolves + a complete ticket artifact is present", () => {
    const wt = "/wt/CTL-604";
    const runGit = makeRunGit({
      "-C /repo worktree list --porcelain": { code: 0, stdout: porcelainFor("CTL-604", wt), stderr: "" },
    });
    const listArtifacts = makeListArtifacts({
      "thoughts/shared/research": ["2026-05-26-ctl-604.md"],
    });
    const readArtifact = makeReadArtifact({
      "2026-05-26-ctl-604.md": RESEARCH_BODY_COMPLETE,
    });
    expect(
      WORK_DONE_PROBES.research(
        { ticket: "CTL-604", repoRoot: "/repo" },
        { runGit, listArtifacts, readArtifact },
      ),
    ).toBe(true);
  });

  test("case-insensitive filename match with a descriptive suffix", () => {
    const wt = "/wt/CTL-604";
    const runGit = makeRunGit({
      "-C /repo worktree list --porcelain": { code: 0, stdout: porcelainFor("CTL-604", wt), stderr: "" },
    });
    const listArtifacts = makeListArtifacts({
      "thoughts/shared/research": ["2026-05-26-CTL-604-some-suffix.md"],
    });
    const readArtifact = makeReadArtifact({
      "2026-05-26-CTL-604-some-suffix.md": RESEARCH_BODY_COMPLETE,
    });
    expect(
      WORK_DONE_PROBES.research(
        { ticket: "CTL-604", repoRoot: "/repo" },
        { runGit, listArtifacts, readArtifact },
      ),
    ).toBe(true);
  });
});

describe("WORK_DONE_PROBES.research — false cases", () => {
  const wt = "/wt/CTL-604";
  const runGitOk = makeRunGit({
    "-C /repo worktree list --porcelain": { code: 0, stdout: porcelainFor("CTL-604", wt), stderr: "" },
  });

  test("no worktree match → false", () => {
    const runGit = makeRunGit({
      "-C /repo worktree list --porcelain": {
        code: 0,
        stdout: "worktree /repo\nHEAD abcdef0\nbranch refs/heads/main\n\n",
        stderr: "",
      },
    });
    expect(
      WORK_DONE_PROBES.research(
        { ticket: "CTL-604", repoRoot: "/repo" },
        { runGit, listArtifacts: () => ["2026-05-26-ctl-604.md"], readArtifact: () => RESEARCH_BODY_COMPLETE },
      ),
    ).toBe(false);
  });

  test("empty directory → false", () => {
    expect(
      WORK_DONE_PROBES.research(
        { ticket: "CTL-604", repoRoot: "/repo" },
        { runGit: runGitOk, listArtifacts: makeListArtifacts({ "thoughts/shared/research": [] }), readArtifact: () => "" },
      ),
    ).toBe(false);
  });

  test("no ticket-matching file → false", () => {
    expect(
      WORK_DONE_PROBES.research(
        { ticket: "CTL-604", repoRoot: "/repo" },
        {
          runGit: runGitOk,
          listArtifacts: makeListArtifacts({ "thoughts/shared/research": ["2026-05-26-ctl-999.md", "notes.md"] }),
          readArtifact: () => RESEARCH_BODY_COMPLETE,
        },
      ),
    ).toBe(false);
  });

  test("artifact below size floor → false", () => {
    expect(
      WORK_DONE_PROBES.research(
        { ticket: "CTL-604", repoRoot: "/repo" },
        {
          runGit: runGitOk,
          listArtifacts: makeListArtifacts({ "thoughts/shared/research": ["2026-05-26-ctl-604.md"] }),
          readArtifact: makeReadArtifact({ "2026-05-26-ctl-604.md": "## Code References\n" }),
        },
      ),
    ).toBe(false);
  });

  test("artifact missing the closing section (truncated mid-write) → false", () => {
    expect(
      WORK_DONE_PROBES.research(
        { ticket: "CTL-604", repoRoot: "/repo" },
        {
          runGit: runGitOk,
          listArtifacts: makeListArtifacts({ "thoughts/shared/research": ["2026-05-26-ctl-604.md"] }),
          readArtifact: makeReadArtifact({ "2026-05-26-ctl-604.md": "x".repeat(400) }),
        },
      ),
    ).toBe(false);
  });

  test("readdir throws → safe default [] → false", () => {
    expect(
      WORK_DONE_PROBES.research(
        { ticket: "CTL-604", repoRoot: "/repo" },
        {
          runGit: runGitOk,
          listArtifacts: () => {
            throw new Error("readdir blew up");
          },
          readArtifact: () => RESEARCH_BODY_COMPLETE,
        },
      ),
    ).toBe(false);
  });
});

describe("WORK_DONE_PROBES.plan — completeness gate", () => {
  const wt = "/wt/CTL-604";
  const runGitOk = makeRunGit({
    "-C /repo worktree list --porcelain": { code: 0, stdout: porcelainFor("CTL-604", wt), stderr: "" },
  });

  test("true when a complete plan with `## Phase ` + `Success Criteria` is present", () => {
    expect(
      WORK_DONE_PROBES.plan(
        { ticket: "CTL-604", repoRoot: "/repo" },
        {
          runGit: runGitOk,
          listArtifacts: makeListArtifacts({ "thoughts/shared/plans": ["2026-05-26-ctl-604.md"] }),
          readArtifact: makeReadArtifact({ "2026-05-26-ctl-604.md": PLAN_BODY_COMPLETE }),
        },
      ),
    ).toBe(true);
  });

  test("plan missing the `## Phase ` heading (truncated) → false", () => {
    const truncated = `# Plan: CTL-604\n\n${"prose ".repeat(60)}\n\n### Success Criteria\n- [ ] x\n`;
    expect(
      WORK_DONE_PROBES.plan(
        { ticket: "CTL-604", repoRoot: "/repo" },
        {
          runGit: runGitOk,
          listArtifacts: makeListArtifacts({ "thoughts/shared/plans": ["2026-05-26-ctl-604.md"] }),
          readArtifact: makeReadArtifact({ "2026-05-26-ctl-604.md": truncated }),
        },
      ),
    ).toBe(false);
  });
});

describe("WORK_DONE_PROBES.research/plan — input guards (no fs/git spawn)", () => {
  const boom = () => {
    throw new Error("seam must not be called");
  };

  test("missing ticket → false", () => {
    expect(
      WORK_DONE_PROBES.research(
        { ticket: null, repoRoot: "/repo" },
        { runGit: boom, listArtifacts: boom, readArtifact: boom },
      ),
    ).toBe(false);
    expect(
      WORK_DONE_PROBES.plan(
        { ticket: null, repoRoot: "/repo" },
        { runGit: boom, listArtifacts: boom, readArtifact: boom },
      ),
    ).toBe(false);
  });

  test("missing repoRoot → false", () => {
    expect(
      WORK_DONE_PROBES.research(
        { ticket: "CTL-604", repoRoot: null },
        { runGit: boom, listArtifacts: boom, readArtifact: boom },
      ),
    ).toBe(false);
  });
});
