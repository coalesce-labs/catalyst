---
name: phase-pr
description: |
  Phase-agent wrapper that opens the pull request after implementation
  completes (CTL-449 Initiative 1 Phase 3). Delegates to
  `/catalyst-dev:create-pr` (which already auto-runs `describe-pr` and
  transitions Linear to `inReview`), then writes the PR number + URL into the
  phase signal file so the downstream `phase-monitor-merge` agent can read it
  without re-querying GitHub. Dispatched as a `claude --bg` job by
  `phase-agent-dispatch`, which invokes it via slash command — hence
  `user-invocable: true`.
user-invocable: true
disable-model-invocation: false # invocable by model (Skill tool) AND user (slash command)
allowed-tools:
  - Bash
  - Read
  - Task
---

# phase-pr

Thin wrapper around `/catalyst-dev:create-pr`. The canonical skill already handles: commit, push,
base-branch detection, PR creation, `describe-pr` auto-invocation, workflow-context tracking, Linear
`inReview` transition, and the post-PR resolution loop. Phase-pr adds only the phase-agent envelope
plus persisting `pr.number` + `pr.url` to the signal file for `phase-monitor-merge`.

## Prerequisites

- `CATALYST_ORCHESTRATOR_DIR`, `CATALYST_ORCHESTRATOR_ID`, `CATALYST_PHASE=pr`, `CATALYST_TICKET`
  set by [[phase-agent-dispatch]].
- The prior phase's signal file `${ORCH_DIR}/workers/<TICKET>/phase-review.json` exists with
  `status=done` — the dispatcher validates this; this skill assumes it.
- Current working directory is the ticket's worktree on the implementation branch (not main).

## Prelude

```bash
set -euo pipefail

: "${CATALYST_ORCHESTRATOR_DIR:?required}"
: "${CATALYST_ORCHESTRATOR_ID:?required}"
: "${CATALYST_PHASE:?required}"
: "${CATALYST_TICKET:?required}"

ORCH_DIR="$CATALYST_ORCHESTRATOR_DIR"
ORCH_ID="$CATALYST_ORCHESTRATOR_ID"
PHASE="$CATALYST_PHASE"
TICKET="$CATALYST_TICKET"
CHANNEL="${ORCH_ID}"

SIGNAL_FILE="${ORCH_DIR}/workers/${TICKET}/phase-${PHASE}.json"
[[ -f "$SIGNAL_FILE" ]] || { echo "phase-${PHASE}: signal file missing" >&2; exit 1; }

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
[[ -n "$PLUGIN_ROOT" ]] || PLUGIN_ROOT="$(dirname "$(dirname "$(dirname "$(realpath "${BASH_SOURCE[0]:-$0}" 2>/dev/null || echo .)")")")"

COMMS="${PLUGIN_ROOT}/scripts/catalyst-comms"
[[ -x "$COMMS" ]] || COMMS="$(command -v catalyst-comms 2>/dev/null || true)"
if [[ -n "$COMMS" && -x "$COMMS" ]]; then
  "$COMMS" join "$CHANNEL" --as "$TICKET" \
    --capabilities "phase-pr: ${TICKET}" \
    --orch "$ORCH_ID" --parent orchestrator --ttl 3600 >/dev/null 2>&1 || true
  "$COMMS" send "$CHANNEL" "phase-pr started" --as "$TICKET" --type info \
    --orch "$ORCH_ID" >/dev/null 2>&1 || true
fi

SESSION_SCRIPT="${PLUGIN_ROOT}/scripts/catalyst-session.sh"
if [[ -x "$SESSION_SCRIPT" ]]; then
  CATALYST_SESSION_ID=$("$SESSION_SCRIPT" start \
    --skill "phase-pr" --ticket "$TICKET" \
    --workflow "${CATALYST_SESSION_ID:-}")
  export CATALYST_SESSION_ID
fi

TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TMP="${SIGNAL_FILE}.tmp.$$"
# CTL-496: persist catalystSessionId so orchestrate-roll-usage --phase can
# attribute cost to the right session_metrics row.
jq --arg ts "$TS" --arg sid "${CATALYST_SESSION_ID:-}" '
  .status = "running"
  | .updatedAt = $ts
  | if $sid != "" then .catalystSessionId = $sid else . end
' "$SIGNAL_FILE" > "$TMP" \
  && mv "$TMP" "$SIGNAL_FILE"
```

