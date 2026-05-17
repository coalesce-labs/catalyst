#!/usr/bin/env bash
# validate-frontmatter.sh — Validate the YAML frontmatter of a briefing markdown
# file against plugins/dev/templates/briefing-frontmatter.schema.json.
#
# Usage:
#   validate-frontmatter.sh <briefing.md>
#
# Exit 0 = valid, exit 1 = invalid (with diagnostics on stderr).

set -euo pipefail

FILE="${1:-}"
if [[ -z "$FILE" ]]; then
  echo "validate-frontmatter.sh: missing path argument" >&2
  exit 2
fi
if [[ ! -f "$FILE" ]]; then
  echo "validate-frontmatter.sh: file not found: $FILE" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCHEMA="${SCRIPT_DIR}/../../templates/briefing-frontmatter.schema.json"
if [[ ! -f "$SCHEMA" ]]; then
  echo "validate-frontmatter.sh: schema not found at $SCHEMA" >&2
  exit 2
fi

# Extract the first --- ... --- block.
FRONTMATTER=$(awk '
  /^---[[:space:]]*$/ {
    if (in_block) { exit }
    in_block = 1; next
  }
  in_block { print }
' "$FILE")

if [[ -z "$FRONTMATTER" ]]; then
  echo "validate-frontmatter.sh: no frontmatter block found in $FILE" >&2
  exit 1
fi

# YAML → JSON via python, then validate via jsonschema.
JSON=$(printf '%s\n' "$FRONTMATTER" | python3 -c 'import sys, json, yaml; json.dump(yaml.safe_load(sys.stdin), sys.stdout)') || {
  echo "validate-frontmatter.sh: failed to parse YAML frontmatter" >&2
  exit 1
}

# jsonschema CLI takes the instance from stdin via -i - in some versions; use a tempfile for portability.
INSTANCE_TMP=$(mktemp)
trap 'rm -f "$INSTANCE_TMP"' EXIT
printf '%s' "$JSON" > "$INSTANCE_TMP"

if ! jsonschema -i "$INSTANCE_TMP" "$SCHEMA" 2>/tmp/.morning-briefing-validate-err.$$; then
  echo "validate-frontmatter.sh: schema validation failed for $FILE" >&2
  cat /tmp/.morning-briefing-validate-err.$$ >&2
  rm -f /tmp/.morning-briefing-validate-err.$$
  exit 1
fi
rm -f /tmp/.morning-briefing-validate-err.$$

echo "ok"
exit 0
