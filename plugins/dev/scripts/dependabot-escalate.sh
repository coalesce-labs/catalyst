#!/usr/bin/env bash
# dependabot-escalate.sh — Periodic sweep that turns two "needs a human"
# Dependabot signals into a Linear ticket in the affected repo's own team,
# so they enter the normal Catalyst triage/recovery-pass queue instead of
# living only in a GitHub Actions log or an email notification (the gap a
# 2026-08-04 fleet CI/CD health sweep found).
#
# Two triggers, both read from evidence Catalyst already has locally:
#   1. failed-update  — the "Dependabot Updates" workflow_run (GitHub's own
#      internal dependency-update-check run, distinct from this repo's
#      user-defined dependabot-auto-merge.yml) completed with
#      conclusion=failure. This means Dependabot could not even open a PR
#      (e.g. a real version-conflict it can't auto-resolve) — there is no PR
#      to label or auto-merge, so without this sweep the only signal is
#      GitHub's own email notification. Queried live via `gh run list`
#      rather than the unified event log: confirmed empirically (2026-08-04)
#      that "Dependabot Updates" runs do NOT appear in
#      ~/catalyst/events/*.jsonl at all despite the repo's webhook being
#      subscribed to workflow_run — GitHub appears not to fire a normal
#      workflow_run webhook for this GitHub-managed internal run type (it's
#      sandboxed separately from user workflow files). A live query sidesteps
#      that gap entirely; it costs one `gh run list` call per repo per sweep.
#   2. major-update   — an open PR already carries the major-update label
#      (dependabot-auto-merge.yml's own labeling for a major-version bump it
#      deliberately does NOT auto-merge). Read via a direct `gh pr list`
#      sweep per repo rather than the event log: GitHub's `pull_request`
#      "labeled" webhook payload includes a `label` block naming which label
#      was added, but the current webhook parser
#      (orch-monitor/lib/webhook-events.ts) does not carry that field through
#      to the canonical event — so the event log alone can't tell WHICH label
#      fired. A live `gh pr list --label` sweep sidesteps that gap entirely.
#
# Deliberately a SHORT-LIVED launchd StartInterval sweep (the health-responder
# / orphan-sweep pattern), not a long-lived daemon — see health-responder.sh's
# header for why. All escalation is idempotent: before filing, it searches
# the target repo's Linear team for an already-open ticket with a matching
# marker string, so a recurring nightly failure (or a PR that stays labeled
# across multiple sweeps) files exactly one ticket, not one per run.
#
# Usage: dependabot-escalate.sh [--dry-run] [--lookback-hours N]

set -uo pipefail

# ─── repo → Linear team key map ────────────────────────────────────────────
# Deliberately NOT hardcoded here (this script ships in the public
# coalesce-labs/catalyst repo — see AGENTS.md's "Do NOT commit: Specific
# ticket prefixes... Linear team/project IDs" rule, and the pre-push hook
# that enforces it). Read instead from a Layer-2-style local config file,
# same two-layer split as .catalyst/config.json vs
# ~/.config/catalyst/config-*.json elsewhere in this repo: the mechanism
# (this script) is public, the operator's actual repo/team list is not.
#
# Format: a flat JSON object, {"org/repo": "TEAMKEY", ...}. See
# dependabot-escalate-repos.example.json alongside this script for the shape.
CONFIG_FILE="${DEPENDABOT_ESCALATE_CONFIG:-${HOME}/.config/catalyst/dependabot-escalate-repos.json}"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "dependabot-escalate.sh: no repo/team config at ${CONFIG_FILE}" >&2
  echo "  Set DEPENDABOT_ESCALATE_CONFIG or create that file — see" >&2
  echo "  dependabot-escalate-repos.example.json for the expected shape." >&2
  exit 1
fi

REPO_TEAM_MAP=()
while IFS=$'\t' read -r repo team; do
  [[ -n "$repo" && -n "$team" ]] && REPO_TEAM_MAP+=("${repo}:${team}")
done < <(jq -r 'to_entries[] | "\(.key)\t\(.value)"' "$CONFIG_FILE" 2>/dev/null)

if [[ "${#REPO_TEAM_MAP[@]}" -eq 0 ]]; then
  echo "dependabot-escalate.sh: ${CONFIG_FILE} parsed to zero repo/team entries — refusing to run a no-op sweep" >&2
  exit 1
fi

DRY_RUN=0
LOOKBACK_HOURS=26  # > 24h so an hourly/daily sweep never has a gap at the boundary

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --lookback-hours=*)
      LOOKBACK_HOURS="${arg#*=}" ;;
    --help|-h)
      echo "Usage: dependabot-escalate.sh [--dry-run] [--lookback-hours=N]"
      exit 0
      ;;
  esac
done

LOG_FILE="${HOME}/catalyst/dependabot-escalate.log"
STATE_DIR="${HOME}/catalyst/.dependabot-escalate"
mkdir -p "$STATE_DIR"

log() {
  local line
  line="$(date -u +"%Y-%m-%dT%H:%M:%SZ") $*"
  echo "$line" >> "$LOG_FILE"
  echo "$line"
}

team_for_repo() {
  local repo="$1"
  for entry in "${REPO_TEAM_MAP[@]}"; do
    if [[ "${entry%%:*}" == "$repo" ]]; then
      echo "${entry##*:}"
      return 0
    fi
  done
  return 1
}

