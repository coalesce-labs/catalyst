// work-done-probes.mjs — per-phase "is the work committed already?" probes for the
// CTL-574 reclaim sweep. Pure given the injected seams; spawns nothing of its own
// at module load.
//
// The registry maps phase name → probe function. `implement` checks commit state
// (CTL-574); `research`/`plan` check for a complete on-disk artifact (CTL-604);
// `triage`/`verify`/`review`/`monitor-deploy` validate a worker-dir JSON artifact's
// content and `pr`/`monitor-merge` query the PR's REST merge state (CTL-641).
// Every pipeline phase now carries a probe — branch (A) "no-probe-for-phase"
// escalation is reached only by a genuinely-unknown phase name.

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

// defaultReadFile — read a file as utf8. Returns { ok, content }; never throws
// (ENOENT / EACCES → { ok: false, content: "" }). Mirrors defaultRunGit's
// never-throw contract so probes keep their safe-default-false logic linear.
export function defaultReadFile(path, { read = readFileSync } = {}) {
  try {
    return { ok: true, content: read(path, "utf8") };
  } catch {
    return { ok: false, content: "" };
  }
}

// readJson — { ok, value } parse of a worker-dir JSON artifact. ok=false on a
// missing file OR a parse error (both mean "not done").
function readJson(path, readFile) {
  const { ok, content } = readFile(path);
  if (!ok) return { ok: false, value: null };
  try {
    return { ok: true, value: JSON.parse(content) };
  } catch {
    return { ok: false, value: null };
  }
}

// workerArtifact — ${orchDir}/workers/<ticket>/<name>; the canonical worker-dir
// JSON/signal layout (signal-reader.mjs).
const workerArtifact = (orchDir, ticket, name) => `${orchDir}/workers/${ticket}/${name}`;

// CTL-641: JSON worker-dir probes (triage, verify, review, monitor-deploy).
// Each validates artifact CONTENT, not mere existence (memory
// project_phase_rewalk_artifact_validation: a truncated artifact must read as
// not-done). Field shapes verified against the phase skills + real archived
// artifacts: triage.json {classification,…}, verify.json
// {regression_risk,findings,tests_attempted,gates,generatedAt} (phase-verify
// SKILL.md:182-189), review.json
// {findings,remediationCommit,reviewPassed,generatedAt} (phase-review
// SKILL.md:167-175), phase-monitor-deploy.json {deploy_state,…}.

function triageProbe({ ticket, orchDir } = {}, { readFile = defaultReadFile } = {}) {
  if (!ticket || !orchDir) return false;
  const { ok, value } = readJson(workerArtifact(orchDir, ticket, "triage.json"), readFile);
  return ok && typeof value?.classification === "string" && value.classification.trim() !== "";
}

function verifyProbe({ ticket, orchDir } = {}, { readFile = defaultReadFile } = {}) {
  if (!ticket || !orchDir) return false;
  const { ok, value } = readJson(workerArtifact(orchDir, ticket, "verify.json"), readFile);
  if (!ok || !value) return false;
  return (
    Array.isArray(value.findings) &&
    "regression_risk" in value &&
    "tests_attempted" in value &&
    "gates" in value &&
    typeof value.generatedAt === "string"
  );
}

// CTL-653: readVerifyVerdict — the verdict the advancement router branches on
// after a verify `done`. Reuses verifyProbe's verify.json read shape. Returns:
//   "fail" — regression_risk ≥ 5 OR any severity:"high" finding (phase-verify
//            SKILL.md:196-208 thresholds) → router detours verify → remediate.
//   "pass" — readable verdict below threshold with no high finding → verify → review.
//   null   — missing/malformed/non-numeric-risk artifact. Deliberately distinct
//            from "pass" so the router can apply the conservative non-regressing
//            default (route to review) rather than stalling on an absent verdict.
// Pure given the injected readFile seam; never throws (readJson swallows misses).
export function readVerifyVerdict({ ticket, orchDir } = {}, { readFile = defaultReadFile } = {}) {
  if (!ticket || !orchDir) return null;
  const { ok, value } = readJson(workerArtifact(orchDir, ticket, "verify.json"), readFile);
  if (!ok || !value || typeof value.regression_risk !== "number") return null;
  const highFinding =
    Array.isArray(value.findings) && value.findings.some((f) => f?.severity === "high");
  return value.regression_risk >= 5 || highFinding ? "fail" : "pass";
}

