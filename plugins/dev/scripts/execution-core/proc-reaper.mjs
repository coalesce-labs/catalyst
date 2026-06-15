// proc-reaper.mjs — CTL-1165 D2. The orphan child-process reaper (HIGHEST RISK).
//
// `claude stop` deregisters the claude AGENT but never reaps the reparented
// node/bun grandchildren (MCP servers, sub-agent tooling, bun-test runners) it
// spawned — the RSS bulk of the leak (on mini, 74 of 81 orphans by RSS were
// node/bun, many 150–550 MB). There was no process-layer reaper before this.
//
// HARD SAFETY RECIPE (R-process-kill-safety, macOS 26.4.1 live-verified):
//   • macOS env-read is DEAD (`ps eww` prints zero env, no /proc), so CATALYST_*
//     env markers are NOT part of the kill gate. `claude agents --json` already
//     returns {pid, cwd, kind, sessionId, status} authoritatively — that is the
//     primary correlation signal.
//   • LIVE_TREE correlation is the primary guard: L = {agent.pid}, then
//     LIVE_TREE = DFS-descendants(L) over the ps children-map. A pid is killable
//     ONLY if NOT in LIVE_TREE and NOT a live root. Walking DOWN from live roots
//     (not just checking the candidate's ppid) is what prevents killing a live
//     worker's MCP/bun-test grandchildren.
//   • KILL-GATE — ALL must hold else SPARE (classifyProc): orphaned (ppid===1 or
//     vanished worktree) AND command∈{node,bun} AND not allowlisted (pid OR argv)
//     AND not in LIVE_TREE / live-agent cwd AND cwd known AND cwd under the
//     worktree root AND etime ≥ minEtimeSec AND (sweep-level) the agents read
//     SUCCEEDED AND the orphan persisted across ≥2 consecutive sweeps.
//   • CATASTROPHE GUARD: a FAILED `claude agents` read (agentsResult.ok===false)
//     ABORTS the whole sweep — kill nothing. Treating read-failure as
//     agents-absent would collapse LIVE_TREE to empty and authorize a host-wide
//     kill. listClaudeAgentsResult returns {ok:false} for exactly this case.
//   • SIGTERM → wait graceMs → re-probe kill(pid,0) → SIGKILL only if still alive.
//     Never SIGKILL first (let node/bun flush).
//
// DEFAULT mode:"shadow" — emits procOrphans.would-reap, kills NOTHING. Bakes on
// mini before any enforce flip (like stall-janitor CTL-1004 + cost-cap CTL-1137).
//
// ALL IO is injected (psLister/lsofCwd/agentsResult/killProc/sleep/now)
// so the unit tests never spawn a subprocess, run ps/lsof, touch ~/.claude, or
// signal a real pid.

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename } from "node:path";
import { emitReapIntent } from "./reap-intent.mjs";
import { listClaudeAgentsResult } from "./claude-agents.mjs";
import { log as defaultLog } from "./config.mjs";

// The hard never-kill argv-substring allowlist (case-insensitive). Config-
// extensible via orphanReaper.procReaper.allowlistPatterns. Tailscale's helper
// procs (Tailscale.app / IPNExtension) are launchd-parented but must NEVER die.
const DEFAULT_ALLOWLIST_PATTERNS = Object.freeze([
  "execution-core/daemon.mjs",
  "broker/index.mjs",
  "orch-monitor/server.ts",
  "tailscale",
  "ipnextension",
]);

// ─── Pure: ps parsing (pid ppid rss etime command) ───────────────────────────

// The 3 leading numeric fields (pid ppid rss) + the etime token are whitespace-
// free; group 5 is the variable command tail (argv, may contain spaces).
const PS_ROW_RE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/;

/**
 * parseEtime — ps `etime` (elapsed time) → seconds. Forms:
 *   MM:SS  /  HH:MM:SS  /  DD-HH:MM:SS
 * Malformed / empty → 0 (a 0-age process can never satisfy the etime floor, so
 * a parse failure degrades SAFE: the proc is spared as too-young).
 */
export function parseEtime(etime) {
  if (typeof etime !== "string" || !etime) return 0;
  let days = 0;
  let rest = etime;
  const dash = etime.indexOf("-");
  if (dash !== -1) {
    days = Number(etime.slice(0, dash));
    rest = etime.slice(dash + 1);
    if (!Number.isFinite(days)) return 0;
  }
  const parts = rest.split(":").map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  let secs;
  if (parts.length === 2) secs = parts[0] * 60 + parts[1];
  else if (parts.length === 3) secs = parts[0] * 3600 + parts[1] * 60 + parts[2];
  else return 0;
  return days * 86400 + secs;
}

