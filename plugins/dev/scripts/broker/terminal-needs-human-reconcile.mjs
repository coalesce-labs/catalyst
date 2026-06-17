#!/usr/bin/env bun
// terminal-needs-human-reconcile.mjs — CTL-1242 (corrected scope): the
// BROKER-side half of the needs-human terminal reap.
//
// WHY THIS EXISTS. The orch-monitor board derives its "needs-human" attention
// badge from the LOCAL filter-state.db cache (ticket_state.labels, via
// board-data.mjs deriveAttention) — NOT from live Linear. When a ticket reaches
// a terminal Linear state (Done / Canceled / Duplicate) but the cache MISSES the
// subsequent "label-removed" webhook (the CTL-1161 drift), the stale
// `needs-human` cache label survives and the board keeps flagging a finished
// ticket for attention (e.g. CTL-1186 "stuck 40h", CTL-1248).
//
// The execution-core terminal sweep (scheduler.mjs, CTL-1242 Phase 1) clears the
// LINEAR label + the host-local `.linear-label-needs-human` marker, and the J4
// janitor GCs the stale worker dir. But the broker is the SOLE writer of
// ticket_state (execution-core opens filter-state.db read-only via
// gateway-read.mjs), so only the broker can strip the CACHE label — and the
// cache label is the one the board actually reads.
//
// This module is the durable form of the hand-run reconcile:
//   UPDATE ticket_state SET labels = (labels − 'needs-human')
//   WHERE linear_state IN (terminal) AND labels LIKE '%needs-human%';
// It is deterministic, idempotent, and terminal-only. It keys off the cache's
// OWN linear_state, so it can never contradict what the board renders from the
// same row — no Linear fetch, no LLM. The cache-drift ROOT cause (re-syncing the
// full label set from Linear on a missed webhook) is a SEPARATE fix
// (CTL-1161 drift-check); this strips only the one stale escalation label that
// leaks a finished ticket into needs-you.
//
// The pure decision helpers are exported for unit testing; the DB writes and the
// interval wiring are exercised at runtime from index.mjs.

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

// TERMINAL_STATES — Linear workflow states a finished ticket settles into.
// Mirrors backfill-ticket-labels.mjs's predicate (case-insensitive match against
// the cached linear_state). A merged PR lands the ticket on `Done`, so the merged
// case is covered by Done — no filter_state join needed.
export const TERMINAL_STATES = new Set(["done", "canceled", "cancelled", "duplicate"]);

export function isTerminalState(state) {
  return typeof state === "string" && TERMINAL_STATES.has(state.toLowerCase());
}

// The escalation label the board's deriveAttention reads for the needs-human
// bucket (board-data.mjs ATTENTION_LABEL_NEEDS_HUMAN). A terminal ticket never
// legitimately carries it — once shipped/closed there is nothing to escalate.
export const STALE_TERMINAL_LABEL = "needs-human";

// decideTerminalNeedsHumanStrip — PURE decision for ONE descriptor. Returns
// { strip, labels, reason }:
//   • strip:true  only when the ticket is terminal AND its cached labels contain
//     needs-human; `labels` is the new array (order-preserved, needs-human gone).
//   • strip:false for a non-terminal ticket, a terminal ticket without the label,
//     or an unusable labels field — `labels` is the stored value, untouched.
// Idempotent: re-running on an already-stripped row returns strip:false.
export function decideTerminalNeedsHumanStrip(descriptor) {
  const state = descriptor?.state;
  const labels = Array.isArray(descriptor?.labels) ? descriptor.labels : null;
  if (!isTerminalState(state)) {
    return { strip: false, labels, reason: "not terminal" };
  }
  if (!labels || !labels.includes(STALE_TERMINAL_LABEL)) {
    return { strip: false, labels, reason: "no stale needs-human label" };
  }
  const next = labels.filter((l) => l !== STALE_TERMINAL_LABEL);
  return {
    strip: true,
    labels: next,
    reason: `terminal (${state}) — strip needs-human: ${JSON.stringify(labels)} → ${JSON.stringify(next)}`,
  };
}

