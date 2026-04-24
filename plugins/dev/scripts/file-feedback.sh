#!/usr/bin/env bash
# file-feedback - Route an auto-filed improvement ticket to Linear first, fall
# back to GitHub on failure. Reads `.catalyst/config.json` for the consent
# flag, github repo, and label list. Applies `auto-submitted` + the caller's
# skill name as labels on both destinations. CTL-183.
#
# Usage:
#   file-feedback.sh --title <T> --body <B> --skill <S>
#                    [--labels <csv>] [--config <path>]
#                    [--ensure-consent] [--json] [--dry-run]
#
#   --title <T>         Ticket title (required)
#   --body <B>          Ticket body / description (required)
#   --skill <S>         Invoking skill name, added as a label (required)
#   --labels <csv>      Extra labels, comma-separated
#   --config <path>     Path to .catalyst/config.json (default: auto-discover)
#   --ensure-consent    Exit 3 with consent-required instead of 2 skipped when
#                       autoFile is unset. Caller is expected to prompt and
#                       call feedback-consent.sh grant, then retry.
#   --json              Always emit JSON (default: JSON for non-TTY, human-
#                       readable otherwise)
#   --dry-run           Compose the payload + destination, don't call any CLI
#
# Exit codes:
#   0  filed successfully
#   1  hard failure (no destinations available, or both CLI calls errored)
#   2  skipped — consent not granted (no --ensure-consent)
#   3  consent-required — only when --ensure-consent is set
#  64  usage error

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONSENT_SCRIPT="${SCRIPT_DIR}/feedback-consent.sh"

TITLE=""
BODY=""
SKILL=""
EXTRA_LABELS=""
CONFIG=""
ENSURE_CONSENT=0
JSON_OUT=""
DRY_RUN=0

usage() {
  sed -n '2,29p' "$0" >&2
  exit "${1:-64}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --title)           TITLE="$2"; shift 2 ;;
    --body)            BODY="$2"; shift 2 ;;
    --skill)           SKILL="$2"; shift 2 ;;
    --labels)          EXTRA_LABELS="$2"; shift 2 ;;
    --config)          CONFIG="$2"; shift 2 ;;
    --ensure-consent)  ENSURE_CONSENT=1; shift ;;
    --json)            JSON_OUT=1; shift ;;
    --dry-run)         DRY_RUN=1; shift ;;
    -h|--help)         usage 0 ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done

[ -z "$TITLE" ] && { echo "ERROR: --title required" >&2; exit 64; }
[ -z "$BODY" ]  && { echo "ERROR: --body required" >&2; exit 64; }
[ -z "$SKILL" ] && { echo "ERROR: --skill required" >&2; exit 64; }

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required for file-feedback" >&2
  exit 1
fi

# Default JSON output to on for non-TTY, off for TTY.
if [ -z "$JSON_OUT" ]; then
  if [ -t 1 ]; then JSON_OUT=0; else JSON_OUT=1; fi
fi

# ─── Resolve config ────────────────────────────────────────────────────────
resolve_config() {
  if [ -n "$CONFIG" ] && [ -f "$CONFIG" ]; then
    echo "$CONFIG"; return 0
  fi
  local dir
  dir="$(pwd)"
  while [ "$dir" != "/" ]; do
    if [ -f "${dir}/.catalyst/config.json" ]; then
      echo "${dir}/.catalyst/config.json"; return 0
    fi
    dir="$(dirname "$dir")"
  done
  echo ""
}

CONFIG_PATH="$(resolve_config)"

# ─── Read config values ────────────────────────────────────────────────────
AUTO_FILE=""
GITHUB_REPO=""
CONFIG_LABELS=""
TEAM_KEY=""

if [ -n "$CONFIG_PATH" ] && [ -f "$CONFIG_PATH" ]; then
  AUTO_FILE=$(jq -r '.catalyst.feedback.autoFile // empty' "$CONFIG_PATH" 2>/dev/null)
  GITHUB_REPO=$(jq -r '.catalyst.feedback.githubRepo // empty' "$CONFIG_PATH" 2>/dev/null)
  CONFIG_LABELS=$(jq -r '.catalyst.feedback.labels // ["auto-submitted"] | join(",")' \
    "$CONFIG_PATH" 2>/dev/null)
  TEAM_KEY=$(jq -r '.catalyst.linear.teamKey // empty' "$CONFIG_PATH" 2>/dev/null)
fi

# Defaults when config is silent.
[ -z "$GITHUB_REPO" ]   && GITHUB_REPO="coalesce-labs/catalyst"
[ -z "$CONFIG_LABELS" ] && CONFIG_LABELS="auto-submitted"

# ─── Emit helper ───────────────────────────────────────────────────────────
emit() {
  local status="$1" destination="$2" identifier="$3" number="$4" url="$5" err="$6"
  local labels_json
  labels_json=$(printf '%s' "$LABELS_CSV" | jq -Rc 'split(",")' 2>/dev/null || echo "[]")

  if [ "$JSON_OUT" -eq 1 ]; then
    jq -nc \
      --arg status "$status" \
      --arg destination "$destination" \
      --arg identifier "$identifier" \
      --arg number "$number" \
      --arg url "$url" \
      --arg err "$err" \
      --argjson labels "$labels_json" \
      '{
        status: $status,
        destination: (if $destination == "" then null else $destination end),
        identifier: (if $identifier == "" then null else $identifier end),
        number: (if $number == "" then null else ($number | tonumber?) end),
        url: (if $url == "" then null else $url end),
        labels: $labels,
        error: (if $err == "" then null else $err end)
      }'
  else
    printf '%s' "$status"
    [ -n "$destination" ] && printf ' → %s' "$destination"
    [ -n "$identifier" ]  && printf ' (%s)' "$identifier"
    [ -n "$number" ]      && printf ' (#%s)' "$number"
    [ -n "$url" ]         && printf ' %s' "$url"
    [ -n "$err" ]         && printf ' — %s' "$err"
    printf '\n'
  fi
}

