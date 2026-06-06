#!/usr/bin/env bash
# render.sh — Render the canonical morning-briefing markdown from a JSON input.
#
# Usage:
#   render.sh --input <json-file> --output <md-file>
#   cat data.json | render.sh --output <md-file>
#
# Input JSON shape:
# {
#   "date": "YYYY-MM-DD",
#   "yesterday": {
#     "linear":   [{"id":"CTL-100","title":"...","state":"Done"}, ...],
#     "github":   [{"number":799,"title":"...","url":"..."}, ...],
#     "granola":  [{"id":"not_...","title":"...","created_at":"..."}, ...],
#     "drive":    [{"id":"...","title":"...","modified":"..."}, ...],
#     "calendar": [{"id":"...","title":"...","start":"..."}, ...]
#   },
#   "decisions": [{"id":"...","type":"...","summary":"...","status":"..."}, ...],
#   "today": {
#     "linear_in_progress": [{"id":"CTL-200","title":"..."}, ...],
#     "calendar":           [{"title":"...","start":"..."}, ...],
#     "followups":          [{"source":"granola","action":"..."}, ...],
#     "retro_signals":      [{"title":"watch: ..."}, ...]
#   },
#   "suggested_runs": [{"id":"CTL-300","title":"...","priority":"High"}, ...]
# }

set -euo pipefail

INPUT=""
OUTPUT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --input) INPUT="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "render.sh: unknown flag $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$OUTPUT" ]]; then
  echo "render.sh: --output is required" >&2
  exit 2
fi

# Load input JSON (file or stdin)
if [[ -n "$INPUT" ]]; then
  [[ -f "$INPUT" ]] || { echo "render.sh: --input file not found: $INPUT" >&2; exit 2; }
  DATA=$(cat "$INPUT")
else
  DATA=$(cat)
fi

# Validate it parses as JSON
if ! jq -e . >/dev/null 2>&1 <<<"$DATA"; then
  echo "render.sh: input is not valid JSON" >&2
  exit 2
fi

DATE=$(jq -r '.date // empty' <<<"$DATA")
if [[ -z "$DATE" ]]; then
  echo "render.sh: input JSON must have a .date field" >&2
  exit 2
fi

# Ensure output dir exists
mkdir -p "$(dirname "$OUTPUT")"

# Render the frontmatter — emit YAML by hand for stable formatting.
# Items are JSON-encoded so they survive special characters.
render_section() {
  local section_key="$1"
  local heading="$2"
  local items
  items=$(jq -c "(${section_key}) // []" <<<"$DATA")
  local count
  count=$(jq -r 'length' <<<"$items")

  echo "## ${heading}"
  echo
  if [[ "$count" -eq 0 ]]; then
    echo "_no data_"
    echo
    return
  fi

  jq -r '.[] | "- " + (
    if .title and .id then "[\(.id)] \(.title)"
    elif .title and .number then "[#\(.number)] \(.title)"
    elif .title then .title
    elif .summary then .summary
    elif .action then .action
    else (. | tostring) end
  ) + (if (.url // "") != "" then "  <\(.url)>" else "" end)' <<<"$items"
  echo
}

{
  echo "---"
  # Use python yaml for safe serialization of arbitrary structure
  jq -n \
    --arg date "$DATE" \
    --argjson decisions "$(jq -c '.decisions // []' <<<"$DATA")" \
    --argjson meetings "$(jq -c '.yesterday.granola // []' <<<"$DATA")" \
    --argjson prs "$(jq -c '.yesterday.github // []' <<<"$DATA")" \
    '{
      date: $date,
      generated_by: "morning-briefing",
      decisions: $decisions,
      meetings_yesterday: $meetings,
      prs_merged_yesterday: $prs
    }' | python3 -c 'import sys, json, yaml; yaml.safe_dump(json.load(sys.stdin), sys.stdout, default_flow_style=False, sort_keys=False)'
  echo "---"
  echo
  echo "# Morning Briefing — ${DATE}"
  echo

  echo "## Review yesterday"
  echo
  render_section '.yesterday.linear'  'Linear (state changes)' | sed 's/^## /### /'
  render_section '.yesterday.github'  'GitHub (merged PRs)'    | sed 's/^## /### /'
  render_section '.yesterday.granola' 'Granola (meetings)'     | sed 's/^## /### /'
  render_section '.yesterday.drive'   'Drive (notes)'          | sed 's/^## /### /'
  render_section '.yesterday.calendar' 'Calendar (events)'     | sed 's/^## /### /'

  echo "## Surface decisions"
  echo
  decisions_count=$(jq -r '(.decisions // []) | length' <<<"$DATA")
  if [[ "$decisions_count" -eq 0 ]]; then
    echo "_no data_"
    echo
  else
    jq -r '.decisions[] | "- **[" + .type + "]** " + .summary + " (`" + .id + "`, status: " + .status + ")"' <<<"$DATA"
    echo
  fi

  echo "## Plan today"
  echo
  render_section '.today.linear_in_progress' 'Linear in-progress' | sed 's/^## /### /'
  render_section '.today.calendar'           'Calendar today'     | sed 's/^## /### /'
  render_section '.today.followups'          'Follow-ups'         | sed 's/^## /### /'
  # CTL-814: latest ticket-retro's top recurring patterns + open watch-items.
  render_section '.today.retro_signals'      'Retro signals'      | sed 's/^## /### /'

  echo "## Suggest orchestrator runs"
  echo
  runs_count=$(jq -r '(.suggested_runs // []) | length' <<<"$DATA")
  if [[ "$runs_count" -eq 0 ]]; then
    echo "_no data_"
  else
    jq -r '.suggested_runs[] | "- `" + .id + "` " + .title + (if .priority then " _(\(.priority))_" else "" end)' <<<"$DATA"
  fi
  echo
} > "$OUTPUT"

printf '%s\n' "$OUTPUT"