## Already-merged detection (CTL-714)

Before delegating to `create-pr`, detect whether this branch's `HEAD` is already contained in
`origin/main` (manual rescue, or a sibling PR landed the same commits). If so, skip PR creation to
avoid a duplicate / empty-diff PR. Two complementary checks: `git merge-base --is-ancestor` (works
even if the branch was deleted from the remote) and `gh pr list --state merged` (recovers the merged
PR number for the downstream probe).

The detection fence is **side-effect-free** so the e2e test can source it in isolation.

```bash phase-pr-already-merged-detect
git fetch origin main --quiet 2>/dev/null || true
ALREADY_MERGED=0
MERGED_PR_NUMBER=""
MERGED_PR_URL=""

# Check 1: is HEAD already contained in origin/main? (must be in `if` — set -e)
if git merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
  ALREADY_MERGED=1
fi

# Check 2: does a MERGED PR exist for this branch? (--state merged is required —
# `gh pr list --head` with no --state returns only OPEN PRs; orchestrate-verify.sh:563)
BRANCH_NAME="$(git branch --show-current 2>/dev/null || true)"
if [[ -n "$BRANCH_NAME" ]]; then
  MERGED_PR_JSON="$(gh pr list --head "$BRANCH_NAME" --state merged \
    --json number,url --limit 1 2>/dev/null || echo '[]')"
  MERGED_PR_NUMBER="$(echo "$MERGED_PR_JSON" | jq -r '.[0].number // empty' 2>/dev/null || true)"
  MERGED_PR_URL="$(echo "$MERGED_PR_JSON" | jq -r '.[0].url // empty' 2>/dev/null || true)"
  if [[ -n "$MERGED_PR_NUMBER" ]]; then
    ALREADY_MERGED=1
  fi
fi
```

When `ALREADY_MERGED=1`, write the disposition into the signal file and complete without creating a
PR:

```bash
if [[ "$ALREADY_MERGED" -eq 1 ]]; then
  echo "phase-pr: HEAD already in origin/main — skipping PR creation (CTL-714)" >&2
  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  TMP="${SIGNAL_FILE}.tmp.$$"
  jq --arg ts "$TS" \
     --arg reason "already-merged-to-main" \
     --argjson prNum "${MERGED_PR_NUMBER:-null}" \
     --arg prUrl "${MERGED_PR_URL:-}" '
    .updatedAt = $ts
    | .attentionReason = $reason
    | if $prNum != null then .pr = {number: $prNum, url: $prUrl} else . end
  ' "$SIGNAL_FILE" > "$TMP" && mv "$TMP" "$SIGNAL_FILE"

  "${PLUGIN_ROOT}/scripts/phase-agent-emit-complete" \
    --phase "$PHASE" --ticket "$TICKET" --status complete
  [[ -n "$COMMS" && -x "$COMMS" ]] && "$COMMS" done "$CHANNEL" --as "$TICKET" >/dev/null 2>&1 || true
  exit 0
fi
```

## Existing open PR detection (CTL-709)

CTL-709's `phase-implement` may have already opened a draft PR for this branch. Detect it here so we
can **promote** it (`gh pr ready`) rather than re-entering `create-pr`'s interactive "PR already
exists" prompt (`create-pr/SKILL.md:96–104`) — that prompt would hang a `--bg` worker forever.
Detection order: merged → existing-open → create-new. The detection fence is **side-effect-free** so
the e2e test can source it in isolation.

