---
name: phase-research
description: |
  Phase agent for the research step of the 9-phase orchestrator pipeline (CTL-450).
  Wraps /catalyst-dev:research-codebase and produces
  thoughts/shared/research/<date>-<ticket>.md, then emits phase.research.complete.<ticket>.
  Reads triage.json from the worker dir as its prior-phase artifact.
  Spawned via plugins/dev/scripts/phase-agent-dispatch, which invokes it via
  slash command — hence `user-invocable: true`.
user-invocable: true
disable-model-invocation: false  # invocable by model (Skill tool) AND user (slash command)
allowed-tools:
  - Read
  - Write
  - Grep
  - Glob
  - Task
  - Bash
---

# phase-research

You are the **research phase agent**. You run inside `claude --bg` and own a single
responsibility: produce `thoughts/shared/research/<date>-<ticket>.md` that meets the
schema enforced by [[research-codebase]], then emit
`phase.research.complete.<ticket>` and exit. Built on the [[_phase-agent-template]]
contract.

You are a documentarian, not a critic. Document what EXISTS. No suggestions for
improvements. No architectural critiques.

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

# Join the shared comms channel (best-effort).
COMMS="${PLUGIN_ROOT}/scripts/catalyst-comms"
[[ -x "$COMMS" ]] || COMMS="$(command -v catalyst-comms 2>/dev/null || true)"
if [[ -n "$COMMS" ]]; then
  "$COMMS" join "$CHANNEL" --as "$TICKET" \
    --capabilities "phase-${PHASE}: ${TICKET}" \
    --orch "$ORCH_ID" --parent orchestrator --ttl 3600 >/dev/null 2>&1 || true
  "$COMMS" send "$CHANNEL" "phase-research started" --as "$TICKET" --type info \
    --orch "$ORCH_ID" >/dev/null 2>&1 || true
fi

# Start a catalyst-session for cost/token instrumentation.
SESSION_SCRIPT="${PLUGIN_ROOT}/scripts/catalyst-session.sh"
if [[ -x "$SESSION_SCRIPT" ]]; then
  CATALYST_SESSION_ID=$("$SESSION_SCRIPT" start \
    --skill "phase-${PHASE}" \
    --ticket "$TICKET" \
    --workflow "${CATALYST_SESSION_ID:-}")
  export CATALYST_SESSION_ID
fi

# Mark signal file running + persist catalystSessionId (CTL-496).
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TMP="${SIGNAL_FILE}.tmp.$$"
jq --arg ts "$TS" --arg sid "${CATALYST_SESSION_ID:-}" '
  .status = "running"
  | .updatedAt = $ts
  | if $sid != "" then .catalystSessionId = $sid else . end
' "$SIGNAL_FILE" > "$TMP" \
  && mv "$TMP" "$SIGNAL_FILE"

# Read the prior-phase artifact (triage.json). The dispatcher already gated this,
# so the file MUST exist — fail loudly if not (race condition / out-of-band run).
TRIAGE_FILE="${ORCH_DIR}/workers/${TICKET}/triage.json"
if [[ ! -f "$TRIAGE_FILE" ]]; then
  echo "phase-research: prior triage.json missing at $TRIAGE_FILE" >&2
  "${PLUGIN_ROOT}/scripts/phase-agent-emit-complete" \
    --phase "$PHASE" --ticket "$TICKET" --status failed \
    --reason "prior_artifact_missing:triage.json"
  exit 1
fi
TRIAGE_SUMMARY=$(jq -r '.summary // .classification // ""' "$TRIAGE_FILE" 2>/dev/null || echo "")
```

<!-- Linear status is written by the coordinator (CTL-558): the execution-core
     scheduler / orchestrate-phase-advance applies the mapped state on every
     committed phase transition. The phase agent no longer transitions Linear. -->

## /goal

```
/goal "I have written thoughts/shared/research/<date>-${ticket-lower}.md with valid
       frontmatter, a 'Summary' section, a 'Findings' section containing at least 10
       file:line references, and a 'References' section linking related thoughts/plans.
       I have printed the path on stdout."
