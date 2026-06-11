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
//   2. throttles to at most one pull per N seconds per root
//   3. runs `git pull --ff-only origin main` in each root
//   4. emits plugin.checkout.updated (new HEAD sha + daemon-skew restart_needed)
//      on success, or plugin.checkout.refresh_failed (WARN) on a diverged/dirty
//      checkout — never failing silently.
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

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { getEventName } from "./router.mjs";

// Throttle window: at most one pull per N seconds per checkout root. A merge
// often arrives as both a github.pr.merged AND a github.push to main within the
// same second; the throttle collapses that pair into a single pull, and also
// caps a burst of rapid merges. 60s mirrors the catalyst-stack hotpatch cadence
// expectation while still delivering "within seconds" freshness.
export const PLUGIN_REFRESH_THROTTLE_MS = 60_000;

// root → last-pull epoch ms. Module-level so the throttle survives across
// events within one daemon lifetime. Cleared between tests via the seam below.
const _lastPullByRoot = new Map();

export function __clearThrottleForTest() {
  _lastPullByRoot.clear();
}

// --- default seams (production wiring) ---------------------------------------

// GIT_TIMEOUT_MS — hard ceiling on every synchronous git call. The broker's
// event loop runs these inline (execFileSync); a network-stalled `pull` with
// no timeout would freeze the ENTIRE broker — the same daemon-wedging class
// CTL-990 fixed in dispatch.mjs. A killed pull throws and surfaces as
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
 * refresh. Read from .catalyst.feedback.githubRepo, falling back to the first
 * .catalyst.monitor.linear.teams[].vcsRepo. Repo config (.catalyst/config.json)
 * takes precedence over the machine config. Returns null when unconfigured.
 */
export function resolveRepoFullName({
  machineConfigPath = defaultMachineConfigPath(),
  repoConfigPath = null,
  readFileFn = (p) => readFileSync(p, "utf8"),
} = {}) {
  for (const path of [repoConfigPath, machineConfigPath]) {
    const cfg = __readConfig(path, readFileFn);
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

// --- refresh ----------------------------------------------------------------

/**
 * refreshPluginCheckout — throttle-gated ff-only pull of a single checkout root.
 *
 * On a pull that advances HEAD, emits plugin.checkout.updated with old/new sha
 * and a restart_needed flag (true when the daemon's loadedCommit is known and
 * the checkout advanced past it — daemon skew is VISIBLE, not auto-restarted).
 * On an ff-only failure (diverged/dirty), emits plugin.checkout.refresh_failed
 * at WARN — surfacing the failure instead of failing silently.
 *
 * Returns a result descriptor: { pulled, throttled, changed, failed }.
 */
export function refreshPluginCheckout({
  root,
  now = Date.now(),
  gitFn = defaultGitFn,
  emitFn,
  loadedCommit = null,
  loadedCommitRoot = null,
}) {
  if (!root) return { pulled: false, throttled: false, changed: false, failed: false };

  const last = _lastPullByRoot.get(root);
  if (last !== undefined && now - last < PLUGIN_REFRESH_THROTTLE_MS) {
    return { pulled: false, throttled: true, changed: false, failed: false };
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

  try {
    gitFn(root, ["pull", "--ff-only", "origin", "main"]);
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
    return { pulled: false, throttled: false, changed: false, failed: true };
  }

  let newSha = null;
  try {
    newSha = gitFn(root, ["rev-parse", "HEAD"]);
  } catch {
    newSha = null;
  }

  // HEAD did not advance — nothing changed, stay quiet (no event noise).
  if (oldSha && newSha && oldSha === newSha) {
    return { pulled: true, throttled: false, changed: false, failed: false };
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
    },
  });
  return { pulled: true, throttled: false, changed: true, failed: false };
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
}) {
  try {
    if (!isThisRepoMergeEvent(event, { repoFullName })) return;
    const roots = resolvePluginCheckoutRoots({
      env,
      machineConfigPath,
      repoConfigPath,
      readFileFn,
      gitToplevelFn,
    });
    for (const root of roots) {
      refreshPluginCheckout({ root, now, gitFn, emitFn, loadedCommit, loadedCommitRoot });
    }
  } catch {
    // Best-effort — a refresh failure must never break event routing. Genuine
    // pull failures are already surfaced as refresh_failed events above.
  }
}
