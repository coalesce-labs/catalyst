---
name: phase-monitor-merge
description: |
  Phase-agent that watches the open PR through to merge (CTL-449 Initiative 1
  Phase 3). Lifts the active listen loop from the legacy `oneshot` Phase 5
  body: event-driven wait on `catalyst-events wait-for`, inline resolution of
  CI fix-ups, bot review threads, and BEHIND rebases, then `gh pr merge
  --squash --delete-branch` when the PR reaches CLEAN. Linear Done transition
  and worktree teardown are owned by phase-teardown (CTL-703). Dispatched as
  a `claude --bg` job by `phase-agent-dispatch`, which invokes it via slash
  command — hence `user-invocable: true`.
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
[[phase-pr]]); this phase agent drives it to MERGED. Linear Done transition
and worktree teardown are owned by [[phase-teardown]] (CTL-703). Implementation
lifts the loop from `plugins/dev/skills/oneshot/SKILL.md`
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
       ${TICKET} (PR #${PR_NUMBER}) AND I have posted the merge mirror
       comment to Linear and emitted phase-monitor-merge.complete (I have
       printed both confirmations to my transcript);
       OR 24 wall-clock hours have elapsed without merge completion
       and I have recorded status:timeout."
```

Wall-clock cap is 24h (per plan §Failure handling).

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
   | behind   | `git fetch && git rebase origin/<base> && git -c core.hooksPath=/dev/null push --force-with-lease` |
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

## Merge

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

# CTL-703: Linear Done is written by phase-teardown (10th phase), not here.
echo "phase-monitor-merge: pr#${PR_NUMBER} merged at ${MERGED_AT}"

# CTL-703: worktree + branch removal moved to phase-teardown.
```

Deployment verification (`skipDeployVerification=false`) is **not** in this
phase's scope — that is `phase-monitor-deploy` (plan §Initiative 1 Phase 5).
This skill exits cleanly the moment the merge lands and the End-block mirror is
posted (CTL-703: Linear Done and worktree teardown happen in phase-teardown; the
compound-log entry below is best-effort and never extends the phase on failure).

## Compound-log closing entry (CTL-813 — off the critical path)

After the merge lands, write the ticket's compound-log entry
so the estimation loop's sink fills autonomously (the unbuilt CTL-189 — in
`merge-pr` a human answers these prompts; here YOU author them). **Best-effort:
on ANY failure log one line and continue to the End block — never fail or
block the phase on this.**

1. **Re-score from the merged diff** (CTL-746 structural bands → points
   XS=1 S=3 M=5 L=8 XL=13; LOC = additions+deletions: `<50→1, <200→3, <800→5,
   <2000→8, else 13`):

```bash
LOC=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}" --jq '.additions + .deletions' 2>/dev/null || echo "")
if   [[ -z "$LOC" ]];      then POINTS=""
elif [[ "$LOC" -lt 50 ]];  then POINTS=1
elif [[ "$LOC" -lt 200 ]]; then POINTS=3
elif [[ "$LOC" -lt 800 ]]; then POINTS=5
elif [[ "$LOC" -lt 2000 ]]; then POINTS=8
else POINTS=13; fi
```

   Adjust ±1 step with judgment (e.g. heavy rework you personally resolved —
   CI fix-up loops, rebases — justifies a bump). Skip the whole section when
   `POINTS` is empty.

2. **Author the two reflections yourself** — you just walked this PR through
   merge, so you have the ground truth: `what_worked` (1-2 sentences) and
   `what_surprised_me` (1-2 sentences; the BEHIND-rebase treadmill, bot review
   threads, or flaky CI you resolved are exactly this signal).

3. **Write the entry.** The helper resolves `estimate_at_start`/cost/wall from
   its defaults; on a missing default, retry once with explicit overrides; on a
   duplicate (re-walked phase), the "already exists" failure IS the skip path:

```bash
CL="${PLUGIN_ROOT}/scripts/compound-log.sh"
"$CL" write "$TICKET" --pr "$PR_NUMBER" --estimate-actual "$POINTS" \
  --what-worked "$WHAT_WORKED" --what-surprised-me "$WHAT_SURPRISED" 2>/dev/null \
|| "$CL" write "$TICKET" --pr "$PR_NUMBER" --estimate-actual "$POINTS" \
  --what-worked "$WHAT_WORKED" --what-surprised-me "$WHAT_SURPRISED" \
  --cost-usd 0 --estimate-start 0 \
|| echo "phase-monitor-merge: compound-log entry skipped (non-fatal)" >&2
```

Do NOT run the corpus refresh here (that is `compound-estimate` step 6 /
operator cadence — a background phase worker must not mutate the committed
corpus).

4. **Run the cross-ticket retro (CTL-831 — the per-ticket learning step).** After
   the compound-log entry (success OR skip), invoke `/catalyst-dev:ticket-retro`
   with no arguments. It regenerates `thoughts/shared/retros/ticket/<today>.md`
   over the since-last-retro window (same-day re-runs are cumulative by design)
   and refreshes the watch-items the morning briefing surfaces — this is how the
   system learns from every ticket it ships. Same contract as the entry above:
   **best-effort, never blocks the End block** — on any retro failure, log one
   line and continue.

## End block

