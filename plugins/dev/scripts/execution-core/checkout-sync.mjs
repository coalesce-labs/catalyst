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
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// The canonical Layer-2 path chain (CTL-1616 §2). Imported, never re-derived: a second
// copy of that ladder is how one process reads `$XDG_CONFIG_HOME/catalyst/config.json`
// while another reads `~/.config/catalyst/config.json` and they disagree about what is
// configured. `secret-contract.mjs` is a zero-npm-dep node:* leaf, so importing it keeps
// this module loadable under bare node (the catalyst-agent's runtime — CTL-1825).
import { resolveLayer2Path } from "../lib/secret-contract.mjs";

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
  // A checkout we could not read a branch from is BROKEN, not "repurposed" (Codex #3316 P2).
  // Without this, a null/partial observation spread into {} leaves currentBranch undefined,
  // which compares unequal to the default and reports `primary-on-other-branch` — a
  // plausible-but-wrong reason that sends a human to look at the wrong thing. Checked before
  // the branch comparison precisely so it cannot be misread as that.
  if (!obs.detached && (typeof obs.currentBranch !== "string" || !obs.currentBranch)) {
    return REFUSAL.BROKEN_POINTER;
  }
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

// ── The declared sources, collected ───────────────────────────────────────────
//
// resolveAllowlist above takes the three source LISTS. Collecting them — reading the
// registry, finding this checkout, reading Layer-2, naming plugin-source — is what
// follows. It lives HERE, next to the fold, because the moment a second consumer needs
// "which checkouts does this host run?" it either imports this or writes its own, and two
// readers of the same question drift. CTL-1825's currency gauge is that second consumer:
// it measures exactly this set, so a root that the sync pass would fast-forward is also a
// root the gauge reports on — one enumeration, two uses, no chance of one covering a tree
// the other cannot see.

// defaultReadJson — parse a JSON file, or null for absent/unreadable/malformed. Total:
// an operator's typo in Layer-2 must not take out the enumeration (and with it every
// OTHER root's measurement), which is what a throw here would do.
function defaultReadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// defaultSelfRoot — the checkout THIS file is running out of, found by walking up to the
// nearest `.git`. Deliberately not a hardcoded ancestor count (`../../../..`): the same
// module is loaded from `~/catalyst/plugin-source`, from a dev clone, and from a linked
// worktree, and only the walk gets all three right. A linked worktree's `.git` is a FILE,
// so `exists` (not a directory check) is the right probe — a worktree IS a checkout that
// executes code, and answering with the primary instead would measure the wrong tree.
//
// Uncached on purpose: the walk is a handful of stat calls, and a cache shared across an
// injected and a real `exists` is a footgun that buys nothing in a one-shot process.
function defaultSelfRoot(exists) {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (exists(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null; // reached the filesystem root
    dir = parent;
  }
}

/**
 * resolveExecutingRoots — every checkout this host actually executes code from, from four
 * DECLARED sources, in order:
 *
 *   1. registry `repoRoots`  — `<CATALYST_DIR>/execution-core/registry.json`, the enrolled
 *                              projects the daemon dispatches into
 *   2. this checkout         — the tree this module was loaded from
 *   3. Layer-2 `catalyst.checkouts[]` — machine-local declarations (siblings a given host
 *                              keeps current but is not enrolled to dispatch into)
 *   4. `<CATALYST_DIR>/plugin-source` — the tree every daemon on a worker node runs FROM,
 *                              which is frequently NOT any of the above (this is the whole
 *                              of CTL-1825: on the laptop it was 24 commits behind while
 *                              the agent's own checkout was current)
 *
 * Still an allowlist, never a filesystem walk — see resolveAllowlist. Every input is
 * injectable so the enumeration is testable without a registry, a config file, or a repo.
 *
 * `requireExists` (default true) drops a root that is not on this host: a registry copied
 * between hosts routinely names a repoRoot that exists on neither (CTL-854), and measuring
 * it costs a git timeout to learn nothing. Set false to inspect the undiluted enumeration.
 */
export function resolveExecutingRoots({
  env = process.env,
  readJson = defaultReadJson,
  // `exists` is destructured BEFORE `selfRoot` so the default below can thread it —
  // default parameters evaluate left to right, and the other order is a TDZ error.
  exists = existsSync,
  // undefined ⇒ resolve the real one; an explicit null ⇒ this host contributes none.
  selfRoot = defaultSelfRoot(exists),
  requireExists = true,
} = {}) {
  // Total against every source: a throwing reader (EACCES, a mocked failure) must cost
  // that ONE source, never the whole set.
  const read = (path) => {
    try {
      return readJson(path);
    } catch {
      return null;
    }
  };

  const home = typeof env?.HOME === "string" && env.HOME ? env.HOME : homedir();
  const catalystDir = typeof env?.CATALYST_DIR === "string" && env.CATALYST_DIR ? env.CATALYST_DIR : join(home, "catalyst");

  // 1. The registry, read straight from disk rather than through registry.mjs — that
  // module imports execution-core/config.mjs (and its bun:sqlite graph), which the bare-node
  // consumers of this enumeration cannot load. Same file, same shape, same key.
  const registry = read(join(catalystDir, "execution-core", "registry.json"));
  const registryRoots = Array.isArray(registry?.projects)
    ? registry.projects.map((p) => p?.repoRoot).filter((r) => typeof r === "string")
    : [];

  // 3. Layer-2 `catalyst.checkouts[]`. A non-array value is IGNORED, not coerced: spreading
  // a bare string would enrol one root per character.
  const layer2 = read(resolveLayer2Path(env));
  const declared = (layer2?.catalyst ?? layer2)?.checkouts;
  const configuredRoots = Array.isArray(declared) ? declared.filter((r) => typeof r === "string") : [];

  // 4. plugin-source, always last so an explicit declaration of the same path keeps its
  // earlier position (resolveAllowlist is order-stable and first-wins).
  configuredRoots.push(join(catalystDir, "plugin-source"));

  const roots = resolveAllowlist({ registryRoots, selfRoot, configuredRoots });
  return requireExists ? roots.filter((r) => exists(r)) : roots;
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
  // `observe` may legitimately return null for a broken checkout, so nothing below may
  // dereference it unguarded: a throw here is caught by runPass and recorded as the
  // TRANSIENT `fetch-failed` class, which by design never escalates — exactly inverting the
  // meaning of a broken pointer, which never fixes itself (Codex #3316 P2).
  const obs = await observe(root, branch);
  base.unreachable_commits = Number(await unreachableCount(root)) || 0;
  const refusal = classifyGitState({ ...(obs ?? {}), defaultBranch: branch });
  base.behind_by = Number(await behindCount(root, branch)) || 0;
  if (refusal) return { ...base, refused_reason: refusal, detail: obs?.detail ?? null };

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
