#!/usr/bin/env bash
# catalyst-hud.sh — color-coded terminal HUD for the catalyst event stream.
#
# Usage: catalyst-hud [--repo PATTERN] [--since TIME] [--help]
#                     [--filter JQ] [--since-line N]
#
# --repo and --since are catalyst-hud extensions.
# --filter and --since-line pass through to catalyst-events tail.

set -uo pipefail

R=$'\033[0m'
BOLD=$'\033[1m'
DIM=$'\033[2m'
RED=$'\033[31m'
GRN=$'\033[32m'
YEL=$'\033[33m'
BLU=$'\033[34m'
MAG=$'\033[35m'
CYN=$'\033[36m'

CATALYST_DIR="${CATALYST_DIR:-$HOME/catalyst}"
EVENTS_DIR="${CATALYST_EVENTS_DIR:-$CATALYST_DIR/events}"

# Auto-detect local timezone from OS
detect_tz() {
  [[ -n "${TZ:-}" ]] && { printf '%s' "$TZ"; return; }
  if [[ -L /etc/localtime ]]; then
    local t
    t=$(readlink /etc/localtime 2>/dev/null || true)
    while [[ -L "$t" ]]; do t=$(readlink "$t" 2>/dev/null) || break; done
    local z="${t#*/zoneinfo/}"
    [[ "$z" != "$t" && -n "$z" ]] && { printf '%s' "$z"; return; }
  fi
  [[ -f /etc/timezone ]] && { tr -d '[:space:]' < /etc/timezone; return; }
  printf 'UTC'
}
TZ_DISPLAY=$(detect_tz)

fmt_time() {
  local raw="${1%%.*}"
  raw="${raw%Z}"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    TZ="$TZ_DISPLAY" date -j -f "%Y-%m-%dT%H:%M:%S" "$raw" "+%H:%M:%S" 2>/dev/null && return
  else
    TZ="$TZ_DISPLAY" date -d "${raw}Z" "+%H:%M:%S" 2>/dev/null && return
  fi
  printf '%s' "${1:11:8}"
}

# Parse a human time spec ("1 hour ago", ISO timestamp) → Unix epoch seconds.
parse_since_epoch() {
  local spec="$1"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    # ISO timestamp
    local clean="${spec%%.*}"; clean="${clean%Z}"
    TZ=UTC date -j -f "%Y-%m-%dT%H:%M:%S" "$clean" "+%s" 2>/dev/null && return
    TZ=UTC date -j -f "%Y-%m-%dT%H:%M" "$clean" "+%s" 2>/dev/null && return
    # Relative: "N unit[s] ago"
    if [[ "$spec" =~ ^([0-9]+)[[:space:]]+(second|minute|hour|day|week)s?[[:space:]]+ago$ ]]; then
      local n="${BASH_REMATCH[1]}" unit="${BASH_REMATCH[2]}"
      case "$unit" in
        second) date -v "-${n}S" "+%s" 2>/dev/null ;;
        minute) date -v "-${n}M" "+%s" 2>/dev/null ;;
        hour)   date -v "-${n}H" "+%s" 2>/dev/null ;;
        day)    date -v "-${n}d" "+%s" 2>/dev/null ;;
        week)   date -v "-${n}w" "+%s" 2>/dev/null ;;
      esac
      return
    fi
  else
    date -d "$spec" "+%s" 2>/dev/null && return
  fi
}

# Unix epoch → ISO-8601 UTC string for lexicographic comparison.
epoch_to_iso() {
  local epoch="$1"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    TZ=UTC date -r "$epoch" "+%Y-%m-%dT%H:%M:%S" 2>/dev/null
  else
    TZ=UTC date -d "@$epoch" "+%Y-%m-%dT%H:%M:%S" 2>/dev/null
  fi
}

# Extract the ts field from a single line of the events file.
_ts_at_line() {
  sed -n "${1}p" "$2" | awk '
    { if (match($0, /"ts":"[^"]*/)) {
        ts = substr($0, RSTART + 6, RLENGTH - 6)
        gsub(/\.[0-9]+$/, "", ts); gsub(/Z$/, "", ts)
        print ts
      }
    }'
}

