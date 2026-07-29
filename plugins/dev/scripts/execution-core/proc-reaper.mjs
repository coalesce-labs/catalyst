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
//
// CTL-1531 — the WIDENED any-command orphan class. A real incident (2026-07-25→26)
// had four `sh -c "while :; do :; done"` processes peg ~4 cores for 16.5h with
// cwd = ~/catalyst/wt/evergreen/evr-23 (a DELETED worktree) and PPID 1. The
// command∈{node,bun} conjunct made them structurally invisible: the hourly sweep
// walked past them ~16 times. The fix gates on OWNERSHIP EVIDENCE instead of the
// command name — a process qualifies for the widened class when ALL of:
//     cwd under the worktree root  AND  cwd path no longer EXISTS  AND  ppid === 1
// The widening is expressed as an OR *inside* the command gate, deliberately, so
// that every gate that already ran before it (allowlist, LIVE_TREE) and every
// gate after it (orphan, cwd-known, live-agent cwd prefix, under-worktree-root,
// target worktree, etime) plus the sweep-level catastrophe guard and the
// two-sweep full-argv persistence STILL apply to the widened row, unchanged.
// The widened class is STRICTLY ppid===1 — isOrphaned's wider "parent vanished
// from the ps snapshot" branch is a snapshot race and must never admit an
// arbitrary command. Both new probes FAIL CLOSED (unknown ⇒ spare). The widened
// class additionally carries a COMMAND DENYLIST (DEFAULT_DENY_COMMAND_RE) that
// the node/bun class never needed: a tmux/screen server is ppid-1 BY
// CONSTRUCTION and inherits its cwd from whatever shell first started it, so one
// kill nukes every pane the operator has open.
//
// CTL-1531 PERF — the widened admission is what makes gate (3) stop being the
// cheap bail: on a real host it cut the rows reaching the cwd probe from ~1344
// spared to ~286, pushing ~1061 extra rows into a per-pid `lsof` execFile inside
// a SEQUENTIAL await loop (585ms sweep → 54.5s). The cost is node's PER-EXECFILE
// SPAWN overhead (~55ms), not lsof (1058 bare-shell lsof calls take ~350ms). The
// sweep therefore resolves every cwd it can possibly need in ONE batched
// `lsof -a -d cwd -Fpn -p <csv>` call (measured 451ms/1046 pids, ~120x cheaper).
// This matters because sweep() runs INSIDE the execution-core daemon off the
// 600s orphan-reaper timer — the exact event-loop path CTL-1524 just unblocked.
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
// ALL IO is injected (psLister/lsofCwd/lsofCwdBatch/cwdExists/worktreeRootExists/
// agentsResult/killProc/probeAlive/sleep/now) so the unit tests never spawn a
// subprocess, run ps/lsof/stat, touch ~/.claude, or signal a real pid.
//
// ─── PARITY WITH orphan-sweep.sh (read this before editing a safety gate) ────
// This file and `plugins/dev/scripts/orphan-sweep.sh` are TWO IMPLEMENTATIONS OF
// ONE POLICY (the daemon-side reaper and the LaunchAgent-side sweep). They have
// drifted in BOTH directions across three review rounds — each round found a
// hardening present on one side and missing on the other. Every SHARED safety
// property therefore carries a `PARITY: <slug>` marker at its site in BOTH
// files, and `proc-reaper.test.mjs` asserts the two marker SETS are identical.
// If you add or remove a shared gate here, tag it and tag the sibling, or the
// parity test fails. Deliberately one-sided behavior must NOT be tagged — see
// the "documented asymmetries" list in that test.

