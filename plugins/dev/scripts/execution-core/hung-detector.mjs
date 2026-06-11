// hung-detector.mjs — CTL-729 progress-watchdog decision (pure, no IO).
// Mirrors stalled-detector.mjs:detectStalled. Returns a frozen decision object.
// All non-determinism (clock, transcript mtime, commit count, resolved thresholds)
// is computed by the caller and passed in — the full truth table is unit-testable
// with zero IO.

import { TERMINAL } from "./signal-reader.mjs";

// Research/plan phases: 0 commits is normal (no code shipped in fan-out).
// The commit gate is WAIVED for these phases; the silence + budget gates still apply
// so a quietly-synthesizing research parent at 35 min is never killed (its budget
// is ~105 min at default settings).
const FANOUT_PHASES = new Set(["research", "plan"]);
const ACTIONABLE_STATUS = new Set(["running", "dispatched"]);
const NO_OP = (reason) => Object.freeze({ action: "none", reason, elapsedMin: 0 });

// evaluateHungWorker — decide whether one worker should be force-killed.
//
// inputs: {
//   ticket, phase, status,
//   nowMs,           — current epoch ms
//   startedAtMs,     — parsed startedAt, or null if unparseable
//   transcriptAgeMs, — ms since last transcript write, or null if unmeasurable
//   progressMark,    — commits-ahead-of-origin/main (0 for fanout phases)
//   silenceMs,       — threshold from readWatchdogConfig().silenceThresholdMs
//   budgetMs,        — from phaseBudgetMs(phase, turnCap)
// }
// returns: frozen { action: "kill-escalate"|"none", reason, elapsedMin }
export function evaluateHungWorker(i) {
  // (1) Status gate — terminal absorbs everything; only running/dispatched can act.
  if (TERMINAL.has(i.status) || i.status === "complete") return NO_OP("terminal");
  if (!ACTIONABLE_STATUS.has(i.status)) return NO_OP("not-actionable");
  // Fail-safe: missing data is never evidence of a hang.
  if (i.startedAtMs == null || !Number.isFinite(i.startedAtMs)) return NO_OP("no-startedat");
  if (i.transcriptAgeMs == null) return NO_OP("no-transcript");
  // (2) Silence gate — a fresh parent OR subagent write counts as progress.
  if (i.transcriptAgeMs <= i.silenceMs) return NO_OP("transcript-fresh");
  // (3) Budget gate — applies to ALL phases including fanout (minimum-elapsed floor).
  const elapsedMs = i.nowMs - i.startedAtMs;
  if (elapsedMs <= i.budgetMs) return NO_OP("under-budget");
  // (4) Commit gate — waived for fanout phases (0 commits expected there).
  if (!FANOUT_PHASES.has(i.phase) && i.progressMark > 0) return NO_OP("has-progress");
  const elapsedMin = Math.floor(elapsedMs / 60_000); // floor → deterministic reason string
  return Object.freeze({
    action: "kill-escalate",
    reason: `hung_no_progress:${i.phase}:${elapsedMin}m_${i.progressMark}_commits`,
    elapsedMin,
  });
}
