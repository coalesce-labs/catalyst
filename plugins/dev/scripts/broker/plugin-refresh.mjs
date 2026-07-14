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

import { readFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { getEventName } from "./event-name.mjs"; // CTL-1348: leaf, not the heavy router

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

// defaultRemoveLockFn — CTL-1473: remove a stale .git/index.lock so the next
// reset --hard can succeed. The lock file is created by git ops that were
// forcibly killed (SIGKILL on timeout); if no git process holds it the removal
// is always safe. Only called after we confirm the error message mentions the lock.
function defaultRemoveLockFn(root) {
  unlinkSync(`${root}/.git/index.lock`);
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
  // CTL-1473: injectable seam for removing a stale .git/index.lock. Tests inject
  // a spy; production defaults to defaultRemoveLockFn (unlinkSync). Only called
  // when the fetch/reset error message mentions "index.lock".
  removeLockFn = defaultRemoveLockFn,
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

  try {
    gitFn(root, ["fetch", "--no-tags", "origin", "main"]);
    gitFn(root, ["reset", "--hard", "origin/main"]);
  } catch (err) {
    // CTL-1473: stale .git/index.lock self-heal. A prior git op killed with SIGKILL
    // (e.g. a timed-out GIT_TIMEOUT_MS fetch) can leave index.lock behind; the next
    // reset --hard then fails with "Unable to create … index.lock: File exists". Remove
    // the lock and retry the reset once. Only the reset is retried — fetch already
    // succeeded (or we'd have thrown earlier), so index.lock is always a reset artifact.
    const errMsg = err?.message ?? String(err);
    if (errMsg.includes("index.lock")) {
      let lockRemoved = false;
      try {
        removeLockFn(root);
        lockRemoved = true;
      } catch {
        // lock file already gone — that's fine; retry regardless
        lockRemoved = true;
      }
      if (lockRemoved) {
        try {
          gitFn(root, ["reset", "--hard", "origin/main"]);
          emitFn({
            event: "plugin.checkout.git_lock_healed",
            orchestrator: null,
            worker: null,
            severity: "INFO",
            detail: { checkout: root, old_sha: oldSha },
          });
          // fall through to the newSha read + updated emit below
        } catch (retryErr) {
          // retry also failed — fall through to normal refresh_failed handling
          emitFn({
            event: "plugin.checkout.refresh_failed",
            orchestrator: null,
            worker: null,
            severity: "WARN",
            detail: {
              checkout: root,
              old_sha: oldSha,
              error: retryErr?.message ?? String(retryErr),
            },
          });
          const priorR = _failuresByRoot.get(root) ?? { count: 0, since: now };
          const nextR = { count: priorR.count + 1, since: priorR.count === 0 ? now : priorR.since };
          _failuresByRoot.set(root, nextR);
          if (nextR.count >= CHECKOUT_LAG_FAILURE_THRESHOLD && !_lagEmittedByRoot.has(root)) {
            _lagEmittedByRoot.add(root);
            emitFn({
              event: "plugin.checkout.lag",
              orchestrator: null,
              worker: null,
              severity: "ERROR",
              detail: {
                checkout: root,
                old_sha: oldSha,
                consecutive_failures: nextR.count,
                behind_since: nextR.since,
                error: retryErr?.message ?? String(retryErr),
              },
            });
          }
          return { pulled: false, throttled: false, changed: false, failed: true, root, oldSha, newSha: null, restartNeeded: false };
        }
      }
    } else {
      emitFn({
        event: "plugin.checkout.refresh_failed",
        orchestrator: null,
        worker: null,
        severity: "WARN",
        detail: {
          checkout: root,
          old_sha: oldSha,
          error: errMsg,
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
            error: errMsg,
          },
        });
      }
      return { pulled: false, throttled: false, changed: false, failed: true, root, oldSha, newSha: null, restartNeeded: false };
    }
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
  if (oldSha) {
    let diffOut = "";
    try { diffOut = gitFn(root, ["diff", "--name-only", oldSha, newSha]); } catch { diffOut = ""; }
    for (const pkgDir of changedPackageDirs(root, diffOut)) {
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
    },
  });
  return { pulled: true, throttled: false, changed: true, failed: false, root, oldSha, newSha, restartNeeded };
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
