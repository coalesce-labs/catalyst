#!/usr/bin/env bash
# action-adr.sh — Resolve an ADR-drift decision via one of three sub-modes:
#   update : open the ADR file in $EDITOR; commit on save.
#   ticket : file a Linear ticket scoped to the drift.
#   defer  : append <!-- drift-noted: DATE: REASON --> to the ADR and commit.
#
# Usage:
#   action-adr.sh --mode update|ticket|defer --adr-file PATH [...]
#
# Mode-specific flags:
#   update : (none required; uses $EDITOR)
#   ticket : --team K  [--title T] [--description D] [--summary S] [--drift-status DS]
#   defer  : --reason R  [--date YYYY-MM-DD]
#
# Common optional: --adr-id ID  (defaults to frontmatter adr_id, else basename).
#
# Output (stdout, one JSON line):
#   update : {"adr_file":"...","adr_id":"...","commit_sha":"...","status":"updated"}
#   ticket : {"identifier":"CTL-1000","url":"...","adr_id":"...","status":"filed"}
#   defer  : {"adr_file":"...","adr_id":"...","commit_sha":"...","status":"deferred"}
# Soft-skip: {"status":"skipped","reason":"..."} (exit 0)
# Hard fail: {"status":"failed","reason":"..."}  (exit 1)
# Bad args : stderr message + exit 2

set -uo pipefail

MODE=""
ADR_FILE=""
ADR_ID=""
# ticket-mode
TEAM=""
TITLE=""
DESCRIPTION=""
SUMMARY=""
DRIFT_STATUS=""
# defer-mode
REASON=""
DATE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)         MODE="$2"; shift 2 ;;
    --adr-file)     ADR_FILE="$2"; shift 2 ;;
    --adr-id)       ADR_ID="$2"; shift 2 ;;
    --team)         TEAM="$2"; shift 2 ;;
    --title)        TITLE="$2"; shift 2 ;;
    --description)  DESCRIPTION="$2"; shift 2 ;;
    --summary)      SUMMARY="$2"; shift 2 ;;
    --drift-status) DRIFT_STATUS="$2"; shift 2 ;;
    --reason)       REASON="$2"; shift 2 ;;
    --date)         DATE="$2"; shift 2 ;;
    -h|--help)      sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "action-adr.sh: unknown flag $1" >&2; exit 2 ;;
  esac
done

case "$MODE" in
  update|ticket|defer) ;;
  "") echo "action-adr.sh: --mode is required (update|ticket|defer)" >&2; exit 2 ;;
  *)  echo "action-adr.sh: --mode must be update|ticket|defer (got: $MODE)" >&2; exit 2 ;;
esac

if [[ -z "$ADR_FILE" ]]; then
  echo "action-adr.sh: --adr-file is required" >&2
  exit 2
fi

if [[ ! -f "$ADR_FILE" ]]; then
  jq -nc --arg reason "adr-file not found: $ADR_FILE" \
    '{status: "skipped", reason: $reason}'
  exit 0
fi

