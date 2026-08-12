#!/usr/bin/env bash
# write-phase-thoughts-doc.sh (CTL-1490) — write a durable local thoughts doc
# for a phase skill. Written unconditionally (cheap, enables single-host
# reconstruct); the sync gate in thoughts-sync-gate.sh controls the off-machine
# push. Single source of truth for the doc path and file-name format.
#
# Source this file, then call write_phase_thoughts_doc.
#
# Usage:
#   source "${PLUGIN_ROOT}/scripts/lib/write-phase-thoughts-doc.sh"
#   write_phase_thoughts_doc <phase-name> <ticket> <body>
#
# Writes to: thoughts/shared/phase-<phase>/<YYYY-MM-DD>-<ticket-lower>.md
# Best-effort: never blocks or fails the caller (exits with 0 always).

if [[ -n "${_WRITE_PHASE_THOUGHTS_DOC_LOADED:-}" ]]; then
  return 0
fi
_WRITE_PHASE_THOUGHTS_DOC_LOADED=1

# Exports CATALYST_PHASE_THOUGHTS_DOC — the path actually written, consumed by
# thoughts-sync-gate.sh so a BLOCKING sync failure can invalidate the document it
# could not publish (CTL-1490 Codex P1). Without that, the doc survives the failed
# gate and reconstruct-ticket-state.mjs — which treats mere presence as proof of
# completion — advances past a phase that did not complete. Handing the path over
# in the environment keeps the invalidation at the ONE gate all eight phase skills
# already call, instead of eight copies of the same cleanup that a ninth skill
# would silently forget.
write_phase_thoughts_doc() {
  local phase="$1" ticket="$2" body="$3"
  local dir="thoughts/shared/phase-${phase}"
  # NB: the local is named doc_path, NOT path. Under zsh, `path` is a special
  # array tied to $PATH; `local path` scopes it locally and resets it to empty,
  # making `tr`, `date`, and `mkdir` unresolvable for the rest of the function
  # (silently swallowed by the pre-existing 2>/dev/null guards). Bash treats
  # `path` as ordinary, so the bug is zsh-only. See linear-team-keys.sh:22-27
  # for the prior fix in the same class. CTL-1777.
  local ticket_lc date_prefix doc_path
  ticket_lc="$(printf '%s' "$ticket" | tr '[:upper:]' '[:lower:]')"
  date_prefix="$(date +%Y-%m-%d)"
  export CATALYST_PHASE_THOUGHTS_DOC=""
  if ! mkdir -p "$dir" 2>/dev/null; then
    echo "write_phase_thoughts_doc: mkdir failed for ${dir}" >&2
    return 0
  fi
  doc_path="${dir}/${date_prefix}-${ticket_lc}.md"
  if printf '%s\n' "$body" > "$doc_path" 2>/dev/null; then
    export CATALYST_PHASE_THOUGHTS_DOC="$doc_path"
  else
    echo "write_phase_thoughts_doc: write failed for ${doc_path}" >&2
  fi
}