# ─── Compose label set ─────────────────────────────────────────────────────
# Merge config labels + --labels arg + skill name, deduplicated, CSV.
join_labels() {
  local parts=""
  [ -n "$CONFIG_LABELS" ] && parts="${parts}${CONFIG_LABELS},"
  [ -n "$EXTRA_LABELS" ]  && parts="${parts}${EXTRA_LABELS},"
  [ -n "$SKILL" ]         && parts="${parts}${SKILL}"
  # Deduplicate while preserving order. awk handles CSV splits cleanly.
  printf '%s' "$parts" | awk -v RS=',' '!seen[$0]++ && NF' | paste -sd, -
}

LABELS_CSV="$(join_labels)"

# ─── Consent gate ──────────────────────────────────────────────────────────
if [ "$AUTO_FILE" != "true" ]; then
  if [ "$ENSURE_CONSENT" -eq 1 ]; then
    emit "consent-required" "" "" "" "" ""
    exit 3
  fi
  emit "skipped-no-consent" "" "" "" "" ""
  exit 2
fi

# ─── Dry run ───────────────────────────────────────────────────────────────
if [ "$DRY_RUN" -eq 1 ]; then
  # Pick the best guess destination for dry-run output.
  if command -v linearis >/dev/null 2>&1; then
    emit "dry-run" "linear" "" "" "" "would file to team=${TEAM_KEY:-?}"
  elif command -v gh >/dev/null 2>&1; then
    emit "dry-run" "github" "" "" "" "would file to repo=${GITHUB_REPO}"
  else
    emit "dry-run" "" "" "" "" "no CLI available"
  fi
  exit 0
fi

# ─── Try Linear first ──────────────────────────────────────────────────────
try_linearis() {
  if ! command -v linearis >/dev/null 2>&1; then
    return 1
  fi
  if [ -z "$TEAM_KEY" ]; then
    return 1
  fi

  local create_json identifier linear_url
  create_json=$(linearis issues create "$TITLE" \
    --team "$TEAM_KEY" \
    --description "$BODY" \
    --output json 2>/dev/null || echo "")
  identifier=$(echo "$create_json" | jq -r '.identifier // empty' 2>/dev/null)
  linear_url=$(echo "$create_json" | jq -r '.url // empty' 2>/dev/null)

  if [ -z "$identifier" ]; then
    return 1
  fi

  # Apply labels via a follow-up update. Label failures are non-fatal.
  if [ -n "$LABELS_CSV" ]; then
    linearis issues update "$identifier" \
      --labels "$LABELS_CSV" --label-mode add >/dev/null 2>&1 || true
  fi

  # Fetch URL if the create response didn't include one.
  if [ -z "$linear_url" ]; then
    linear_url=$(linearis issues read "$identifier" --output json 2>/dev/null \
      | jq -r '.url // empty' 2>/dev/null || echo "")
  fi

  emit "filed" "linear" "$identifier" "" "$linear_url" ""
  return 0
}

if try_linearis; then
  exit 0
fi

# ─── Fall back to GitHub ───────────────────────────────────────────────────
try_gh() {
  if ! command -v gh >/dev/null 2>&1; then
    return 1
  fi

  # Build the --label args as separate flags so commas in label names never
  # collide with gh's CSV parsing.
  local -a label_args=()
  local IFS=','
  for L in $LABELS_CSV; do
    [ -n "$L" ] && label_args+=(--label "$L")
  done
  unset IFS

  local gh_out gh_err issue_url issue_number
  gh_err=$(mktemp)
  gh_out=$(gh issue create \
    --repo "$GITHUB_REPO" \
    --title "$TITLE" \
    --body "$BODY" \
    "${label_args[@]}" 2>"$gh_err")
  local rc=$?

  if [ $rc -ne 0 ]; then
    local err_msg
    err_msg=$(tr '\n' ' ' < "$gh_err" | head -c 200)
    rm -f "$gh_err"
    emit "failed" "" "" "" "" "gh issue create failed: ${err_msg}"
    return 2
  fi
  rm -f "$gh_err"

  # gh issue create emits the issue URL on its last line.
  issue_url=$(printf '%s' "$gh_out" | tail -n1 | tr -d '[:space:]')
  issue_number=$(printf '%s' "$issue_url" | sed -n 's:.*/issues/\([0-9][0-9]*\).*:\1:p')

  emit "filed" "github" "" "$issue_number" "$issue_url" ""
  return 0
}

GH_RESULT=0
try_gh || GH_RESULT=$?

if [ $GH_RESULT -eq 0 ]; then
  exit 0
elif [ $GH_RESULT -eq 2 ]; then
  # emit was already called with the error message
  exit 1
fi

# Neither CLI worked.
emit "failed-no-destinations" "" "" "" "" "neither linearis nor gh could file this ticket"
exit 1