```

Replace `<date>` with `$(date -u +%Y-%m-%d)` and `<ticket-lower>` with the lowercased
`$TICKET` (`ctl-450` for `CTL-450`).

## Work block

Conduct the research by **invoking the canonical skill** rather than reimplementing
it. The body of [[research-codebase]] is the single source of truth for how research
is performed.

1. Read the Linear ticket via `linearis issues read $TICKET --with-attachments` to
   get the title, description, and any linked plan reference.
2. Read the triage summary from `$TRIAGE_FILE` to understand classification and
   surfaced dependencies.
3. **Pull-before-read (CTL-1236).** Fast-forward all thoughts checkouts so reads
   pick up the freshest peer state. Roster-gated, ff-only, non-fatal — skips on
   single-host setups, never blocks research if offline:
   ```bash
   # Pull-before-read (CTL-1236): roster-gated, ff-only, non-fatal.
   "${PLUGIN_ROOT}/scripts/lib/thoughts-pull-sync-gate.sh" || true
   ```
4. **Relevant Past Learnings lens (compound loop, CTL-789).** BEFORE the
   `/catalyst-dev:research-codebase` fan-out, grep the shared learnings store for
   prior problem→solution entries that touch this ticket's area, so the research
   inherits hard-won context instead of rediscovering it. Pick 2–5 keywords from
   the ticket + triage summary (component, feature, error type) and run:
   ```bash
   LEARN_DIR="thoughts/shared/learnings"
   if [ -d "$LEARN_DIR" ]; then
     rg -li "<2-5 keywords from the ticket: component, feature, error type>" "$LEARN_DIR"/**/*.md 2>/dev/null
   fi
   ```
   For each hit, read the frontmatter (`component` / `tags` / `problem_type` — see
   `plugins/dev/skills/ticket-compound/reference.md` for the schema) and keep
   only entries whose `component` matches this ticket's component. Inject a short
   `## Relevant Past Learnings` section **near the TOP of the research doc** (right
   under the Summary), one line per applicable entry as
   `title — path — one-line guidance`. Write `None found.` when the store is empty
   or nothing matches. The store may not exist yet — the `-d` guard above makes this
   best-effort; NEVER block research on an empty store.
5. Assert the `thoughts/` root belongs to this project before writing (CTL-1081):
   ```bash
   bash "${PLUGIN_ROOT}/scripts/lib/assert-thoughts-project.sh" || {
     "${PLUGIN_ROOT}/scripts/phase-agent-emit-complete" \
       --phase "$PHASE" --ticket "$TICKET" --status failed \
       --reason "wrong_project_thoughts_root"
     exit 1
   }
   ```
6. Invoke `/catalyst-dev:research-codebase` against the ticket's research question.
   That skill spawns parallel sub-agents, synthesizes findings, and writes the
   document. Do not duplicate its logic.
7. Confirm the artifact exists at the expected path before continuing.
   Use the shared slug-tolerant matcher from lib/phase-artifact-gate.sh (CTL-1081):
   ```bash
   source "${PLUGIN_ROOT}/scripts/lib/phase-artifact-gate.sh"
   RESEARCH_DOC="$(match_thoughts_artifact thoughts/shared/research "$TICKET" | tail -1 || true)"
   [[ -n "$RESEARCH_DOC" && -f "$RESEARCH_DOC" ]] || {
     "${PLUGIN_ROOT}/scripts/phase-agent-emit-complete" \
       --phase "$PHASE" --ticket "$TICKET" --status failed \
       --reason "research_doc_not_written"
     exit 1
   }
   ```

If [[research-codebase]] hits a question it cannot resolve, post a `question` comms
message and continue with the best-effort answer — do not block the pipeline.

### Inbox check (CTL-749)

After `/catalyst-dev:research-codebase` Task returns, check for mid-flight context updates from the human:

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
# Update the signal file with the artifact path so downstream phases can find it.
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TMP="${SIGNAL_FILE}.tmp.$$"
jq --arg ts "$TS" --arg doc "$RESEARCH_DOC" \
  '.updatedAt = $ts | .artifact = $doc' \
  "$SIGNAL_FILE" > "$TMP" && mv "$TMP" "$SIGNAL_FILE"
```

Mirror the phase output to Linear as a single comment (CTL-632). Fail-open
(a failed Linear post must not break the phase) and idempotent (re-walks
after orchestrator restart skip already-posted phases via a marker file).
The fence is uniquely named so the e2e test can extract just this block.

```bash phase-research-mirror
LINEAR_MIRROR_MARKER="${ORCH_DIR}/workers/${TICKET}/.linear-mirror-${PHASE}"
if [[ ! -e "${LINEAR_MIRROR_MARKER}" ]]; then
  RESEARCH_TITLE="$(awk '/^# /{print; exit}' "${RESEARCH_DOC}" | sed 's/^# //')"
  RESEARCH_SUMMARY="$(awk '/^## Summary/{flag=1; next} /^## /{flag=0} flag && NF' "${RESEARCH_DOC}" | head -5)"
  MIRROR_BODY="$(cat <<EOF
