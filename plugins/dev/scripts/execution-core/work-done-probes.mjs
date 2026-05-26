// work-done-probes.mjs — per-phase "is the work committed already?" probes for the
// CTL-574 reclaim sweep. Pure given the injected seams; spawns nothing of its own
// at module load.
//
// The registry maps phase name → probe function. `implement` checks commit state
// (CTL-574); `research`/`plan` check for a complete on-disk artifact (CTL-604).
// Only `verify`/`review`/`pr`/`monitor-*` remain without a probe — they have no
// single on-disk artifact and stay CTL-587's auto-revival responsibility.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { parseWorktreeForBranch } from "./worktree.mjs";

// MIN_ARTIFACT_BYTES — a small size floor below which an artifact is treated as a
// truncated mid-write and NOT reclaimed (CTL-604, re-walk-artifact-validation
// precedent). Erring strict means a borderline artifact is re-dispatched (safe)
// rather than advanced on a partial doc (unsafe).
const MIN_ARTIFACT_BYTES = 200;

// defaultRunGit — `git <args>` with stdout/stderr captured. Returns
// { code, stdout, stderr }; never throws.
export function defaultRunGit(args, { spawn = spawnSync } = {}) {
  const res = spawn("git", args, { encoding: "utf8" });
  if (res.error) return { code: 127, stdout: "", stderr: res.error.message };
  return { code: res.status ?? 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// defaultListArtifacts — `readdirSync(dir)` → filenames; [] on any error (missing
// directory, permission, etc.). The injected-seam discipline mirrors defaultRunGit.
export function defaultListArtifacts(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// defaultReadArtifact — `readFileSync(path, "utf8")` → string; "" on any error.
export function defaultReadArtifact(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

// resolveWorktree — find the worktree path bound to refs/heads/<ticket> via
// `git worktree list --porcelain`. Shared by implementProbe and the artifact
// probes. Returns the path or null (missing input, git failure, or no match) —
// never throws, never spawns when input is incomplete.
export function resolveWorktree({ ticket, repoRoot } = {}, { runGit = defaultRunGit } = {}) {
  if (!ticket || !repoRoot) return null;
  const list = runGit(["-C", repoRoot, "worktree", "list", "--porcelain"]);
  if (list.code !== 0) return null;
  return parseWorktreeForBranch(list.stdout, ticket) || null;
}

// implementProbe — commits-ahead>0 vs origin/main + clean tree on the worktree
// bound to refs/heads/<ticket>. The worktree path is resolved from `git worktree
// list --porcelain` (not reconstructed from projectKey config) so it's correct
// regardless of any per-team config drift — same precedent as teardownWorktree.
// Returns false on any git failure (safe default — missing worktree, stale ref,
// permission error, etc.).
function implementProbe({ ticket, repoRoot } = {}, { runGit = defaultRunGit } = {}) {
  if (!ticket || !repoRoot) return false;

  const worktreePath = resolveWorktree({ ticket, repoRoot }, { runGit });
  if (!worktreePath) return false;

  const ahead = runGit(["-C", worktreePath, "rev-list", "--count", "origin/main..HEAD"]);
  if (ahead.code !== 0) return false;
  if (Number(ahead.stdout.trim() || "0") <= 0) return false;

  const status = runGit(["-C", worktreePath, "status", "--porcelain"]);
  if (status.code !== 0) return false;
  return status.stdout.trim() === "";
}

// matchesTicket — true when `filename` is a markdown file naming `ticket`. Mirrors
// the dispatcher's CTL-494 two-step match (strict `*-<ticket-lower>.md` then a
// wider case-insensitive `*<ticket>*.md`): the strict tail is a subset of the
// case-insensitive substring, so the substring check is the effective behavior.
function matchesTicket(filename, ticket) {
  const lf = filename.toLowerCase();
  return lf.endsWith(".md") && lf.includes(ticket.toLowerCase());
}

// bodyHasMarkers — completeness gate. `anyOf` requires at least one marker
// present; `allOf` requires every marker present. Either may be empty.
function bodyHasMarkers(body, { anyOf = [], allOf = [] }) {
  if (anyOf.length > 0 && !anyOf.some((m) => body.includes(m))) return false;
  if (allOf.length > 0 && !allOf.every((m) => body.includes(m))) return false;
  return true;
}

// artifactProbe — factory for an on-disk-artifact work-done probe (CTL-604). The
// probe is true only when (a) the ticket's worktree resolves, (b) a markdown file
// naming the ticket exists under `<worktree>/<subdir>`, and (c) that file clears
// the size floor AND carries the schema's closing markers. Any failure (missing
// worktree, no match, short/truncated body, throwing seam) returns false — the
// established safe default, so a borderline artifact is re-dispatched, not advanced.
function artifactProbe(subdir, markers) {
  return (
    { ticket, repoRoot } = {},
    { runGit = defaultRunGit, listArtifacts = defaultListArtifacts, readArtifact = defaultReadArtifact } = {},
  ) => {
    if (!ticket || !repoRoot) return false;
    const worktreePath = resolveWorktree({ ticket, repoRoot }, { runGit });
    if (!worktreePath) return false;

    const dir = `${worktreePath}/${subdir}`;
    let files;
    try {
      files = listArtifacts(dir);
    } catch {
      return false;
    }
    if (!Array.isArray(files) || files.length === 0) return false;

    const match = files.find((f) => matchesTicket(f, ticket));
    if (!match) return false;

    const body = readArtifact(`${dir}/${match}`);
    if (!body || body.length < MIN_ARTIFACT_BYTES) return false;
    return bodyHasMarkers(body, markers);
  };
}

// researchProbe — a complete research doc under thoughts/shared/research/ (CTL-604).
// Completeness requires the closing `## Code References` or `## Summary` section the
// research artifact schema guarantees.
const researchProbe = artifactProbe("thoughts/shared/research", {
  anyOf: ["## Code References", "## Summary"],
});

// planProbe — a complete plan under thoughts/shared/plans/ (CTL-604). Completeness
// requires at least one `## Phase ` heading AND a `Success Criteria` marker (the
// create-plan schema).
const planProbe = artifactProbe("thoughts/shared/plans", {
  allOf: ["## Phase ", "Success Criteria"],
});

// WORK_DONE_PROBES — phase → probe. Adding a probe is the entire opt-in for a
// phase to participate in the CTL-574 reclaim sweep. Phases without an entry
// (verify/review/pr/monitor-*) remain CTL-587's responsibility (auto-revival).
export const WORK_DONE_PROBES = {
  implement: implementProbe,
  research: researchProbe,
  plan: planProbe,
};

// hasProbe — true when the given phase has a registered probe. Used by the
// reclaim function to classify a `dead` worker as 'not-applicable' when the
// phase has no work-done probe yet.
export function hasProbe(phase) {
  return Object.prototype.hasOwnProperty.call(WORK_DONE_PROBES, phase);
}
