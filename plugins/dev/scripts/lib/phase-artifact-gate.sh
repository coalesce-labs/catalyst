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
# (e.g. ctl-10812 does NOT satisfy a ctl-1081 gate). Case-insensitive matching
# absorbs the uppercase-ticket convention (CTL-1081 writer, ctl-1081 glob) in
# one step.
#
# Deliberately shell-agnostic (no `shopt`, no bash array-glob): this file's
# shebang says bash, but in practice callers have sourced it under an
# interactive zsh session rather than invoking via `bash -c` as intended.
# `shopt` is not a zsh builtin, so `shopt -s nullglob nocaseglob` silently
# failed under zsh (non-fatal, execution continued) and the SUBSEQUENT glob ran
# under zsh's own default (non-nullglob, error-on-no-match) semantics instead
# of bash's — producing an empty match with no error surfaced, which this
# function's callers read as "prior artifact missing" even when it existed.
# Confirmed root cause behind at least one false plan-phase stall (see
# PROJ-39's friction log) — real research/plan docs existed on disk, but the
# gate reported them missing. `find -iname` performs the identical
# slug-tolerant, boundary-safe, case-insensitive match without depending on
# either shell's array/glob-option extensions, so sourcing this file under
# bash OR zsh now behaves identically. Bash-3.2 safe: uses tr for lowercasing,
# no mapfile.
#
# Depth-limited via the classic `-prune` idiom rather than `-maxdepth`/`-mindepth`:
# prune any directory encountered that is not <dir> itself, so find never
# descends into subdirectories, without depending on either flag being present.
# `! -name '.*'` excludes dotfiles (macOS AppleDouble `._*` siblings, editor
# swap files) to match the previous glob's default (non-dotglob) behavior,
# which silently skipped leading-dot basenames. Output is piped through `sort`
# so callers doing `tail -1` for "most recent" get a deterministic,
# lexicographically-last result — raw find traversal order is filesystem-
# dependent and not guaranteed to match creation or name order.
match_thoughts_artifact() {
	local dir="$1" ticket="$2" lc

	# Missing dir → no match, no error (mirrors the prior nullglob behavior).
	[[ -d "$dir" ]] || return 1

	lc="$(printf '%s' "$ticket" | tr '[:upper:]' '[:lower:]')"

	local matches
	matches="$(
		find "$dir" -type d ! -path "$dir" -prune -o \
			-type f ! -name '.*' \( -iname "*-${lc}.md" -o -iname "*-${lc}-*.md" \) -print \
			2>/dev/null | sort
	)"

	if [[ -n "$matches" ]]; then
		printf '%s\n' "$matches"
		return 0
	fi
	return 1
}
