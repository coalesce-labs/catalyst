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

# Detect per COMMAND SEGMENT, not payload-wide, so a sanctioned `--with-attachments`
# read in the same tool call can't shield a sibling bare read
# (e.g. `linearis issues read A; linearis issues read B --with-attachments`). Split on
# shell separators (;, &, |, newline) — sufficient for the payload shapes agents emit.
# A segment is a BARE read iff it is an `issues read` (verb `read` excludes list/search/
# create/update/comments/usage/auth) WITHOUT --with-attachments (the one replica-less read).
bare=""
while IFS= read -r seg; do
  printf '%s' "$seg" | grep -Eq 'linearis([[:space:]]+[^[:space:]]+)*[[:space:]]+issues[[:space:]]+read([[:space:]]|$)' || continue
  printf '%s' "$seg" | grep -Eq -- '--with-attachments' && continue   # sanctioned attachment read — exempt
  bare="$seg"; break
done < <(printf '%s\n' "$cmd" | tr ';&|' '\n')
[[ -n "$bare" ]] || exit 0

# Literal id in the OFFENDING segment if present; else variable-form → unknown (still counted/blocked).
id="$(printf '%s' "$bare" | grep -Eo '[A-Za-z][A-Za-z0-9]*-[0-9]+' | head -1)"
id="${id:-unknown}"

# Count it in Loki (same event as E1; source=raw-cli-hook, reason=no-gate).
LIB="$(dirname "$0")/../scripts/lib/linear-read-replica.sh"
[[ -r "$LIB" ]] && { source "$LIB"; _lrr_emit_fallback_event "$id" no-gate raw-cli-hook; }

if [[ "${CATALYST_LINEAR_READ_DETECT_MODE:-observe}" == "enforce" ]]; then
  echo "Blocked: '$bare' hits the rate-limited Linear API. Use the replica: source plugins/dev/scripts/lib/linear-read-replica.sh && linear_read_ticket ${id/unknown/<ID>} (or gate + sqlite3 the replica). Attachments? add --with-attachments (exempt). See the linearis skill 'Reading Linear'." >&2
  exit 2                                          # exit 2 = block the tool call, feed stderr to the model
fi
# observe mode: warn + allow (does NOT hard-stop the read — see deploy plan).
echo "note: this bypassed the replica — prefer linear_read_ticket ${id/unknown/<ID>} (linearis skill 'Reading Linear')." >&2
exit 0
