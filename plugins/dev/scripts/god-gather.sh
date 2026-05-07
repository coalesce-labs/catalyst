#!/usr/bin/env bash
# god-gather.sh — collect cross-project Catalyst state and emit JSON
#
# Reads: ~/catalyst/state.json, ~/catalyst/runs/*/state.json,
#        ~/catalyst/runs/*/workers/*.json, ~/catalyst/wt/, ~/.claude/projects/,
#        ~/catalyst/catalyst.db (via catalyst-session.sh), ~/catalyst/events/YYYY-MM.jsonl
#
# Outputs a single JSON object:
#   ts           — ISO timestamp of this snapshot
#   global       — aggregate orchestrator counts
#   orchestrators — map from global state.json
#   projects     — array of {name, path, worktrees[]}
#   workers      — array of worker signal file contents
#   runs         — array of per-run state.json summaries
#   sessions     — active Claude sessions (from catalyst-session.sh)
#   recentEvents — events from last 30 min

set -uo pipefail

CATALYST_DIR="${CATALYST_DIR:-$HOME/catalyst}"
CLAUDE_PROJECTS_DIR="${HOME}/.claude/projects"
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EPOCH_NOW=$(date +%s)

# ── helpers ──────────────────────────────────────────────────────────────────

# macOS-safe "N minutes ago" ISO timestamp
minutes_ago_iso() {
  local n="$1"
  date -u -v"-${n}M" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
    date -u --date="${n} minutes ago" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
    echo ""
}

# mtime of a path in seconds since epoch (macOS + Linux)
path_mtime() {
  stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0
}

# Elapsed seconds → human string
elapsed_human() {
  local secs="$1"
  if [ "$secs" -lt 60 ]; then
    echo "${secs}s ago"
  elif [ "$secs" -lt 3600 ]; then
    echo "$((secs / 60)) min ago"
  else
    local h=$((secs / 3600)) m=$(( (secs % 3600) / 60 ))
    echo "${h}h ${m}min ago"
  fi
}

# Classify a worktree directory name into: orchestrator, worker, pm, oneshot, other
classify_worktree() {
  local name="$1"
  case "$name" in
    orch-*)
      # worker: ends with TICKET-NUM (uppercase letters dash digits)
      if echo "$name" | grep -qE '[A-Z][A-Z0-9]+-[0-9]+$'; then
        echo "worker"
      else
        echo "orchestrator"
      fi
      ;;
    PM|pm|Pm)
      echo "pm"
      ;;
    *)
      # standalone oneshot: TICKET-NUM pattern
      if echo "$name" | grep -qE '^[A-Z][A-Z0-9]+-[0-9]+$'; then
        echo "oneshot"
      else
        echo "other"
      fi
      ;;
  esac
}

# ── 1. Global state.json ─────────────────────────────────────────────────────

GLOBAL_STATE_FILE="${CATALYST_DIR}/state.json"
GLOBAL_STATE='{"orchestrators":{},"lastUpdated":null}'
if [ -f "$GLOBAL_STATE_FILE" ]; then
  GLOBAL_STATE=$(jq -c '{orchestrators: (.orchestrators // {}), lastUpdated: .lastUpdated}' \
    "$GLOBAL_STATE_FILE" 2>/dev/null) || GLOBAL_STATE='{"orchestrators":{},"lastUpdated":null}'
fi