/**
 * parsePsRows — parse `ps -axo pid=,ppid=,rss=,etime=,command=` lines into row
 * objects { pid, ppid, rssKb, etimeSec, command, args }. `command` is the
 * basename (lowercased) of argv[0]; `args` is the full command line, kept for
 * allowlist substring matching (`command=` carries the FULL path, NOT the
 * truncated `comm`). Pure; never throws on a malformed line (it is skipped).
 */
export function parsePsRows(lines = []) {
  const rows = [];
  for (const raw of lines) {
    if (typeof raw !== "string") continue;
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const m = PS_ROW_RE.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const rssKb = Number(m[3]);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    const etimeSec = parseEtime(m[4]);
    const args = m[5].trim();
    const argv0 = args.split(/\s+/)[0] || "";
    const command = basename(argv0).toLowerCase() || null;
    rows.push({ pid, ppid, rssKb: Number.isFinite(rssKb) ? rssKb : null, etimeSec, command, args });
  }
  return rows;
}

// ─── Pure: cwd boundary ──────────────────────────────────────────────────────

/**
 * cwdUnderWorktreeRoot — boundary-safe "is cwd inside root?" (reuse reaper.mjs
 * cwdUnder semantics so `/wt/CTL-64` never matches a sibling `/wt/CTL-649`).
 */
export function cwdUnderWorktreeRoot(cwd, root) {
  if (!cwd || !root || typeof cwd !== "string" || typeof root !== "string") return false;
  const r = root.length > 1 && root.endsWith("/") ? root.slice(0, -1) : root;
  return cwd === r || cwd.startsWith(r + "/");
}

// ─── Pure: orphan detection ──────────────────────────────────────────────────

/**
 * isOrphaned — a process is orphaned when it was reparented to launchd
 * (ppid===1) OR its parent is not present in the ps snapshot (vanished). A
 * present, non-init parent means a live ancestor still owns it → NOT orphaned.
 */
export function isOrphaned(row, byPid) {
  if (!row) return false;
  if (row.ppid === 1) return true;
  // parent present in snapshot → live ancestor → not orphaned.
  if (byPid && byPid.has(row.ppid)) return false;
  // parent absent (vanished) AND not init → treat as orphaned (its owner is gone).
  return true;
}

// ─── Pure: LIVE_TREE construction ────────────────────────────────────────────

/**
 * collectLiveAgentSubtree — DFS-descendants of every live claude-agent pid. The
 * returned Set is the LIVE_TREE: every live root plus every descendant. A pid in
 * this set is a live worker's own MCP/bun-test/tooling child and must NEVER be
 * killed. Reuses the rssTotalForPid walk shape (cli/sessions.mjs).
 */
export function collectLiveAgentSubtree(liveAgents, byPid, childrenByPpid) {
  const subtree = new Set();
  const roots = [];
  for (const a of liveAgents ?? []) {
    const pid = Number(a?.pid);
    if (Number.isFinite(pid) && pid > 0) roots.push(pid);
  }
  const stack = [...roots];
  const seen = new Set();
  while (stack.length) {
    const p = stack.pop();
    if (seen.has(p)) continue;
    seen.add(p);
    subtree.add(p);
    for (const c of childrenByPpid?.get(p) ?? []) stack.push(c);
  }
  return subtree;
}

// ─── Pure: allowlist ─────────────────────────────────────────────────────────

/**
 * buildAllowlist — the hard never-kill set. Combines a pid set (self + daemon +
 * the whole LIVE_TREE) and an argv-substring pattern list (default + operator-
 * configured, lowercased). A candidate is allowlisted if its pid is in the set
 * OR its lowercased argv contains any pattern.
 */
export function buildAllowlist({
  selfPid,
  daemonPids = [],
  liveAgentSubtreePids = new Set(),
  allowlistPatterns = [],
} = {}) {
  const pids = new Set();
  if (Number.isFinite(Number(selfPid))) pids.add(Number(selfPid));
  for (const p of daemonPids) {
    const n = Number(p);
    if (Number.isFinite(n) && n > 0) pids.add(n);
  }
  for (const p of liveAgentSubtreePids) pids.add(p);
  const patterns = [
    ...DEFAULT_ALLOWLIST_PATTERNS,
    ...allowlistPatterns.map((s) => String(s).toLowerCase()),
  ];
  return { pids, patterns };
}

