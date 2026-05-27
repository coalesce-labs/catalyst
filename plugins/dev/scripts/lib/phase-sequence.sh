#!/usr/bin/env bash
# phase-sequence.sh — shared bash mirror of lib/phase-fsm.mjs PHASES (CTL-607).
#
# KEEP IN SYNC with lib/phase-fsm.mjs `export const PHASES`. The drift-guard
# test __tests__/phase-sequence.test.sh asserts the two stay identical. Bash
# cannot import the .mjs; this mirrors the established precedent in
# orchestrate-phase-advance (phase_next() mirrors NEXT_PHASE; PHASE_LINEAR_KEY
# is mirrored likewise).
#
# Why a mirror: neither orchestrate-revive nor orchestrate-healthcheck invokes
# node; adding a node-startup dependency to the recovery sweep would change
# the failure modes of the recovery path. A hand-maintained mirror + drift
# guard test keeps the recovery scanners pure bash.

# shellcheck disable=SC2034  # PHASES is consumed by sourcing scripts
PHASES=(triage research plan implement verify review pr monitor-merge monitor-deploy)

# CTL-667: the BUILD phases that get a fresh-dispatch rebase onto origin/<base>.
# Strict subset of PHASES — keep in that set (the phase-sequence drift test +
# the CTL-667 subset guard assert this). triage/pr/remediate and the monitor-*
# phases are intentionally excluded (see plan: What We're NOT Doing).
# shellcheck disable=SC2034  # REBASE_PHASES is consumed by sourcing scripts
REBASE_PHASES=(research plan implement verify review)

# is_rebase_phase PHASE → exit 0 if PHASE is a front-load-rebase build phase.
is_rebase_phase() {
  local phase="$1" p
  for p in "${REBASE_PHASES[@]}"; do
    [[ $p == "$phase" ]] && return 0
  done
  return 1
}

# latest_phase_in_dir DIR
# Echoes the highest-index PHASES entry that has a workers/<T>/phase-<name>.json
# present in DIR, or the empty string if none. Mirrors scheduler.mjs:270
# (walk PHASES in order, overwrite `latest` on every hit → ends at max index).
latest_phase_in_dir() {
  local dir="$1" latest="" p
  for p in "${PHASES[@]}"; do
    if [ -e "${dir}/phase-${p}.json" ]; then
      latest="$p"
    fi
  done
  printf '%s' "$latest"
}
