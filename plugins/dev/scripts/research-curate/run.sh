#!/usr/bin/env bash
# Usage: run.sh [--dry-run] [--reference-date YYYY-MM-DD] [--git-dir DIR]
#               [--skip-contradictions] [--llm-cmd CMD] [--contradictions-dest PATH]
#               <target-dir>
#
# Driver: walks <target-dir>, scores docs, writes INDEX.md, then (unless
# --skip-contradictions) clusters docs and appends LLM-surfaced contradictions
# to <target-dir>/CONTRADICTIONS.md.
#   Default:   <target-dir>/INDEX.md is overwritten; CONTRADICTIONS.md appended.
#   --dry-run: writes INDEX to /tmp/research-curate-INDEX-<basename>.md instead.
#              (CONTRADICTIONS.md is NOT touched during dry runs.)
#
# Summary lines on stdout:
#   <target-dir>: current=N needs-review=M likely-stale=K → <index-path>
#   <target-dir>: contradictions clusters=K appended=M → <contradictions-path>
#
# --reference-date and --git-dir are passed through to score.sh.
# --llm-cmd CMD overrides the default LLM invocation for contradict.sh
# (default: "claude -p"). Tests substitute a deterministic mock.

set -uo pipefail

DRY_RUN=0
REFERENCE_DATE=""
GIT_DIR=""
TARGET_DIR=""
SKIP_CONTRADICTIONS=0
LLM_CMD=""
CONTRA_DEST=""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INVENTORY="${SCRIPT_DIR}/inventory.sh"
SCORE="${SCRIPT_DIR}/score.sh"
GENERATE="${SCRIPT_DIR}/generate-index.sh"
CLUSTER="${SCRIPT_DIR}/cluster.sh"
CONTRADICT="${SCRIPT_DIR}/contradict.sh"
APPEND="${SCRIPT_DIR}/append-contradictions.sh"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --reference-date) REFERENCE_DATE="$2"; shift 2 ;;
    --git-dir) GIT_DIR="$2"; shift 2 ;;
    --skip-contradictions) SKIP_CONTRADICTIONS=1; shift ;;
    --llm-cmd) LLM_CMD="$2"; shift 2 ;;
    --contradictions-dest) CONTRA_DEST="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,18p' "$0"
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

# ---------------------------------------------------------------------------
# Contradiction detection (CTL-468). Skipped during --dry-run or when
# --skip-contradictions is set. Pipes inventory → cluster → contradict → append.
# ---------------------------------------------------------------------------
if (( ! SKIP_CONTRADICTIONS )) && (( ! DRY_RUN )); then
  CLUSTERS=$(bash "$INVENTORY" "$TARGET_DIR" | bash "$CLUSTER")
  CLUSTER_COUNT=$(printf '%s\n' "$CLUSTERS" | grep -c '^{' || true)

  if (( CLUSTER_COUNT > 0 )); then
    CONTRA_ARGS=(--inventory-dir "$TARGET_DIR")
    [[ -n "$LLM_CMD" ]] && CONTRA_ARGS+=(--llm-cmd "$LLM_CMD")

    CONTRA=$(printf '%s\n' "$CLUSTERS" | bash "$CONTRADICT" "${CONTRA_ARGS[@]}")
    APPEND_COUNT=$(printf '%s\n' "$CONTRA" | grep -c '^{' || true)

    CONTRA_DEST="${CONTRA_DEST:-${TARGET_DIR}/CONTRADICTIONS.md}"
    APPEND_ARGS=()
    [[ -n "$REFERENCE_DATE" ]] && APPEND_ARGS+=(--date "$REFERENCE_DATE")

    if (( APPEND_COUNT > 0 )); then
      printf '%s\n' "$CONTRA" | bash "$APPEND" "${APPEND_ARGS[@]}" "$CONTRA_DEST"
    fi

    echo "${TARGET_DIR}: contradictions clusters=${CLUSTER_COUNT} appended=${APPEND_COUNT} → ${CONTRA_DEST}"
  else
    echo "${TARGET_DIR}: contradictions clusters=0 (no eligible clusters)"
  fi
fi
