#!/usr/bin/env bash
# action-compound.sh — Resolve a pending compound-engineering ADR proposal that
# the ticket-compound curator queued at thoughts/shared/compound/pending/<TICKET>.md.
# This is the ONLY writer of docs/adrs.md in the whole system (ADR changes are
# APPROVE-gated; the curator only ever proposes).
#
# Sub-modes:
#   apply  : read the proposal (target ADR new|amend|supersede + proposed text),
#            write that change into docs/adrs.md, git-commit it, then remove the
#            pending proposal file (git history preserves it).
#   edit   : open the proposal in $EDITOR for a tweak, then apply (above).
#   defer  : leave the proposal pending; annotate it with a defer note + date.
#   reject : remove the pending proposal (git history preserves it); record reason.
#
# Usage:
#   action-compound.sh --mode apply|edit|defer|reject --pending PATH [...]
#
# Mode-specific flags:
#   apply  : [--adrs-file PATH]  (defaults to <repo>/docs/adrs.md)
#   edit   : [--adrs-file PATH]  (uses $EDITOR on the proposal, then applies)
#   defer  : --reason R  [--date YYYY-MM-DD]
#   reject : --reason R  [--date YYYY-MM-DD]
#
# Common optional: --ticket ID  (defaults to the pending file basename).
#
# Proposal file contract (what ticket-compound Step 6 writes):
#   ---
#   ticket: CTL-619
#   target: amend            # new | amend | supersede
#   adr_id: ADR-017          # required for amend/supersede; ignored for new
#   rationale: one-line why + evidence (learning path)
#   ---
#   ## Proposed text
#   <the exact ADR markdown to insert (new) or to replace the section with (amend/supersede)>
#
# Output (stdout, one JSON line):
#   apply  : {"adrs_file":"...","adr_id":"...","target":"...","commit_sha":"...","status":"applied"}
#   defer  : {"pending":"...","ticket":"...","status":"deferred"}
#   reject : {"pending":"...","ticket":"...","reason":"...","status":"rejected"}
# Soft-skip: {"status":"skipped","reason":"..."} (exit 0)
# Hard fail: {"status":"failed","reason":"..."}  (exit 1)
# Bad args : stderr message + exit 2

set -uo pipefail

MODE=""
PENDING=""
TICKET=""
ADRS_FILE=""
REASON=""
DATE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)       MODE="$2"; shift 2 ;;
    --pending)    PENDING="$2"; shift 2 ;;
    --ticket)     TICKET="$2"; shift 2 ;;
    --adrs-file)  ADRS_FILE="$2"; shift 2 ;;
    --reason)     REASON="$2"; shift 2 ;;
    --date)       DATE="$2"; shift 2 ;;
    -h|--help)    sed -n '2,42p' "$0"; exit 0 ;;
    *) echo "action-compound.sh: unknown flag $1" >&2; exit 2 ;;
  esac
done

case "$MODE" in
  apply|edit|defer|reject) ;;
  "") echo "action-compound.sh: --mode is required (apply|edit|defer|reject)" >&2; exit 2 ;;
  *)  echo "action-compound.sh: --mode must be apply|edit|defer|reject (got: $MODE)" >&2; exit 2 ;;
esac

if [[ -z "$PENDING" ]]; then
  echo "action-compound.sh: --pending is required" >&2
  exit 2
fi

if [[ ! -f "$PENDING" ]]; then
  jq -nc --arg reason "pending proposal not found: $PENDING" \
    '{status: "skipped", reason: $reason}'
  exit 0
fi

