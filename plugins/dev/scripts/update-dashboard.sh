#!/usr/bin/env bash
# update-dashboard.sh — Render ${ORCH_DIR}/DASHBOARD.md from orchestrator state.
#
# Reads ${ORCH_DIR}/state.json + ${ORCH_DIR}/workers/*.json signal files +
# ${CATALYST_DIR}/events/*.jsonl, writes ${ORCH_DIR}/DASHBOARD.md atomically.
# Idempotent: rerunning with no state change produces a byte-identical file.
#
# Usage:
#   update-dashboard.sh --orch <id> [--orch-dir <dir>] [--stdout]
#
# No-op (exits 0) when:
#   - state.json missing
#
# Exits non-zero on:
#   - missing required args

set -euo pipefail

# Resolve symlinks for SCRIPT_DIR (CTL-239 pattern).
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"

CATALYST_DIR="${CATALYST_DIR:-$HOME/catalyst}"
GLOBAL_STATE="${CATALYST_STATE_FILE:-$CATALYST_DIR/state.json}"
EVENTS_DIR="${CATALYST_DIR}/events"

usage() {
  cat >&2 <<'EOF'
usage: update-dashboard.sh --orch <id> [--orch-dir <dir>] [--stdout]

required:
  --orch <id>         orchestrator id

optional:
  --orch-dir <dir>    override default ~/catalyst/runs/<orch>/
  --stdout            write to stdout instead of DASHBOARD.md
EOF
  exit 2
}

ORCH_ID="" ORCH_DIR="" STDOUT_MODE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --orch)     ORCH_ID="${2:-}"; shift 2 ;;
    --orch-dir) ORCH_DIR="${2:-}"; shift 2 ;;
    --stdout)   STDOUT_MODE=1; shift ;;
    -h|--help)  usage ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done

[ -n "$ORCH_ID" ] || usage
[ -n "$ORCH_DIR" ] || ORCH_DIR="${CATALYST_DIR}/runs/${ORCH_ID}"

STATE_FILE="${ORCH_DIR}/state.json"
WORKERS_DIR="${ORCH_DIR}/workers"
DASHBOARD_FILE="${ORCH_DIR}/DASHBOARD.md"

# No-op when state.json absent — orchestrator hasn't initialised yet.
if [ ! -f "$STATE_FILE" ]; then
  echo "warn: state.json not found at $STATE_FILE" >&2
  exit 0
fi

# ─── Helpers ──────────────────────────────────────────────────────────────────

dod_count_cell() {
  # Args: signal_file key
  local signal="$1" key="$2"
  local exists count
  exists=$(jq -r ".definitionOfDone.${key}.exists // false" "$signal")
  count=$(jq -r ".definitionOfDone.${key}.count // 0" "$signal")
  if [ "$exists" = "true" ]; then
    printf '✓ %s' "$count"
  else
    printf '—'
  fi
}

dod_passed_cell() {
  # Args: signal_file key
  # Don't use jq's `//` here — it treats both null and false as nullish, so an
  # explicit `passed: false` would collapse to the default branch. Read the raw
  # value (jq -r prints "true"/"false"/"null") and match on the string.
  local signal="$1" key="$2"
  local passed
  passed=$(jq -r ".definitionOfDone.${key}.passed" "$signal")
  case "$passed" in
    true)  printf '✓' ;;
    false) printf '✗' ;;
    *)     printf '—' ;;
  esac
}

pr_link_cell() {
  # Args: signal_file
  local signal="$1" num url
  num=$(jq -r '.pr.number // empty' "$signal")
  url=$(jq -r '.pr.url // empty' "$signal")
  if [ -n "$num" ] && [ -n "$url" ]; then
    printf '[#%s](%s)' "$num" "$url"
  fi
}

pr_field() {
  # Args: signal_file field
  jq -r --arg f "$2" '.pr[$f] // ""' "$1"
}

