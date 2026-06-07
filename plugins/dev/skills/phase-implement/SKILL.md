---
name: phase-implement
description: |
  Phase-agent wrapper that drives TDD implementation from an approved plan
  (CTL-449 Initiative 1 Phase 3). Reads `thoughts/shared/plans/*-<ticket>.md`,
  delegates the red→green→refactor cycle to `/catalyst-dev:implement-plan`,
  commits each plan phase as it lands, and transitions the Linear ticket to
  `inProgress`. Dispatched as a `claude --bg` job by `phase-agent-dispatch`,
  which invokes it via slash command — hence `user-invocable: true`.
user-invocable: true
disable-model-invocation: false  # invocable by model (Skill tool) AND user (slash command)
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Edit
  - Write
  - Task
---

# phase-implement

Phase-agent that owns the implementation half of the legacy `oneshot` cycle —
this is the biggest single cost line of a worker run, which is why it leaves
`-p` for `--bg` first (plan §Initiative 1 Phase 3 rationale). The skill body
is intentionally thin: the canonical `/catalyst-dev:implement-plan` skill
already handles TDD rhythm, quality gates, agent-team mode, and findings
collection — phase-implement adds only the phase-agent envelope (signal file,
comms channel, `/goal` cap, terminal emit) around it.

## Prerequisites

- `CATALYST_ORCHESTRATOR_DIR`, `CATALYST_ORCHESTRATOR_ID`, `CATALYST_PHASE=implement`, `CATALYST_TICKET` set by [[phase-agent-dispatch]].
- An approved plan exists at `thoughts/shared/plans/<date>-<ticket-lowercase>.md` — the dispatcher's prior-artifact gate already validates this; this skill re-reads the file.
- Current working directory is the ticket's worktree (orchestrator's Phase 2 provisioning).

## Prelude (template — copy verbatim into the running session)

