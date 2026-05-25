# plugins/dev/direnv/lib/otel.sh
#
# Vendored source-of-truth for the `use_otel_context` direnv helper. Install on
# a user's machine by copying to ~/.config/direnv/lib/otel.sh — direnv loads
# any *.sh in that directory automatically.
#
# Usage in .envrc files:
#   use_otel_context                    # Auto-detect project from directory name
#   use_otel_context "my-project"       # Explicit project name
#
# Sets OTEL_RESOURCE_ATTRIBUTES with:
#   - project       (from argument or directory name)
#   - hostname      (machine short name)
#   - branch        (current branch, if in a git repo)
#   - linear.key    (ticket ID from branch name, e.g. ADV-167 or ENG-123,
#                    with fallback to .catalyst/.workflow-context.json)
#   - catalyst.orchestration  (orchestration name, set when in a Catalyst worktree;
#                              groups orchestrator + workers from the same run)
#
# These become Prometheus labels and Loki structured metadata via the
# OTel Collector's resource_to_telemetry_conversion.
#
# Note: direnv sets $PWD to the directory containing the .envrc file, NOT
# the directory you cd'd into. So for worktree containers (e.g. Adva/ with
# baku/ inside), each worktree needs its own .envrc with source_up so that
# $PWD correctly points to the worktree when this function runs.
# If you switch branches without leaving the directory, run `direnv reload`.
#
# CTL-637: this file dedups OTEL_RESOURCE_ATTRIBUTES on every direnv reload
# (last-write-wins per key). Without dedup, every `cd` / `direnv reload`
# appended another full snapshot of project=, hostname=, branch=, linear.key=,
# catalyst.orchestration= pairs and long-lived shells accumulated the same
# key many times.

# CTL-637: Pure helper. Dedups a comma-joined "k=v,k=v,..." string by keeping
# the LAST occurrence of each key (matches OTLP last-write-wins). The position
# of each surviving pair is the position of its FIRST occurrence in the input
# — preserves a stable order for human readability without affecting OTLP,
# which is order-insensitive. Tokens without '=' are preserved verbatim
# (no key, no possible collision).
#
# Known limitation: values containing literal commas are not supported. The
# attribute set produced by use_otel_context never embeds commas inside
# values, so this is fine today. If a future key needs embedded commas,
# update both this helper and use_otel_context.
__catalyst_otel_dedup_attrs() {
  local input="$1"
  if [ -z "$input" ]; then
    printf ''
    return 0
  fi

  printf '%s' "$input" | awk -v RS=',' '
    {
      pos = index($0, "=")
      if (pos == 0) {
        # Token without "=" — preserve verbatim at first-seen position.
        if (!($0 in seen_raw)) {
          seen_raw[$0] = 1
          order[++n] = $0
          is_raw[$0] = 1
        }
        next
      }
      key = substr($0, 1, pos - 1)
      if (!(key in val)) {
        order[++n] = key
      }
      val[key] = $0
    }
    END {
      for (i = 1; i <= n; i++) {
        token = order[i]
        if (token in is_raw) {
          printf "%s%s", token, (i < n ? "," : "")
        } else {
          printf "%s%s", val[token], (i < n ? "," : "")
        }
      }
    }
  '
}

use_otel_context() {
  local project="${1:-$(basename "$PWD")}"
  local attrs="project=${project},hostname=$(hostname -s)"

  # Git branch: use $PWD (correct when .envrc is in the worktree dir itself).
  # Fallback to CONDUCTOR_WORKSPACE_PATH for Conductor-launched sessions where
  # direnv sets $PWD to the .envrc's parent dir, not the worktree.
  local git_dir="${PWD}"
  if [ -z "$(git -C "$git_dir" branch --show-current 2>/dev/null)" ] && [ -n "${CONDUCTOR_WORKSPACE_PATH:-}" ]; then
    git_dir="$CONDUCTOR_WORKSPACE_PATH"
  fi
  local branch
  branch=$(git -C "$git_dir" branch --show-current 2>/dev/null)
  if [ -n "$branch" ]; then
    attrs="${attrs},branch=${branch}"
  fi

  # Linear ticket: extract from branch name (case-insensitive, uppercased).
  # Uses tail -1 so Catalyst worker branches like "orch-prefix-ADV-220" pick up
  # the ticket suffix (ADV-220) rather than a false match in the prefix.
  local linear_key=""
  local all_ticket_matches=""
  local match_count=0
  if [ -n "$branch" ]; then
    all_ticket_matches=$(echo "$branch" | grep -oiE '[A-Za-z]+-[0-9]+' || true)
    if [ -n "$all_ticket_matches" ]; then
      match_count=$(echo "$all_ticket_matches" | wc -l | tr -d ' ')
      linear_key=$(echo "$all_ticket_matches" | tail -1 | tr '[:lower:]' '[:upper:]')
    fi
  fi

  # Fallback: read from .catalyst/.workflow-context.json if branch had no ticket
  if [ -z "$linear_key" ] && [ -f "${PWD}/.catalyst/.workflow-context.json" ]; then
    local ctx_ticket
    ctx_ticket=$(python3 -c "
import json, sys
try:
    d = json.load(open('${PWD}/.catalyst/.workflow-context.json'))
    t = d.get('currentTicket')
    if t and t not in ('null', 'general', 'None'):
        print(t)
except Exception:
    pass
" 2>/dev/null)
    [ -n "$ctx_ticket" ] && linear_key="$ctx_ticket"
  fi

  [ -n "$linear_key" ] && attrs="${attrs},linear.key=${linear_key}"

  # Catalyst orchestration: when in a Catalyst worktree, derive the orchestration
  # name so all workers + orchestrator from the same run share a grouping label.
  # Worker branches: "orch-name-TICKET" → strip ticket suffix → "orch-name"
  # Orchestrator branches: use the branch name directly.
  if [ -d "${PWD}/.catalyst" ] && [ -n "$branch" ]; then
    local orch_name
    if [ "$match_count" -gt 1 ]; then
      local raw_last_match
      raw_last_match=$(echo "$all_ticket_matches" | tail -1)
      orch_name=$(echo "$branch" | sed "s/-${raw_last_match}$//")
    else
      orch_name="$branch"
    fi
    attrs="${attrs},catalyst.orchestration=${orch_name}"
  fi

  if [ -n "${OTEL_RESOURCE_ATTRIBUTES:-}" ]; then
    OTEL_RESOURCE_ATTRIBUTES="${OTEL_RESOURCE_ATTRIBUTES},${attrs}"
  else
    OTEL_RESOURCE_ATTRIBUTES="${attrs}"
  fi
  # CTL-637: dedup keeping last value per key (OTLP LWW). Without this,
  # every direnv reload appends another full copy of project=, hostname=,
  # branch=, linear.key=, catalyst.orchestration= pairs — long-lived shells
  # accumulate the same key many times.
  OTEL_RESOURCE_ATTRIBUTES=$(__catalyst_otel_dedup_attrs "$OTEL_RESOURCE_ATTRIBUTES")
  export OTEL_RESOURCE_ATTRIBUTES
}
