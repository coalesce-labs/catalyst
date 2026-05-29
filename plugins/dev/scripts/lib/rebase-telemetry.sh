#!/usr/bin/env bash
# lib/rebase-telemetry.sh — CTL-707 Layer 4. Emit the four stale-base canonical
# events. Pure wrapper over build_canonical_line + canonical_jsonl_append.
# Source this from any bash producer that needs to emit rebase telemetry.

set -uo pipefail

if [[ -n "${__CATALYST_REBASE_TELEMETRY_SOURCED:-}" ]]; then return 0; fi
__CATALYST_REBASE_TELEMETRY_SOURCED=1

_RT_SELF="${BASH_SOURCE[0]:-${(%):-%x}}"
_RT_DIR="$(cd "$(dirname "$_RT_SELF")" && pwd)"
# shellcheck source=./canonical-event.sh
source "${_RT_DIR}/canonical-event.sh"

# _emit_rebase_event — internal dispatch. Takes pre-built --event-name/--severity
# plus the common --orch/--ticket args. Returns 0 even on build/write failure so
# callers never abort on telemetry errors.
_emit_rebase_event() {
  local event_name="" severity="" orch="" ticket="" payload="{}"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --event-name)   event_name="$2";  shift 2 ;;
      --severity)     severity="$2";    shift 2 ;;
      --orch)         orch="$2";        shift 2 ;;
      --ticket)       ticket="$2";      shift 2 ;;
      --payload-json) payload="$2";     shift 2 ;;
      *)              shift ;;
    esac
  done
  local ts; ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local line
  line="$(build_canonical_line \
    --ts         "$ts" \
    --severity   "$severity" \
    --service    "catalyst.worktree-rebase" \
    --event-name "$event_name" \
    --entity     "phase" \
    --action     "rebase" \
    --label      "$ticket" \
    --orch       "$orch" \
    --worker     "$ticket" \
    --linear-ticket "$ticket" \
    --payload-json "$payload")" || return 0
  canonical_jsonl_append "${EVENTS_DIR:-$HOME/catalyst/events}" "$line"
}

# emit_stale_base_detected — WARN: the worktree is behind origin/<base>.
# --orch <id>  --ticket <key>  --phase <name>
# --commits-behind <n>  --files-at-risk <json-array>
emit_stale_base_detected() {
  local orch="" ticket="" phase="" commits_behind=0 files_at_risk="[]"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --orch)           orch="$2";           shift 2 ;;
      --ticket)         ticket="$2";         shift 2 ;;
      --phase)          phase="$2";          shift 2 ;;
      --commits-behind) commits_behind="$2"; shift 2 ;;
      --files-at-risk)  files_at_risk="$2";  shift 2 ;;
      *)                shift ;;
    esac
  done
  local payload
  payload="$(jq -nc --argjson cb "$commits_behind" --argjson far "$files_at_risk" \
    '{commits_behind: $cb, files_at_risk: $far}')" || payload="{}"
  _emit_rebase_event \
    --event-name "phase.${phase}.stale-base-detected.${ticket}" \
    --severity WARN \
    --orch "$orch" --ticket "$ticket" \
    --payload-json "$payload"
}

# emit_auto_rebased — INFO: rebase succeeded (clean or additive auto-resolve).
# --orch <id>  --ticket <key>  --phase <name>  --strategy <clean|additive|recreate>
emit_auto_rebased() {
  local orch="" ticket="" phase="" strategy="clean"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --orch)     orch="$2";     shift 2 ;;
      --ticket)   ticket="$2";   shift 2 ;;
      --phase)    phase="$2";    shift 2 ;;
      --strategy) strategy="$2"; shift 2 ;;
      *)          shift ;;
    esac
  done
  local payload
  payload="$(jq -nc --arg s "$strategy" '{strategy: $s}')" || payload="{}"
  _emit_rebase_event \
    --event-name "phase.${phase}.auto-rebased.${ticket}" \
    --severity INFO \
    --orch "$orch" --ticket "$ticket" \
    --payload-json "$payload"
}

# emit_rebase_conflict_categorized — WARN: conflicted files categorized by type.
# --orch <id>  --ticket <key>  --phase <name>
# --test-count <n>  --noise-count <n>  --source-count <n>  --thoughts-count <n>
emit_rebase_conflict_categorized() {
  local orch="" ticket="" phase=""
  local test_count=0 noise_count=0 source_count=0 thoughts_count=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --orch)           orch="$2";           shift 2 ;;
      --ticket)         ticket="$2";         shift 2 ;;
      --phase)          phase="$2";          shift 2 ;;
      --test-count)     test_count="$2";     shift 2 ;;
      --noise-count)    noise_count="$2";    shift 2 ;;
      --source-count)   source_count="$2";   shift 2 ;;
      --thoughts-count) thoughts_count="$2"; shift 2 ;;
      *)                shift ;;
    esac
  done
  local payload
  payload="$(jq -nc \
    --argjson tc "$test_count" --argjson nc "$noise_count" \
    --argjson sc "$source_count" --argjson thc "$thoughts_count" \
    '{test_count: $tc, noise_count: $nc, source_count: $sc, thoughts_count: $thc}')" || payload="{}"
  _emit_rebase_event \
    --event-name "phase.${phase}.rebase-conflict-categorized.${ticket}" \
    --severity WARN \
    --orch "$orch" --ticket "$ticket" \
    --payload-json "$payload"
}

# emit_rebase_conflict_stalled — ERROR: conflict cannot be auto-resolved; phase parked.
# --orch <id>  --ticket <key>  --phase <name>
# --reason <string>  --files <json-array>  --category <string>
emit_rebase_conflict_stalled() {
  local orch="" ticket="" phase="" reason="" files="[]" category=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --orch)     orch="$2";     shift 2 ;;
      --ticket)   ticket="$2";   shift 2 ;;
      --phase)    phase="$2";    shift 2 ;;
      --reason)   reason="$2";   shift 2 ;;
      --files)    files="$2";    shift 2 ;;
      --category) category="$2"; shift 2 ;;
      *)          shift ;;
    esac
  done
  local payload
  payload="$(jq -nc --arg r "$reason" --argjson f "$files" --arg c "$category" \
    '{reason: $r, files: $f, category: $c}')" || payload="{}"
  _emit_rebase_event \
    --event-name "phase.${phase}.rebase-conflict-stalled.${ticket}" \
    --severity ERROR \
    --orch "$orch" --ticket "$ticket" \
    --payload-json "$payload"
}
