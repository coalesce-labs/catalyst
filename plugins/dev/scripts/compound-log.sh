#!/usr/bin/env bash
# compound-log.sh — write a compound-log entry at PR merge.
#
# Closing ritual for the AI-native estimation feedback loop (CTL-159). At PR
# merge, this helper writes a structured entry to:
#
#   <thoughts-dir>/shared/pm/metrics/<YYYY-WW>-compound-log.md
#
# One file per ISO week, one entry per merged PR. Fields follow the
# CTL-159 schema: linear.key, pr_number, merged_at, estimate_at_start,
# estimate_actual, cost_usd, wall_time_hours, what_worked, what_surprised_me.
#
# Commands:
#   iso-week <iso-timestamp>
#       Print YYYY-WW for the given UTC timestamp. Exits non-zero on bad input.
#
#   write <ticket-id> [options]
#       Append an entry for <ticket-id>. Options:
#         --pr <number>               PR number (default: gh pr view on branch)
#         --merged-at <iso>           override (default: gh pr view mergedAt)
#         --created-at <iso>          override (default: gh pr view createdAt)
#         --estimate-start <int>      override (default: linearis read .estimate)
#         --estimate-actual <int>     REQUIRED
#         --cost-usd <float>          override (default: catalyst-state aggregate)
#         --wall-time-hours <float>   override (default: computed from PR ts)
#         --what-worked <text>        REQUIRED
#         --what-surprised-me <text>  REQUIRED
#         --thoughts-dir <path>       override thoughts root (default: ./thoughts)
#         --force                     replace existing (ticket, pr) entry
#         --dry-run                   print entry, write nothing
#
# Exit codes: 0 on success, 1 on any validation/IO failure (fails loud).

set -uo pipefail

# ─── utilities ──────────────────────────────────────────────────────────────

err() { echo "error: $*" >&2; }

fatal() {
  err "$*"
  exit 1
}

# Parse an ISO-8601 UTC timestamp to epoch seconds. Returns epoch on stdout,
# non-zero on failure. Tries BSD date first (macOS), then GNU date (Linux).
iso_to_epoch() {
  local ts="$1"
  local epoch
  epoch=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$ts" "+%s" 2>/dev/null) \
    || epoch=$(date -u -d "$ts" "+%s" 2>/dev/null) \
    || return 1
  printf "%s" "$epoch"
}

# Emit YYYY-WW (ISO-8601 week) for a UTC timestamp.
iso_week_of() {
  local ts="$1"
  local out
  out=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$ts" "+%G-W%V" 2>/dev/null) \
    || out=$(date -u -d "$ts" "+%G-W%V" 2>/dev/null) \
    || return 1
  printf "%s" "$out"
}

# Numeric check — accepts ints and decimals (positive only).
is_numeric() {
  [[ "$1" =~ ^[0-9]+(\.[0-9]+)?$ ]]
}

# ─── PR + Linear probes ─────────────────────────────────────────────────────

# Echo key=value lines from `gh pr view --json number,createdAt,mergedAt,state`.
# Returns non-zero if gh is unavailable or PR lookup fails.
probe_pr() {
  local pr_arg="$1" json
  if [ -n "$pr_arg" ]; then
    json=$(gh pr view "$pr_arg" --json number,createdAt,mergedAt,state 2>/dev/null) || return 1
  else
    json=$(gh pr view --json number,createdAt,mergedAt,state 2>/dev/null) || return 1
  fi
  [ -z "$json" ] && return 1
  printf "%s" "$json"
}

probe_linear_estimate() {
  local ticket="$1" json
  json=$(linearis issues read "$ticket" 2>/dev/null) || return 1
  [ -z "$json" ] && return 1
  echo "$json" | jq -r '.estimate // empty'
}

# Probe local cost data. Tries (in order):
#   1. catalyst-state.sh worker aggregate for current orchestrator
#   2. catalyst-session.sh history --ticket
# Prints numeric cost on stdout, exits non-zero if no data found.
probe_cost_local() {
  local ticket="$1"
  local script_dir="$2"
  local state_script="${script_dir}/catalyst-state.sh"
  local session_script="${script_dir}/catalyst-session.sh"

  # State aggregate (orchestrator mode)
  if [ -n "${CATALYST_ORCHESTRATOR_ID:-}" ] && [ -x "$state_script" ]; then
    local agg
    agg=$("$state_script" worker-usage "${CATALYST_ORCHESTRATOR_ID}" "$ticket" 2>/dev/null \
      | jq -r '.cost_usd // empty' 2>/dev/null)
    if [ -n "$agg" ] && is_numeric "$agg"; then
      printf "%s" "$agg"
      return 0
    fi
  fi

  # Session history fallback
  if [ -x "$session_script" ]; then
    local hist
    hist=$("$session_script" history --ticket "$ticket" --limit 1 2>/dev/null \
      | jq -r '.[0].cost_usd // empty' 2>/dev/null)
    if [ -n "$hist" ] && is_numeric "$hist"; then
      printf "%s" "$hist"
      return 0
    fi
  fi

  return 1
}

