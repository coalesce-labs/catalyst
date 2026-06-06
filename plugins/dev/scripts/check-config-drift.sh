#!/usr/bin/env bash
# Catalyst config-template drift detector (CTL-489).
#
# Compares a project's .catalyst/config.json against the canonical template at
# plugins/dev/templates/config.template.json and reports missing leaf keys.
#
# Modes:
#   (default)              emit warning lines to stdout (check-project-setup.sh style)
#   --json                 emit a JSON array of {path, template_value} objects
#   --merge-into FILE      write a merged config (existing values preserved, missing added)
#
# Options:
#   --config PATH    project config (default: .catalyst/config.json)
#   --template PATH  template (default: plugins/dev/templates/config.template.json)
#   --help|-h        show this header
#
# Exit codes: 0 no drift, 1 drift detected, 2 setup error.

set -uo pipefail

CONFIG_PATH=".catalyst/config.json"
TEMPLATE_PATH="plugins/dev/templates/config.template.json"
MODE="warn"            # warn | json | merge
MERGE_OUT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --json) MODE="json"; shift ;;
    --merge-into) MODE="merge"; MERGE_OUT="${2:-}"; shift 2 ;;
    --config) CONFIG_PATH="${2:-}"; shift 2 ;;
    --template) TEMPLATE_PATH="${2:-}"; shift 2 ;;
    --help|-h) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if ! command -v jq >/dev/null 2>&1; then
  echo "check-config-drift: jq not found on PATH" >&2
  exit 2
fi

if [ ! -e "$TEMPLATE_PATH" ]; then
  echo "check-config-drift: template not found: $TEMPLATE_PATH" >&2
  exit 2
fi

if [ ! -e "$CONFIG_PATH" ]; then
  echo "check-config-drift: config not found: $CONFIG_PATH" >&2
  exit 2
fi

# Validate template JSON (must be a real readable JSON document).
if ! jq -e . "$TEMPLATE_PATH" >/dev/null 2>&1; then
  echo "check-config-drift: template is not valid JSON: $TEMPLATE_PATH" >&2
  exit 2
fi

# Validate config JSON. Permit /dev/null and other empty inputs — the merge/drift
# logic below treats null/empty as "config has no keys at all" via `// {}`.
# Reject only the case where the file has content but it's malformed.
if [ -s "$CONFIG_PATH" ] && ! jq -e . "$CONFIG_PATH" >/dev/null 2>&1; then
  echo "check-config-drift: config is not valid JSON: $CONFIG_PATH" >&2
  exit 2
fi

# Paths whose absence is already reported by check-project-setup.sh — suppress to
# avoid double-warning. Match leaves whose path equals OR is rooted at one of these.
SUPPRESSED_ROOTS_JSON='[
  ["catalyst","projectKey"],
  ["catalyst","project","ticketPrefix"],
  ["catalyst","linear","teamKey"],
  ["catalyst","linear","stateMap"],
  ["catalyst","linear","stateIds"]
]'

