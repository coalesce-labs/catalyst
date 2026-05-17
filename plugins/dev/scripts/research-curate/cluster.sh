#!/usr/bin/env bash
# Usage: cluster.sh [--threshold FLOAT] [--max-cluster-size N]
#
# Reads inventory JSONL on stdin (one doc per line from inventory.sh) and
# emits cluster JSONL on stdout:
#   {"cluster_id":"c1","topic":"orchestrator+state+workers",
#    "docs":[{"filename":...,"topic":...,"tags":[...]}, ...]}
#
# Algorithm (v1):
#   1. Build a token set per doc = lowercase(tags) ∪ tokenize(topic).
#   2. For every pair (i,j), compute Jaccard. If ≥ threshold, union(i,j).
#   3. Group by union-find root. Drop clusters of size < 3. Cap at
#      --max-cluster-size (default 10) by keeping the first N members
#      in the deterministic input order; the rest are dropped from this run.
#
# Defaults: --threshold 0.4, --max-cluster-size 10.

set -uo pipefail

THRESHOLD=0.4
MAX_SIZE=10

while [[ $# -gt 0 ]]; do
  case "$1" in
    --threshold) THRESHOLD="$2"; shift 2 ;;
    --max-cluster-size) MAX_SIZE="$2"; shift 2 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "cluster.sh: unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Slurp JSONL into a JSON array
ENTRIES=$(jq -s '.' </dev/stdin)
N=$(jq 'length' <<<"$ENTRIES")

if [[ "$N" -lt 3 ]]; then
  # Nothing can cluster — emit nothing.
  exit 0
fi

# Decorate each entry with `tokens` (tags ∪ tokenized topic, stopword-filtered).
DECORATED=$(jq -c '
  def stopwords: ["the","and","for","with","from","that","this","not","but","you","are","its","has","was","were","into","over","under","than","then","they","them","their","there","here","when","what","where","which","while","also","more","most","some","such","only","just","very","one","two","three","four","about","upon","onto","without","within","via","per","each","both","other"];
  def tokenize(s):
    (s // "")
    | ascii_downcase
    | gsub("[^a-z0-9]+"; " ")
    | split(" ")
    | map(select(length >= 3))
    | map(select(. as $t | stopwords | index($t) | not));
  map(
    . as $e |
    ((($e.tags // []) | map(ascii_downcase))
      + tokenize($e.topic // "")
      + tokenize(($e.filename // "") | gsub("\\.md$"; ""))) as $raw |
    $e + {tokens: ($raw | unique)}
  )
' <<<"$ENTRIES")

# Initialize union-find parent array
declare -a parent
for ((i=0; i<N; i++)); do parent[$i]=$i; done

uf_find() {
  local x=$1
  while [[ "${parent[$x]}" != "$x" ]]; do
    parent[$x]=${parent[${parent[$x]}]}
    x=${parent[$x]}
  done
  printf '%s' "$x"
}

uf_union() {
  local rx ry
  rx=$(uf_find "$1")
  ry=$(uf_find "$2")
  if [[ "$rx" != "$ry" ]]; then
    parent[$rx]=$ry
  fi
}

# Compute pairwise Jaccard and union when ≥ threshold.
# Streamed in one jq pass: emit "<i> <j> <jaccard>" lines for all i<j.
PAIRS=$(jq -r --argjson n "$N" '
  . as $d |
  [range(0; $n)] as $idx |
  [
    $idx[] as $i | $idx[] as $j | select($j > $i) |
    ($d[$i].tokens) as $a | ($d[$j].tokens) as $b |
    ($a | length) as $la | ($b | length) as $lb |
    (if ($la == 0 or $lb == 0) then 0
     else
       ([$a[], $b[]] | group_by(.) | map(select(length > 1)) | length) as $inter |
       (($a + $b) | unique | length) as $union |
       (if $union == 0 then 0 else ($inter / $union) end)
     end) as $jac |
     "\($i) \($j) \($jac)"
  ] | .[]
' <<<"$DECORATED")

while IFS=' ' read -r i j jac; do
  [[ -z "$i" ]] && continue
  # Floating point comparison via awk
  if awk "BEGIN {exit !($jac >= $THRESHOLD)}"; then
    uf_union "$i" "$j"
  fi
done <<<"$PAIRS"

# Group docs by root
declare -A groups
for ((i=0; i<N; i++)); do
  r=$(uf_find "$i")
  if [[ -z "${groups[$r]+x}" ]]; then
    groups[$r]="$i"
  else
    groups[$r]="${groups[$r]} $i"
  fi
done

# Sort roots numerically so cluster_ids are stable across runs on the same input
ROOTS=$(for k in "${!groups[@]}"; do echo "$k"; done | sort -n)

CID=0
while IFS= read -r root; do
  [[ -z "$root" ]] && continue
  read -ra MEMBERS <<<"${groups[$root]}"
  COUNT=${#MEMBERS[@]}

  # Drop clusters smaller than 3
  if [[ "$COUNT" -lt 3 ]]; then
    continue
  fi

  # Cap at MAX_SIZE — keep first N by input order (deterministic).
  if [[ "$COUNT" -gt "$MAX_SIZE" ]]; then
    MEMBERS=("${MEMBERS[@]:0:$MAX_SIZE}")
  fi

  CID=$((CID + 1))

  # Build a JSON array of the member indices
  IDX_JSON=$(printf '%s\n' "${MEMBERS[@]}" \
    | jq -R -s 'split("\n") | map(select(length > 0) | tonumber)')

  # Cluster topic = top-3 most common tags joined with "+"; fallback "cluster-c<N>"
  TOPIC=$(jq -r --argjson idx "$IDX_JSON" '
    [.[$idx[]].tags // [] | .[]]
    | map(ascii_downcase)
    | group_by(.)
    | map({tag: .[0], n: length})
    | sort_by(-.n, .tag)
    | .[0:3] | map(.tag) | join("+")
  ' <<<"$DECORATED")

  if [[ -z "$TOPIC" ]]; then
    TOPIC="cluster-c${CID}"
  fi

  # Emit one cluster JSON per line — strip `tokens` (internal-only).
  jq -nc --arg cid "c${CID}" --arg topic "$TOPIC" --argjson idx "$IDX_JSON" --argjson all "$DECORATED" '
    {cluster_id: $cid, topic: $topic,
     docs: [$all[$idx[]] | {filename, topic, tags, path}]}
  '
done <<<"$ROOTS"
