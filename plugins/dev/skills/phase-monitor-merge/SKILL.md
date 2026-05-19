---
name: phase-monitor-merge
description: |
  Phase-agent that watches the open PR through to merge (CTL-449 Initiative 1
  Phase 3). Lifts the active listen loop from the legacy `oneshot` Phase 5
  body: event-driven wait on `catalyst-events wait-for`, inline resolution of
  CI fix-ups, bot review threads, and BEHIND rebases, then `gh pr merge
  --squash --delete-branch` when the PR reaches CLEAN, then transitions
  Linear to `done`. Dispatched as a `claude --bg` job by `phase-agent-dispatch`,
  which invokes it via slash command — hence `user-invocable: true`.
user-invocable: true
disable-model-invocation: false  # invocable by model (Skill tool) AND user (slash command)
allowed-tools:
  - Bash
  - Read
  - Grep
  - Task
---

# phase-monitor-merge

The reactive half of the worker lifecycle. The PR exists (opened by
[[phase-pr]]); this phase agent drives it to MERGED and transitions Linear
to `done`. Implementation lifts the loop from `plugins/dev/skills/oneshot/SKILL.md`
§"Step 2: Active PR Listen Loop" — same event names, same `mergeable_state`
state machine, same inline fix-up cap — wrapped in the phase-agent envelope
(signal file, comms channel, terminal event emission).

## Prerequisites

- `CATALYST_ORCHESTRATOR_DIR`, `CATALYST_ORCHESTRATOR_ID`, `CATALYST_PHASE=monitor-merge`, `CATALYST_TICKET` set by [[phase-agent-dispatch]].
- The prior phase's signal file `${ORCH_DIR}/workers/<TICKET>/phase-pr.json` exists with `status=done` AND `.pr.number` populated by [[phase-pr]].
- `gh` CLI authenticated; broker daemon optionally running (the loop falls back to direct `catalyst-events wait-for` filtering when it is not — see [[wait-for-github]]).

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

PR_SIGNAL="${ORCH_DIR}/workers/${TICKET}/phase-pr.json"
PR_NUMBER=$(jq -r '.pr.number // empty' "$PR_SIGNAL" 2>/dev/null || echo "")
[[ -n "$PR_NUMBER" ]] || { echo "phase-monitor-merge: no PR number in $PR_SIGNAL" >&2; exit 1; }

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
[[ -n "$PLUGIN_ROOT" ]] || PLUGIN_ROOT="$(dirname "$(dirname "$(dirname "$(realpath "${BASH_SOURCE[0]:-$0}" 2>/dev/null || echo .)")")")"

COMMS="${PLUGIN_ROOT}/scripts/catalyst-comms"
[[ -x "$COMMS" ]] || COMMS="$(command -v catalyst-comms 2>/dev/null || true)"
if [[ -n "$COMMS" && -x "$COMMS" ]]; then
  "$COMMS" join "$CHANNEL" --as "$TICKET" \
    --capabilities "phase-monitor-merge: ${TICKET} pr#${PR_NUMBER}" \
    --orch "$ORCH_ID" --parent orchestrator --ttl 86400 >/dev/null 2>&1 || true
  "$COMMS" send "$CHANNEL" "phase-monitor-merge watching pr#${PR_NUMBER}" \
    --as "$TICKET" --type info --orch "$ORCH_ID" >/dev/null 2>&1 || true
fi

SESSION_SCRIPT="${PLUGIN_ROOT}/scripts/catalyst-session.sh"
if [[ -x "$SESSION_SCRIPT" ]]; then
  CATALYST_SESSION_ID=$("$SESSION_SCRIPT" start \
    --skill "phase-monitor-merge" --ticket "$TICKET" \
    --workflow "${CATALYST_SESSION_ID:-}")
  export CATALYST_SESSION_ID
fi

REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || echo "")
[[ -n "$REPO" ]] || { echo "phase-monitor-merge: cannot resolve repo" >&2; exit 1; }

TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TMP="${SIGNAL_FILE}.tmp.$$"
# CTL-496: persist catalystSessionId so orchestrate-roll-usage --phase can
# attribute cost to the right session_metrics row.
jq --arg ts "$TS" --argjson pr "$PR_NUMBER" --arg sid "${CATALYST_SESSION_ID:-}" '
  .status = "running"
  | .updatedAt = $ts
  | .pr = {number: $pr}
  | if $sid != "" then .catalystSessionId = $sid else . end
' "$SIGNAL_FILE" > "$TMP" && mv "$TMP" "$SIGNAL_FILE"
```

## /goal condition

Plan §"Per-phase /goal conditions":

```
/goal "`gh pr view --json merged` returns `true` for the PR linked to
       ${TICKET} (PR #${PR_NUMBER}) AND Linear state is `Done` (I have
       printed both confirmations to my transcript); OR I have stopped after
       50 turns or 24 wall-clock hours."
