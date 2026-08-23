// sdk-child-discovery.mjs — CTL-2192 Phase 2: find the SDK worker's OWN child
// pid so liveness survives a daemon bounce.
//
// The registry projection's `pid` is `process.pid` — the DAEMON's, for every
// worker. After a bounce that pid is dead by construction, so an on-disk
// liveness read has nothing left to probe. The child's pid is the one durable
// fact, and an SDK child can outlive its daemon as a PID-1 orphan (research
// measured 14 minutes on `mini`).
//
// ATTRIBUTION IS NON-POSITIONAL. Measured on this host 2026-08-23, SDK workers
// are direct children of the daemon, one `claude-agent-sdk-darwin-arm64` each,
// and their cwd is exactly the `worktreePath` on the projection:
//
//   pid=90211 ppid=87122 cwd=/Users/ryan/catalyst/wt/catalyst-cloud/CTC-904
//   pid=90212 ppid=87122 cwd=/Users/ryan/catalyst/wt/catalyst-workspace/CTL-2179
//   pid=90213 ppid=87122 cwd=/Users/ryan/catalyst/wt/catalyst-workspace/CTL-2192
//
// so a per-pid (ppid == daemon) ∧ (cwd == worktreePath) join is sound. We do NOT
// parse argv or `ps -E` env to attribute a pid to a ticket — that is the CTL-2097
// class the ticket explicitly warns about. `lsof -d cwd` is a structured,
// per-pid field.
//
// LEAF MODULE: node:child_process only.

import { spawnSync } from "node:child_process";

// Bound every probe: a wedged `ps`/`lsof` must not stall a dispatch.
const PROBE_TIMEOUT_MS = 5_000;

function defaultPs() {
  // ABSOLUTE path: a restricted-PATH context (a phase-agent worker's env) is
  // exactly where a PATH-resolved helper becomes a silent no-op.
  //
  // ⛔ NEVER `pgrep -P`. Measured 2026-08-23 on mini-2: `pgrep -P 2556` returned
  // {42474, 77778} and OMITTED 31607, a live child whose parentage `ps -p 31607
  // -o ppid=` independently confirmed as 2556. `ps -eo pid=,ppid=` returned all
  // three. A pgrep-based enumerator is blind to a real child and answers "no
  // worker" — a false clean in the direction that re-claims a live worker.
  return spawnSync("/bin/ps", ["-eo", "pid=,ppid="], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS });
}

function defaultLsof(pid) {
  return spawnSync("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
  });
}

/**
 * Every pid whose ppid is `parentPid`.
 *
 * TRI-STATE, deliberately: `[]` means "ps ran and this pid has no children";
 * `null` means "I COULD NOT LOOK". Collapsing them is how a host with no usable
 * process table would record every live worker as childless — and a childless
 * record is what the liveness oracle later reads as DEAD, which re-claims a
 * running worker. Same discipline as the oracle itself.
 *
 * @returns {number[]|null}
 */
export function listChildPids(parentPid, { ps = defaultPs } = {}) {
  if (!Number.isInteger(parentPid) || parentPid <= 0) return null;
  let out;
  try {
    out = ps();
  } catch {
    return null;
  }
  if (!out || out.status !== 0 || typeof out.stdout !== "string") return null;
  const kids = [];
  for (const line of out.stdout.split("\n")) {
    // `ps` RIGHT-ALIGNS the pid column, so the line starts with padding. Split
    // on runs of whitespace after trimming — a `${line%% *}`-style leading split
    // yields the empty string on a padded line and silently matches nothing.
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (ppid === parentPid) kids.push(pid);
  }
  return kids;
}

/**
 * The cwd of one pid, read from `lsof -d cwd -Fn` (a structured per-pid field).
 * @returns {string|null}
 */
export function cwdOfPid(pid, { lsof = defaultLsof } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let out;
  try {
    out = lsof(pid);
  } catch {
    return null;
  }
  if (!out || out.status !== 0 || typeof out.stdout !== "string") return null;
  for (const line of out.stdout.split("\n")) {
    if (line.startsWith("n") && line.length > 1) return line.slice(1);
  }
  return null;
}

