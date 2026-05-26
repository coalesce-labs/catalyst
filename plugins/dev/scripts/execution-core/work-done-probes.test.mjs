// Unit tests for the CTL-574 per-phase work-done probe registry.
// Run: cd plugins/dev/scripts/execution-core && bun test work-done-probes.test.mjs

import { describe, test, expect } from "bun:test";
import {
  WORK_DONE_PROBES,
  hasProbe,
  defaultRunGit,
  resolveWorktree,
  defaultReadFile,
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

// CTL-604 + CTL-641: every pipeline phase now carries a probe — implement
// (CTL-574), research/plan (CTL-604), and triage/verify/review/pr/monitor-merge/
// monitor-deploy (CTL-641). hasProbe is false only for a genuinely-unknown phase,
// keeping the recovery sweep's branch (A) "no-probe-for-phase" escalation as a
// defensive guard.
describe("WORK_DONE_PROBES — registry shape", () => {
  test("all 9 pipeline phases are registered", () => {
    for (const phase of [
      "implement", "triage", "research", "plan",
      "verify", "review", "pr", "monitor-merge", "monitor-deploy",
    ]) {
      expect(hasProbe(phase)).toBe(true);
    }
  });
  test("a genuinely-unknown phase is not registered", () => {
    for (const phase of ["unknown-phase", "deploy", ""]) {
      expect(hasProbe(phase)).toBe(false);
    }
  });
});

// makeReadFile — deterministic fs fake keyed on absolute path. Returns the
// { ok, content } shape of defaultReadFile; an unknown path is a miss.
function makeReadFile(files) {
  return (path) => (path in files ? { ok: true, content: files[path] } : { ok: false, content: "" });
}

const ORCH = "/orch";
const wpath = (ticket, name) => `${ORCH}/workers/${ticket}/${name}`;

describe("WORK_DONE_PROBES.triage", () => {
  test("true when triage.json parses with non-empty classification", () => {
    const readFile = makeReadFile({
      [wpath("CTL-1", "triage.json")]: JSON.stringify({ classification: "feature", summary: "x" }),
    });
    expect(WORK_DONE_PROBES.triage({ ticket: "CTL-1", orchDir: ORCH }, { readFile })).toBe(true);
  });
  test("false when classification empty/missing (truncated)", () => {
    const readFile = makeReadFile({ [wpath("CTL-1", "triage.json")]: JSON.stringify({ summary: "x" }) });
    expect(WORK_DONE_PROBES.triage({ ticket: "CTL-1", orchDir: ORCH }, { readFile })).toBe(false);
  });
  test("false when classification is whitespace-only (truncated)", () => {
    const readFile = makeReadFile({ [wpath("CTL-1", "triage.json")]: JSON.stringify({ classification: "   " }) });
    expect(WORK_DONE_PROBES.triage({ ticket: "CTL-1", orchDir: ORCH }, { readFile })).toBe(false);
  });
  test("false when file missing", () => {
    expect(WORK_DONE_PROBES.triage({ ticket: "CTL-1", orchDir: ORCH }, { readFile: makeReadFile({}) })).toBe(false);
  });
  test("false on invalid JSON (parse error is safe)", () => {
    const readFile = makeReadFile({ [wpath("CTL-1", "triage.json")]: "{not json" });
    expect(WORK_DONE_PROBES.triage({ ticket: "CTL-1", orchDir: ORCH }, { readFile })).toBe(false);
  });
  test("false on missing input (no readFile call)", () => {
    const readFile = () => { throw new Error("readFile must not be called"); };
    expect(WORK_DONE_PROBES.triage({ ticket: null, orchDir: ORCH }, { readFile })).toBe(false);
    expect(WORK_DONE_PROBES.triage({ ticket: "CTL-1", orchDir: null }, { readFile })).toBe(false);
  });
});

// verify.json real schema (phase-verify SKILL.md:182-189):
//   {regression_risk:int, findings:[...], tests_attempted:int, gates:{...}, generatedAt:string}
describe("WORK_DONE_PROBES.verify", () => {
  test("true with all required keys present", () => {
    const readFile = makeReadFile({
      [wpath("CTL-1", "verify.json")]: JSON.stringify({
        regression_risk: 1, findings: [], tests_attempted: 0, gates: {}, generatedAt: "2026-05-26T00:00:00Z",
      }),
    });
    expect(WORK_DONE_PROBES.verify({ ticket: "CTL-1", orchDir: ORCH }, { readFile })).toBe(true);
  });
  test("false when a required key is absent (truncated)", () => {
    const readFile = makeReadFile({ [wpath("CTL-1", "verify.json")]: JSON.stringify({ findings: [] }) });
    expect(WORK_DONE_PROBES.verify({ ticket: "CTL-1", orchDir: ORCH }, { readFile })).toBe(false);
  });
  test("false when findings is not an array (truncated)", () => {
    const readFile = makeReadFile({
      [wpath("CTL-1", "verify.json")]: JSON.stringify({
        regression_risk: 1, findings: "oops", tests_attempted: 0, gates: {}, generatedAt: "x",
      }),
    });
    expect(WORK_DONE_PROBES.verify({ ticket: "CTL-1", orchDir: ORCH }, { readFile })).toBe(false);
  });
  test("false on missing file / invalid JSON", () => {
    expect(WORK_DONE_PROBES.verify({ ticket: "CTL-1", orchDir: ORCH }, { readFile: makeReadFile({}) })).toBe(false);
  });
});

// review.json real schema (phase-review SKILL.md:167-175):
//   {findings:[...], remediationCommit:string|null, reviewPassed:bool, generatedAt:string}
describe("WORK_DONE_PROBES.review", () => {
  test("true with findings[], reviewPassed bool, remediationCommit present, generatedAt", () => {
    const readFile = makeReadFile({
      [wpath("CTL-1", "review.json")]: JSON.stringify({
        findings: [], remediationCommit: null, reviewPassed: true, generatedAt: "2026-05-26T00:00:00Z",
      }),
    });
    expect(WORK_DONE_PROBES.review({ ticket: "CTL-1", orchDir: ORCH }, { readFile })).toBe(true);
  });
  test("false when reviewPassed is not a boolean (truncated)", () => {
    const readFile = makeReadFile({ [wpath("CTL-1", "review.json")]: JSON.stringify({ findings: [], generatedAt: "x" }) });
    expect(WORK_DONE_PROBES.review({ ticket: "CTL-1", orchDir: ORCH }, { readFile })).toBe(false);
  });
  test("false when remediationCommit key absent (truncated)", () => {
    const readFile = makeReadFile({
      [wpath("CTL-1", "review.json")]: JSON.stringify({ findings: [], reviewPassed: true, generatedAt: "x" }),
    });
    expect(WORK_DONE_PROBES.review({ ticket: "CTL-1", orchDir: ORCH }, { readFile })).toBe(false);
  });
  test("false on missing file", () => {
    expect(WORK_DONE_PROBES.review({ ticket: "CTL-1", orchDir: ORCH }, { readFile: makeReadFile({}) })).toBe(false);
  });
});

// monitor-deploy: deploy_state ∈ {success, skipped} is done (signal-reader.mjs:29
// ranks skipped as terminal-equivalent); anything else / missing is not.
describe("WORK_DONE_PROBES['monitor-deploy']", () => {
  test.each(["success", "skipped"])("true when deploy_state=%s", (state) => {
    const readFile = makeReadFile({
      [wpath("CTL-1", "phase-monitor-deploy.json")]: JSON.stringify({ deploy_state: state, deploy_sha: "abc", completed_at: "x" }),
    });
    expect(WORK_DONE_PROBES["monitor-deploy"]({ ticket: "CTL-1", orchDir: ORCH }, { readFile })).toBe(true);
  });
  test("false when deploy_state=failure", () => {
    const readFile = makeReadFile({ [wpath("CTL-1", "phase-monitor-deploy.json")]: JSON.stringify({ deploy_state: "failure" }) });
    expect(WORK_DONE_PROBES["monitor-deploy"]({ ticket: "CTL-1", orchDir: ORCH }, { readFile })).toBe(false);
  });
  test("false when deploy_state absent / file missing", () => {
    const readFile = makeReadFile({ [wpath("CTL-1", "phase-monitor-deploy.json")]: JSON.stringify({ status: "running" }) });
    expect(WORK_DONE_PROBES["monitor-deploy"]({ ticket: "CTL-1", orchDir: ORCH }, { readFile })).toBe(false);
    expect(WORK_DONE_PROBES["monitor-deploy"]({ ticket: "CTL-1", orchDir: ORCH }, { readFile: makeReadFile({}) })).toBe(false);
  });
});

describe("defaultReadFile — never throws", () => {
  test("missing file → { ok: false, content: '' }", () => {
    const r = defaultReadFile("/no/such/path/xyz.json");
    expect(r.ok).toBe(false);
    expect(r.content).toBe("");
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
    expect(
      WORK_DONE_PROBES.plan(
        { ticket: "CTL-604", repoRoot: null },
        { runGit: boom, listArtifacts: boom, readArtifact: boom },
      ),
    ).toBe(false);
  });
});

// --- CTL-641 Phase 3: gh REST probes (pr, monitor-merge) -------------------
// pr is done when its PR is open (or already merged); monitor-merge is done
// when the PR is merged. The PR number/url is read from the worker-dir signal
// (.pr.number / .pr.url). We query the REST endpoint `gh api
// repos/<slug>/pulls/<n>` (research §4 — REST `.state`/`.merged`, NOT GraphQL,
// whose state field is uppercase). The repo slug is parsed from .pr.url; when
// absent we fall back to gh's `{owner}/{repo}` placeholder (cwd inference).

// makeRunGh — deterministic `gh` fake keyed on the joined args.
function makeRunGh(responses) {
  return (args) => responses[args.join(" ")] ?? { code: 1, stdout: "", stderr: "no match" };
}

describe("WORK_DONE_PROBES.pr", () => {
  // url "u" has no parseable slug → falls back to the {owner}/{repo} placeholder.
  const readFile = makeReadFile({ [wpath("CTL-1", "phase-pr.json")]: JSON.stringify({ pr: { number: 42, url: "u" } }) });
  test("true when PR state is open (REST)", () => {
    const runGh = makeRunGh({ "api repos/{owner}/{repo}/pulls/42": { code: 0, stdout: JSON.stringify({ state: "open" }), stderr: "" } });
    expect(WORK_DONE_PROBES.pr({ ticket: "CTL-1", orchDir: ORCH }, { readFile, runGh })).toBe(true);
  });
  test("true when PR already merged (pr phase still done)", () => {
    const runGh = makeRunGh({ "api repos/{owner}/{repo}/pulls/42": { code: 0, stdout: JSON.stringify({ state: "closed", merged: true }), stderr: "" } });
    expect(WORK_DONE_PROBES.pr({ ticket: "CTL-1", orchDir: ORCH }, { readFile, runGh })).toBe(true);
  });
  test("false when PR is closed-unmerged", () => {
    const runGh = makeRunGh({ "api repos/{owner}/{repo}/pulls/42": { code: 0, stdout: JSON.stringify({ state: "closed", merged: false }), stderr: "" } });
    expect(WORK_DONE_PROBES.pr({ ticket: "CTL-1", orchDir: ORCH }, { readFile, runGh })).toBe(false);
  });
  test("real github url → slug parsed into the REST path", () => {
    const rf = makeReadFile({
      [wpath("CTL-1", "phase-pr.json")]: JSON.stringify({ pr: { number: 42, url: "https://github.com/coalesce-labs/catalyst/pull/42" } }),
    });
    const runGh = makeRunGh({ "api repos/coalesce-labs/catalyst/pulls/42": { code: 0, stdout: JSON.stringify({ state: "open" }), stderr: "" } });
    expect(WORK_DONE_PROBES.pr({ ticket: "CTL-1", orchDir: ORCH }, { readFile: rf, runGh })).toBe(true);
  });
  test("false when no PR number on the signal (no gh call)", () => {
    const runGh = () => { throw new Error("runGh must not be called"); };
    expect(WORK_DONE_PROBES.pr({ ticket: "CTL-1", orchDir: ORCH }, { readFile: makeReadFile({ [wpath("CTL-1", "phase-pr.json")]: "{}" }), runGh })).toBe(false);
  });
  test("false when gh fails (safe default)", () => {
    expect(WORK_DONE_PROBES.pr({ ticket: "CTL-1", orchDir: ORCH }, { readFile, runGh: makeRunGh({}) })).toBe(false);
  });
  test("false on missing input (no readFile/gh call)", () => {
    const boom = () => { throw new Error("must not be called"); };
    expect(WORK_DONE_PROBES.pr({ ticket: null, orchDir: ORCH }, { readFile: boom, runGh: boom })).toBe(false);
    expect(WORK_DONE_PROBES.pr({ ticket: "CTL-1", orchDir: null }, { readFile: boom, runGh: boom })).toBe(false);
  });
});

describe("WORK_DONE_PROBES['monitor-merge']", () => {
  // phase-monitor-merge.json carries .pr.number but NOT .pr.url (it writes
  // `.pr = {number}` only) — the probe reads the url from phase-pr.json.
  const readFile = makeReadFile({
    [wpath("CTL-1", "phase-monitor-merge.json")]: JSON.stringify({ pr: { number: 42 } }),
    [wpath("CTL-1", "phase-pr.json")]: JSON.stringify({ pr: { number: 42, url: "https://github.com/coalesce-labs/catalyst/pull/42" } }),
  });
  test("true when merged==true (REST)", () => {
    const runGh = makeRunGh({ "api repos/coalesce-labs/catalyst/pulls/42": { code: 0, stdout: JSON.stringify({ merged: true }), stderr: "" } });
    expect(WORK_DONE_PROBES["monitor-merge"]({ ticket: "CTL-1", orchDir: ORCH }, { readFile, runGh })).toBe(true);
  });
  test("false when merged==false", () => {
    const runGh = makeRunGh({ "api repos/coalesce-labs/catalyst/pulls/42": { code: 0, stdout: JSON.stringify({ merged: false }), stderr: "" } });
    expect(WORK_DONE_PROBES["monitor-merge"]({ ticket: "CTL-1", orchDir: ORCH }, { readFile, runGh })).toBe(false);
  });
  test("falls back to phase-pr.json number when monitor-merge signal lacks one", () => {
    const rf = makeReadFile({ [wpath("CTL-1", "phase-pr.json")]: JSON.stringify({ pr: { number: 7, url: "u" } }) });
    const runGh = makeRunGh({ "api repos/{owner}/{repo}/pulls/7": { code: 0, stdout: JSON.stringify({ merged: true }), stderr: "" } });
    expect(WORK_DONE_PROBES["monitor-merge"]({ ticket: "CTL-1", orchDir: ORCH }, { readFile: rf, runGh })).toBe(true);
  });
  test("false when no PR number anywhere / gh fails", () => {
    expect(WORK_DONE_PROBES["monitor-merge"]({ ticket: "CTL-1", orchDir: ORCH }, { readFile: makeReadFile({}), runGh: () => { throw new Error("no"); } })).toBe(false);
    expect(WORK_DONE_PROBES["monitor-merge"]({ ticket: "CTL-1", orchDir: ORCH }, { readFile, runGh: makeRunGh({}) })).toBe(false);
  });
});
