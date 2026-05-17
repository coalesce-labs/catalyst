#!/usr/bin/env bash
# Usage: inventory.sh <dir>
#
# Walks <dir> for *.md (excluding INDEX.md, CONTRADICTIONS.md, dotfiles) and
# emits one JSON object per line on stdout with these fields:
#   filename, path, date, topic, tags, word_count, file_line_refs
#
# Frontmatter is parsed by simple line-based YAML (no yq dep). Supports:
#   date: YYYY-MM-DD[T...]
#   topic: "..." (or unquoted)
#   tags: [a, b, c]
# If frontmatter `date` is missing, falls back to YYYY-MM-DD prefix of filename.
#
# file_line_refs are extracted using a tightened regex that requires a known
# file extension (so timestamps and URLs are excluded). Each ref is a string
# like "src/server.ts:42" — line numbers are kept for human navigation but
# only the path is validated by score.sh.

set -uo pipefail

DIR="${1:-}"
if [[ -z "$DIR" || ! -d "$DIR" ]]; then
  echo "inventory.sh: missing or invalid directory: '$DIR'" >&2
  exit 2
fi

# Extensions we recognize as code/doc files for file:line ref purposes.
REF_REGEX='[a-zA-Z0-9_./-]+\.(sh|ts|tsx|js|mjs|cjs|jsx|py|md|yaml|yml|json|go|rs|toml|html|css|mts|cts):[0-9]+'

# Parse frontmatter from a single .md file. Echoes three lines on stdout:
#   <date>
#   <topic>
#   <tags-comma-separated>
# Empty values are emitted as empty lines so the caller can read with mapfile.
parse_frontmatter() {
  local file="$1"
  local in_fm=0 first_line=1 line key val
  local date="" topic="" tags=""

  while IFS= read -r line; do
    if (( first_line )); then
      first_line=0
      if [[ "$line" == "---" ]]; then
        in_fm=1
        continue
      else
        break
      fi
    fi
    if (( in_fm )); then
      if [[ "$line" == "---" ]]; then
        break
      fi
      # Match `key: value` (optional whitespace around colon)
      if [[ "$line" =~ ^([a-zA-Z_][a-zA-Z0-9_]*):[[:space:]]*(.*)$ ]]; then
        key="${BASH_REMATCH[1]}"
        val="${BASH_REMATCH[2]}"
        # Strip outer quotes
        val="${val#\"}"; val="${val%\"}"
        val="${val#\'}"; val="${val%\'}"
        case "$key" in
          date)
            # Keep only YYYY-MM-DD prefix
            if [[ "$val" =~ ^([0-9]{4}-[0-9]{2}-[0-9]{2}) ]]; then
              date="${BASH_REMATCH[1]}"
            fi
            ;;
          topic|title)
            # title is a fallback alias for topic when topic is absent
            if [[ -z "$topic" ]]; then
              topic="$val"
            fi
            ;;
          tags)
            # Match `[a, b, c]` or `[a]`
            if [[ "$val" =~ ^\[(.*)\]$ ]]; then
              local raw="${BASH_REMATCH[1]}"
              # Strip whitespace and quotes around each comma-separated item
              tags=$(echo "$raw" | tr ',' '\n' \
                | sed -E "s/^[[:space:]]*[\"']?//; s/[\"']?[[:space:]]*$//" \
                | grep -v '^$' \
                | paste -sd',' -)
            fi
            ;;
        esac
      fi
    fi
  done < "$file"

  printf '%s\n%s\n%s\n' "$date" "$topic" "$tags"
}

# Extract date from filename: YYYY-MM-DD-*.md
filename_date() {
  local base
  base=$(basename "$1")
  if [[ "$base" =~ ^([0-9]{4}-[0-9]{2}-[0-9]{2}) ]]; then
    echo "${BASH_REMATCH[1]}"
  else
    echo ""
  fi
}

# Extract file:line refs from a markdown file.
# Emits a JSON array on stdout.
extract_refs() {
  local file="$1"
  # Use grep -oE with the tightened regex; dedupe in case the same ref appears
  # multiple times in the doc.
  local refs
  refs=$(grep -oE "$REF_REGEX" "$file" 2>/dev/null | sort -u)
  if [[ -z "$refs" ]]; then
    echo '[]'
    return
  fi
  # Build a JSON array via jq
  echo "$refs" | jq -R -s 'split("\n") | map(select(length > 0))'
}

shopt -s nullglob
for f in "$DIR"/*.md; do
  base=$(basename "$f")
  case "$base" in
    INDEX.md|CONTRADICTIONS.md|.*) continue ;;
  esac

  mapfile -t fm < <(parse_frontmatter "$f")
  date="${fm[0]:-}"
  topic="${fm[1]:-}"
  tags_csv="${fm[2]:-}"

  if [[ -z "$date" ]]; then
    date=$(filename_date "$f")
  fi

  # Word count
  wc_words=$(wc -w < "$f" | tr -d ' ')

  # Tags array
  if [[ -n "$tags_csv" ]]; then
    tags_json=$(echo "$tags_csv" | tr ',' '\n' | jq -R -s 'split("\n") | map(select(length > 0))')
  else
    tags_json='[]'
  fi

  refs_json=$(extract_refs "$f")

  # If topic is empty, derive from first H1
  if [[ -z "$topic" ]]; then
    topic=$(grep -m1 -E '^#[[:space:]]+' "$f" | sed -E 's/^#[[:space:]]+//; s/^[A-Z]+-[0-9]+:?[[:space:]]*//')
  fi

  jq -nc \
    --arg filename "$base" \
    --arg path "$f" \
    --arg date "$date" \
    --arg topic "$topic" \
    --argjson tags "$tags_json" \
    --argjson word_count "$wc_words" \
    --argjson file_line_refs "$refs_json" \
    '{filename: $filename, path: $path, date: $date, topic: $topic,
      tags: $tags, word_count: $word_count, file_line_refs: $file_line_refs}'
done
