---
name: phase-monitor-deploy
description: Phase agent that watches the post-merge deployment for a ticket. Reads the merge SHA from phase-pr.json, subscribes via `catalyst-events wait-for` to deploy events on that SHA, then delegates a live verification check to the /canary skill (gstack). Emits phase.monitor-deploy.complete.<TICKET> on canary success, phase.monitor-deploy.failed.<TICKET> on deploy or canary failure, and phase.monitor-deploy.skipped.<TICKET> when no deploy event arrives before the timeout. Dispatched by the phase-agent orchestrator (CTL-452) via slash command — `user-invocable: true` so the dispatcher's `claude --bg "/catalyst-dev:phase-monitor-deploy ..."` resolves.
user-invocable: true
disable-model-invocation: false  # invocable by model (Skill tool) AND user (slash command)
allowed-tools: Bash, Read, Write
version: 1.0.0
---

# phase-monitor-deploy

Greenfield phase agent shipped in CTL-451 (Initiative 1 Phase 5). Runs after `phase-pr`
has merged the PR. Subscribes to GitHub `deployment_status` events on the merge commit
SHA, then delegates canary verification to `/canary` (gstack) once the deploy reaches a
terminal state.

Optimized for Haiku — the body is purely procedural shell. The model context is only used
to gate the `/canary` skill invocation (which itself decides how aggressively to probe
the live URL).

## Inputs

Environment:
- `TICKET` — Linear identifier (e.g. `CTL-451`). Required.
- `WORKER_DIR` — directory containing `phase-pr.json` (read) and where
  `phase-monitor-deploy.json` (write) lands. Defaults to
  `${ORCH_DIR}/workers/${TICKET}` if set, else `$(pwd)`.
- `PHASE_DEPLOY_TIMEOUT_SEC` — seconds to wait for a `deployment_status` event matching
  the merge SHA. Default `1800` (30 minutes). Setting to a small value is the
  documented way to skip deploy verification in test/dev environments.
- `PHASE_DEPLOY_ENV` — GitHub Deployment environment name to match (default
  `production`). Set per-project as needed.
- `PHASE_CANARY_CMD` — command line used to invoke the canary skill. Default
  `claude --model haiku -p /canary --output-format json`. Test runners override this with
  a stub that emits a fixture canary result.
- `CATALYST_ORCHESTRATOR_ID`, `CATALYST_SESSION_ID` — used for event trace/span id derivation.

## phase-pr.json contract (input shape)

```json
{
  "pr": {
    "number": 1234,
    "url": "https://github.com/org/repo/pull/1234",
    "mergeCommitSha": "abc123..."
  }
}
```

The skill reads `.pr.mergeCommitSha` only; everything else is informational.

## Body

