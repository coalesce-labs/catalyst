// unstuck-sweep.mjs — CTL-1064 classify-then-act deep-dive sweep for
// stalled/needs-human ticket backlog.
//
// Peer module to stall-janitor.mjs. While the janitor handles process hygiene
// (J1 orphan worktrees, J2 ghost sessions, J3 prior-artifact retries), this
// sweep classifies the stalled/needs-human *ticket* backlog — rebase stalls,
// source-conflict stalls, orphan-sweep-stale signals, and stale attention
// labels on terminal tickets — and mechanically clears whitelisted categories.
//
// Architecture mirrors CTL-729 watchdog: PURE classifiers (no IO, all evidence
// injected) + an action driver (runUnstuckSweepPass — every side-effect seam
// injected). Runs as a low-frequency throttled Pass 0u (default 15 min).
// Ships with mode='off'; operators roll out via shadow → enforce.

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { log, getEventLogPath } from "./config.mjs";
import { UNSTUCK_SWEEP_EVENT_TYPES } from "./unstuck-sweep-event-types.mjs";

export { UNSTUCK_SWEEP_EVENT_TYPES };

export const UNSTUCK_SWEEP_INTENT_KIND = "unstuck-sweep";

// emitUnstuckEvent — dedicated unified-log emitter for the unstuck-sweep
// vocabulary (CTL-1064). The sweep owns UNSTUCK_SWEEP_EVENT_TYPES and MUST NOT
// route through emitReapIntent: reap-intent.mjs's vocabulary is closed and
// deliberately EXCLUDES unstuck.* (unstuck-sweep-event-types.mjs §"What We're
// NOT Doing"). Passing an unstuck.* type to emitReapIntent throws "unknown
// reap-intent event type"; because the sweep's emit is fire-and-forget, that
// rejected promise was swallowed by runUnstuckSweepPass's fire() p.catch and
// EVERY unstuck event (shadow would.* twins AND enforce cleared/pushed/
// emitted/escalated) was silently dropped — an operator in shadow mode saw zero
// events and would wrongly conclude the sweep found nothing. This emitter
// validates against the sweep's OWN closed list and appends to the same unified
// log getEventLogPath() resolves to. Best-effort on write failure (returns
// false; never throws on EACCES / disk full) — mirrors emitReapIntent.
export async function emitUnstuckEvent(eventType, fields = {}) {
  if (!UNSTUCK_SWEEP_EVENT_TYPES.includes(eventType)) {
    throw new Error(`unknown unstuck-sweep event type: ${eventType}`);
  }
  const payload = {
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    event: eventType,
  };
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === "") continue;
    payload[k] = v;
  }
  const line = JSON.stringify(payload) + "\n";
  const logPath = getEventLogPath();
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, line);
    return true;
  } catch (err) {
    log.error({ err: err?.message, eventType }, "emitUnstuckEvent: append failed (CTL-1064)");
    return false;
  }
}

// Named accessors over the frozen list — one per unstuck emit type. Indexing
// the frozen array keeps the strings in ONE place; a typo here is a load error.
const UNSTUCK_EVENT = Object.freeze({
  clearedNoise:          UNSTUCK_SWEEP_EVENT_TYPES[0],
  wouldClearNoise:       UNSTUCK_SWEEP_EVENT_TYPES[1],
  pushedForceWithLease:  UNSTUCK_SWEEP_EVENT_TYPES[2],
  wouldPush:             UNSTUCK_SWEEP_EVENT_TYPES[3],
  emittedPhaseComplete:  UNSTUCK_SWEEP_EVENT_TYPES[4],
  wouldEmitComplete:     UNSTUCK_SWEEP_EVENT_TYPES[5],
  clearedStaleLabel:     UNSTUCK_SWEEP_EVENT_TYPES[6],
  wouldClearLabel:       UNSTUCK_SWEEP_EVENT_TYPES[7],
  escalated:             UNSTUCK_SWEEP_EVENT_TYPES[8],
  wouldEscalate:         UNSTUCK_SWEEP_EVENT_TYPES[9],
});

// STALL_CATEGORY_MAP — routing table: stalledReason string → {category, action}.
// Unrecognized reasons fall through to {category:'unknown', action:'escalate'}.
// Empty-branch is NOT hardcoded here — unrecognized reasons route to escalate,
// and empty-branch is detected at runtime via commitsAhead.length === 0.
export const STALL_CATEGORY_MAP = Object.freeze({
  rebase_refused_dirty_tree:          { category: "dirty-tree",     action: "clear-noise-and-retry" },
  source_conflict_ctl708_unavailable: { category: "source-conflict", action: "force-push-if-clean" },
  "orphan-sweep-stale":               { category: "orphan-stale",   action: "emit-phase-complete-if-merged" },
  "remediate-cycle-cap-exhausted":    { category: "remediate-cap",  action: "escalate" },
  // CTL-1442 (Codex R5): a ticket parked by the no-progress escalation ask-cap
  // is ALREADY terminally escalated (needs-human + brief + final event) — the
  // unstuck sweep must stay quiet, not re-escalate it every interval (that
  // would recreate the ask loop through a different subsystem).
  "escalation-ask-cap":               { category: "skip",           action: "skip" },
});

