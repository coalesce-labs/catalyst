// checkout-sync.mjs — CTL-1808. Keep every enrolled PRIMARY checkout at origin/<default>.
//
// ─── WHY THIS IS A SUBSCRIBER AND NOT A CALL ────────────────────────────────────
//
// The primary checkout must fast-forward when something merges. That was built the old
// way — a helper (`pull-primary-worktree.sh`) invoked explicitly by the merge skill — and
// it decayed exactly as that shape always decays: the helper acquired two callers plus a
// third INLINE reimplementation inside one of them (`merge-pr/SKILL.md:458-461` runs its
// own `git checkout $base && git pull` a few lines from where it calls the helper), while
// the workflow moved out from under it. `phase-monitor-merge`, `phase-teardown`, PR triage,
// recovery-pass, and every merge a human does by hand have never called it.
//
// On 2026-08-12 that produced four measured incidents in one day: two agents read stale
// trees and each came within one inference of filing "this feature was never built" against
// work that was merged, deployed, and in front of a live customer (one checkout 22 commits
// behind, another 17); and a stale sibling clone hid a ratified ADR from three separate
// agents, each of whom concluded the document did not exist.
//
// Adding the call to the paths that lack it reproduces the bug. So does moving it to a
// shared "merge confirmed" seam — BOTH still couple the side effect to the merger, and the
// sixth merge path written next month misses it again. So the merge emits nothing extra and
// knows nothing; THIS runs on its own clock and reacts to the world.
//
// ─── THE RULE THAT SHAPES THE MECHANISM ─────────────────────────────────────────
//
// "Let the event wake the scan; never let it replace the scan." A periodic pass holds the
// entire correctness intent; an event may only make it happen sooner. This module therefore
// takes NO argument describing what merged — it cannot act on an event's contents even by
// mistake — and it keeps NO record of work done: no consumed offset, no handled-merge
// marker, no cursor. It asks the world every pass.
//
// That is not academic here. The local event log on a monitor node was MEASURED (CTL-1812)
// to be missing 341,356 events — 15.6% of one worker's and 13.6% of the other's. A design
// that is correct only when it receives the event would be wrong one time in seven on this
// very machine. If every event were lost, this still converges within one interval.
//
// ─── WHAT IT MAY DO ─────────────────────────────────────────────────────────────
//
// The entire mutating vocabulary is `git fetch <one refspec>` and `git merge --ff-only`.
// Explicitly never, on any path or flag: reset, checkout, clean, stash, rebase, gc, prune,
// remote set-head, tag fetch, config write, or any deletion. If a situation needs a
// decision, it is not this automation's to make — it refuses and says exactly what it found.

import { createHash } from "node:crypto";

// ── Outcomes ──────────────────────────────────────────────────────────────────
// A closed vocabulary. `refused` always carries a `refused_reason`; `fetch-failed` is
// deliberately NOT a refusal — transient infrastructure must never read as a human problem.
export const ACTION = Object.freeze({
  CURRENT: "current",
  ADVANCED: "advanced",
  REFUSED: "refused",
  FETCH_FAILED: "fetch-failed",
  SKIPPED: "skipped",
  DIAGNOSTIC: "diagnostic-only",
});

// REFUSAL — every reason this automation declines to act. Each is a state a human must
// resolve, and each is reported verbatim rather than summarised, because "refused" without
// the reason is the silent failure this ticket exists to remove.
export const REFUSAL = Object.freeze({
  DETACHED: "detached-head",
  WRONG_BRANCH: "primary-on-other-branch",
  OP_IN_PROGRESS: "git-operation-in-progress",
  LOCAL_COMMITS: "unpushed-local-commits",
  FF_BLOCKED: "ff-blocked-by-local-changes",
  NO_UPSTREAM: "no-upstream",
  DEFAULT_UNRESOLVED: "default-branch-unresolved",
  BROKEN_POINTER: "broken-worktree-pointer",
  LINKED_WORKTREE: "not-a-primary-checkout",
});

// ── Pure helpers ──────────────────────────────────────────────────────────────

// slugForRoot — a stable, filesystem-safe id for a repo path, used for the per-repo lock
// and alert-latch filenames. A hash rather than a sanitised path so two roots differing
// only in a character the sanitiser would fold cannot collide onto one lock.
export function slugForRoot(root) {
  return createHash("sha256").update(String(root)).digest("hex").slice(0, 16);
}