**Phase Research**

- **Document**: \`${RESEARCH_DOC}\`
- **Title**: ${RESEARCH_TITLE:-_untitled_}

<details>
<summary>Summary preview</summary>

${RESEARCH_SUMMARY}

</details>

_Posted automatically by phase-research (CTL-632)._
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
  if [[ -n "$COMMENT_POST" && -x "$COMMENT_POST" ]] && "$COMMENT_POST" "${TICKET}" "${MIRROR_BODY}" >/dev/null; then
    : > "${LINEAR_MIRROR_MARKER}"
  else
    echo "phase-research: linear-comment-post failed (continuing)" >&2
  fi
fi
```

## Step N — Capture friction (compound loop, CTL-789)

IMMEDIATELY before emitting `phase.research.complete`, append this phase's friction
to the shared per-ticket friction log. This is the PRODUCER half of the compound
loop — what `ticket-compound` Step 1 later harvests. Replace each `<…>` placeholder
below with your real experience THIS phase (terse, 3–6 lines total); `None.` is a
valid value for any bullet when the phase ran frictionless. `${TICKET}` is already
resolved in the Prelude — do not re-derive it. This append is best-effort and OFF
the critical path: it must NEVER fail the phase.

```bash
# --- Compound-engineering friction capture (CTL-789, Slice 1). Off critical path; NEVER block emit. ---
FRICTION_LOG="thoughts/shared/friction/${TICKET}.md"
mkdir -p "$(dirname "$FRICTION_LOG")"
[ -f "$FRICTION_LOG" ] || printf '# Friction log — %s\n' "${TICKET}" > "$FRICTION_LOG"
cat >> "$FRICTION_LOG" <<EOF

## research · ${TICKET} · $(date +%Y-%m-%dT%H:%M:%S%z)
- **Backtracks / redone work:** <where you backtracked or redid work this phase — or "None.">
- **Missing / wrong / hard-to-find context:** <context that was absent, stale, or hard to locate — or "None.">
- **If I'd known:** <the ADR / guidance / past learning that would have saved this — the compounding signal — or "None.">
EOF
```

The record header `## <phase> · <TICKET> · <ISO-8601 timestamp>` is a CROSS-PHASE
contract — keep it byte-identical across all five phase skills (only the `research`
label differs here). The `$(date +%Y-%m-%dT%H:%M:%S%z)` stamp carries DATE+TIME+offset
(e.g. `2026-06-06T14:23:01+0900`); do NOT drop to date-only — the morning briefing /
daily review sorts "friction since last review" by this per-record timestamp.

```bash
# CTL-866: multi-host thoughts-sync gate. Single-host → exact no-op. Multi-host
# → commit+push the research artifact before any other host can read the
# completion event; on sync failure the gate emits `failed` and we stop here.
"${PLUGIN_ROOT}/scripts/lib/thoughts-sync-gate.sh" --phase "$PHASE" --ticket "$TICKET" || exit 11

# Emit phase-complete event, close signal file, end catalyst-session.
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

# Final comms send.
[[ -n "$COMMS" ]] && "$COMMS" done "$CHANNEL" --as "$TICKET" >/dev/null 2>&1 || true
```

## Failure handling

Any non-recoverable failure (turn cap hit, [[research-codebase]] returns no document,
prior-artifact gate fails after dispatcher race):

```bash
"${PLUGIN_ROOT}/scripts/phase-agent-emit-complete" \
  --phase "$PHASE" --ticket "$TICKET" --status failed \
  --reason "<short human-readable reason>"
[[ -n "$COMMS" ]] && "$COMMS" send "$CHANNEL" \
  "phase-research failed: <reason>" --as "$TICKET" --type attention \
  --orch "$ORCH_ID" >/dev/null 2>&1 || true
exit 1
```

The orchestrator's Phase 4 monitor receives the failed event via the broker
`phase_lifecycle` route and dispatches a fix-up phase agent (one retry, then
escalates to user via `attention`).
