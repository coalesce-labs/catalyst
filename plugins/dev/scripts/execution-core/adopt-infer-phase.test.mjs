// Tests for adopt-infer-phase.mjs — CTL-1642.
// Run: cd plugins/dev/scripts/execution-core && node adopt-infer-phase.test.mjs
//
// These tests verify: infers correct phase from artifact presence,
// handles missing args, prints exactly one bare token on stdout.

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SHIM = join(__dirname, "adopt-infer-phase.mjs");

let passes = 0;
let failures = 0;

function pass(label) {
  passes++;
  console.log(`  PASS: ${label}`);
}

function fail(label, detail) {
  failures++;
  console.error(`  FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
}

function assert(cond, label, detail) {
  if (cond) pass(label);
  else fail(label, detail);
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@test.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@test.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

// run the shim synchronously, returns { code, stdout, stderr }
function runShim(args, env = {}) {
  const res = spawnSync("node", [SHIM, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 15000,
  });
  return {
    code: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function runGit(args, cwd) {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV },
  });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  }
  return res.stdout ?? "";
}

// makeGitFixture — create a temp git repo with the ticket branch checked out.
// Optionally seeds thoughts/ artifacts. Returns { dir, cleanup }.
//
// `branch` defaults to the bare ticket, but catalyst-adopt.sh accepts four shapes
// (`<ticket>`, `<ticket>-*`, `*/<ticket>`, `*/<ticket>-*`), so tests can override it
// to pin that inference is branch-shape-independent — see Test 7 (CTL-1642 P1).
function makeGitFixture(ticket, setup = () => {}, branch = ticket) {
  const base = mkdtempSync(join(tmpdir(), "adopt-infer-test-"));
  const origin = join(base, "origin.git");
  const work = join(base, "work");

  // bare origin + clone
  spawnSync("git", ["init", "--quiet", "--bare", "-b", "main", origin], {
    env: { ...process.env, ...GIT_ENV },
  });
  spawnSync("git", ["clone", "--quiet", origin, work], {
    env: { ...process.env, ...GIT_ENV },
  });
  // initial commit on main
  writeFileSync(join(work, "base.txt"), "base\n");
  runGit(["add", "base.txt"], work);
  runGit(["commit", "--quiet", "-m", "initial"], work);
  runGit(["push", "--quiet", "origin", "main"], work);

  // checkout the ticket branch (shape is caller-selectable — see the note above)
  runGit(["checkout", "--quiet", "-b", branch], work);

  // seed thoughts structure
  const thoughtsDir = join(work, "thoughts", "shared");
  mkdirSync(join(thoughtsDir, "research"), { recursive: true });
  mkdirSync(join(thoughtsDir, "plans"), { recursive: true });
  setup(work, thoughtsDir, ticket);

  return {
    dir: work,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

console.log("\nadopt-infer-phase.mjs tests\n");

// ─── Test 1: --ticket missing → non-zero exit ────────────────────────────────

{
  const { code, stderr } = runShim([]);
  assert(code !== 0, "exits non-zero when --ticket is missing");
  assert(stderr.includes("--ticket"), "stderr mentions --ticket", stderr);
}

// ─── Test 2: falls back to 'research' when no artifacts ──────────────────────

{
  const ticket = "PROJ-9999";
  const { dir, cleanup } = makeGitFixture(ticket);
  try {
    const { code, stdout, stderr } = runShim(
      ["--ticket", ticket, "--cwd", dir],
      GIT_ENV
    );
    assert(code === 0, "exits 0 with no artifacts", stderr);
    const token = stdout.trim();
    assert(token === "research", `prints 'research' fallback, got '${token}'`);
    assert(!token.includes("\n"), "stdout is a single line");
  } finally {
    cleanup();
  }
}

// ─── Test 3: infers 'plan' when research doc exists but no plan ─────────────
// research probe fires → next phase = plan

{
  const ticket = "PROJ-9998";
  const { dir, cleanup } = makeGitFixture(ticket, (work, td, t) => {
    const body = "## Summary\n" + "x".repeat(220);
    writeFileSync(join(td, "research", `2026-01-01-${t.toLowerCase()}.md`), body);
  });
  try {
    const { code, stdout, stderr } = runShim(
      ["--ticket", ticket, "--cwd", dir],
      GIT_ENV
    );
    assert(code === 0, "exits 0 with research artifact", stderr);
    const token = stdout.trim();
    assert(token === "plan", `infers 'plan' after research done, got '${token}'`);
  } finally {
    cleanup();
  }
}

// ─── Test 4: infers 'implement' when plan doc exists ────────────────────────
// plan probe fires → next phase = implement

{
  const ticket = "PROJ-9997";
  const { dir, cleanup } = makeGitFixture(ticket, (work, td, t) => {
    const tl = t.toLowerCase();
    writeFileSync(
      join(td, "research", `2026-01-01-${tl}.md`),
      "## Summary\n" + "x".repeat(220)
    );
    writeFileSync(
      join(td, "plans", `2026-01-01-${tl}.md`),
      "## Phase 1\nSome content\n\nSuccess Criteria: done\n" + "x".repeat(200)
    );
  });
  try {
    const { code, stdout, stderr } = runShim(
      ["--ticket", ticket, "--cwd", dir],
      GIT_ENV
    );
    assert(code === 0, "exits 0 with plan artifact", stderr);
    const token = stdout.trim();
    assert(token === "implement", `infers 'implement' after plan done, got '${token}'`);
  } finally {
    cleanup();
  }
}

// ─── Test 5: stdout is exactly one bare token (no log noise) ─────────────────

{
  const ticket = "PROJ-9996";
  const { dir, cleanup } = makeGitFixture(ticket);
  try {
    const { stdout } = runShim(["--ticket", ticket, "--cwd", dir], GIT_ENV);
    const lines = stdout.split("\n").filter((l) => l.length > 0);
    assert(lines.length === 1, `stdout has exactly one non-empty line, got ${lines.length}`, stdout);
    assert(!/\s/.test(lines[0].trim()), `token has no whitespace, got '${lines[0]}'`);
  } finally {
    cleanup();
  }
}

// ─── Test 6: caps at the worktree-detectable range (Codex #3175 round 2) ──────
// The shim mirrors recovery.mjs's inferResumePhase(ticket,{cwd}) — cwd only, no
// orchDir — so the orchDir-gated post-implement probes never fire and a retained
// verify.json under a worker dir must NOT pull inference to `review`. Post-implement
// routing (verify-verdict detour, stale post-PR sanitization) is the scheduler's job.
// A worktree with research+plan+implement done resumes at `verify` (the next
// worktree-detectable step), never `review`/`teardown`.

{
  const ticket = "PROJ-9995";
  const { dir, cleanup } = makeGitFixture(ticket, (work, td, t) => {
    const tl = t.toLowerCase();
    writeFileSync(join(td, "research", `2026-01-01-${tl}.md`), "## Summary\n" + "x".repeat(220));
    writeFileSync(
      join(td, "plans", `2026-01-01-${tl}.md`),
      "## Phase 1\nSome content\n\nSuccess Criteria: done\n" + "x".repeat(200)
    );
    // Commit the plan work so implementProbe (clean + ahead + plan phases) fires.
    runGit(["add", "-A"], work);
    runGit(["commit", "--quiet", "-m", "impl"], work);
    runGit(["push", "--quiet", "origin", "HEAD"], work);
  });
  try {
    const { code, stdout, stderr } = runShim(["--ticket", ticket, "--cwd", dir], GIT_ENV);
    assert(code === 0, "exits 0 with implement-complete worktree", stderr);
    const token = stdout.trim();
    assert(
      token === "verify",
      `caps at worktree-detectable range → 'verify' after implement, got '${token}'`
    );
  } finally {
    cleanup();
  }
}

// ─── Test 7: inference is BRANCH-SHAPE INDEPENDENT (Codex #3175 P1) ───────────
// The regression: the worktree-scoped probes used to re-derive the worktree from the
// branch name via resolveWorktree, whose porcelain match is EXACTLY `refs/heads/<ticket>`.
// catalyst-adopt.sh accepts three further shapes, so an adopted worktree on any of them
// resolved to null, every probe returned false, and inference silently collapsed to
// `research` no matter how much work was actually done — the worst case being a retained
// `done` research signal, where the dispatcher then exits 0 and adoption reports success
// having launched nothing.
//
// Each shape below seeds an identical research doc, so a correct implementation must
// infer `plan` for ALL of them. Before the fix only the bare-ticket case did; the other
// three returned `research`. Note the lowercase forms: Linear's branchName produces
// `ryan/<ticket>-slug` with a lowercased ticket, and those dominate the real worktree
// list, so an exact match fails on casing even for the `*/<ticket>-*` shape.

{
  const shapes = [
    ["PROJ-7", "PROJ-7", "bare ticket"],
    ["PROJ-7", "PROJ-7-hotfix", "<ticket>-suffix"],
    ["PROJ-7", "user/PROJ-7", "prefix/<ticket>"],
    ["PROJ-7", "ryan/PROJ-7-feature", "prefix/<ticket>-suffix"],
    ["PROJ-7", "ryan/proj-7-feature", "lowercase prefix/<ticket>-suffix"],
  ];

  for (const [ticket, branch, label] of shapes) {
    const { dir, cleanup } = makeGitFixture(
      ticket,
      (work, td, t) => {
        writeFileSync(
          join(td, "research", `2026-01-01-${t.toLowerCase()}.md`),
          "## Summary\n" + "x".repeat(220)
        );
      },
      branch
    );
    try {
      const { code, stdout, stderr } = runShim(["--ticket", ticket, "--cwd", dir], GIT_ENV);
      assert(code === 0, `exits 0 on branch shape: ${label}`, stderr);
      const token = stdout.trim();
      assert(
        token === "plan",
        `infers 'plan' on branch shape ${label} ('${branch}'), got '${token}'`
      );
    } finally {
      cleanup();
    }
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\nResults: ${passes} passed, ${failures} failed\n`);
if (failures > 0) process.exit(1);