```bash
set -euo pipefail

: "${CATALYST_ORCHESTRATOR_DIR:?required (set by phase-agent-dispatch)}"
: "${CATALYST_ORCHESTRATOR_ID:?required}"
: "${CATALYST_PHASE:?required}"
: "${CATALYST_TICKET:?required}"

ORCH_DIR="$CATALYST_ORCHESTRATOR_DIR"
ORCH_ID="$CATALYST_ORCHESTRATOR_ID"
PHASE="$CATALYST_PHASE"
TICKET="$CATALYST_TICKET"
CHANNEL="${ORCH_ID}"

# CTL-484: continuation-worker orientation. Set by orchestrate-revive's
# continuation branch when this skill is resumed via `claude --bg --resume`
# after a previous session hit its /goal turn cap. Read the handoff doc and
# trust its summary instead of re-walking the plan from scratch.
if [[ "${CATALYST_IS_CONTINUATION:-}" == "true" ]]; then
  CONT_HANDOFF="${CATALYST_HANDOFF_PATH:-}"
  CONT_N="${CATALYST_CONTINUATION_COUNT:-?}"
  if [[ -n "$CONT_HANDOFF" && -f "$CONT_HANDOFF" ]]; then
    echo "phase-implement: continuation #${CONT_N} — resuming from ${CONT_HANDOFF}"
    echo "phase-implement: reading handoff (do NOT re-read full plan from scratch)"
    cat "$CONT_HANDOFF"
  else
    echo "warn: CATALYST_IS_CONTINUATION=true but handoff path missing or unreadable" >&2
  fi
fi

SIGNAL_FILE="${ORCH_DIR}/workers/${TICKET}/phase-${PHASE}.json"
[[ -f "$SIGNAL_FILE" ]] || { echo "phase-${PHASE}: signal file missing" >&2; exit 1; }

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
[[ -n "$PLUGIN_ROOT" ]] || PLUGIN_ROOT="$(dirname "$(dirname "$(dirname "$(realpath "${BASH_SOURCE[0]:-$0}" 2>/dev/null || echo .)")")")"

# 0. Codified bg_job_id yield (CTL-615). If the signal file's bg_job_id
#    names a DIFFERENT live bg job, we are a redispatch duplicate of a
#    still-running canonical worker. Bow out without touching the signal,
#    without emitting any phase event. Encodes operator memories
#    #43/#44/#49/#50 — the playbook is now code. phase-implement carries
#    the highest blast radius (commits land here), so it gets the gate
#    even though the template inheritance also provides it.
YIELD_CHECK="${PLUGIN_ROOT}/scripts/phase-agent-yield-check.sh"
if [[ -x "$YIELD_CHECK" ]] && bash "$YIELD_CHECK" \
     --signal "$SIGNAL_FILE" \
     --phase "$PHASE" \
     --worker-dir "$(dirname "$SIGNAL_FILE")"; then
  echo "phase-${PHASE}: yielding to canonical worker (CTL-615)" >&2
  exit 0
fi

# 1. Join the shared comms channel (best-effort).
COMMS="${PLUGIN_ROOT}/scripts/catalyst-comms"
[[ -x "$COMMS" ]] || COMMS="$(command -v catalyst-comms 2>/dev/null || true)"
if [[ -n "$COMMS" && -x "$COMMS" ]]; then
  "$COMMS" join "$CHANNEL" --as "$TICKET" \
    --capabilities "phase-implement: ${TICKET}" \
    --orch "$ORCH_ID" --parent orchestrator --ttl 3600 >/dev/null 2>&1 || true
  "$COMMS" send "$CHANNEL" "phase-implement started" --as "$TICKET" --type info \
    --orch "$ORCH_ID" >/dev/null 2>&1 || true
fi

# 2. Start a catalyst-session for cost/token instrumentation.
SESSION_SCRIPT="${PLUGIN_ROOT}/scripts/catalyst-session.sh"
if [[ -x "$SESSION_SCRIPT" ]]; then
  CATALYST_SESSION_ID=$("$SESSION_SCRIPT" start \
    --skill "phase-implement" \
    --ticket "$TICKET" \
    --workflow "${CATALYST_SESSION_ID:-}")
  export CATALYST_SESSION_ID
fi

# 3. Mark the signal file as running + persist catalystSessionId (CTL-496:
#    orchestrate-roll-usage --phase reads this to attribute cost).
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TMP="${SIGNAL_FILE}.tmp.$$"
jq --arg ts "$TS" --arg sid "${CATALYST_SESSION_ID:-}" '
  .status = "running"
  | .updatedAt = $ts
  | if $sid != "" then .catalystSessionId = $sid else . end
' "$SIGNAL_FILE" > "$TMP" \
  && mv "$TMP" "$SIGNAL_FILE"

# CTL-587: test-kill after-prelude. Exits AFTER the signal is flipped to
# running (so classifyWorker sees a non-terminal worker) but BEFORE any
# commit work, so reclaimDeadWorkIfPossible's implement-probe returns false
# on the next staleness tick and the revive path engages. Mode suffix
# `${PHASE}:after-prelude` keeps the env var phase-agnostic — only the
# matching phase aborts.
if [[ "${CATALYST_TEST_KILL_PHASE:-}" == "${PHASE}:after-prelude" ]]; then
  echo "[CTL-587 test-kill] aborting after prelude" >&2
  exit 137
fi

# 4. Locate the approved plan. The dispatcher already validated this glob;
#    we re-resolve to capture the actual filename for the delegated skill.
TICKET_LC="$(printf '%s' "$TICKET" | tr '[:upper:]' '[:lower:]')"
shopt -s nullglob
PLAN_MATCHES=( thoughts/shared/plans/*-"${TICKET_LC}".md )
shopt -u nullglob
[[ ${#PLAN_MATCHES[@]} -gt 0 ]] || { echo "no plan found for ${TICKET} under thoughts/shared/plans/" >&2; exit 1; }
PLAN_PATH="${PLAN_MATCHES[0]}"
echo "phase-implement: plan = ${PLAN_PATH}"

# 5. Linear status is written by the coordinator (CTL-558): the execution-core
#    scheduler / orchestrate-phase-advance applies the `Implement` state when
#    it commits the implement-phase transition. The phase agent no longer
#    transitions Linear itself.
```