// MODES / readReconcileMode — the single operator knob. CTL-1242 corrected scope
// ships ENFORCE by default (the board must stop flagging finished tickets), with
// a kill-switch — UNLIKE the recovery passes (which ship off → shadow → enforce),
// because this reconcile is deterministic, idempotent, and terminal-only:
//   "0" | "off" → off, "shadow" → log-only, "enforce" → write, unset/other → enforce.
export const MODES = new Set(["off", "shadow", "enforce"]);
export function readReconcileMode(env = process.env) {
  const v = env.CATALYST_TERMINAL_NEEDS_HUMAN_RECONCILE;
  if (v === "0" || v === "off") return "off";
  if (typeof v === "string" && MODES.has(v)) return v;
  return "enforce"; // CTL-1242: default-on kill-switch
}

// ── Runtime sweep ───────────────────────────────────────────────────────────

// reconcileTerminalNeedsHuman — ONE pass over the whole ticket_state cache. The
// seams (getAll / upsert / emit / log / mode) are injected so the pass is
// unit-testable without a real DB. Returns a summary
// { mode, scanned, stripped, items:[{ticket, from, to}] }.
//
// Fail-soft throughout: a getAll throw aborts the pass (returns the empty
// summary); a per-row upsert throw is logged and that row rolled back out of the
// summary so the next pass retries it. Never throws to the caller.
export function reconcileTerminalNeedsHuman({
  getAll,
  upsert,
  emit = () => {},
  log = console,
  mode = readReconcileMode(),
} = {}) {
  const summary = { mode, scanned: 0, stripped: 0, items: [] };
  if (mode === "off") return summary;

  let descriptors;
  try {
    descriptors = getAll() ?? [];
  } catch (err) {
    log?.warn?.({ err: String(err) }, "terminal-needs-human-reconcile: getAll failed");
    return summary;
  }

  for (const d of descriptors) {
    summary.scanned++;
    const decision = decideTerminalNeedsHumanStrip(d);
    if (!decision.strip) continue;

    if (mode === "shadow") {
      summary.stripped++;
      summary.items.push({ ticket: d.ticket, from: d.labels, to: decision.labels });
      log?.info?.(
        { ticket: d.ticket, reason: decision.reason },
        "terminal-needs-human-reconcile: WOULD strip needs-human (shadow)"
      );
      continue;
    }

    // enforce — write the stripped label set back. KEY-PRESENCE upsert: only
    // `labels` (+ updated_at) changes; every other column is left untouched.
    try {
      upsert({ ticket: d.ticket, labels: decision.labels });
      summary.stripped++;
      summary.items.push({ ticket: d.ticket, from: d.labels, to: decision.labels });
      log?.info?.(
        { ticket: d.ticket, reason: decision.reason },
        "terminal-needs-human-reconcile: stripped stale needs-human (terminal)"
      );
    } catch (err) {
      log?.warn?.(
        { ticket: d.ticket, err: String(err) },
        "terminal-needs-human-reconcile: upsert failed — leaving for next pass"
      );
    }
  }

  if (summary.stripped > 0) {
    emit(summary);
  }
  return summary;
}

// startTerminalNeedsHumanReconcile — setInterval wrapper mirroring startWatchdog
// (router.mjs). Runs once immediately so a stale label clears at boot, then on
// the interval. Returns the timer handle; the caller clearInterval's it on
// shutdown (index.mjs). The tick is fully guarded so a throw never crashes the
// broker. `unref()` keeps the timer from holding the event loop open.
export const RECONCILE_INTERVAL_MS = 60_000;
export function startTerminalNeedsHumanReconcile(opts = {}) {
  const tick = () => {
    try {
      reconcileTerminalNeedsHuman(opts);
    } catch (err) {
      (opts.log ?? console)?.warn?.(
        { err: String(err) },
        "terminal-needs-human-reconcile: tick threw"
      );
    }
  };
  tick(); // boot pass
  const id = setInterval(tick, opts.intervalMs ?? RECONCILE_INTERVAL_MS);
  if (typeof id?.unref === "function") id.unref();
  return id;
}
