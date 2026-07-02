#!/usr/bin/env bash
# PreToolUse/Bash hook: detect a bare single-ticket `linearis issues read <arg>`
# that bypasses the replica — for LITERAL ids AND shell-variable forms ($T, "$T",
# ${T}, $(...)). Flag-order independent. EXEMPT the one sanctioned linearis read the
# replica can't serve: --with-attachments. Comments are fetched via `linearis
# comments list` (structurally outside `issues read`), so no comment exemption is
# needed. Mode: CATALYST_LINEAR_READ_DETECT_MODE (observe|enforce; default observe).
set -uo pipefail
input="$(cat)"                                   # Claude Code pipes the tool call as JSON on stdin
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)"
[[ -n "$cmd" ]] || exit 0

# Is this an `issues read` at all? (verb `read` excludes list/search/create/update/
# comments/usage/auth). Allow arbitrary flags/tokens between `linearis` and `issues`.
printf '%s' "$cmd" | grep -Eq 'linearis([[:space:]]+[^[:space:]]+)*[[:space:]]+issues[[:space:]]+read([[:space:]]|$)' || exit 0
# Sanctioned exemption: attachments have no replica form.
printf '%s' "$cmd" | grep -Eq -- '--with-attachments' && exit 0

# Literal id if present; else variable-form → unknown (still counted/blocked).
id="$(printf '%s' "$cmd" | grep -Eo '[A-Za-z][A-Za-z0-9]*-[0-9]+' | head -1)"
id="${id:-unknown}"

# Count it in Loki (same event as E1; source=raw-cli-hook, reason=no-gate).
LIB="$(dirname "$0")/../scripts/lib/linear-read-replica.sh"
[[ -r "$LIB" ]] && { source "$LIB"; _lrr_emit_fallback_event "$id" no-gate raw-cli-hook; }

if [[ "${CATALYST_LINEAR_READ_DETECT_MODE:-observe}" == "enforce" ]]; then
  echo "Blocked: '$cmd' hits the rate-limited Linear API. Use the replica: source plugins/dev/scripts/lib/linear-read-replica.sh && linear_read_ticket ${id/unknown/<ID>} (or gate + sqlite3 the replica). Attachments? add --with-attachments (exempt). See the linearis skill 'Reading Linear'." >&2
  exit 2                                          # exit 2 = block the tool call, feed stderr to the model
fi
# observe mode: warn + allow (does NOT hard-stop the read — see deploy plan).
echo "note: this bypassed the replica — prefer linear_read_ticket ${id/unknown/<ID>} (linearis skill 'Reading Linear')." >&2
exit 0