import { execFile, execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import { emitReapIntent } from "./reap-intent.mjs";
import { listClaudeAgentsResult } from "./claude-agents.mjs";
import { log as defaultLog } from "./config.mjs";

// PARITY: allowlist
// The hard never-kill argv-substring allowlist (case-insensitive). Config-
// extensible via orphanReaper.procReaper.allowlistPatterns. Tailscale's helper
// procs (Tailscale.app / IPNExtension) are launchd-parented but must NEVER die.
//
// CTL-1531 round 3: `orphan-sweep.sh` and `catalyst-stack` were present in the
// .sh sibling's _PROC_ALLOWLIST_RE and MISSING here — the exact drift the parity
// contract exists to stop, shipped under a comment claiming the two lists
// mirrored each other. Both are PPID-1 BY CONSTRUCTION, so the pid-based half of
// the allowlist (self / parent / daemonPids) does not cover them:
//   • orphan-sweep.sh runs from a LaunchAgent — launchd is its parent, and it is
//     never the daemon's parent, so the daemon reaper could target the SWEEP.
//   • catalyst-stack is re-exec'd by launchd (`catalyst-stack start` every 600s)
//     and hand-started as `nohup … & disown`.
// A reaper that can kill the other reaper — or the process supervisor that
// restarts the fleet — is a self-inflicted outage, not a reclamation.
const DEFAULT_ALLOWLIST_PATTERNS = Object.freeze([
  "execution-core/daemon.mjs",
  "broker/index.mjs",
  "orch-monitor/server.ts",
  "tailscale",
  "ipnextension",
  "orphan-sweep.sh",
  "catalyst-stack",
]);

// PARITY: denylist
// CTL-1531 — the WIDENED-class-only command DENYLIST (mirrors orphan-sweep.sh's
// _PROC_DENY_CMD_RE). The node/bun class never needed one: `node`/`bun` are not
// session multiplexers or login plumbing. The widened class admits ANY command,
// so a tmux/screen server — which is daemonized (ppid 1 BY CONSTRUCTION) and
// inherits its cwd from whatever shell first started it — becomes syntactically
// eligible, and ONE kill nukes every pane the operator has open. An orphaned ssh
// tunnel likewise keeps working fine with a deleted cwd.
//
// The trailing `:?` is load-bearing: setproctitle's `progname: ` form is what
// these processes actually advertise —
//     "tmux: server (/private/tmp/tmux-501/default)"  → argv[0] = "tmux:"
//     "sshd: ryan [priv]"                             → argv[0] = "sshd:"
// so a bare `^tmux$` anchor NEVER matches the very processes it exists to guard.
const DEFAULT_DENY_COMMAND_RE =
  /^(tmux|tmux-server|screen|sshd|ssh|mosh-server|login|launchd|init|systemd|nohup):?$/i;

// ─── CTL-1531 P1-a: the widened class's OWN rollout mode ─────────────────────
//
// The widened any-command class must NOT inherit authority from the legacy
// node/bun reaper's `mode`. A host that already carries
// `orphanReaper.procReaper.mode: "enforce"` (an operator flip that was granted
// for the NARROW node/bun class, after that class's own shadow bake) would
// otherwise, the instant this ships, gain authority to SIGTERM **any** PPID-1
// command whose cwd looks deleted — skipping the shadow observation window and
// the operator-owned flip ADR-023 requires ("Dark by default"; "Three-state
// off → shadow → enforce"; "Gated criteria flips"; "Rejected: enable-on-merge").
//
// So the widened class gets an INDEPENDENT three-state knob, `widenMode`, that
// defaults to "shadow" REGARDLESS of `mode` — the exact mirror of the .sh side's
// SWEEP_PROC_WIDEN. Semantics:
//   off     → the widened admission is not even evaluated; classifyPreCwd spares
//             on the pre-CTL-1531 reason, so unsetting fully reverts the feature.
//   shadow  → widened rows are classified and REPORTED (would-reap + log +
//             event) but are never signalled, even when mode === "enforce".
//   enforce → widened rows follow `mode` (so BOTH gates must be open to kill).
// The legacy node/bun class is untouched by this knob in every state.
// PARITY: shadow-default
export const WIDEN_MODES = Object.freeze(["off", "shadow", "enforce"]);

// PARITY: per-run-cap
// CTL-1531 round 2 (Codex P1-b) — the per-run bound on WIDENED kills, ported
// from orphan-sweep.sh's SWEEP_PROC_WIDEN_MAX_KILLS (same default, same
// semantics, same "cap reached (N), M deferred" reporting) so the two
// implementations of this policy agree.
//
// Why a cap at all: the widened class's authorizing evidence is "the cwd path
// no longer exists", and that predicate is CORRELATED across the whole host —
// rename, delete or unmount `worktreeRoot` and EVERY process beneath it
// satisfies it in the same pass. Two sweeps of that (the persistence gate) and
// a single root-level fault becomes a host-wide kill. A genuine orphan leak is
// a handful of processes; anything larger is a root-level event that wants a
// human, not a killer.
//
// TWO ceilings, deliberately, because they bound different things (this is the
// ambiguity Codex flagged on the .sh side, fixed identically in both):
//   • `widenMaxKills` bounds CONFIRMED TERMINATIONS. Counting confirmed exits
//     rather than attempts is what stops a process that traps/ignores SIGTERM
//     from consuming a cap slot — and so crowding a real orphan out — forever.
//   • the derived signal ceiling bounds DELIVERED SIGNALS at `cap * 2` and
//     counts EVERY signal (SIGTERM *and* SIGKILL). A candidate is worth at most
//     two signals, so `cap` candidates are worth at most `cap * 2` signals. A
//     host where nothing responds to signals stops instead of piling on.
export const WIDEN_DEFAULT_MAX_KILLS = 5;

/**
 * normalizeWidenMode — PURE. Any value that is not exactly one of
 * off|shadow|enforce degrades to "shadow" (never to "enforce"): a typo in the
 * Layer-1 config must not silently arm a process killer.
 */
export function normalizeWidenMode(value) {
  return WIDEN_MODES.includes(value) ? value : "shadow";
}

/**
 * isCommandDenylisted — CTL-1531. True when ANY whitespace-separated argv token
 * basenames to a denied command. Matching the FULL argv (not just argv[0]) is
 * deliberate: `nohup tmux …`, `/usr/bin/env screen …` and `sh -c "ssh …"` all
 * hide the denied program past position 0, and over-SPARING is the safe
 * direction for a process killer. A trailing `:` is stripped before the test so
 * the `progname: ` setproctitle form cannot defeat the anchor.
 *
 * Whitespace tokenization DOES over-match on this host (measured): `/usr/sbin/
 * universalaccessd launchd -s` and `…/CoreServices/Screen Time.app/…` both trip
 * it. That is accepted and intentional — every such row is SPARED, and a killer
 * that spares four system daemons it was never going to reach (they fail
 * `not-under-worktree-root` anyway) is strictly better than one that misses a
 * `tmux:` server. The motivating incident argv (`sh -c while :; do :; done`)
 * contains no denied token, so the widening still does its job.
 */
export function isCommandDenylisted(args, command = null, denyRe = DEFAULT_DENY_COMMAND_RE) {
  const re = denyRe instanceof RegExp ? denyRe : DEFAULT_DENY_COMMAND_RE;
  const tokens = [];
  if (typeof command === "string" && command) tokens.push(command);
  if (typeof args === "string" && args) {
    for (const tok of args.split(/\s+/)) if (tok) tokens.push(tok);
  }
  for (const tok of tokens) {
    const bare = basename(tok).replace(/:+$/, "");
    if (bare && re.test(bare)) return true;
  }
  return false;
}

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
 * buildAllowlist — the hard never-kill set. Combines a pid set (self + PARENT +
 * daemon + the whole LIVE_TREE) and an argv-substring pattern list (default +
 * operator-configured, lowercased). A candidate is allowlisted if its pid is in
 * the set OR its lowercased argv contains any pattern.
 *
 * CTL-1531: `parentPid` is part of the set because the widened any-command class
 * makes the sweep's own supervising shell/process a syntactically eligible row.
 * Self-protection must be an explicit gate, not an accident of the command name.
 */
export function buildAllowlist({
  selfPid,
  parentPid,
  daemonPids = [],
  liveAgentSubtreePids = new Set(),
  allowlistPatterns = [],
} = {}) {
  const pids = new Set();
  if (Number.isFinite(Number(selfPid))) pids.add(Number(selfPid));
  if (Number.isFinite(Number(parentPid)) && Number(parentPid) > 0) pids.add(Number(parentPid));
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
 * classifyPreCwd — PURE and IO-FREE. Gates (1)-(4) of the kill gate: allowlist,
 * LIVE_TREE, command / widened admission (+ the widened command denylist), and
 * orphanhood. Returns either a terminal `{action:'spare', reason}` verdict, or
 * `{action:'probe', widened}` meaning "this row still needs its cwd resolved".
 *
 * Split out of classifyProc for CTL-1531's batched cwd prefetch: sweep() runs
 * this cheap pass over the WHOLE ps snapshot first, so it knows the exact pid set
 * that needs a cwd before it spends a single execFile. Both callers share this
 * one implementation, so the prefetch set can never drift from the real gate.
 */
export function classifyPreCwd(row, ctx) {
  const {
    byPid,
    liveAgentSubtreePids,
    allowlist,
    killableCommands,
    denyCommandRe = DEFAULT_DENY_COMMAND_RE,
    // CTL-1531 P1-a: the widened class's own rollout mode. "off" removes the
    // widened admission entirely (full revert-by-unset, ADR-023 §5); shadow and
    // enforce both ADMIT the row here — the difference between them is whether
    // the sweep is allowed to signal it, which is decided in sweep(), not here,
    // so that shadow still produces the would-reap observation the flip needs.
    widenMode = "shadow",
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

  // (3) command must be killable (node/bun) — OR (CTL-1531) the row must qualify
  //     for the WIDENED any-command class. Widened admission is deliberately an
  //     OR *here*, so gates (1)-(2) above and (4)-(10) below all still apply to
  //     the widened row; the widened-only deleted-cwd conjunct is gate (7b).
  //     STRICT ppid === 1: isOrphaned's wider "parent vanished from the ps
  //     snapshot" branch is a snapshot race and must never admit an arbitrary
  //     command. Anything else keeps the original spare reason (and, crucially,
  //     never pays for the lsof/stat probes below).
  //     CTL-1531 P1-a: the widened admission is additionally gated on its OWN
  //     rollout mode. widenMode "off" ⇒ the conjunct below is never evaluated
  //     and the row spares on the EXACT pre-CTL-1531 reason, so unsetting the
  //     knob is a byte-identical revert of the whole feature (ADR-023 §5).
  const commandKillable = killableCommands.has(row.command);
  const widened =
    !commandKillable && normalizeWidenMode(widenMode) !== "off" && row.ppid === 1;
  if (!commandKillable && !widened) {
    return { action: "spare", reason: "command-not-killable" };
  }

  // (3b) WIDENED CLASS ONLY: the command denylist (session multiplexers, login /
  //      init plumbing). node/bun are never denied, so the legacy class is
  //      untouched. See DEFAULT_DENY_COMMAND_RE for why this is not optional.
  if (widened && isCommandDenylisted(row.args, row.command, denyCommandRe)) {
    return { action: "spare", reason: "command-denylisted" };
  }

  // (4) must be orphaned (reparented to launchd / vanished parent).
  if (!isOrphaned(row, byPid)) return { action: "spare", reason: "has-live-ancestor" };

  return { action: "probe", widened };
}

/**
 * classifyProc — the full kill gate. Returns { action:'kill'|'spare', reason }.
 * ALL conditions must hold for 'kill', else SPARE with the first failing reason.
 * The ordering puts the never-kill allowlist + LIVE_TREE FIRST (so an
 * allowlisted/live proc is never even probed), then orphan/command/cwd/etime.
 */
export async function classifyProc(row, ctx) {
  const { liveAgentCwds, worktreeRoot, minEtimeSec, cwdForPid, cwdExists, worktreePath } = ctx;

  // (1)-(4): the cheap, IO-free gates.
  const pre = classifyPreCwd(row, ctx);
  if (pre.action !== "probe") return pre;
  const widened = pre.widened === true;

  // (5) cwd must be resolvable; unknown cwd → SPARE (degrade safe).
  const cwd = await cwdForPid(row.pid);
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

  // (7b) CTL-1531, WIDENED CLASS ONLY: the cwd must no longer EXIST. This is the
  //      ownership evidence that stands in for the command-name gate — a shell a
  //      human left sitting in a LIVE worktree is never a candidate; only debris
  //      whose backing tree was deleted out from under it is. FAIL CLOSED: a
  //      probe that cannot answer (null/undefined/non-boolean) SPARES.
  //      node/bun deliberately skip this gate — narrowing them to "deleted cwd"
  //      would be a silent coverage REGRESSION of the pre-CTL-1531 behavior.
  if (widened) {
    const exists = typeof cwdExists === "function" ? await cwdExists(cwd) : null;
    if (typeof exists !== "boolean") return { action: "spare", reason: "cwd-exists-unknown" };
    if (exists) return { action: "spare", reason: "cwd-still-exists" };
  }

  // (8) targeted teardown sweep: scope to one worktree path (boundary-safe).
  if (worktreePath && !cwdUnderWorktreeRoot(cwd, worktreePath)) {
    return { action: "spare", reason: "outside-target-worktree" };
  }

  // PARITY: age-floor
  // (9) etime corroboration floor (never a SOLE gate — all the above ran first).
  // Mirrors SWEEP_PROC_WIDEN_MIN_AGE_SECS. A just-spawned process whose worktree
  // is mid-teardown must not be reaped out from under the teardown.
  if ((row.etimeSec ?? 0) < minEtimeSec) return { action: "spare", reason: "too-young" };

  return {
    action: "kill",
    reason: widened ? "orphan-any-command-deleted-cwd" : "orphan-node-under-worktree",
    widened,
  };
}

// ─── Default IO seams (replaced wholesale in tests) ──────────────────────────

function execFileAsync(bin, args, opts = {}) {
  // Same deadline contract as execFileTolerant: when a `timeout` is supplied we
  // enforce it with our OWN watchdog and settle independently of child exit.
  // node's `timeout` option only DELIVERS a SIGTERM and then keeps awaiting the
  // child, so a probe wedged in uninterruptible I/O on a stale mount never
  // settles — which is exactly the case the lsof deadline exists for, and is why
  // the single-pid path measured 30s against a 700ms deadline before this.
  const { timeout, ...rest } = opts;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(v);
    };
    let child;
    try {
      child = execFile(bin, args, { encoding: "utf8", ...rest }, (err, stdout) =>
        err ? finish(reject, err) : finish(resolve, stdout)
      );
    } catch (err) {
      return finish(reject, err);
    }
    if (Number.isFinite(timeout) && timeout > 0) {
      timer = setTimeout(() => {
        try {
          child?.kill?.("SIGKILL"); // best effort; a D-state child may survive it
        } catch {
          /* unsignalable — stop waiting regardless */
        }
        const err = new Error(`execFileAsync: ${bin} exceeded ${timeout}ms`);
        err.code = "ETIMEDOUT";
        finish(reject, err); // callers treat a rejection as UNKNOWN ⇒ spare
      }, timeout);
      if (typeof timer.unref === "function") timer.unref();
    }
  });
}