# Derive TICKET from the proposal frontmatter `ticket:`, else the basename.
if [[ -z "$TICKET" ]]; then
  TICKET=$(grep -m1 '^ticket:' "$PENDING" 2>/dev/null \
    | sed -E 's/^ticket:[[:space:]]*//; s/^"//; s/"$//; s/^'\''//; s/'\''$//')
  [[ -z "$TICKET" ]] && TICKET="$(basename "$PENDING" .md)"
fi

# Resolve the git repo root containing the proposal. Empty when not in a repo.
pending_dir() { cd "$(dirname "$PENDING")" && pwd; }
REPO_TOP=$(git -C "$(pending_dir)" rev-parse --show-toplevel 2>/dev/null || echo "")

# ── Proposal parsers (shared by apply/edit) ────────────────────────────────
# Read a scalar frontmatter field from the first --- ... --- block.
proposal_field() {
  local field="$1"
  awk -v key="$field" '
    /^---[[:space:]]*$/ { blk++; if (blk == 2) exit; next }
    blk == 1 {
      if ($0 ~ "^" key ":[[:space:]]*") {
        sub("^" key ":[[:space:]]*", "")
        gsub(/^"|"$|^'\''|'\''$/, "")
        print
        exit
      }
    }
  ' "$PENDING"
}

# Print the proposed ADR body — everything after the `## Proposed text` heading.
proposal_text() {
  awk '
    found { print; next }
    /^##[[:space:]]+Proposed text[[:space:]]*$/ { found = 1 }
  ' "$PENDING" | sed '1{/^$/d;}'
}

# ── apply path (shared by apply + edit-then-apply) ─────────────────────────
do_apply() {
  if [[ -z "$REPO_TOP" ]]; then
    jq -nc --arg reason "proposal not in a git repo: $PENDING" \
      '{status: "skipped", reason: $reason}'
    exit 0
  fi

  [[ -z "$ADRS_FILE" ]] && ADRS_FILE="$REPO_TOP/docs/adrs.md"
  if [[ ! -f "$ADRS_FILE" ]]; then
    jq -nc --arg reason "adrs file not found: $ADRS_FILE" \
      '{status: "skipped", reason: $reason}'
    exit 0
  fi

  local target adr_id text
  target=$(proposal_field "target")
  adr_id=$(proposal_field "adr_id")
  text=$(proposal_text)

  case "$target" in
    new|amend|supersede) ;;
    "") jq -nc --arg reason "proposal missing target: (new|amend|supersede) in $PENDING" \
          '{status: "failed", reason: $reason}'; exit 1 ;;
    *)  jq -nc --arg reason "proposal target must be new|amend|supersede (got: $target)" \
          '{status: "failed", reason: $reason}'; exit 1 ;;
  esac

  if [[ -z "$text" ]]; then
    jq -nc --arg reason "proposal has no '## Proposed text' body in $PENDING" \
      '{status: "failed", reason: $reason}'
    exit 1
  fi

  if [[ "$target" == "amend" || "$target" == "supersede" ]]; then
    if [[ -z "$adr_id" ]]; then
      jq -nc --arg reason "proposal target=$target requires adr_id in $PENDING" \
        '{status: "failed", reason: $reason}'
      exit 1
    fi
    if ! grep -qE "^##[[:space:]]+${adr_id}:" "$ADRS_FILE"; then
      jq -nc --arg reason "adr_id $adr_id not found as a '## $adr_id:' section in $ADRS_FILE" \
        '{status: "failed", reason: $reason}'
      exit 1
    fi
  fi

  local tmp_text
  tmp_text=$(mktemp -t action-compound-text.XXXXXX)
  printf '%s\n' "$text" > "$tmp_text"

  if [[ "$target" == "new" ]]; then
    # Append the new ADR section to the end of the file, separated by a rule.
    if [[ -n "$(tail -c1 "$ADRS_FILE" 2>/dev/null)" ]]; then
      printf '\n' >> "$ADRS_FILE"
    fi
    {
      printf '\n---\n\n'
      cat "$tmp_text"
      printf '\n'
    } >> "$ADRS_FILE"
  else
    # amend / supersede: replace the existing `## <adr_id>: ...` section in
    # place. The section runs from its `## <adr_id>:` heading up to (but not
    # including) the next `## ` heading or EOF. awk emits everything outside the
    # section verbatim and splices the proposed text in where the section was.
    local tmp_out
    tmp_out=$(mktemp -t action-compound-adrs.XXXXXX)
    if ! awk -v id="$adr_id" -v textfile="$tmp_text" '
      BEGIN { insec = 0 }
      /^##[[:space:]]/ {
        if ($0 ~ "^##[[:space:]]+" id ":") {
          insec = 1
          while ((getline line < textfile) > 0) print line
          close(textfile)
          next
        } else if (insec) {
          insec = 0
        }
      }
      insec { next }
      { print }
    ' "$ADRS_FILE" > "$tmp_out"; then
      rm -f "$tmp_text" "$tmp_out"
      jq -nc --arg reason "failed to splice $adr_id in $ADRS_FILE" \
        '{status: "failed", reason: $reason}'
      exit 1
    fi
    mv "$tmp_out" "$ADRS_FILE"
  fi
  rm -f "$tmp_text"

  # Only docs/adrs.md is a tracked, committable path. The pending proposal lives
  # under thoughts/ (humanlayer-synced, never committed to the code repo), so we
  # remove it from disk after the ADR commit rather than staging it in git.
  if ! git -C "$REPO_TOP" add -- "$ADRS_FILE" >/dev/null 2>&1; then
    jq -nc --arg reason "git add failed" \
      '{status: "failed", reason: $reason}'
    exit 1
  fi

  local subject
  if [[ "$target" == "new" ]]; then
    subject="docs(adr): add ADR from ${TICKET} compound proposal"
  else
    subject="docs(adr): ${target} ${adr_id} from ${TICKET} compound proposal"
  fi
  local stderr_file
  stderr_file=$(mktemp -t action-compound-apply-stderr.XXXXXX)
  if ! git -C "$REPO_TOP" commit -q \
         -m "$subject" \
         -- "$ADRS_FILE" 2>"$stderr_file"; then
    local stderr_tail
    stderr_tail=$(tail -c 500 "$stderr_file" 2>/dev/null || echo "")
    rm -f "$stderr_file"
    local reason_msg="git commit failed"
    [[ -n "$stderr_tail" ]] && reason_msg="${reason_msg}: ${stderr_tail}"
    jq -nc --arg reason "$reason_msg" '{status: "failed", reason: $reason}'
    exit 1
  fi
  rm -f "$stderr_file"

  # The proposal is now resolved — remove it from the pending queue. It lives in
  # the humanlayer-synced thoughts/ store (its own git history preserves it), so
  # this is a plain filesystem removal, not a code-repo commit.
  rm -f "$PENDING"

  local commit_sha
  commit_sha=$(git -C "$REPO_TOP" rev-parse HEAD)
  jq -nc \
    --arg adrs_file "$ADRS_FILE" \
    --arg adr_id "$adr_id" \
    --arg target "$target" \
    --arg sha "$commit_sha" \
    '{adrs_file: $adrs_file, adr_id: $adr_id, target: $target, commit_sha: $sha, status: "applied"}'
}

