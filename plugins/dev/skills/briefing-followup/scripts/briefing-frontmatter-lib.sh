#!/usr/bin/env bash
# briefing-frontmatter-lib.sh — Shared helpers for reading the YAML frontmatter
# of briefing markdown files. Source from any briefing-related script that
# needs to extract or parse the leading `--- ... ---` block.
#
# Public functions:
#   bf_fm_extract <file>    Echo the YAML block (between the two `---` lines).
#                           Exit 0 on success, 1 if file missing, 2 if no block.
#   bf_fm_to_json  <file>   YAML → JSON via python3+yaml. Same exit codes as
#                           bf_fm_extract, plus 3 on YAML parse error.
#   bf_fm_split   <file>    Echo fm block + body separator + body. The fm and
#                           body are split on `\0` (NUL) so callers can `read -d`
#                           them apart without a tempfile.
#
# The extraction logic mirrors the inline awk previously duplicated in
# parse-briefing.sh and morning-briefing/validate-frontmatter.sh — both callers
# can migrate to these helpers without behavior change.

# Idempotent guard so dot-sourcing twice is a no-op.
if [[ -n "${__CATALYST_BRIEFING_FM_LIB_SOURCED:-}" ]]; then
  return 0 2>/dev/null || exit 0
fi
__CATALYST_BRIEFING_FM_LIB_SOURCED=1

bf_fm_extract() {
  local file="${1:-}"
  if [[ -z "$file" ]]; then
    echo "bf_fm_extract: file argument required" >&2; return 2
  fi
  if [[ ! -f "$file" ]]; then
    echo "bf_fm_extract: file not found: $file" >&2; return 1
  fi
  local fm
  fm=$(awk '
    /^---[[:space:]]*$/ {
      if (in_block) { exit }
      in_block = 1; next
    }
    in_block { print }
  ' "$file")
  if [[ -z "$fm" ]]; then
    echo "bf_fm_extract: no YAML frontmatter found in $file" >&2; return 2
  fi
  printf '%s\n' "$fm"
}

bf_fm_to_json() {
  local file="${1:-}"
  local fm
  fm=$(bf_fm_extract "$file") || return $?
  local err_log
  err_log=$(mktemp)
  if ! printf '%s\n' "$fm" | python3 -c '
import sys, json, yaml
try:
    data = yaml.safe_load(sys.stdin)
except yaml.YAMLError as e:
    sys.stderr.write("YAML parse error: " + str(e) + "\n")
    sys.exit(3)
if not isinstance(data, dict):
    sys.stderr.write("YAML root must be a mapping\n")
    sys.exit(3)
json.dump(data, sys.stdout, default=str)
' 2>"$err_log"; then
    echo "bf_fm_to_json: malformed YAML frontmatter in $file" >&2
    [[ -s "$err_log" ]] && cat "$err_log" >&2
    rm -f "$err_log"
    return 3
  fi
  rm -f "$err_log"
}

bf_fm_body() {
  # Echo the markdown body (everything AFTER the closing `---`).
  local file="${1:-}"
  if [[ -z "$file" ]]; then
    echo "bf_fm_body: file argument required" >&2; return 2
  fi
  if [[ ! -f "$file" ]]; then
    echo "bf_fm_body: file not found: $file" >&2; return 1
  fi
  awk '
    BEGIN { dashes = 0 }
    /^---[[:space:]]*$/ {
      dashes++
      if (dashes == 2) { in_body = 1; next }
      next
    }
    in_body { print }
  ' "$file"
}

# When sourced from a script that runs in `set -e`, ensure we return 0 so the
# source itself never aborts the caller.
return 0 2>/dev/null || true