Mirror the merge outcome to Linear as a single comment (CTL-632). Best-effort
end-of-loop summary (per the design decision — per-finding detail like
individual CI fix-up commits or bot review threads stays on the PR itself):
merge commit + base branch, the final CI check rollup (passed/total), and a
count of bot reviews handled (e.g. Codex) whose threads were resolved before
the merge. Merge metadata is re-read from the signal file (`.pr.mergeCommitSha`
/ `.pr.mergedAt`, written in the merge step above); CI + reviews are pulled once
from `gh pr view`. Runs inside the ticket worktree (CTL-703: no auto-teardown
`cd` here; the skill stays in the ticket worktree and relies on absolute
signal paths and the PR number). Body hard-truncated to 30,000 bytes. Fail-open and
idempotent via the per-phase marker file. Uniquely-named fence so the e2e test
can extract just this block.

```bash phase-monitor-merge-mirror
LINEAR_MIRROR_MARKER="${ORCH_DIR}/workers/${TICKET}/.linear-mirror-${PHASE}"
if [[ ! -e "${LINEAR_MIRROR_MARKER}" ]]; then
  MM_SIGNAL="${ORCH_DIR}/workers/${TICKET}/phase-${PHASE}.json"
  MM_PR_NUMBER="$(jq -r '.pr.number // empty' "${MM_SIGNAL}" 2>/dev/null || true)"
  [[ -n "${MM_PR_NUMBER}" ]] || MM_PR_NUMBER="${PR_NUMBER:-}"
  MERGE_SHA="$(jq -r '.pr.mergeCommitSha // empty' "${MM_SIGNAL}" 2>/dev/null || true)"
  MERGED_AT="$(jq -r '.pr.mergedAt // empty' "${MM_SIGNAL}" 2>/dev/null || true)"
  PR_VIEW="{}"
  if [[ -n "${MM_PR_NUMBER}" ]]; then
    PR_VIEW="$(gh pr view "${MM_PR_NUMBER}" --json url,baseRefName,createdAt,statusCheckRollup,reviews 2>/dev/null || echo '{}')"
  fi
  PR_URL="$(printf '%s' "${PR_VIEW}" | jq -r '.url // empty' 2>/dev/null || true)"
  BASE_REF="$(printf '%s' "${PR_VIEW}" | jq -r '.baseRefName // "main"' 2>/dev/null || echo 'main')"
  CREATED_AT="$(printf '%s' "${PR_VIEW}" | jq -r '.createdAt // empty' 2>/dev/null || true)"
  CHECKS_TOTAL="$(printf '%s' "${PR_VIEW}" | jq -r '(.statusCheckRollup // []) | length' 2>/dev/null || echo 0)"
  CHECKS_PASSED="$(printf '%s' "${PR_VIEW}" | jq -r '[(.statusCheckRollup // [])[] | select((.conclusion // .state) == "SUCCESS")] | length' 2>/dev/null || echo 0)"
  BOT_REVIEWS="$(printf '%s' "${PR_VIEW}" | jq -r '[(.reviews // [])[] | select((.author.login // "" | ascii_downcase) | test("codex|bot"))] | length' 2>/dev/null || echo 0)"
  if [[ "${CHECKS_TOTAL}" == "0" ]]; then
    CI_LINE="_no CI checks reported_"
  else
    CI_LINE="${CHECKS_PASSED}/${CHECKS_TOTAL} checks passed"
  fi
  if [[ -n "${MERGE_SHA}" ]]; then
    MERGE_LINE="\`${MERGE_SHA}\` into \`${BASE_REF}\`${MERGED_AT:+ at ${MERGED_AT}}"
  else
    MERGE_LINE="_merge commit unavailable_"
  fi
  # Wall-clock time the PR was open (opened → merged). This is total elapsed,
  # most of it spent WAITING on GitHub (CI, reviews) — the agent's actual
  # working time is the "active" figure in the footer below, so
  # waiting ≈ time-to-merge − active. fromdateiso8601 is portable (needs the Z).
  TIME_TO_MERGE="_unknown_"
  if [[ -n "${CREATED_AT}" && -n "${MERGED_AT}" ]]; then
    TTM_SECS="$(jq -n --arg a "${CREATED_AT}" --arg b "${MERGED_AT}" \
      '(($b|fromdateiso8601) - ($a|fromdateiso8601)) | floor' 2>/dev/null || echo "")"
    if [[ "${TTM_SECS}" =~ ^[0-9]+$ ]]; then
      TTM_H=$(( TTM_SECS / 3600 )); TTM_M=$(( (TTM_SECS % 3600) / 60 ))
      if [[ "${TTM_H}" -gt 0 ]]; then TIME_TO_MERGE="${TTM_H}h ${TTM_M}m"; else TIME_TO_MERGE="${TTM_M}m"; fi
    fi
  fi
  MIRROR_BODY="$(cat <<EOF
**Phase Monitor-Merge** — PR #${MM_PR_NUMBER:-?} merged

- **PR**: ${PR_URL:-_url unavailable_}
- **Merge commit**: ${MERGE_LINE}
- **Time to merge** (PR opened → merged): ${TIME_TO_MERGE} — mostly waiting on CI/reviews; see the footer's _active_ figure for actual working time
- **CI**: ${CI_LINE}
- **Bot reviews handled** (e.g. Codex): ${BOT_REVIEWS} — threads resolved before merge

_Posted automatically by phase-monitor-merge (CTL-632). Per-finding detail —
individual CI fix-up commits and review threads — lives on the PR itself._
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
  if [[ -n "$COMMENT_POST" && -x "$COMMENT_POST" ]] && "$COMMENT_POST" "${TICKET}" "${MIRROR_BODY}" >/dev/null 2>&1; then
    : > "${LINEAR_MIRROR_MARKER}"
  else
    echo "phase-monitor-merge: linear-comment-post failed (continuing)" >&2
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
