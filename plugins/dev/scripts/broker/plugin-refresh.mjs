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
//      in each root (self-healing: the clone is disposable per CTL-992, so
//      reset --hard is always safe regardless of working-tree dirt — CTL-1106)
//   4. runs `bun install` in each dir whose package.json/bun.lock moved, then
//      AUDITS whether the install actually relinked (CTL-1831 — a bun install
//      that skips a transitive-only resolution change still exits 0), forcing a
//      relink only on a proven mismatch
//   5. emits plugin.checkout.updated (new HEAD sha + daemon-skew restart_needed)
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

import { readFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { getEventName } from "../lib/event-name.mjs"; // CTL-1834: THE shared event-name boundary (still a leaf)
import { staleLockStatus, indexLockPath, STALE_LOCK_THRESHOLD_MS } from "../lib/stale-lock.mjs"; // CTL-1415
import { auditLockResolution } from "./lock-resolution-audit.mjs"; // CTL-1831

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

export function __clearLagStateForTest() {
  _failuresByRoot.clear();
  _lagEmittedByRoot.clear();
  _driftSinceByRoot.clear();
}

function _clearLagState(root) {
  _failuresByRoot.delete(root);
  _lagEmittedByRoot.delete(root);
  _driftSinceByRoot.delete(root);
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

/**
 * bunInstallArgv — the argv for one `bun install` variant. Extracted as a pure
 * helper (CTL-1831) so the flags themselves are assertable: the ONLY difference
 * between an install that relinks a transitive-only resolution change and one
 * that exits 0 having done nothing is `--force`, and that distinction had no
 * test anywhere.
 */
export function bunInstallArgv({ force = false, frozen = true } = {}) {
  if (force) return ["install", "--force"];
  return frozen ? ["install", "--frozen-lockfile"] : ["install"];
}

// defaultBunInstallFn — run `bun install` in a package dir. Frozen first (the
// checkout was just reset to origin/main, so the lockfile is authoritative);
// fall back to a plain install if frozen rejects. Throws on non-zero exit, which
// the caller catches and surfaces as deps_install_failed (non-fatal).
//
// CTL-1831: `force:true` is the RELINK variant, and it is deliberately NOT the
// default — measured, `--force` re-extracts 1168 packages (3-8 s) even when
// nothing changed, so paying it on every refresh is the wrong trade. The caller
// escalates to it only after the post-install resolution audit PROVES the tree
// on disk disagrees with the lockfile.
function defaultBunInstallFn(pkgDir, { force = false } = {}) {
  const run = (argv) =>
    execFileSync("bun", argv, {
      cwd: pkgDir, encoding: "utf8", timeout: BUN_INSTALL_TIMEOUT_MS,
      killSignal: "SIGKILL", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  if (force) {
    run(bunInstallArgv({ force: true }));
    return;
  }
  try {
    run(bunInstallArgv({ frozen: true }));
  } catch {
    run(bunInstallArgv({ frozen: false }));
  }
}

// Files whose change means deps may need (re)installing in their containing dir.
const DEP_MANIFEST_RE = /(^|\/)(package\.json|bun\.lock)$/;

// The lockfile alone — the subset of DEP_MANIFEST_RE whose change can move a
// RESOLUTION, and therefore the only one the CTL-1831 audit has anything to
// verify. A package.json-only change (a script rename, a field edit) resolves to
// the same versions, so auditing it would spend probes to prove nothing.
const LOCKFILE_RE = /(^|\/)bun\.lock$/;

/**
 * changedLockfiles — pure helper (CTL-1831): map a `git diff --name-only` output
 * to the bun.lock files the pulled range touched, each with the absolute dir
 * that owns it. Order-preserving and deduped. Exported for direct unit testing
 * (no I/O — path logic only).
 *
 * @returns {{rel:string, dir:string}[]}
 */
export function changedLockfiles(root, diffOutput) {
  const out = [];
  const seen = new Set();
  for (const line of String(diffOutput || "").split("\n")) {
    const rel = line.trim();
    if (!rel || !LOCKFILE_RE.test(rel)) continue;
    if (seen.has(rel)) continue;
    seen.add(rel);
    const dirRel = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ".";
    out.push({ rel, dir: dirRel === "." ? root : resolve(root, dirRel) });
  }
  return out;
}

/**
 * workspaceRootsFor — the directories the CTL-1831 audit may resolve FROM: the
 * lockfile's own dir plus each literal workspace member that has a package.json.
 *
 * The member dirs matter because bun's isolated linker gives the workspace root
 * no copy of a package it does not itself depend on (measured on this repo:
 * `require.resolve("@catalyst-cloud/schema")` from the root is MODULE_NOT_FOUND
 * while it resolves fine from execution-core), so a root-only site list would
 * report "no importer resolves it" for exactly the packages that matter.
 *
 * Glob entries ("packages/*") are SKIPPED, not expanded — same discipline as
 * workspaceMemberNodeModules. The fail direction is safe here: a skipped member
 * can only SHRINK the site set, and an entry with no reachable site is reported
 * INCONCLUSIVE, never clean.
 *
 * Each root carries its own package `name` when the manifest declares one,
 * because the audit's bare-key site selection has to shed exactly the member
 * root that owns a `<member>/<id>` nested key. This repo's bun.lock really has
 * three (`orch-monitor-ui/react`, `orch-monitor-ui/@types/react`,
 * `orch-monitor-ui/typescript`) and `plugins/dev/scripts/orch-monitor/ui` is a
 * literal member passed here as a root — so without the name, a version move on
 * `react` would read that member's legitimately-nested copy as a stale bare
 * resolution and force a needless re-extract. `name` is null when the manifest
 * is absent, unparseable, or nameless; the audit's fallback for a nameless root
 * is blunt but safe (it sheds the root rather than trusting it).
 *
 * @returns {{dir:string, name:string|null}[]}
 */
export function workspaceRootsFor(lockDir, { readFileFn = readFileSync, existsFn = existsSync } = {}) {
  const nameOf = (parsed) => (typeof parsed?.name === "string" && parsed.name ? parsed.name : null);
  const manifestAt = (dir) => {
    try {
      return JSON.parse(readFileFn(resolve(dir, "package.json"), "utf8"));
    } catch {
      return null; // absent/unreadable/malformed — no name, and no members
    }
  };
  // One read of the root manifest, used for BOTH its name and its members.
  const manifest = manifestAt(lockDir);
  const roots = [{ dir: lockDir, name: nameOf(manifest) }];
  if (manifest === null) return roots;
  const entries = Array.isArray(manifest?.workspaces) ? manifest.workspaces : [];
  for (const entry of entries) {
    if (typeof entry !== "string" || entry === "" || entry.includes("*")) continue;
    const memberDir = resolve(lockDir, entry);
    // Membership stays keyed on the package.json EXISTING, exactly as before —
    // a member whose manifest is present but unparseable is still a resolvable
    // dir, it just contributes no name.
    if (!existsFn(join(memberDir, "package.json"))) continue;
    roots.push({ dir: memberDir, name: nameOf(manifestAt(memberDir)) });
  }
  return roots;
}

/**
 * defaultResolvePackageFn — what `<id>` ACTUALLY resolves to when imported from
 * `fromDir`, as `{dir, version}` or null.
 *
 * Directory PLACEMENT read off the disk, not `createRequire().resolve()`. The
 * first cut of this probe used module resolution and was unusable for the exact
 * reason this whole module exists: **Node/bun module resolution is cached
 * PROCESS-WIDE, and a fresh `createRequire` does not clear that cache**. Measured
 * identically under node v25.8.2 and bun 1.3.5 (macOS 26.5, arm64), isolated-
 * linker layout, one process:
 *
 *     before:              symlink -> 0.1.5 | resolve -> 0.1.5
 *     after flip to 0.1.3: symlink -> 0.1.3 | resolve -> 0.1.5   <- STALE
 *
 * Held as a standing regression by the "THE DEFECT: a SECOND call in the SAME
 * process sees the relink" test in plugin-refresh.test.mjs.
 *
 * In the long-lived updater daemon (`updater.mjs`'s setInterval) and the broker
 * that consequence is total: the post-`--force` RE-audit answers from the cache
 * the pre-force audit populated, so a SUCCESSFUL relink reported
 * `deps_relink_failed` (an ERROR the docs describe as unfixable) and
 * `deps_relinked` was permanently `[]`; and once a process had audited one good
 * tree it reported CLEAN on a tree that had since gone stale — the detector
 * blind to its own incident. A question about BYTES ON DISK must be answered by
 * reading the disk.
 *
 * The walk is node's own `node_modules` ladder — `<dir>/node_modules/<id>`,
 * rising to the filesystem root — which is what makes it layout-agnostic: under
 * the hoisted linker the entry IS the package, under bun's isolated linker it is
 * a symlink into `.bun/<id>@<version>/`, and `readFileSync` follows either. (The
 * ladder is not pruned at a `node_modules` segment the way NODE_MODULES_PATHS
 * prunes it; the extra probe is a miss on a path that cannot exist, and every
 * directory the spec DOES visit is still visited, in the same order.)
 *
 * Version comes from the addressed `<id>/package.json` itself — no walking up to
 * an "owning" manifest, since the path already names the package — and `dir` is
 * realpath'd so a mismatch report names the store entry rather than the link.
 * A realpath failure keeps the literal path: the version is the verdict, and
 * losing the cosmetic path must not turn a real answer into a null (which the
 * audit reads as "could not look").
 *
 * @param {string} fromDir importer directory to resolve from
 * @param {string} id      package id, e.g. `@catalyst-cloud/schema`
 */
export function defaultResolvePackageFn(fromDir, id, { readFileFn = readFileSync, realpathFn = realpathSync } = {}) {
  if (typeof fromDir !== "string" || !fromDir) return null;
  if (typeof id !== "string" || !id) return null;
  let dir = resolve(fromDir);
  for (;;) {
    const candidate = join(dir, "node_modules", ...id.split("/"));
    let parsed = null;
    try {
      parsed = JSON.parse(readFileFn(join(candidate, "package.json"), "utf8"));
    } catch {
      parsed = null; // absent/unreadable/malformed here — keep climbing the ladder
    }
    if (parsed && typeof parsed.version === "string" && parsed.version) {
      let real = candidate;
      try {
        real = realpathFn(candidate);
      } catch {
        /* keep the literal path — the version is the verdict */
      }
      return { dir: real, version: parsed.version };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

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
 * (self-healing: clone is disposable per CTL-992; reset --hard is always safe
 * regardless of working-tree dirt — CTL-1106). On success, emits
 * plugin.checkout.updated with old/new sha and a restart_needed flag (daemon
 * skew is VISIBLE, not auto-restarted). On a genuine fetch/reset failure
 * (network/auth), emits plugin.checkout.refresh_failed at WARN.
 *
 * Returns a result descriptor: { pulled, throttled, changed, failed }.
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
  // CTL-1415: seams for the pre-pull stale-index.lock age-gate. Undefined statFn
  // falls through to staleLockStatus's real statSync default in production.
  statFn = undefined,
  rmFn = defaultRmFn,
  // CTL-1831 seams: the post-install "did the install actually RELINK?" audit.
  // All four are injectable so the wiring (signal → force → re-audit) is testable
  // without a real node_modules; the audit's own logic has direct unit coverage
  // in lock-resolution-audit.test.mjs.
  auditFn = auditLockResolution,
  workspaceRootsFn = workspaceRootsFor,
  resolvePackageFn = defaultResolvePackageFn,
  readFileFn = (p) => readFileSync(p, "utf8"),
}) {
  if (!root) return { pulled: false, throttled: false, changed: false, failed: false, root, oldSha: null, newSha: null, restartNeeded: false };

  const last = _lastPullByRoot.get(root);
  if (last !== undefined && now - last < PLUGIN_REFRESH_THROTTLE_MS) {
    return { pulled: false, throttled: true, changed: false, failed: false, root, oldSha: null, newSha: null, restartNeeded: false };
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
      return { pulled: false, throttled: false, changed: false, failed: true, root, oldSha: headSha, newSha: null, restartNeeded: false };
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
      return { pulled: false, throttled: false, changed: false, failed: false, root, oldSha: headSha, newSha: originSha, restartNeeded: false };
    }
    // Up to date — clear any prior real-pull stall episode AND the drift-grace tracker.
    _clearLagState(root);
    return { pulled: false, throttled: false, changed: false, failed: false, root, oldSha: headSha, newSha: originSha, restartNeeded: false };
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
    return { pulled: false, throttled: false, changed: false, failed: true, root, oldSha, newSha: null, restartNeeded: false };
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
    return { pulled: true, throttled: false, changed: false, failed: false, root, oldSha, newSha, restartNeeded: false };
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
  const depsRelinked = [];
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

    // CTL-1831: an install that exits 0 is NOT evidence that it relinked
    // anything. Measured on `mini` immediately after #3337 moved bun.lock from
    // @catalyst-cloud/schema@0.1.3 to 0.1.5: `--frozen-lockfile` and the plain
    // fallback BOTH reported "no changes", exited 0, and left the SDK's resolved
    // schema at 0.1.3; only `--force` relinked it. So the loop above could
    // succeed on every host while the correct lockfile never reached the running
    // code — the second link of the CTL-1506 chain, and the one that had no
    // detector at all (deps_install_failed covers only a FAILING install).
    //
    // The audit compares the lockfile's moved resolutions against what the
    // IMPORTING package resolves on disk, and only a proven mismatch escalates
    // to `--force`. Detect-then-force, never force-always: a blanket --force
    // re-extracts 1168 packages (3-8 s measured) on every refresh.
    //
    // Scoped to dirs whose install SUCCEEDED: a tree that was never built has
    // nothing to audit, and forcing on top of a failed install would replace one
    // loud failure with a slower one.
    const installedDirs = new Set(depsInstalled);
    for (const lock of changedLockfiles(root, diffOut)) {
      if (!installedDirs.has(lock.dir)) continue;
      let oldLockText = null;
      try { oldLockText = gitFn(root, ["show", `${oldSha}:${lock.rel}`]); } catch { oldLockText = null; }
      let newLockText = null;
      try { newLockText = readFileFn(join(lock.dir, "bun.lock")); } catch { newLockText = null; }
      const auditArgs = {
        workspaceRoots: workspaceRootsFn(lock.dir),
        oldLockText,
        newLockText,
        resolvePackageFn,
      };
      let audit;
      try {
        audit = auditFn(auditArgs);
      } catch (err) {
        // The audit is a guardrail, not a gate: a throw here must degrade to a
        // named inconclusive, never take down the refresh that already succeeded.
        audit = { conclusive: false, reason: `audit threw: ${err?.message ?? String(err)}`, checked: 0, matched: [], mismatched: [], inconclusive: [] };
      }

      if (audit.mismatched.length > 0) {
        // THE SIGNAL the no-op install never produced. Emitted at DETECTION,
        // before any remediation, so the record exists even if the force below
        // throws or fails to fix it.
        emitFn({
          event: "plugin.checkout.deps_install_noop",
          orchestrator: null,
          worker: null,
          severity: "WARN",
          detail: {
            checkout: root,
            package_dir: lock.dir,
            lockfile: lock.rel,
            checked: audit.checked,
            mismatched: audit.mismatched,
          },
        });
        try {
          bunInstallFn(lock.dir, { force: true });
        } catch (err) {
          emitFn({
            event: "plugin.checkout.deps_install_failed",
            orchestrator: null,
            worker: null,
            severity: "WARN",
            detail: { checkout: root, package_dir: lock.dir, forced: true, error: err?.message ?? String(err) },
          });
          continue;
        }
        let after;
        try {
          after = auditFn(auditArgs);
        } catch (err) {
          after = { conclusive: false, reason: `re-audit threw: ${err?.message ?? String(err)}`, checked: 0, matched: [], mismatched: [], inconclusive: [] };
        }
        if (after.mismatched.length > 0) {
          // --force is the strongest lever this path has. Still stale after it
          // means the drift is not bun's relink heuristic (a shadowing member
          // node_modules, a registry serving the wrong bytes, a read-only tree),
          // so it is ERROR: nothing further here will fix it.
          emitFn({
            event: "plugin.checkout.deps_relink_failed",
            orchestrator: null,
            worker: null,
            severity: "ERROR",
            detail: {
              checkout: root,
              package_dir: lock.dir,
              lockfile: lock.rel,
              mismatched: after.mismatched,
            },
          });
        } else if (after.conclusive && after.inconclusive.length === 0) {
          depsRelinked.push(lock.dir);
        } else {
          // A re-audit that could not LOOK is not evidence of repair. The
          // synthesized throw-result above, and an audit whose entries came back
          // per-entry inconclusive, both carry an EMPTY `mismatched` — identical
          // to a genuinely clean tree. Claiming `deps_relinked` off that emptiness
          // would be a check-that-cannot-fail sitting inside the fix for a
          // check-that-cannot-fail: the refresh would report a known mismatch
          // repaired with no positive evidence, and say nothing about the doubt.
          // Only a CONCLUSIVE re-audit with neither mismatches nor per-entry
          // inconclusives proves the force worked.
          emitFn({
            event: "plugin.checkout.deps_audit_inconclusive",
            orchestrator: null,
            worker: null,
            severity: "WARN",
            detail: {
              checkout: root,
              package_dir: lock.dir,
              lockfile: lock.rel,
              forced: true, // the POST-force re-audit, not the detection pass
              reason: after.reason ?? null,
              checked: after.checked,
              inconclusive: after.inconclusive,
            },
          });
        }
      } else if (!audit.conclusive || audit.inconclusive.length > 0) {
        // "I could not look" must be distinguishable from "the tree is correct".
        // A silent inconclusive is exactly how the original defect stayed
        // invisible for a year of refreshes.
        emitFn({
          event: "plugin.checkout.deps_audit_inconclusive",
          orchestrator: null,
          worker: null,
          severity: "WARN",
          detail: {
            checkout: root,
            package_dir: lock.dir,
            lockfile: lock.rel,
            forced: false, // the DETECTION pass, not a post-force re-audit
            reason: audit.reason ?? null,
            checked: audit.checked,
            inconclusive: audit.inconclusive,
          },
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
      deps_relinked: depsRelinked, // CTL-1831: dirs a forced relink actually repaired
      stale_node_modules_pruned: staleNodeModulesPruned,
    },
  });
  return { pulled: true, throttled: false, changed: true, failed: false, root, oldSha, newSha, restartNeeded };
}


// ─── CTL-1951: advancing the pinned catalyst-index serving root ─────────────
//
// CTL-1935 pinned the serving root and hooked `setup-plugin-source.sh` to apply it. That covers
// the JOIN path. It does NOT cover the path that actually runs many times a day — THIS module —
// so a pin bump never reached a worker node. Measured on all three hosts at 01:27 CT after the
// pin had already been distributed: `index-source present: NO` everywhere.
//
// ⛔ WHY THIS IS NOT A `catalyst-index-root setup` CALL INLINE. This module runs in the broker's
// event loop via execFileSync. `setup` is heavier than the `reset --hard` around it — on a node
// that has never indexed, its first run is a FULL CLONE of catalyst-cloud. Dropping that into
// the hot path trades a stale indexer for a WEDGED BROKER, which is strictly worse (the CTL-990
// class the 20 s git ceiling above exists to prevent).
//
// So the work is split by cost:
//   VERIFY  — cheap, local-only git (no network, no clone), run INLINE under a short ceiling.
//   SETUP   — heavy and network-bound, SPAWNED DETACHED and unref'd. The broker never waits on
//             it and cannot be wedged by it.
//
// ⛔ AND THE HALF THAT MAKES IT HONEST: a detached job's exit code is unobservable by definition,
// so "spawned" must never be reported as "advanced". The NEXT reload verifies again, and a root
// that is still not at the pin AFTER an attempt emits a named WARN. That is the difference
// between a fire-and-forget that silently never works and one that tells you it didn't.

export const INDEX_ROOT_THROTTLE_MS =
  Number(process.env.CATALYST_INDEX_ROOT_THROTTLE_MS) || 10 * 60 * 1000;

// Verify is local-only git; it must still be bounded, because "local" is not "instant" on a
// machine under load, and this one runs inline.
const INDEX_ROOT_VERIFY_TIMEOUT_MS =
  Number(process.env.CATALYST_INDEX_ROOT_VERIFY_TIMEOUT_MS) || 15_000;

const _lastIndexRootAttemptByRoot = new Map();
const _indexRootAttemptedByRoot = new Map();

export function __clearIndexRootStateForTest() {
  _lastIndexRootAttemptByRoot.clear();
  _indexRootAttemptedByRoot.clear();
}

function defaultIndexRootVerifyFn(script) {
  execFileSync("bash", [script, "verify"], {
    encoding: "utf8",
    timeout: INDEX_ROOT_VERIFY_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return true;
}

// Detached + unref'd + stdio ignored: the broker does not wait on it, does not hold its pipes,
// and survives its own restart without orphaning a half-written checkout in the loop.
function defaultIndexRootSpawnFn(script) {
  const child = spawn("bash", [script, "setup"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid ?? null;
}

/**
 * advanceIndexServingRoot — bring this node's catalyst-index serving root to the pinned sha,
 * without doing the heavy half in the broker's event loop.
 *
 * Returns one of:
 *   { skipped:true, reason:"opt-out" | "no-pin" | "throttled" }
 *   { atPin:true }                                  — verify passed, nothing to do
 *   { spawned:true, pid }                           — setup dispatched detached
 *   { stale:true }                                  — still not at the pin AFTER a prior attempt
 */
export function advanceIndexServingRoot({
  root,
  now = Date.now(),
  env = process.env,
  emitFn,
  verifyFn = defaultIndexRootVerifyFn,
  spawnFn = defaultIndexRootSpawnFn,
  existsFn = existsSync,
}) {
  const emit = typeof emitFn === "function" ? emitFn : () => {};
  if (!root) return { skipped: true, reason: "no-root" };

  // AC 3: a node that never indexes does NO catalyst-cloud clone at all. Checked first, so the
  // opt-out costs nothing — not even a stat.
  if (String(env.CATALYST_SKIP_INDEX_ROOT ?? "") === "1") {
    return { skipped: true, reason: "opt-out" };
  }

  const script = `${root}/plugins/dev/scripts/catalyst-index-root`;
  const pin = `${root}/plugins/dev/config/index-serving-root.json`;
  if (!existsFn(script) || !existsFn(pin)) {
    // An older checkout predates the pin. Named, not silent — but INFO, because on a node that
    // has simply not pulled the pin yet this is expected and self-correcting.
    emit({
      event: "plugin.index_root.unavailable",
      orchestrator: null,
      worker: null,
      severity: "INFO",
      detail: { checkout: root, reason: "checkout predates the CTL-1935 pin" },
    });
    return { skipped: true, reason: "no-pin" };
  }

  const last = _lastIndexRootAttemptByRoot.get(root);
  if (last !== undefined && now - last < INDEX_ROOT_THROTTLE_MS) {
    return { skipped: true, reason: "throttled" };
  }

  // VERIFY first — cheap, local, and it is also what makes a repeat reload a no-op instead of
  // respawning setup on every merge event.
  let atPin = false;
  try {
    atPin = verifyFn(script) !== false;
  } catch {
    atPin = false;
  }
  if (atPin) {
    _indexRootAttemptedByRoot.delete(root);
    return { atPin: true };
  }

  // Not at the pin. If we ALREADY dispatched setup for this root and it is still not there, the
  // detached job failed — network, auth, or a bad pin. This is the named failure signal: without
  // it, a setup that never succeeds looks identical to one that was never needed.
  const attemptedAt = _indexRootAttemptedByRoot.get(root);
  if (attemptedAt !== undefined) {
    emit({
      event: "plugin.index_root.stale",
      orchestrator: null,
      worker: null,
      severity: "WARN",
      detail: {
        checkout: root,
        attempted_at: attemptedAt,
        reason:
          "catalyst-index-root setup was dispatched on an earlier reload and the serving root is STILL not at the pin",
        consequence: "a cold index on this node would run stale or unpinned code (CTL-1935)",
        remedy: `bash ${script} setup`,
      },
    });
  }

  _lastIndexRootAttemptByRoot.set(root, now);
  let pid = null;
  try {
    pid = spawnFn(script);
  } catch (err) {
    emit({
      event: "plugin.index_root.refresh_failed",
      orchestrator: null,
      worker: null,
      severity: "WARN",
      detail: { checkout: root, error: String(err?.message ?? err) },
    });
    return { failed: true };
  }
  _indexRootAttemptedByRoot.set(root, now);
  emit({
    event: "plugin.index_root.advancing",
    orchestrator: null,
    worker: null,
    severity: "INFO",
    detail: {
      checkout: root,
      pid,
      note: "dispatched DETACHED — the exit code is not observable here; the next reload verifies and WARNs if it did not land",
    },
  });
  return { spawned: true, pid };
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
      results.push(refreshPluginCheckout({ root, now, gitFn, emitFn, loadedCommit, loadedCommitRoot, pull }));
      // CTL-1951: the ROUTINE reload advances the pinned indexer serving root too. Runs
      // unconditionally rather than only when the checkout `changed`, because a node whose
      // serving root is ABSENT must converge even on a reload that pulled nothing new — the
      // measured state on all three hosts was "pin distributed, root absent". Cheap when already
      // at the pin (one local verify) and throttled otherwise. Never throws.
      try {
        advanceIndexServingRoot({ root, now, env, emitFn });
      } catch {
        /* the indexer root must never break the plugin reload or event routing */
      }
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
      results.push(refreshPluginCheckout({ root, now, gitFn, emitFn, loadedCommit, loadedCommitRoot, pull }));
      // CTL-1951: same as the event-driven path. This is the periodic backstop, so it is also
      // what converges a node whose merge webhook never arrived.
      try {
        advanceIndexServingRoot({ root, now, env, emitFn });
      } catch {
        /* never break the drift-check tick */
      }
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
