// pid-file-identity.mjs — a pid file may only be written over, or removed, by a
// process that can prove the file is not pointing at a LIVE peer.
//
// ⛔ THE MEASURED INCIDENT (CTL-2028, mini-2, 2026-08-18 16:20 CT). Two brokers,
// both alive, both heartbeating, both tailing the same event log and folding into
// the same `filter-state.db`. The orphan had survived a `catalyst-stack restart`
// and had been running for EIGHTY-FIVE MINUTES — and `catalyst-stack status`
// reported ONE healthy broker the entire time, because it reads the pid file and
// the pid file had been overwritten by the newer process.
//
// The mechanism was two unconditional lines:
//
//   writeFileSync(PID_FILE_PATH, `${process.pid}\n`);  // clobbers a LIVE peer
//   unlinkSync(PID_FILE_PATH);                         // unlinks SOMEONE ELSE's
//
// so the failure composes:
//   1. a restart leaves the old daemon alive        → two daemons;
//   2. the new one CLOBBERS the file                → the old one is invisible to
//      every pid-based check, supervisor and status command;
//   3. the old one eventually exits and REMOVES the → the survivor is unmanaged,
//      live daemon's pid file                          and the next supervisor
//                                                      pass may start a THIRD.
// Step 3 was reproduced, not theorised: terminating the orphan left the pid file
// absent with a healthy broker still running, and status then reported DOWN.
//
// ⚠️ WHY IDENTITY AND NOT `kill -0`. Pids are recycled. A liveness-only check
// would let an unrelated same-user process that inherited the recorded pid look
// like a live peer — which would make a legitimately stale pid file permanently
// un-writable and wedge the daemon. This is the same lesson `catalyst-monitor.sh`'s
// `_forward_pid_is_ours` already paid for on the bash side; the rule there and here
// is identical: match the COMMAND LINE, and be explicit about the fail direction.
//
// ⛔ THE TWO FAIL DIRECTIONS ARE OPPOSITE, AND THAT IS DELIBERATE.
//   • REMOVE fails toward LEAVING THE FILE. Deleting a live peer's pid file is the
//     step-3 damage above; leaving a stale file behind is a cosmetic mess a
//     restart clears. So "I could not read the file" or "the contents are not a
//     number" means DO NOT UNLINK.
//   • WRITE fails toward WRITING. Refusing to write on an unreadable `ps` would
//     leave a healthy daemon with no pid file at all — unmanaged, exactly the
//     state this module exists to prevent. So an unresolvable identity is a
//     WARNING plus a write, never a refusal.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * readPidFrom — the pid a file names, or null.
 *
 * Returns null for absent, unreadable, empty, non-numeric and non-positive
 * contents. Every one of those is "I cannot tell whose file this is", and the
 * caller must treat them as such rather than as "nobody's".
 */
export function readPidFrom(path, { readFn = readFileSync } = {}) {
  let raw;
  try {
    raw = readFn(path, "utf8");
  } catch {
    return null;
  }
  const n = Number.parseInt(String(raw).trim(), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * processCommand — the full command line of `pid`, or null when it cannot be read.
 *
 * ⚠️ `-ww` IS LOad-BEARING. Linux procps wraps at 80 columns when stdout is not a
 * tty, and a bun-launched daemon's command line is comfortably longer than that —
 * so without it the marker the identity match depends on is TRUNCATED AWAY and the
 * check answers "not the same daemon" about a process that is. That exact
 * truncation shipped once on the bash side (`_forward_pid_is_ours`) and reproduced
 * only on Linux, because macOS `ps` does not truncate.
 */
export function processCommand(pid, { execFn = execFileSync } = {}) {
  try {
    const out = execFn("ps", ["-ww", "-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const cmd = String(out).trim();
    return cmd.length > 0 ? cmd : null;
  } catch {
    return null;
  }
}

/**
 * classifyPidFile — who does this pid file name?
 *
 * `marker` is a substring that identifies THIS daemon in a command line (e.g.
 * "broker/index.mjs"). Returns a discriminated verdict — never a bare boolean —
 * so a caller can act differently on "a live peer" and "I could not look", which
 * are the two answers that must not be collapsed:
 *
 *   { kind: "absent" }                    no file, or nothing parseable in it
 *   { kind: "self", pid }                 the file names THIS process
 *   { kind: "live-peer", pid, command }   a DIFFERENT, live process, same daemon
 *   { kind: "stale", pid, reason }        names a pid that is gone, or alive but a
 *                                         DIFFERENT program (a recycled pid)
 *   { kind: "unknown", pid }              the pid exists but `ps` would not answer
 */
export function classifyPidFile(path, marker, { readFn = readFileSync, execFn = execFileSync, selfPid = process.pid } = {}) {
  const pid = readPidFrom(path, { readFn });
  if (pid === null) return { kind: "absent" };
  if (pid === selfPid) return { kind: "self", pid };
  const command = processCommand(pid, { execFn });
  if (command === null) {
    // `ps` said nothing. Either the process is gone (the common case) or `ps`
    // itself failed. These are not distinguishable from here, and the two callers
    // want opposite defaults — so the ambiguity is REPORTED, not resolved.
    return { kind: "unknown", pid };
  }
  // A recycled pid: alive, but running something else entirely. Treating this as a
  // live peer would make the file permanently un-writable.
  if (!command.includes(marker)) return { kind: "stale", pid, reason: "recycled-pid", command };
  return { kind: "live-peer", pid, command };
}

/**
 * shouldRemovePidFile — may this process unlink `path`?
 *
 * ONLY when the file names this process. Everything else — a live peer, a stale
 * entry, an unreadable file — is left alone, because the cost of a wrong unlink
 * (an unmanaged live daemon) is strictly worse than the cost of a wrong keep (a
 * stale file the next start overwrites).
 */
export function shouldRemovePidFile(verdict) {
  return verdict?.kind === "self";
}

/**
 * duplicateDaemonAlarm — the operator-facing sentence for a `live-peer` verdict,
 * or null. Both pids are named, because "there are two" is not actionable and
 * "17643 and 53448 are both running" is.
 */
export function duplicateDaemonAlarm(verdict, { name = "daemon", selfPid = process.pid } = {}) {
  if (verdict?.kind !== "live-peer") return null;
  return (
    `duplicate ${name}: the pid file names ${verdict.pid}, which is ALIVE and is also a ${name} — ` +
    `this process (${selfPid}) is about to overwrite it, so ${verdict.pid} becomes invisible to every ` +
    `pid-based status check and supervisor. Two ${name}s are processing the same inputs. ` +
    `Stop one by identity, then restart.`
  );
}