GLOBAL_COUNTS=$(echo "$GLOBAL_STATE" | jq -c '
  .orchestrators as $o |
  {
    totalOrchestrators: ($o | length),
    activeOrchestrators: ($o | to_entries | map(select(.value.status == "active")) | length),
    completedOrchestrators: ($o | to_entries | map(select(.value.status == "completed")) | length)
  }' 2>/dev/null) || GLOBAL_COUNTS='{"totalOrchestrators":0,"activeOrchestrators":0,"completedOrchestrators":0}'

# ── 2. Per-run states ────────────────────────────────────────────────────────

RUNS_DIR="${CATALYST_DIR}/runs"
RUNS_JSON="[]"
if [ -d "$RUNS_DIR" ]; then
  RUNS_JSON=$(
    find "$RUNS_DIR" -maxdepth 2 -name "state.json" 2>/dev/null | sort | \
    while IFS= read -r sf; do
      jq -c --arg dir "$(dirname "$sf")" '{
        orchestrator: (.orchestrator // ""),
        dir: $dir,
        startedAt: .startedAt,
        currentWave: (.currentWave // 0),
        totalWaves: (.totalWaves // 0),
        waves: [(.waves // [])[] | {wave: .wave, status: .status, tickets: (.tickets // [])}],
        attention: (.attention // [])
      }' "$sf" 2>/dev/null
    done | jq -cs '.'
  ) || RUNS_JSON="[]"
fi

# ── 3. Worker signal files ────────────────────────────────────────────────────

WORKERS_JSON="[]"
if [ -d "$RUNS_DIR" ]; then
  WORKERS_JSON=$(
    find "$RUNS_DIR" -maxdepth 3 -path "*/workers/*.json" 2>/dev/null | \
    grep -v -- '-rollup' | sort | \
    while IFS= read -r wf; do
      jq -c '{
        ticket: (.ticket // .workerName // "unknown"),
        orchestrator: (.orchestrator // null),
        wave: (.wave // null),
        label: (.label // null),
        status: (.status // "unknown"),
        phase: (.phase // 0),
        pr: (.pr // null),
        needsAttention: (.needsAttention // false),
        attentionReason: (.attentionReason // null),
        lastHeartbeat: (.lastHeartbeat // null),
        pid: (.pid // null),
        worktreePath: (.worktreePath // null),
        startedAt: (.startedAt // null),
        updatedAt: (.updatedAt // null)
      }' "$wf" 2>/dev/null
    done | jq -cs '.'
  ) || WORKERS_JSON="[]"
fi

# ── 4. Worktree inventory ────────────────────────────────────────────────────

WT_BASE="${CATALYST_DIR}/wt"
PROJECTS_JSON="[]"

if [ -d "$WT_BASE" ]; then
  PROJECTS_JSON=$(
    for project in $(ls -1 "$WT_BASE" 2>/dev/null); do
      PROJECT_DIR="${WT_BASE}/${project}"
      [ -d "$PROJECT_DIR" ] || continue
      WORKTREES_JSON="[]"
      for wt in $(ls -1 "$PROJECT_DIR" 2>/dev/null); do
        WT_PATH="${PROJECT_DIR}/${wt}"
        [ -d "$WT_PATH" ] || continue
        TYPE=$(classify_worktree "$wt")

        # Find corresponding Claude session dir
        SESSION_DIR="${CLAUDE_PROJECTS_DIR}/-Users-ryan-catalyst-wt-${project}-${wt}"
        SESSION_MTIME=0
        ELAPSED_STR="unknown"
        if [ -d "$SESSION_DIR" ]; then
          SESSION_MTIME=$(path_mtime "$SESSION_DIR")
          if [ "$SESSION_MTIME" -gt 0 ]; then
            ELAPSED=$(( EPOCH_NOW - SESSION_MTIME ))
            ELAPSED_STR=$(elapsed_human "$ELAPSED")
          fi
        fi

        WORKTREES_JSON=$(echo "$WORKTREES_JSON" | jq -c \
          --arg name "$wt" --arg type "$TYPE" --arg path "$WT_PATH" \
          --argjson mtime "$SESSION_MTIME" --arg elapsed "$ELAPSED_STR" \
          '. + [{name: $name, type: $type, path: $path, sessionMtime: $mtime, lastActive: $elapsed}]')
      done
      echo "{\"name\": $(echo "$project" | jq -R .), \"path\": $(echo "$PROJECT_DIR" | jq -R .), \"worktrees\": $WORKTREES_JSON}"
    done | jq -cs '.'
  ) || PROJECTS_JSON="[]"
fi

# ── 5. Active sessions ────────────────────────────────────────────────────────

SESSIONS_JSON="[]"
SESS_SCRIPT=$(ls ~/.claude/plugins/cache/catalyst/catalyst-dev/*/scripts/catalyst-session.sh 2>/dev/null | head -1 || true)
if [ -n "$SESS_SCRIPT" ] && [ -x "$SESS_SCRIPT" ]; then
  SESSIONS_JSON=$("$SESS_SCRIPT" list --active --json 2>/dev/null | jq -c '.' 2>/dev/null) || SESSIONS_JSON="[]"
fi

# ── 6. Recent events (last 30 min) ───────────────────────────────────────────

EVENTS_JSON="[]"
EVENTS_FILE="${CATALYST_DIR}/events/$(date +%Y-%m).jsonl"
CUTOFF=$(minutes_ago_iso 30)

if [ -f "$EVENTS_FILE" ] && [ -n "$CUTOFF" ]; then
  TOTAL=$(wc -l < "$EVENTS_FILE" | tr -d ' ')
  SINCE=$(( TOTAL > 3000 ? TOTAL - 3000 : 0 ))
  EVENTS_JSON=$(
    tail -n +"$((SINCE + 1))" "$EVENTS_FILE" 2>/dev/null | \
    jq -c --arg cutoff "$CUTOFF" '
      select(.ts >= $cutoff) | select(
        (.event | startswith("worker-")) or
        (.event | startswith("filter.wake")) or
        .event == "github.pr.merged" or
        .event == "github.check_suite.completed" or
        .event == "github.workflow_run.completed" or
        .event == "attention-raised" or
        .event == "attention-resolved" or
        .event == "linear.issue.state_changed" or
        (.event == "comms.message.posted" and ((.detail.type // "") == "attention"))
      ) | {ts, event, orchestrator, worker,
           scope: (.scope // null),
           detail: (.detail // null)}
    ' 2>/dev/null | jq -cs '.'
  ) || EVENTS_JSON="[]"
fi

# ── 7. Emit ───────────────────────────────────────────────────────────────────

jq -cn \
  --arg ts "$NOW" \
  --argjson global "$GLOBAL_COUNTS" \
  --argjson orchestrators "$(echo "$GLOBAL_STATE" | jq '.orchestrators')" \
  --argjson projects "$PROJECTS_JSON" \
  --argjson workers "$WORKERS_JSON" \
  --argjson runs "$RUNS_JSON" \
  --argjson sessions "$SESSIONS_JSON" \
  --argjson recentEvents "$EVENTS_JSON" \
  '{ts: $ts, global: $global, orchestrators: $orchestrators, projects: $projects,
    workers: $workers, runs: $runs, sessions: $sessions, recentEvents: $recentEvents}'