# ─── entry rendering + file writing ─────────────────────────────────────────

# Args: all resolved fields in positional order.
render_entry() {
  local linear_key="$1" pr="$2" merged_at="$3" est_start="$4" est_actual="$5"
  local cost="$6" wall_hours="$7" what_worked="$8" what_surprised="$9"

  # YAML-escape: replace " with \" in free-text fields; wrap in double quotes.
  local ww="${what_worked//\"/\\\"}"
  local ws="${what_surprised//\"/\\\"}"

  cat <<EOF
### ${linear_key} — #${pr} — ${merged_at}

\`\`\`yaml
linear_key: ${linear_key}
pr_number: ${pr}
merged_at: ${merged_at}
estimate_at_start: ${est_start}
estimate_actual: ${est_actual}
cost_usd: ${cost}
wall_time_hours: ${wall_hours}
what_worked: "${ww}"
what_surprised_me: "${ws}"
\`\`\`

EOF
}

# Ensure the weekly file exists with its header.
ensure_week_file() {
  local file="$1" week="$2"
  if [ ! -f "$file" ]; then
    mkdir -p "$(dirname "$file")"
    cat > "$file" <<EOF
# Compound Log — ${week}

One entry per merged PR. Fields follow the CTL-159 schema.

EOF
  fi
}

# Remove an existing entry (### TICKET — #PR … through the next ### or EOF).
# Writes the result back to the file in-place.
remove_entry() {
  local file="$1" ticket="$2" pr="$3"
  local tmp="${file}.tmp.$$"
  awk -v marker="### ${ticket} — #${pr}" '
    BEGIN { in_block = 0 }
    /^### / {
      if (index($0, marker) == 1) { in_block = 1; next }
      else { in_block = 0 }
    }
    { if (!in_block) print }
  ' "$file" > "$tmp" && mv "$tmp" "$file"
}

# ─── subcommand: iso-week ───────────────────────────────────────────────────

cmd_iso_week() {
  local ts="${1:-}"
  [ -z "$ts" ] && fatal "iso-week: missing timestamp argument"
  local out
  out=$(iso_week_of "$ts") || fatal "iso-week: invalid ISO-8601 timestamp: $ts"
  printf "%s\n" "$out"
}

# ─── subcommand: write ──────────────────────────────────────────────────────

cmd_write() {
  local ticket="${1:-}"
  shift || true
  [ -z "$ticket" ] && fatal "write: missing ticket-id argument"

  local pr=""
  local merged_at=""
  local created_at=""
  local est_start=""
  local est_actual=""
  local cost_usd=""
  local wall_hours=""
  local what_worked=""
  local what_surprised=""
  local thoughts_dir="./thoughts"
  local force=0
  local dry_run=0

  while [ $# -gt 0 ]; do
    case "$1" in
      --pr)                pr="$2"; shift 2 ;;
      --merged-at)         merged_at="$2"; shift 2 ;;
      --created-at)        created_at="$2"; shift 2 ;;
      --estimate-start)    est_start="$2"; shift 2 ;;
      --estimate-actual)   est_actual="$2"; shift 2 ;;
      --cost-usd)          cost_usd="$2"; shift 2 ;;
      --wall-time-hours)   wall_hours="$2"; shift 2 ;;
      --what-worked)       what_worked="$2"; shift 2 ;;
      --what-surprised-me) what_surprised="$2"; shift 2 ;;
      --thoughts-dir)      thoughts_dir="$2"; shift 2 ;;
      --force)             force=1; shift ;;
      --dry-run)           dry_run=1; shift ;;
      *) fatal "write: unknown flag: $1" ;;
    esac
  done

  # 1. Required user-supplied fields (fail loud before any external calls).
  [ -z "$est_actual" ] && fatal "write: required: --estimate-actual"
  is_numeric "$est_actual" || fatal "write: --estimate-actual must be numeric, got: $est_actual"
  [ -z "$what_worked" ] && fatal "write: required: --what-worked"
  [ -z "$what_surprised" ] && fatal "write: required: --what-surprised-me"

  # 2. Resolve PR details via `gh` unless fully overridden.
  local pr_json=""
  if [ -z "$pr" ] || [ -z "$merged_at" ] || [ -z "$created_at" ]; then
    pr_json=$(probe_pr "$pr") \
      || fatal "write: could not resolve PR via gh (pass --pr/--merged-at/--created-at to override)"
  fi

  if [ -z "$pr" ]; then
    pr=$(echo "$pr_json" | jq -r '.number // empty')
    [ -z "$pr" ] && fatal "write: gh returned no PR number"
  fi

  if [ -z "$merged_at" ]; then
    merged_at=$(echo "$pr_json" | jq -r '.mergedAt // empty')
    [ -z "$merged_at" ] || [ "$merged_at" = "null" ] && fatal "write: PR #${pr} has no mergedAt (not yet merged?)"
  fi

  if [ -z "$created_at" ]; then
    created_at=$(echo "$pr_json" | jq -r '.createdAt // empty')
  fi

  # 3. Resolve Linear estimate_at_start via linearis unless overridden.
  if [ -z "$est_start" ]; then
    est_start=$(probe_linear_estimate "$ticket") \
      || fatal "write: could not resolve estimate via linearis (pass --estimate-start to override)"
    [ -z "$est_start" ] && fatal "write: ticket $ticket has no estimate set in Linear"
  fi
  is_numeric "$est_start" || fatal "write: estimate_at_start not numeric: $est_start"

  # 4. Resolve cost_usd from local aggregates unless overridden.
  if [ -z "$cost_usd" ]; then
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    cost_usd=$(probe_cost_local "$ticket" "$script_dir") \
      || fatal "write: no cost data for $ticket in catalyst-state or session history (pass --cost-usd to override)"
  fi
  is_numeric "$cost_usd" || fatal "write: cost_usd not numeric: $cost_usd"

  # 5. Compute wall_time_hours unless overridden.
  if [ -z "$wall_hours" ]; then
    [ -z "$created_at" ] && fatal "write: cannot compute wall_time_hours without createdAt (pass --wall-time-hours)"
    local t0 t1 delta
    t0=$(iso_to_epoch "$created_at") || fatal "write: invalid createdAt: $created_at"
    t1=$(iso_to_epoch "$merged_at")  || fatal "write: invalid mergedAt: $merged_at"
    delta=$(( t1 - t0 ))
    # One decimal place; awk handles division portably.
    wall_hours=$(awk -v d="$delta" 'BEGIN{ printf "%.1f", d/3600 }')
  fi
  is_numeric "$wall_hours" || fatal "write: wall_time_hours not numeric: $wall_hours"

  # 6. Prometheus overlay is gated but not yet implemented. Advertise clearly.
  if [ -n "${CATALYST_PROMETHEUS_URL:-}" ]; then
    echo "note: CATALYST_PROMETHEUS_URL is set; Prometheus overlay not yet implemented — using local aggregates" >&2
  fi

  # 7. Compute target week file from mergedAt (NOT today).
  local week outfile
  week=$(iso_week_of "$merged_at") || fatal "write: could not derive ISO week from mergedAt: $merged_at"
  outfile="${thoughts_dir}/shared/pm/metrics/${week}-compound-log.md"

  # 8. Dry-run: print entry only.
  local entry
  entry=$(render_entry "$ticket" "$pr" "$merged_at" "$est_start" "$est_actual" \
                       "$cost_usd" "$wall_hours" "$what_worked" "$what_surprised")

  if [ "$dry_run" -eq 1 ]; then
    echo "dry-run: would write to ${outfile}"
    echo ""
    printf "%s" "$entry"
    return 0
  fi

  # 9. Dedup check.
  ensure_week_file "$outfile" "$week"
  if grep -q "^### ${ticket} — #${pr} " "$outfile" 2>/dev/null \
     || grep -q "^### ${ticket} — #${pr}$" "$outfile" 2>/dev/null; then
    if [ "$force" -eq 0 ]; then
      fatal "write: entry for ${ticket} #${pr} already exists in ${outfile}; pass --force to replace"
    fi
    remove_entry "$outfile" "$ticket" "$pr"
  fi

  # 10. Append. Trailing newline re-added — $(heredoc) strips them, and we
  # need a blank line between entries so `### ` headings stay on their own line.
  printf "%s\n\n" "$entry" >> "$outfile"
  echo "wrote: ${outfile}"
  echo "entry: ${ticket} — #${pr} — ${merged_at}"
}

# ─── main ───────────────────────────────────────────────────────────────────

usage() {
  sed -n '2,35p' "$0" | sed 's|^# \{0,1\}||'
}

case "${1:-}" in
  iso-week)  shift; cmd_iso_week "$@" ;;
  write)     shift; cmd_write "$@" ;;
  -h|--help|help|"") usage ;;
  *) fatal "unknown subcommand: ${1}" ;;
esac
