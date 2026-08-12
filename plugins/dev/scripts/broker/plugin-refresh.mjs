// plugin-refresh.mjs — refresh every node's pluginDirs checkout on merge-to-main
// (CTL-993).
//
// CTL-941 keeps headless plugin checkouts fresh via a PERIODIC ff-only
// auto-pull. We iterate many times a day; waiting on the poll interval (or the
// daily release-please version bump, or a manual `catalyst-stack hotpatch`)
// delays feedback on every fix. GitHub webhooks already flow into the unified
// event log via the webhook receiver + broker — the merge signal exists, and
// this module is the consumer that turns it into an instant checkout pull.
//
// The broker tails the event log; when a GitHub push/merge event for the
// configured repo@main arrives, the router calls handlePluginRefreshEvent,
// which:
//   1. resolves the pluginDirs checkout root(s)  (parity with lib/plugin-dirs.sh)
//   2. throttles to at most one fetch+reset per N seconds per root
//   3. runs `git fetch --no-tags origin main && git reset --hard origin/main`
//      in each clean root. CAT-167 refuses to reset over tracked working-tree
//      changes; CTL-1106's unconditional behavior remains available via mode=off.
//   4. emits plugin.checkout.updated (new HEAD sha + daemon-skew restart_needed)
//      on success, or plugin.checkout.refresh_failed (WARN) on a genuine
//      network/auth failure — never failing silently.
//
// RESOLUTION-PARITY CONTRACT — keep in sync with the other two resolvers:
//   - lib/plugin-dirs.sh:56            resolve_plugin_dirs (catalyst-stack / setup)
//   - phase-agent-dispatch:891         --plugin-dir flag builder (workers)
// We re-implement the same env → repo-config → machine-config precedence and the
// same string-or-`:`-array pluginDirs parse IN JS here (pure file reads), rather
// than sourcing bash from a long-lived daemon. The broker stays no-shell-out
// except the single `git` invocation, which goes through the injected gitFn seam.
//
// All OS/git/config/clock interactions are injected seams (gitFn, gitToplevelFn,
// readFileFn, emitFn, now, env) so the decision core and lifecycle are
// deterministically testable without real load, timers, network, or a checkout.
// Mirrors the gc-liveness.mjs / autotune.mjs seam-injection convention.