function isArgvAllowlisted(args, patterns) {
  const lower = String(args || "").toLowerCase();
  return patterns.some((p) => p && lower.includes(p));
}

// ─── Pure: the kill gate ─────────────────────────────────────────────────────

/**
 * classifyProc — PURE kill-gate. Returns { action:'kill'|'spare', reason }.
 * ALL conditions must hold for 'kill', else SPARE with the first failing reason.
 * The ordering puts the never-kill allowlist + LIVE_TREE FIRST (so an
 * allowlisted/live proc is never even probed), then orphan/command/cwd/etime.
 */
export function classifyProc(row, ctx) {
  const {
    byPid,
    liveAgentCwds,
    liveAgentSubtreePids,
    allowlist,
    worktreeRoot,
    killableCommands,
    minEtimeSec,
    cwdForPid,
    worktreePath,
  } = ctx;

  // (1) hard never-kill: pid in allowlist set (self/daemon/LIVE_TREE) OR argv pattern.
  if (allowlist.pids.has(row.pid)) return { action: "spare", reason: "allowlisted" };
  if (isArgvAllowlisted(row.args, allowlist.patterns)) {
    return { action: "spare", reason: "allowlisted" };
  }

  // (2) LIVE_TREE: the candidate is (a descendant of) a live claude agent.
  if (liveAgentSubtreePids.has(row.pid)) {
    return { action: "spare", reason: "live-agent-owned" };
  }

  // (3) command must be killable (node/bun) — anything else is never ours to kill.
  if (!killableCommands.has(row.command)) {
    return { action: "spare", reason: "command-not-killable" };
  }

  // (4) must be orphaned (reparented to launchd / vanished parent).
  if (!isOrphaned(row, byPid)) return { action: "spare", reason: "has-live-ancestor" };

  // (5) cwd must be resolvable; unknown cwd → SPARE (degrade safe).
  const cwd = cwdForPid(row.pid);
  if (cwd === null || cwd === undefined) return { action: "spare", reason: "cwd-unknown" };

  // (6) cwd AT OR UNDER any live-agent cwd → a live worker's own (possibly
  //     reparented) child, spare. PREFIX-aware, not byte-exact: an MCP server /
  //     bun-test / bun-install grandchild typically runs from a package SUBDIR
  //     under the agent's worktree, and once its intermediate parent exits it
  //     reparents to launchd (leaving LIVE_TREE) — the shared cwd prefix is what
  //     still ties it to the live worker. Erring toward spare is the safe
  //     direction (a live worker's tooling is never yanked mid-run).
  for (const liveCwd of liveAgentCwds) {
    if (cwdUnderWorktreeRoot(cwd, liveCwd)) {
      return { action: "spare", reason: "live-agent-owned" };
    }
  }

  // (7) cwd must be under the worktree root (an interactive claude / dev shell
  //     outside ~/catalyst/wt is never reaped — the under-wt signal is REQUIRED).
  if (!cwdUnderWorktreeRoot(cwd, worktreeRoot)) {
    return { action: "spare", reason: "not-under-worktree-root" };
  }

  // (8) targeted teardown sweep: scope to one worktree path (boundary-safe).
  if (worktreePath && !cwdUnderWorktreeRoot(cwd, worktreePath)) {
    return { action: "spare", reason: "outside-target-worktree" };
  }

  // (9) etime corroboration floor (never a SOLE gate — all the above ran first).
  if ((row.etimeSec ?? 0) < minEtimeSec) return { action: "spare", reason: "too-young" };

  return { action: "kill", reason: "orphan-node-under-worktree" };
}

// ─── Default IO seams (replaced wholesale in tests) ──────────────────────────

function defaultPsLister() {
  try {
    const out = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,etime=,command="], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return out.split("\n");
  } catch {
    return [];
  }
}

function defaultLsofCwd(pid) {
  try {
    const out = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      encoding: "utf8",
    });
    // -Fn output: lines like `pPID`, `fcwd`, `n/abs/path`. The cwd path line
    // starts with 'n'.
    for (const line of out.split("\n")) {
      if (line.startsWith("n")) return line.slice(1) || null;
    }
    return null; // unknown → spare
  } catch {
    return null; // unreadable → spare (degrade safe)
  }
}