// parseSymrefDefault — read the default branch from `git ls-remote --symref origin HEAD`.
//
// This is asked of the REMOTE every pass on purpose. The local `refs/remotes/origin/HEAD`
// is a clone-time cache that no fetch updates; trusting it would reintroduce exactly the
// class of defect this ticket is about — a stale local copy asserted as current fact.
export function parseSymrefDefault(stdout) {
  if (typeof stdout !== "string") return null;
  for (const line of stdout.split("\n")) {
    // `ref: refs/heads/main\tHEAD`
    const m = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/.exec(line.trim());
    if (m) return m[1];
  }
  return null;
}

// classifyGitState — the guard set, as a PURE function of already-collected observations.
// Returns null when every guard holds (safe to fast-forward), else the refusal.
//
// Note what is NOT here: a dirty worktree is not pre-refused. `merge --ff-only` aborts
// precisely when it would clobber a local edit and otherwise fast-forwards while preserving
// it, so pre-refusing on dirt would be this automation making a judgement call that git
// makes better. Let the tool that owns the invariant enforce it.
export function classifyGitState(obs) {
  if (!obs || typeof obs !== "object") return REFUSAL.BROKEN_POINTER;
  if (obs.brokenPointer) return REFUSAL.BROKEN_POINTER;
  // G1 — a linked worktree has its own HEAD and belongs to phase-agent-dispatch's rebase
  // layers. A second writer there is the genuinely dangerous version of this ticket.
  if (obs.isLinkedWorktree) return REFUSAL.LINKED_WORKTREE;
  // G3 — an interrupted git operation. The user's commits may exist only in the reflog.
  if (obs.operationInProgress) return REFUSAL.OP_IN_PROGRESS;
  // G2 — detached, or deliberately parked on another branch. Both are someone's workspace.
  if (obs.detached) return REFUSAL.DETACHED;
  if (obs.defaultBranch && obs.currentBranch !== obs.defaultBranch) return REFUSAL.WRONG_BRANCH;
  if (!obs.hasUpstreamRef) return REFUSAL.NO_UPSTREAM;
  // G4 — local commits that are not on the remote. `--ff-only` would refuse anyway; this
  // reports it as the distinct, actionable state it is rather than as a merge failure.
  if (obs.aheadBy > 0) return REFUSAL.LOCAL_COMMITS;
  return null;
}

// summarize — fold per-repo results into the one-line verdict a human or a check reads.
// Counts every action so a pass that did nothing is distinguishable from one that never ran.
export function summarize(repos) {
  const out = { total: repos.length, current: 0, advanced: 0, refused: 0, fetchFailed: 0, skipped: 0, diagnostic: 0, unreachableCommits: 0 };
  for (const r of repos) {
    if (r.action === ACTION.CURRENT) out.current += 1;
    else if (r.action === ACTION.ADVANCED) out.advanced += 1;
    else if (r.action === ACTION.REFUSED) out.refused += 1;
    else if (r.action === ACTION.FETCH_FAILED) out.fetchFailed += 1;
    else if (r.action === ACTION.SKIPPED) out.skipped += 1;
    else if (r.action === ACTION.DIAGNOSTIC) out.diagnostic += 1;
    out.unreachableCommits += Number(r.unreachable_commits ?? 0) || 0;
  }
  return out;
}

// resolveAllowlist — the enrolled primary checkouts, from three DECLARED sources.
//
// Never a filesystem walk for `.git`. A walk would sweep in harness worktrees under
// `.claude/worktrees/`, the forensic archive, the marketplace cache, and third-party
// clones — repos this automation has no business touching and whose states it would then
// have to reason about. An allowlist is also what makes "zero repos" a detectable
// misconfiguration rather than a quiet no-op.
//
// Sibling repos matter: the 2026-08-12 ADR incident was `catalyst-cloud`, NOT this repo.
// A catalyst-only subscriber would have caught none of the four incidents.
export function resolveAllowlist({ registryRoots = [], selfRoot = null, configuredRoots = [] } = {}) {
  const seen = new Set();
  const out = [];
  for (const r of [...registryRoots, ...(selfRoot ? [selfRoot] : []), ...configuredRoots]) {
    if (typeof r !== "string" || !r.trim()) continue;
    const root = r.replace(/\/+$/, "");
    if (seen.has(root)) continue;
    seen.add(root);
    out.push(root);
  }
  return out;
}

// ── The pass ──────────────────────────────────────────────────────────────────

