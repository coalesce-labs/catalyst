// stale-needs-human-sweep.mjs — CTL-1871 COORD-29: daily sweep over active
// needs-human tickets that lack an ASK comment.
//
// WHY THIS EXISTS. The atomic gate (label-guard.mjs Phase 2) posts the ASK
// comment and applies the label in one step for every FUTURE escalation.  But
// legacy labels, cross-host applications, and edge races can leave a
// needs-human ticket with the label but no ASK comment.  This sweep catches
// those gaps: once per day it scans active needs-human tickets, and for any
// that lack a well-formed `parseAskComment`-recognised comment it applies the
// `stale-needs-human` label and posts a defect comment so the operator inbox
// shows something actionable rather than a bare label.
//
// The sweep is additive and non-destructive: it never removes labels, never
// touches terminal tickets, and is idempotent (a ticket already carrying
// stale-needs-human is skipped).  Default mode is `shadow` so the first
// deployment is observe-only.
//
// Modelled on terminal-needs-human-reconcile.mjs.

import { parseAskComment, formatAskComment } from "../execution-core/needs-human-ask.mjs";
import { coerceExplanation, DEFAULT_IF_SILENT } from "../execution-core/escalation-explanation.mjs";
import { isTerminalState } from "./terminal-needs-human-reconcile.mjs";

// ── Constants ────────────────────────────────────────────────────────────────

export const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 h

/** The label applied when a stale gap is detected. */
export const STALE_LABEL = "stale-needs-human";

/** The event name emitted at the end of each sweep pass. */
export const STALE_SWEEP_EVENT = "broker.stale-needs-human.swept";

// ── Pure classifier ──────────────────────────────────────────────────────────

/**
 * classifyStaleNeedsHuman — PURE decision for ONE descriptor.
 *
 * @param {object} descriptor
 *   - ticket {string}
 *   - state {string}  — Linear workflow state (lowercased)
 *   - labels {string[]}
 *   - comments {Array<{body: string}>}  — the ticket's Linear comments
 * @returns {{ flag: boolean, reason: string }}
 */
export function classifyStaleNeedsHuman(descriptor) {
  const { state, labels, comments } = descriptor ?? {};

  if (isTerminalState(state)) {
    return { flag: false, reason: "terminal" };
  }

  const labelArr = Array.isArray(labels) ? labels : [];
  if (!labelArr.includes("needs-human")) {
    return { flag: false, reason: "no-needs-human" };
  }
  if (labelArr.includes(STALE_LABEL)) {
    return { flag: false, reason: "already-flagged" };
  }

  // Does the ticket have at least one well-formed ASK comment?
  const commentArr = Array.isArray(comments) ? comments : [];
  const hasAsk = commentArr.some((c) => parseAskComment(String(c?.body ?? "")).isAsk);
  if (hasAsk) {
    return { flag: false, reason: "has-ask" };
  }

  return { flag: true, reason: "needs-human without ASK comment" };
}

// ── Mode ─────────────────────────────────────────────────────────────────────

export const SWEEP_MODES = new Set(["off", "shadow", "enforce"]);

export function readSweepMode(env = process.env) {
  const v = (env ?? process.env).CATALYST_STALE_NEEDS_HUMAN_SWEEP;
  if (v === "off") return "off";
  if (v === "enforce") return "enforce";
  return "shadow"; // default: shadow
}

// ── Defect comment body ──────────────────────────────────────────────────────

export function buildDefectComment() {
  const explanation = coerceExplanation(
    {
      type: "authorization",
      problem:
        "This ticket carries the needs-human label but has no ASK comment. The operator inbox cannot show what decision is needed.",
      call_to_action:
        "Post a COORD-29 ASK comment on this ticket stating the question and what happens if nobody answers.",
      default_if_silent: DEFAULT_IF_SILENT,
    },
    { ticket: "?", canExecute: false }
  );
  const askLine = formatAskComment(explanation);
  return (
    `⚠️ **stale-needs-human** (COORD-29 gap detected by the daily sweep)\n\n` +
    `This ticket is labelled \`needs-human\` but has no \`ASK (…)\` comment — ` +
    `the operator inbox cannot show what decision is needed.\n\n` +
    `Suggested template:\n\n> ${askLine}\n\n` +
    `_Posted automatically by the stale-needs-human sweep (CTL-1871)._`
  );
}