```bash phase-pr-existing-pr-detect
# CTL-709: phase-implement may have already opened a (draft) PR for this branch.
# Detect it here so we can promote it rather than re-entering create-pr's
# interactive "PR already exists" prompt (create-pr/SKILL.md:96 — would hang --bg).
EXISTING_PR_NUMBER=""
EXISTING_PR_URL=""
EXISTING_PR_IS_DRAFT=""
EXISTING_PR_JSON="$(gh pr view --json number,url,state,isDraft 2>/dev/null || true)"
if [[ -n "$EXISTING_PR_JSON" ]]; then
  if [[ "$(printf '%s' "$EXISTING_PR_JSON" | jq -r '.state // empty' 2>/dev/null)" == "OPEN" ]]; then
    EXISTING_PR_NUMBER="$(printf '%s' "$EXISTING_PR_JSON" | jq -r '.number // empty' 2>/dev/null || true)"
    EXISTING_PR_URL="$(printf '%s' "$EXISTING_PR_JSON" | jq -r '.url // empty' 2>/dev/null || true)"
    EXISTING_PR_IS_DRAFT="$(printf '%s' "$EXISTING_PR_JSON" | jq -r '.isDraft // false' 2>/dev/null || true)"
  fi
fi
```

When an existing open PR is found, promote it (if draft) and finish — **without** delegating to
`create-pr`. The promote-and-finish block is NOT side-effect-free.

