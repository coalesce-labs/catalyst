// reaper.mjs — single reconciler for reap-intent events (CTL-649 Phase 4).
//
// Consumes events of the shape:
//   {"event": "phase.<kind>.reap-requested", ...}
//   {"event": "worktree.presweep.reap-requested", ...}
//   {"event": "pr.merged.cleanup-requested", ...}
//   {"event": "orphans.reap-requested"}
// and invokes the appropriate local executor: `claude stop`, `git worktree
// remove`, `git branch -D`. Re-emits `*.reap-complete` or `*.reap-failed`
// echoes so consumers (operators, audit CLIs, future cloud-managed-agents
// reconciler) can observe completion deterministically.
//
// Why this seam: producers stay simple (append one line); when the cloud-
// managed-agents port lands, only the executors here swap to control-plane
// APIs. The schema, the producers, and the consumer count are all stable.

import { spawnSync, execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { shortIdFromSessionId, isSelfSession } from "./claude-ids.mjs";
import { emitReapIntent, REAP_INTENT_TYPES } from "./reap-intent.mjs";
import { log } from "./config.mjs";

const CLAUDE_BIN = process.env.CATALYST_DISPATCH_CLAUDE_BIN || "claude";
const DEDUPE_WINDOW_MS = Number(process.env.REAPER_DEDUPE_WINDOW_MS) || 60_000;

/**
 * Reaper — composes injectable executors so the unit test never shells out.
 * Production wiring uses the defaults; tests pass fakes.
 */
export class Reaper {
  constructor({
    executorReap = defaultExecutorReap,
    agents = defaultAgents,
    emit = defaultEmit,
    gitWorktreeRemove = defaultGitWorktreeRemove,
    gitBranchDelete = defaultGitBranchDelete,
    cwdExists = defaultCwdExists,
    log: logger = log,
  } = {}) {
    this.executorReap = executorReap;
    this.agents = agents;
    this.emit = emit;
    this.gitWorktreeRemove = gitWorktreeRemove;
    this.gitBranchDelete = gitBranchDelete;
    this.cwdExists = cwdExists;
    this.log = logger;
    this._inflight = new Map(); // key → expiresAt
  }

  _isDuplicate(key) {
    const now = Date.now();
    // Reap stale entries (lazy GC keeps memory bounded over long daemon uptime).
    for (const [k, expires] of this._inflight) {
      if (expires < now) this._inflight.delete(k);
    }
    if (this._inflight.has(key)) return true;
    this._inflight.set(key, now + DEDUPE_WINDOW_MS);
    return false;
  }

  async handle(event) {
    if (!event || typeof event.event !== "string") return;
    if (!event.event.endsWith(".reap-requested") && event.event !== "orphans.reap-requested" &&
        event.event !== "pr.merged.cleanup-requested") {
      return;
    }
    const key = `${event.event}:${event.bg_job_id ?? event.worktree_path ?? "scan"}`;
    if (this._isDuplicate(key)) return;

    try {
      switch (event.event) {
        case "phase.yield.reap-requested":
        case "phase.predecessor.reap-requested":
        case "phase.supersede.reap-requested":
        case "phase.revive.reap-requested":
        case "phase.abort.reap-requested":
          await this._handleBgReap(event);
          break;
        case "worktree.presweep.reap-requested":
          await this._handleWorktreePresweep(event);
          break;
        case "pr.merged.cleanup-requested":
          await this._handlePrMergedCleanup(event);
          break;
        case "orphans.reap-requested":
          await this._handleOrphansSweep(event);
          break;
        default:
          this.log.warn({ event: event.event }, "reaper: unknown reap-intent event");
      }
    } catch (err) {
      this.log.error({ err: err.message, event: event.event }, "reaper: handler threw");
    }
  }

  async _handleBgReap(event) {
    const bgJobId = event.bg_job_id;
    if (!bgJobId) return;
    if (isSelfSession(bgJobId)) return; // never reap the controlling session

    const live = await this.agents();
    const target = live.find((a) => {
      try {
        return shortIdFromSessionId(a.sessionId) === shortIdFromSessionId(bgJobId);
      } catch {
        return false;
      }
    });
    if (!target) return; // already gone, no-op
    // TODO(CTL-619): replace status==="idle" check with pidAlive+state.json
    // freshness once CTL-619's primitive lands. Conservative until then —
    // we never reap a session reporting `active`.
    if (target.status !== "idle") {
      this.log.info({ bgJobId, status: target.status }, "reaper: skipping non-idle session");
      return;
    }

    let shortId;
    try {
      shortId = shortIdFromSessionId(bgJobId);
    } catch {
      return;
    }
    const result = await this.executorReap(shortId);
    const echoSuffix = result.ok ? "reap-complete" : "reap-failed";
    const echoEvent = event.event.replace("reap-requested", echoSuffix);
    await this.emit(echoEvent, {
      ticket: event.ticket,
      phase: event.phase,
      bgJobId,
      worktreePath: event.worktree_path,
      ...(result.error ? { reason: result.error } : {}),
    });
  }

  async _handleWorktreePresweep(event) {
    if (!event.worktree_path) return;
    const live = await this.agents();
    const sessions = live.filter(
      (a) => a.cwd && a.cwd.startsWith(event.worktree_path),
    );
    for (const s of sessions) {
      let shortId;
      try {
        shortId = shortIdFromSessionId(s.sessionId);
      } catch {
        continue;
      }
      if (isSelfSession(s.sessionId)) continue;
      // Active sessions stay safe until CTL-619.
      if (s.status !== "idle") continue;
      await this.executorReap(shortId);
    }
  }

  async _handlePrMergedCleanup(event) {
    if (!event.worktree_path) return;
    // 1. Presweep first — the worktree-remove step requires no live sessions.
    await this._handleWorktreePresweep({ worktree_path: event.worktree_path });
    // 2. Remove worktree.
    const wt = await this.gitWorktreeRemove(event.worktree_path);
    if (!wt.ok) {
      await this.emit("pr.merged.cleanup-failed", {
        ticket: event.ticket,
        worktreePath: event.worktree_path,
        branch: event.branch,
        reason: wt.error,
      });
      return;
    }
    // 3. Delete local branch.
    if (event.branch) {
      await this.gitBranchDelete(event.branch);
    }
    await this.emit("pr.merged.cleanup-complete", {
      ticket: event.ticket,
      worktreePath: event.worktree_path,
      branch: event.branch,
    });
  }

  async _handleOrphansSweep(_event) {
    await this.scanOrphans();
  }

  /**
   * scanOrphans — find sessions whose cwd no longer exists and emit one
   * `phase.abort.reap-requested` per orphan. Reconciler then handles each
   * via the standard bg-reap path. Public so the daemon timer can call it
   * directly without round-tripping through the event log on every tick.
   */
  async scanOrphans() {
    const live = await this.agents();
    for (const a of live) {
      if (!a.sessionId || !a.cwd) continue;
      if (isSelfSession(a.sessionId)) continue;
      if (a.status !== "idle") continue;
      const exists = await this.cwdExists(a.cwd);
      if (exists) continue;
      let shortId;
      try {
        shortId = shortIdFromSessionId(a.sessionId);
      } catch {
        continue;
      }
      await this.emit("phase.abort.reap-requested", {
        bgJobId: shortId,
        worktreePath: a.cwd,
        reason: "orphan-cwd-missing",
      });
    }
  }

  /**
   * bootReplay — on daemon startup, scan the current month's event log for
   * `*.reap-requested` entries with no matching `*.reap-complete` echo and
   * replay them. Bounds graceful-degradation behaviour: if the daemon was
   * down when a yield happened, the intent gets reaped on next boot.
   *
   * Skips when log is missing or unreadable — never throws.
   */
  async bootReplay(eventLogPath) {
    if (!existsSync(eventLogPath)) return;
    let content;
    try {
      content = readFileSync(eventLogPath, "utf8");
    } catch {
      return;
    }
    const events = [];
    for (const line of content.split("\n")) {
      if (!line) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        /* malformed line — skip */
      }
    }
    const completed = new Set();
    for (const e of events) {
      const evt = e.event;
      if (!evt) continue;
      if (evt.endsWith(".reap-complete") || evt.endsWith(".cleanup-complete")) {
        const reqEvt = evt.replace(/\.reap-complete$/, ".reap-requested")
                          .replace(/\.cleanup-complete$/, ".cleanup-requested");
        completed.add(`${reqEvt}:${e.bg_job_id ?? e.worktree_path ?? "scan"}`);
      }
    }
    for (const e of events) {
      const evt = e.event;
      if (!evt) continue;
      const isIntent =
        evt.endsWith(".reap-requested") || evt === "pr.merged.cleanup-requested";
      if (!isIntent) continue;
      const key = `${evt}:${e.bg_job_id ?? e.worktree_path ?? "scan"}`;
      if (completed.has(key)) continue;
      await this.handle(e);
    }
  }
}