function reviewProbe({ ticket, orchDir } = {}, { readFile = defaultReadFile } = {}) {
  if (!ticket || !orchDir) return false;
  const { ok, value } = readJson(workerArtifact(orchDir, ticket, "review.json"), readFile);
  if (!ok || !value) return false;
  return (
    Array.isArray(value.findings) &&
    typeof value.reviewPassed === "boolean" &&
    "remediationCommit" in value &&
    typeof value.generatedAt === "string"
  );
}

// deploy_state ∈ {success, skipped} is terminal-done (signal-reader.mjs:29 ranks
// `skipped` the same as `done`: no deployment_status arrived before the timeout).
const DEPLOY_DONE_STATES = new Set(["success", "skipped"]);
function monitorDeployProbe({ ticket, orchDir } = {}, { readFile = defaultReadFile } = {}) {
  if (!ticket || !orchDir) return false;
  const { ok, value } = readJson(workerArtifact(orchDir, ticket, "phase-monitor-deploy.json"), readFile);
  return ok && DEPLOY_DONE_STATES.has(value?.deploy_state);
}

// CTL-641 Phase 3: gh-backed probes (pr, monitor-merge). pr is done when its PR
// is open or already merged; monitor-merge is done when the PR is merged. The
// PR number/url come from the worker-dir signal; the merge state comes from the
// REST endpoint (`gh api repos/<slug>/pulls/<n>` → lowercase `.state`/`.merged`,
// per research §4 — NOT `gh pr view --json state`, whose GraphQL state is
// uppercase and would never compare equal to "open").

