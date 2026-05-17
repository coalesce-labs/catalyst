#!/usr/bin/env bash
# Usage: score.sh [--reference-date YYYY-MM-DD] [--git-dir DIR]
#
# Reads inventory JSONL on stdin. For each doc, augments the entry with:
#   age_days           — days between reference date (today by default) and doc date
#   broken_refs        — count of file_line_refs whose path doesn't resolve at HEAD
#   topic_activity_30d — count of git log hits in last 30d for the doc's top tags
#   status             — one of "current" | "needs-review" | "likely-stale"
#
# Classification:
#   age_days >= 180 AND topic_activity_30d == 0  → likely-stale
#   age_days >= 90  OR  broken_refs > 0          → needs-review
#   otherwise                                    → current
#
# --reference-date is for deterministic tests (pins "today"). --git-dir lets
# tests point at a fixture repo instead of the working dir.

set -uo pipefail

REFERENCE_DATE=$(date -u +%Y-%m-%d)
GIT_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --reference-date)
      REFERENCE_DATE="$2"
      shift 2
      ;;
    --git-dir)
      GIT_DIR="$2"
      shift 2
      ;;
    *)
      echo "score.sh: unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

# Convert YYYY-MM-DD → days since epoch (portable across macOS & Linux).
date_to_epoch_days() {
  local d="$1"
  if [[ -z "$d" ]]; then
    echo 0
    return
  fi
  # GNU date first, then BSD/macOS date
  local sec
  sec=$(date -d "$d" +%s 2>/dev/null) \
    || sec=$(date -j -f "%Y-%m-%d" "$d" +%s 2>/dev/null) \
    || sec=0
  echo $(( sec / 86400 ))
}

REF_EPOCH=$(date_to_epoch_days "$REFERENCE_DATE")

# Run git with optional --git-dir / -C override. The --git-dir flag from CLI
# is treated as the working tree root for tests.
git_at() {
  if [[ -n "$GIT_DIR" ]]; then
    git -C "$GIT_DIR" "$@"
  else
    git "$@"
  fi
}

# Validate a single ref path against HEAD. Echoes "valid" or "invalid".
ref_path_valid() {
  local ref="$1"
  local path="${ref%%:*}"
  if git_at cat-file -e "HEAD:${path}" 2>/dev/null; then
    echo "valid"
  else
    echo "invalid"
  fi
}

# Count git log commits in last 30d whose message contains $1 (case-insensitive).
git_topic_hits() {
  local tag="$1"
  git_at log --since='30 days ago' --grep="$tag" -i --pretty=oneline 2>/dev/null | wc -l | tr -d ' '
}

# Process JSONL line by line.
while IFS= read -r entry; do
  [[ -z "$entry" ]] && continue

  date_val=$(jq -r '.date // ""' <<<"$entry")
  if [[ -n "$date_val" ]]; then
    doc_epoch=$(date_to_epoch_days "$date_val")
    age_days=$(( REF_EPOCH - doc_epoch ))
  else
    age_days=99999  # treat undated as ancient
  fi

  # broken_refs — count refs whose path doesn't resolve at HEAD
  broken=0
  refs_json=$(jq -c '.file_line_refs' <<<"$entry")
  if [[ "$refs_json" != "[]" && "$refs_json" != "null" ]]; then
    while IFS= read -r r; do
      [[ -z "$r" ]] && continue
      if [[ "$(ref_path_valid "$r")" == "invalid" ]]; then
        broken=$(( broken + 1 ))
      fi
    done < <(jq -r '.file_line_refs[]' <<<"$entry")
  fi

  # topic_activity_30d — sum hits for up to top-3 tags
  activity=0
  while IFS= read -r tag; do
    [[ -z "$tag" ]] && continue
    hits=$(git_topic_hits "$tag")
    activity=$(( activity + hits ))
  done < <(jq -r '.tags[0:3][]?' <<<"$entry")

  # Classify
  if (( age_days >= 180 )) && (( activity == 0 )); then
    status="likely-stale"
  elif (( age_days >= 90 )) || (( broken > 0 )); then
    status="needs-review"
  else
    status="current"
  fi

  jq -nc \
    --argjson entry "$entry" \
    --argjson age_days "$age_days" \
    --argjson broken_refs "$broken" \
    --argjson activity "$activity" \
    --arg status "$status" \
    '$entry + {age_days: $age_days, broken_refs: $broken_refs,
               topic_activity_30d: $activity, status: $status}'
done
