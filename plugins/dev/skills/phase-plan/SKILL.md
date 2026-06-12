---
name: phase-plan
description: |
  Phase agent for the plan step of the 9-phase orchestrator pipeline (CTL-450).
  Wraps /catalyst-dev:create-plan and produces
  thoughts/shared/plans/<date>-<ticket>.md, then emits phase.plan.complete.<ticket>.
  Reads the prior research document from thoughts/shared/research/ as its
  prior-phase artifact. Spawned via plugins/dev/scripts/phase-agent-dispatch,
  which invokes it via slash command — hence `user-invocable: true`.
user-invocable: true
disable-model-invocation: false  # invocable by model (Skill tool) AND user (slash command)
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
# CTL-496: persist catalystSessionId so orchestrate-roll-usage --phase can
# attribute cost to the right session_metrics row.
jq --arg ts "$TS" --arg sid "${CATALYST_SESSION_ID:-}" '
  .status = "running"
  | .updatedAt = $ts
  | if $sid != "" then .catalystSessionId = $sid else . end
' "$SIGNAL_FILE" > "$TMP" \
  && mv "$TMP" "$SIGNAL_FILE"

# Prior-phase artifact: the research document. Dispatcher gates this via
# match_thoughts_artifact (lib/phase-artifact-gate.sh, CTL-1081); re-read
# here so we can fail loudly on race.
source "${PLUGIN_ROOT}/scripts/lib/phase-artifact-gate.sh"
RESEARCH_DOC="$(match_thoughts_artifact thoughts/shared/research "$TICKET" | tail -1 || true)"
if [[ -z "$RESEARCH_DOC" || ! -f "$RESEARCH_DOC" ]]; then
  echo "phase-plan: research document missing for $TICKET" >&2
  "${PLUGIN_ROOT}/scripts/phase-agent-emit-complete" \
    --phase "$PHASE" --ticket "$TICKET" --status failed \
    --reason "prior_artifact_missing:research_doc"
  exit 1
fi
```

<!-- Linear status is written by the coordinator (CTL-558): the execution-core
     scheduler / orchestrate-phase-advance applies the mapped state on every
     committed phase transition. The phase agent no longer transitions Linear. -->

## /goal

```
/goal "I have written thoughts/shared/plans/<date>-${ticket-lower}.md containing the
       full plan with: Overview, Phase 1..N sections each with Tests First (Red),
       Implementation (Green), Refactor, and Success Criteria (Automated + Manual).
       I have printed the path on stdout."