# --merge-into: jq's `*` operator does a recursive merge. Project on the right
# means user values always win; template keys missing from project are added.
# Comment/$schema keys and placeholder branches are stripped from the template
# first so they don't pollute the merged output.
if [ "$MODE" = "merge" ]; then
  if [ -z "$MERGE_OUT" ]; then
    echo "check-config-drift: --merge-into requires a FILE argument" >&2
    exit 2
  fi
  TMP="${MERGE_OUT}.tmp.$$"
  JQ_ERR="${MERGE_OUT}.err.$$"
  if ! jq -n \
      --slurpfile t "$TEMPLATE_PATH" \
      --slurpfile p "$CONFIG_PATH" \
      '
      def strip_meta:
        walk(if type == "object"
             then with_entries(select(.key | IN("_comment","$comment","$schema") | not))
             else . end);
      # Drop entries whose KEY is a [YOUR_*] placeholder (e.g. the deploy
      # "[YOUR_ORG]/[YOUR_REPO]" sub-tree) AND entries whose VALUE is a
      # [YOUR_*] placeholder string (e.g. repository.org="[YOUR_ORG]").
      # Without the value filter, --merge-into would write placeholder
      # literals into the user'"'"'s config — the garbage-default class
      # this feature exists to prevent.
      def strip_placeholders:
        walk(if type == "object"
             then with_entries(
               select(
                 (.key | test("\\[YOUR_(ORG|REPO)\\]") | not)
                 and ((.value | type) != "string"
                      or ((.value | test("\\[YOUR_(ORG|REPO)\\]")) | not))
               ))
             else . end);
      ($t[0] | strip_meta | strip_placeholders) * ($p[0] // {})
      ' > "$TMP" 2>"$JQ_ERR"; then
    err=$(cat "$JQ_ERR" 2>/dev/null || true)
    rm -f "$TMP" "$JQ_ERR"
    echo "check-config-drift: merge failed${err:+: $err}" >&2
    exit 2
  fi
  rm -f "$JQ_ERR"
  if ! mv "$TMP" "$MERGE_OUT"; then
    rm -f "$TMP"
    echo "check-config-drift: failed to write $MERGE_OUT" >&2
    exit 2
  fi
  exit 0
fi

# Enumerate drifted leaves. The jq pipeline:
#   1. strip $schema/$comment/_comment keys from the template
#   2. enumerate leaf paths — arrays are treated as leaves themselves, NOT
#      descended into. `paths(type != "object")` emits both the array's path
#      and its integer-indexed element paths; filtering on `.[-1] | type ==
#      "string"` keeps only object-key paths and drops the array internals.
#      Users never set array elements by integer index, so reporting
#      "Missing catalyst.feedback.labels.0" is semantically wrong.
#   3. drop paths whose segments hit [YOUR_ORG]/[YOUR_REPO] placeholders
#   4. drop paths whose root is in the suppress list (already reported elsewhere)
#   5. drop paths the project already has set (getpath returns non-null)
#   6. emit each remaining {path, template_value} as one JSON object per line
DRIFT_ERR=$(mktemp 2>/dev/null || echo "/tmp/check-config-drift.err.$$")
DRIFT_JSON=$(jq -n \
  --slurpfile t "$TEMPLATE_PATH" \
  --slurpfile p "$CONFIG_PATH" \
  --argjson suppress "$SUPPRESSED_ROOTS_JSON" \
  '
  def strip_meta:
    walk(if type == "object"
         then with_entries(select(.key | IN("_comment","$comment","$schema") | not))
         else . end);
  def has_placeholder($p):
    any($p[]; tostring | test("\\[YOUR_(ORG|REPO)\\]"));
  def is_suppressed($p; $roots):
    any($roots[]; . as $root
                | ($p | length) >= ($root | length)
                  and ($p[0:($root|length)] == $root));
  def is_object_key_path($p):
    ($p | length) > 0 and (($p | .[-1] | type) == "string");
  ($t[0] | strip_meta) as $tmpl
  | ($p[0] // {}) as $proj
  | [ $tmpl
      | paths(type != "object") as $pp
      | select(is_object_key_path($pp))
      | select(has_placeholder($pp) | not)
      | select(is_suppressed($pp; $suppress) | not)
      | select(($proj | getpath($pp)) == null)
      | {path: $pp, template_value: ($tmpl | getpath($pp))} ]
  ' 2>"$DRIFT_ERR") || {
    err=$(cat "$DRIFT_ERR" 2>/dev/null || true)
    rm -f "$DRIFT_ERR"
    echo "check-config-drift: jq evaluation failed${err:+: $err}" >&2
    exit 2
}
rm -f "$DRIFT_ERR"

COUNT=$(jq -r 'length' <<<"$DRIFT_JSON")

if [ "$MODE" = "json" ]; then
  printf '%s\n' "$DRIFT_JSON"
  [ "$COUNT" -gt 0 ] && exit 1 || exit 0
fi

# Default (warn) mode — emit human-readable lines for check-project-setup.sh's
# warnings[] array. Two lines per missing key: the warning + an indented hint.
if [ "$COUNT" -eq 0 ]; then
  exit 0
fi

jq -r '
  .[] | (
    (.path | join(".")) as $p
    | (.template_value | tojson) as $v
    | "Missing \($p) in '"$CONFIG_PATH"' — template suggests \($v)",
      "  Run /catalyst-foundry:setup-catalyst to apply the missing key."
  )
' <<<"$DRIFT_JSON"

exit 1
