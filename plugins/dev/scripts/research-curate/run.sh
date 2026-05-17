#!/usr/bin/env bash
# Usage: run.sh [--dry-run] [--reference-date YYYY-MM-DD] [--git-dir DIR] <target-dir>
#
# Driver: walks <target-dir>, scores docs, writes INDEX.md.
#   Default:   <target-dir>/INDEX.md is overwritten.
#   --dry-run: writes to /tmp/research-curate-INDEX-<basename>.md instead.
#
# Also emits one summary line to stdout per invocation:
#   <target-dir>: current=N needs-review=M likely-stale=K
#
# --reference-date and --git-dir are passed through to score.sh (useful for tests).

set -uo pipefail

DRY_RUN=0
REFERENCE_DATE=""
GIT_DIR=""
TARGET_DIR=""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INVENTORY="${SCRIPT_DIR}/inventory.sh"
SCORE="${SCRIPT_DIR}/score.sh"
GENERATE="${SCRIPT_DIR}/generate-index.sh"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --reference-date) REFERENCE_DATE="$2"; shift 2 ;;
    --git-dir) GIT_DIR="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    --)
      shift
      TARGET_DIR="${1:-}"
      shift
      ;;
    -*)
      echo "run.sh: unknown flag: $1" >&2
      exit 2
      ;;
    *)
      TARGET_DIR="$1"
      shift
      ;;
  esac
done

if [[ -z "$TARGET_DIR" || ! -d "$TARGET_DIR" ]]; then
  echo "run.sh: target dir missing or not a directory: '$TARGET_DIR'" >&2
  exit 2
fi

# Build score args
SCORE_ARGS=()
[[ -n "$REFERENCE_DATE" ]] && SCORE_ARGS+=(--reference-date "$REFERENCE_DATE")
[[ -n "$GIT_DIR" ]] && SCORE_ARGS+=(--git-dir "$GIT_DIR")

LABEL=$(basename "$TARGET_DIR")

# Pipe through inventory → score → generate-index
SCORED=$(bash "$INVENTORY" "$TARGET_DIR" | bash "$SCORE" "${SCORE_ARGS[@]}")
INDEX_OUT=$(echo "$SCORED" | bash "$GENERATE" "$LABEL")

# Pick destination
if (( DRY_RUN )); then
  DEST="/tmp/research-curate-INDEX-${LABEL}.md"
else
  DEST="${TARGET_DIR}/INDEX.md"
fi

printf '%s' "$INDEX_OUT" > "$DEST"

# Summary line
CUR=$(echo "$SCORED" | grep -c '"status":"current"' || true)
NR=$(echo "$SCORED" | grep -c '"status":"needs-review"' || true)
LS=$(echo "$SCORED" | grep -c '"status":"likely-stale"' || true)
echo "${TARGET_DIR}: current=${CUR} needs-review=${NR} likely-stale=${LS} → ${DEST}"