```

## Work block

Generate the plan by **invoking the canonical skill** rather than reimplementing it.
The body of [[create-plan]] is the single source of truth.

Phase agents run inside `claude --bg` — there is no interactive user. Pass the
research document as the input and operate non-interactively:

1. Read `$RESEARCH_DOC` to understand the problem. While reading, skim any
   `## Relevant Past Learnings` section the research phase surfaced, and any
   directly-matching entries under `thoughts/shared/learnings/`, and let those
   prior problem→solution notes inform the plan (the heavy grep lens lives in
   phase-research — don't re-run it here).
2. Assert the `thoughts/` root belongs to this project before writing (CTL-1081):
   ```bash
   bash "${PLUGIN_ROOT}/scripts/lib/assert-thoughts-project.sh" || {
     "${PLUGIN_ROOT}/scripts/phase-agent-emit-complete" \
       --phase "$PHASE" --ticket "$TICKET" --status failed \
       --reason "wrong_project_thoughts_root"
     exit 1
   }
   ```
3. Invoke `/catalyst-dev:create-plan` against the research document. When that skill
   asks for clarifications, answer from the research document; if the research
   document is silent on a point, default to the most conservative reasonable choice
   and record the assumption in the plan's "Open questions" section.
4. Confirm the artifact exists using the shared matcher (CTL-1081):
   ```bash
   # source already called above in the prelude (idempotent guard in the lib).
   source "${PLUGIN_ROOT}/scripts/lib/phase-artifact-gate.sh"
   PLAN_DOC="$(match_thoughts_artifact thoughts/shared/plans "$TICKET" | tail -1 || true)"
   [[ -n "$PLAN_DOC" && -f "$PLAN_DOC" ]] || {
     "${PLUGIN_ROOT}/scripts/phase-agent-emit-complete" \
       --phase "$PHASE" --ticket "$TICKET" --status failed \
       --reason "plan_doc_not_written"
     exit 1
   }
   ```

If [[create-plan]] runs into a question it cannot resolve from the research
document, post a `question` comms message to the orchestrator with `--re <msg_id>`
correlation; do not block waiting for a reply — record the assumption and proceed.

### Inbox check (CTL-749)

After `/catalyst-dev:create-plan` Task returns, check for mid-flight context updates from the human:

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

## End block

```bash
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TMP="${SIGNAL_FILE}.tmp.$$"
jq --arg ts "$TS" --arg doc "$PLAN_DOC" \
  '.updatedAt = $ts | .artifact = $doc' \
  "$SIGNAL_FILE" > "$TMP" && mv "$TMP" "$SIGNAL_FILE"
```

Mirror the phase output to Linear as a single comment (CTL-632). Fail-open
and idempotent via the per-phase marker file. Uniquely-named fence so the
e2e test can extract just this block.

```bash phase-plan-mirror
LINEAR_MIRROR_MARKER="${ORCH_DIR}/workers/${TICKET}/.linear-mirror-${PHASE}"
if [[ ! -e "${LINEAR_MIRROR_MARKER}" ]]; then
  PLAN_TITLE="$(awk '/^# /{print; exit}' "${PLAN_DOC}" | sed 's/^# //')"
  PLAN_PHASES_COUNT="$(grep -c '^## Phase ' "${PLAN_DOC}" || true)"
  : "${PLAN_PHASES_COUNT:=0}"
  MIRROR_BODY="$(cat <<EOF
**Phase Plan**

- **Document**: \`${PLAN_DOC}\`
- **Title**: ${PLAN_TITLE:-_untitled_}
- **Phases**: ${PLAN_PHASES_COUNT}
- **Research backlink**: \`${RESEARCH_DOC}\`

_Posted automatically by phase-plan (CTL-632)._
EOF
)"
  MIRROR_FOOTER=""
  if [[ -n "${PLUGIN_ROOT:-}" && -x "${PLUGIN_ROOT}/scripts/lib/phase-mirror-footer.sh" ]]; then
    MIRROR_FOOTER="$("${PLUGIN_ROOT}/scripts/lib/phase-mirror-footer.sh" --orch-dir "${ORCH_DIR}" --ticket "${TICKET}" --phase "${PHASE}" 2>/dev/null || true)"
  fi
  [[ -n "${MIRROR_FOOTER}" ]] && MIRROR_BODY="${MIRROR_BODY}
${MIRROR_FOOTER}"
  COMMENT_POST="${CATALYST_COMMENT_POST_HELPER:-${PLUGIN_ROOT}/scripts/lib/linear-comment-post.sh}"
  if [[ ! -x "$COMMENT_POST" ]]; then COMMENT_POST="$(command -v linear-comment-post.sh 2>/dev/null || true)"; fi
  if [[ -n "$COMMENT_POST" && -x "$COMMENT_POST" ]] && "$COMMENT_POST" "${TICKET}" "${MIRROR_BODY}" >/dev/null 2>&1; then
    : > "${LINEAR_MIRROR_MARKER}"
  else
    echo "phase-plan: linear-comment-post failed (continuing)" >&2
  fi
fi
```

## Step — Capture friction (compound loop, CTL-789)

Before emitting completion, append **your** friction from this plan phase to the
shared per-ticket friction log. This is the producer side of the compound loop —
`ticket-compound` harvests these records later. Replace each `<…>` placeholder
below with your real experience this phase (3–6 lines, terse; `None.` is a valid
answer when the phase was frictionless). `${TICKET}` is already resolved in the
Prelude — do not re-derive it. This append is best-effort: it must **never** fail
the phase, so it stays off the critical path and runs immediately before
emit-complete.

```bash
# --- Compound-engineering friction capture (CTL-789, Slice 1). Off critical path; NEVER block emit. ---
FRICTION_LOG="thoughts/shared/friction/${TICKET}.md"
mkdir -p "$(dirname "$FRICTION_LOG")"
[ -f "$FRICTION_LOG" ] || printf '# Friction log — %s\n' "${TICKET}" > "$FRICTION_LOG"
cat >> "$FRICTION_LOG" <<EOF

## plan · ${TICKET} · $(date +%Y-%m-%dT%H:%M:%S%z)
- **Backtracks / redone work:** <where you backtracked or redid work this phase — or "None.">
- **Missing / wrong / hard-to-find context:** <context that was absent, stale, or hard to locate — or "None.">
- **If I'd known:** <the ADR / guidance / past learning that would have saved this — the compounding signal — or "None.">
EOF
```

```bash
# CTL-866: multi-host thoughts-sync gate. Single-host → exact no-op. Multi-host
# → commit+push the plan artifact before any other host can read the
# completion event; on sync failure the gate emits `failed` and we stop here.
"${PLUGIN_ROOT}/scripts/lib/thoughts-sync-gate.sh" --phase "$PHASE" --ticket "$TICKET" || exit 11

"${PLUGIN_ROOT}/scripts/phase-agent-emit-complete" \
  --phase "$PHASE" --ticket "$TICKET" --status complete

# Self-halt after complete to prevent zombie workers (CTL-778 step 2).
# Read our own bg_job_id from the signal file and ask Claude to stop us.
# Best-effort: a failed stop is covered by the daemon reaper backstop.
if [[ -n "${ORCH_DIR:-}" && -f "${ORCH_DIR}/workers/${TICKET}/phase-${PHASE}.json" ]]; then
  _SELF_BG=$(jq -r '.bg_job_id // empty' \
    "${ORCH_DIR}/workers/${TICKET}/phase-${PHASE}.json" 2>/dev/null || true)
  [[ -n "$_SELF_BG" ]] && claude stop "${_SELF_BG:0:8}" >/dev/null 2>&1 || true
fi

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
