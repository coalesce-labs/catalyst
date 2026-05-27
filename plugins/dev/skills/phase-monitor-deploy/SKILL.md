---
name: phase-monitor-deploy
description: Phase agent that watches the post-merge deployment for a ticket. Reads the merge SHA from phase-monitor-merge.json (the signal file phase-monitor-merge writes after `gh pr merge` confirms via REST), subscribes via `catalyst-events wait-for` to deploy events on that SHA, then delegates a live verification check to the /canary skill (gstack). Emits phase.monitor-deploy.complete.<TICKET> on canary success, phase.monitor-deploy.failed.<TICKET> on deploy or canary failure, and phase.monitor-deploy.skipped.<TICKET> when no deploy event arrives before the timeout. Dispatched by the phase-agent orchestrator (CTL-452) via slash command — `user-invocable: true` so the dispatcher's `claude --bg "/catalyst-dev:phase-monitor-deploy ..."` resolves.
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
- `WORKER_DIR` — directory containing `phase-monitor-merge.json` (read,
  primary input) and where `phase-monitor-deploy.json` (write) lands. Defaults
  to `${ORCH_DIR}/workers/${TICKET}` if set, else `$(pwd)`.
- `PHASE_DEPLOY_TIMEOUT_SEC` — seconds to wait for a `deployment_status` event matching
  the merge SHA. Default `1800` (30 minutes). Setting to a small value is the
  documented way to skip deploy verification in test/dev environments.
- `PHASE_DEPLOY_ENV` — GitHub Deployment environment name to match (default
  `production`). Set per-project as needed.
- `PHASE_CANARY_CMD` — command line used to invoke the canary skill. Default
  `claude --model haiku -p /canary --output-format json`. Test runners override this with
  a stub that emits a fixture canary result.
- `CATALYST_ORCHESTRATOR_ID`, `CATALYST_SESSION_ID` — used for event trace/span id derivation.

`gh` CLI on `$PATH`, authenticated against the GitHub repo, is required only
when `phase-monitor-merge.json` exists but `.pr.mergeCommitSha` is empty (the
REST fallback path). In the common case (where `phase-monitor-merge` recorded
the SHA successfully), `gh` is not invoked. The fallback also reads PR number
from `phase-pr.json`.

## phase-monitor-merge.json contract (input shape)

```json
{
  "pr": {
    "mergedAt": "2026-05-18T22:00:00Z",
    "ciStatus": "merged",
    "mergeCommitSha": "abc123..."
  }
}
```

The skill reads `.pr.mergeCommitSha` only; everything else is informational.
The file is written by [[phase-monitor-merge]] after `gh pr merge --squash`
confirms via REST (`gh api repos/<owner>/<repo>/pulls/<num>` returns
`.merged == true`).

## /goal

```
/goal "The deploy for the merge SHA actually SUCCEEDED — a terminal
       deployment_status success event arrived for the SHA AND the /canary check
       passed — and I have written ${WORKER_DIR}/phase-monitor-deploy.json
       recording that success. If the deploy FAILED (a deployment_status failure
       or a failing canary), I have driven at least one remediation attempt
       rather than passively recording failed/skipped. OR no deployment_status
       event arrived within PHASE_DEPLOY_TIMEOUT_SEC and I have recorded
       status:skipped with a reason (the PR is already merged, so a missing
       deploy event is a skip, not a failure)."
```

CTL-656: monitor-deploy is **not** a passive watch — its goal is that the deploy
*actually succeeded*, so the `/goal` evaluator keeps the agent driving toward a
green canary, including a remediation attempt on a failed deploy, instead of
emitting `failed`/`skipped` and walking away on the first terminal signal. The
timeout path is the one legitimate early exit. (Production mode only; the CI
bash body below remains self-sufficient and deterministic.)

## Body

