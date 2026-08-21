// backstop.mjs — CTL-2000. The two pure classifiers behind the OUT-OF-FLEET
// backstops (routing.md → "Backstopping the backstop"):
//
//   1. the holding-reply SENTINEL posts the tagged "steward/<slug> is being
//      restarted" reply at the 15-minute silence mark and asks the supervisor
//      to restart the role;
//   2. the DEAD-MAN alarm pushes the human ONCE and posts on the channel when
//      there is no concierge heartbeat AND no channel turn for 30 minutes.
//
// "A 529 wave takes stewards and concierge together — measured twice on
// 2026-08-18." So these live in their own launchd units and cannot be taken
// down with the fleet. This file is the pure, node:*-only decision core (it
// imports nothing); the launchd shells (holding-sentinel.mjs / dead-man.mjs)
// wire the real reads to it.

// These thresholds are RELATED to agent-liveness's SILENT_AFTER_MS (10m) /
// DEAD_AFTER_MS (30m) but deliberately DISTINCT: the holding reply is a
// silence-to-restart trigger (15m, between silent and dead), and the dead-man
// is concierge-specific (heartbeat 30m AND channel-turn 30m). Kept as their own
// named constants — see Open Question 3 on whether operators want one knob.
export const HOLDING_REPLY_AFTER_MS = 15 * 60 * 1000; // cf. SILENT_AFTER_MS (10m) / DEAD_AFTER_MS (30m)
export const DEAD_MAN_AFTER_MS = 30 * 60 * 1000; // matches DEAD_AFTER_MS, applied to BOTH signals

/**
 * Should the holding-reply sentinel post now? True once the role has been
 * silent for >= 15 minutes and the reply has not already been posted this
 * episode. A null/undefined silence age is "nothing to act on" → false (the
 * sentinel needs a positive silence measurement, unlike the dead-man which
 * treats absence as death).
 *
 * @param {{silenceMs: number|null, alreadyPosted: boolean}} arg
 * @returns {boolean}
 */
export function shouldPostHoldingReply({ silenceMs, alreadyPosted = false } = {}) {
  if (alreadyPosted) return false;
  if (typeof silenceMs !== "number") return false;
  return silenceMs >= HOLDING_REPLY_AFTER_MS;
}

/**
 * Should the dead-man alarm fire now? True ONLY when BOTH the concierge
 * heartbeat AND the last channel turn are >= 30 minutes old, and the alarm has
 * not already pushed this episode.
 *
 * A `null` age (missing heartbeat / no channel turn ever) counts as DEAD, never
 * as healthy — the absence of a signal is not evidence of life, and defaulting
 * it to alive is how a dead concierge would hide. Requiring BOTH signals is
 * what keeps a merely-restarting concierge (fresh channel turn) or a quiet-but-
 * alive one (fresh heartbeat) from paging the human.
 *
 * @param {{conciergeHbAgeMs: number|null, lastChannelTurnAgeMs: number|null, alreadyPushed: boolean}} arg
 * @returns {boolean}
 */
export function deadManShouldFire({ conciergeHbAgeMs, lastChannelTurnAgeMs, alreadyPushed = false } = {}) {
  if (alreadyPushed) return false;
  // null/undefined/non-number → treat as "infinitely old" (dead/silent).
  const hbDead = !(typeof conciergeHbAgeMs === "number") || conciergeHbAgeMs >= DEAD_MAN_AFTER_MS;
  const turnDead = !(typeof lastChannelTurnAgeMs === "number") || lastChannelTurnAgeMs >= DEAD_MAN_AFTER_MS;
  return hbDead && turnDead;
}