worker_row() {
  # Args: signal_file
  local sig="$1" ticket title status pr_link pr_opened auto_armed merged
  ticket=$(jq -r '.ticket' "$sig")
  title=$(jq -r '.label // .ticket' "$sig")
  status=$(jq -r '.status' "$sig")
  pr_link=$(pr_link_cell "$sig")
  pr_opened=$(pr_field "$sig" prOpenedAt)
  auto_armed=$(pr_field "$sig" autoMergeArmedAt)
  merged=$(pr_field "$sig" mergedAt)
  local unit api func sec review verified fixup followup
  unit=$(dod_count_cell "$sig" unitTests)
  api=$(dod_count_cell "$sig" apiTests)
  func=$(dod_count_cell "$sig" functionalTests)
  sec=$(dod_passed_cell "$sig" securityReview)
  review=$(dod_passed_cell "$sig" codeReview)
  verified=$(dod_passed_cell "$sig" rewardHackingScan)
  fixup=$(jq -r '.fixupCommit // ""' "$sig")
  followup=$(jq -r '.followUpTo // ""' "$sig")
  printf '| %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |\n' \
    "$ticket" "$title" "$status" "$pr_link" \
    "$pr_opened" "$auto_armed" "$merged" \
    "$unit" "$api" "$func" "$sec" "$review" "$verified" \
    "$fixup" "$followup"
}

# Read orch-level metadata
ORCH_NAME=$(jq -r '.orchestrator // ""' "$STATE_FILE")
STARTED_AT=$(jq -r '.startedAt // ""' "$STATE_FILE")
BASE_BRANCH=$(jq -r '.baseBranch // ""' "$STATE_FILE")
TOTAL_TICKETS=$(jq -r '.totalTickets // 0' "$STATE_FILE")
TOTAL_WAVES=$(jq -r '.totalWaves // 0' "$STATE_FILE")
CURRENT_WAVE=$(jq -r '.currentWave // 1' "$STATE_FILE")
MAX_PARALLEL=$(jq -r '.maxParallel // 0' "$STATE_FILE")

# projectKey lives in the global state; falls back to "unknown" if absent.
PROJECT_NAME="unknown"
if [ -f "$GLOBAL_STATE" ]; then
  PROJECT_NAME=$(jq -r --arg id "$ORCH_NAME" '.orchestrators[$id].projectKey // "unknown"' "$GLOBAL_STATE" 2>/dev/null || echo "unknown")
fi

shopt -s nullglob

