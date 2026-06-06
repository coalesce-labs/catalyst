#!/usr/bin/env bash
# validate-learnings.sh — guard a learnings-store entry's YAML frontmatter against the silent-corruption
# traps and the required-field contract (see plugins/foundry/skills/ticket-compound/reference.md).
# Usage: validate-learnings.sh <path-to-entry.md>
# Exit 0 = valid; exit 1 = problems (printed to stderr). zsh/bash-safe.
set -uo pipefail

FILE="${1:-}"
[ -n "$FILE" ] && [ -f "$FILE" ] || { echo "validate-learnings: file not found: '$FILE'" >&2; exit 1; }

# Extract the frontmatter block (between the first two '---' lines).
fm="$(awk 'NR==1 && $0!="---"{print "NOFM"; exit} NR==1{next} $0=="---"{exit} {print}' "$FILE")"
if [ "$fm" = "NOFM" ] || [ -z "$fm" ]; then
  echo "validate-learnings: $FILE — missing or malformed --- frontmatter block" >&2; exit 1
fi

problems=0
err() { echo "validate-learnings: $FILE — $1" >&2; problems=$((problems+1)); }

# Required scalar keys.
for key in title date category problem_type component severity; do
  printf '%s\n' "$fm" | grep -qE "^${key}:[[:space:]]*[^[:space:]]" \
    || err "missing/empty required field: ${key}"
done

# YAML trap 1: an unquoted scalar value containing '#' (silently truncated as a comment).
# Flag `key: ... # ...` where the value isn't quoted.
printf '%s\n' "$fm" | grep -nE '^[a-z_]+:[[:space:]]+[^"'\''#]*#' \
  | while IFS= read -r line; do echo "validate-learnings: $FILE — unquoted '#' in value (will truncate): $line" >&2; done
printf '%s\n' "$fm" | grep -qE '^[a-z_]+:[[:space:]]+[^"'\''#]*#' && problems=$((problems+1)) || true

# YAML trap 2: an unquoted array item containing ': ' (parsed as a mapping).
#   tags: ["ok", bad: value]   or   - bad: value
printf '%s\n' "$fm" | grep -nE '^[[:space:]]*-[[:space:]]+[^"'\''].*:[[:space:]]' \
  | while IFS= read -r line; do echo "validate-learnings: $FILE — unquoted ': ' in list item (parsed as map): $line" >&2; done
printf '%s\n' "$fm" | grep -qE '^[[:space:]]*-[[:space:]]+[^"'\''].*:[[:space:]]' && problems=$((problems+1)) || true

# problem_type must be a known track value.
BUG='build_error|test_failure|runtime_error|logic_error|integration_issue|performance_issue|data_issue|security_issue'
KNOW='best_practice|architecture_pattern|convention|workflow_issue|developer_experience|documentation_gap|tooling_decision'
pt="$(printf '%s\n' "$fm" | sed -nE 's/^problem_type:[[:space:]]*"?([a-z_]+)"?.*/\1/p' | head -1)"
[ -n "$pt" ] && ! printf '%s' "$pt" | grep -qE "^(${BUG}|${KNOW})$" \
  && err "unknown problem_type: '$pt' (see reference.md)"

if [ "$problems" -gt 0 ]; then
  echo "validate-learnings: $FILE — $problems problem(s)" >&2; exit 1
fi
echo "validate-learnings: OK $FILE"