// defaultKillProc — wraps process.kill; never throws. Returns true when the call
// succeeded (signal delivered, or a 0-probe found the proc alive), false on
// ESRCH/EPERM (gone, or alive-but-foreign → NEVER our kill). Signal 0 is the
// liveness probe; a foreign-uid proc throws EPERM here and is treated as "not
// ours" (false) so the SIGKILL re-probe spares it.
function defaultKillProc(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * ProcReaper — the orphan child-process reaper. Constructed once by the daemon
 * and driven by the orphan-reaper timer's procOrphans.reap-requested event
 * (routed through reaper.mjs _handleProcOrphansSweep). All IO injected.
 */
export class ProcReaper {
  constructor({
    mode = "shadow",
    worktreeRoot = `${homedir()}/catalyst/wt`,
    graceMs = 5000,
    minEtimeSec = 900,
    killableCommands = new Set(["node", "bun"]),
    psLister = defaultPsLister,
    lsofCwd = defaultLsofCwd,
    agentsResult = () => listClaudeAgentsResult(),
    killProc = defaultKillProc,
    sleep = realSleep,
    now = () => Date.now(),
    selfPid = process.pid,
    daemonPids = [],
    allowlistPatterns = [],
    log = defaultLog,
    emit = emitReapIntent,
  } = {}) {
    this.mode = mode;
    this.worktreeRoot = worktreeRoot;
    this.graceMs = graceMs;
    this.minEtimeSec = minEtimeSec;
    this.killableCommands = killableCommands;
    this.psLister = psLister;
    this.lsofCwd = lsofCwd;
    this.agentsResult = agentsResult;
    this.killProc = killProc;
    this.sleep = sleep;
    this.now = now;
    this.selfPid = selfPid;
    this.daemonPids = daemonPids;
    this.allowlistPatterns = allowlistPatterns;
    this.log = log;
    this.emit = emit;
    // Two-sweep persistence: pid → full argv seen on the PREVIOUS sweep. A
    // candidate must be orphaned-and-killable on two CONSECUTIVE sweeps AND its
    // full argv must match across both — keying on argv (not the node/bun
    // basename) is what actually guards pid-reuse: a recycled pid hosting a
    // different node/bun process has a different argv and is spared.
    this._priorCandidates = new Map();
  }

  /**
   * sweep — one pass. Returns { reaped, wouldReap, spared }.
   *   mode 'off'     → empty report, no emit, no kill.
   *   mode 'shadow'  → emit procOrphans.would-reap for each persisted candidate;
   *                    kill NOTHING.
   *   mode 'enforce' → SIGTERM → grace → SIGKILL each persisted candidate; emit
   *                    procOrphans.reaped.
   */
  async sweep({ worktreePath = null } = {}) {
    const report = { reaped: [], wouldReap: [], spared: [] };
    if (this.mode === "off") {
      this._priorCandidates.clear();
      return report;
    }

    // CATASTROPHE GUARD: a FAILED agents read aborts the WHOLE sweep, kills
    // nothing. {ok:false} is distinct from a genuine empty list ({ok:true,[]}).
    let agentsRes;
    try {
      agentsRes = this.agentsResult();
    } catch {
      agentsRes = { ok: false, agents: [] };
    }
    if (!agentsRes || agentsRes.ok !== true) {
      this.log.warn(
        {},
        "proc-reaper: `claude agents` read FAILED — aborting sweep, killing nothing (CATASTROPHE GUARD)",
      );
      await this._safeEmit("procOrphans.spared", { reason: "agents-unreadable" });
      this._priorCandidates.clear(); // a failed read invalidates persistence state
      return report;
    }

    // Snapshot processes. An unreadable ps degrades safe (empty report).
    let rows;
    try {
      rows = parsePsRows(this.psLister());
    } catch (err) {
      this.log.warn({ err: err?.message }, "proc-reaper: ps snapshot failed — skipping sweep");
      return report;
    }

    const byPid = new Map(rows.map((r) => [r.pid, r]));
    const childrenByPpid = new Map();
    for (const r of rows) {
      if (!childrenByPpid.has(r.ppid)) childrenByPpid.set(r.ppid, []);
      childrenByPpid.get(r.ppid).push(r.pid);
    }

    // Live-agent correlation: pid roots → LIVE_TREE subtree; cwd set. These
    // derive from the SAME fresh, ok-verified read that just passed the
    // catastrophe guard — NOT a separate cached snapshot. Keeping the guard and
    // the correlation on one source means a cold/stale cache returning [] while
    // the fresh read succeeds can never shrink the live-agent cwd set out from
    // under the kill gate.
    const liveAgents = Array.isArray(agentsRes.agents) ? agentsRes.agents : [];
    const liveAgentSubtreePids = collectLiveAgentSubtree(liveAgents, byPid, childrenByPpid);
    const liveAgentCwds = new Set();
    for (const a of liveAgents) if (a?.cwd) liveAgentCwds.add(a.cwd);

    const allowlist = buildAllowlist({
      selfPid: this.selfPid,
      daemonPids: this.daemonPids,
      liveAgentSubtreePids,
      allowlistPatterns: this.allowlistPatterns,
    });

    const ctx = {
      byPid,
      liveAgentCwds,
      liveAgentSubtreePids,
      allowlist,
      worktreeRoot: this.worktreeRoot,
      killableCommands: this.killableCommands,
      minEtimeSec: this.minEtimeSec,
      cwdForPid: (pid) => this._safeCwd(pid),
      worktreePath,
    };

    // Classify every row. Collect this-sweep kill candidates for persistence.
    const thisSweepCandidates = new Map();
    const verdicts = [];
    for (const row of rows) {
      const v = classifyProc(row, ctx);
      verdicts.push({ row, v });
      if (v.action === "kill") thisSweepCandidates.set(row.pid, row.args);
    }

    // Two-sweep persistence: act only on a candidate seen orphaned-and-killable
    // on the PREVIOUS sweep too, with a matching command (pid-reuse guard).
    for (const { row, v } of verdicts) {
      if (v.action !== "kill") {
        report.spared.push({ pid: row.pid, command: row.command, reason: v.reason });
        continue;
      }
      const prior = this._priorCandidates.get(row.pid);
      if (!prior || prior !== row.args) {
        // First sweep this candidate is seen (or pid reused under a new argv):
        // spare it this pass; the persistence map below records it for next time.
        report.spared.push({ pid: row.pid, command: row.command, reason: "awaiting-second-sweep" });
        continue;
      }
      // Persisted across ≥2 sweeps → act.
      if (this.mode === "shadow") {
        report.wouldReap.push({ pid: row.pid, command: row.command });
        await this._safeEmit("procOrphans.would-reap", {
          pid: row.pid,
          command: row.command,
          worktreePath: this._safeCwd(row.pid),
        });
      } else if (this.mode === "enforce") {
        const killed = await this._terminateWithGrace(row);
        if (killed) {
          report.reaped.push({ pid: row.pid, command: row.command });
          await this._safeEmit("procOrphans.reaped", {
            pid: row.pid,
            command: row.command,
            worktreePath: this._safeCwd(row.pid),
          });
        }
      }
    }

    // Roll persistence forward: remember THIS sweep's candidates for the next.
    this._priorCandidates = thisSweepCandidates;
    return report;
  }

  // SIGTERM → wait graceMs → re-probe kill(pid,0) → SIGKILL only if still alive.
  // Never SIGKILL first (let node/bun flush). Returns true if the proc is gone
  // (whether it exited under SIGTERM or SIGKILL).
  async _terminateWithGrace(row) {
    this.killProc(row.pid, "SIGTERM");
    await this.sleep(this.graceMs);
    // Re-probe: signal 0 returns true (alive) / false (gone or foreign-uid).
    const stillAlive = this.killProc(row.pid, 0);
    if (!stillAlive) return true; // exited under SIGTERM (or vanished) — done.
    // Re-match FULL argv just before SIGKILL to dodge pid-reuse: re-snapshot. A
    // pid recycled into a different process during the grace window has a
    // different argv (or is absent) → stillSame false → no SIGKILL.
    let stillSame = true;
    try {
      const fresh = parsePsRows(this.psLister());
      const cur = fresh.find((r) => r.pid === row.pid);
      stillSame = !!cur && cur.args === row.args;
    } catch {
      stillSame = false; // can't re-confirm → do NOT SIGKILL (degrade safe).
    }
    if (!stillSame) {
      this.log.warn({ pid: row.pid }, "proc-reaper: pid no longer matches argv — skipping SIGKILL");
      return false;
    }
    this.killProc(row.pid, "SIGKILL");
    return true;
  }

  _safeCwd(pid) {
    try {
      return this.lsofCwd(pid);
    } catch {
      return null;
    }
  }

  async _safeEmit(type, fields) {
    try {
      return await this.emit(type, fields);
    } catch (err) {
      this.log.warn({ err: err?.message, type }, "proc-reaper: emit failed");
      return false;
    }
  }
}