// defaultRunGh — `gh <args>` with stdout/stderr captured; never throws.
export function defaultRunGh(args, { spawn = spawnSync } = {}) {
  const res = spawn("gh", args, { encoding: "utf8" });
  if (res.error) return { code: 127, stdout: "", stderr: res.error.message };
  return { code: res.status ?? 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// prInfoFromSignal — read { number, url } from a worker-dir signal's .pr. null
// on any miss (missing file, parse error, no number).
function prInfoFromSignal(orchDir, ticket, signalName, readFile) {
  const { ok, value } = readJson(workerArtifact(orchDir, ticket, signalName), readFile);
  if (!ok || !value?.pr?.number) return null;
  return { number: value.pr.number, url: value.pr.url ?? null };
}

// repoSlugFromUrl — "https://github.com/owner/repo/pull/42" → "owner/repo", or null.
function repoSlugFromUrl(url) {
  const m = typeof url === "string" && url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/);
  return m ? m[1] : null;
}

// ghPullRest — REST pull payload ({ state, merged, … }) for a PR, or null on any
// gh/parse failure. Slug from the PR url; when absent, gh substitutes
// {owner}/{repo} from the cwd repo.
function ghPullRest(pr, runGh) {
  const slug = repoSlugFromUrl(pr.url) || "{owner}/{repo}";
  const res = runGh(["api", `repos/${slug}/pulls/${pr.number}`]);
  if (res.code !== 0) return null;
  try {
    return JSON.parse(res.stdout);
  } catch {
    return null;
  }
}

function prProbe({ ticket, orchDir } = {}, { readFile = defaultReadFile, runGh = defaultRunGh } = {}) {
  if (!ticket || !orchDir) return false;
  const pr = prInfoFromSignal(orchDir, ticket, "phase-pr.json", readFile);
  if (!pr) return false;
  const json = ghPullRest(pr, runGh);
  // open or already-merged both mean the PR phase landed its artifact.
  return json?.state === "open" || json?.merged === true;
}

function monitorMergeProbe({ ticket, orchDir } = {}, { readFile = defaultReadFile, runGh = defaultRunGh } = {}) {
  if (!ticket || !orchDir) return false;
  const mm = prInfoFromSignal(orchDir, ticket, "phase-monitor-merge.json", readFile);
  const prSig = prInfoFromSignal(orchDir, ticket, "phase-pr.json", readFile);
  const number = mm?.number ?? prSig?.number;
  if (!number) return false;
  // phase-monitor-merge.json omits .pr.url, so prefer phase-pr.json for the slug.
  const url = prSig?.url ?? mm?.url ?? null;
  return ghPullRest({ number, url }, runGh)?.merged === true;
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

// CTL-653: remediateProbe — remediate is fix-capable (like implement), so its
// work-done signal is the same: a commit landed on the ticket branch + a clean
// tree. It reuses implementProbe's commit-state check verbatim. Registering ANY
// probe is the real point (research §9): without it, a false-dead during
// remediate hits CTL-587's branch-(A) "no-probe-for-phase" escalation →
// needs-human, defeating the very autonomy CTL-653 adds.
const remediateProbe = implementProbe;

// WORK_DONE_PROBES — phase → probe. Adding a probe is the entire opt-in for a
// phase to participate in the CTL-574 reclaim sweep. All nine pipeline phases
// plus the ancillary remediate phase (CTL-653) have an entry; only a
// genuinely-unknown phase falls through to CTL-587's branch-(A) escalation.
export const WORK_DONE_PROBES = {
  implement: implementProbe,
  research: researchProbe,
  plan: planProbe,
  triage: triageProbe,
  verify: verifyProbe,
  review: reviewProbe,
  pr: prProbe,
  "monitor-merge": monitorMergeProbe,
  "monitor-deploy": monitorDeployProbe,
  remediate: remediateProbe,
};

// hasProbe — true when the given phase has a registered probe. Used by the
// reclaim function to classify a `dead` worker as 'not-applicable' when the
// phase has no work-done probe yet.
export function hasProbe(phase) {
  return Object.prototype.hasOwnProperty.call(WORK_DONE_PROBES, phase);
}

// CTL-664: human-readable description of what each work-done probe verifies.
// Co-located with WORK_DONE_PROBES so adding a probe and describing it stay in
// one place (the first probe-descriptions test enforces a description for every
// registered probe). Surfaced in the enriched phase.*.reclaim payload
// (probe_checked) so an operator reading the event/HUD knows what evidence the
// daemon used to declare the dead worker's work complete.
export const WORK_DONE_PROBE_DESCRIPTIONS = {
  implement: "commits ahead of origin/main + clean worktree",
  remediate: "commits ahead of origin/main + clean worktree",
  research: "≥200-byte research md naming the ticket with ## Summary / ## Code References",
  plan: "≥200-byte plan with ## Phase and Success Criteria",
  triage: "triage.json with a non-empty classification",
  verify: "verify.json with findings[], regression_risk, tests_attempted, gates, generatedAt",
  review: "review.json with findings[], reviewPassed, remediationCommit, generatedAt",
  pr: "GitHub PR state=open or merged=true",
  "monitor-merge": "GitHub PR merged=true",
  "monitor-deploy": "phase-monitor-deploy.json with deploy_state in {success,skipped}",
};

// describeProbe — the probe-checked string for the enriched reclaim payload.
// Falls back to "unknown" for an unregistered phase (branch (A) territory, where
// a dead worker has no probe and is escalated rather than reclaimed).
export function describeProbe(phase) {
  return WORK_DONE_PROBE_DESCRIPTIONS[phase] ?? "unknown";
}
