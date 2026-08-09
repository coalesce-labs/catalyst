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
function makeGitFixture(ticket, setup = () => {}) {
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

  // checkout the ticket branch
  runGit(["checkout", "--quiet", "-b", ticket], work);

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
  const ticket = "CTL-9999";
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
  const ticket = "CTL-9998";
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
  const ticket = "CTL-9997";
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
  const ticket = "CTL-9996";
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

// ─── Test 6: orchDir threading — orchestrator-scoped probes fire (Codex #3175) ─
// A durable verify.json under <orchDir>/workers/<ticket>/ must let the shim infer
// the phase AFTER verify (review). Without --orch-dir the same fixture can only
// see up to the worktree artifacts, so it falls back to 'research'. This proves
// the P2 fix: the orchestrator-scoped probes now receive orchDir.

{
  const ticket = "CTL-9995";
  const { dir, cleanup } = makeGitFixture(ticket);
  const orchDir = join(dir, "..", "orch");
  const workerDir = join(orchDir, "workers", ticket);
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(
    join(workerDir, "verify.json"),
    JSON.stringify({
      findings: [],
      regression_risk: 2,
      tests_attempted: 3,
      gates: {},
      generatedAt: "2026-01-01T00:00:00Z",
    })
  );
  try {
    // Without --orch-dir: the orchestrator-scoped probes cannot see the signal.
    const noOrch = runShim(["--ticket", ticket, "--cwd", dir], GIT_ENV);
    assert(
      noOrch.stdout.trim() === "research",
      `without --orch-dir falls back to research, got '${noOrch.stdout.trim()}'`
    );
    // With --orch-dir: verifyProbe fires → next phase is review.
    const withOrch = runShim(
      ["--ticket", ticket, "--cwd", dir, "--orch-dir", orchDir],
      GIT_ENV
    );
    assert(withOrch.code === 0, "exits 0 with orchDir verify.json", withOrch.stderr);
    assert(
      withOrch.stdout.trim() === "review",
      `infers 'review' after verify done (orchDir threaded), got '${withOrch.stdout.trim()}'`
    );
  } finally {
    cleanup();
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\nResults: ${passes} passed, ${failures} failed\n`);
if (failures > 0) process.exit(1);