# Derive ADR_ID from frontmatter `adr_id:` scalar; fall back to basename.
if [[ -z "$ADR_ID" ]]; then
  ADR_ID=$(grep -m1 '^adr_id:' "$ADR_FILE" 2>/dev/null \
    | sed -E 's/^adr_id:[[:space:]]*//; s/^"//; s/"$//; s/^'\''//; s/'\''$//')
  [[ -z "$ADR_ID" ]] && ADR_ID="$(basename "$ADR_FILE" .md)"
fi

# Resolve the git repo root containing the ADR. Empty when the file isn't in a repo.
adr_dir() { cd "$(dirname "$ADR_FILE")" && pwd; }
REPO_TOP=$(git -C "$(adr_dir)" rev-parse --show-toplevel 2>/dev/null || echo "")

case "$MODE" in

  update)
    if [[ -z "${EDITOR:-}" ]]; then
      jq -nc --arg reason "EDITOR not set" \
        '{status: "skipped", reason: $reason}'
      exit 0
    fi

    if [[ -z "$REPO_TOP" ]]; then
      jq -nc --arg reason "adr-file not in a git repo: $ADR_FILE" \
        '{status: "skipped", reason: $reason}'
      exit 0
    fi

    PRE_HASH=$(git -C "$REPO_TOP" hash-object "$ADR_FILE" 2>/dev/null || echo "")

    # Invoke editor. Word-split $EDITOR so compound values like "code --wait"
    # work the same way git does for GIT_EDITOR. $ADR_FILE is intentionally
    # quoted so paths with shell metacharacters never get re-interpreted.
    # shellcheck disable=SC2086
    $EDITOR "$ADR_FILE"

    POST_HASH=$(git -C "$REPO_TOP" hash-object "$ADR_FILE" 2>/dev/null || echo "")

    if [[ -z "$POST_HASH" || "$PRE_HASH" == "$POST_HASH" ]]; then
      jq -nc --arg reason "no changes saved by editor" \
        '{status: "skipped", reason: $reason}'
      exit 0
    fi

    if ! git -C "$REPO_TOP" add -- "$ADR_FILE" >/dev/null 2>&1; then
      jq -nc --arg reason "git add failed" \
        '{status: "failed", reason: $reason}'
      exit 1
    fi

    STDERR_FILE=$(mktemp -t action-adr-update-stderr.XXXXXX)
    if ! git -C "$REPO_TOP" commit -q \
           -m "docs(adr): resolve drift in $ADR_ID" \
           -- "$ADR_FILE" 2>"$STDERR_FILE"; then
      STDERR_TAIL=$(tail -c 500 "$STDERR_FILE" 2>/dev/null || echo "")
      rm -f "$STDERR_FILE"
      REASON_MSG="git commit failed"
      [[ -n "$STDERR_TAIL" ]] && REASON_MSG="${REASON_MSG}: ${STDERR_TAIL}"
      jq -nc --arg reason "$REASON_MSG" '{status: "failed", reason: $reason}'
      exit 1
    fi
    rm -f "$STDERR_FILE"

    COMMIT_SHA=$(git -C "$REPO_TOP" rev-parse HEAD)
    jq -nc \
      --arg adr_file "$ADR_FILE" \
      --arg adr_id "$ADR_ID" \
      --arg sha "$COMMIT_SHA" \
      '{adr_file: $adr_file, adr_id: $adr_id, commit_sha: $sha, status: "updated"}'
    ;;

  ticket)
    if [[ -z "$TEAM" ]]; then
      echo "action-adr.sh: --team is required for ticket mode" >&2
      exit 2
    fi

    if ! command -v linearis >/dev/null 2>&1; then
      jq -nc --arg reason "linearis not on PATH" \
        '{status: "skipped", reason: $reason}'
      exit 0
    fi

    # Compose defaults from any provided context. The title surfaces the ADR id;
    # the body links the drift to the ADR file path so a reviewer can find both.
    if [[ -z "$TITLE" ]]; then
      if [[ -n "$SUMMARY" ]]; then
        TITLE="Resolve drift from ${ADR_ID}: ${SUMMARY}"
      else
        TITLE="Resolve drift from ${ADR_ID}"
      fi
    fi
    if [[ -z "$DESCRIPTION" ]]; then
      DESCRIPTION="Code drift detected against ${ADR_ID}."$'\n\n'
      DESCRIPTION+="ADR file: ${ADR_FILE}"$'\n'
      DESCRIPTION+="ADR id: ${ADR_ID}"$'\n'
      [[ -n "$DRIFT_STATUS" ]] && DESCRIPTION+="Drift status: ${DRIFT_STATUS}"$'\n'
      [[ -n "$SUMMARY"      ]] && DESCRIPTION+="Summary: ${SUMMARY}"$'\n'
      DESCRIPTION+=$'\n'"This ticket tracks the code work required to bring the implementation back in line with the ADR."
    fi

    # linearis upstream bug czottmann/linearis#56: --team must be a UUID, not a
    # key/name. Resolve key→UUID up front (mirrors action-ticket.sh).
    RESOLVED_TEAM="$TEAM"
    if ! [[ "$TEAM" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
      TEAMS_JSON=$(linearis teams list 2>/dev/null || true)
      CANDIDATE=$(echo "$TEAMS_JSON" \
        | jq -r --arg k "$TEAM" \
            '.[]? | select(.key == $k or .name == $k) | .id' 2>/dev/null \
        | head -n1)
      if [[ -n "$CANDIDATE" ]]; then
        RESOLVED_TEAM="$CANDIDATE"
      fi
    fi

    ARGS=( issues create "$TITLE" --team "$RESOLVED_TEAM" --description "$DESCRIPTION" )

    STDERR_FILE=$(mktemp -t action-adr-ticket-stderr.XXXXXX)
    CREATE_JSON=$(linearis "${ARGS[@]}" 2>"$STDERR_FILE")
    EXIT_CODE=$?
    STDERR_TAIL=$(tail -c 500 "$STDERR_FILE" 2>/dev/null || echo "")
    rm -f "$STDERR_FILE"

    IDENT=$(echo "$CREATE_JSON" | jq -r '.identifier // empty' 2>/dev/null || echo "")
    URL=$(echo "$CREATE_JSON" | jq -r '.url // empty' 2>/dev/null || echo "")

    if [[ -z "$IDENT" ]]; then
      REASON_MSG="linearis issues create returned no identifier (exit=$EXIT_CODE)"
      [[ -n "$STDERR_TAIL" ]] && REASON_MSG="${REASON_MSG}: ${STDERR_TAIL}"
      jq -nc --arg reason "$REASON_MSG" '{status: "failed", reason: $reason}'
      exit 1
    fi

    jq -nc \
      --arg id "$IDENT" \
      --arg url "$URL" \
      --arg adr_id "$ADR_ID" \
      '{identifier: $id, url: $url, adr_id: $adr_id, status: "filed"}'
    ;;

  defer)
    if [[ -z "$REASON" ]]; then
      echo "action-adr.sh: --reason is required for defer mode" >&2
      exit 2
    fi
    [[ -z "$DATE" ]] && DATE=$(date -u +%Y-%m-%d)

    if [[ -z "$REPO_TOP" ]]; then
      jq -nc --arg reason "adr-file not in a git repo: $ADR_FILE" \
        '{status: "skipped", reason: $reason}'
      exit 0
    fi

    # Ensure file ends with a newline so the appended comment isn't merged onto
    # the last existing line.
    if [[ -n "$(tail -c1 "$ADR_FILE" 2>/dev/null)" ]]; then
      printf '\n' >> "$ADR_FILE"
    fi
    printf '<!-- drift-noted: %s: %s -->\n' "$DATE" "$REASON" >> "$ADR_FILE"

    if ! git -C "$REPO_TOP" add -- "$ADR_FILE" >/dev/null 2>&1; then
      jq -nc --arg reason "git add failed" \
        '{status: "failed", reason: $reason}'
      exit 1
    fi

    STDERR_FILE=$(mktemp -t action-adr-defer-stderr.XXXXXX)
    if ! git -C "$REPO_TOP" commit -q \
           -m "docs(adr): defer drift on $ADR_ID" \
           -- "$ADR_FILE" 2>"$STDERR_FILE"; then
      STDERR_TAIL=$(tail -c 500 "$STDERR_FILE" 2>/dev/null || echo "")
      rm -f "$STDERR_FILE"
      REASON_MSG="git commit failed"
      [[ -n "$STDERR_TAIL" ]] && REASON_MSG="${REASON_MSG}: ${STDERR_TAIL}"
      jq -nc --arg reason "$REASON_MSG" '{status: "failed", reason: $reason}'
      exit 1
    fi
    rm -f "$STDERR_FILE"

    COMMIT_SHA=$(git -C "$REPO_TOP" rev-parse HEAD)
    jq -nc \
      --arg adr_file "$ADR_FILE" \
      --arg adr_id "$ADR_ID" \
      --arg sha "$COMMIT_SHA" \
      '{adr_file: $adr_file, adr_id: $adr_id, commit_sha: $sha, status: "deferred"}'
    ;;
esac
