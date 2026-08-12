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
import { isTicketKey } from "./ticket-key.mjs";
import { parseWorktreeForBranch } from "./worktree.mjs";

// MIN_ARTIFACT_BYTES — a small size floor below which an artifact is treated as a
// truncated mid-write and NOT reclaimed (CTL-604, re-walk-artifact-validation
// precedent). Erring strict means a borderline artifact is re-dispatched (safe)
// rather than advanced on a partial doc (unsafe).
const MIN_ARTIFACT_BYTES = 200;

// PLAN_PHASE_HEADER_RE — anchored multiline regex matching the `## Phase ` marker
// that create-plan writes at the start of each implementation phase section. Must
// stay in lockstep with the `"## Phase "` marker planProbe uses (below) — both
// derive phaseCount from the same schema element.
const PLAN_PHASE_HEADER_RE = /^## Phase /gm;

// CTL-1810 — BOUND EVERY PROBE SPAWN.
//
// `defaultRunGit`/`defaultRunGh` were the only un-timed `spawnSync` seams left in
// execution-core, and both are called SYNCHRONOUSLY from `schedulerTick` (a 30s
// `setInterval`): resolveWorktree's `git worktree list`, ghPullRest's `gh api`, and the
// implement/verify/review probes' `git rev-list`/`git status`. An unbounded child — hung
// TLS, a GitHub incident, a credential-helper prompt, a stalled network mount — blocks the
// daemon's event loop indefinitely, with no clock and nothing to break the wait. That is
// the CTL-1524 failure mode (median event-loop delay 77.5s inside a synchronous drain
// burst; see wt-cleanup-drain.mjs:19-30).
//
// Every sibling probe in this directory was already bounded — pr-block-probe.mjs:24 (20s),
// github-quota-timer.mjs:43 (10s), github-auth-preflight.mjs:52 (10s) — and the first of
// those states this rationale in its own header. These two were the gap.
//
// WHY A TIMEOUT NEEDS NO NEW ERROR PATH HERE. Unlike pr-block-probe's `realGh`, these two
// seams contract to NEVER THROW; a timeout must degrade to the existing non-zero return, not
// an exception thrown into the tick. `spawnSync` reports a timeout by setting `res.error`
// (ETIMEDOUT) and leaving `status` null, which the pre-existing `if (res.error)` branch below
// already converts to `{ code: 127 }`. Callers then see "probe failed", which every probe
// already treats as "work NOT proven done" — the safe direction. The only addition is a
// stderr string that names the timeout, so a bound that fires is diagnosable rather than
// looking like a generic spawn failure.
//
// `CATALYST_GH_PROBE_TIMEOUT_MS` is deliberately the SAME knob (and the same 20s default)
// pr-block-probe.mjs already uses, so "the gh probe timeout" stays one value fleet-wide.
// Local `git` gets its own, tighter bound: measured warm-cache cost is 0.02-0.07s, so 10s is
// already three orders of magnitude of headroom.
const GIT_PROBE_TIMEOUT_MS = Number(process.env.CATALYST_GIT_PROBE_TIMEOUT_MS || 10000);
const GH_PROBE_TIMEOUT_MS = Number(process.env.CATALYST_GH_PROBE_TIMEOUT_MS || 20000);