// syncRepo — one repo, one pass. Every effect is an injected seam so the whole decision
// tree is testable without a git binary, a network, or a real checkout.
//
// ORDER IS LOAD-BEARING: resolve the default branch, FETCH, and only then evaluate the
// guards — because `aheadBy` is measured against `origin/<default>`, and before the fetch
// that ref is stale or absent. Evaluating it first asks git about a commit the local object
// store does not have, which errors on precisely the repos that are behind: the main path.
export async function syncRepo(root, deps) {
  const {
    lsRemoteDefault,     // (root) -> {ok, branch} | {ok:false}
    offlineDefault,      // (root) -> branch | null   (origin/HEAD cache; DIAGNOSTIC ONLY)
    fetchRef,            // (root, branch) -> {ok, stderr}
    observe,             // (root, branch) -> observations for classifyGitState
    mergeFf,             // (root, branch) -> {ok, stderr}
    headSha,             // (root) -> sha | null
    remoteSha,           // (root, branch) -> sha | null
    behindCount,         // (root, branch) -> number
    unreachableCount,    // (root) -> number
  } = deps;

  const base = { root, action: ACTION.REFUSED, refused_reason: null, behind_by: 0, unreachable_commits: 0 };

  // 1. The default branch, from the remote. This is the only authority.
  const sym = await lsRemoteDefault(root);
  let branch = sym?.ok ? sym.branch : null;
  let diagnosticOnly = false;
  if (!branch) {
    // The remote is unreachable. The local cache MAY tell us the branch — but a cached
    // answer is exactly the kind of stale fact this ticket exists to stop trusting, so it
    // may inform a REPORT and must never authorise a WRITE.
    branch = offlineDefault(root);
    if (!branch) return { ...base, refused_reason: REFUSAL.DEFAULT_UNRESOLVED };
    diagnosticOnly = true;
  }
  base.branch = branch;

  // 2. Fetch BEFORE the guards, so every subsequent comparison is against a current ref.
  if (!diagnosticOnly) {
    const f = await fetchRef(root, branch);
    if (!f.ok) {
      // Transient infrastructure is NOT a refusal and NOT a human's problem. It is reported,
      // counted, and escalated only if it persists — never labelled needs-human.
      return { ...base, action: ACTION.FETCH_FAILED, refused_reason: null, error: (f.stderr || "").split("\n")[0]?.slice(0, 200) ?? "" };
    }
  }

  // 3. Guards, all against the just-fetched ref.
  const obs = await observe(root, branch);
  base.unreachable_commits = Number(await unreachableCount(root)) || 0;
  const refusal = classifyGitState({ ...obs, defaultBranch: branch });
  base.behind_by = Number(await behindCount(root, branch)) || 0;
  if (refusal) return { ...base, refused_reason: refusal, detail: obs.detail ?? null };

  if (diagnosticOnly) {
    // Guards pass, but the branch came from a cache we do not trust to authorise a write.
    return { ...base, action: ACTION.DIAGNOSTIC, refused_reason: null };
  }

  if (base.behind_by === 0) return { ...base, action: ACTION.CURRENT, refused_reason: null };

  // 4. Act.
  const before = await headSha(root);
  const m = await mergeFf(root, branch);

  // 5. THE ORACLE. The verdict is what the world says, never the exit code.
  //
  // This is not defensive padding. On a non-default branch `git pull --ff-only` exits 0 with
  // "Already up to date." while N commits behind — so an exit-code verdict reports success it
  // did not achieve, which is the one thing rule 4 forbids outright. Ask where HEAD actually is.
  const after = await headSha(root);
  const target = await remoteSha(root, branch);
  if (after && target && after === target) {
    return { ...base, action: ACTION.ADVANCED, refused_reason: null, old_sha: before, new_sha: after };
  }
  return {
    ...base,
    refused_reason: REFUSAL.FF_BLOCKED,
    // git's own words, not our paraphrase — it names the files that blocked the merge.
    detail: (m?.stderr || "").split("\n").slice(0, 3).join(" ").slice(0, 300),
  };
}

// runPass — every enrolled repo, once. Never throws: a scanner that dies on one bad repo
// stops protecting the others, and its silence would be indistinguishable from health.
export async function runPass({ roots, deps, reason = "timer", now = () => new Date().toISOString(), host = "" }) {
  const repos = [];
  for (const root of roots) {
    try {
      repos.push(await syncRepo(root, deps));
    } catch (err) {
      repos.push({
        root,
        action: ACTION.FETCH_FAILED,
        refused_reason: null,
        behind_by: 0,
        unreachable_commits: 0,
        error: String(err?.message ?? err).slice(0, 200),
      });
    }
  }
  // The heartbeat is written on EVERY pass, acting or not. A scanner whose only output is a
  // refusal is invisible when it dies — and a dead scanner never refuses. This status record
  // is what makes "it stopped running" a detectable state rather than an absence of news.
  return { ts: now(), host, reason, repos, summary: summarize(repos) };
}