```bash
# CTL-864: cross-host fence — bow out if a takeover superseded us. No-op single-host.
"${PLUGIN_ROOT}/scripts/lib/cluster-fence-guard.sh" --phase "$PHASE" --ticket "$TICKET" || exit 10
if [[ -n "$EXISTING_PR_NUMBER" ]]; then
  echo "phase-pr: promoting existing PR #${EXISTING_PR_NUMBER} (draft=${EXISTING_PR_IS_DRAFT})" >&2
  if [[ -r "${PLUGIN_ROOT}/scripts/lib/draft-pr.sh" ]]; then
    # shellcheck source=/dev/null
    source "${PLUGIN_ROOT}/scripts/lib/draft-pr.sh"
  fi
  # CTL-1051: prove the remote branch (and the PR head) equal the worktree HEAD
  # BEFORE announcing the promoted PR — remediation/rebase may have advanced
  # local HEAD past the draft's pushed commit. Fail-closed: a stale ref is a
  # phase FAILURE, not a silent complete.
  # CTL-1119: rc=3 from draft_pr_push_verify means the push was rejected for
  # missing 'workflow' OAuth scope; escalate with an actionable human_question.
  VERIFIED_SHA=""
  PUSH_VERIFY_RC=0
  # CTL-1119 remediate: capture stdout ONLY (the verified SHA). draft_pr_push_verify
  # writes diagnostic _draft_pr_warn lines to stderr on every retry path (force-with-lease
  # AND the token-routed push); folding them in with 2>&1 made VERIFIED_SHA multi-line, so
  # the PR_HEAD_OID != VERIFIED_SHA guard below always tripped and falsely failed the phase
  # with stale_ref_push_verify_failed. No redirect: stderr flows to the worker log.
  VERIFIED_SHA="$(draft_pr_push_verify)" || PUSH_VERIFY_RC=$?
  if [[ "$PUSH_VERIFY_RC" -eq 3 ]]; then
    echo "phase-pr: push rejected — missing 'workflow' OAuth scope on existing PR path" >&2
    if [[ -r "${PLUGIN_ROOT}/scripts/lib/escalate-workflow-scope.sh" ]]; then
      # shellcheck source=/dev/null
      source "${PLUGIN_ROOT}/scripts/lib/escalate-workflow-scope.sh"
      _escalate_workflow_scope_push
    else
      "${PLUGIN_ROOT}/scripts/phase-agent-emit-complete" \
        --phase "$PHASE" --ticket "$TICKET" --status failed \
        --reason "push_rejected_no_workflow_scope"
    fi
    exit 1
  elif [[ "$PUSH_VERIFY_RC" -ne 0 ]]; then
    echo "phase-pr: push-verify failed for #${EXISTING_PR_NUMBER} (stale ref)" >&2
    "${PLUGIN_ROOT}/scripts/phase-agent-emit-complete" \
      --phase "$PHASE" --ticket "$TICKET" --status failed \
      --reason "stale_ref_push_verify_failed"
    exit 1
  fi
  PR_HEAD_OID="$(draft_pr_head_oid || true)"
  if [[ -n "$PR_HEAD_OID" && "$PR_HEAD_OID" != "$VERIFIED_SHA" ]]; then
    echo "phase-pr: PR headRefOid ${PR_HEAD_OID} != worktree HEAD ${VERIFIED_SHA}" >&2
    "${PLUGIN_ROOT}/scripts/phase-agent-emit-complete" \
      --phase "$PHASE" --ticket "$TICKET" --status failed \
      --reason "stale_ref_push_verify_failed"
    exit 1
  fi
  if [[ "$EXISTING_PR_IS_DRAFT" == "true" ]]; then
    if type draft_pr_promote >/dev/null 2>&1; then
      draft_pr_promote || gh pr ready "$EXISTING_PR_NUMBER" 2>/dev/null || true
    else
      gh pr ready "$EXISTING_PR_NUMBER" 2>/dev/null || true
    fi
  fi
  # Enrich the PR body now that the draft is ready (deferred from phase-implement to keep
  # its End block free of Task-tool calls — research Q4).
  #
  # Use the Task tool to invoke /catalyst-dev:describe-pr on $EXISTING_PR_NUMBER.
  # describe-pr is non-interactive when CATALYST_PHASE is set (it skips the Linear
  # inReview transition — the coordinator owns that — create-pr/SKILL.md:226–232).
  TS2=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  TMP="${SIGNAL_FILE}.tmp.$$"
  jq --argjson pr "$EXISTING_PR_NUMBER" --arg url "$EXISTING_PR_URL" --arg ts "$TS2" \
     '.pr={number:$pr,url:$url} | .updatedAt=$ts' \
     "$SIGNAL_FILE" > "$TMP" && mv "$TMP" "$SIGNAL_FILE"
  echo "phase-pr: existing PR #${EXISTING_PR_NUMBER} promoted — skipping create-pr delegation" >&2
fi
```

## /goal condition

Plan §"Per-phase /goal conditions":

```
/goal "`gh pr view --json number,state,headRefName` shows an open PR linked
       to ${TICKET} AND Linear state is `In Review` AND describe-pr has run
       successfully (I have printed the PR URL and `describe-pr ran` to my
       transcript)."
```

Turn cap defaults to 12 (from `phase-agent-dispatch:phase_default_turn_cap`). This is intentionally
tight because the work is mostly tool calls — most of the reasoning happens upstream in `create-pr`
itself.

## Phase-specific work

1. When `EXISTING_PR_NUMBER` is set (the draft opened by `phase-implement` was detected and promoted
   above): invoke `/catalyst-dev:describe-pr` via the Task tool on `$EXISTING_PR_NUMBER`. Then
   proceed directly to the End block — **do not** invoke `/catalyst-dev:create-pr`.

2. When `EXISTING_PR_NUMBER` is empty (Phase 3 draft creation failed or was disabled): invoke
   `/catalyst-dev:create-pr` via the Task tool. The canonical skill handles: branch push,
   base-branch resolution, idempotent PR creation if one already exists, `describe-pr` invocation,
   and Linear `inReview` transition.