// spawnResult — shared { code, stdout, stderr } normalizer for the two bounded seams.
// Never throws. A timed-out child (ETIMEDOUT, or killed by the timeout's SIGTERM) is
// reported as the same code:127 failure as any other spawn error, with a stderr that says
// so explicitly.
function spawnResult(bin, args, res, timeoutMs) {
  if (res.error) {
    const timedOut = res.error.code === "ETIMEDOUT" || res.signal === "SIGTERM";
    return {
      code: 127,
      stdout: "",
      stderr: timedOut ? `${bin} timed out after ${timeoutMs}ms: ${bin} ${args.join(" ")}` : res.error.message,
    };
  }
  return { code: res.status ?? 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// defaultRunGit — `git <args>` with stdout/stderr captured, bounded by `timeoutMs`.
// Returns { code, stdout, stderr }; never throws.
export function defaultRunGit(args, { spawn = spawnSync, timeoutMs = GIT_PROBE_TIMEOUT_MS } = {}) {
  const res = spawn("git", args, { encoding: "utf8", timeout: timeoutMs });
  return spawnResult("git", args, res, timeoutMs);
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
//
// `worktreePath` short-circuit (CTL-1642 Codex #3175 P1). A caller that ALREADY
// knows the worktree passes it and we return it verbatim — no git spawn, no
// branch matching. This exists because branch-name resolution is a strictly
// weaker way to answer a question the caller can already answer: the porcelain
// match is exact (`refs/heads/<ticket>`), so every other shape the surrounding
// tooling accepts — `<ticket>-hotfix`, `ryan/<ticket>-slug`, `codex/<ticket>-x`,
// and the lowercase `ryan/ctl-NNNN-…` forms that dominate the real worktree list
// — resolves to null and silently probes false. For `catalyst-adopt.sh` that
// turned every completed research/plan/implement signal into "not done" and
// pinned inference at `research`. Callers that do NOT pass it are unaffected:
// same git spawn, same exact match, same null-on-miss contract as before.
export function resolveWorktree(
  { ticket, repoRoot, worktreePath } = {},
  { runGit = defaultRunGit } = {},
) {
  if (worktreePath) return worktreePath;
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

// defaultRunGh — `gh <args>` with stdout/stderr captured, bounded by `timeoutMs`
// (CTL-1810 — see the GIT_PROBE_TIMEOUT_MS block above for why). Never throws.
export function defaultRunGh(args, { spawn = spawnSync, timeoutMs = GH_PROBE_TIMEOUT_MS } = {}) {
  const res = spawn("gh", args, { encoding: "utf8", timeout: timeoutMs });
  return spawnResult("gh", args, res, timeoutMs);
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

// commitProbe — commits-ahead>0 vs origin/main + clean tree on the worktree
// bound to refs/heads/<ticket>. The worktree path is resolved from `git worktree
// list --porcelain` (not reconstructed from projectKey config) so it's correct
// regardless of any per-team config drift — same precedent as teardownWorktree.
// Returns false on any git failure (safe default — missing worktree, stale ref,
// permission error, etc.). Shared by implementProbe (CTL-574) and remediateProbe
// (CTL-653); implement strengthens this core with a plan-completeness gate (CTL-663).
function commitProbe(
  { ticket, repoRoot, worktreePath: knownWorktree } = {},
  { runGit = defaultRunGit } = {},
) {
  if (!ticket || !repoRoot) return false;

  const worktreePath = resolveWorktree(
    { ticket, repoRoot, worktreePath: knownWorktree },
    { runGit },
  );
  if (!worktreePath) return false;

  const ahead = runGit(["-C", worktreePath, "rev-list", "--count", "origin/main..HEAD"]);
  if (ahead.code !== 0) return false;
  if (Number(ahead.stdout.trim() || "0") <= 0) return false;

  const status = runGit(["-C", worktreePath, "status", "--porcelain"]);
  if (status.code !== 0) return false;
  return status.stdout.trim() === "";
}

// implementProbe — strengthened (CTL-663 Option A): commitProbe's commits-ahead>0
// + clean-tree core, PLUS — when a plan doc exists for the ticket — a
// plan-completeness gate requiring commitCount >= the number of `## Phase `
// headers (at least one commit per plan phase; implement-plan commits each phase
// as it lands). A 1-of-5 partial branch therefore probes FALSE and is routed to
// the CTL-658 resume path (recovery branch C) instead of being reclaimed-as-done
// (branch B) — the CTL-661 premature-advance class. No plan doc / short doc /
// zero headers → gate skipped (backward compatible with planless tickets).
// remediateProbe NEVER gets this gate (Option A1) — remediate fixes 1–2 findings,
// not N plan phases; gating it would cause revive loops on short remediations.
function implementProbe(
  { ticket, repoRoot, worktreePath: knownWorktree } = {},
  {
    runGit = defaultRunGit,
    listArtifacts = defaultListArtifacts,
    readArtifact = defaultReadArtifact,
  } = {},
) {
  if (!ticket || !repoRoot) return false;

  const worktreePath = resolveWorktree(
    { ticket, repoRoot, worktreePath: knownWorktree },
    { runGit },
  );
  if (!worktreePath) return false;

  const ahead = runGit(["-C", worktreePath, "rev-list", "--count", "origin/main..HEAD"]);
  if (ahead.code !== 0) return false;
  const commitCount = Number(ahead.stdout.trim() || "0");
  if (commitCount <= 0) return false;

  const status = runGit(["-C", worktreePath, "status", "--porcelain"]);
  if (status.code !== 0) return false;
  if (status.stdout.trim() !== "") return false;

  // Plan-completeness gate: if a plan doc exists, all phases must have landed.
  const planDir = `${worktreePath}/thoughts/shared/plans`;
  let planFiles;
  try {
    planFiles = listArtifacts(planDir);
  } catch {
    planFiles = [];
  }
  if (Array.isArray(planFiles) && planFiles.length > 0) {
    const match = planFiles.find((f) => matchesTicket(f, ticket));
    if (match) {
      const body = readArtifact(`${planDir}/${match}`);
      if (body && body.length >= MIN_ARTIFACT_BYTES) {
        const phaseCount = (body.match(PLAN_PHASE_HEADER_RE) || []).length;
        if (phaseCount > 0 && commitCount < phaseCount) return false;
      }
    }
  }

  return true;
}

// matchesTicket — true when `filename` is a markdown file naming `ticket` as a
// WHOLE TOKEN: delimited on the left by start-of-name or a non-alphanumeric
// separator, and on the right by a non-alphanumeric character (or end).
//
// WHY THE BOUNDARIES ARE LOAD-BEARING. The old rule was a bare
// `lf.includes(ticket)`, and `<worktree>/thoughts/shared` is a SYMLINK into one
// shared repo — every worktree lists the identical corpus (measured: 695
// research + 630 plans docs, same realpath from every worktree). Over that live
// corpus the substring rule let **144 distinct ticket ids match a DIFFERENT
// ticket's document** (2721 foreign pairs), and 100 of those ids own no document
// at all. `CTL-56` owns nothing yet matched `2026-05-21-CTL-564.md`,
// `-CTL-565.md`, `-CTL-567.md` — so `researchProbe`/`planProbe` returned TRUE for
// CTL-56 off CTL-564's completed work. All three call sites turn that into a
// wrong conclusion: a false "work is done" (:368), a wrong plan-phase commit
// gate (:311), and a large forward-progress mark for a ticket with zero progress
// (:501), which makes the reclaim path revive instead of stop.
//
// This is the un-fixed JS twin of an already-solved bash problem: the
// dispatcher's gate `match_thoughts_artifact` (lib/phase-artifact-gate.sh,
// CTL-1081) is boundary-safe and states the same goal — "the word-boundary guard
// rejects cross-ticket lookalikes (e.g. ctl-10812 does NOT satisfy a ctl-1081
// gate)". The stale comment this replaces claimed to mirror the dispatcher's
// CTL-494 two-step match; the dispatcher moved to CTL-1081 and this copy never
// followed.
//
// The grammar is the bash gate's, widened only to accept `_` as a left delimiter
// so the six real `YYYY-MM-DD_ctl-NNNN_slug.md` docs on disk keep matching (the
// bash gate's `-`-only rule loses them — a pre-existing gap, verified live).
//
// Measured against the real corpus: foreign matches 2721 pairs / 144 ids -> 0;
// legitimate files newly unmatched -> 0. The new rule matches a STRICT SUBSET of
// what the old one matched (same substring, plus boundaries).
//
// What that subset means per call site — it is NOT uniformly "more conservative":
//   :368 artifactProbe    — fewer matches => fewer "work is done" returns. Strictly safer.
//   :501 progress mark    — fewer matches => no progress invented for a foreign doc. Safer.
//   :311 implement's gate — a non-match SKIPS the gate (the probe then returns true
//        on >=1 commit + clean tree), so dropping a match here removes a gate rather
//        than tightening one. That is still the right call: the gate being removed was
//        computing a commit threshold from ANOTHER ticket's plan, whose error direction
//        is arbitrary (too few phases => premature done; too many => a false "not done"
//        revive loop). Removing a wrong gate is correct; it is just not "more conservative".
//
// The ticket-id shape is validated with the CANONICAL predicate
// (`ticket-key.mjs` TICKET_KEY_RE, CTL-1504) rather than a local pattern. A
// narrower private copy here would reject a legitimate team key that carries a
// digit or underscore (`OPS_2-17`) or a long prefix/number, and a rejected id
// returns false from every call site above — silently reporting real artifacts as
// absent. That is the exact defect ticket-key.mjs was created to fix, and
// re-deriving the grammar here would have reintroduced it as a second un-fixed
// twin, which is the very failure this function's own history demonstrates.
// Uppercased before the test because the canonical predicate is uppercase-only
// while this matcher has always been case-insensitive about its input.
function matchesTicket(filename, ticket) {
  if (typeof filename !== "string" || typeof ticket !== "string") return false;
  const lf = filename.toLowerCase();
  if (!lf.endsWith(".md")) return false;
  // Reject a malformed ticket id rather than building a garbage regex from it.
  if (!isTicketKey(ticket.toUpperCase())) return false;
  const esc = ticket.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^0-9a-z])${esc}(?![0-9a-z])`).test(lf);
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
    { ticket, repoRoot, worktreePath: knownWorktree } = {},
    { runGit = defaultRunGit, listArtifacts = defaultListArtifacts, readArtifact = defaultReadArtifact } = {},
  ) => {
    if (!ticket || !repoRoot) return false;
    const worktreePath = resolveWorktree(
      { ticket, repoRoot, worktreePath: knownWorktree },
      { runGit },
    );
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
// tree. It reuses commitProbe's commit-state check (NOT implementProbe) so that
// the CTL-663 plan-completeness gate never applies to remediate — remediate fixes
// 1–2 findings, not N plan phases, and gating it would cause revive loops on
// short remediations (Option A1). Registering ANY probe is the real point
// (research §9): without it, a false-dead during remediate hits CTL-587's
// branch-(A) "no-probe-for-phase" escalation → needs-human.
const remediateProbe = commitProbe;

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
  implement: "commits ahead of origin/main + clean worktree + all plan phases landed (commits >= ## Phase count when a plan doc exists)",
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

// CTL-736 Phase 3: per-phase worker-dir JSON artifact whose byte-size measures
// forward progress (a growing artifact = progress, even before it is "done").
const PROGRESS_ARTIFACT = {
  triage: "triage.json",
  verify: "verify.json",
  review: "review.json",
  "monitor-deploy": "phase-monitor-deploy.json",
  pr: "phase-pr.json",
  "monitor-merge": "phase-monitor-merge.json",
};

// defaultProgressMark — CTL-736 Phase 3's forward-progress quantity for the
// reclaim path. Unlike the boolean work-done probes, this returns a MONOTONIC-ish
// non-negative integer so the reclaim path can tell progressed-then-died (revive)
// from zero-progress (stop, never respawn): code phases (implement/remediate) →
// commits-ahead-of-origin/main count; doc phases (research/plan) → matching
// markdown byte size; JSON worker-dir phases → artifact byte size. 0 on any miss
// (no worktree, no artifact, git failure) — the safe "no progress observed"
// default. Pure given the injected seams; never throws.
export function defaultProgressMark(
  { ticket, phase, repoRoot, orchDir } = {},
  {
    runGit = defaultRunGit,
    listArtifacts = defaultListArtifacts,
    readArtifact = defaultReadArtifact,
    readFile = defaultReadFile,
  } = {},
) {
  if (!ticket) return 0;

  // Code phases: commits ahead of origin/main on the ticket worktree.
  if (phase === "implement" || phase === "remediate") {
    const worktreePath = resolveWorktree({ ticket, repoRoot }, { runGit });
    if (!worktreePath) return 0;
    const ahead = runGit(["-C", worktreePath, "rev-list", "--count", "origin/main..HEAD"]);
    if (ahead.code !== 0) return 0;
    return Math.max(0, Number(ahead.stdout.trim()) || 0);
  }

  // Worktree markdown artifacts: research/plan → byte size of the matching doc.
  if (phase === "research" || phase === "plan") {
    const worktreePath = resolveWorktree({ ticket, repoRoot }, { runGit });
    if (!worktreePath) return 0;
    const subdir = phase === "research" ? "thoughts/shared/research" : "thoughts/shared/plans";
    let files;
    try {
      files = listArtifacts(`${worktreePath}/${subdir}`);
    } catch {
      return 0;
    }
    const match = (Array.isArray(files) ? files : []).find((f) => matchesTicket(f, ticket));
    if (!match) return 0;
    return (readArtifact(`${worktreePath}/${subdir}/${match}`) || "").length;
  }

  // JSON worker-dir phases (triage/verify/review/pr/monitor-*): artifact byte size.
  const name = PROGRESS_ARTIFACT[phase];
  if (name && orchDir) {
    const { ok, content } = readFile(workerArtifact(orchDir, ticket, name));
    return ok ? content.length : 0;
  }
  return 0;
}
