// cli/repo.mjs — repo-root resolution + a throwing, stderr-capturing git runner
// shared by the audit nouns (CTL-675).
//
// Two defects motivate this module:
//   1. The audit nouns shelled out to git with NO cwd anchor, so git resolved
//      the repo from the operator's inherited process cwd. Run from outside a
//      repo, every call threw `fatal: not a git repository`.
//   2. The inventory helpers swallowed that throw into ""/[], so tidy continued
//      and printed a success line — a silent no-op.
//
// resolveRepoRoot is the single anchor resolver; runGitCapture is the throwing,
// stderr-capturing runner the *inventory* helpers use (per-item action helpers
// and best-effort metadata keep their own local catch). Resolution precedence:
//   1. explicit --repo-root   2. $CATALYST_REPO_ROOT
//   3. current repo (git rev-parse --show-toplevel)   4. first registry repoRoot
import { execFileSync } from "node:child_process";
import { existsSync as fsExistsSync } from "node:fs";
import { listProjects } from "../registry.mjs";

export function resolveRepoRoot({
  explicit,
  env = process.env,
  cwd = process.cwd(),
  projects = listProjects(),
  existsSync = fsExistsSync,
  runGit = (args, opts) => execFileSync("git", args, opts),
} = {}) {
  if (explicit) return explicit; // 1
  if (env.CATALYST_REPO_ROOT) return env.CATALYST_REPO_ROOT; // 2
  try {
    // 3
    const top = runGit(["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (top) return top;
  } catch {
    /* not in a repo — fall through */
  }
  const reg = projects.find((p) => p.repoRoot && existsSync(p.repoRoot)); // 4
  if (reg) return reg.repoRoot;
  throw new Error(
    "cannot resolve a git repo root: not in a git repo, $CATALYST_REPO_ROOT unset, " +
      "and the registry has no usable repoRoot. Pass --repo-root <path>."
  );
}

export function runGitCapture(args, { cwd, run = (a, opts) => execFileSync("git", a, opts) } = {}) {
  try {
    return run(args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const detail =
      String(err?.stderr || err?.message || "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)[0] || "git failed";
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
}