/**
 * The pure diff: of the pids present in `after` but not `before`, the ONE whose
 * cwd is exactly `worktreePath`.
 *
 * THREE-VALUED, like every other liveness read in this ticket. `conclusive`
 * separates "I looked and there is no child of mine" from "I could not look",
 * because only the FIRST justifies the `childPidResolved` stamp that the oracle
 * reads as DEAD. The inconclusive reasons are each a real host condition:
 *
 *   enumerator-unusable       — `ps` failed; `after` is null.
 *   before-unavailable        — the BEFORE snapshot is `null`, i.e. `ps` failed
 *                               at snapshot time. listChildPids returns null
 *                               SPECIFICALLY to mean "I could not look" (see its
 *                               docstring); folding that into an empty Set would
 *                               say "the daemon had no children", which promotes
 *                               every pre-existing sibling into a `fresh` pid.
 *   cwd-unreadable            — new children exist and AT LEAST ONE cwd probe
 *                               failed while nothing matched (the systematic
 *                               case: no usable `lsof`). See the zero-match
 *                               branch below for why this is per-pid and not
 *                               scan-wide.
 *   ambiguous-multiple-matches— two new children share the worktree, i.e. two
 *                               generations. Never a guess, and never a "no
 *                               child" claim — that would let the oracle read
 *                               one of them dead and mint a third.
 *   no-worktree-path          — nothing to join on.
 *
 * @returns {{pid: number|null, conclusive: boolean, reason: string}}
 */
export function discoverSdkChildPid({ before, after, cwdOf, worktreePath } = {}) {
  if (typeof worktreePath !== "string" || worktreePath === "") {
    return { pid: null, conclusive: false, reason: "no-worktree-path" };
  }
  if (!Array.isArray(after) || typeof cwdOf !== "function") {
    return { pid: null, conclusive: false, reason: "enumerator-unusable" };
  }
  // ⛔ A `null` BEFORE is "ps failed at snapshot time", not "there were no
  // children" — listChildPids returns null for exactly that (lines 52-56). Folded
  // into an empty Set it makes every pre-existing sibling look `fresh`, which at
  // best loses the stamp to `ambiguous-multiple-matches` and at worst attributes
  // a previous generation's orphan to this run. Undefined is the same fact
  // (the caller never took a snapshot), so both are inconclusive.
  if (!Array.isArray(before)) {
    return { pid: null, conclusive: false, reason: "before-unavailable" };
  }
  const seen = new Set(before);
  const fresh = after.filter((pid) => !seen.has(pid));
  if (fresh.length === 0) return { pid: null, conclusive: true, reason: "no-new-children" };

  const matches = [];
  // ⛔ Track the FAILURES, not "did anything succeed". `anyCwdRead` was
  // SCAN-WIDE, so one readable sibling licensed a CONCLUSIVE `no-match` even
  // when OUR child's own probe was the one that failed — and a conclusive
  // no-match is what stamps childPidResolved, which classifySdkWorkerLiveness
  // branch 6 reads as DEAD for a worker that is alive. Zero matches is evidence
  // of absence only when every fresh pid was actually INTERROGATED; a single
  // unreadable pid is a pid that could still have been ours.
  let anyCwdUnreadable = false;
  for (const pid of fresh) {
    let cwd;
    try {
      cwd = cwdOf(pid);
    } catch {
      anyCwdUnreadable = true; // one unreadable pid must not abort the scan…
      continue; // …but it must not be silently treated as interrogated either
    }
    if (typeof cwd !== "string" || cwd === "") {
      anyCwdUnreadable = true;
      continue;
    }
    // Exact match, no trailing-slash normalisation — the same semantics
    // hasLiveBgWorker documents for its own `cwd === worktreePath` compare.
    if (cwd === worktreePath) matches.push(pid);
  }
  // A POSITIVE match stands on its own evidence: we read that pid's cwd and it
  // is this worktree, so another pid's unreadable probe cannot make it wrong.
  if (matches.length === 1) return { pid: matches[0], conclusive: true, reason: "matched" };
  if (matches.length > 1) return { pid: null, conclusive: false, reason: "ambiguous-multiple-matches" };
  // Zero matches — conclusive ONLY if every fresh pid was readable.
  return anyCwdUnreadable
    ? { pid: null, conclusive: false, reason: "cwd-unreadable" }
    : { pid: null, conclusive: true, reason: "no-match" };
}

/**
 * Convenience wrapper for the runner: snapshot → run → diff, with the real
 * probes wired. Never throws; a throw degrades to INCONCLUSIVE, never to a
 * conclusive "no child".
 * @returns {{pid: number|null, conclusive: boolean, reason: string}}
 */
export function discoverSdkChildPidLive({ before, parentPid = process.pid, worktreePath, ps, lsof } = {}) {
  try {
    return discoverSdkChildPid({
      before,
      after: listChildPids(parentPid, ps ? { ps } : undefined),
      cwdOf: (pid) => cwdOfPid(pid, lsof ? { lsof } : undefined),
      worktreePath,
    });
  } catch {
    return { pid: null, conclusive: false, reason: "threw" };
  }
}
