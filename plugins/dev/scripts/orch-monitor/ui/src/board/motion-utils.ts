// motion-utils.ts — shared motion config for orch-monitor UI (CTL-952).
//
// All animation parameters live here so the values stay consistent across
// surfaces (board kanban, list, queue) and the reduced-motion collapse is in
// ONE place. Import `useReducedMotion` from the `motion/react` package, and
// use `motionConfig` / `cardTransition` / `rowTransition` at call-sites.
//
// Design rule (DESIGN.md ethos): tasteful + fast, NO bounce.

import { useReducedMotion } from "motion/react";
export { useReducedMotion };

// ── transition presets ────────────────────────────────────────────────────────

/** Transition for kanban cards (layout + enter/exit). */
export const cardTransition = {
  type: "spring" as const,
  stiffness: 400,
  damping: 38,
  mass: 0.6,
  duration: 0.22,
};

/** Transition for list/queue rows (enter/exit, no layout). */
export const rowTransition = {
  type: "spring" as const,
  stiffness: 500,
  damping: 45,
  mass: 0.5,
  duration: 0.18,
};

/** Transition for layout animations (position changes between columns). */
export const layoutTransition = {
  type: "spring" as const,
  stiffness: 380,
  damping: 40,
  mass: 0.7,
  duration: 0.25,
};

// ── instant variants (prefers-reduced-motion) ─────────────────────────────────
// When the OS accessibility preference is set, ALL variants collapse to instant
// — no keyframes, no spring, just a synchronous DOM update.

/** Collapse a transition to instant when reduced-motion is requested. */
export function reduceTransition(t: object, reduced: boolean | null) {
  return reduced ? { duration: 0 } : t;
}

// ── presence variants ────────────────────────────────────────────────────────
// Shared enter / exit keyframes. The `initial` / `animate` / `exit` triplet is
// used for both cards and rows; the difference is the transition timing above.

/** Standard enter: fade + small upward slide. */
export const enterVariants = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  exit:    { opacity: 0, y: -4, transition: { duration: 0.12 } },
};

/** Reduced-motion enter: instant opacity only (no y movement). */
export const enterVariantsReduced = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0 } },
  exit:    { opacity: 0, transition: { duration: 0 } },
};
