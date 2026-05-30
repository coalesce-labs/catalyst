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

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { scanEventsChunked } from "./event-tail.mjs";
import { shortIdFromSessionId, isSelfSession } from "./claude-ids.mjs";
import { emitReapIntent, REAP_INTENT_TYPES } from "./reap-intent.mjs";
import { lastSeenMsForSession } from "./session-recency.mjs";
import { getAgentsCached } from "./claude-agents.mjs";
import { log } from "./config.mjs";

const CLAUDE_BIN = process.env.CATALYST_DISPATCH_CLAUDE_BIN || "claude";
const DEDUPE_WINDOW_MS = Number(process.env.REAPER_DEDUPE_WINDOW_MS) || 60_000;
const DEFAULT_MIN_IDLE_MS = 15 * 60 * 1000; // 15 min

// CTL-661 Phase 5 — the per-ticket reconciler's spawn-grace window. A revive or
// advance reassigns a ticket's bg_job_id to a fresh successor; for a brief
// window two background sessions co-exist by design while the new one takes
// over the signal. The reconciler must grant that window so it never stops a
// legitimate freshly-spawned successor mid-handoff.
//
// ─── Three DISTINCT time constants — do NOT conflate (research called this out) ───
//   • STALE_MS          (recovery.mjs, 5 min)  — dead-detection: a state.json
//                         quiet longer than this is *candidate*-dead.
//   • minIdleMs         (this file, 15 min)    — periodic-sweep recency floor:
//                         a transcript touched within this is "still in use".
//   • CLEANUP_GRACE_MS  (this file, 60 s)      — reconciler spawn-grace: a
//                         non-canonical session younger than this is a likely
//                         just-spawned successor; spare it this tick.
// DEDUPE_WINDOW_MS (60 s) coincidentally shares the grace's magnitude but serves
// a different role (suppress re-emitting the same intent), so they are kept as
// separate named constants.
export const CLEANUP_GRACE_MS = 60_000;

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
    // CTL-661 hole #4: per-ticket reconciliation seams.
    //  - readActivePhaseSignal(ticket): the ticket's authoritative active-phase
    //    signal { bg_job_id, phase } | null, used to pick the canonical owner.
    //    Default returns null so the sweep falls back to newest-by-last_seen;
    //    the daemon injects a real orchDir-backed reader.
    //  - now: injectable clock for the Phase-5 cleanup-grace skip.
    readActivePhaseSignal = () => null,
    now = () => Date.now(),
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
    this.readActivePhaseSignal = readActivePhaseSignal;
    this.now = now;
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
        // CTL-695: terminal-worker reap — same authoritative single-target
        // (busy-OK) path as predecessor/yield/supersede/revive/abort.
        case "phase.terminal.reap-requested":
          await this._handleBgReap(event);
          break;
        // CTL-661 hole #4: the reconcile event is dual-purpose, disambiguated by
        // bg_job_id. With a target it is a per-session stop (the sweep's own
        // emit, round-tripped through the log) → _handleBgReap. Without one it is
        // the periodic timer's TRIGGER → run the per-ticket reconciliation sweep.
        case "phase.reconcile.reap-requested":
          if (event.bg_job_id) await this._handleBgReap(event);
          else await this._handleReconcile(event);
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

  // CTL-661 hole #4: trigger handler for the periodic reconcile tick.
  async _handleReconcile(_event) {
    await this.reconcileTicketWorkers();
  }

  /**
   * reconcileTicketWorkers — enforce one-live-bg-worker-per-ticket. Group live
   * `background` sessions by the ticket derived from their worktree cwd; for any
   * ticket with >1 live session, keep the canonical owner (the active-phase
   * signal's bg_job_id, else newest-by-last_seen) and emit a
   * `phase.reconcile.reap-requested` for every other live session — except those
   * younger than CLEANUP_GRACE_MS (a likely just-spawned successor still taking
   * over the signal; the next tick re-evaluates). Interactive/unknown-kind
   * sessions and sessions outside a recognizable worktree are never reconciled.
   */
  async reconcileTicketWorkers() {
    const live = await this.agents();
    const groups = groupBackgroundSessionsByTicket(live);
    for (const [ticket, sessions] of groups) {
      if (sessions.length <= 1) continue; // single live session → nothing to do
      const signal = this.readActivePhaseSignal(ticket);
      const dominantPhase = signal?.phase ?? null;
      const canonical = this._resolveCanonical(ticket, sessions, signal);
      if (!canonical) continue;
      let canonicalShortId;
      try {
        canonicalShortId = shortIdFromSessionId(canonical.sessionId);
      } catch {
        continue; // can't name the keeper safely → leave the whole group alone
      }
      for (const s of sessions) {
        if (s === canonical) continue;
        if (isSelfSession(s.sessionId)) continue; // never reap the controller
        let shortId;
        try {
          shortId = shortIdFromSessionId(s.sessionId);
        } catch {
          continue;
        }
        // Phase 5 — spawn-grace skip: a non-canonical session whose recency proxy
        // is within CLEANUP_GRACE_MS is likely a just-spawned successor still
        // taking over the signal. Spare it; the next tick re-evaluates. A null
        // proxy (no transcript) does NOT spare it.
        const seen = this.lastSeenMs(s.sessionId);
        if (seen !== null && seen !== undefined && seen < CLEANUP_GRACE_MS) {
          this.log.info(
            { ticket, sessionId: s.sessionId, lastSeenS: Math.round(seen / 1000) },
            "reaper: reconcile sparing freshly-spawned session (within cleanup grace)",
          );
          continue;
        }
        await this.emit("phase.reconcile.reap-requested", {
          ticket,
          phase: dominantPhase,
          bgJobId: shortId,
          worktreePath: s.cwd,
          canonicalBgJobId: canonicalShortId,
          dominantPhase,
          reason: "ctl-661-one-worker-per-ticket",
        });
      }
    }
  }

  /**
   * _resolveCanonical — pick the live session to KEEP for a ticket group.
   *   1. the session whose shortId matches the active-phase signal's bg_job_id;
   *   2. else the newest session by last_seen (smallest age);
   *   3. else (no signal, every last_seen null) the first-enumerated, + log.
   */
  _resolveCanonical(ticket, sessions, signal) {
    if (signal?.bg_job_id) {
      let target;
      try {
        target = shortIdFromSessionId(signal.bg_job_id);
      } catch {
        target = null;
      }
      if (target) {
        const match = sessions.find((s) => {
          try {
            return shortIdFromSessionId(s.sessionId) === target;
          } catch {
            return false;
          }
        });
        if (match) return match;
      }
    }
    // Newest-by-last_seen: lastSeenMs is an AGE (ms since last activity), so the
    // most recently active session has the SMALLEST value.
    let best = null;
    let bestSeen = Infinity;
    for (const s of sessions) {
      const seen = this.lastSeenMs(s.sessionId);
      if (seen === null || seen === undefined) continue;
      if (seen < bestSeen) {
        bestSeen = seen;
        best = s;
      }
    }
    if (best) return best;
    this.log.info(
      { ticket },
      "reaper: reconcile canonical fallback — no signal, no last_seen; keeping first-enumerated",
    );
    return sessions[0] ?? null;
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
    // CTL-673: stream the log in bounded chunks and retain ONLY reap-relevant
    // events, so a 183 MB / ~297K-line log never materializes into a whole-file
    // string + array at boot. scanEventsChunked swallows open/stat errors
    // (returns a no-op result) and skips malformed lines via parseEventTailChunk,
    // preserving the old `catch { return; }` best-effort behavior.
    const events = [];
    scanEventsChunked({
      path: eventLogPath,
      fromOffset: 0,
      onEvent: (e) => {
        const evt = e?.event;
        if (typeof evt !== "string") return;
        if (
          evt.endsWith(".reap-requested") ||
          evt.endsWith(".reap-complete") ||
          evt.endsWith(".cleanup-complete") ||
          evt === "pr.merged.cleanup-requested"
        ) {
          events.push(e); // retain ONLY reap-relevant events — bounds peak memory
        }
      },
    });
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

/**
 * ticketFromCwd — derive a ticket id from a worktree cwd (CTL-661 hole #4).
 * Worktrees follow the `…/wt/<TICKET>` convention, so the basename IS the
 * ticket. Grouping by basename is boundary-safe by construction: `/wt/CTL-64`
 * and `/wt/CTL-649` yield the distinct keys `CTL-64` / `CTL-649`. Returns null
 * for an empty/unusable cwd so the reconciler never reaps on a guess.
 */
export function ticketFromCwd(cwd) {
  if (!cwd || typeof cwd !== "string") return null;
  const base = stripTrailingSlash(cwd).split("/").filter(Boolean).pop();
  return base || null;
}

/**
 * groupBackgroundSessionsByTicket — bucket live `background` sessions by the
 * ticket their cwd resolves to (CTL-661 hole #4). Interactive/unknown-kind
 * sessions, sessions without a sessionId/cwd, and sessions outside a
 * recognizable worktree are dropped — never counted, never reaped. Returns a
 * Map<ticket, sessions[]> preserving enumeration order within each group.
 */
export function groupBackgroundSessionsByTicket(live) {
  const groups = new Map();
  for (const s of live ?? []) {
    if (!s || !s.sessionId || !s.cwd) continue;
    if (s.kind !== "background") continue; // interactive/unknown never reconciled
    const ticket = ticketFromCwd(s.cwd);
    if (!ticket) continue;
    if (!groups.has(ticket)) groups.set(ticket, []);
    groups.get(ticket).push(s);
  }
  return groups;
}

/**
 * defaultReadActivePhaseSignal — production reader for the reconciler's
 * canonical-owner resolution (CTL-661 hole #4). Reads
 * <orchDir>/workers/<ticket>/phase-*.json and returns { bg_job_id, phase } for
 * the active worker: the `running` signal, else the newest by updatedAt. Returns
 * null when the worker dir is absent or no signal carries a bg_job_id. Best-
 * effort — never throws. The daemon binds `orchDir` and injects the bound form.
 */
export function defaultReadActivePhaseSignal(orchDir, ticket, { readDir = readdirSync, readFile = readFileSync } = {}) {
  if (!orchDir || !ticket) return null;
  const dir = join(orchDir, "workers", ticket);
  let files;
  try {
    files = readDir(dir).filter((f) => f.startsWith("phase-") && f.endsWith(".json"));
  } catch {
    return null;
  }
  let best = null;
  let bestRank = -1;
  for (const f of files) {
    let sig;
    try {
      sig = JSON.parse(readFile(join(dir, f), "utf8"));
    } catch {
      continue;
    }
    if (!sig?.bg_job_id) continue;
    const running = sig.status === "running" ? 1 : 0;
    const ts = Date.parse(sig.updatedAt ?? sig.startedAt ?? "") || 0;
    const rank = running * 1e15 + ts; // prefer running, then newest
    if (rank > bestRank) {
      bestRank = rank;
      best = sig;
    }
  }
  return best ? { bg_job_id: best.bg_job_id, phase: best.phase } : null;
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

// CTL-731: the reaper runs on the shared daemon event loop alongside the
// scheduler. Pre-CTL-731 it shelled out `claude agents --json` SYNCHRONOUSLY
// here every pass — and under heavy session load (many duplicate workers) that
// call balloons to multiple seconds, blocking the loop and starving the
// scheduler tick (a self-sustaining wedge: dupes make `claude agents` slow → the
// sync read blocks the loop → the scheduler can't tick → can't reclaim the dupes).
// Route it through the warm, never-blocking snapshot instead — the same primitive
// the scheduler/autotune/wait-watcher use. Returns last-good synchronously and
// fires a background refresh when stale; never spawns on the calling thread.
export async function defaultAgents() {
  return getAgentsCached().agents;
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