// classifyStalledTicket — PURE top-level router (Phase 1). No IO.
// Evidence shape: { reason, liveSessionInWorktree, linearTerminal, ... }
// Returns { category, action } or { category:'skip', action:'skip', reason }.
export function classifyStalledTicket(evidence = {}) {
  if (evidence.liveSessionInWorktree) {
    return { category: "skip", action: "skip", reason: "live-session" };
  }
  if (evidence.linearTerminal) {
    return { category: "skip", action: "skip", reason: "linear-terminal" };
  }
  const mapped = STALL_CATEGORY_MAP[evidence.reason];
  if (mapped) return mapped;
  return { category: "unknown", action: "escalate" };
}

// defaultCollectUnstuckCandidates — dual-status census: reads BOTH
//   (status === 'stalled' && stalledReason) AND
//   (status === 'failed' && failureReason === 'orphan-sweep-stale')
// normalizing into a single evidence.reason. Per-candidate try/catch.
export function defaultCollectUnstuckCandidates({
  orchDir,
  readdirSync: readdir = readdirSync,
  readFileSync: readFile = readFileSync,
  agentsSnapshot = [],
  isLinearTerminal = () => false,
  resolveWorktreePath = () => null,
} = {}) {
  const out = [];
  let workerDirs;
  try {
    workerDirs = readdir(join(orchDir, "workers"), { withFileTypes: true });
  } catch {
    return out; // no workers dir → nothing to census
  }

  for (const d of workerDirs) {
    if (!d.isDirectory()) continue;
    const ticket = d.name;
    try {
      const workerDir = join(orchDir, "workers", ticket);
      let signalFiles;
      try {
        signalFiles = readdir(workerDir, { withFileTypes: true });
      } catch { continue; }

      for (const sf of signalFiles) {
        if (!sf.name.startsWith("phase-") || !sf.name.endsWith(".json")) continue;
        const signalPath = join(workerDir, sf.name);
        let signal;
        try {
          signal = JSON.parse(readFile(signalPath, "utf8"));
        } catch { continue; }

        // Accept both status shapes (CTL-1064 §Confirmed gaps).
        let reason = null;
        if (signal.status === "stalled" && signal.stalledReason) {
          reason = signal.stalledReason;
        } else if (signal.status === "failed" && signal.failureReason === "orphan-sweep-stale") {
          reason = "orphan-sweep-stale";
        } else {
          continue;
        }

        const phase = signal.phase ??
          sf.name.replace(/^phase-/, "").replace(/\.json$/, "");
        const worktreePath = resolveWorktreePath(ticket);

        const liveSessionInWorktree =
          worktreePath != null &&
          Array.isArray(agentsSnapshot) &&
          agentsSnapshot.some((a) => {
            if (!a?.cwd) return false;
            const strip = (p) => String(p).replace(/\/+$/, "");
            const c = strip(a.cwd);
            const r = strip(worktreePath);
            return c === r || c.startsWith(r + "/");
          });

        const linearTerminal = isLinearTerminal(ticket);

        out.push({
          ticket,
          phase,
          signal,
          workerDir,
          worktreePath,
          liveSessionInWorktree,
          linearTerminal,
          evidence: {
            reason,
            ticket,
            phase,
            signal,
            worktreePath,
            liveSessionInWorktree,
            linearTerminal,
          },
        });
      }
    } catch (err) {
      log.warn(
        { ticket, err: err?.message },
        "unstuck-sweep: candidate probe threw — skipping (CTL-1064)",
      );
    }
  }
  return out;
}

// buildAuditComment — assemble the three mandatory sections for a Linear mirror.
// Every enforce action posts a three-section comment: What was found / What was
// done / What was verified after.
export function buildAuditComment({ found, done, verified }) {
  return [
    "**What was found**",
    found ?? "_unavailable_",
    "",
    "**What was done**",
    done ?? "_unavailable_",
    "",
    "**What was verified after**",
    verified ?? "_unavailable_",
  ].join("\n");
}