3. After either path, capture the PR metadata via `gh` and write it into the phase signal file so
   `phase-monitor-merge` can read it directly without re-querying GitHub. For the create-pr path,
   push-verify before recording metadata (CTL-1051):

   ```bash
   # CTL-1051: ensure create-pr's push left origin == HEAD and the PR points at it.
   # CTL-1119: rc=3 means the push was rejected for missing 'workflow' OAuth scope.
   [[ -r "${PLUGIN_ROOT}/scripts/lib/draft-pr.sh" ]] && source "${PLUGIN_ROOT}/scripts/lib/draft-pr.sh"
   VERIFIED_SHA=""
   PUSH_VERIFY_RC=0
   # CTL-1119 remediate: capture stdout ONLY (the verified SHA) — see the existing-PR path
   # above. 2>&1 folded draft_pr_push_verify's stderr warnings into VERIFIED_SHA on retry
   # paths, breaking the PR_HEAD_OID comparison with a false stale_ref_push_verify_failed.
   VERIFIED_SHA="$(draft_pr_push_verify)" || PUSH_VERIFY_RC=$?
   if [[ "$PUSH_VERIFY_RC" -eq 3 ]]; then
     echo "phase-pr: push rejected — missing 'workflow' OAuth scope on create-pr path" >&2
     if [[ -r "${PLUGIN_ROOT}/scripts/lib/escalate-workflow-scope.sh" ]]; then
       # shellcheck source=/dev/null
       source "${PLUGIN_ROOT}/scripts/lib/escalate-workflow-scope.sh"
       _escalate_workflow_scope_push
     else
       "${PLUGIN_ROOT}/scripts/phase-agent-emit-complete" \
         --phase "$PHASE" --ticket "$TICKET" --status failed \
         --reason "push_rejected_no_workflow_scope"
     fi
     exit 1
   elif [[ "$PUSH_VERIFY_RC" -ne 0 ]]; then
     echo "phase-pr: post-create-pr push-verify failed (stale ref)" >&2
     "${PLUGIN_ROOT}/scripts/phase-agent-emit-complete" \
       --phase "$PHASE" --ticket "$TICKET" --status failed \
       --reason "stale_ref_push_verify_failed"
     exit 1
   fi
   PR_HEAD_OID="$(draft_pr_head_oid || true)"
   if [[ -n "$PR_HEAD_OID" && "$PR_HEAD_OID" != "$VERIFIED_SHA" ]]; then
     echo "phase-pr: PR headRefOid ${PR_HEAD_OID} != HEAD ${VERIFIED_SHA}" >&2
     "${PLUGIN_ROOT}/scripts/phase-agent-emit-complete" \
       --phase "$PHASE" --ticket "$TICKET" --status failed \
       --reason "stale_ref_push_verify_failed"
     exit 1
   fi
   PR_INFO=$(gh pr view --json number,url,headRefName,baseRefName 2>/dev/null || echo "{}")
   PR_NUMBER=$(echo "$PR_INFO" | jq -r '.number // empty')
   PR_URL=$(echo "$PR_INFO" | jq -r '.url // empty')
   if [[ -n "$PR_NUMBER" ]]; then
     TS2=$(date -u +%Y-%m-%dT%H:%M:%SZ)
     TMP="${SIGNAL_FILE}.tmp.$$"
     jq --argjson pr "$PR_NUMBER" --arg url "$PR_URL" --arg ts "$TS2" \
        '.pr = {number: $pr, url: $url} | .updatedAt = $ts' \
        "$SIGNAL_FILE" > "$TMP" && mv "$TMP" "$SIGNAL_FILE"
     echo "phase-pr: opened PR #${PR_NUMBER} at ${PR_URL}"
   else
     echo "phase-pr: gh pr view returned no PR — create-pr may have failed" >&2
   fi
   ```

4. The post-PR active resolution loop (CI fix-up, bot review threads, BEHIND rebase) is **not** run
   here — that is `phase-monitor-merge`'s responsibility. `create-pr`'s own brief monitoring window
   stays inside `create-pr`; phase-pr exits as soon as the PR exists in `OPEN` state.

