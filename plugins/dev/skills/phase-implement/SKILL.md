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

# 3. Mark the signal file as running.
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TMP="${SIGNAL_FILE}.tmp.$$"
jq --arg ts "$TS" '.status = "running" | .updatedAt = $ts' "$SIGNAL_FILE" > "$TMP" \
  && mv "$TMP" "$SIGNAL_FILE"

# 4. Locate the approved plan. The dispatcher already validated this glob;
#    we re-resolve to capture the actual filename for the delegated skill.
TICKET_LC="$(printf '%s' "$TICKET" | tr '[:upper:]' '[:lower:]')"
shopt -s nullglob
PLAN_MATCHES=( thoughts/shared/plans/*-"${TICKET_LC}".md )
shopt -u nullglob
[[ ${#PLAN_MATCHES[@]} -gt 0 ]] || { echo "no plan found for ${TICKET} under thoughts/shared/plans/" >&2; exit 1; }
PLAN_PATH="${PLAN_MATCHES[0]}"
echo "phase-implement: plan = ${PLAN_PATH}"

# 5. Transition Linear to inProgress (worker-owned state per plan §Linear
#    Integration). Best-effort — Linear connectivity issues should not block
#    the implementation work.
LINEAR_TRANSITION="${PLUGIN_ROOT}/scripts/linear-transition.sh"
if [[ -x "$LINEAR_TRANSITION" ]]; then
  "$LINEAR_TRANSITION" --ticket "$TICKET" --transition inProgress \
    --config .catalyst/config.json 2>/dev/null || true
fi
```

## /goal condition

Transcript-evaluable so a `/goal` evaluator (which only sees Claude's text
output, not the filesystem) can decide pass/fail from what the agent prints.
Plan §"Per-phase /goal conditions":

```
/goal "I have run /catalyst-dev:implement-plan on ${PLAN_PATH} to completion
       AND `git diff <base>..HEAD` on this branch is non-empty AND the targeted
       tests pass (I have printed the test command + `exit 0` to my transcript)
       AND I have updated Linear to inProgress (the linear-transition.sh
       output line is in my transcript);
       OR I am within ~5 turns of the 75-turn cap, in which case I have
       (a) written a structured handoff to
           thoughts/shared/handoffs/${TICKET}/<ts>_turn-cap-continuation.md
           using the bash template in the 'Failure handling' section,
       (b) called phase-agent-emit-complete --status turn-cap-exhausted
           --handoff-path <the file> --reason 'turn cap hit (N)', and
       (c) exited 0 (cleanly — this is NOT a failure; the orchestrator
           dispatches a continuation worker on a separate budget)."
```

Turn cap defaults to 75 (from `phase-agent-dispatch:phase_default_turn_cap`)
and is overridable via `.catalyst/config.json:catalyst.orchestration.phaseAgents.turnCaps.implement`.

**CTL-484:** when the agent self-detects impending cap exhaustion (typically
~5 turns remaining), it takes the second `/goal` branch: writes a structured
handoff, emits `phase.implement.turn-cap-exhausted.<TICKET>`, and exits 0.
`orchestrate-revive`'s continuation branch reads the handoff path from the
per-phase signal file, dispatches a fresh `claude --bg --resume` session with
`CATALYST_IS_CONTINUATION=true` + `CATALYST_HANDOFF_PATH=<path>` +
`CATALYST_CONTINUATION_COUNT=<n>`, and the resumed session enters this skill
again — the Prelude check above orients it from the handoff instead of
re-walking the plan. Default budget: 3 continuations per ticket per phase
before `stalled` + `attentionReason=continuation-budget-exhausted`.

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

## End block (terminal emit — copy verbatim)

```bash
EMIT="${PLUGIN_ROOT}/scripts/phase-agent-emit-complete"
if [[ -x "$EMIT" ]]; then
  "$EMIT" --phase "$PHASE" --ticket "$TICKET" --status complete
fi
[[ -n "$COMMS" && -x "$COMMS" ]] && "$COMMS" done "$CHANNEL" --as "$TICKET" >/dev/null 2>&1 || true
```

## Failure handling

Two failure modes — turn-cap exhaustion (recoverable via continuation) and
hard error (caller-supplied reason). The branch is determined by the reason
string: anything starting with `turn cap hit` takes the CTL-484 continuation
path; everything else takes the legacy hard-error path.

```bash
REASON="${1:-implement-plan exited non-zero}"  # caller-supplied short string

# ── CTL-484: turn-cap branch — write handoff, emit turn-cap-exhausted,
#    exit 0. Orchestrator dispatches a continuation worker on a separate
#    budget; this is NOT a failure from the orchestrator's perspective.
if [[ "$REASON" =~ ^turn\ cap\ hit ]]; then
  TS_HO=$(date -u +%Y-%m-%d_%H-%M-%S)
  HANDOFF_DIR="thoughts/shared/handoffs/${TICKET}"
  HANDOFF_FILE="${HANDOFF_DIR}/${TS_HO}_turn-cap-continuation.md"
  mkdir -p "$HANDOFF_DIR"

  GIT_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "")
  BRANCH=$(git branch --show-current 2>/dev/null || echo "")
  BASE_REF=$(git merge-base HEAD main 2>/dev/null || echo HEAD)
  DIFF_STAT=$(git diff --stat "${BASE_REF}..HEAD" 2>/dev/null || echo "")
  CONT_N="${CATALYST_CONTINUATION_COUNT:-1}"

  cat > "$HANDOFF_FILE" <<EOF
---
date: $(date -u +%Y-%m-%d)
researcher: phase-implement
git_commit: ${GIT_COMMIT}
branch: ${BRANCH}
topic: "Continuation handoff for ${TICKET} (turn cap hit)"
status: in-progress
type: handoff
source_ticket: ${TICKET}
source_plan: ${PLAN_PATH:-unknown}
---

# ${TICKET} — turn-cap continuation handoff

## Task(s)

Implement plan at \`${PLAN_PATH:-unknown}\`. The previous session reached
its 75-turn cap before completing all phases. The continuation worker
should resume from the last committed phase and complete the remaining
ones.

## Recent changes (this session)

\`\`\`
${DIFF_STAT}
\`\`\`

Last commit: \`${GIT_COMMIT}\`
Branch: \`${BRANCH}\`

## Action Items & Next Steps

1. You are reading this handoff via \`CATALYST_HANDOFF_PATH\` — the
   Prelude block has already cat'd it to the transcript.
2. Read \`${PLAN_PATH:-the plan in thoughts/shared/plans/}\` only if you
   need detail beyond what \`git log --oneline ${BASE_REF}..HEAD\` shows.
   **Do NOT redo committed work** — trust the commit log.
3. Resume from the first uncommitted plan phase. Continue TDD rhythm.
4. On success, call \`phase-agent-emit-complete --status complete\`
   (terminal).
5. If you also hit the cap, write a fresh continuation handoff in this
   same directory and emit \`--status turn-cap-exhausted\` again. Budget
   is 3 continuations per ticket per phase before stall.

## Other Notes

- Catalyst session: ${CATALYST_SESSION_ID:-unknown}
- Continuation count: ${CONT_N}
- Plan path: ${PLAN_PATH:-unknown}
EOF

  "$EMIT" --phase "$PHASE" --ticket "$TICKET" \
    --status turn-cap-exhausted \
    --reason "$REASON" \
    --handoff-path "$HANDOFF_FILE"

  [[ -n "$COMMS" && -x "$COMMS" ]] && "$COMMS" send "$CHANNEL" \
    "phase-implement turn-cap-exhausted; handoff: ${HANDOFF_FILE}" \
    --as "$TICKET" --type info --orch "$ORCH_ID" >/dev/null 2>&1 || true
  exit 0
fi

# ── Hard-error branch (existing): emit failed + attention, exit non-zero.
"$EMIT" --phase "$PHASE" --ticket "$TICKET" --status failed --reason "$REASON"
[[ -n "$COMMS" && -x "$COMMS" ]] && "$COMMS" send "$CHANNEL" \
  "phase-implement failed: ${REASON}" \
  --as "$TICKET" --type attention --orch "$ORCH_ID" >/dev/null 2>&1 || true
exit 1
```

The orchestrator's Phase 4 monitor receives `phase.implement.failed.${TICKET}`
via the broker `phase_lifecycle` route (CTL-447) and dispatches one fix-up
phase agent. A second failure escalates to the user via the `attention` post.

For the turn-cap branch, the orchestrator instead receives
`phase.implement.turn-cap-exhausted.${TICKET}` and runs `orchestrate-revive`,
which detects the new status + handoff path on the per-phase signal and
dispatches a continuation worker on a budget separate from the error-revive
budget (CTL-484).

## Comms discipline

Inherits the contract from [[_phase-agent-template]]:

| Type        | When                                                                                  |
|-------------|--------------------------------------------------------------------------------------|
| `info`      | At start; once after `implement-plan` returns; once on turn-cap handoff write (CTL-484). ~2-3 per session. |
| `attention` | Missing plan, unresolved 3+ test failures, hard error. (Turn cap is NOT an attention event — see CTL-484.) |
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