```bash phase-monitor-deploy-body
set -uo pipefail

__PM_SCRIPT_PATH="${BASH_SOURCE[0]:-${0}}"
__PM_SKILL_DIR="$(cd "$(dirname "$__PM_SCRIPT_PATH")" && pwd 2>/dev/null || pwd)"
__PM_REPO_ROOT="${PHASE_AGENT_REPO_ROOT:-$(cd "$__PM_SKILL_DIR/../../../.." 2>/dev/null && pwd || pwd)}"
__PM_LIB="${PHASE_EMIT_HELPER:-${__PM_REPO_ROOT}/plugins/dev/scripts/lib/phase-emit-complete.sh}"

if [[ ! -r "$__PM_LIB" ]]; then
  echo "phase-monitor-deploy: cannot find phase-emit-complete.sh at $__PM_LIB" >&2
  exit 1
fi
# shellcheck disable=SC1090
. "$__PM_LIB"

: "${TICKET:?phase-monitor-deploy: TICKET env var required}"

WORKER_DIR="${WORKER_DIR:-${ORCH_DIR:+${ORCH_DIR}/workers/${TICKET}}}"
WORKER_DIR="${WORKER_DIR:-$(pwd)}"
mkdir -p "$WORKER_DIR"

DEPLOY_TIMEOUT="${PHASE_DEPLOY_TIMEOUT_SEC:-1800}"
DEPLOY_ENV="${PHASE_DEPLOY_ENV:-production}"
CANARY_CMD="${PHASE_CANARY_CMD:-claude --model haiku -p /canary --output-format json}"

# 1. Read merge SHA from the prior phase artifact.
PR_FILE="$WORKER_DIR/phase-pr.json"
if [[ ! -f "$PR_FILE" ]]; then
  emit_phase_complete --phase monitor-deploy --ticket "$TICKET" --status failed \
    --reason "phase-pr.json missing at $PR_FILE"
  exit 1
fi

MERGE_SHA="$(jq -r '.pr.mergeCommitSha // empty' "$PR_FILE" 2>/dev/null)"
if [[ -z "$MERGE_SHA" ]]; then
  emit_phase_complete --phase monitor-deploy --ticket "$TICKET" --status failed \
    --reason "phase-pr.json has empty .pr.mergeCommitSha"
  exit 1
fi

# 2. Subscribe to deployment_status events for this SHA. The filter accepts any
#    deployment_status event whose vcs.revision matches and whose deployment.environment
#    matches PHASE_DEPLOY_ENV. wait-for scans the file from the start (it is not a true
#    live tail) so historical events fire immediately, which is the behavior the test
#    runner depends on.
DEPLOY_FILTER='(.attributes."event.name" | startswith("github.deployment_status"))
               and .attributes."vcs.revision" == "'"$MERGE_SHA"'"
               and .attributes."deployment.environment" == "'"$DEPLOY_ENV"'"'

DEPLOY_EVENT="$(catalyst-events wait-for \
  --filter "$DEPLOY_FILTER" \
  --timeout "$DEPLOY_TIMEOUT" 2>/dev/null || true)"

DEPLOY_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [[ -z "$DEPLOY_EVENT" ]]; then
  # 2a. No deploy event observed — emit `skipped` and exit successfully. The
  #     orchestrator treats skipped as success because the PR is already merged
  #     and the deploy pipeline simply did not signal this code path.
  jq -nc \
    --arg ticket "$TICKET" \
    --arg sha "$MERGE_SHA" \
    --arg env "$DEPLOY_ENV" \
    --arg ts "$DEPLOY_TIME" \
    '{
      ticket: $ticket,
      deploy_sha: $sha,
      deploy_env: $env,
      deploy_state: "skipped",
      deploy_time: $ts,
      canary_result: null,
      completed_at: $ts,
      reason: "no deployment_status event matched within timeout"
    }' > "$WORKER_DIR/phase-monitor-deploy.json"

  emit_phase_complete --phase monitor-deploy --ticket "$TICKET" --status skipped \
    --reason "no deployment_status event for $MERGE_SHA on env $DEPLOY_ENV within ${DEPLOY_TIMEOUT}s" \
    --payload-json "$(cat "$WORKER_DIR/phase-monitor-deploy.json")"
  exit 0
fi

DEPLOY_STATE="$(printf '%s' "$DEPLOY_EVENT" \
  | jq -r '.attributes."deployment.state" // .body.payload.state // empty' 2>/dev/null)"

# 3. Branch on deploy state.
case "$DEPLOY_STATE" in
  success)
    : # continue to canary
    ;;
  failure|error)
    jq -nc \
      --arg ticket "$TICKET" \
      --arg sha "$MERGE_SHA" \
      --arg env "$DEPLOY_ENV" \
      --arg state "$DEPLOY_STATE" \
      --arg ts "$DEPLOY_TIME" \
      '{
        ticket: $ticket,
        deploy_sha: $sha,
        deploy_env: $env,
        deploy_state: $state,
        deploy_time: $ts,
        canary_result: null,
        completed_at: $ts
      }' > "$WORKER_DIR/phase-monitor-deploy.json"
    emit_phase_complete --phase monitor-deploy --ticket "$TICKET" --status failed \
      --reason "deployment_status reported state=$DEPLOY_STATE for $MERGE_SHA on $DEPLOY_ENV" \
      --payload-json "$(cat "$WORKER_DIR/phase-monitor-deploy.json")"
    exit 1
    ;;
  *)
    # pending / in_progress / queued — wait-for already filtered terminal states
    # via the test fixture, so this branch is mainly defensive. Treat as failed
    # to escalate; future work can re-enter the wait loop instead.
    emit_phase_complete --phase monitor-deploy --ticket "$TICKET" --status failed \
      --reason "unexpected non-terminal deployment state: $DEPLOY_STATE"
    exit 1
    ;;
esac

# 4. Run the canary check. The default command shells out to `claude -p /canary`.
#    The test runner overrides PHASE_CANARY_CMD to a stub that writes a fixture
#    result. Either way, the command is expected to print JSON on stdout that
#    parses to an object with at least a `status` field ("success"|"failed").
CANARY_OUT_FILE="$WORKER_DIR/canary-output.json"
CANARY_STDERR_FILE="$WORKER_DIR/canary-stderr.log"

if ! eval "$CANARY_CMD" > "$CANARY_OUT_FILE" 2> "$CANARY_STDERR_FILE"; then
  emit_phase_complete --phase monitor-deploy --ticket "$TICKET" --status failed \
    --reason "canary command exited non-zero (see $CANARY_STDERR_FILE)"
  exit 1
fi

if ! jq -e . "$CANARY_OUT_FILE" >/dev/null 2>&1; then
  emit_phase_complete --phase monitor-deploy --ticket "$TICKET" --status failed \
    --reason "canary stdout did not parse as JSON"
  exit 1
fi

CANARY_STATUS="$(jq -r '.status // empty' "$CANARY_OUT_FILE")"

# 5. Compose phase-monitor-deploy.json.
RESULT_FILE="$WORKER_DIR/phase-monitor-deploy.json"
jq -nc \
  --arg ticket "$TICKET" \
  --arg sha "$MERGE_SHA" \
  --arg env "$DEPLOY_ENV" \
  --arg ts "$DEPLOY_TIME" \
  --slurpfile canary "$CANARY_OUT_FILE" \
  '{
    ticket: $ticket,
    deploy_sha: $sha,
    deploy_env: $env,
    deploy_state: "success",
    deploy_time: $ts,
    canary_result: ($canary | first),
    completed_at: $ts
  }' > "$RESULT_FILE"

# 6. Emit the canonical phase event based on canary status.
if [[ "$CANARY_STATUS" == "success" ]]; then
  emit_phase_complete --phase monitor-deploy --ticket "$TICKET" --status complete \
    --payload-json "$(cat "$RESULT_FILE")"
  exit 0
fi

emit_phase_complete --phase monitor-deploy --ticket "$TICKET" --status failed \
  --reason "canary status=${CANARY_STATUS:-unknown}" \
  --payload-json "$(cat "$RESULT_FILE")"
exit 1
```

## What an Opus-mode invocation adds

Haiku is the default. If the orchestrator routes this to an Opus agent (e.g., for a
high-stakes deploy where the canary is borderline), the agent should:

1. Run the bash body to drive the deploy event wait + canary invocation.
2. Read `canary-output.json` and decide whether the canary result is materially actionable
   beyond the binary `status` field (e.g., performance regressions worth flagging).
3. Optionally extend the comment posted by a later phase agent with model-grade insight.

The bash body alone is enough to drive the state machine. Opus-mode add-ons are pure
upside.