## End block

Mirror the phase output to Linear as a single comment (CTL-632). Describes the PR that was opened
(number, URL, title, files changed, additions/deletions, commit count) plus the pre-merge
verification surfaced from the verify phase's `verify.json` (test/typecheck/lint gate status +
regression risk) so the trail records what was checked before the PR went up. PR metadata is re-read
from the phase signal file (`.pr.number`/`.pr.url`, written in the phase-specific work above) and
enriched via `gh pr view`; the verify summary is fail-soft if no `verify.json` exists. Body
hard-truncated to 30,000 bytes. Fail-open and idempotent via the per-phase marker file.
Uniquely-named fence so the e2e test can extract just this block.

```bash phase-pr-mirror
LINEAR_MIRROR_MARKER="${ORCH_DIR}/workers/${TICKET}/.linear-mirror-${PHASE}"
if [[ ! -e "${LINEAR_MIRROR_MARKER}" ]]; then
  PR_SIGNAL="${ORCH_DIR}/workers/${TICKET}/phase-${PHASE}.json"
  PR_NUMBER="$(jq -r '.pr.number // empty' "${PR_SIGNAL}" 2>/dev/null || true)"
  PR_URL="$(jq -r '.pr.url // empty' "${PR_SIGNAL}" 2>/dev/null || true)"
  PR_VIEW="{}"
  if [[ -n "${PR_NUMBER}" ]]; then
    PR_VIEW="$(gh pr view "${PR_NUMBER}" --json title,files,additions,deletions,commits 2>/dev/null || echo '{}')"
  fi
  PR_TITLE="$(printf '%s' "${PR_VIEW}" | jq -r '.title // "_untitled_"' 2>/dev/null || echo '_untitled_')"
  FILES_CHANGED="$(printf '%s' "${PR_VIEW}" | jq -r '(.files // []) | length' 2>/dev/null || echo '?')"
  ADDITIONS="$(printf '%s' "${PR_VIEW}" | jq -r '.additions // "?"' 2>/dev/null || echo '?')"
  DELETIONS="$(printf '%s' "${PR_VIEW}" | jq -r '.deletions // "?"' 2>/dev/null || echo '?')"
  COMMIT_COUNT="$(printf '%s' "${PR_VIEW}" | jq -r '(.commits // []) | length' 2>/dev/null || echo '?')"
  VERIFY_JSON_FILE="${ORCH_DIR}/workers/${TICKET}/verify.json"
  VERIFY_RENDERED="_no verify.json found — verification ran in a prior phase or was skipped_"
  if [[ -f "${VERIFY_JSON_FILE}" ]]; then
    VERIFY_RENDERED="$(jq -r '
      ("- **Regression risk**: " + ((.regression_risk // "?")|tostring) + " / 10")
      + "\n"
      + ((.gates // {})
         | to_entries
         | map(select(.key | test("test|typecheck|lint|coverage")))
         | map("- **" + .key + "**: " + (.value.status // "unknown")
               + (if .value.summary then " — " + .value.summary else "" end))
         | join("\n"))
    ' "${VERIFY_JSON_FILE}" 2>/dev/null || echo '_verify.json unreadable_')"
  fi
  MIRROR_BODY="$(cat <<EOF
**Phase PR** — opened PR #${PR_NUMBER:-?}

- **PR**: ${PR_URL:-_url unavailable_}
- **Title**: ${PR_TITLE}
- **Files changed**: ${FILES_CHANGED} (+${ADDITIONS} / -${DELETIONS})
- **Commits**: ${COMMIT_COUNT}

**Pre-merge verification** (from the verify phase):
${VERIFY_RENDERED}

_Posted automatically by phase-pr (CTL-632)._
EOF
)"
  MIRROR_FOOTER=""
  if [[ -n "${PLUGIN_ROOT:-}" && -x "${PLUGIN_ROOT}/scripts/lib/phase-mirror-footer.sh" ]]; then
    MIRROR_FOOTER="$("${PLUGIN_ROOT}/scripts/lib/phase-mirror-footer.sh" --orch-dir "${ORCH_DIR}" --ticket "${TICKET}" --phase "${PHASE}" 2>/dev/null || true)"
  fi
  [[ -n "${MIRROR_FOOTER}" ]] && MIRROR_BODY="${MIRROR_BODY}
${MIRROR_FOOTER}"
  if [[ ${#MIRROR_BODY} -gt 30000 ]]; then
    MIRROR_BODY="${MIRROR_BODY:0:30000}

_... (truncated)_"
  fi
  COMMENT_POST="${CATALYST_COMMENT_POST_HELPER:-${PLUGIN_ROOT}/scripts/lib/linear-comment-post.sh}"
  if [[ ! -x "$COMMENT_POST" ]]; then COMMENT_POST="$(command -v linear-comment-post.sh 2>/dev/null || true)"; fi
  if [[ -n "$COMMENT_POST" && -x "$COMMENT_POST" ]] && "$COMMENT_POST" "${TICKET}" "${MIRROR_BODY}" >/dev/null; then
    : > "${LINEAR_MIRROR_MARKER}"
  else
    echo "phase-pr: linear-comment-post failed (continuing)" >&2
  fi
fi
```