import { readFileSync, existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { getEventName } from "./event-name.mjs"; // CTL-1348: leaf, not the heavy router
import { staleLockStatus, indexLockPath, STALE_LOCK_THRESHOLD_MS } from "../lib/stale-lock.mjs"; // CTL-1415

// Throttle window: at most one pull per N seconds per checkout root. A merge
// often arrives as both a github.pr.merged AND a github.push to main within the
// same second; the throttle collapses that pair into a single pull, and also
// caps a burst of rapid merges. 60s mirrors the catalyst-stack hotpatch cadence
// expectation while still delivering "within seconds" freshness.
export const PLUGIN_REFRESH_THROTTLE_MS = 60_000;

// root → last-fetch epoch ms. Module-level so the throttle survives across
// events within one daemon lifetime. Cleared between tests via the seam below.
// Name kept as _lastPullByRoot to avoid barrel-contract churn (CTL-1106).
const _lastPullByRoot = new Map();

export function __clearThrottleForTest() {
  _lastPullByRoot.clear();
}

// CTL-1106: consecutive genuine-failure count per root + one-shot lag guard.
// A dirty tree is no longer a failure (Phase 1); these count only fetch/reset
// failures (network/auth) that leave the checkout behind origin/main.
export const CHECKOUT_LAG_FAILURE_THRESHOLD =
  Number(process.env.CATALYST_CHECKOUT_LAG_FAILURE_THRESHOLD) || 2;

const _failuresByRoot = new Map(); // root → { count, since }
const _lagEmittedByRoot = new Set(); // root → already emitted this stall episode

// CTL-1348: detect-only drift grace. When pluginPullOwner=updater the broker's PERIODIC
// drift watcher runs the detect-only branch; the updater pulls on its own ~90s cadence, so
// a checkout can be transiently "behind origin/main" for the few seconds between a merge and
// the updater's next poll. Emitting plugin.checkout.drift on that transient state would cry
// wolf on healthy nodes (Codex P2). We only WARN once a checkout has stayed behind LONGER
// than this grace (i.e. the updater has actually missed its SLA), tracking first-behind per
// root. Default 180s (> the 90s updater poll); env-overridable.
const _driftSinceByRoot = new Map(); // root → epoch ms first seen behind (detect-only)
export const PLUGIN_DRIFT_GRACE_MS =
  Number(process.env.CATALYST_PLUGIN_DRIFT_GRACE_MS) || 180_000;

const VALID_DIRTY_GUARD_MODES = new Set(["off", "shadow", "enforce"]);

export function resolveDirtyGuardMode(env = process.env) {
  const raw = env.CATALYST_PLUGIN_DIRTY_GUARD;
  return VALID_DIRTY_GUARD_MODES.has(raw) ? raw : "enforce";
}

const _dirtySkipSinceByRoot = new Map();
const _dirtyStaleEmittedByRoot = new Set();
export const PLUGIN_DIRTY_SKIP_GRACE_MS =
  Number(process.env.CATALYST_PLUGIN_DIRTY_SKIP_GRACE_MS) || 1_800_000;
const DIRTY_ENTRY_SAMPLE = 10;

export function checkoutWorkingTreeDirty({ root, gitFn = defaultGitFn }) {
  let out;
  try {
    out = gitFn(root, ["status", "--porcelain", "--untracked-files=no"]);
  } catch (err) {
    return {
      dirty: true,
      reason: "status_failed",
      entries: [],
      entryCount: 0,
      error: err?.message ?? String(err),
    };
  }
  const lines = String(out ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    return { dirty: false, reason: null, entries: [], entryCount: 0 };
  }
  const paths = lines.map((line) => {
    const path = line.slice(2).trim();
    const arrow = path.indexOf(" -> ");
    return arrow === -1 ? path : path.slice(arrow + 4);
  });
  return {
    dirty: true,
    reason: "tracked_changes",
    entries: paths.slice(0, DIRTY_ENTRY_SAMPLE),
    entryCount: paths.length,
  };
}

export function __clearLagStateForTest() {
  _failuresByRoot.clear();
  _lagEmittedByRoot.clear();
  _driftSinceByRoot.clear();
  _dirtySkipSinceByRoot.clear();
  _dirtyStaleEmittedByRoot.clear();
}

function _clearLagState(root) {
  _failuresByRoot.delete(root);
  _lagEmittedByRoot.delete(root);
  _driftSinceByRoot.delete(root);
  _dirtySkipSinceByRoot.delete(root);
  _dirtyStaleEmittedByRoot.delete(root);
}

// --- default seams (production wiring) ---------------------------------------

// GIT_TIMEOUT_MS — hard ceiling on every synchronous git call. The broker's
// event loop runs these inline (execFileSync); a network-stalled `fetch` with
// no timeout would freeze the ENTIRE broker — the same daemon-wedging class
// CTL-990 fixed in dispatch.mjs. A killed fetch throws and surfaces as
// refresh_failed; the next merge event retries after the throttle window.
const GIT_TIMEOUT_MS = Number(process.env.CATALYST_PLUGIN_REFRESH_GIT_TIMEOUT_MS) || 20_000;

// defaultGitFn — run a git subcommand in `root` and return trimmed stdout.
// GIT_TERMINAL_PROMPT=0 so an auth-required fetch fails fast instead of hanging
// a daemon with no tty/ssh-agent. Throws on non-zero exit (execFileSync), which
// the pull path catches and surfaces as refresh_failed.
function defaultGitFn(root, args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    killSignal: "SIGKILL",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

// defaultRmFn — remove a path, tolerating a concurrent removal (force). Used only
// to clear a stale git index.lock (CTL-1415); seam-injected for tests.
function defaultRmFn(path) {
  rmSync(path, { force: true });
}

/**
 * clearStaleIndexLock — CTL-1415: age-gated removal of a crashed-op leftover
 * `.git/index.lock` before a pull, so a stale lock can't silently freeze the
 * checkout's `git reset --hard` for hours (the ~8.5h laptop freeze in CTL-1401).
 *
 * Removes ONLY when staleLockStatus reports the lock is older than the safe
 * threshold, so an in-flight git op's lock is never disturbed. On removal, emits
 * plugin.checkout.stale_lock_cleared (WARN — clearing means a git op had crashed,
 * worth a signal). NEVER throws: a removal failure emits
 * plugin.checkout.stale_lock_clear_failed (WARN) and the caller proceeds to the
 * git op anyway (which then fails loudly via refresh_failed rather than this
 * masking it).
 *
 * Codex P1 (#2530): two overlapping cleanup attempts could both classify the SAME
 * old lock as stale; the first removes it and starts git (creating a fresh
 * index.lock), then the second — still acting on its earlier classification —
 * would unlink that brand-new live lock, defeating git's mutual exclusion. Right
 * before removing, we re-run staleLockStatus and bail (no-op) if the lock is no
 * longer present-and-stale at that instant — this narrows the race window to the
 * single re-check rather than the whole caller's prior work, and a second
 * concurrent attempt that loses the race simply leaves the winner's fresh lock
 * alone instead of destroying it.
 *
 * @returns {{present, ageMs, stale, cleared:boolean, error?:string}}
 */
export function clearStaleIndexLock({
  root,
  now = Date.now(),
  emitFn,
  statFn,
  rmFn = defaultRmFn,
  thresholdMs = STALE_LOCK_THRESHOLD_MS,
}) {
  const status = staleLockStatus({ root, now, thresholdMs, statFn });
  if (!status.present || !status.stale) return { ...status, cleared: false };
  // Re-verify immediately before removing (see Codex P1 note above). Reuses the
  // same `now` as the classification above — what matters is a fresh statFn
  // read of the lock's mtime, not wall-clock drift between the two calls (this
  // whole function runs synchronously), and reusing `now` keeps the recheck
  // seam-injectable/deterministic for tests instead of reaching for a real clock.
  const recheck = staleLockStatus({ root, now, thresholdMs, statFn });
  if (!recheck.present || !recheck.stale) return { ...status, cleared: false };
  try {
    rmFn(indexLockPath(root));
    emitFn?.({
      event: "plugin.checkout.stale_lock_cleared",
      orchestrator: null,
      worker: null,
      severity: "WARN",
      detail: { checkout: root, lock_age_ms: status.ageMs, threshold_ms: thresholdMs },
    });
    return { ...status, cleared: true };
  } catch (err) {
    emitFn?.({
      event: "plugin.checkout.stale_lock_clear_failed",
      orchestrator: null,
      worker: null,
      severity: "WARN",
      detail: { checkout: root, lock_age_ms: status.ageMs, error: err?.message ?? String(err) },
    });
    return { ...status, cleared: false, error: err?.message ?? String(err) };
  }
}

// Dep install can take longer than a git op (lockfile resolution); generous ceiling.
const BUN_INSTALL_TIMEOUT_MS =
  Number(process.env.CATALYST_PLUGIN_REFRESH_BUN_TIMEOUT_MS) || 180_000;

// defaultBunInstallFn — run `bun install` in a package dir. Frozen first (the
// checkout was just reset to origin/main, so the lockfile is authoritative);
// fall back to a plain install if frozen rejects. Throws on non-zero exit, which
// the caller catches and surfaces as deps_install_failed (non-fatal).
function defaultBunInstallFn(pkgDir) {
  try {
    execFileSync("bun", ["install", "--frozen-lockfile"], {
      cwd: pkgDir, encoding: "utf8", timeout: BUN_INSTALL_TIMEOUT_MS,
      killSignal: "SIGKILL", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  } catch {
    execFileSync("bun", ["install"], {
      cwd: pkgDir, encoding: "utf8", timeout: BUN_INSTALL_TIMEOUT_MS,
      killSignal: "SIGKILL", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  }
}

// Files whose change means deps may need (re)installing in their containing dir.
const DEP_MANIFEST_RE = /(^|\/)(package\.json|bun\.lock)$/;

// changedPackageDirs — pure helper: map a `git diff --name-only` output to
// unique absolute package dirs that need `bun install`. Exported for direct
// unit testing (no I/O — path/dedup logic only).
export function changedPackageDirs(root, diffOutput) {
  const dirs = new Set();
  for (const line of String(diffOutput || "").split("\n")) {
    const rel = line.trim();
    if (!rel || !DEP_MANIFEST_RE.test(rel)) continue;
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ".";
    dirs.add(dir === "." ? root : resolve(root, dir));
  }
  return [...dirs];
}

// workspaceMemberNodeModules — pure helper: when `root` is a bun WORKSPACE root
// (root package.json has `workspaces` and the root bun.lock is authoritative),
// return each member's node_modules dir that exists and is not standalone-managed
// (member has no bun.lock of its own). Exported for direct unit testing.
//
// WHY (CTL-1628 follow-up): the workspace conversion moved dep resolution to the
// ROOT lockfile, but nodes migrated in place kept the node_modules the OLD
// per-package flow had installed inside each member. Module resolution walks UP,
// so that debris SHADOWS every root install forever: on the fleet this pinned the
// running cloud-sync daemon to @catalyst-cloud/sdk 0.8.0 (no CTC-328 stale-frame
// guard) while the root lock said 0.8.1 and every refresh "succeeded".
//
// Callers prune these dirs immediately BEFORE a root install — never on a bare
// tick. That placement is the safety argument: bun legitimately creates nested
// member node_modules for version conflicts, and no cheap signature separates
// those from pre-workspace debris (verified: the fleet's stale trees carry no
// .bun store either). Pruning only when an install follows makes a false
// positive harmless — `bun install` recreates any nest it actually needs — and
// costs nothing on ticks where no manifest changed.
//
// Glob workspace entries ("packages/*") are SKIPPED, not expanded: this repo
// lists members literally, and silently expanding globs here would turn a new
// pattern entry into a surprise rm -rf fan-out. A skipped glob is surfaced by
// the caller's event detail, not swallowed.
export function workspaceMemberNodeModules(root, { readFileFn = readFileSync, existsFn = existsSync } = {}) {
  let manifest;
  try {
    manifest = JSON.parse(readFileFn(resolve(root, "package.json"), "utf8"));
  } catch {
    return [];
  }
  const entries = Array.isArray(manifest?.workspaces) ? manifest.workspaces : [];
  if (entries.length === 0) return [];
  if (!existsFn(resolve(root, "bun.lock"))) return []; // no authoritative root lock → not ours to prune
  const out = [];
  for (const entry of entries) {
    if (typeof entry !== "string" || entry === "" || entry.includes("*")) continue;
    const memberDir = resolve(root, entry);
    if (!existsFn(join(memberDir, "package.json"))) continue;
    if (existsFn(join(memberDir, "bun.lock"))) continue; // standalone-managed member — not workspace debris
    const nm = join(memberDir, "node_modules");
    if (existsFn(nm)) out.push(nm);
  }
  return out;
}

// defaultPruneFn — remove one member node_modules dir. Injectable for tests.
function defaultPruneFn(dir) {
  rmSync(dir, { recursive: true, force: true });
}

// defaultGitToplevelFn — map a pluginDirs entry (<checkout>/plugins/dev) to its
// git toplevel checkout root, or null when it is not inside a git checkout.
function defaultGitToplevelFn(pluginDir) {
  try {
    return execFileSync("git", ["-C", pluginDir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      killSignal: "SIGKILL",
    }).trim();
  } catch {
    return null;
  }
}

function defaultMachineConfigPath() {
  const xdg = process.env.XDG_CONFIG_HOME || `${homedir()}/.config`;
  return resolve(process.env.CATALYST_MACHINE_CONFIG || `${xdg}/catalyst/config.json`);
}

// --- config parsing ----------------------------------------------------------

// __pluginDirsFromFile — extract pluginDirs from one config file. Same
// string-or-array tolerance as lib/plugin-dirs.sh::__plugin_dirs_from_file and
// phase-agent-dispatch:891. Returns "" when the file is absent/unparseable or
// the key is unset.
function __pluginDirsFromFile(path, readFileFn) {
  if (!path) return "";
  let raw;
  try {
    raw = readFileFn(path);
  } catch {
    return "";
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    return "";
  }
  const v = cfg?.catalyst?.orchestration?.pluginDirs;
  if (Array.isArray(v)) return v.join(":");
  if (typeof v === "string") return v;
  return "";
}

/**
 * resolvePluginCheckoutRoots — JS mirror of lib/plugin-dirs.sh::resolve_plugin_dirs.
 *
 * Precedence: CATALYST_PLUGIN_DIRS env → repo .catalyst/config.json →
 * machine config. pluginDirs may be a string or array (joined with ":") in
 * either config file. Each `:`-separated entry points at <checkout>/plugins/dev
 * and is mapped through gitToplevelFn to its checkout root; unresolvable entries
 * are dropped and the resulting roots are deduped (order-preserving).
 *
 * @returns {string[]} deduped checkout roots, [] when pluginDirs is unset.
 */
export function resolvePluginCheckoutRoots({
  env = process.env,
  machineConfigPath = defaultMachineConfigPath(),
  repoConfigPath = null,
  readFileFn = (p) => readFileSync(p, "utf8"),
  gitToplevelFn = defaultGitToplevelFn,
} = {}) {
  let value = "";
  if (env.CATALYST_PLUGIN_DIRS) {
    value = env.CATALYST_PLUGIN_DIRS;
  } else {
    value = __pluginDirsFromFile(repoConfigPath, readFileFn);
    if (!value) value = __pluginDirsFromFile(machineConfigPath, readFileFn);
  }
  if (!value) return [];

  const roots = [];
  const seen = new Set();
  for (const entry of value.split(":")) {
    const pd = entry.trim();
    if (!pd) continue;
    const root = gitToplevelFn(pd);
    if (!root) continue;
    if (seen.has(root)) continue;
    seen.add(root);
    roots.push(root);
  }
  return roots;
}

// __readConfig — parse one config file through the readFileFn seam, tolerant of
// absent/unparseable files (returns {}).
function __readConfig(path, readFileFn) {
  if (!path) return {};
  try {
    return JSON.parse(readFileFn(path)) ?? {};
  } catch {
    return {};
  }
}

/**
 * resolveRepoFullName — the "owner/repo" whose merges trigger a checkout
 * refresh.
 *
 * Precedence (per config file, repo config before machine config):
 *   1. canonical catalyst.repository.{org,name} — the schema key
 *      check-project-setup tells operators to set (joined as "org/name", both
 *      must be non-empty strings)
 *   2. legacy catalyst.feedback.githubRepo
 *   3. legacy first catalyst.monitor.linear.teams[].vcsRepo
 *
 * Returns null when unconfigured. Reading the canonical key FIRST is CTL-1014:
 * without it, hosts configured canonically resolve null here and
 * isThisRepoMergeEvent rejects every merge, so the CTL-993 merge-to-main
 * auto-pull never fires (verified live on mini 2026-06-11). A malformed
 * canonical block (missing/empty/non-string org or name) falls through to the
 * legacy keys unchanged.
 */
export function resolveRepoFullName({
  machineConfigPath = defaultMachineConfigPath(),
  repoConfigPath = null,
  readFileFn = (p) => readFileSync(p, "utf8"),
} = {}) {
  for (const path of [repoConfigPath, machineConfigPath]) {
    const cfg = __readConfig(path, readFileFn);
    const repo = cfg?.catalyst?.repository;
    const org = repo?.org;
    const name = repo?.name;
    if (typeof org === "string" && org && typeof name === "string" && name) {
      return `${org}/${name}`;
    }
    const fromFeedback = cfg?.catalyst?.feedback?.githubRepo;
    if (typeof fromFeedback === "string" && fromFeedback) return fromFeedback;
    const teams = cfg?.catalyst?.monitor?.linear?.teams;
    if (Array.isArray(teams)) {
      const hit = teams.find((t) => typeof t?.vcsRepo === "string" && t.vcsRepo);
      if (hit) return hit.vcsRepo;
    }
  }
  return null;
}

// --- merge-event matcher -----------------------------------------------------

// Periodic drift-check backstop (CTL-1161). Covers merges that arrive with
// neither a github webhook NOR a phase.monitor-merge.complete signal (manual /
// out-of-pipeline merges), and any sustained lag. Longer than the 60 s throttle
// so a tick landing right after an event-driven pull is a cheap no-op.
export const PLUGIN_DRIFT_CHECK_INTERVAL_MS =
  Number(process.env.CATALYST_PLUGIN_DRIFT_CHECK_INTERVAL_MS) || 300_000;

// Read the repo identity from an event shape-agnostically: canonical envelopes
// carry it at attributes["vcs.repository.name"], legacy flat events at
// scope.repo (mirrors how router.summarizeEvent resolves repo).
function eventRepo(event) {
  return event.attributes?.["vcs.repository.name"] ?? event.scope?.repo ?? null;
}

// Resolve the pushed ref name from canonical (attributes["vcs.ref.name"]) or
// legacy (scope.ref, which is the full refs/heads/<branch>) shape.
function eventRefBranch(event) {
  const ref = event.attributes?.["vcs.ref.name"] ?? event.scope?.ref ?? "";
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

/**
 * isThisRepoMergeEvent — true when the event is a merge of new code into main
 * of the configured repo: github.pr.merged OR github.push to main, AND the
 * event's repository matches repoFullName. Returns false when repoFullName is
 * unconfigured (no identity to match → never refresh on an unknown repo).
 */
export function isThisRepoMergeEvent(event, { repoFullName } = {}) {
  if (!repoFullName) return false;
  if (eventRepo(event) !== repoFullName) return false;
  const name = getEventName(event);
  if (name === "github.pr.merged") return true;
  if (name === "github.push") return eventRefBranch(event) === "main";
  return false;
}

// Daemon-local merge signal: phase.monitor-merge.complete.<TICKET> is emitted
// into THIS daemon's event log by every pipeline merge (phase-agent-emit-complete),
// independently of GitHub webhook delivery. It carries no vcs.repository.name —
// by construction every such event in this log is for this daemon's repo — so we
// match on event name only and do NOT repo-match. Second, webhook-independent
// trigger for CTL-1161 (the github.push/github.pr.merged path can be missed).
// Ticket suffix must match: [A-Za-z][A-Za-z0-9_]*-\d+ (parity with router.mjs PHASE_EVENT_PATTERN).
const MONITOR_MERGE_COMPLETE_RE = /^phase\.monitor-merge\.complete\.[A-Za-z][A-Za-z0-9_]*-\d+$/;
export function isDaemonLocalMergeSignal(event) {
  return MONITOR_MERGE_COMPLETE_RE.test(getEventName(event) ?? "");
}

// --- plugin-pull ownership (CTL-1348) ----------------------------------------

/**
 * resolvePluginPullOwner — which process owns the plugin PULL on this node:
 * "broker" (today's default) or "updater" (the standalone catalyst-updater agent).
 * The broker DEFERS the actual `reset --hard` pull to the updater ONLY when this
 * resolves to exactly "updater"; ANY other outcome — env/config absent, unreadable,
 * malformed, or any other string — returns "broker" so the broker keeps pulling.
 *
 * FAIL-SAFE BY CONSTRUCTION: the cutover is inert until install-services explicitly
 * writes "updater" into the machine-local config. Read precedence env →
 * machine-local config (a per-NODE deployment fact, so NOT the committed repo config),
 * default "broker". Read FRESH on each broker tick (never cached) so a running broker
 * honors a live cutover (or a revert to "broker") without a restart. Never throws.
 *
 * @param {object} [opts]
 * @param {Record<string,string|undefined>} [opts.env]
 * @param {string} [opts.machineConfigPath]  ~/.config/catalyst/config.json
 * @param {Function} [opts.readFileFn]
 * @returns {"broker"|"updater"}
 */
export function resolvePluginPullOwner({
  env = process.env,
  machineConfigPath,
  readFileFn = readFileSync,
} = {}) {
  const coerce = (v) => (typeof v === "string" && v.trim() === "updater" ? "updater" : "broker");
  const fromEnv = env.CATALYST_PLUGIN_PULL_OWNER;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return coerce(fromEnv);
  if (machineConfigPath) {
    try {
      const v = JSON.parse(readFileFn(machineConfigPath, "utf8"))?.catalyst?.orchestration?.pluginPullOwner;
      if (typeof v === "string" && v.trim().length > 0) return coerce(v);
    } catch {
      /* unreadable/malformed machine config → fail safe to broker */
    }
  }
  return "broker";
}

// --- refresh ----------------------------------------------------------------

/**
 * refreshPluginCheckout — throttle-gated fetch+reset of a single checkout root.
 *
 * Runs `git fetch --no-tags origin main` then `git reset --hard origin/main`
 * (self-healing: clone is disposable per CTL-992) after CAT-167's tracked-dirt
 * guard permits the destructive operation. On success, emits
 * plugin.checkout.updated with old/new sha and a restart_needed flag (daemon
 * skew is VISIBLE, not auto-restarted). On a genuine fetch/reset failure
 * (network/auth), emits plugin.checkout.refresh_failed at WARN.
 *
 * Returns a result descriptor: { pulled, throttled, changed, failed, skipped }.
 */
export function refreshPluginCheckout({
  root,
  now = Date.now(),
  gitFn = defaultGitFn,
  bunInstallFn = defaultBunInstallFn,
  // CTL-1628 follow-up seams: stale-member-node_modules pruning ahead of a root
  // install (see workspaceMemberNodeModules for why). Injectable for tests.
  memberNodeModulesFn = workspaceMemberNodeModules,
  pruneFn = defaultPruneFn,
  emitFn,
  loadedCommit = null,
  loadedCommitRoot = null,
  // CTL-1348: pull-owner cutover seam. Default true preserves today's behavior for
  // every existing caller. pull:false = detect-only — the broker DEFERS the pull to
  // the standalone catalyst-updater agent (pluginPullOwner=updater) but keeps drift
  // observability: it fetches + compares HEAD vs origin/main but NEVER reset --hard /
  // bun install, NEVER touches the throttle slot or the lag/failure state machine, and
  // ALWAYS returns changed:false so decideStackReload (stack-reload.mjs) stays a no-op
  // (a behind checkout the broker never pulled must not trigger a stack restart loop).
  pull = true,
  env = process.env,
  // CTL-1415: seams for the pre-pull stale-index.lock age-gate. Undefined statFn
  // falls through to staleLockStatus's real statSync default in production.
  statFn = undefined,
  rmFn = defaultRmFn,
}) {
  if (!root) return { pulled: false, throttled: false, changed: false, failed: false, skipped: null, root, oldSha: null, newSha: null, restartNeeded: false };

  const last = _lastPullByRoot.get(root);
  if (last !== undefined && now - last < PLUGIN_REFRESH_THROTTLE_MS) {
    return { pulled: false, throttled: true, changed: false, failed: false, skipped: null, root, oldSha: null, newSha: null, restartNeeded: false };
  }

  // CTL-1348 detect-only: placed BEFORE the throttle reservation so it neither
  // consumes nor writes throttle state (a detect-only tick must never block a later
  // real pull within the 60 s window), and it does not enter the reset/lag path below.
  if (pull === false) {
    let headSha = null;
    let originSha = null;
    try {
      headSha = gitFn(root, ["rev-parse", "HEAD"]);
      gitFn(root, ["fetch", "--no-tags", "origin", "main"]);
      originSha = gitFn(root, ["rev-parse", "origin/main"]);
    } catch (err) {
      // Observability-only: a detect-only fetch failure does NOT advance the lag
      // state machine (the broker no longer owns pulling this checkout; the updater does).
      return { pulled: false, throttled: false, changed: false, failed: true, skipped: null, root, oldSha: headSha, newSha: null, restartNeeded: false };
    }
    if (headSha && originSha && headSha !== originSha) {
      // The checkout is behind and the broker is NOT pulling it. Only WARN once it has been
      // behind LONGER than the grace window — within it, the updater is expected to catch up
      // on its own poll, so staying silent avoids false drift alerts on healthy nodes.
      const since = _driftSinceByRoot.get(root) ?? now;
      if (!_driftSinceByRoot.has(root)) _driftSinceByRoot.set(root, now);
      if (now - since >= PLUGIN_DRIFT_GRACE_MS) {
        // Past grace — the updater has missed its SLA (fallen behind or died). Surface drift.
        emitFn({
          event: "plugin.checkout.drift",
          orchestrator: null,
          worker: null,
          severity: "WARN",
          detail: { checkout: root, head_sha: headSha, origin_sha: originSha, behind: true, behind_since: since },
        });
      }
      return { pulled: false, throttled: false, changed: false, failed: false, skipped: null, root, oldSha: headSha, newSha: originSha, restartNeeded: false };
    }
    // Up to date — clear any prior real-pull stall episode AND the drift-grace tracker.
    _clearLagState(root);
    return { pulled: false, throttled: false, changed: false, failed: false, skipped: null, root, oldSha: headSha, newSha: originSha, restartNeeded: false };
  }

  const dirtyMode = resolveDirtyGuardMode(env);
  if (dirtyMode !== "off") {
    const dirt = checkoutWorkingTreeDirty({ root, gitFn });
    if (dirt.dirty) {
      const since = _dirtySkipSinceByRoot.get(root) ?? now;
      if (!_dirtySkipSinceByRoot.has(root)) _dirtySkipSinceByRoot.set(root, now);
      const detail = {
        checkout: root,
        reason: dirt.reason,
        entries: dirt.entries,
        entry_count: dirt.entryCount,
        error: dirt.error ?? null,
      };
      if (dirtyMode === "shadow") {
        emitFn({ event: "plugin.checkout.would_skip_dirty", orchestrator: null, worker: null, severity: "WARN", detail });
      } else {
        emitFn({
          event: "plugin.checkout.dirty_skipped",
          orchestrator: null,
          worker: null,
          severity: "WARN",
          detail: { ...detail, blocked_since: since },
        });
        if (now - since >= PLUGIN_DIRTY_SKIP_GRACE_MS && !_dirtyStaleEmittedByRoot.has(root)) {
          _dirtyStaleEmittedByRoot.add(root);
          emitFn({
            event: "plugin.checkout.dirty_stale",
            orchestrator: null,
            worker: null,
            severity: "ERROR",
            detail: { ...detail, blocked_since: since, blocked_ms: now - since, grace_ms: PLUGIN_DIRTY_SKIP_GRACE_MS },
          });
        }
        return { pulled: false, throttled: false, changed: false, failed: false, skipped: "dirty", root, oldSha: null, newSha: null, restartNeeded: false };
      }
    }
  }

  // Reserve the slot BEFORE the (possibly slow) pull so a duplicate event that
  // arrives mid-pull is throttled rather than launching a second git process.
  _lastPullByRoot.set(root, now);

  let oldSha = null;
  try {
    oldSha = gitFn(root, ["rev-parse", "HEAD"]);
  } catch {
    oldSha = null;
  }

  // CTL-1415: clear a stale (crashed-op) index.lock BEFORE the reset --hard it
  // would otherwise block on forever. Age-gated, so a live git op is untouched;
  // never throws, so a clear failure surfaces as its own WARN and we still
  // attempt the pull (which then fails loudly rather than being masked).
  clearStaleIndexLock({ root, now, emitFn, statFn, rmFn });

  try {
    gitFn(root, ["fetch", "--no-tags", "origin", "main"]);
    gitFn(root, ["reset", "--hard", "origin/main"]);
  } catch (err) {
    emitFn({
      event: "plugin.checkout.refresh_failed",
      orchestrator: null,
      worker: null,
      severity: "WARN",
      detail: {
        checkout: root,
        old_sha: oldSha,
        error: err?.message ?? String(err),
      },
    });
    const prior = _failuresByRoot.get(root) ?? { count: 0, since: now };
    const next = { count: prior.count + 1, since: prior.count === 0 ? now : prior.since };
    _failuresByRoot.set(root, next);
    if (next.count >= CHECKOUT_LAG_FAILURE_THRESHOLD && !_lagEmittedByRoot.has(root)) {
      _lagEmittedByRoot.add(root);
      emitFn({
        event: "plugin.checkout.lag",
        orchestrator: null,
        worker: null,
        severity: "ERROR",
        detail: {
          checkout: root,
          old_sha: oldSha,
          consecutive_failures: next.count,
          behind_since: next.since,
          error: err?.message ?? String(err),
        },
      });
    }
    return { pulled: false, throttled: false, changed: false, failed: true, skipped: null, root, oldSha, newSha: null, restartNeeded: false };
  }

  let newSha = null;
  try {
    newSha = gitFn(root, ["rev-parse", "HEAD"]);
  } catch {
    newSha = null;
  }

  // HEAD did not advance — nothing changed, stay quiet (no event noise).
  if (oldSha && newSha && oldSha === newSha) {
    _clearLagState(root);
    return { pulled: true, throttled: false, changed: false, failed: false, skipped: null, root, oldSha, newSha, restartNeeded: false };
  }

  // Daemon skew: the checkout advanced, but the long-lived daemon still runs the
  // code it loaded at boot. Surface restart_needed so the operator/HUD can see
  // the skew (ties into the CTL-669 loadedCommit/restartNeeded model). Daemon
  // restart stays a gated OPERATOR action — never automated here.
  // restart_needed only fires for the checkout the daemon itself runs from
  // (loadedCommitRoot): a broker running from checkout A must not flag skew
  // because an unrelated pluginDirs checkout B advanced. A null loadedCommitRoot
  // (caller didn't resolve it) preserves the coarse loadedCommit comparison.
  const restartNeeded =
    loadedCommit != null &&
    newSha != null &&
    loadedCommit !== newSha &&
    (loadedCommitRoot == null || loadedCommitRoot === root);

  _clearLagState(root);

  // CTL-1223: diff the pulled range to find changed package.json/bun.lock dirs
  // and run `bun install` in each before emitting plugin.checkout.updated (which
  // triggers the monitor restart). Install failures are surfaced as WARN events
  // and never block the checkout-updated signal (reset already succeeded).
  const depsInstalled = [];
  const staleNodeModulesPruned = [];
  if (oldSha) {
    let diffOut = "";
    try { diffOut = gitFn(root, ["diff", "--name-only", oldSha, newSha]); } catch { diffOut = ""; }
    const pkgDirs = changedPackageDirs(root, diffOut);
    // CTL-1628 follow-up: an install is about to run and the root lockfile is
    // authoritative, so first clear any member node_modules that would SHADOW
    // it (pre-workspace debris; see workspaceMemberNodeModules). Prune failures
    // are non-fatal for the same reason install failures are — the reset
    // already succeeded — but they surface as WARN, never silently.
    if (pkgDirs.length > 0) {
      for (const nm of memberNodeModulesFn(root)) {
        try {
          pruneFn(nm);
          staleNodeModulesPruned.push(nm);
        } catch (err) {
          emitFn({
            event: "plugin.checkout.node_modules_prune_failed",
            orchestrator: null,
            worker: null,
            severity: "WARN",
            detail: { checkout: root, node_modules_dir: nm, error: err?.message ?? String(err) },
          });
        }
      }
    }
    for (const pkgDir of pkgDirs) {
      try {
        bunInstallFn(pkgDir);
        depsInstalled.push(pkgDir);
      } catch (err) {
        emitFn({
          event: "plugin.checkout.deps_install_failed",
          orchestrator: null,
          worker: null,
          severity: "WARN",
          detail: { checkout: root, package_dir: pkgDir, error: err?.message ?? String(err) },
        });
      }
    }
  }

  emitFn({
    event: "plugin.checkout.updated",
    orchestrator: null,
    worker: null,
    detail: {
      checkout: root,
      old_sha: oldSha,
      new_sha: newSha,
      loaded_commit: loadedCommit,
      restart_needed: restartNeeded,
      deps_installed: depsInstalled,
      stale_node_modules_pruned: staleNodeModulesPruned,
    },
  });
  return { pulled: true, throttled: false, changed: true, failed: false, skipped: null, root, oldSha, newSha, restartNeeded };
}

/**
 * handlePluginRefreshEvent — top-level wiring the router calls for every event.
 * No-op unless the event is a merge-to-main of the configured repo. Resolves
 * the pluginDirs checkout root(s) and refreshes each (throttle-gated). Pure
 * orchestration over the three units above — never throws (best-effort, the
 * routing path must not die on a refresh).
 */
export function handlePluginRefreshEvent({
  event,
  now = Date.now(),
  env = process.env,
  repoFullName,
  machineConfigPath,
  repoConfigPath = null,
  readFileFn,
  gitToplevelFn,
  gitFn,
  emitFn,
  loadedCommit = null,
  loadedCommitRoot = null,
  pull = true, // CTL-1348: pass pull:false from the event-driven path when owner=updater
}) {
  try {
    const isMerge =
      isThisRepoMergeEvent(event, { repoFullName }) || isDaemonLocalMergeSignal(event);
    if (!isMerge) return null;
    const roots = resolvePluginCheckoutRoots({
      env,
      machineConfigPath,
      repoConfigPath,
      readFileFn,
      gitToplevelFn,
    });
    const results = [];
    for (const root of roots) {
      results.push(refreshPluginCheckout({ root, now, gitFn, emitFn, loadedCommit, loadedCommitRoot, pull, env }));
    }
    return results;
  } catch {
    // Best-effort — a refresh failure must never break event routing. Genuine
    // pull failures are already surfaced as refresh_failed events above.
    return null;
  }
}

/**
 * refreshAllPluginCheckouts — timer-driven analogue of handlePluginRefreshEvent's
 * body, without the event gate. Resolves roots via resolvePluginCheckoutRoots and
 * calls refreshPluginCheckout per root. Used by the periodic drift-check backstop
 * (CTL-1161) to cover merges that arrive with neither a webhook nor a
 * phase.monitor-merge.complete signal (manual/out-of-pipeline merges).
 *
 * Best-effort: returns [] on any resolution failure (never throws).
 */
export function refreshAllPluginCheckouts({
  now = Date.now(),
  env = process.env,
  machineConfigPath,
  repoConfigPath = null,
  readFileFn,
  gitToplevelFn,
  gitFn,
  emitFn,
  loadedCommit = null,
  loadedCommitRoot = null,
  pull = true, // CTL-1348: pass pull:false from the broker drift-check when owner=updater
} = {}) {
  try {
    const roots = resolvePluginCheckoutRoots({
      env,
      machineConfigPath,
      repoConfigPath,
      readFileFn,
      gitToplevelFn,
    });
    const results = [];
    for (const root of roots) {
      results.push(refreshPluginCheckout({ root, now, gitFn, emitFn, loadedCommit, loadedCommitRoot, pull, env }));
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * startPluginDriftCheck — thin, seam-injected wrapper around setInterval,
 * mirroring startWatchdog (router.mjs:1780). Returns the timer handle so the
 * caller can clearInterval on shutdown.
 */
export function startPluginDriftCheck({
  intervalMs = PLUGIN_DRIFT_CHECK_INTERVAL_MS,
  tickFn,
  setIntervalFn = setInterval,
} = {}) {
  return setIntervalFn(tickFn, intervalMs);
}
