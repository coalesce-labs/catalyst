---
name: phase-implement
description: |
  Phase-agent wrapper that drives TDD implementation from an approved plan
  (CTL-449 Initiative 1 Phase 3). Reads `thoughts/shared/plans/*-<ticket>.md`,
  delegates the red→green→refactor cycle to `/catalyst-dev:implement-plan`,
  commits each plan phase as it lands, and transitions the Linear ticket to
  `inProgress`. Dispatched as a `claude --bg` job by `phase-agent-dispatch`;
  not user-invocable.
disable-model-invocation: true
user-invocable: false
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
       output line is in my transcript); OR I have stopped after 75 turns
       and printed the partial git diff stat + the last test result to my
       transcript."
```

Turn cap defaults to 75 (from `phase-agent-dispatch:phase_default_turn_cap`)
and is overridable via `.catalyst/config.json:catalyst.orchestration.phaseAgents.turnCaps.implement`.

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

Any non-recoverable failure (turn cap hit, `implement-plan` errored out,
unresolvable plan ambiguity that the comms `question`/`directive` round-trip
could not unblock):

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

| Type        | When                                                              |
|-------------|------------------------------------------------------------------|
| `info`      | At start; once after `implement-plan` returns. ~2 per session.    |
| `attention` | Stalled (turn cap), missing plan, unresolved 3+ test failures.    |
| `question`  | Plan ambiguity the agent cannot resolve unilaterally.             |
| `done`      | Emitted by `phase-agent-emit-complete` on success.                |

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