async function defaultPsLister() {
  try {
    const out = await execFileAsync("ps", ["-axo", "pid=,ppid=,rss=,etime=,command="], {
      maxBuffer: 16 * 1024 * 1024,
    });
    return out.split("\n");
  } catch {
    return [];
  }
}

// execFileTolerant — like execFileAsync but NEVER rejects: it resolves with
// whatever stdout was produced, even on a non-zero exit. Required for batched
// lsof: `lsof -p <1500 pids>` exits 1 whenever ANY listed pid is gone or
// unreadable (measured on this host: exit 1 with 1155 valid process records),
// so rejecting would throw away the entire batch on a single dead pid.
function execFileTolerant(bin, args, opts = {}) {
  // The deadline is enforced by OUR OWN watchdog, not by execFile's `timeout`.
  // node's option only DELIVERS a SIGTERM at the deadline and then keeps waiting
  // for the child to exit — the callback, and therefore this promise, stays
  // pending until it does. A probe wedged in uninterruptible I/O on a stale mount
  // (the exact case this bound exists for) never exits and ignores SIGTERM, so
  // the "5 second bound" would still have wedged the daemon's reaper handler
  // indefinitely. Resolving independently is what actually bounds the caller.
  const { timeout, ...rest } = opts;
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const done = (v) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(v);
    };
    let child;
    try {
      child = execFile(bin, args, { encoding: "utf8", ...rest }, (_err, stdout) =>
        done(typeof stdout === "string" ? stdout : "")
      );
    } catch {
      return done("");
    }
    if (Number.isFinite(timeout) && timeout > 0) {
      timer = setTimeout(() => {
        // Best-effort reap of the straggler; a D-state child may ignore even
        // SIGKILL, which is precisely why we no longer WAIT for it.
        try {
          child?.kill?.("SIGKILL");
        } catch {
          /* already gone, or unsignalable — either way stop waiting */
        }
        done(""); // empty ⇒ cwd unknown ⇒ the candidate is SPARED
      }, timeout);
      if (typeof timer.unref === "function") timer.unref();
    }
  });
}

// PARITY: probe-deadline
// The LSOF cwd probe is bounded so ONE hung mount cannot wedge the daemon's
// reaper handler (the single-pid path shipped with no timeout at all). The .sh
// sibling bounds its own `lsof` with a watchdog child (stock macOS ships no
// `timeout`), configurable via SWEEP_PROC_CWD_TIMEOUT_SECS.
//
// NOTE the scope: this property covers the LSOF probe on both sides and NOTHING
// ELSE. The "does this cwd path still exist?" probe (defaultCwdExists →
// statSync here, `stat` there) is UNBOUNDED on both sides; see the
// "unbounded statSync existence probe" entry in proc-reaper.test.mjs's
// DOCUMENTED_ASYMMETRIES for why, and for the blast-radius difference.
//
// CATALYST_LSOF_TIMEOUT_MS is the JS-side knob (the .sh side already had
// SWEEP_PROC_CWD_TIMEOUT_SECS). It is read at CALL time, not at module load, so
// a test can drive a sub-second deadline against a deliberately hung `lsof`
// without a 5s wall clock — which is what makes the deadline TESTABLE at all.
const LSOF_TIMEOUT_DEFAULT_MS = 5000;