# Binary search for the 0-indexed line number of the first event with ts >= cutoff.
# ISO-8601 timestamps are lexicographically ordered, so string comparison is valid.
# O(log N) line reads instead of a full scan.
find_since_line() {
  local file="$1" cutoff="$2"
  [[ ! -f "$file" ]] && echo "0" && return

  local total
  total=$(wc -l < "$file" | tr -d ' ')
  [[ "$total" -eq 0 ]] && echo "0" && return

  local lo=1 hi="$total" mid ts
  while [[ "$lo" -le "$hi" ]]; do
    mid=$(( (lo + hi) / 2 ))
    ts=$(_ts_at_line "$mid" "$file")
    if [[ -z "$ts" || "$ts" < "$cutoff" ]]; then
      lo=$((mid + 1))
    else
      hi=$((mid - 1))
    fi
  done

  # lo is the 1-indexed first line >= cutoff; return as 0-indexed for --since-line
  echo $((lo - 1))
}

usage() {
  cat <<'EOF'
Usage: catalyst-hud [--repo PATTERN] [--since TIME] [--help]
                    [--filter JQ] [--since-line N]

Color-coded terminal HUD for the catalyst event stream.
Times shown in local timezone (auto-detected from OS).

Options (catalyst-hud extensions):
  --repo PATTERN    Only show events whose repo field matches PATTERN (substring).
                    Non-repo events (worker, comms) always show through.
  --since TIME      Replay events since TIME, then follow live.
                    Accepts relative ("1 hour ago", "30 minutes ago") or
                    absolute ("2026-05-06T00:00:00Z") times.
  --help, -h        Show this help.

Pass-through options (forwarded to catalyst-events tail):
  --filter JQ       Filter events with a jq predicate expression.
  --since-line N    Start replay at line N of the events file.

Examples:
  catalyst-hud
  catalyst-hud --since "1 hour ago"
  catalyst-hud --since "30 minutes ago" --repo catalyst
  catalyst-hud --filter '.attributes."event.name" | startswith("github")'

Columns:
  TIME     Local time (HH:MM:SS)
  REPO     Short repo name (org prefix stripped)
  EVENT    Event label (merged, ci fail, comms, phase, …)
  SOURCE   github · linear · comms · orchestrator/worker name
  REF      PR number, ticket ID, or empty
  DETAILS  Human-readable summary

Note: --since only searches the current month's events file.
EOF
}

# --- Arg parsing -----------------------------------------------------------
REPO_FILTER=""
SINCE_SPEC=""
_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)   REPO_FILTER="${2:-}"; shift 2 ;;
    --since)  SINCE_SPEC="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) _ARGS+=("$1"); shift ;;
  esac