// defaultPostUnstuckComment — post a three-section Linear comment + write the
// idempotency marker. Fail-open (logs, never throws). Guards existsSync on the
// worker dir before writing the marker (mirrors recovery.mjs:607).
export function defaultPostUnstuckComment(
  ticket,
  category,
  phase,
  commentBody,
  {
    runCommentPost = null,
    orchDir = null,
    existsSync: exists = existsSync,
    writeMarker = (p) => writeFileSync(p, ""),
  } = {},
) {
  if (!orchDir || !ticket || !phase) return;
  const workerDir = join(orchDir, "workers", ticket);
  if (!exists(workerDir)) return;
  const markerPath = join(workerDir, `.unstuck-comment-${category}-${phase}.applied`);
  if (exists(markerPath)) return; // idempotent — first-writer-wins
  try {
    const poster = runCommentPost ?? defaultRunCommentPost;
    const r = typeof poster === "function" ? poster(ticket, commentBody) : null;
    // Treat a null/undefined poster result as FAILURE (leave the marker absent
    // so the next pass retries) — mirrors recovery.mjs:596 (hardened under
    // CTL-835). The prior `!r || r.status === 0` wrote the idempotency marker on
    // a null result, permanently suppressing future comment attempts for this
    // ticket/phase/category even though nothing posted (CTL-1064).
    if (r && r.status === 0) {
      try {
        mkdirSync(workerDir, { recursive: true });
        writeMarker(markerPath);
      } catch (err) {
        log.warn({ ticket, category, phase, err: err?.message }, "unstuck-sweep: marker write failed (CTL-1064)");
      }
    } else {
      log.warn(
        { ticket, category, phase, status: r?.status },
        "unstuck-sweep: linear-comment-post failed (CTL-1064)",
      );
    }
  } catch (err) {
    log.warn({ ticket, category, phase, err: err?.message }, "unstuck-sweep: postComment threw (CTL-1064)");
  }
}

function defaultRunCommentPost(ticket, body) {
  const helperPath = join(
    process.env.PLUGIN_ROOT ?? process.cwd(),
    "scripts/lib/linear-comment-post.sh",
  );
  return spawnSync(helperPath, [ticket, body], { encoding: "utf8", timeout: 10_000 });
}

// _actionToEnforceEvent / _actionToShadowEvent — map decision.action → event type.
function _actionToEnforceEvent(action) {
  switch (action) {
    case "clear-noise-and-retry":         return UNSTUCK_EVENT.clearedNoise;
    case "force-push-if-clean":           return UNSTUCK_EVENT.pushedForceWithLease;
    case "emit-phase-complete-if-merged": return UNSTUCK_EVENT.emittedPhaseComplete;
    case "clear-label":                   return UNSTUCK_EVENT.clearedStaleLabel;
    default:                              return null;
  }
}

function _actionToShadowEvent(action) {
  switch (action) {
    case "clear-noise-and-retry":         return UNSTUCK_EVENT.wouldClearNoise;
    case "force-push-if-clean":           return UNSTUCK_EVENT.wouldPush;
    case "emit-phase-complete-if-merged": return UNSTUCK_EVENT.wouldEmitComplete;
    case "clear-label":                   return UNSTUCK_EVENT.wouldClearLabel;
    case "escalate":                      return UNSTUCK_EVENT.wouldEscalate;
    default:                              return null;
  }
}

