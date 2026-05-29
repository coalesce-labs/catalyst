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
disable-model-invocation: false  # invocable by model (Skill tool) AND user (slash command)
allowed-tools:
  - Bash
  - Read
  - Task
---

# phase-pr

Thin wrapper around `/catalyst-dev:create-pr`. The canonical skill already
handles: commit, push, base-branch detection, PR creation, `describe-pr`
auto-invocation, workflow-context tracking, Linear `inReview` transition,
and the post-PR resolution loop. Phase-pr adds only the phase-agent envelope
plus persisting `pr.number` + `pr.url` to the signal file for
`phase-monitor-merge`.

## Prerequisites

- `CATALYST_ORCHESTRATOR_DIR`, `CATALYST_ORCHESTRATOR_ID`, `CATALYST_PHASE=pr`, `CATALYST_TICKET` set by [[phase-agent-dispatch]].
- The prior phase's signal file `${ORCH_DIR}/workers/<TICKET>/phase-review.json` exists with `status=done` — the dispatcher validates this; this skill assumes it.
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
`origin/main` (manual rescue, or a sibling PR landed the same commits). If so, skip PR creation
to avoid a duplicate / empty-diff PR. Two complementary checks: `git merge-base --is-ancestor`
(works even if the branch was deleted from the remote) and `gh pr list --state merged` (recovers
the merged PR number for the downstream probe).

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

When `ALREADY_MERGED=1`, write the disposition into the signal file and complete without
creating a PR:

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

## /goal condition

Plan §"Per-phase /goal conditions":

```
/goal "`gh pr view --json number,state,headRefName` shows an open PR linked
       to ${TICKET} AND Linear state is `In Review` AND describe-pr has run
       successfully (I have printed the PR URL and `describe-pr ran` to my
       transcript); OR I have stopped after 12 turns."
```

Turn cap defaults to 12 (from `phase-agent-dispatch:phase_default_turn_cap`).
This is intentionally tight because the work is mostly tool calls — most of
the reasoning happens upstream in `create-pr` itself.

## Phase-specific work

1. Invoke `/catalyst-dev:create-pr` via the Task tool. The canonical skill
   handles: branch push, base-branch resolution, idempotent PR creation if
   one already exists, `describe-pr` invocation, and Linear `inReview`
   transition.

2. After `create-pr` returns, capture the PR metadata via `gh` and write it
   into the phase signal file so `phase-monitor-merge` can read it directly
   without re-querying GitHub:

   ```bash
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

3. The post-PR active resolution loop (CI fix-up, bot review threads, BEHIND
   rebase) is **not** run here — that is `phase-monitor-merge`'s
   responsibility. `create-pr`'s own brief monitoring window stays inside
   `create-pr`; phase-pr exits as soon as the PR exists in `OPEN` state.

## End block

Mirror the phase output to Linear as a single comment (CTL-632). Describes the
PR that was opened (number, URL, title, files changed, additions/deletions,
commit count) plus the pre-merge verification surfaced from the verify phase's
`verify.json` (test/typecheck/lint gate status + regression risk) so the trail
records what was checked before the PR went up. PR metadata is re-read from the
phase signal file (`.pr.number`/`.pr.url`, written in the phase-specific work
above) and enriched via `gh pr view`; the verify summary is fail-soft if no
`verify.json` exists. Body hard-truncated to 30,000 bytes. Fail-open and
idempotent via the per-phase marker file. Uniquely-named fence so the e2e test
can extract just this block.

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
  if linearis issues discuss "${TICKET}" --body "${MIRROR_BODY}" >/dev/null 2>&1; then
    : > "${LINEAR_MIRROR_MARKER}"
  else
    echo "phase-pr: linearis discuss failed (continuing)" >&2
  fi
fi
```

```bash
EMIT="${PLUGIN_ROOT}/scripts/phase-agent-emit-complete"
if [[ -x "$EMIT" ]]; then
  "$EMIT" --phase "$PHASE" --ticket "$TICKET" --status complete
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

- **Branch not pushable** (e.g., diverged, network failure): `create-pr` errors;
  phase-pr emits `failed` with the underlying reason.
- **PR already exists with no new commits**: not a failure — `create-pr` is
  idempotent and returns the existing PR. The signal file gets the existing
  PR number written, downstream phases proceed normally.
- **`gh` not authenticated**: emit `failed` with the gh stderr; orchestrator's
  retry path will not unstick this — escalate via `attention`.

## Why this is a thin wrapper

Plan architectural commitment #3. `/catalyst-dev:create-pr` is mature (504
lines as of CTL-373) and owns workflow-context, Linear linking, describe-pr,
and idempotency. phase-pr adds the phase-agent envelope (~80 lines) and
nothing else — improvements to create-pr propagate for free.