export function lsofTimeoutMs() {
  const raw = process.env.CATALYST_LSOF_TIMEOUT_MS;
  if (raw === undefined || raw === null || raw === "") return LSOF_TIMEOUT_DEFAULT_MS;
  const n = Number(raw);
  // Bounded, like the .sh side's _sweep_bounded_int: a garbage or out-of-range
  // value falls back to the DEFAULT, never to "unbounded" (0 / NaN / negative
  // would all disable the deadline, which is the failure this guard exists for).
  return Number.isFinite(n) && n > 0 && n <= 600000 ? Math.floor(n) : LSOF_TIMEOUT_DEFAULT_MS;
}
// Chunk size for the batched probe. 1493 pids in one call measured 561ms, so
// this is not about lsof cost — it bounds the argv length and the per-call
// blast radius of a timeout (a timed-out chunk loses only its own pids).
const LSOF_BATCH_CHUNK = 512;

async function defaultLsofCwd(pid) {
  try {
    const out = await execFileAsync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      timeout: lsofTimeoutMs(),
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

/**
 * parseLsofCwdBatch — PURE. Parses `lsof -Fpn` record streams into pid → cwd.
 * The stream is a flat sequence of tagged lines; a `p<PID>` line opens a process
 * set and every following `n<path>` belongs to it until the next `p`:
 *     p407 / fcwd / n/Users/ryan / p630 / fcwd / n/ ...
 * Only the FIRST `n` per pid is taken (one cwd fd per process). Unparseable or
 * empty records are dropped — a pid absent from the result is UNKNOWN, and
 * unknown spares.
 *
 * SAFETY — the UNTERMINATED TAIL IS DISCARDED. `execFileTolerant` deliberately
 * keeps the stdout of a lsof that hit its timeout (or otherwise exited non-zero),
 * and such a stream can end mid-line. A truncated `n/Users/ryan/catalyst/wt/CTL-1`
 * would be read as a real, currently-nonexistent path under the worktree root —
 * i.e. it would MANUFACTURE a perfect widened kill candidate out of a process
 * whose actual cwd is somewhere else entirely. Only the last line can be partial,
 * so if the text does not end in a newline that line is dropped outright.
 */
export function parseLsofCwdBatch(stdout) {
  const out = new Map();
  const text = String(stdout ?? "");
  const lines = text.split("\n");
  if (text && !text.endsWith("\n")) lines.pop(); // truncated tail → never trusted
  let pid = null;
  for (const line of lines) {
    if (!line) continue;
    if (line[0] === "p") {
      const n = Number(line.slice(1));
      pid = Number.isFinite(n) && n > 0 ? n : null;
      continue;
    }
    if (line[0] === "n" && pid !== null && !out.has(pid)) {
      const path = line.slice(1);
      if (path) out.set(pid, path);
    }
  }
  return out;
}

/**
 * defaultLsofCwdBatch — resolve MANY pids' cwds in ONE lsof call per chunk.
 * Returns Map<pid, path>; a pid lsof could not answer for is simply absent.
 * This is the CTL-1531 perf fix: the previous per-pid execFile loop cost ~55ms
 * of node spawn overhead PER PID (585ms → 54.5s once the widened admission
 * pushed ~1061 extra rows into it), and that loop ran on the execution-core
 * daemon's event loop.
 */
async function defaultLsofCwdBatch(pids) {
  const out = new Map();
  const list = (Array.isArray(pids) ? pids : [])
    .map((p) => Number(p))
    .filter((p) => Number.isFinite(p) && p > 0);
  if (list.length === 0) return out;
  for (let i = 0; i < list.length; i += LSOF_BATCH_CHUNK) {
    const chunk = list.slice(i, i + LSOF_BATCH_CHUNK);
    const stdout = await execFileTolerant(
      "lsof",
      ["-a", "-d", "cwd", "-Fpn", "-p", chunk.join(",")],
      { timeout: lsofTimeoutMs(), maxBuffer: 16 * 1024 * 1024 }
    );
    for (const [pid, path] of parseLsofCwdBatch(stdout)) {
      if (!out.has(pid)) out.set(pid, path);
    }
  }
  return out;
}

// defaultKillProc — wraps process.kill; never throws. Returns true when the call
// succeeded (signal delivered, or a 0-probe found the proc alive), false on
// ESRCH/EPERM (gone, or alive-but-foreign → NEVER our kill). Signal 0 is the
// liveness probe; a foreign-uid proc throws EPERM here and is treated as "not
// ours" (false) so the SIGKILL re-probe spares it.
//
// NOTE (CTL-1531 round 2): this BOOLEAN seam is fine for DELIVERING a signal but
// is NOT a sound liveness probe — see defaultProbeAlive. Nothing in this file
// may read `killProc(pid, 0) === false` as "the process is gone".
function defaultKillProc(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

// PARITY: confirmed-exit
/**
 * defaultProbeAlive — TRI-STATE liveness: true (alive) | false (definitely
 * gone) | null (the probe itself could not answer). CTL-1531 round 2, the JS
 * half of Codex's `_proc_alive` finding.
 *
 * The old code probed liveness through `killProc(pid, 0)`, whose boolean
 * collapses three distinct outcomes into `false`:
 *   • ESRCH — no such process. The ONLY one that proves an exit.
 *   • EPERM — the kernel FOUND the process and refused us. It is ALIVE. Reading
 *     this as "gone" made `_terminateWithGrace` return true right after SIGTERM
 *     and report a reclamation for a process that never died — the same
 *     fail-open class as the earlier findings, now inside the confirmation.
 *   • anything else (EINVAL, a thrown non-Error, an injected seam blowing up) —
 *     UNKNOWN. A failed probe is not evidence of an exit.
 * Only `false` may be read as "definitely gone"; `true` and `null` both mean
 * "do not claim the exit".
 */
export function defaultProbeAlive(pid, { kill = process.kill } = {}) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return null;
  try {
    kill(n, 0);
    return true; // signal 0 accepted → the process exists
  } catch (err) {
    const code = err?.code;
    if (code === "ESRCH") return false; // definitely gone
    if (code === "EPERM") return true; // found, but foreign-uid → ALIVE
    return null; // cannot tell
  }
}

// defaultCwdExists — CTL-1531's "does the cwd path still exist?" probe. MUST
// return a real boolean (a non-boolean is read as "unknown" and spares). Kept a
// separate injectable seam so the widened-class tests drive deletion purely as a
// predicate: no test ever touches the filesystem.
//
// PARITY: tri-state-cwd-probe
// CTL-1531 P1-b — this MUST NOT use existsSync(). existsSync swallows EVERY
// stat error and returns plain `false`, so an UNANSWERABLE probe (EACCES on a
// mode-000 parent, EIO on a failing disk, ESTALE / ENOTCONN on a dropped NFS or
// SMB mount, EPERM under a sandbox) is indistinguishable from "the worktree was
// deleted" — the exact inversion of the fail-closed rule this gate exists to
// enforce, and it fires on the widened class where the deleted-cwd conjunct is
// the ONLY ownership evidence for killing an arbitrary command. statSync
// surfaces the errno, so "definitely gone" (ENOENT — and ENOTDIR, which likewise
// proves the path cannot resolve) stays separable from "cannot tell".
// `stat` is injectable ONLY so the errno discrimination below can be pinned: EIO
// and ESTALE cannot be provoked on a real filesystem, and treating either as
// "definitely gone" would make a flaky mount look like positive kill evidence.
// Production always uses statSync.
//
// NOT COVERED BY `PARITY: probe-deadline` (CTL-1531 round 3). This statSync is
// SYNCHRONOUS and UNBOUNDED: a stat against a hung NFS/SMB mount blocks the
// daemon's whole event loop until the kernel gives up, which is a strictly worse
// blast radius than the .sh sibling's `stat` (that one wedges only its own
// LaunchAgent run). Bounding it would mean moving the probe into a subprocess on
// every candidate — more spawns than the hang it guards against, and the exact
// per-pid spawn storm CTL-1531's batched lsof exists to remove. So it is
// deliberately left unbounded and DECLARED, in DOCUMENTED_ASYMMETRIES, rather
// than advertised as bounded by a property the code does not implement.
export function defaultCwdExists(path, { stat = statSync } = {}) {
  if (typeof path !== "string" || !path) return null; // unknown → spare
  try {
    stat(path);
    return true;
  } catch (err) {
    const code = err?.code;
    // Only ENOENT. ENOTDIR was here, and it made JS the KILLING side of an
    // undeclared asymmetry: the shell probe matches only "No such file or
    // directory", so macOS's "Not a directory" falls through to unknown ⇒ SPARE,
    // while JS treated it as proof of deletion ⇒ kill evidence. The shared
    // property text also says "Only a definite ENOENT is kill evidence", which
    // was false for JS. Converged to the safer side rather than widening the
    // shell: for a gate that kills, the two implementations disagreeing is worse
    // than either answer, and sparing costs one deferred sweep.
    if (code === "ENOENT") return false; // definitely gone
    return null; // EACCES / EIO / ESTALE / EPERM / … → CANNOT TELL → spare
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
    // CTL-1531 P1-a: INDEPENDENT rollout mode for the widened any-command class.
    // Defaults to "shadow" even when `mode` is already "enforce" — see
    // WIDEN_MODES. Mirrors the .sh side's SWEEP_PROC_WIDEN.
    widenMode = "shadow",
    // CTL-1531 round 2 (P1-b): per-run cap on WIDENED confirmed terminations.
    // 0 = uncapped. Mirrors SWEEP_PROC_WIDEN_MAX_KILLS. See WIDEN_DEFAULT_MAX_KILLS.
    widenMaxKills = WIDEN_DEFAULT_MAX_KILLS,
    worktreeRoot = `${homedir()}/catalyst/wt`,
    graceMs = 5000,
    minEtimeSec = 900,
    killableCommands = new Set(["node", "bun"]),
    psLister = defaultPsLister,
    lsofCwd = defaultLsofCwd,
    lsofCwdBatch = null,
    cwdExists = defaultCwdExists,
    // CTL-1531 round 2 (P1-a): "is the worktree ROOT itself still there?" — a
    // DIFFERENT question from "is this candidate's cwd still there?", so it gets
    // its own seam. It defaults to the cwd probe (never to a constant), so a
    // caller that swaps in a real-filesystem cwd probe gets a real root probe
    // too and the gate can never silently fail open.
    worktreeRootExists = null,
    denyCommandRe = DEFAULT_DENY_COMMAND_RE,
    agentsResult = () => listClaudeAgentsResult(),
    killProc = defaultKillProc,
    // CTL-1531 round 2: TRI-STATE liveness. Explicit injection always wins;
    // otherwise the errno-discriminating native probe is used ONLY when the kill
    // seam is also the native default — so a test that injects `killProc` alone
    // keeps a fully hermetic probe and never touches a real pid.
    probeAlive = null,
    sleep = realSleep,
    now = () => Date.now(),
    selfPid = process.pid,
    parentPid = process.ppid,
    daemonPids = [],
    allowlistPatterns = [],
    log = defaultLog,
    emit = emitReapIntent,
  } = {}) {
    this.mode = mode;
    // Normalized on the way in: an unrecognized value degrades to "shadow",
    // never to "enforce" (a config typo must not arm a process killer).
    this.widenMode = normalizeWidenMode(widenMode);
    // A non-numeric / non-finite / negative cap degrades to the DEFAULT, never
    // to uncapped — the .sh side's `_sweep_bounded_int` rule, in JS. Note the
    // `typeof` test is load-bearing: `Number(null)` is 0, and 0 is the
    // DOCUMENTED "uncapped" value, so coercing would turn a null config field
    // into an uncapped process killer. Explicit numeric 0 still means uncapped —
    // that is an operator decision, not a typo.
    // CTL-1531 (Codex P1): require an INTEGER, and never floor into uncapped. The
    // old test admitted any finite non-negative number and then floored it, so a
    // malformed fractional cap like `widenMaxKills: 0.5` became `0` — which is the
    // DOCUMENTED "uncapped" value. A typo in the config therefore removed the
    // widened-process kill ceiling entirely, the exact inversion of what a cap is
    // for. `Number.isInteger` also implies finite, so it subsumes the old check.
    // Exact numeric 0 still means uncapped: that is an operator decision, not a typo.
    this.widenMaxKills =
      typeof widenMaxKills === "number" && Number.isInteger(widenMaxKills) && widenMaxKills >= 0
        ? widenMaxKills
        : WIDEN_DEFAULT_MAX_KILLS;
    this.worktreeRoot = worktreeRoot;
    this.graceMs = graceMs;
    this.minEtimeSec = minEtimeSec;
    this.killableCommands = killableCommands;
    this.psLister = psLister;
    this.lsofCwd = lsofCwd;
    // Batched cwd seam. Explicit injection always wins. Otherwise the fast
    // native batch is used ONLY when the single-pid seam is also the native
    // default — so a test (or caller) that injects `lsofCwd` alone keeps a fully
    // hermetic per-pid path and never shells out to the real lsof.
    this.lsofCwdBatch =
      typeof lsofCwdBatch === "function"
        ? lsofCwdBatch
        : lsofCwd === defaultLsofCwd
          ? defaultLsofCwdBatch
          : null;
    this.cwdExists = cwdExists;
    this.worktreeRootExists =
      typeof worktreeRootExists === "function" ? worktreeRootExists : (p) => this.cwdExists(p);
    this.denyCommandRe = denyCommandRe instanceof RegExp ? denyCommandRe : DEFAULT_DENY_COMMAND_RE;
    this.agentsResult = agentsResult;
    this.killProc = killProc;
    // Stored UNRESOLVED (null = "derive it"). The derivation reads
    // `this.killProc` at CALL time, not construction time — a caller (or test)
    // that swaps the kill seam after construction must not be left probing real
    // pids through the native default. See _safeProbeAlive.
    this.probeAlive = typeof probeAlive === "function" ? probeAlive : null;
    this.sleep = sleep;
    this.now = now;
    this.selfPid = selfPid;
    this.parentPid = parentPid;
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
        "proc-reaper: `claude agents` read FAILED — aborting sweep, killing nothing (CATASTROPHE GUARD)"
      );
      await this._safeEmit("procOrphans.spared", { reason: "agents-unreadable" });
      this._priorCandidates.clear(); // a failed read invalidates persistence state
      return report;
    }

    // Snapshot processes. An unreadable ps degrades safe (empty report).
    let rows;
    try {
      rows = parsePsRows(await this.psLister());
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
      parentPid: this.parentPid,
      daemonPids: this.daemonPids,
      liveAgentSubtreePids,
      allowlistPatterns: this.allowlistPatterns,
    });

    // PARITY: root-absent-bail
    // CTL-1531 round 2 (Codex P1-a), ported from orphan-sweep.sh's BOUND 1.
    //
    // The widened class's authorizing conjunct is "this cwd no longer exists".
    // That predicate is CORRELATED, not independent: rename, delete or unmount
    // `worktreeRoot` and EVERY PPID-1 process whose cwd was beneath it answers
    // ENOENT in the same pass. Two sweeps of that (persistence is satisfied by
    // the SAME correlated fault, so it is no defense here) and one root-level
    // failure becomes a mass kill.
    //
    // So: probe the ROOT ITSELF first. If it is not definitely present, the
    // signal is about the root, not about any individual process — disable the
    // widened admission for this sweep entirely and say why. Fail closed: only
    // `true` proceeds; `false` (gone) and `null` (unreadable — EACCES on the
    // mount point, ESTALE on a dropped share) both bail. The LEGACY node/bun
    // class is untouched, exactly as the .sh bail skips only the widened branch.
    let effectiveWidenMode = this.widenMode;
    if (effectiveWidenMode !== "off") {
      const rootPresent = await this._safeWorktreeRootExists(this.worktreeRoot);
      if (rootPresent !== true) {
        effectiveWidenMode = "off";
        this.log.warn(
          {
            worktreeRoot: this.worktreeRoot,
            probe: rootPresent === false ? "absent" : "unreadable",
          },
          "proc-reaper: worktree root is absent/unreadable — DISABLING the widened class for this sweep (a missing root makes EVERY cwd under it look gone)"
        );
        await this._safeEmit("procOrphans.spared", { reason: "widen-root-absent" });
      }
    }

    const ctx = {
      byPid,
      liveAgentCwds,
      liveAgentSubtreePids,
      allowlist,
      worktreeRoot: this.worktreeRoot,
      killableCommands: this.killableCommands,
      denyCommandRe: this.denyCommandRe,
      widenMode: effectiveWidenMode,
      minEtimeSec: this.minEtimeSec,
      // Assigned below, once the batched prefetch has run. classifyPreCwd (the
      // only thing called before that) never touches it.
      cwdForPid: null,
      cwdExists: (path) => this._safeCwdExists(path),
      worktreePath,
    };

    // CTL-1531 PERF — batched cwd prefetch. Run the IO-FREE gates over the whole
    // snapshot first to learn the EXACT pid set that will need a cwd, then
    // resolve all of them in ONE lsof call. Without this the widened admission
    // pushes ~1061 extra rows into a sequential per-pid execFile (~55ms of node
    // spawn overhead each) and the sweep goes 585ms → 54.5s ON THE DAEMON EVENT
    // LOOP. `cwdCache` is authoritative for every pid it was asked about: a pid
    // lsof could not answer for is cached as null (= unknown = spare) rather
    // than retried per-pid, which is what keeps the worst case cheap too.
    const needCwd = [];
    for (const row of rows) {
      if (classifyPreCwd(row, ctx).action === "probe") needCwd.push(row.pid);
    }
    const cwdCache = await this._safeCwdBatch(needCwd);
    ctx.cwdForPid = (pid) => (cwdCache.has(pid) ? cwdCache.get(pid) : this._safeCwd(pid));

    // Classify every row. Collect this-sweep kill candidates for persistence.
    const thisSweepCandidates = new Map();
    const verdicts = [];
    for (const row of rows) {
      const v = await classifyProc(row, ctx);
      verdicts.push({ row, v });
      if (v.action === "kill") thisSweepCandidates.set(row.pid, row.args);
    }

    // PARITY: per-run-cap — the widened class's two run-scoped ceilings. See
    // WIDEN_DEFAULT_MAX_KILLS for why there are two and what each bounds.
    const widenCap = this.widenMaxKills;
    let widenActed = 0; // CONFIRMED terminations (bounded by widenCap)
    let widenSignalled = 0; // signals DELIVERED, SIGTERM *and* SIGKILL (bounded by widenCap*2)
    let widenDeferred = 0;
    let widenSignalBoundHit = false;

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
      // Persisted across ≥2 sweeps → act. CTL-1531: carry `reason`/`widened` on
      // the report entry AND the emitted event so the newly-visible any-command
      // class is separable from the legacy node/bun class in Loki/Prometheus
      // during the shadow bake, and log it explicitly (there was no log at all
      // on the would-reap path before — the shadow signal was event-only).
      //
      // PARITY: argv-redaction
      // CTL-1531 P1-d — the log NEVER carries `row.args`. The widened class
      // admits ARBITRARY commands, and an arbitrary argv routinely carries an
      // API token, a password, an `Authorization:` header or a pre-signed URL
      // (`curl -H "Authorization: Bearer …"`, `psql "postgres://u:p@…"`,
      // `foo --api-key=…`). These log lines go to the structured execution-core
      // log, which Alloy ships to Loki — so merely OBSERVING the widened class
      // in the DEFAULT shadow mode would write secrets to disk and off-host,
      // with no enforce flip anywhere in the picture. `row.command` is already
      // the basename of argv[0] (see parsePsRows) and is the most that is safe
      // to print. The full argv stays IN MEMORY ONLY, where it is genuinely
      // load-bearing: the two-sweep persistence map and the pre-SIGKILL
      // re-match, both of which are pid-reuse guards.
      const widened = v.widened === true;
      // CTL-1531 P1-a: the widened class answers to its OWN mode. Only
      // widenMode === "enforce" lets a widened candidate follow `mode`; in every
      // other state it is pinned to shadow, so a host already at
      // procReaper.mode:"enforce" still merely OBSERVES the new class.
      const effectiveMode = widened
        ? effectiveWidenMode === "enforce"
          ? this.mode
          : "shadow"
        : this.mode;
      if (effectiveMode === "shadow") {
        report.wouldReap.push({
          pid: row.pid,
          command: row.command,
          reason: v.reason,
          widened,
        });
        this.log.info(
          { pid: row.pid, command: row.command, reason: v.reason, widened },
          widened
            ? "proc-reaper [shadow]: WOULD reap WIDENED orphan (CTL-1531: any command, ppid=1, cwd deleted under worktree root)"
            : "proc-reaper [shadow]: WOULD reap orphan node/bun under worktree root"
        );
        await this._safeEmit("procOrphans.would-reap", {
          pid: row.pid,
          command: row.command,
          reason: v.reason,
          worktreePath: await ctx.cwdForPid(row.pid),
        });
      } else if (effectiveMode === "enforce") {
        // PARITY: per-run-cap — both ceilings are applied on the ENFORCING path
        // only, so shadow keeps reporting the FULL candidate set (that is the
        // signal an operator needs to size the cap before flipping to enforce).
        if (widened && widenCap > 0) {
          if (widenSignalBoundHit) {
            report.spared.push({
              pid: row.pid,
              command: row.command,
              reason: "widen-signal-bound-reached",
            });
            continue;
          }
          if (widenActed >= widenCap) {
            widenDeferred += 1;
            report.spared.push({
              pid: row.pid,
              command: row.command,
              reason: "widen-cap-reached",
            });
            continue;
          }
          // CTL-1531 round 3: admit only if the candidate's WORST CASE still fits
          // under the ceiling. A candidate is worth up to TWO signals (SIGTERM,
          // then SIGKILL), and the check runs at ADMISSION — so testing
          // `signalled >= cap*2` admits a candidate at `cap*2 - 1` which then
          // spends two more, delivering `cap*2 + 1`. Provoked by ODD parity: with
          // cap=2 (ceiling 4), one candidate that exits under SIGTERM (1 signal)
          // followed by stubborn ones delivered 1+2+2 = 5. `signalled + 2 > cap*2`
          // is the bound that actually bounds what it claims to bound.
          if (widenSignalled + 2 > widenCap * 2) {
            widenSignalBoundHit = true;
            this.log.warn(
              { cap: widenCap, signalBound: widenCap * 2, confirmed: widenActed },
              `proc-reaper: widened signal bound reached (${widenCap * 2}) with only ${widenActed} confirmed termination(s) — stopping this run (a human should look at this host)`
            );
            report.spared.push({
              pid: row.pid,
              command: row.command,
              reason: "widen-signal-bound-reached",
            });
            continue;
          }
        }
        // PARITY: pre-signal-revalidation
        // CTL-1531 P2-f: re-establish the widened ownership conjunction from a
        // FRESH read immediately before the first signal (see
        // _revalidateWidened for why the classification snapshot is stale here).
        if (widened && !(await this._revalidateWidened(row, ctx))) {
          report.spared.push({
            pid: row.pid,
            command: row.command,
            reason: "widened-revalidation-failed",
          });
          this.log.warn(
            { pid: row.pid, command: row.command, reason: "widened-revalidation-failed" },
            "proc-reaper: widened candidate no longer proves ownership at signal time — sparing"
          );
          continue;
        }
        const killed = await this._terminateWithGrace(row, {
          widened,
          ctx,
          onSignal: widened
            ? () => {
                widenSignalled += 1;
              }
            : null,
        });
        if (killed) {
          if (widened) widenActed += 1;
          report.reaped.push({ pid: row.pid, command: row.command, reason: v.reason, widened });
          this.log.info(
            { pid: row.pid, command: row.command, reason: v.reason, widened },
            widened
              ? "proc-reaper [enforce]: reaped WIDENED orphan (CTL-1531)"
              : "proc-reaper [enforce]: reaped orphan node/bun"
          );
          await this._safeEmit("procOrphans.reaped", {
            pid: row.pid,
            command: row.command,
            reason: v.reason,
            worktreePath: await ctx.cwdForPid(row.pid),
          });
        }
      }
    }

    // PARITY: per-run-cap — same wording as the .sh side's deferral report, so
    // one Loki/log query finds the overflow on either implementation.
    if (widenDeferred > 0) {
      this.log.warn(
        { cap: widenCap, deferred: widenDeferred },
        `proc-reaper: widened cap reached (${widenCap}), ${widenDeferred} deferred to the next run`
      );
    }

    // Roll persistence forward: remember THIS sweep's candidates for the next.
    this._priorCandidates = thisSweepCandidates;
    return report;
  }

  /**
   * _revalidateWidened — CTL-1531 P2-f. Re-establish the FULL widened ownership
   * conjunction from a fresh read, immediately before the first signal.
   *
   * Why the classification verdict is not enough: every candidate is classified
   * from ONE ps snapshot, then the verdicts are processed SERIALLY, and each
   * enforcing candidate sleeps `graceMs` (default 5s) inside _terminateWithGrace
   * before the next one is reached. The 10th candidate is therefore signalled
   * ~45s after the snapshot that justified it — ample time for a pid to be
   * recycled, a worktree to be recreated by `create-worktree.sh`, a new agent to
   * claim the tree, or the process to be adopted by a live supervisor.
   * _terminateWithGrace's existing argv re-match runs only AFTER the SIGTERM has
   * already been delivered, so it protects the SIGKILL and nothing else.
   *
   * Re-checked here, all from reads taken NOW:
   *   • the pid is still present with the SAME full argv (pid-reuse guard)
   *   • ppid is STILL exactly 1 (not re-adopted by a live supervisor)
   *   • it is not (a descendant of) a live claude agent
   *   • its cwd still resolves, is still under the worktree root (and the
   *     targeted worktree when the sweep is scoped), is not under a live agent's
   *     cwd, and is still DELETED
   *
   * ANY unanswerable probe ⇒ false ⇒ no signal. Fail closed, like every other
   * gate in this file. Applies to the WIDENED class only: the legacy node/bun
   * class keeps its exact pre-CTL-1531 path.
   */
  async _revalidateWidened(row, ctx = null) {
    // (1) fresh ps: same pid, same full argv, still strictly ppid === 1.
    let fresh;
    try {
      fresh = parsePsRows(await this.psLister());
    } catch {
      return false;
    }
    const cur = fresh.find((r) => r.pid === row.pid);
    if (!cur || cur.args !== row.args || cur.ppid !== 1) return false;

    // (2) live-agent ownership, re-read. A FAILED read is the catastrophe-guard
    //     condition and must spare here exactly as it aborts the sweep.
    let agentsRes;
    try {
      agentsRes = this.agentsResult();
    } catch {
      return false;
    }
    if (!agentsRes || agentsRes.ok !== true) return false;
    const agents = Array.isArray(agentsRes.agents) ? agentsRes.agents : [];
    const byPid = new Map(fresh.map((r) => [r.pid, r]));
    const childrenByPpid = new Map();
    for (const r of fresh) {
      if (!childrenByPpid.has(r.ppid)) childrenByPpid.set(r.ppid, []);
      childrenByPpid.get(r.ppid).push(r.pid);
    }
    if (collectLiveAgentSubtree(agents, byPid, childrenByPpid).has(row.pid)) return false;

    // (3) cwd re-probe — deliberately the single-pid seam, NOT the batch cache
    //     the classification pass filled; a cached path is the stale value this
    //     whole method exists to distrust.
    const cwd = await this._safeCwd(row.pid);
    if (typeof cwd !== "string" || !cwd) return false;
    for (const a of agents) {
      if (a?.cwd && cwdUnderWorktreeRoot(cwd, a.cwd)) return false;
    }
    if (!cwdUnderWorktreeRoot(cwd, this.worktreeRoot)) return false;
    const targetPath = ctx?.worktreePath ?? null;
    if (targetPath && !cwdUnderWorktreeRoot(cwd, targetPath)) return false;
    return (await this._safeCwdExists(cwd)) === false; // true OR unknown ⇒ spare
  }

  // SIGTERM → wait graceMs → re-probe liveness → SIGKILL only if still alive.
  // Never SIGKILL first (let node/bun flush). Returns true ONLY when the proc is
  // CONFIRMED gone (whether it exited under SIGTERM or SIGKILL).
  async _terminateWithGrace(row, { widened = false, ctx = null, onSignal = null } = {}) {
    this.killProc(row.pid, "SIGTERM");
    if (typeof onSignal === "function") onSignal();
    await this.sleep(this.graceMs);
    // PARITY: confirmed-exit — TRI-STATE. Only a probe that CONFIRMS absence
    // (`false`) may claim the exit. `true` (alive) and `null` (the probe itself
    // failed — EPERM/EINVAL/a throwing seam) both fall through to the SIGKILL
    // path, because a failed probe is not evidence that anything died.
    const alive = await this._safeProbeAlive(row.pid);
    if (alive === false) return true; // exited under SIGTERM — done.
    // PARITY: pre-signal-revalidation
    // `graceMs` (default 5s, and serial across candidates) is a second window in
    // which the evidence can go stale, so the pre-SIGTERM revalidation does NOT
    // cover the SIGKILL. Re-prove ownership from reads taken NOW.
    //
    // For the WIDENED class an argv re-match alone is not enough: the process
    // may have moved into a live cwd, its worktree may have been recreated by
    // `create-worktree.sh`, a live agent may have claimed the tree, or its PPID
    // may have changed — in every one of those it would still have been
    // SIGKILLed. Re-run the FULL widened conjunction (ppid===1, argv, no
    // live-agent owner, cwd under the root / target, cwd still deleted).
    if (widened) {
      if (!(await this._revalidateWidened(row, ctx))) {
        this.log.warn(
          { pid: row.pid, command: row.command },
          "proc-reaper: widened candidate no longer proves ownership at SIGKILL time — skipping SIGKILL"
        );
        return false;
      }
    } else {
      // Legacy node/bun class: unchanged pre-CTL-1531 pid-reuse guard. A pid
      // recycled into a different process during the grace window has a
      // different argv (or is absent) → stillSame false → no SIGKILL.
      let stillSame = true;
      try {
        const fresh = parsePsRows(await this.psLister());
        const cur = fresh.find((r) => r.pid === row.pid);
        stillSame = !!cur && cur.args === row.args;
      } catch {
        stillSame = false; // can't re-confirm → do NOT SIGKILL (degrade safe).
      }
      if (!stillSame) {
        this.log.warn(
          { pid: row.pid },
          "proc-reaper: pid no longer matches argv — skipping SIGKILL"
        );
        return false;
      }
    }
    this.killProc(row.pid, "SIGKILL");
    if (typeof onSignal === "function") onSignal();
    // CTL-1531 (Codex P2-i): kill(2) returns on DELIVERY, not on exit. A process
    // wedged in uninterruptible sleep (D state on a hung mount) — or one we lack
    // permission to signal — survives SIGKILL. Returning true unconditionally
    // reported a PHANTOM reclamation: the pid landed in report.reaped and emitted
    // procOrphans.reaped while the process kept running, so every sweep would
    // re-"reap" it forever. Mirror the shell's _proc_gone_within: confirm the exit.
    return await this._confirmGone(row.pid);
  }

  // PARITY: confirmed-exit
  // _confirmGone — poll the TRI-STATE liveness probe until the pid is CONFIRMED
  // gone, bounded. Fail-CLOSED in the reporting direction: only an explicit
  // `false` ("definitely gone") returns true. `null` — the probe ITSELF failed —
  // is NOT an exit and must never be read as one; at the deadline we return
  // false, so the sweep UNDER-reports rather than emitting a reclamation that
  // never happened.
  async _confirmGone(pid, { attempts = 5, intervalMs = 200 } = {}) {
    for (let i = 0; i < attempts; i++) {
      const alive = await this._safeProbeAlive(pid);
      if (alive === false) return true; // CONFIRMED gone
      if (i < attempts - 1) await this.sleep(intervalMs);
    }
    this.log.warn(
      { pid },
      "proc-reaper: exit NOT confirmed after SIGKILL (still alive, or the liveness probe itself could not answer) — NOT counted as reaped"
    );
    return false;
  }

  // _safeProbeAlive — normalize the liveness seam to true|false|null. Any throw,
  // or any non-boolean answer, becomes null = UNKNOWN, and unknown never claims
  // an exit. Fail closed by construction (mirrors _safeCwdExists).
  //
  // The seam is resolved HERE, not in the constructor: an explicit `probeAlive`
  // always wins; otherwise the errno-discriminating native probe is used ONLY
  // while `killProc` is still the native default. Any injected kill seam —
  // including one assigned after construction — routes the probe back through
  // it, so a hermetic test can never leak a real `process.kill` probe.
  async _safeProbeAlive(pid) {
    const probe =
      this.probeAlive ??
      (this.killProc === defaultKillProc ? defaultProbeAlive : (p) => this.killProc(p, 0));
    try {
      const r = await probe(pid);
      return typeof r === "boolean" ? r : null;
    } catch {
      return null;
    }
  }

  async _safeCwd(pid) {
    try {
      return await this.lsofCwd(pid);
    } catch {
      return null;
    }
  }

  /**
   * _safeCwdBatch — CTL-1531. Resolve many cwds at once, returning a Map that is
   * AUTHORITATIVE for every requested pid: each is pre-seeded to null (unknown →
   * spare) and only overwritten by a real string answer. That pre-seed is what
   * stops the caller from silently falling back to a per-pid execFile for the
   * ~20% of pids lsof cannot read — which would reintroduce the exact spawn
   * storm this fix exists to remove.
   *
   * A total batch failure (throw / timeout / no batch seam available) therefore
   * degrades to "every cwd unknown" ⇒ the sweep kills nothing. Fail closed.
   */
  async _safeCwdBatch(pids) {
    const out = new Map();
    const unique = [
      ...new Set(
        (Array.isArray(pids) ? pids : []).map((p) => Number(p)).filter((p) => Number.isFinite(p) && p > 0)
      ),
    ];
    if (unique.length === 0) return out;
    for (const p of unique) out.set(p, null);

    if (typeof this.lsofCwdBatch !== "function") {
      // No batch seam (a test injected only the single-pid seam) → per-pid.
      for (const p of unique) out.set(p, await this._safeCwd(p));
      return out;
    }
    try {
      const res = await this.lsofCwdBatch(unique);
      const entries = res instanceof Map ? res.entries() : Object.entries(res ?? {});
      for (const [k, v] of entries) {
        const pid = Number(k);
        if (out.has(pid)) out.set(pid, typeof v === "string" && v ? v : null);
      }
    } catch (err) {
      this.log.warn(
        { err: err?.message, pids: unique.length },
        "proc-reaper: batched cwd probe failed — treating every cwd as unknown (sweep spares all)"
      );
    }
    return out;
  }

  // CTL-1531 — "does this cwd path still exist?", normalized to true|false|null.
  // A throw, or any non-boolean answer, becomes null = UNKNOWN, and classifyProc
  // spares on unknown. Fail closed by construction.
  async _safeCwdExists(path) {
    try {
      const r = await this.cwdExists(path);
      return typeof r === "boolean" ? r : null;
    } catch {
      return null;
    }
  }

  // PARITY: root-absent-bail — "is the worktree root itself present?", normalized
  // to true|false|null. Only `true` lets the widened class run this sweep.
  async _safeWorktreeRootExists(root) {
    if (typeof root !== "string" || !root) return false;
    try {
      const r = await this.worktreeRootExists(root);
      return typeof r === "boolean" ? r : null;
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
