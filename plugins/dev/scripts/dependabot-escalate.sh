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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# This is a macOS LaunchAgent (StartInterval sweep), not a Claude
# process -- unlike execution-core/broker, it had no app-actor auth at all,
# so its linearis calls fell straight through to the operator's own personal
# credential. Mint the dedicated linear-linearis-actor identity before the
# first linearis call below. Fail-open (linear_app_actor_auth's own
# documented contract): a failed mint just leaves LINEAR_API_TOKEN unset, and
# linearis falls back to its own resolution (~/.linearis/token) exactly as it
# does today -- the sweep is never blocked by this.
# shellcheck source=lib/linear-app-actor.sh
source "${SCRIPT_DIR}/lib/linear-app-actor.sh"
linear_app_actor_auth "dependabot-escalate" LINEAR_API_TOKEN linear-linearis-actor "Catalyst linearis app-actor"

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
      LOOKBACK_HOURS="${arg#*=}"
      # Codex P2: a malformed value (e.g. "abc") silently zeroes out the
      # lookback arithmetic below (empty since_epoch compares as 0 under
      # `set -u`), which lets an arbitrarily old failed run pass the cutoff
      # and file a live ticket. Require a positive integer up front.
      [[ "$LOOKBACK_HOURS" =~ ^[1-9][0-9]*$ ]] || {
        echo "dependabot-escalate.sh: --lookback-hours must be a positive integer, got: ${LOOKBACK_HOURS}" >&2
        exit 2
      }
      ;;
    --help|-h)
      echo "Usage: dependabot-escalate.sh [--dry-run] [--lookback-hours=N]"
      exit 0
      ;;
    *)
      # Codex P2: an unrecognized flag (e.g. a typo'd --dry-rnu) must not
      # silently fall through to a live sweep with dry-run=0.
      echo "dependabot-escalate.sh: unknown argument: ${arg} (see --help)" >&2
      exit 2
      ;;
  esac
done

LOG_FILE="${HOME}/catalyst/dependabot-escalate.log"
STATE_DIR="${HOME}/catalyst/.dependabot-escalate"
mkdir -p "$STATE_DIR"

# Set by any failure that must not be silently swallowed (dedup query error,
# `gh` query error, ticket-create error, team misroute) — the final exit code
# reflects it, so a launchd/cron log-only sweep still surfaces failures loudly
# rather than reporting "sweep done" over data it never actually escalated.
SWEEP_HAD_ERRORS=0

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

# Resolve a Linear team key/name to its UUID, with an in-process cache (a
# plain array, matching REPO_TEAM_MAP's style — this script is launched via
# /bin/bash by launchd, i.e. macOS's stock bash 3.2, which has no
# `declare -A`). Codex P2: `linearis issues create --team <key>` has a
# documented upstream bug (czottmann/linearis#56) where a key/name argument
# silently routes to the workspace DEFAULT team instead of erroring — the
# same workaround already used by briefing-followup/action-ticket.sh.
TEAM_UUID_MAP=()

