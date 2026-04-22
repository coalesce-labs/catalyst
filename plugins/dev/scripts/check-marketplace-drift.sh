#!/usr/bin/env bash
# Catalyst dev-marketplace drift check (CTL-121).
#
# Reads ~/.claude/plugins/known_marketplaces.json for entries that register a local
# directory as a Catalyst marketplace, then warns when:
#   * the registered path has drifted >= DRIFT_COMMIT_THRESHOLD commits behind origin/main
#   * the oldest unmerged origin/main commit is older than DRIFT_AGE_HOURS
#   * the registered path is a linked git worktree rather than the main checkout
#
# Exit codes: 0 clean, 1 any warning, 2 setup error (missing jq, malformed JSON).

set -uo pipefail

KNOWN_MARKETPLACES_FILE="${KNOWN_MARKETPLACES_FILE:-$HOME/.claude/plugins/known_marketplaces.json}"
DRIFT_COMMIT_THRESHOLD="${DRIFT_COMMIT_THRESHOLD:-5}"
DRIFT_AGE_HOURS="${DRIFT_AGE_HOURS:-24}"

QUIET=0
for arg in "$@"; do
  case "$arg" in
    --quiet|-q) QUIET=1 ;;
    --help|-h)
      sed -n '2,12p' "$0"
      exit 0
      ;;
  esac
done

ok()   { [ "$QUIET" = 1 ] || printf '✅ %s\n' "$1"; }
warn() { printf '⚠️ %s\n' "$1"; WARN_COUNT=$((WARN_COUNT + 1)); }
err()  { printf '❌ %s\n' "$1" >&2; }
note() { [ "$QUIET" = 1 ] || printf 'ℹ %s\n' "$1"; }

WARN_COUNT=0

if ! command -v jq >/dev/null 2>&1; then
  err "jq not found on PATH — cannot parse known_marketplaces.json"
  exit 2
fi

if [ ! -f "$KNOWN_MARKETPLACES_FILE" ]; then
  # No registry at all — nothing to check. Silent success.
  exit 0
fi

# Extract directory-source entries as "path" lines. Capture stderr separately so a
# malformed registry surfaces the real jq diagnostic, not a blank "failed to parse".
JQ_ERR_FILE=$(mktemp)
trap 'rm -f "$JQ_ERR_FILE"' EXIT
DIR_ENTRIES=$(jq -r '
  to_entries
  | map(select(.value.source.source == "directory"))
  | .[]
  | .value.source.path // empty
' "$KNOWN_MARKETPLACES_FILE" 2>"$JQ_ERR_FILE") || {
  err "failed to parse $KNOWN_MARKETPLACES_FILE: $(cat "$JQ_ERR_FILE")"
  exit 2
}

if [ -z "$DIR_ENTRIES" ]; then
  exit 0
fi

now_ts=$(date +%s)

check_one() {
  local path="$1"

  if [ ! -d "$path" ]; then
    note "skipping $path — directory does not exist"
    return
  fi

  if [ ! -f "$path/.claude-plugin/marketplace.json" ]; then
    # Not a Catalyst checkout; silently ignore (some other local plugin source).
    return
  fi

  if [ ! -e "$path/.git" ]; then
    warn "$path is registered as a Catalyst marketplace but is not a git checkout"
    return
  fi

  # Linked-worktree check. In a linked worktree, git-common-dir points elsewhere
  # than <path>/.git. Resolve both to absolute paths and compare.
  local git_dir common_dir
  git_dir=$(git -C "$path" rev-parse --git-dir 2>/dev/null || echo "")
  common_dir=$(git -C "$path" rev-parse --git-common-dir 2>/dev/null || echo "")
  if [ -n "$git_dir" ] && [ -n "$common_dir" ]; then
    # --git-dir / --git-common-dir can be returned as relative paths. Normalize.
    local abs_git abs_common
    abs_git=$(cd "$path" && cd "$git_dir" 2>/dev/null && pwd || echo "$git_dir")
    abs_common=$(cd "$path" && cd "$common_dir" 2>/dev/null && pwd || echo "$common_dir")
    if [ "$abs_git" != "$abs_common" ]; then
      warn "$path is a linked git worktree — registration should point at the main checkout"
      # Continue with drift math so the user sees both signals if both apply.
    fi
  fi

  # Determine the tracked branch / remote.
  if ! git -C "$path" remote get-url origin >/dev/null 2>&1; then
    warn "$path has no 'origin' remote — cannot determine drift"
    return
  fi

  # A drift detector that can't reach origin is an unknown, not a green — warn so the
  # user knows they're flying blind, rather than silently trusting a possibly-stale mirror.
  if ! git -C "$path" fetch --quiet origin main 2>/dev/null; then
    warn "$path: fetch origin/main failed — drift state unknown (offline or auth issue?)"
    return
  fi

  if ! git -C "$path" rev-parse --verify origin/main >/dev/null 2>&1; then
    warn "$path: no origin/main ref after fetch — drift state unknown"
    return
  fi

  local behind
  if ! behind=$(git -C "$path" rev-list --count HEAD..origin/main 2>/dev/null); then
    warn "$path: rev-list HEAD..origin/main failed — repo may be corrupt"
    return
  fi

  if [ "$behind" -eq 0 ]; then
    ok "$path is up-to-date with origin/main"
    return
  fi

  # Age of the oldest unmerged commit on origin/main. If we know we're behind but can't
  # read the log, surface that as an anomaly — don't silently drop the age check.
  local oldest_ts age_seconds age_hours log_out
  if ! log_out=$(git -C "$path" log HEAD..origin/main --format=%ct 2>/dev/null); then
    warn "$path: git log HEAD..origin/main failed — age-based drift check skipped"
    log_out=""
  fi
  oldest_ts=$(echo "$log_out" | tail -n1)
  if [ -n "$oldest_ts" ]; then
    age_seconds=$((now_ts - oldest_ts))
    age_hours=$((age_seconds / 3600))
  else
    age_hours=0
  fi

  local triggered=0
  local msg="$path is $behind commit(s) behind origin/main"
  if [ "$behind" -ge "$DRIFT_COMMIT_THRESHOLD" ]; then
    triggered=1
  fi
  if [ "$age_hours" -ge "$DRIFT_AGE_HOURS" ]; then
    triggered=1
    msg="$msg — stale for ${age_hours} hours"
  fi

  if [ "$triggered" = 1 ]; then
    warn "$msg — run 'git -C $path pull --ff-only' and restart Claude Code"
  else
    ok "$path is $behind commit(s) behind origin/main (below threshold)"
  fi
}

while IFS= read -r path; do
  [ -z "$path" ] && continue
  check_one "$path"
done <<< "$DIR_ENTRIES"

if [ "$WARN_COUNT" -gt 0 ]; then
  exit 1
fi
exit 0