done
if [[ ${#_ARGS[@]} -gt 0 ]]; then set -- "${_ARGS[@]}"; else set --; fi

# Translate --since → --since-line before forwarding to catalyst-events tail
if [[ -n "$SINCE_SPEC" ]]; then
  since_epoch=$(parse_since_epoch "$SINCE_SPEC")
  if [[ -z "${since_epoch:-}" ]]; then
    printf 'error: cannot parse --since time: %s\n' "$SINCE_SPEC" >&2
    printf '  try: "1 hour ago"  "30 minutes ago"  "2026-05-06T00:00:00Z"\n' >&2
    exit 2
  fi
  since_iso=$(epoch_to_iso "$since_epoch")
  events_file="$EVENTS_DIR/$(date -u +%Y-%m).jsonl"
  since_line=$(find_since_line "$events_file" "$since_iso")
  set -- "--since-line" "$since_line" "$@"
fi

# --- Event rendering -------------------------------------------------------
render() {
  local line="$1"
  [[ -z "$line" ]] && return

  local f
  # Use SOH () as separator — unlike tab, it is NOT IFS whitespace so bash
  # read won't collapse consecutive empty fields (which shifts all subsequent vars).
  f=$(printf '%s' "$line" | jq -r '[
    (.ts // ""),
    (.attributes."event.name" // "unknown"),
    (.attributes."catalyst.orchestrator.id" // ""),
    (.attributes."catalyst.worker.ticket" // ""),
    (.attributes."vcs.repository.name" // ""),
    ((.attributes."vcs.pr.number" // 0) | tostring),
    (.attributes."linear.issue.identifier" // .attributes."catalyst.worker.ticket" // ""),
    (.attributes."cicd.pipeline.run.conclusion" // .body.payload.conclusion // ""),
    ((.body.payload.state // "") | ascii_downcase),
    (.body.payload.phase // ""),
    (.body.payload.workerStatus // .body.payload.status // ""),
    (.body.payload.channel // ""),
    ((.body.payload.prNumbers // []) | map(tostring) | join(",")),
    ((.body.payload.title // "") | gsub("[\n\t]"; " ")),
    ((.body.payload.message // .body.payload.text // "") | gsub("[\n\t]"; " ")),
    (.body.payload.ref // .attributes."vcs.ref.name" // ""),
    ((.body.payload.name // "") | gsub("[\n\t]"; " ")),
    (.body.payload.headBranch // ""),
    ((.body.payload.reason // "") | gsub("[\n\t]"; " ")),
    ((.body.payload.source_event_ids // []) | length | tostring)
  ] | join("")' 2>/dev/null) || return

  local ts ev orch worker repo pr ticket conclusion state phase wstatus channel prnums title msg gitref wfname headbranch reason src_ids_len
  IFS=$'\001' read -r ts ev orch worker repo pr ticket conclusion state phase wstatus channel prnums title msg gitref wfname headbranch reason src_ids_len <<< "$f"

  # Noise — skip high-frequency internal events. CTL-300 canonical names.
  case "$ev" in
    session.heartbeat|orchestrator.archived|session.started|session.ended) return ;;
  esac
  [[ "$ev" == "github.check_run.completed" \
    && ( "$conclusion" == "success" || "$conclusion" == "neutral" || "$conclusion" == "skipped" ) ]] && return

  # Repo filter (non-repo events pass through)
  if [[ -n "$REPO_FILTER" && -n "$repo" && "$repo" != *"$REPO_FILTER"* ]]; then return; fi

  local t c lbl src repo_short prref refc body
  t=$(fmt_time "$ts")

  repo_short="${repo##*/}"

  prref=""
  refc="$DIM"
  if [[ -n "$pr" && "$pr" =~ ^[0-9]+$ && "$pr" != "0" ]]; then
    prref="#${pr}"
  elif [[ -n "$prnums" && "$prnums" =~ ^[0-9,]+$ ]]; then
    prref="#${prnums}"
  elif [[ -n "$ticket" && "$ticket" != "null" ]]; then
    prref="$ticket"
  fi
  # For CI events with no PR: try extracting a ticket from the branch name
  if [[ -z "$prref" && -n "$headbranch" && "$headbranch" =~ ([A-Z]+-[0-9]+) ]]; then
    prref="${BASH_REMATCH[1]}"
  fi
  # Still no ref — show branch in magenta so main-branch CI events aren't blank
  if [[ -z "$prref" && -n "$headbranch" ]]; then
    prref="→ ${headbranch:0:12}"
    refc="$MAG"
  fi

  # SOURCE
  case "$ev" in
    github.*) src="github" ;;
    linear.*) src="linear" ;;
    comms.*)  src="comms"  ;;
    filter.*) src="filter" ;;
    *)
      if [[ -n "$worker" && "$worker" != "null" && -n "$orch" && "$orch" != "null" && "$worker" != "$orch" ]]; then
        src="${orch:0:9}/${worker:0:9}"
      elif [[ -n "$orch" && "$orch" != "null" ]]; then
        src="${orch:0:19}"
      elif [[ -n "$worker" && "$worker" != "null" ]]; then
        src="${worker:0:19}"
      else
        src="system"
      fi
      ;;
  esac

  local smsg="${msg:0:70}"
  local stitle="${title:0:50}"
  local sref="${gitref#refs/heads/}"; sref="${sref#refs/tags/}"

  body=""
  case "$ev" in
    # ── GitHub PR ──────────────────────────────────────────────────────────
    github.pr.merged)
      c="$GRN"; lbl="merged"
      body="${stitle:+— $stitle}"
      ;;
    github.pr.opened|github.pull_request.opened|session.pr_opened)
      c="$BLU"; lbl="pr open"
      body="${stitle:+— $stitle}"
      ;;
    github.pr.closed)
      c="$YEL"; lbl="pr closed"
      ;;
    github.pr.synchronize)
      c="$DIM"; lbl="pr sync"
      ;;
    github.pr.edited)
      c="$DIM"; lbl="pr edit"
      ;;
    github.pr.labeled)
      c="$DIM"; lbl="labeled"
      body="${stitle}"
      ;;
    github.pr.auto_merge_enabled)
      c="$GRN"; lbl="automerge+"
      ;;
    github.pr.auto_merge_disabled)
      c="$YEL"; lbl="automerge-"
      ;;
    # ── GitHub Reviews ─────────────────────────────────────────────────────
    github.pr_review.submitted)
      case "$state" in
        approved)           c="$GRN"; lbl="approved" ;;
        changes_requested)  c="$RED"; lbl="changes"  ;;
        *)                  c="$YEL"; lbl="reviewed" ;;
      esac
      ;;
    github.pr_review_thread.resolved)
      c="$DIM"; lbl="thread done"
      ;;
    # ── GitHub Comments ────────────────────────────────────────────────────
    github.issue_comment.*|github.pr_review_comment.*)
      c="$CYN"; lbl="comment"
      body="${smsg:+— $smsg}"
      ;;
    # ── GitHub CI ──────────────────────────────────────────────────────────
    github.check_suite.completed)
      if [[ "$conclusion" == "failure" || "$conclusion" == "timed_out" ]]; then
        c="$RED"; lbl="ci fail"
      elif [[ "$conclusion" == "cancelled" ]]; then
        c="$YEL"; lbl="ci cancel"
      else
        c="$GRN"; lbl="ci pass"
      fi
      body="${wfname:+$wfname }[$conclusion]"
      ;;
    github.check_run.completed)
      c="$RED"; lbl="chk fail"
      body="${stitle:-check} [$conclusion]"
      ;;
    # ── GitHub Workflows ───────────────────────────────────────────────────
    github.workflow_run.completed)
      body="${wfname:+$wfname }[$conclusion]"
      if [[ "$conclusion" == "failure" || "$conclusion" == "timed_out" ]]; then
        c="$RED"; lbl="wflow fail"
      elif [[ "$conclusion" == "cancelled" ]]; then
        c="$YEL"; lbl="wflow cancel"
        body="${wfname:-}"
      else
        c="$GRN"; lbl="wflow ok"
      fi
      ;;
    github.workflow_run.*)
      c="$DIM"; lbl="workflow"
      body="${wfname:+$wfname }[${wstatus:-${ev#github.workflow_run.}}]"
      ;;
    # ── GitHub Push / Branch ───────────────────────────────────────────────
    github.push)
      c="$DIM"; lbl="push"
      body="${sref:+→ $sref}"
      ;;
    github.create)
      c="$CYN"; lbl="branch +"
      body="${sref:-$stitle}"
      ;;
    github.delete)
      c="$YEL"; lbl="branch -"
      body="${sref:-$stitle}"
      ;;
    # ── GitHub Deployments ─────────────────────────────────────────────────
    github.deployment.created)
      c="$CYN"; lbl="deploy +"
      body="${stitle}"
      ;;
    github.deployment_status.success)
      c="$GRN"; lbl="deployed"
      body="${stitle}"
      ;;
    github.deployment_status.in_progress)
      c="$CYN"; lbl="deploying"
      body="${stitle}"
      ;;
    github.deployment_status.*)
      c="$DIM"; lbl="deploy"
      body="${stitle:+$stitle }[${ev#github.deployment_status.}]"
      ;;
    # ── Comms ──────────────────────────────────────────────────────────────
    comms.message.posted)
      c="$MAG"; lbl="comms"
      body="${channel:+#$channel }${smsg:+— $smsg}"
      ;;
    # ── Worker Events (CTL-300 canonical names) ───────────────────────────
    orchestrator.worker.done|orchestrator.worker.pr_merged)
      c="$GRN"; lbl="done"
      body="${ev##*.}"
      ;;
    orchestrator.worker.failed)
      c="$RED"; lbl="failed"
      body="$smsg"
      ;;
    orchestrator.worker.launch_failed)
      c="$RED"; lbl="launch fail"
      body="$smsg"
      ;;
    orchestrator.worker.dispatched)
      c="$CYN"; lbl="dispatched"
      ;;
    orchestrator.worker.pr_created)
      c="$BLU"; lbl="pr created"
      ;;
    orchestrator.worker.revived)
      c="$YEL"; lbl="revived"
      ;;
    orchestrator.worker.status_terminal)
      case "$wstatus" in
        done|success|completed) c="$GRN"; lbl="done"   ;;
        failed|error)           c="$RED"; lbl="failed" ;;
        *)                      c="$CYN"; lbl="worker" ;;
      esac
      body="$wstatus"
      ;;
    # ── Orchestrator Events (CTL-300 canonical names) ─────────────────────
    orchestrator.started)
      c="$BLU"; lbl="orch start"
      ;;
    orchestrator.failed)
      c="$RED"; lbl="orch fail"
      body="$smsg"
      ;;
    orchestrator.worker.phase_advanced|session.phase)
      c="$CYN"; lbl="phase"
      body="→ $phase"
      ;;
    session.iteration)
      c="$DIM"; lbl="iteration"
      ;;
    # ── Attention (CTL-300 canonical names) ───────────────────────────────
    orchestrator.attention.raised)
      c="${YEL}${BOLD}"; lbl="attention"
      body="$smsg"
      ;;
    orchestrator.attention.resolved)
      c="$DIM"; lbl="resolved"
      ;;
    # ── Linear ─────────────────────────────────────────────────────────────
    linear.issue.*)
      c="$BLU"; lbl="linear"
      body="${ev#linear.issue.}${stitle:+ — $stitle}"
      ;;
    # ── Filter Events ──────────────────────────────────────────────────────
    filter.wake*)
      # Groq no-match noise — suppress
      if [[ "$reason" == "No matching events found" ]]; then return; fi
      if [[ "${src_ids_len:-0}" -gt 0 ]]; then
        c="$CYN"; lbl="filter wake"
        body="Filter woke ${orch:0:20} — ${reason:0:70}"
      else
        c="$YEL"; lbl="filter wake"
        body="Worker went silent — ${reason:0:70}"
      fi
      ;;
    filter.register)
      c="$CYN"; lbl="filter reg"
      body="${orch:0:20} registered filter interest"
      ;;
    filter.deregister)
      c="$DIM"; lbl="filter unreg"
      body="${orch:0:20} deregistered interest"
      ;;
    # ── Fallthrough ────────────────────────────────────────────────────────
    *)
      c="$DIM"; lbl="${ev:0:14}"
      body="$smsg"
      ;;
  esac

  # TIME(8)  REPO(12)  SOURCE(20)  EVENT(14)  REF(10)  DETAILS
  printf "${c}${BOLD}%-8s${R}  %-12s  ${DIM}%-20s${R}  ${c}%-14s${R}  ${refc}%-14s${R}  %s\n" \
    "$t" "${repo_short:-}" "$src" "$lbl" "${prref:-}" "$body"
}

# --- Header ----------------------------------------------------------------
printf "${BOLD}${CYN}%-8s  %-12s  %-20s  %-14s  %-14s  %s${R}\n" \
  "TIME" "REPO" "SOURCE" "EVENT" "REF" "DETAILS"
printf "${DIM}%s${R}\n" "$(printf '%.0s─' {1..100})"

# --- Stream ----------------------------------------------------------------
catalyst-events tail "$@" | while IFS= read -r line; do
  render "$line"
done
