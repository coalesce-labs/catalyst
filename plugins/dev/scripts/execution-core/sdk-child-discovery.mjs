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
 *   cwd-unreadable            — new children exist but EVERY cwd probe failed
 *                               (the systematic case: no usable `lsof`).
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
  const seen = new Set(Array.isArray(before) ? before : []);
  const fresh = after.filter((pid) => !seen.has(pid));
  if (fresh.length === 0) return { pid: null, conclusive: true, reason: "no-new-children" };

  const matches = [];
  let anyCwdRead = false;
  for (const pid of fresh) {
    let cwd;
    try {
      cwd = cwdOf(pid);
    } catch {
      continue; // one unreadable pid must not abort the scan
    }
    if (typeof cwd !== "string" || cwd === "") continue;
    anyCwdRead = true;
    // Exact match, no trailing-slash normalisation — the same semantics
    // hasLiveBgWorker documents for its own `cwd === worktreePath` compare.
    if (cwd === worktreePath) matches.push(pid);
  }
  if (matches.length === 1) return { pid: matches[0], conclusive: true, reason: "matched" };
  if (matches.length > 1) return { pid: null, conclusive: false, reason: "ambiguous-multiple-matches" };
  // Zero matches. That is only evidence if we actually READ at least one cwd.
  return anyCwdRead
    ? { pid: null, conclusive: true, reason: "no-match" }
    : { pid: null, conclusive: false, reason: "cwd-unreadable" };
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
