// worker-disposition.mjs — CTL-764 Phase 3: pure precedence resolver + label-set helper.
// No I/O. Import constants and functions from this module; never instantiate them elsewhere.

export const DISP_NEEDS_HUMAN = "needs-human";
export const DISP_NEEDS_INPUT = "needs-input";
export const DISP_BLOCKED = "blocked";
export const DISP_QUEUED = "queued";

/** Descending precedence order: index 0 wins. */
export const DISPOSITIONS = [
  DISP_NEEDS_HUMAN,
  DISP_NEEDS_INPUT,
  DISP_BLOCKED,
  DISP_QUEUED,
];

/**
 * Resolve the highest-precedence active disposition.
 * @param {{ needsHuman?: boolean, needsInput?: boolean, blocked?: boolean, queued?: boolean }} [flags]
 * @returns {string|null} disposition string, or null when healthy
 */
export function resolveDisposition(flags = {}) {
  const { needsHuman = false, needsInput = false, blocked = false, queued = false } = flags;
  if (needsHuman) return DISP_NEEDS_HUMAN;
  if (needsInput) return DISP_NEEDS_INPUT;
  if (blocked) return DISP_BLOCKED;
  if (queued) return DISP_QUEUED;
  return null;
}

/**
 * Return the single-member Set of labels that should be applied for a disposition.
 * Returns an empty Set for null/undefined (healthy — no disposition label).
 * @param {string|null|undefined} disposition
 * @returns {Set<string>}
 */
export function desiredLabelSet(disposition) {
  if (!disposition) return new Set();
  return new Set([disposition]);
}