```

Turn cap defaults to 50 — high relative to other phases because the work is
event-driven and one wake = one turn. Wall-clock cap is 24h (per plan
§Failure handling).

## Phase-specific work — active listen loop

Reuse the reactive listen loop from [[oneshot]] § Phase 5 Step 2. The full
control flow lives there; this skill copies the body verbatim, substituting
`phase-monitor-merge` framing in place of `oneshot`'s session-id machinery.
Key elements that MUST be preserved:

1. **Event-driven, not polling.** `catalyst-events wait-for` blocks until a
   PR-lifecycle event fires. Filter clause matches the canonical event names
   `github.pr.merged`, `github.check_suite.completed`, `github.pr_review*`,
   and `github.push` keyed by `attributes."vcs.pr.number"` (PR/review events)
   or `body.payload.prNumbers` (check_suite/workflow_run — see
   [[event-schema]]). When the broker daemon is up, register a
   `pr_lifecycle` interest via `agent.checkin.claimed_pr` and wait on
   `filter.wake.${CATALYST_SESSION_ID}` instead (the single-wake path — see
   [[monitor-events]] Pattern 3).

2. **REST is authoritative.** Every loop iteration calls
   `gh api repos/${REPO}/pulls/${PR_NUMBER}` and reads `.merged` +
   `.mergeable_state`. Never use `gh pr view --json mergeable` (GraphQL is
   eventually consistent for the merge-state fields and frequently lies).

3. **State machine.** Branch on `mergeable_state`:

   | state    | action |
   |----------|--------|
   | clean    | proceed to merge step |
   | blocked  | resolve via `/catalyst-dev:review-comments` (bot threads) or run an inline CI fix-up commit (up to 3 attempts); 4th attempt → `stalled` |
   | behind   | `git fetch && git rebase origin/<base> && git push --force-with-lease` |
   | dirty    | merge conflicts — emit `failed` with reason "merge conflicts (DIRTY)" |
   | unknown/unstable | continue waiting for the next event |

4. **Human reviewer changes-requested.** After every wake, query
   `gh pr view --json reviews` for the most recent `CHANGES_REQUESTED` from
   a human reviewer (filter on `.author.login` not matching known bots). If
   present, emit `failed` with reason "human reviewer ${LOGIN} requested
   changes — operator action required". Do NOT attempt to address human
   review comments programmatically.

5. **Wake narration.** Every iteration produces one short line of assistant
   text before re-entering the wait (defeats the assistant `end_turn`
   rendering bleed described in [[monitor-events]] § Narration). Shape:
   `wake: <event.name> #<PR_NUMBER> — <action being taken>`.

## Merge + Linear `done`

Once `mergeable_state == "clean"` (and the PR isn't already merged):

```bash
gh pr merge "$PR_NUMBER" --squash --delete-branch
# REST is authoritative — confirm via REST, never GraphQL
MERGED_OK=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}" --jq '.merged' 2>/dev/null || echo "false")
[[ "$MERGED_OK" = "true" ]] || { echo "phase-monitor-merge: merge not confirmed via REST" >&2; exit 1; }

MERGE_COMMIT_SHA=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}" --jq '.merge_commit_sha // empty')
MERGED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Record merge in signal file.
TMP="${SIGNAL_FILE}.tmp.$$"
jq --arg ts "$MERGED_AT" --arg sha "${MERGE_COMMIT_SHA:-}" \
   '.pr.mergedAt = $ts | .pr.ciStatus = "merged"
    | (if $sha != "" then .pr.mergeCommitSha = $sha else . end)
    | .updatedAt = $ts' \
   "$SIGNAL_FILE" > "$TMP" && mv "$TMP" "$SIGNAL_FILE"

# Transition Linear to done — worker-owned per plan §Linear Integration.
LINEAR_TRANSITION="${PLUGIN_ROOT}/scripts/linear-transition.sh"
if [[ -x "$LINEAR_TRANSITION" ]]; then
  "$LINEAR_TRANSITION" --ticket "$TICKET" --transition done \
    --config .catalyst/config.json 2>/dev/null || true
fi

echo "phase-monitor-merge: pr#${PR_NUMBER} merged at ${MERGED_AT}; Linear=done"
```

Deployment verification (`skipDeployVerification=false`) is **not** in this
phase's scope — that is `phase-monitor-deploy` (plan §Initiative 1 Phase 5).
This skill exits cleanly the moment the merge + Linear transition land.

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
REASON="${1:-listen loop terminal failure}"
"$EMIT" --phase "$PHASE" --ticket "$TICKET" --status failed --reason "$REASON"
[[ -n "$COMMS" && -x "$COMMS" ]] && "$COMMS" send "$CHANNEL" \
  "phase-monitor-merge failed: ${REASON}" \
  --as "$TICKET" --type attention --orch "$ORCH_ID" >/dev/null 2>&1 || true
exit 1
```

Failure modes that emit `phase.monitor-merge.failed.${TICKET}`:

- `dirty` (merge conflicts) — operator must rebase manually.
- Human reviewer `CHANGES_REQUESTED` — operator must address comments.
- CI blocked after 3 auto-fix attempts.
- `gh pr merge` succeeded but REST confirms `.merged == false` (rare; usually
  a branch-protection rule mismatch).
- 24-hour wall-clock cap — orchestrator dispatches a fix-up or escalates.

## Comms discipline

Inherits the contract from [[_phase-agent-template]]:

| Type        | When                                                              |
|-------------|------------------------------------------------------------------|
| `info`      | At start with PR number; after each successful inline fix-up.     |
| `attention` | DIRTY, human changes-requested, CI blocked after 3 attempts.      |
| `question`  | Reserved — this phase rarely needs to ask, since the work is reactive. |
| `done`      | Emitted by `phase-agent-emit-complete` on merge confirmed.        |

## Why this is a thin wrapper

Plan architectural commitment #3. The listen loop logic lives in [[oneshot]]
SKILL.md and is exercised every day. Lifting it into a phase-agent skill
without duplicating the body keeps both paths in lockstep — when the legacy
oneshot path retires (plan §Initiative 1 Phase 6), this skill becomes the
sole owner.