// runUnstuckSweepPass — the action driver. All side-effect seams are injected.
// Returns { acted, wouldAct, escalated, wouldEscalate, skipped, failed }.
//
// Seam contract (simplified signatures — scheduler binds db/orchDir at wiring):
//   collectCandidates()                → [{ticket, phase, evidence, ...}]
//   classify(evidence)                 → {category, action, ...}
//   actByCategory[category](c, decision) → void (may throw; caught per-candidate)
//   escalate(c)                        → void (best-effort; caught per-candidate)
//   emit(type, fields)                 → Promise|void (fire-and-forget)
//   recordIntent(kind, subject)        → void (best-effort)
//   isIntentEffective(kind, subject)   → bool (true = still open+viable → skip)
//   postComment(ticket, category, phase) → void (best-effort; called after act)
//   logger                             → pino-compatible
export function runUnstuckSweepPass({
  mode,
  collectCandidates,
  classify = classifyStalledTicket,
  actByCategory = {},
  escalate = () => {},
  emit = async () => true,
  recordIntent = () => {},
  isIntentEffective = () => false,
  postComment = () => {},
  logger = log,
} = {}) {
  const report = {
    acted: [],
    wouldAct: [],
    escalated: [],
    wouldEscalate: [],
    skipped: [],
    failed: [],
  };

  // off → skip the pass entirely: no census, no events, no intents.
  if (mode === "off") return report;
  const enforce = mode === "enforce";

  // fire-and-forget emit: never await (so a slow append can't stall the loop),
  // never let a rejection escape (a thrown/rejecting emitter is logged, not fatal).
  const fire = (type, fields, ticket) => {
    try {
      const p = emit(type, fields);
      if (p && typeof p.catch === "function") {
        p.catch((err) =>
          logger.warn({ ticket, type, err: err?.message }, "unstuck-sweep: emit failed (CTL-1064)"),
        );
      }
    } catch (err) {
      // A SYNCHRONOUSLY-throwing emit seam must not abort the candidate loop —
      // re-throw to the per-candidate catch below.
      throw err;
    }
  };

  // Collect candidates — a throwing census degrades to empty (no abort).
  let candidates = [];
  try {
    candidates = collectCandidates() ?? [];
  } catch (err) {
    logger.warn({ err: err?.message }, "unstuck-sweep: census threw — skipping pass (CTL-1064)");
    return report;
  }

  for (const c of candidates) {
    try {
      const decision = classify(c.evidence ?? c);

      // skip — live session, linear-terminal, or classifier-level skip.
      if (decision.action === "skip") {
        report.skipped.push({ ticket: c.ticket, phase: c.phase, reason: decision.reason });
        continue;
      }

      const subject = `${c.ticket}/${c.phase}`;

      if (!enforce) {
        // shadow — emit would-* twin; no act, no intent, no comment.
        const shadowEvt = _actionToShadowEvent(decision.action);
        if (shadowEvt) {
          fire(
            shadowEvt,
            { ticket: c.ticket, phase: c.phase, category: decision.category, reason: decision.reason },
            c.ticket,
          );
        }
        if (decision.action === "escalate") {
          report.wouldEscalate.push({ ticket: c.ticket, phase: c.phase, category: decision.category });
        } else {
          report.wouldAct.push({ ticket: c.ticket, phase: c.phase, category: decision.category, action: decision.action });
        }
        continue;
      }

      // enforce — escalate path: no intent gate (genuine decisions always surface).
      if (decision.action === "escalate") {
        try { escalate(c, decision); } catch (err) {
          logger.warn({ ticket: c.ticket, err: err?.message }, "unstuck-sweep: escalate seam threw (CTL-1064)");
        }
        fire(UNSTUCK_EVENT.escalated, { ticket: c.ticket, phase: c.phase, category: decision.category }, c.ticket);
        try { postComment(c.ticket, decision.category ?? "unknown", c.phase); } catch { /* best-effort */ }
        report.escalated.push({ ticket: c.ticket, phase: c.phase, category: decision.category });
        continue;
      }

      // enforce — clearable action: check intent gate BEFORE acting (storm-prevention).
      if (isIntentEffective(UNSTUCK_SWEEP_INTENT_KIND, subject)) {
        report.skipped.push({ ticket: c.ticket, phase: c.phase, reason: "intent-effective" });
        continue;
      }

      // call the per-category act seam. When NO act seam is wired for this
      // category (the production default is actByCategory:{}), we must NOT fall
      // through to record an intent, post a comment, emit a success event, or
      // push report.acted — that asserts work that never ran (false success).
      // Skip with reason 'no-act-seam' so telemetry reflects reality (CTL-1064).
      const actFn = actByCategory[decision.category];
      if (!actFn) {
        report.skipped.push({
          ticket: c.ticket,
          phase: c.phase,
          category: decision.category,
          reason: "no-act-seam",
        });
        continue;
      }
      try {
        actFn(c, decision);
      } catch (err) {
        logger.warn(
          { ticket: c.ticket, category: decision.category, err: err?.message },
          "unstuck-sweep: act seam threw (CTL-1064)",
        );
        report.failed.push({ ticket: c.ticket, phase: c.phase, category: decision.category, err: err?.message });
        continue;
      }

      // record intent with kind:'unstuck-sweep', subject:'<ticket>/<phase>'.
      try { recordIntent(UNSTUCK_SWEEP_INTENT_KIND, subject); } catch (err) {
        logger.warn({ ticket: c.ticket, err: err?.message }, "unstuck-sweep: recordIntent threw (CTL-1064)");
      }

      // post comment (after act, before emit — matches recovery.mjs:564 ordering).
      try { postComment(c.ticket, decision.category, c.phase); } catch { /* best-effort */ }

      // emit the enforce event.
      const enforceEvt = _actionToEnforceEvent(decision.action);
      if (enforceEvt) {
        fire(enforceEvt, { ticket: c.ticket, phase: c.phase, category: decision.category }, c.ticket);
      }

      report.acted.push({ ticket: c.ticket, phase: c.phase, category: decision.category, action: decision.action });
    } catch (err) {
      logger.warn(
        { ticket: c?.ticket, err: err?.message },
        "unstuck-sweep: per-candidate step failed — continuing (CTL-1064)",
      );
      report.failed.push({ ticket: c?.ticket, phase: c?.phase, err: err?.message });
    }
  }

  return report;
}