# True (rc=0) if an OPEN ticket already exists in $1's team whose description
# contains the EXACT marker string $2.
#
# Deliberately NOT `linearis issues search` — confirmed empirically
# (2026-08-04) that Linear's search API does fuzzy/OR token matching, not
# phrase matching: it silently returns ZERO results for a marker containing
# `/` or `:` (even though the exact substring is present in a ticket
# description), and returns a near-workspace-wide false-positive flood for
# markers containing only common word-fragments — either failure mode broke
# idempotency (verified: it filed 8 duplicate tickets per sweep before this
# fix). Pulling the team's open issues via `list` (paginated, exact JSON) and
# grepping locally with a FIXED string is slower per-call but exact — no
# query-language edge cases to hit.
ticket_already_exists() {
  local team="$1" marker="$2"
  linearis issues list --team "$team" --status "Backlog,Todo,In Progress,In Review,Triage" \
    --fields description --limit 250 2>/dev/null \
    | grep -qF "Escalation-marker: ${marker}"
}

file_ticket() {
  local team="$1" title="$2" body="$3" marker="$4"
  if ticket_already_exists "$team" "$marker"; then
    log "skip (already open): [$team] $title"
    return 0
  fi
  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "DRY-RUN would file: [$team] $title"
    return 0
  fi
  local result
  result="$(linearis issues create "$title" --team "$team" --description "$body" --fields identifier 2>&1)"
  local identifier
  identifier="$(echo "$result" | grep -o '"identifier": *"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
  if [[ -n "$identifier" ]]; then
    log "filed: $identifier — [$team] $title"
  else
    log "ERROR filing [$team] $title: $result"
  fi
}

# ─── Trigger 1: failed dependency-update workflow runs ─────────────────────
sweep_failed_updates() {
  local since_epoch
  since_epoch="$(date -u -v-"${LOOKBACK_HOURS}"H +%s 2>/dev/null || date -u -d "-${LOOKBACK_HOURS} hours" +%s)"

  for entry in "${REPO_TEAM_MAP[@]}"; do
    local repo="${entry%%:*}" team="${entry##*:}"
    local runs
    runs="$(gh run list --repo "$repo" --workflow "Dependabot Updates" --limit 10 \
      --json conclusion,createdAt,databaseId,url 2>/dev/null)"
    [[ -z "$runs" || "$runs" == "[]" ]] && continue

    # Only the MOST RECENT run counts — an older failure a later run already
    # superseded should not re-escalate.
    local latest_conclusion latest_created latest_url ts_epoch
    latest_conclusion="$(echo "$runs" | jq -r '.[0].conclusion')"
    latest_created="$(echo "$runs" | jq -r '.[0].createdAt')"
    latest_url="$(echo "$runs" | jq -r '.[0].url')"
    [[ "$latest_conclusion" != "failure" ]] && continue

    ts_epoch="$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$latest_created" +%s 2>/dev/null \
      || date -u -d "$latest_created" +%s 2>/dev/null || echo 0)"
    [[ "$ts_epoch" -lt "$since_epoch" ]] && continue

    local marker="dependabot-update-failure:${repo}"
    local title="${repo#*/}'s Dependabot update run should be fixed, not left silently failing"
    local body
    body="$(cat <<EOF
Context: routine dependabot-health sweep (2026-08-04 audit + ongoing dependabot-escalate.sh watcher).
Motivation: a failed "Dependabot Updates" run means Dependabot could not open a PR at all — usually a real, human-judgment dependency conflict (e.g. a security patch that would force-downgrade a peer dependency). Without this ticket the only signal is GitHub's own email notification / the Actions log.
Outcome: someone resolves the underlying conflict (bump the blocking peer dependency first, or add an npm/cargo/etc override pinning a safe version), then re-runs the Dependabot update.

Repo: ${repo}
Run: ${latest_url}
First observed by this sweep: $(date -u +%Y-%m-%dT%H:%M:%SZ)

Escalation-marker: ${marker}
EOF
)"
    file_ticket "$team" "$title" "$body" "$marker"
  done
}

# ─── Trigger 2: PRs already labeled major-update ────────────────────────────
sweep_major_update_prs() {
  for entry in "${REPO_TEAM_MAP[@]}"; do
    local repo="${entry%%:*}" team="${entry##*:}"
    local prs
    prs="$(gh pr list --repo "$repo" --label "major-update" --state open --json number,title,url,body 2>/dev/null)"
    [[ -z "$prs" || "$prs" == "[]" ]] && continue

    echo "$prs" | jq -c '.[]' | while IFS= read -r pr; do
      local num title url
      num="$(echo "$pr" | jq -r '.number')"
      title="$(echo "$pr" | jq -r '.title')"
      url="$(echo "$pr" | jq -r '.url')"

      local marker="dependabot-major-update:${repo}#${num}"
      local ticket_title="${repo#*/}#${num} needs a human decision on a major dependency bump"
      local body
      body="$(cat <<EOF
Context: dependabot-auto-merge.yml deliberately does NOT auto-merge major-version bumps — it labels them major-update,needs-review and stops, per the existing repo workflow.
Motivation: without an explicit ticket, a labeled PR can sit indefinitely with no queue visibility beyond the GitHub PR list itself.
Outcome: a human reviews the changelog/breaking changes for this bump and either merges it or closes it with a reason.

PR: ${url}
Title: ${title}

Escalation-marker: ${marker}
EOF
)"
      file_ticket "$team" "$ticket_title" "$body" "$marker"
    done
  done
}

log "=== dependabot-escalate sweep start (lookback=${LOOKBACK_HOURS}h dry-run=${DRY_RUN}) ==="
sweep_failed_updates
sweep_major_update_prs
log "=== dependabot-escalate sweep done ==="
