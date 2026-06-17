#!/usr/bin/env bash
# lib/phase-artifact-gate.sh — shared phase-artifact gate contract (CTL-1081).
#
# Exposes three functions:
#   prior_artifact_for_phase <phase>
#       Gate spec for the artifact the PRIOR phase produces (consumer view).
#       Returns "signal:<file>", "glob:<dir>", or "" (entry point).
#
#   own_thoughts_artifact_dir_for_phase <phase>
#       Directory where THIS phase writes its thoughts artifact (producer view).
#       Returns a directory path ("thoughts/shared/research", etc.) or "".
#
#   match_thoughts_artifact <dir> <ticket>
#       Slug-tolerant, boundary-safe, case-insensitive matcher.
#       Prints matching filenames; returns 0 if at least one match, 1 otherwise.
#       Bash-3.2 safe (no mapfile, no ${var,,}).
#
# Source this file; do NOT execute it. It has no side-effects on sourcing.

# Guard against double-sourcing.
if [[ -n "${_PHASE_ARTIFACT_GATE_LOADED:-}" ]]; then
	return 0
fi
_PHASE_ARTIFACT_GATE_LOADED=1

# ─── Gate spec map ─────────────────────────────────────────────────────────────

# prior_artifact_for_phase <phase>
#
# Gate spec: what the prior phase must have produced before this phase can start.
#   "signal:<file>"  → a signal file under ${ORCH_DIR}/workers/<TICKET>/
#   "glob:<dir>"     → a thoughts artifact under <dir>/ (evaluated via match_thoughts_artifact)
#   ""               → this phase is the pipeline entry point (no prior artifact)
prior_artifact_for_phase() {
	case "$1" in
	triage) echo "" ;;
	research) echo "signal:triage.json" ;;
	plan) echo "glob:thoughts/shared/research" ;;
	implement) echo "glob:thoughts/shared/plans" ;;
	verify) echo "signal:phase-implement.json" ;;
	review) echo "signal:verify.json" ;;
	pr) echo "signal:review.json" ;;
	monitor-merge) echo "signal:phase-pr.json" ;;
	monitor-deploy) echo "signal:phase-monitor-merge.json" ;;
	remediate) echo "signal:verify.json" ;;
	# recovery-pass (CTL-1176 rung 3): its brief is recovery-pass.json — the
	# evidence envelope + failed-seam list the wire-in writes before dispatch
	# (the analogue of verify.json for remediate). The skill reads it as its
	# prior-phase artifact.
	recovery-pass) echo "signal:recovery-pass.json" ;;
	teardown) echo "signal:phase-monitor-deploy.json" ;;
	*) echo "" ;;
	esac
}

# own_thoughts_artifact_dir_for_phase <phase>
#
# Directory where this phase writes its own thoughts artifact (the producer view).
# Returns "" for phases that do not produce thoughts artifacts.
own_thoughts_artifact_dir_for_phase() {
	case "$1" in
	research) echo "thoughts/shared/research" ;;
	plan) echo "thoughts/shared/plans" ;;
	*) echo "" ;;
	esac
}

# ─── Slug-tolerant, boundary-safe, case-insensitive matcher ────────────────────

# match_thoughts_artifact <dir> <ticket>
#
# Finds thoughts artifacts in <dir> that belong to <ticket>.
# Accepts both the tail form (…-ctl-1081.md) and the slug form (…-ctl-1081-<slug>.md).
# The word-boundary guard (-${lc}. and -${lc}-) rejects cross-ticket lookalikes
# (e.g. ctl-10812 does NOT satisfy a ctl-1081 gate). nocaseglob absorbs the
# uppercase-ticket convention (CTL-1081 writer, ctl-1081 glob) in one step.
# Bash-3.2 safe: uses tr for lowercasing, no mapfile.
match_thoughts_artifact() {
	local dir="$1" ticket="$2" lc
	lc="$(printf '%s' "$ticket" | tr '[:upper:]' '[:lower:]')"

	# nullglob: missing dir → empty array, no error.
	# nocaseglob: absorbs uppercase ticket names in one pass.
	shopt -s nullglob nocaseglob
	# shellcheck disable=SC2206
	local matches=( "${dir}"/*-"${lc}".md "${dir}"/*-"${lc}"-*.md )
	shopt -u nullglob nocaseglob

	if [[ ${#matches[@]} -gt 0 ]]; then
		printf '%s\n' "${matches[@]}"
		return 0
	fi
	return 1
}
