// beliefs/guards.mjs — CTL-935: canonical legacy-guard name list and
// guard→belief-rule attribution map.  Shared by the reclaim comparator
// (Phase 3) and the weekly report (Phase 5) so both reference one source
// of truth for the ~16 reclaimDeadWork outcome strings.

// Every raw outcome string reclaimDeadWork can return.  Four of these
// ("guard-only-no-rule") have no belief counterpart and are provably
// load-bearing — the belief store cannot replace them.
export const LEGACY_GUARDS = [
  "reclaimed",
  "terminal-short-circuit",
  "revived",
  "wedged-redispatched",
  "revive-suppressed",
  "no-progress-stopped",
  "escalated",
  "escalation-suppressed",
  "rate-limited-deferred",
  "alive-suppressed",
  "reclaim-failed",
  "inert-stale",
  "superseded-noop",
  "noop",
];

// Guards that have no belief counterpart (provably load-bearing).
export const GUARD_ONLY_NO_RULE = new Set([
  "terminal-short-circuit",
  "superseded-noop",
  "rate-limited-deferred",
  "escalation-suppressed",
]);

// GUARD_RULE_MAP — filled in Phase 3 (reclaim-shadow.mjs).
// Maps a raw reclaimDeadWork outcome to its expected belief class, expressed
// as the R-id of the belief rule that AGREES with it.  A null entry means
// the guard is provably load-bearing (no belief rule covers it).
export const GUARD_RULE_MAP = {
  "reclaimed":              "R7",
  "terminal-short-circuit": null,
  "revived":                "R7",
  "wedged-redispatched":    "R4",
  "revive-suppressed":      "R7",
  "no-progress-stopped":    "R7",
  "escalated":              null,  // ambiguous (Phase 3 refactor note)
  "escalation-suppressed":  null,
  "rate-limited-deferred":  null,
  "alive-suppressed":       "R5",  // procedural=alive; disagrees with R6/R7
  "reclaim-failed":         "R7",
  "inert-stale":            "R7",
  "superseded-noop":        null,
  "noop":                   "R5",
};