# Render to a string so we can write atomically.
render() {
  cat <<EOF
# Orchestration Dashboard

**Orchestrator:** ${ORCH_NAME}
**Started:** ${STARTED_AT}
**Project:** ${PROJECT_NAME}
**Base branch:** ${BASE_BRANCH}
**Total:** ${TOTAL_TICKETS} tickets | ${TOTAL_WAVES} waves | Max parallel: ${MAX_PARALLEL}

## Current Wave: ${CURRENT_WAVE} of ${TOTAL_WAVES}

| Ticket | Title | Status | PR | PR Opened | Auto-Merge Armed | Merged | Unit Tests | API Tests | Functional | Security | Code Review | Verified | Fix-up Commit | Follow-up To |
|--------|-------|--------|-----|-----------|------------------|--------|-----------|-----------|------------|----------|-------------|----------|---------------|--------------|
EOF

  if [ -d "$WORKERS_DIR" ]; then
    for sig in "$WORKERS_DIR"/*.json; do
      [ -f "$sig" ] || continue
      local sig_wave
      sig_wave=$(jq -r '.wave // 0' "$sig")
      [ "$sig_wave" = "$CURRENT_WAVE" ] || continue
      worker_row "$sig"
    done
  fi

  # ─── Upcoming Waves ─────────────────────────────────────────────────────────
  local upcoming_count
  upcoming_count=$(jq --arg cw "$CURRENT_WAVE" \
    '[.waves[]? | select(.wave > ($cw|tonumber))] | length' "$STATE_FILE")
  if [ "$upcoming_count" -gt 0 ]; then
    printf '\n## Upcoming Waves\n'
    # Iterate upcoming waves in ascending wave order.
    while IFS= read -r wave_json; do
      [ -z "$wave_json" ] && continue
      local w_num w_deps tickets_count
      w_num=$(jq -r '.wave' <<<"$wave_json")
      w_deps=$(jq -rc '.dependsOn // []' <<<"$wave_json")
      tickets_count=$(jq -r '(.tickets // []) | length' <<<"$wave_json")
      local depends_on_label="—"
      if [ "$(jq -r 'length' <<<"$w_deps")" -gt 0 ]; then
        # Print the highest dependency as "Wave N" so the heading reads cleanly.
        local dep_max
        dep_max=$(jq -r 'max' <<<"$w_deps")
        depends_on_label="Wave ${dep_max}"
      fi
      if [ "$depends_on_label" = "—" ]; then
        printf '\n### Wave %s\n' "$w_num"
      else
        printf '\n### Wave %s (blocked on %s)\n' "$w_num" "$depends_on_label"
      fi
      printf '\n| Ticket | Depends On |\n'
      printf '|--------|------------|\n'
      if [ "$tickets_count" -gt 0 ]; then
        # Stable: state.json wave-array order is the queue order.
        jq -r --arg dep "$depends_on_label" \
          '(.tickets // [])[] | "| \(.) | \($dep) |"' <<<"$wave_json"
      fi
    done < <(jq -c --arg cw "$CURRENT_WAVE" \
      '.waves[]? | select(.wave > ($cw|tonumber))' "$STATE_FILE" \
      | jq -sc 'sort_by(.wave) | .[]')
  fi

  # ─── Completed Waves ────────────────────────────────────────────────────────
  local completed_count
  completed_count=$(jq '[.waves[]? | select(.status == "completed")] | length' "$STATE_FILE")
  if [ "$completed_count" -gt 0 ]; then
    printf '\n## Completed Waves\n'
    while IFS= read -r wave_json; do
      [ -z "$wave_json" ] && continue
      local w_num
      w_num=$(jq -r '.wave' <<<"$wave_json")
      printf '\n### Wave %s\n' "$w_num"
      printf '\n| Ticket | PR | Merged |\n'
      printf '|--------|-----|--------|\n'
      # Iterate this wave's tickets in array order; pull each signal file
      # to render the PR link + merge timestamp.
      while IFS= read -r tkt; do
        [ -z "$tkt" ] && continue
        local sig="${WORKERS_DIR}/${tkt}.json"
        local pr_link="" merged=""
        if [ -f "$sig" ]; then
          pr_link=$(pr_link_cell "$sig")
          merged=$(pr_field "$sig" mergedAt)
        fi
        printf '| %s | %s | %s |\n' "$tkt" "$pr_link" "$merged"
      done < <(jq -r '(.tickets // [])[]' <<<"$wave_json")
    done < <(jq -c '.waves[]? | select(.status == "completed")' "$STATE_FILE" \
      | jq -sc 'sort_by(.wave) | .[]')
  fi

  # ─── Event Log ──────────────────────────────────────────────────────────────
  printf '\n## Event Log\n\n'
  if [ -d "$EVENTS_DIR" ]; then
    # Combine all monthly events files (sorted), filter to this orchestrator,
    # take last 30 by chronological order. Stable input → stable output.
    local events_glob=( "$EVENTS_DIR"/*.jsonl )
    if [ ${#events_glob[@]} -gt 0 ]; then
      # Read raw and use `fromjson?` so partial/concurrent-write lines in the
      # shared events log don't abort rendering for everyone.
      cat "${events_glob[@]}" 2>/dev/null \
        | jq -Rrc --arg orch "$ORCH_NAME" \
            'fromjson?
             | select(.orchestrator == $orch)
             | "- \(.ts) — \(.event)" + (if .worker then " (\(.worker))" else "" end)' \
        | tail -30
    fi
  fi
}

# Atomic write — render to a temp file in the same directory then mv.
if [ "$STDOUT_MODE" = "1" ]; then
  render
else
  mkdir -p "$ORCH_DIR"
  TMP=$(mktemp "${ORCH_DIR}/.DASHBOARD.md.XXXXXX")
  trap 'rm -f "$TMP"' EXIT
  render > "$TMP"
  mv "$TMP" "$DASHBOARD_FILE"
  trap - EXIT
fi