## /goal condition

Transcript-evaluable so a `/goal` evaluator (which only sees Claude's text
output, not the filesystem) can decide pass/fail from what the agent prints.
Plan §"Per-phase /goal conditions":

```
/goal "I have run /catalyst-dev:implement-plan on ${PLAN_PATH} to completion
       AND `git diff <base>..HEAD` on this branch is non-empty AND the targeted
       tests pass (I have printed the test command + `exit 0` to my transcript);
       (Linear status is written by the coordinator — CTL-558 — not this agent.)"
```

## Phase-specific work

1. Invoke the canonical implementation skill via the Task tool. It owns TDD,
   quality gates, agent-team mode (`--team`), findings collection, and the
   per-phase commit cadence:

   ```
   Use the Task tool to launch /catalyst-dev:implement-plan on PLAN_PATH.
   Pass through any --team flag if the caller set CATALYST_IMPLEMENT_TEAM=1
   in the env. Wait for completion and surface its stdout summary.
   ```

   The canonical skill is responsible for committing each plan phase as a
   discrete commit AND for running the post-implementation quality gates
   (`/validate-type-safety`, `/security-review`, code-reviewer agent,
   pr-test-analyzer agent). phase-implement does NOT add commits or gates of
   its own. If `implement-plan` exits with errors, the failure-handling
   block below runs.

2. After the delegated skill returns, print a one-line summary to stdout so
   the `/goal` evaluator has signal that the work landed:

   ```bash
   git diff --stat "$(git merge-base HEAD main)..HEAD"  # base depends on the
                                                        # worktree's tracking
   ```

3. When the broader plan's Phase 4 (CTL-450) introduces dedicated
   `phase-verify` and `phase-review` agents, this skill will pass
   `--skip-quality-gates` to implement-plan so those concerns move into their
   own phase agents (plan §"Phase agents wrap canonical skills"). For the
   MVP this skill runs the gates inline via implement-plan because no
   phase-verify exists yet — the cutover is a one-line change to the Task
   invocation when that phase lands.

### Inbox check (CTL-749)

Before continuing to the End block, check for mid-flight context updates from the human:

1. If `${ORCH_DIR}/workers/${TICKET}/inbox.jsonl` exists and is non-empty, read it fully.
2. Parse each JSONL line — entries have `kind: "comment"` or `kind: "description_changed"`.
3. For each entry, decide:
   - **Absorb and continue**: the update is additive context (clarification, extra constraints,
     "also handle X") — fold it into your working context and continue. Post a brief reply comment
     acknowledging the update (one sentence).
   - **Pause and replan**: the update fundamentally changes scope or invalidates the current
     approach — emit `failed` with `reason: "mid_flight_replan_needed"` via
     `${PLUGIN_ROOT}/scripts/phase-agent-emit-complete` and post the reason to Linear as a
     comment before exiting.
4. After reading, archive processed entries:
   ```bash
   [[ -f "${ORCH_DIR}/workers/${TICKET}/inbox.jsonl" ]] && \
     mv "${ORCH_DIR}/workers/${TICKET}/inbox.jsonl" \
        "${ORCH_DIR}/workers/${TICKET}/inbox.processed-$(date +%s).jsonl" || true
   ```
5. If no inbox file or it is empty, continue normally.

## End block (terminal emit — copy verbatim)

Mirror the phase output to Linear as a single comment (CTL-632). Re-derives
the commit list at end-block time (no captured variable upstream), falling
back to `_base branch unknown_` if neither `origin/main` nor `main` exists.
Fail-open and idempotent via the per-phase marker file. Uniquely-named
fence so the e2e test can extract just this block.