// ─── Default executors ──────────────────────────────────────────────────────
// Pure side-effect wrappers — never throw, always return {ok, error?}.

async function defaultExecutorReap(shortId) {
  try {
    const res = spawnSync(CLAUDE_BIN, ["stop", shortId], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if ((res.status ?? 0) === 0) return { ok: true };
    return { ok: false, error: res.stderr?.trim() || `claude stop rc=${res.status}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function defaultAgents() {
  try {
    const out = execFileSync(CLAUDE_BIN, ["agents", "--json"], { encoding: "utf8" });
    return JSON.parse(out);
  } catch {
    return [];
  }
}

async function defaultEmit(eventType, fields) {
  try {
    return await emitReapIntent(eventType, fields);
  } catch (err) {
    if (!REAP_INTENT_TYPES.includes(eventType)) {
      // Echo events are not in the closed-vocab list; fall back to direct append.
      const { getEventLogPath } = await import("./config.mjs");
      const { appendFileSync, mkdirSync } = await import("node:fs");
      const { dirname } = await import("node:path");
      const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      const payload = { ts, event: eventType, ...mapFields(fields) };
      const logPath = getEventLogPath();
      try {
        mkdirSync(dirname(logPath), { recursive: true });
        appendFileSync(logPath, JSON.stringify(payload) + "\n");
      } catch {
        /* best-effort */
      }
      return;
    }
    throw err;
  }
}

function mapFields(fields = {}) {
  const map = {
    ticket: "ticket",
    phase: "phase",
    bgJobId: "bg_job_id",
    worktreePath: "worktree_path",
    sessionId: "session_id",
    branch: "branch",
    reason: "reason",
  };
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === "") continue;
    out[map[k] ?? k] = v;
  }
  return out;
}

async function defaultGitWorktreeRemove(path) {
  try {
    const res = spawnSync("git", ["worktree", "remove", path], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if ((res.status ?? 0) === 0) return { ok: true };
    return { ok: false, error: res.stderr?.trim() || `git worktree remove rc=${res.status}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function defaultGitBranchDelete(branch) {
  try {
    const res = spawnSync("git", ["branch", "-D", branch], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if ((res.status ?? 0) === 0) return { ok: true };
    return { ok: false, error: res.stderr?.trim() || `git branch -D rc=${res.status}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function defaultCwdExists(path) {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}
