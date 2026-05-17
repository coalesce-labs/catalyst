---
name: phase-plan
description: |
  Phase agent for the plan step of the 9-phase orchestrator pipeline (CTL-450).
  Wraps /catalyst-dev:create-plan and produces
  thoughts/shared/plans/<date>-<ticket>.md, then emits phase.plan.complete.<ticket>.
  Reads the prior research document from thoughts/shared/research/ as its
  prior-phase artifact. Spawned via plugins/dev/scripts/phase-agent-dispatch;
  not normally user-invoked.
disable-model-invocation: false
user-invocable: false
allowed-tools:
  - Read
  - Write
  - Grep
  - Glob
  - Task
  - Bash
  - mcp__deepwiki__ask_question
  - mcp__deepwiki__read_wiki_structure
---

# phase-plan

You are the **plan phase agent**. You run inside `claude --bg` and own a single
responsibility: produce `thoughts/shared/plans/<date>-<ticket>.md` that meets the
schema enforced by [[create-plan]], then emit `phase.plan.complete.<ticket>` and
exit. Built on the [[_phase-agent-template]] contract.

Plans are TDD-structured: Tests First (Red) → Implementation (Green) → Refactor →
Success Criteria for every phase, with success criteria split into Automated and
Manual Verification.

## Prelude

```bash
set -uo pipefail

: "${CATALYST_ORCHESTRATOR_DIR:?required (set by phase-agent-dispatch)}"
: "${CATALYST_ORCHESTRATOR_ID:?required}"
: "${CATALYST_PHASE:?required}"
: "${CATALYST_TICKET:?required}"

ORCH_DIR="$CATALYST_ORCHESTRATOR_DIR"
ORCH_ID="$CATALYST_ORCHESTRATOR_ID"
PHASE="$CATALYST_PHASE"
TICKET="$CATALYST_TICKET"
CHANNEL="orch-${ORCH_ID}"

SIGNAL_FILE="${ORCH_DIR}/workers/${TICKET}/phase-${PHASE}.json"
[[ -f "$SIGNAL_FILE" ]] || { echo "phase-${PHASE}: signal file missing" >&2; exit 1; }

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/../../.." && pwd)}"

# Join comms channel (best-effort).
COMMS="${PLUGIN_ROOT}/scripts/catalyst-comms"
[[ -x "$COMMS" ]] || COMMS="$(command -v catalyst-comms 2>/dev/null || true)"
if [[ -n "$COMMS" ]]; then
  "$COMMS" join "$CHANNEL" --as "$TICKET" \
    --capabilities "phase-${PHASE}: ${TICKET}" \
    --orch "$ORCH_ID" --parent orchestrator --ttl 3600 >/dev/null 2>&1 || true
  "$COMMS" send "$CHANNEL" "phase-plan started" --as "$TICKET" --type info \
    --orch "$ORCH_ID" >/dev/null 2>&1 || true
fi

# Start session.
SESSION_SCRIPT="${PLUGIN_ROOT}/scripts/catalyst-session.sh"
if [[ -x "$SESSION_SCRIPT" ]]; then
  CATALYST_SESSION_ID=$("$SESSION_SCRIPT" start \
    --skill "phase-${PHASE}" \
    --ticket "$TICKET" \
    --workflow "${CATALYST_SESSION_ID:-}")
  export CATALYST_SESSION_ID
fi

TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TMP="${SIGNAL_FILE}.tmp.$$"
jq --arg ts "$TS" '.status = "running" | .updatedAt = $ts' "$SIGNAL_FILE" > "$TMP" \
  && mv "$TMP" "$SIGNAL_FILE"

# Prior-phase artifact: the research document. Dispatcher gates this via glob;
# we re-read it here so we can fail loudly on race.
shopt -s nullglob
RESEARCH_MATCHES=( thoughts/shared/research/*-${TICKET,,}.md )
shopt -u nullglob
if [[ ${#RESEARCH_MATCHES[@]} -eq 0 ]]; then
  echo "phase-plan: research document missing for $TICKET" >&2
  "${PLUGIN_ROOT}/scripts/phase-agent-emit-complete" \
    --phase "$PHASE" --ticket "$TICKET" --status failed \
    --reason "prior_artifact_missing:research_doc"
  exit 1
fi
RESEARCH_DOC="${RESEARCH_MATCHES[-1]}"
```

## Linear state transition

```bash
LT="${PLUGIN_ROOT}/scripts/linear-transition.sh"
if [[ -x "$LT" ]]; then
  "$LT" --ticket "$TICKET" --transition planning --config .catalyst/config.json \
    >/dev/null 2>&1 || true
fi
```

## /goal

```
/goal "I have written thoughts/shared/plans/<date>-${ticket-lower}.md containing the
       full plan with: Overview, Phase 1..N sections each with Tests First (Red),
       Implementation (Green), Refactor, and Success Criteria (Automated + Manual).
       I have printed the path on stdout. OR I have stopped after 25 turns and
       printed a clear partial-progress summary."
```

## Work block

Generate the plan by **invoking the canonical skill** rather than reimplementing it.
The body of [[create-plan]] is the single source of truth.

Phase agents run inside `claude --bg` — there is no interactive user. Pass the
research document as the input and operate non-interactively:

1. Read `$RESEARCH_DOC` to understand the problem.
2. Invoke `/catalyst-dev:create-plan` against the research document. When that skill
   asks for clarifications, answer from the research document; if the research
   document is silent on a point, default to the most conservative reasonable choice
   and record the assumption in the plan's "Open questions" section.
3. Confirm the artifact exists:
   ```bash
   shopt -s nullglob
   PLAN_MATCHES=( thoughts/shared/plans/*-${TICKET,,}.md )
   shopt -u nullglob
   [[ ${#PLAN_MATCHES[@]} -gt 0 ]] || {
     "${PLUGIN_ROOT}/scripts/phase-agent-emit-complete" \
       --phase "$PHASE" --ticket "$TICKET" --status failed \
       --reason "plan_doc_not_written"
     exit 1
   }
   PLAN_DOC="${PLAN_MATCHES[-1]}"
   ```

If [[create-plan]] runs into a question it cannot resolve from the research
document, post a `question` comms message to the orchestrator with `--re <msg_id>`
correlation; do not block waiting for a reply — record the assumption and proceed.

## End block

```bash
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TMP="${SIGNAL_FILE}.tmp.$$"
jq --arg ts "$TS" --arg doc "$PLAN_DOC" \
  '.updatedAt = $ts | .artifact = $doc' \
  "$SIGNAL_FILE" > "$TMP" && mv "$TMP" "$SIGNAL_FILE"

"${PLUGIN_ROOT}/scripts/phase-agent-emit-complete" \
  --phase "$PHASE" --ticket "$TICKET" --status complete

[[ -n "$COMMS" ]] && "$COMMS" done "$CHANNEL" --as "$TICKET" >/dev/null 2>&1 || true
```

## Failure handling

```bash
"${PLUGIN_ROOT}/scripts/phase-agent-emit-complete" \
  --phase "$PHASE" --ticket "$TICKET" --status failed \
  --reason "<short reason>"
[[ -n "$COMMS" ]] && "$COMMS" send "$CHANNEL" \
  "phase-plan failed: <reason>" --as "$TICKET" --type attention \
  --orch "$ORCH_ID" >/dev/null 2>&1 || true
exit 1
```