case "$MODE" in

  apply)
    do_apply
    ;;

  edit)
    if [[ -z "${EDITOR:-}" ]]; then
      jq -nc --arg reason "EDITOR not set" \
        '{status: "skipped", reason: $reason}'
      exit 0
    fi
    # Open the proposal for a tweak. Word-split $EDITOR so compound values like
    # "code --wait" work the way git does; $PENDING stays quoted so paths with
    # shell metacharacters are never re-interpreted.
    # shellcheck disable=SC2086
    $EDITOR "$PENDING"
    if [[ ! -f "$PENDING" ]]; then
      jq -nc --arg reason "proposal removed during edit: $PENDING" \
        '{status: "skipped", reason: $reason}'
      exit 0
    fi
    do_apply
    ;;

  defer)
    if [[ -z "$REASON" ]]; then
      echo "action-compound.sh: --reason is required for defer mode" >&2
      exit 2
    fi
    [[ -z "$DATE" ]] && DATE=$(date -u +%Y-%m-%d)

    # Ensure the file ends with a newline so the appended note isn't merged onto
    # the last existing line. Leave the proposal pending (no removal).
    if [[ -n "$(tail -c1 "$PENDING" 2>/dev/null)" ]]; then
      printf '\n' >> "$PENDING"
    fi
    printf '<!-- compound-deferred: %s: %s -->\n' "$DATE" "$REASON" >> "$PENDING"

    jq -nc \
      --arg pending "$PENDING" \
      --arg ticket "$TICKET" \
      '{pending: $pending, ticket: $ticket, status: "deferred"}'
    ;;

  reject)
    if [[ -z "$REASON" ]]; then
      echo "action-compound.sh: --reason is required for reject mode" >&2
      exit 2
    fi
    [[ -z "$DATE" ]] && DATE=$(date -u +%Y-%m-%d)

    # The proposal lives under thoughts/ (humanlayer-synced, never committed to
    # the code repo) — its own git history preserves the rejected text. Record
    # the reason inline (so the thoughts-store diff captures why), then remove it
    # from the pending queue so it stops surfacing in the morning briefing.
    if [[ -n "$(tail -c1 "$PENDING" 2>/dev/null)" ]]; then
      printf '\n' >> "$PENDING"
    fi
    printf '<!-- compound-rejected: %s: %s -->\n' "$DATE" "$REASON" >> "$PENDING"

    if ! rm -f "$PENDING"; then
      jq -nc --arg reason "failed to remove pending proposal: $PENDING" \
        '{status: "failed", reason: $reason}'
      exit 1
    fi

    jq -nc \
      --arg pending "$PENDING" \
      --arg ticket "$TICKET" \
      --arg reason "$REASON" \
      '{pending: $pending, ticket: $ticket, reason: $reason, status: "rejected"}'
    ;;
esac
