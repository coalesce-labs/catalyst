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