```bash phase-implement-mirror
LINEAR_MIRROR_MARKER="${ORCH_DIR}/workers/${TICKET}/.linear-mirror-${PHASE}"
if [[ ! -e "${LINEAR_MIRROR_MARKER}" ]]; then
  BASE_REF=""
  if git rev-parse --verify --quiet origin/main >/dev/null 2>&1; then
    BASE_REF="origin/main"
  elif git rev-parse --verify --quiet main >/dev/null 2>&1; then
    BASE_REF="main"
  fi
  BASE_SHA=""
  if [[ -n "${BASE_REF}" ]]; then
    BASE_SHA="$(git merge-base HEAD "${BASE_REF}" 2>/dev/null || true)"
  fi
  if [[ -n "${BASE_SHA}" ]]; then
    COMMIT_LIST="$(git log --no-merges --oneline "${BASE_SHA}..HEAD" 2>/dev/null | sed 's/^/- /')"
    COMMIT_COUNT="$(printf '%s\n' "${COMMIT_LIST}" | grep -c '^- ' || true)"
    : "${COMMIT_COUNT:=0}"
    DIFF_STAT="$(git diff --stat "${BASE_SHA}..HEAD" 2>/dev/null | tail -1)"
    NAME_STATUS="$(git diff --name-status "${BASE_SHA}..HEAD" 2>/dev/null)"
    FILES_ADDED="$(printf '%s\n' "${NAME_STATUS}" | grep -c '^A' || true)"
    FILES_MODIFIED="$(printf '%s\n' "${NAME_STATUS}" | grep -c '^M' || true)"
    FILES_DELETED="$(printf '%s\n' "${NAME_STATUS}" | grep -c '^D' || true)"
    LINES_ADDED="$(git diff --numstat "${BASE_SHA}..HEAD" 2>/dev/null | awk '$1 ~ /^[0-9]+$/ {a+=$1} END {print a+0}')"
    LINES_DELETED="$(git diff --numstat "${BASE_SHA}..HEAD" 2>/dev/null | awk '$2 ~ /^[0-9]+$/ {d+=$2} END {print d+0}')"
  else
    COMMIT_LIST="_base branch unknown_"
    COMMIT_COUNT="?"
    DIFF_STAT="_unavailable_"
    FILES_ADDED="?"; FILES_MODIFIED="?"; FILES_DELETED="?"
    LINES_ADDED="?"; LINES_DELETED="?"
  fi
  BRANCH_NAME="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "${TICKET}")"
  MIRROR_BODY="$(cat <<EOF
**Phase Implement**

- **Branch**: \`${BRANCH_NAME}\`
- **Commits**: ${COMMIT_COUNT}
- **Files**: ${FILES_ADDED} added, ${FILES_MODIFIED} modified, ${FILES_DELETED} deleted
- **Lines**: +${LINES_ADDED} / -${LINES_DELETED}
- **Diff**: ${DIFF_STAT}

<details>
<summary>Commit list</summary>

${COMMIT_LIST}

</details>

_Posted automatically by phase-implement (CTL-632)._
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
    echo "phase-implement: linear-comment-post failed (continuing)" >&2
  fi
fi
```

Then the empty-branch self-emit gate (CTL-608). Runs **before** the terminal
`--status complete` so a worker cannot self-report implement success on an empty
ticket branch (0 commits ahead of its integration base). This is the ADV-1128
failure mode: sub-agent commits stranded in nested `.claude/worktrees/agent-*`
worktrees never reach `refs/heads/<ticket>`, leaving HEAD at base and opening an
empty PR. Uniquely-named fence so the e2e harness can extract+exercise it; uses
only POSIX/zsh-safe `git rev-list --count` (no `${VAR,,}` / `shopt`). Fail-open
(warn + allow) only when the base is unresolvable, mirroring the mirror block's
`_base branch unknown_` tolerance.