```bash phase-monitor-deploy-body
set -uo pipefail

__PM_SCRIPT_PATH="${BASH_SOURCE[0]:-${0}}"
__PM_SKILL_DIR="$(cd "$(dirname "$__PM_SCRIPT_PATH")" && pwd 2>/dev/null || pwd)"
__PM_REPO_ROOT="${PHASE_AGENT_REPO_ROOT:-$(cd "$__PM_SKILL_DIR/../../../.." 2>/dev/null && pwd || pwd)}"
__PM_LIB="${PHASE_EMIT_HELPER:-${__PM_REPO_ROOT}/plugins/dev/scripts/lib/phase-emit-complete.sh}"
# CTL-512: emit terminal events via the production wrapper so the signal
# file's `status` field is written canonically. The lib helper at
# $__PM_LIB only emits events — it never touches the signal file, which
# is why pre-CTL-512 skipped runs relied on orchestrate-revive to
# synthesize a `done` status. The wrapper also handles the broker emit,
# the session DB close, and the completedAt timestamp.
__PM_WRAPPER="${PHASE_EMIT_WRAPPER:-${__PM_REPO_ROOT}/plugins/dev/scripts/phase-agent-emit-complete}"

if [[ ! -r "$__PM_LIB" ]]; then
  echo "phase-monitor-deploy: cannot find phase-emit-complete.sh at $__PM_LIB" >&2
  exit 1
fi
# shellcheck disable=SC1090
. "$__PM_LIB"

if [[ ! -x "$__PM_WRAPPER" ]]; then
  echo "phase-monitor-deploy: cannot find phase-agent-emit-complete wrapper at $__PM_WRAPPER" >&2
  exit 1
fi

: "${TICKET:?phase-monitor-deploy: TICKET env var required}"

WORKER_DIR="${WORKER_DIR:-${ORCH_DIR:+${ORCH_DIR}/workers/${TICKET}}}"
WORKER_DIR="${WORKER_DIR:-$(pwd)}"
mkdir -p "$WORKER_DIR"

DEPLOY_TIMEOUT="${PHASE_DEPLOY_TIMEOUT_SEC:-1800}"
DEPLOY_ENV="${PHASE_DEPLOY_ENV:-production}"
CANARY_CMD="${PHASE_CANARY_CMD:-claude --model haiku -p /canary --output-format json}"

# 1. Read merge SHA from phase-monitor-merge.json (the prior phase artifact).
MERGE_FILE="$WORKER_DIR/phase-monitor-merge.json"
if [[ ! -f "$MERGE_FILE" ]]; then
  emit_phase_complete --phase monitor-deploy --ticket "$TICKET" --status failed \
    --reason "phase-monitor-merge.json missing at $MERGE_FILE"
  exit 1
fi

MERGE_SHA="$(jq -r '.pr.mergeCommitSha // empty' "$MERGE_FILE" 2>/dev/null)"
if [[ -z "$MERGE_SHA" ]]; then
  # Fall back to gh REST. Mirrors orchestrate-verify.sh:131-156. PR number
  # comes from phase-pr.json (phase-monitor-merge.json does not record it).
  PR_FILE="$WORKER_DIR/phase-pr.json"
  PR_NUMBER=""
  if [[ -f "$PR_FILE" ]]; then
    PR_NUMBER="$(jq -r '.pr.number // empty' "$PR_FILE" 2>/dev/null)"
  fi
  if [[ -z "$PR_NUMBER" ]]; then
    emit_phase_complete --phase monitor-deploy --ticket "$TICKET" --status failed \
      --reason "phase-monitor-merge.json has empty .pr.mergeCommitSha and no PR number available for gh REST fallback"
    exit 1
  fi
  REPO="$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || echo "")"
  if [[ -z "$REPO" ]]; then
    emit_phase_complete --phase monitor-deploy --ticket "$TICKET" --status failed \
      --reason "phase-monitor-merge.json has empty .pr.mergeCommitSha and gh repo view returned empty"
    exit 1
  fi
  MERGE_SHA="$(gh api "repos/${REPO}/pulls/${PR_NUMBER}" --jq '.merge_commit_sha // empty' 2>/dev/null || echo "")"
  if [[ -z "$MERGE_SHA" ]]; then
    emit_phase_complete --phase monitor-deploy --ticket "$TICKET" --status failed \
      --reason "phase-monitor-merge.json has empty .pr.mergeCommitSha and gh REST fallback also returned empty for pr#${PR_NUMBER}"
    exit 1
  fi
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

  # CTL-512: use the production wrapper so the signal file's `status` field
  # is written canonically (status: "skipped", completedAt set). The wrapper
  # merges these fields on top of the artifact JSON above without clobbering
  # deploy_state / deploy_sha / canary_result. Pre-CTL-512 this branch went
  # through the lib helper, which emitted the event but never touched the
  # signal file — orchestrate-revive then synthesized a `done` status by
  # accident, masking the leak.
  "$__PM_WRAPPER" --phase monitor-deploy --ticket "$TICKET" --status skipped \
    --reason "no deployment_status event for $MERGE_SHA on env $DEPLOY_ENV within ${DEPLOY_TIMEOUT}s"
  exit 0
fi

DEPLOY_STATE="$(printf '%s' "$DEPLOY_EVENT" \
  | jq -r '.attributes."deployment.state" // .body.payload.state // empty' 2>/dev/null)"

# Preview / live environment URL from the deployment_status payload. Prefer the
# environment URL (the actual deployed/preview site, e.g. a Cloudflare Pages
# preview); fall back to target_url (often the CI run). Surfaced in the mirror
# comment and persisted to the signal as structured data so a HUD/agent can link
# straight to the running deploy.
DEPLOY_URL="$(printf '%s' "$DEPLOY_EVENT" \
  | jq -r '.body.payload.environmentUrl // .body.payload.environment_url // .body.payload.targetUrl // .body.payload.target_url // empty' 2>/dev/null || true)"

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
  --arg url "$DEPLOY_URL" \
  --slurpfile canary "$CANARY_OUT_FILE" \
  '{
    ticket: $ticket,
    deploy_sha: $sha,
    deploy_env: $env,
    deploy_state: "success",
    deploy_time: $ts,
    deployment: ({environment: $env} + (if $url != "" then {url: $url} else {} end)),
    canary_result: ($canary | first),
    completed_at: $ts
  }' > "$RESULT_FILE"

CANARY_STATUS_FOR_MIRROR="$(jq -r '.status // "unknown"' "$CANARY_OUT_FILE" 2>/dev/null || echo "unknown")"

# Mirror the deploy outcome to Linear as a single comment (CTL-632). Shows the
# environment + preview/live URL (clickable straight from the ticket) and the
# canary verdict. Fail-open + idempotent via the per-phase marker. The footer is
# appended via the shared helper. monitor-deploy is the terminal phase, so this
# is the last automated comment on the ticket.
LINEAR_MIRROR_MARKER="${WORKER_DIR}/.linear-mirror-monitor-deploy"
if [[ ! -e "${LINEAR_MIRROR_MARKER}" ]] && command -v linearis >/dev/null 2>&1; then
  DEPLOY_URL_LINE="${DEPLOY_URL:-_none reported_}"
  MIRROR_BODY="$(cat <<EOF
**Phase Monitor-Deploy** — deployed to \`${DEPLOY_ENV}\`

- **Deploy**: success · canary \`${CANARY_STATUS_FOR_MIRROR}\`
- **Preview / environment URL**: ${DEPLOY_URL_LINE}
- **Merge SHA**: \`${MERGE_SHA}\`

_Posted automatically by phase-monitor-deploy (CTL-632)._
EOF
)"
  ORCH_DIR_RESOLVED="${CATALYST_ORCHESTRATOR_DIR:-${ORCH_DIR:-$(cd "${WORKER_DIR}/../.." 2>/dev/null && pwd || echo "")}}"
  FOOTER_BIN="${__PM_REPO_ROOT}/plugins/dev/scripts/lib/phase-mirror-footer.sh"
  if [[ -n "${ORCH_DIR_RESOLVED}" && -x "${FOOTER_BIN}" ]]; then
    MIRROR_FOOTER="$("${FOOTER_BIN}" --orch-dir "${ORCH_DIR_RESOLVED}" --ticket "${TICKET}" --phase "monitor-deploy" 2>/dev/null || true)"
    [[ -n "${MIRROR_FOOTER}" ]] && MIRROR_BODY="${MIRROR_BODY}
${MIRROR_FOOTER}"
  fi
  if linearis issues discuss "${TICKET}" --body "${MIRROR_BODY}" >/dev/null 2>&1; then
    : > "${LINEAR_MIRROR_MARKER}"
  else
    echo "phase-monitor-deploy: linearis discuss failed (continuing)" >&2
  fi
fi

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