```bash
EMIT="${PLUGIN_ROOT}/scripts/phase-agent-emit-complete"
if [[ -x "$EMIT" ]]; then
  "$EMIT" --phase "$PHASE" --ticket "$TICKET" --status complete
fi
# Self-halt after complete to prevent zombie workers (CTL-778 step 2).
# Read our own bg_job_id from the signal file and ask Claude to stop us.
# Best-effort: a failed stop is covered by the daemon reaper backstop.
if [[ -n "${ORCH_DIR:-}" && -f "${ORCH_DIR}/workers/${TICKET}/phase-${PHASE}.json" ]]; then
  _SELF_BG=$(jq -r '.bg_job_id // empty' \
    "${ORCH_DIR}/workers/${TICKET}/phase-${PHASE}.json" 2>/dev/null || true)
  [[ -n "$_SELF_BG" ]] && claude stop "${_SELF_BG:0:8}" >/dev/null 2>&1 || true
fi
[[ -n "$COMMS" && -x "$COMMS" ]] && "$COMMS" done "$CHANNEL" --as "$TICKET" >/dev/null 2>&1 || true
```

## Failure handling

```bash
REASON="${1:-create-pr exited non-zero}"
"$EMIT" --phase "$PHASE" --ticket "$TICKET" --status failed --reason "$REASON"
[[ -n "$COMMS" && -x "$COMMS" ]] && "$COMMS" send "$CHANNEL" \
  "phase-pr failed: ${REASON}" \
  --as "$TICKET" --type attention --orch "$ORCH_ID" >/dev/null 2>&1 || true
exit 1
```

Common failure modes:

- **Branch not pushable** (e.g., diverged, network failure): `create-pr` errors; phase-pr emits
  `failed` with the underlying reason.
- **PR already exists with no new commits**: not a failure — `create-pr` is idempotent and returns
  the existing PR. The signal file gets the existing PR number written, downstream phases proceed
  normally.
- **`gh` not authenticated**: emit `failed` with the gh stderr; orchestrator's retry path will not
  unstick this — escalate via `attention`.

## Why this is a thin wrapper

Plan architectural commitment #3. `/catalyst-dev:create-pr` is mature (504 lines as of CTL-373) and
owns workflow-context, Linear linking, describe-pr, and idempotency. phase-pr adds the phase-agent
envelope (~80 lines) and nothing else — improvements to create-pr propagate for free.