resolve_team_uuid() {
  local team_key="$1"
  if [[ "$team_key" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
    echo "$team_key"
    return 0
  fi
  local entry
  for entry in "${TEAM_UUID_MAP[@]}"; do
    if [[ "${entry%%:*}" == "$team_key" ]]; then
      echo "${entry#*:}"
      return 0
    fi
  done
  local teams_json uuid
  teams_json="$(linearis teams list 2>/dev/null </dev/null)"
  uuid="$(echo "$teams_json" | jq -r --arg k "$team_key" \
    '.nodes[]? | select(.key == $k or .name == $k) | .id' 2>/dev/null | head -1)"
  if [[ -z "$uuid" ]]; then
    log "WARN resolve_team_uuid: could not resolve Linear team '${team_key}' via 'linearis teams list' — falling back to the raw key (linearis#56 may then misroute to the workspace default team)"
    uuid="$team_key"
  fi
  TEAM_UUID_MAP+=("${team_key}:${uuid}")
  echo "$uuid"
}

# True (rc=0) if an OPEN ticket already exists in $1's team whose description
# contains the EXACT marker string $2. Return codes:
#   0 = a matching OPEN ticket exists
#   1 = queried successfully — confirmed no match
#   2 = the query itself failed — caller must NOT treat this as "no match"
#       (Codex P1/P2: a discarded stderr + nonzero rc, or a mid-team-list
#       partial page, looks identical to a legitimate empty result to a bare
#       `grep -q`, which would silently re-file a duplicate on every
#       transient Linear/CLI hiccup).
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
#
# Deliberately NOT a fixed `--status` list either (Codex P1): a generic
# Backlog/Todo/In Progress/... list does not cover every team's custom
# workflow (e.g. this repo's own CTL team uses Research/Plan/Implement/
# Validate/PR/Remediate/Triage instead of "In Progress" — confirmed live,
# `linearis issues list --status "...In Progress..."` errors "Status \"In
# Progress\" ... not found" for that team). The default (unfiltered) `list`
# already excludes Done tickets (linearis skill Gotcha #1), which is exactly
# the "still open" semantics this check needs, for ANY team's state names.
ticket_already_exists() {
  local team_uuid="$1" marker="$2"
  local after="" page=0
  while :; do
    page=$((page + 1))
    if [[ "$page" -gt 40 ]]; then
      # Safety valve, not a real limit: 40 pages * 250 = 10,000 open tickets
      # in one team is not a realistic dedup scan — treat a pathological
      # pageInfo loop as a query failure rather than spinning forever.
      log "ERROR ticket_already_exists: aborting after ${page} pages for team=${team_uuid} marker=${marker}"
      return 2
    fi

    local out rc
    if [[ -n "$after" ]]; then
      out="$(linearis issues list --team "$team_uuid" --limit 250 --after "$after" 2>&1 </dev/null)"
    else
      out="$(linearis issues list --team "$team_uuid" --limit 250 2>&1 </dev/null)"
    fi
    rc=$?
    if [[ "$rc" -ne 0 ]]; then
      log "ERROR ticket_already_exists: linearis issues list failed (exit=${rc}) team=${team_uuid}: ${out}"
      return 2
    fi
    if echo "$out" | jq -e 'has("error")' >/dev/null 2>&1; then
      log "ERROR ticket_already_exists: linearis issues list returned an error team=${team_uuid}: ${out}"
      return 2
    fi

    if echo "$out" | jq -r '.nodes[]?.description // empty' 2>/dev/null \
        | grep -qF "Escalation-marker: ${marker}"; then
      return 0
    fi

    local has_next next_cursor
    has_next="$(echo "$out" | jq -r '.pageInfo.hasNextPage // false' 2>/dev/null)"
    next_cursor="$(echo "$out" | jq -r '.pageInfo.endCursor // empty' 2>/dev/null)"
    if [[ "$has_next" != "true" || -z "$next_cursor" ]]; then
      return 1
    fi
    after="$next_cursor"
  done
}

file_ticket() {
  local team_key="$1" title="$2" body="$3" marker="$4"
  local team_uuid
  team_uuid="$(resolve_team_uuid "$team_key")"

  local exists_rc
  ticket_already_exists "$team_uuid" "$marker"
  exists_rc=$?
  if [[ "$exists_rc" -eq 0 ]]; then
    log "skip (already open): [$team_key] $title"
    return 0
  elif [[ "$exists_rc" -eq 2 ]]; then
    log "ERROR skip filing [$team_key] $title — dedup query failed, refusing to file blind (will retry next sweep)"
    SWEEP_HAD_ERRORS=1
    return 1
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "DRY-RUN would file: [$team_key] $title"
    return 0
  fi

  local result rc identifier
  result="$(linearis issues create "$title" --team "$team_uuid" --description "$body" 2>&1 </dev/null)"
  rc=$?
  identifier="$(echo "$result" | grep -o '"identifier": *"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"

  if [[ "$rc" -ne 0 || -z "$identifier" ]]; then
    # Codex P2: previously this branch only logged — the sweep continued and
    # printed "sweep done" as if nothing had failed. If a Linear/auth outage
    # outlasts LOOKBACK_HOURS, the underlying signal (failed run / labeled
    # PR) ages out of the next sweep's window and the escalation is lost for
    # good. Propagate the failure via SWEEP_HAD_ERRORS -> nonzero exit, so an
    # operator/alert actually sees the miss instead of a clean-looking log.
    log "ERROR filing [$team_key] $title (exit=${rc}): ${result}"
    SWEEP_HAD_ERRORS=1
    return 1
  fi

  # Defense against linearis#56 (issues create silently routing to the
  # workspace default team when given a key/name instead of a UUID): if we
  # couldn't resolve team_key to a UUID above, or even if we could, confirm
  # the filed ticket's identifier prefix actually matches the intended team.
  if ! [[ "$team_key" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
    local prefix="${identifier%%-*}"
    if [[ "$prefix" != "$team_key" ]]; then
      log "ERROR filed ${identifier} but its team prefix (${prefix}) does not match the intended team (${team_key}) — possible linearis#56 misroute: [$team_key] $title"
      SWEEP_HAD_ERRORS=1
      return 1
    fi
  fi

  log "filed: $identifier — [$team_key] $title"
}

# ─── Trigger 1: failed dependency-update workflow runs ─────────────────────
sweep_failed_updates() {
  local since_epoch
  since_epoch="$(date -u -v-"${LOOKBACK_HOURS}"H +%s 2>/dev/null || date -u -d "-${LOOKBACK_HOURS} hours" +%s)"

  for entry in "${REPO_TEAM_MAP[@]}"; do
    local repo="${entry%%:*}" team="${entry##*:}"
    local runs rc stderr_file
    stderr_file="$(mktemp -t dependabot-escalate-stderr.XXXXXX)"
    runs="$(gh run list --repo "$repo" --workflow "Dependabot Updates" --limit 20 \
      --json conclusion,createdAt,databaseId,url,headBranch 2>"$stderr_file")"
    rc=$?
    if [[ "$rc" -ne 0 ]]; then
      # Codex P2: previously stderr was discarded and an empty $runs from a
      # failed `gh run list` (expired auth, permissions, outage — gh's own
      # exit codes: 1=ordinary failure, 4=auth failure) was indistinguishable
      # from a legitimate "no runs" result, so a real failure just logged a
      # clean-looking sweep. If the outage outlasts LOOKBACK_HOURS the failed
      # run becomes permanently ineligible even after recovery.
      log "ERROR gh run list failed for ${repo} (exit=${rc}): $(cat "$stderr_file" 2>/dev/null)"
      rm -f "$stderr_file"
      SWEEP_HAD_ERRORS=1
      continue
    fi
    rm -f "$stderr_file"
    [[ -z "$runs" || "$runs" == "[]" ]] && continue

    # Codex P1: repos with more than one Dependabot update config (multiple
    # package-ecosystem/directory entries) get an INDEPENDENT "Dependabot
    # Updates" workflow_run per config. Checking only the repo-wide newest
    # run (.[0]) lets a passing config mask a still-failing sibling config —
    # once that failure ages past LOOKBACK_HOURS it can never be escalated.
    # Group by headBranch (each config's check runs against its own ref) and
    # evaluate the LATEST run within EACH group, not just the overall latest.
    local branches
    branches="$(echo "$runs" | jq -r '[.[].headBranch // "default"] | unique | .[]')"
    while IFS= read -r cfg_branch; do
      [[ -z "$cfg_branch" ]] && continue
      local latest_conclusion latest_created latest_url ts_epoch
      latest_conclusion="$(echo "$runs" | jq -r --arg b "$cfg_branch" \
        '[.[] | select((.headBranch // "default") == $b)] | sort_by(.createdAt) | last | .conclusion')"
      latest_created="$(echo "$runs" | jq -r --arg b "$cfg_branch" \
        '[.[] | select((.headBranch // "default") == $b)] | sort_by(.createdAt) | last | .createdAt')"
      latest_url="$(echo "$runs" | jq -r --arg b "$cfg_branch" \
        '[.[] | select((.headBranch // "default") == $b)] | sort_by(.createdAt) | last | .url')"
      [[ "$latest_conclusion" != "failure" ]] && continue

      ts_epoch="$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$latest_created" +%s 2>/dev/null \
        || date -u -d "$latest_created" +%s 2>/dev/null || echo 0)"
      [[ "$ts_epoch" -lt "$since_epoch" ]] && continue

      local marker="dependabot-update-failure:${repo}:${cfg_branch}"
      local title="${repo#*/}'s Dependabot update run should be fixed, not left silently failing"
      local body
      body="$(cat <<EOF
Context: routine dependabot-health sweep (2026-08-04 audit + ongoing dependabot-escalate.sh watcher).
Motivation: a failed "Dependabot Updates" run means Dependabot could not open a PR at all — usually a real, human-judgment dependency conflict (e.g. a security patch that would force-downgrade a peer dependency). Without this ticket the only signal is GitHub's own email notification / the Actions log.
Outcome: someone resolves the underlying conflict (bump the blocking peer dependency first, or add an npm/cargo/etc override pinning a safe version), then re-runs the Dependabot update.

Repo: ${repo}
Update config (headBranch): ${cfg_branch}
Run: ${latest_url}
First observed by this sweep: $(date -u +%Y-%m-%dT%H:%M:%SZ)

Escalation-marker: ${marker}
EOF
)"
      file_ticket "$team" "$title" "$body" "$marker"
    done <<< "$branches"
  done
}

# ─── Trigger 2: PRs already labeled major-update ────────────────────────────
sweep_major_update_prs() {
  for entry in "${REPO_TEAM_MAP[@]}"; do
    local repo="${entry%%:*}" team="${entry##*:}"
    local prs rc stderr_file
    stderr_file="$(mktemp -t dependabot-escalate-stderr.XXXXXX)"
    # Codex P2: default `gh pr list` limit is 30 — a repo with more than 30
    # open major-update PRs would silently drop the older ones off every
    # sweep forever. 500 is a generous ceiling for a single label/repo.
    prs="$(gh pr list --repo "$repo" --label "major-update" --state open --limit 500 \
      --json number,title,url,body 2>"$stderr_file")"
    rc=$?
    if [[ "$rc" -ne 0 ]]; then
      log "ERROR gh pr list failed for ${repo} (exit=${rc}): $(cat "$stderr_file" 2>/dev/null)"
      rm -f "$stderr_file"
      SWEEP_HAD_ERRORS=1
      continue
    fi
    rm -f "$stderr_file"
    [[ -z "$prs" || "$prs" == "[]" ]] && continue

    # Codex P1: a `... | while read; do ...; done` pipeline runs the loop
    # body in a SUBSHELL in bash, so any SWEEP_HAD_ERRORS=1 set inside it
    # would be silently discarded by the time the loop exits. Feed the loop
    # via process substitution instead, which keeps it in THIS shell.
    while IFS= read -r pr; do
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
    done < <(echo "$prs" | jq -c '.[]')
  done
}

log "=== dependabot-escalate sweep start (lookback=${LOOKBACK_HOURS}h dry-run=${DRY_RUN}) ==="
sweep_failed_updates
sweep_major_update_prs
if [[ "$SWEEP_HAD_ERRORS" -eq 1 ]]; then
  log "=== dependabot-escalate sweep done WITH ERRORS (see ERROR lines above) ==="
  exit 1
fi
log "=== dependabot-escalate sweep done ==="
