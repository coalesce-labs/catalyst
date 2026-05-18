#!/usr/bin/env bash
# Usage: contradict.sh [--llm-cmd CMD] [--sample-chars N] [--inventory-dir DIR]
#
# Reads cluster JSONL on stdin (from cluster.sh) and invokes --llm-cmd once
# per cluster with a bounded prompt. Emits one record per line on stdout for
# clusters where the LLM returned at least one contradiction:
#   {"cluster_id":"c1","topic":"<cluster topic>",
#    "contradictions":[{"between":["slug-A","slug-B"],
#                       "claim_a":"...","claim_b":"...","explanation":"..."}, ...]}
#
# Per-cluster steps:
#   1. Re-read each doc's body from --inventory-dir (or cluster doc.path if present).
#   2. Strip frontmatter; take first --sample-chars bytes.
#   3. Build a prompt asking for contradictions; pipe to $LLM_CMD on stdin.
#   4. Parse the response as strict JSON. On parse failure, warn + skip.
#   5. Drop clusters with zero contradictions.
#
# Defaults: --llm-cmd "claude -p", --sample-chars 1500.

set -uo pipefail

# CTL-495: tag OTEL stream as research-curate-contradict so Grafana cost can be
# sliced. The export propagates to the eval'd $LLM_CMD subprocess below.
# shellcheck source=../lib/task-type.sh
. "$(dirname "$0")/../lib/task-type.sh"
__catalyst_append_task_type "research-curate-contradict"

LLM_CMD="claude -p"
SAMPLE_CHARS=1500
INVENTORY_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --llm-cmd) LLM_CMD="$2"; shift 2 ;;
    --sample-chars) SAMPLE_CHARS="$2"; shift 2 ;;
    --inventory-dir) INVENTORY_DIR="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "contradict.sh: unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Strip YAML frontmatter (lines from the first --- to the next ---) and emit
# the first $SAMPLE_CHARS bytes of the remainder.
extract_excerpt() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    printf '(file not found: %s)' "$file"
    return
  fi
  awk 'BEGIN {in_fm=0; first=1}
       first==1 && /^---$/ {in_fm=1; first=0; next}
       first==1 {first=0; print; next}
       in_fm==1 && /^---$/ {in_fm=0; next}
       in_fm==1 {next}
       {print}' "$file" \
    | head -c "$SAMPLE_CHARS"
}

# Resolve a doc's filesystem path. Prefer the embedded `path` field; fall back
# to `<inventory-dir>/<filename>`.
resolve_doc_path() {
  local cluster_json="$1" idx="$2"
  local p
  p=$(jq -r --argjson i "$idx" '.docs[$i].path // ""' <<<"$cluster_json")
  if [[ -z "$p" || ! -f "$p" ]]; then
    local fname
    fname=$(jq -r --argjson i "$idx" '.docs[$i].filename' <<<"$cluster_json")
    if [[ -n "$INVENTORY_DIR" ]]; then
      p="${INVENTORY_DIR}/${fname}"
    fi
  fi
  printf '%s' "$p"
}

# Strip .md extension from a filename to produce a wiki slug.
slug() {
  local s="$1"
  s="${s%.md}"
  printf '%s' "$s"
}

build_prompt() {
  local cluster_json="$1"
  local ndocs
  ndocs=$(jq '.docs | length' <<<"$cluster_json")

  printf 'You are auditing a research corpus for contradictory claims.\n\n'
  printf 'Below are %d research notes that share related topics. Identify any places\n' "$ndocs"
  printf 'where two notes make contradicting claims about the same subject.\n\n'
  printf 'Respond with strict JSON only (no prose, no code fences):\n'
  printf '{"contradictions":[{"between":["<slug-A>","<slug-B>"],"claim_a":"<text>","claim_b":"<text>","explanation":"<one sentence>"}]}\n\n'
  printf 'If no contradictions exist, respond with {"contradictions":[]}.\n\n'

  local i fname topic doc_path
  for ((i=0; i<ndocs; i++)); do
    fname=$(jq -r --argjson i "$i" '.docs[$i].filename' <<<"$cluster_json")
    topic=$(jq -r --argjson i "$i" '.docs[$i].topic // ""' <<<"$cluster_json")
    doc_path=$(resolve_doc_path "$cluster_json" "$i")

    printf '### [[%s]]\n' "$(slug "$fname")"
    if [[ -n "$topic" ]]; then
      printf 'Topic: %s\n' "$topic"
    fi
    printf 'Excerpt:\n'
    extract_excerpt "$doc_path"
    printf '\n\n'
  done
}

# Stream clusters from stdin; one per line.
while IFS= read -r cluster_json; do
  [[ -z "$cluster_json" ]] && continue

  CID=$(jq -r '.cluster_id' <<<"$cluster_json")
  TOPIC=$(jq -r '.topic' <<<"$cluster_json")

  PROMPT=$(build_prompt "$cluster_json")

  # Pipe prompt to LLM_CMD. Capture stdout; ignore stderr from the LLM.
  set +e
  RESPONSE=$(printf '%s' "$PROMPT" | eval "$LLM_CMD" 2>/dev/null)
  LLM_EXIT=$?
  set -e

  if [[ "$LLM_EXIT" -ne 0 ]]; then
    echo "warn: cluster ${CID} LLM exited non-zero (${LLM_EXIT}) — skipping" >&2
    continue
  fi

  # Parse JSON defensively
  if ! CONTRADICTIONS=$(jq -c '.contradictions // []' <<<"$RESPONSE" 2>/dev/null); then
    echo "warn: cluster ${CID} LLM returned non-JSON — skipping" >&2
    continue
  fi

  COUNT=$(jq 'length' <<<"$CONTRADICTIONS")
  if [[ "$COUNT" -eq 0 ]]; then
    continue
  fi

  jq -nc --arg cid "$CID" --arg topic "$TOPIC" --argjson c "$CONTRADICTIONS" \
    '{cluster_id: $cid, topic: $topic, contradictions: $c}'
done