// ── Runtime sweep ─────────────────────────────────────────────────────────────

/**
 * sweepStaleNeedsHuman — ONE pass over the candidate set.
 *
 * Seams (injected for unit-testability):
 *   getCandidates() → descriptor[]
 *   applyLabel(ticket, label) → { applied: boolean } | boolean
 *   postComment(ticket, body) → { status: number } | boolean
 *   emit(summary) → void
 *   log — { info, warn }
 *   mode — "off" | "shadow" | "enforce"
 *
 * Returns { mode, scanned, flagged, items: [{ ticket, reason }] }.
 * Never throws to the caller.
 */
export function sweepStaleNeedsHuman({
  getCandidates,
  applyLabel = () => ({ applied: false }),
  postComment = () => ({ status: 1 }),
  emit = () => {},
  log = console,
  mode = readSweepMode(),
} = {}) {
  const summary = { mode, scanned: 0, flagged: 0, items: [] };
  if (mode === "off") return summary;

  let candidates;
  try {
    candidates = getCandidates() ?? [];
  } catch (err) {
    log?.warn?.({ err: String(err) }, "stale-needs-human-sweep: getCandidates failed");
    return summary;
  }

  for (const d of candidates) {
    summary.scanned++;
    const decision = classifyStaleNeedsHuman(d);
    if (!decision.flag) continue;

    if (mode === "shadow") {
      summary.flagged++;
      summary.items.push({ ticket: d.ticket, reason: decision.reason });
      log?.info?.(
        { ticket: d.ticket, reason: decision.reason },
        "stale-needs-human-sweep: WOULD flag (shadow)"
      );
      continue;
    }

    // enforce — apply label + post defect comment.
    let labelOk = false;
    let commentOk = false;
    try {
      const lr = applyLabel(d.ticket, STALE_LABEL);
      labelOk = lr === true || lr?.applied === true;
    } catch (err) {
      log?.warn?.(
        { ticket: d.ticket, err: String(err) },
        "stale-needs-human-sweep: applyLabel threw — skipping"
      );
    }

    try {
      const cr = postComment(d.ticket, buildDefectComment());
      commentOk = cr === true || cr?.status === 0;
    } catch (err) {
      log?.warn?.(
        { ticket: d.ticket, err: String(err) },
        "stale-needs-human-sweep: postComment threw — skipping"
      );
    }

    if (labelOk || commentOk) {
      summary.flagged++;
      summary.items.push({ ticket: d.ticket, reason: decision.reason });
      log?.info?.(
        { ticket: d.ticket, labelOk, commentOk },
        "stale-needs-human-sweep: flagged stale gap"
      );
    } else {
      log?.warn?.(
        { ticket: d.ticket },
        "stale-needs-human-sweep: both applyLabel and postComment failed — leaving for next pass"
      );
    }
  }

  if (summary.flagged > 0) {
    try {
      emit(summary);
    } catch { /* best-effort */ }
  }
  return summary;
}

// ── Timer ─────────────────────────────────────────────────────────────────────

/**
 * startStaleNeedsHumanSweep — setInterval wrapper mirroring startTerminalNeedsHumanReconcile.
 * Runs once at boot, then every intervalMs (default 24 h). Returns the timer handle.
 */
export function startStaleNeedsHumanSweep(opts = {}) {
  const tick = () => {
    try {
      sweepStaleNeedsHuman(opts);
    } catch (err) {
      (opts.log ?? console)?.warn?.(
        { err: String(err) },
        "stale-needs-human-sweep: tick threw"
      );
    }
  };
  tick(); // boot pass
  const id = setInterval(tick, opts.intervalMs ?? SWEEP_INTERVAL_MS);
  if (typeof id?.unref === "function") id.unref();
  return id;
}