```bash phase-implement-empty-branch-gate
EMPTY_BRANCH_GATE_BASE=""
if git rev-parse --verify --quiet origin/main >/dev/null 2>&1; then
  EMPTY_BRANCH_GATE_BASE="origin/main"
elif git rev-parse --verify --quiet main >/dev/null 2>&1; then
  EMPTY_BRANCH_GATE_BASE="main"
fi
if [[ -n "${EMPTY_BRANCH_GATE_BASE}" ]]; then
  AHEAD="$(git rev-list --count "${EMPTY_BRANCH_GATE_BASE}..HEAD" 2>/dev/null || echo 0)"
  if [[ "${AHEAD:-0}" -le 0 ]]; then
    echo "phase-implement: 0 commits ahead of ${EMPTY_BRANCH_GATE_BASE}; refusing to emit complete on an empty branch (CTL-608)" >&2
    "${PLUGIN_ROOT}/scripts/phase-agent-emit-complete" \
      --phase "$PHASE" --ticket "$TICKET" --status failed \
      --reason "empty_branch:0_commits_ahead_of_${EMPTY_BRANCH_GATE_BASE}"
    [[ -n "$COMMS" && -x "$COMMS" ]] && "$COMMS" send "$CHANNEL" \
      "phase-implement failed: empty branch (0 commits ahead of ${EMPTY_BRANCH_GATE_BASE})" \
      --as "$TICKET" --type attention --orch "$ORCH_ID" >/dev/null 2>&1 || true
    exit 1
  fi
else
  echo "phase-implement: could not resolve integration base (no origin/main or main); skipping empty-branch gate (CTL-608)" >&2
fi
```

CTL-783: The canonical `implement-plan` skill opens the draft PR at the **first** plan-phase
commit via the `implement-plan-draft-pr-early` fence (idempotent — later commits just push).
This End-block fence is the **idempotent backstop**: it fires after all phases complete and is
the sole writer of `.draftPr` into the signal file. Gated on `draftPr.enabled` (default `true`)
so it can be disabled with one config key. Phase-pr detects and promotes the draft instead of
creating a new PR (avoiding the `create-pr` interactive "PR already exists" hang).

```bash phase-implement-draft-pr
# CTL-709: open a draft PR + push as soon as we have commits, so CI runs during
# verify/review and CTL-708 can see the branch. Fail-open — never blocks completion.
if [[ -r "${PLUGIN_ROOT}/scripts/lib/draft-pr.sh" ]]; then
  # shellcheck source=/dev/null
  source "${PLUGIN_ROOT}/scripts/lib/draft-pr.sh"
  if [[ "$(draft_pr_enabled)" == "true" ]]; then
    draft_pr_push || true
    DPR_OUT="$(draft_pr_ensure "main" "$TICKET" 2>/dev/null || true)"
    if [[ -n "${DPR_OUT}" ]]; then
      DPR_NUM="$(printf '%s' "$DPR_OUT" | cut -f1)"
      DPR_URL="$(printf '%s' "$DPR_OUT" | cut -f2)"
      DPR_DRAFT="$(printf '%s' "$DPR_OUT" | cut -f3)"
      TS_DPR=$(date -u +%Y-%m-%dT%H:%M:%SZ)
      TMP="${SIGNAL_FILE}.tmp.$$"
      jq --arg ts "$TS_DPR" --argjson num "${DPR_NUM:-null}" \
         --arg url "${DPR_URL:-}" --argjson draft "${DPR_DRAFT:-false}" \
         '.updatedAt=$ts | if $num!=null and $num!="" then .draftPr={number:($num|tonumber),url:$url,isDraft:$draft} else . end' \
         "$SIGNAL_FILE" > "$TMP" && mv "$TMP" "$SIGNAL_FILE" || true
      echo "phase-implement: draft PR #${DPR_NUM:-?} ${DPR_URL:-}" >&2
    fi
  fi
fi
```

## Step N — Capture friction (compound loop, CTL-789)

Just before the terminal emit, append **this phase's** friction to the shared per-ticket friction
log. This is the producer half of the engineering compound loop: `ticket-compound` later harvests
`thoughts/shared/friction/<TICKET>.md` to turn what hurt this run into durable learnings/ADRs.

