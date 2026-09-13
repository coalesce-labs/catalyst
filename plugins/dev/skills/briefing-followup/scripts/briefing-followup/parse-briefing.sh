#!/usr/bin/env bash
# parse-briefing.sh — Load and parse a morning briefing markdown file for the
# briefing-followup skill (CTL-462 Phase 1).
#
# Subcommands:
#   path     [--date YYYY-MM-DD] [--root DIR]
#       Print the resolved briefing path. Does NOT check existence.
#
#   load     [--date YYYY-MM-DD] [--root DIR] [--file FILE]
#       Resolve + read briefing, print frontmatter as JSON.
#       Exits 1 if file missing (with a suggestion to run morning-briefing),
#       2 if frontmatter is malformed or absent.
#
#   decisions [--date Y] [--root D] [--file F] [--status open|all]
#       Print the decisions array as JSON. Default --status=open filters out
#       resolved/deferred entries.
#
#   decision [--date Y] [--root D] [--file F] --id DEC_ID
#       Print a single decision JSON by id. Exits 3 if id not found.
#
#   agenda    [--date Y] [--root D] [--file F] [--status open|all]
#       Print a human-readable numbered agenda, one decision per line.

set -uo pipefail

usage() {
  sed -n '2,30p' "$0"
}

# ─── Argument parsing helpers ───────────────────────────────────────────────
DATE=""
ROOT="${PWD}"
FILE=""
STATUS="open"
DEC_ID=""

parse_flags() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --date)   DATE="${2:-}"; shift 2 ;;
      --root)   ROOT="${2:-}"; shift 2 ;;
      --file)   FILE="${2:-}"; shift 2 ;;
      --status) STATUS="${2:-}"; shift 2 ;;
      --id)     DEC_ID="${2:-}"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *)
        echo "parse-briefing.sh: unknown flag: $1" >&2
        exit 2
        ;;
    esac
  done
}

resolve_path() {
  # If --file was passed, honor it.
  if [[ -n "$FILE" ]]; then
    printf '%s\n' "$FILE"
    return
  fi
  if [[ -z "$DATE" ]]; then
    DATE="$(date -u +%Y-%m-%d)"
  fi
  if ! [[ "$DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    echo "parse-briefing.sh: --date must be YYYY-MM-DD, got: $DATE" >&2
    exit 2
  fi
  printf '%s/thoughts/briefings/%s.md\n' "$ROOT" "$DATE"
}

# Read frontmatter from a markdown file and emit it as JSON via python3+yaml.
# Exits 1 if file missing (writes suggestion to stderr).
# Exits 2 if frontmatter absent or malformed (writes path to stderr).
emit_frontmatter_json() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    cat >&2 <<ERR
parse-briefing.sh: briefing not found: $file

Generate today's briefing with:
  /catalyst-dev:morning-briefing

Or pass --date YYYY-MM-DD to target a different day.
ERR
    exit 1
  fi

  # Extract the first --- ... --- block.
  local fm
  fm=$(awk '
    /^---[[:space:]]*$/ {
      if (in_block) { exit }
      in_block = 1; next
    }
    in_block { print }
  ' "$file")

  if [[ -z "$fm" ]]; then
    echo "parse-briefing.sh: no YAML frontmatter found in $file" >&2
    exit 2
  fi

  # YAML → JSON via python3 + PyYAML. `default=str` coerces YAML-native
  # date/datetime values (e.g. `date: 2026-04-03`) into JSON strings instead
  # of crashing json.dump on non-serializable types.
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
    echo "parse-briefing.sh: malformed YAML frontmatter in $file" >&2
    [[ -s "$err_log" ]] && cat "$err_log" >&2
    rm -f "$err_log"
    exit 2
  fi
  rm -f "$err_log"
}

# Filter a decisions JSON array by status. Pass "all" to skip filtering.
filter_decisions_json() {
  local status="$1"
  if [[ "$status" == "all" ]]; then
    jq '.decisions // []'
  else
    jq --arg s "$status" '[(.decisions // [])[] | select(.status == $s)]'
  fi
}

# ─── Subcommand dispatch ────────────────────────────────────────────────────
SUBCMD="${1:-}"
if [[ -z "$SUBCMD" ]]; then
  usage >&2
  exit 2
fi
shift

case "$SUBCMD" in
  path)
    parse_flags "$@"
    resolve_path
    ;;

  load)
    parse_flags "$@"
    FILE_PATH=$(resolve_path)
    emit_frontmatter_json "$FILE_PATH"
    echo
    ;;

  decisions)
    parse_flags "$@"
    FILE_PATH=$(resolve_path)
    emit_frontmatter_json "$FILE_PATH" | filter_decisions_json "$STATUS"
    ;;

  decision)
    parse_flags "$@"
    if [[ -z "$DEC_ID" ]]; then
      echo "parse-briefing.sh: decision subcommand requires --id" >&2
      exit 2
    fi
    FILE_PATH=$(resolve_path)
    DECISION=$(emit_frontmatter_json "$FILE_PATH" \
      | jq --arg id "$DEC_ID" '(.decisions // [])[] | select(.id == $id)')
    if [[ -z "$DECISION" || "$DECISION" == "null" ]]; then
      echo "parse-briefing.sh: no decision with id=$DEC_ID in $FILE_PATH" >&2
      exit 3
    fi
    printf '%s\n' "$DECISION"
    ;;

  agenda)
    parse_flags "$@"
    FILE_PATH=$(resolve_path)
    emit_frontmatter_json "$FILE_PATH" \
      | filter_decisions_json "$STATUS" \
      | jq -r 'to_entries | .[]
          | "\(.key + 1). [\(.value.id)] [\(.value.type)] \(.value.summary)"'
    ;;

  *)
    echo "parse-briefing.sh: unknown subcommand: $SUBCMD" >&2
    usage >&2
    exit 2
    ;;
esac
