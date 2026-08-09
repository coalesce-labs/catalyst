#!/usr/bin/env bash
# lib/worktree-salvage-telemetry.sh — CTL-1639. Emit worktree.salvage.* canonical
# events. Pure wrapper over build_canonical_line + canonical_jsonl_append. Never
# aborts the caller (returns 0 even on build/write failure), mirroring
# rebase-telemetry.sh. Source this from any bash producer that snapshots a
# worktree before destroying it.
set -uo pipefail
if [[ -n "${__CATALYST_WORKTREE_SALVAGE_TELEMETRY_SOURCED:-}" ]]; then return 0; fi
__CATALYST_WORKTREE_SALVAGE_TELEMETRY_SOURCED=1

# Portable self-path: BASH_SOURCE under bash, prompt-expansion %x under zsh.
_WST_SELF="${BASH_SOURCE[0]:-${(%):-%x}}"
_WST_DIR="$(cd "$(dirname "$_WST_SELF")" && pwd)"
# shellcheck source=./canonical-event.sh
source "${_WST_DIR}/canonical-event.sh"

# _emit_salvage_event --event-name --severity --ticket --orch --payload-json
# Internal dispatch. Returns 0 even on build/write failure so callers never abort
# on telemetry errors (the "telemetry never aborts the caller" contract).
_emit_salvage_event() {
  local event_name="" severity="INFO" ticket="" orch="" payload="{}"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --event-name)   event_name="$2"; shift 2 ;;
      --severity)     severity="$2";   shift 2 ;;
      --ticket)       ticket="$2";     shift 2 ;;
      --orch)         orch="$2";       shift 2 ;;
      --payload-json) payload="$2";    shift 2 ;;
      *)              shift ;;
    esac
  done
  local ts; ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local line
  line="$(build_canonical_line \
    --ts            "$ts" \
    --severity      "$severity" \
    --service       "catalyst.worktree-salvage" \
    --event-name    "$event_name" \
    --entity        "worktree" \
    --action        "salvage" \
    --label         "$ticket" \
    --orch          "$orch" \
    --worker        "$ticket" \
    --linear-ticket "$ticket" \
    --payload-json  "$payload")" || return 0
  canonical_jsonl_append "${CATALYST_EVENTS_DIR:-${CATALYST_DIR:-$HOME/catalyst}/events}" "$line"
}

# emit_salvage_created — INFO: artifacts were saved.
emit_salvage_created() { _emit_salvage_event --event-name "worktree.salvage.created" --severity INFO "$@"; }
# emit_salvage_skipped — INFO: nothing to save (clean & fully pushed).
emit_salvage_skipped() { _emit_salvage_event --event-name "worktree.salvage.skipped" --severity INFO "$@"; }
# emit_salvage_failed — WARN: an artifact write errored.
emit_salvage_failed()  { _emit_salvage_event --event-name "worktree.salvage.failed"  --severity WARN "$@"; }