REPLACE each `<…>` placeholder below with your real experience from **this** phase (terse, 3–6
lines total; `"None."` is a valid answer when the phase was frictionless). `${TICKET}` is already
resolved upstream — do not re-derive it. This append is **best-effort and off the critical path**:
it must NEVER fail the phase or block the emit-complete below. (Note this phase emits a signal JSON,
not a `thoughts/` markdown doc — which is exactly why friction goes to the shared friction LOG; do
not touch any `*.json` signal file.)

```bash
# --- Compound-engineering friction capture (CTL-789, Slice 1). Off critical path; NEVER block emit. ---
FRICTION_LOG="thoughts/shared/friction/${TICKET}.md"
mkdir -p "$(dirname "$FRICTION_LOG")"
[ -f "$FRICTION_LOG" ] || printf '# Friction log — %s\n' "${TICKET}" > "$FRICTION_LOG"
cat >> "$FRICTION_LOG" <<EOF

## implement · ${TICKET} · $(date +%Y-%m-%dT%H:%M:%S%z)
- **Backtracks / redone work:** <where you backtracked or redid work this phase — or "None.">
- **Missing / wrong / hard-to-find context:** <context that was absent, stale, or hard to locate — or "None.">
- **If I'd known:** <the ADR / guidance / past learning that would have saved this — the compounding signal — or "None.">
EOF
```

The record header `## implement · ${TICKET} · $(date +%Y-%m-%dT%H:%M:%S%z)` is a CROSS-PHASE
contract: `## <phase> · <TICKET> · <ISO-8601 timestamp>` carrying DATE+TIME+offset (e.g.
`2026-06-06T14:23:01+0900`). Keep this format byte-identical across all five phases — the per-record
stamp is what lets the morning briefing / daily review scan and sort "friction since last review";
never drop to a date-only stamp.

## End block — terminal emit (copy verbatim)

```bash
EMIT="${PLUGIN_ROOT}/scripts/phase-agent-emit-complete"
if [[ -x "$EMIT" ]]; then
  "$EMIT" --phase "$PHASE" --ticket "$TICKET" --status complete
fi
[[ -n "$COMMS" && -x "$COMMS" ]] && "$COMMS" done "$CHANNEL" --as "$TICKET" >/dev/null 2>&1 || true
```

## Failure handling

One failure mode — hard error (caller-supplied reason).

```bash
REASON="${1:-implement-plan exited non-zero}"  # caller-supplied short string

"$EMIT" --phase "$PHASE" --ticket "$TICKET" --status failed --reason "$REASON"
[[ -n "$COMMS" && -x "$COMMS" ]] && "$COMMS" send "$CHANNEL" \
  "phase-implement failed: ${REASON}" \
  --as "$TICKET" --type attention --orch "$ORCH_ID" >/dev/null 2>&1 || true
exit 1
```

The orchestrator's Phase 4 monitor receives `phase.implement.failed.${TICKET}`
via the broker `phase_lifecycle` route (CTL-447) and dispatches one fix-up
phase agent. A second failure escalates to the user via the `attention` post.

## Comms discipline

Inherits the contract from [[_phase-agent-template]]:

| Type        | When                                                                                  |
|-------------|--------------------------------------------------------------------------------------|
| `info`      | At start; once after `implement-plan` returns. ~1-2 per session. |
| `attention` | Missing plan, unresolved 3+ test failures, hard error. (Turn caps are enforced daemon-side — CTL-748 — not self-detected by this skill.) |
| `question`  | Plan ambiguity the agent cannot resolve unilaterally.                                 |
| `done`      | Emitted by `phase-agent-emit-complete` on success.                                    |

Read inbound `directive` / `pause` / `abort` after every Task-tool round-trip
back from `implement-plan` — the orchestrator may abort the worker while
implementation is in flight.

## Why this is a thin wrapper

Architectural commitment #3 in the plan: "phase agents are thin wrappers
around the canonical skills." Improvements to `/catalyst-dev:implement-plan`
(TDD agent-team mode, findings filing, quality-gate iteration limits)
propagate to every phase-agent run without code duplication. The phase-agent
boundary owns only the envelope: signal file, comms, `/goal` cap, terminal
event emission. See plan §"Phase agents wrap canonical skills" for the full
delegation table.
