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
import { lastSeenMsForSession } from "./session-recency.mjs";
import { log } from "./config.mjs";

const CLAUDE_BIN = process.env.CATALYST_DISPATCH_CLAUDE_BIN || "claude";
const DEDUPE_WINDOW_MS = Number(process.env.REAPER_DEDUPE_WINDOW_MS) || 60_000;
const DEFAULT_MIN_IDLE_MS = 15 * 60 * 1000; // 15 min

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
    // CTL-649 safety guards:
    //  - includeInteractive: opt-in to reaping interactive (human) sessions.
    //    Default false — the daemon never opts in, so a stepped-away human
    //    window is never auto-reaped.
    //  - minIdleMs: recency floor for the periodic sweep — a session whose
    //    transcript was touched within this window is "still in use".
    //  - lastSeenMs: injectable transcript-mtime probe (tests pass a fake).
    includeInteractive = false,
    minIdleMs = DEFAULT_MIN_IDLE_MS,
    lastSeenMs = (sessionId) => lastSeenMsForSession(sessionId),
    log: logger = log,
  } = {}) {
    this.executorReap = executorReap;
    this.agents = agents;
    this.emit = emit;
    this.gitWorktreeRemove = gitWorktreeRemove;
    this.gitBranchDelete = gitBranchDelete;
    this.cwdExists = cwdExists;
    this.includeInteractive = includeInteractive;
    this.minIdleMs = minIdleMs;
    this.lastSeenMs = lastSeenMs;
    this.log = logger;
    this._inflight = new Map(); // key → expiresAt
  }

  // `claude agents --json` reports `.kind` as "interactive" | "background".
  // Older/edge builds may omit it (undefined/null) — callers decide how to
  // treat the ambiguous case.
  _isInteractive(s) {
    return s?.kind === "interactive";
  }

  _isBackground(s) {
    return s?.kind === "background";
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
        // CTL-661 hole #3: single-target stop of a reclaimed (genuinely-hung)
        // worker on the recovery happy path. Busy-OK, like the others.
        case "phase.reclaim.reap-requested":
        // CTL-661 hole #4: single-target stop of a non-canonical live bg session
        // identified by the per-ticket reconciliation sweep.
        case "phase.reconcile.reap-requested":
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
    // CTL-649 kind guard: an explicit single-target intent (yield/supersede/
    // predecessor/revive/abort) is authoritative — a producer already decided
    // this specific bg worker must die — so NO recency gate here. But never
    // reap an interactive (human) session unless explicitly opted in. We skip
    // ONLY when kind is explicitly "interactive"; an absent/unknown kind on a
    // protocol-targeted bg worker is still reaped (avoids regressing the leak
    // fix if `claude` ever omits `.kind` for a bg session).
    if (this._isInteractive(target) && !this.includeInteractive) {
      this.log.info({ bgJobId }, "reaper: skipping interactive session");
      return;
    }
    // CTL-657: NO idle gate here. A single-target intent (yield/predecessor/
    // supersede/revive/abort) is authoritative — the producer already decided
    // this specific bg worker must die. A phase worker is almost always still
    // `busy` finishing its last turn at the moment its successor's dispatch
    // emits the predecessor reap, so the pre-CTL-657 `status !== "idle"` skip
    // dropped the stop and never retried (the de-dupe at :93 consumes the event
    // once) — the worker went idle seconds later and lingered forever (0
    // reap-complete events ever; 35-session/28GB pileup). `claude stop` works
    // on a busy session, so stop it regardless of busy/idle. The idle gate
    // survives ONLY on the periodic orphan sweep + worktree presweep, which
    // enumerate ALL sessions and so must stay conservative.

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

  /**
   * Stop every idle session whose cwd is under the worktree. Returns the count
   * of sessions that remain live (non-idle, so we declined to stop them, or a
   * stop that failed) — callers gating worktree removal on "no live session"
   * use this to avoid a second agents() shell-out.
   */
  async _handleWorktreePresweep(event) {
    if (!event.worktree_path) return 0;
    const wt = stripTrailingSlash(event.worktree_path);
    const live = await this.agents();
    const sessions = live.filter((a) => cwdUnder(a.cwd, wt));
    let unstoppable = 0;
    for (const s of sessions) {
      let shortId;
      try {
        shortId = shortIdFromSessionId(s.sessionId);
      } catch {
        continue;
      }
      if (isSelfSession(s.sessionId)) continue;
      // CTL-649 kind guard: an interactive (human) session in the worktree is
      // never auto-stopped (unless opted in) AND counts as unstoppable, so a
      // downstream worktree-remove refuses rather than yanking a live
      // interactive cwd out from under the user. Worktree teardown is
      // authoritative, so NO recency gate.
      if (this._isInteractive(s) && !this.includeInteractive) {
        this.log.info({ sessionId: s.sessionId }, "reaper: skipping interactive session");
        unstoppable++;
        continue;
      }
      // Active sessions stay safe until CTL-619 — and they count as still-live
      // so a downstream worktree-remove can refuse rather than yank a live cwd.
      if (s.status !== "idle") {
        unstoppable++;
        continue;
      }
      const res = await this.executorReap(shortId);
      if (!res || !res.ok) unstoppable++;
    }
    return unstoppable;
  }

  async _handlePrMergedCleanup(event) {
    if (!event.worktree_path) return;
    // 1. Presweep first — the worktree-remove step requires no live sessions.
    const stillLive = await this._handleWorktreePresweep({
      worktree_path: event.worktree_path,
    });
    // 1a. Mirror worktree-presweep.sh: never yank a worktree out from under a
    //     session we could not stop (non-idle/active). Removing it would
    //     re-introduce the orphan race this protocol exists to close.
    if (stillLive > 0) {
      await this.emit("pr.merged.cleanup-failed", {
        ticket: event.ticket,
        worktreePath: event.worktree_path,
        branch: event.branch,
        reason: "sessions-still-live",
      });
      return;
    }
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
    // 3. Delete local branch. `force` is set only for a confirmed-MERGED PR
    //    (squash-merges are invisible to `git branch -d`, so they need `-D`);
    //    for closed/abandoned/stale the non-force `-d` refuses to drop unmerged
    //    commits, surfacing the refusal in the echo instead of vanishing them.
    let branchDeleted = true;
    let branchDeleteError;
    if (event.branch) {
      const del = await this.gitBranchDelete(event.branch, event.force === true);
      if (!del.ok) {
        branchDeleted = false;
        branchDeleteError = del.error;
      }
    }
    await this.emit("pr.merged.cleanup-complete", {
      ticket: event.ticket,
      worktreePath: event.worktree_path,
      branch: event.branch,
      // Truthfully reflect that the branch was NOT deleted — the worktree is
      // already gone, so we still complete, but consumers must see the refusal.
      ...(branchDeleted
        ? {}
        : { branchDeleted: false, branchDeleteError }),
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
      // CTL-649 kind guard: the periodic sweep enumerates ALL live sessions —
      // it can see the user's interactive windows — so it is strict
      // background-ONLY. Skip interactive AND unknown/null kinds: never
      // auto-reap an ambiguous session. (includeInteractive relaxes this.)
      if (!this.includeInteractive && !this._isBackground(a)) {
        this.log.info(
          { sessionId: a.sessionId, kind: a.kind ?? null },
          "reaper: skipping interactive session",
        );
        continue;
      }
      const exists = await this.cwdExists(a.cwd);
      if (exists) continue;
      // CTL-649 recency guard: even with a missing cwd, a session whose
      // transcript was touched within minIdleMs is still in use — skip it. A
      // null lastSeen (no transcript found) does NOT block reaping.
      const seen = this.lastSeenMs(a.sessionId);
      if (seen !== null && seen < this.minIdleMs) {
        this.log.info(
          {
            sessionId: a.sessionId,
            lastSeenS: Math.round(seen / 1000),
            minIdleS: Math.round(this.minIdleMs / 1000),
          },
          `reaper: skipping recently-active session (last_seen ${Math.round(seen / 1000)}s < min ${Math.round(this.minIdleMs / 1000)}s)`,
        );
        continue;
      }
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

// ─── Pure path helpers ───────────────────────────────────────────────────────

/** Drop a single trailing slash so boundary matching is exact. */
function stripTrailingSlash(p) {
  return typeof p === "string" && p.length > 1 && p.endsWith("/")
    ? p.slice(0, -1)
    : p;
}

/**
 * Boundary-safe "is cwd inside this worktree?" — `/wt/CTL-64` must NOT match a
 * sibling `/wt/CTL-649`. Either an exact match or a real path-segment boundary.
 */
function cwdUnder(cwd, worktree) {
  if (!cwd || !worktree) return false;
  return cwd === worktree || cwd.startsWith(worktree + "/");
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
      } catch (appendErr) {
        // A dropped *.cleanup-complete / *.reap-complete echo makes bootReplay
        // re-reap on next boot (it keys replay-skip on the echo's presence), so
        // an unwritable log must be loud, not silently best-effort.
        log.error(
          { err: appendErr.message, eventType },
          "reaper: echo append failed",
        );
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

async function defaultGitBranchDelete(branch, force = false) {
  try {
    // `-D` force-deletes even unmerged branches; reserve it for confirmed
    // MERGED PRs (squash-merge is invisible to `-d`). Otherwise `-d` refuses
    // to drop a branch with unmerged commits, surfacing the refusal as {ok:false}.
    const flag = force ? "-D" : "-d";
    const res = spawnSync("git", ["branch", flag, branch], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if ((res.status ?? 0) === 0) return { ok: true };
    return { ok: false, error: res.stderr?.trim() || `git branch ${flag} rc=${res.status}` };
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
