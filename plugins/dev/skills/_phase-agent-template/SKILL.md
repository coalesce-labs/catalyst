---
name: _phase-agent-template
description: |
  Reference template every phase-agent skill copies (CTL-448). The leading
  underscore + the disable/non-invocable flags below prevent the skill loader
  from picking this up — it is NOT a runnable skill, only a structural
  template the nine real phase agents (phase-triage, phase-research, phase-plan,
  phase-implement, phase-verify, phase-review, phase-pr, phase-monitor-merge,
  phase-monitor-deploy) clone and specialize.
disable-model-invocation: true
user-invocable: false
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Edit
  - Write
---

# _phase-agent-template

This is the structural template for every phase agent in Initiative 1
(plan §"Phase-agent architecture"). It is NOT itself a skill — phase-N
SKILL.md files copy this skeleton and fill in the placeholders marked with
`{{...}}`. The leading underscore on this directory keeps the skill loader
from registering it, and the `disable-model-invocation: true` /
`user-invocable: false` flags are belt-and-suspenders.

## Contract

Every phase agent:

1. Joins the shared `orch-${CATALYST_ORCHESTRATOR_ID}` comms channel at entry
2. Reads the **prior phase artifact** (see lookup table in
   `plugins/dev/scripts/phase-agent-dispatch`) — abort if missing.
3. Starts a `catalyst-session` and writes per-phase status updates.
4. Does the phase-specific work — delegates to a canonical skill via the
   Task tool wherever possible. See plan §"Phase agents wrap canonical
   skills" for the mapping.
5. On exit, calls `plugins/dev/scripts/phase-agent-emit-complete` which:
   - Emits the canonical `phase.<name>.{complete,failed}.<ticket>` event
     (broker `phase_lifecycle` route — CTL-447).
   - Updates `${ORCH_DIR}/workers/<TICKET>/phase-<name>.json`.
   - Calls `catalyst-session.sh end`.

## Required env vars

The dispatcher (`plugins/dev/scripts/phase-agent-dispatch`) sets these on
the spawned `claude --bg` process. The phase agent reads them at startup:

| Var | Meaning |
|---|---|
| `CATALYST_ORCHESTRATOR_DIR` | Where signal files live (`workers/<TICKET>/phase-<name>.json`) |
| `CATALYST_ORCHESTRATOR_ID`  | Broker session correlation + comms channel suffix |
| `CATALYST_PHASE`            | This phase's name (matches the skill suffix) |
| `CATALYST_TICKET`           | The ticket this phase agent owns |

## Prelude (every phase agent copies this verbatim)

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
CHANNEL="orch-${ORCH_ID}"

SIGNAL_FILE="${ORCH_DIR}/workers/${TICKET}/phase-${PHASE}.json"
[[ -f "$SIGNAL_FILE" ]] || { echo "phase-${PHASE}: signal file missing" >&2; exit 1; }

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-/Users/ryan/.claude/plugins/cache/catalyst/catalyst-dev/$(jq -r .version "${CLAUDE_PLUGIN_ROOT:-.}/.claude-plugin/plugin.json" 2>/dev/null || echo 0.0.0)}"

# 1. Join the shared comms channel (best-effort — phase agents must not crash
#    if catalyst-comms is unavailable).
COMMS="${PLUGIN_ROOT}/scripts/catalyst-comms"
[[ -x "$COMMS" ]] || COMMS="$(command -v catalyst-comms 2>/dev/null || true)"
if [[ -n "$COMMS" ]]; then
  "$COMMS" join "$CHANNEL" --as "$TICKET" \
    --capabilities "phase-${PHASE}: ${TICKET}" \
    --orch "$ORCH_ID" --parent orchestrator --ttl 3600 >/dev/null 2>&1 || true
  "$COMMS" send "$CHANNEL" "phase-${PHASE} started" --as "$TICKET" --type info \
    --orch "$ORCH_ID" >/dev/null 2>&1 || true
fi

# 2. Start a catalyst-session (cost / token instrumentation).
SESSION_SCRIPT="${PLUGIN_ROOT}/scripts/catalyst-session.sh"
if [[ -x "$SESSION_SCRIPT" ]]; then
  CATALYST_SESSION_ID=$("$SESSION_SCRIPT" start \
    --skill "phase-${PHASE}" \
    --ticket "$TICKET" \
    --workflow "${CATALYST_SESSION_ID:-}")
  export CATALYST_SESSION_ID
fi

# 3. Mark the signal file as "running" + record the start timestamp.
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TMP="${SIGNAL_FILE}.tmp.$$"
jq --arg ts "$TS" '.status = "running" | .updatedAt = $ts' "$SIGNAL_FILE" > "$TMP" \
  && mv "$TMP" "$SIGNAL_FILE"
```

## /goal condition

Every phase agent declares a `/goal` line at the top of its phase-specific
work block. The condition MUST be transcript-evaluable and reference the
artifact this phase produces (per the lookup table in `phase-agent-dispatch`).
Example for `phase-research`:

```
/goal "I have written thoughts/shared/research/<date>-${TICKET,,}.md
       with valid frontmatter and at least 10 file:line references AND I
       have printed the path + a confirmation line; OR I have stopped
       after 35 turns and printed what's done."
```

Turn caps come from `.catalyst/config.json:catalyst.orchestration.phaseAgents.turnCaps.<phase>`
with per-phase defaults baked into `phase-agent-dispatch`.

## Comms discipline (CTL-448)

Outbound message types — phase agent → orchestrator:

| Type        | When                                           | Cadence per session |
|-------------|-----------------------------------------------|---------------------|
| `info`      | Phase started / phase work milestones          | 3–5 |
| `attention` | Scope conflict, missing access, repeated failures, stalled | 0–2 |
| `question`  | Specific clarification needed (msg_id is correlation key) | 0–1 |
| `done`      | Terminal success (emitted by phase-agent-emit-complete) | 1 |

Inbound message types — orchestrator → phase agent (reads on every loop tick):

| Type        | Effect                                                       |
|-------------|-------------------------------------------------------------|
| `directive` | Answer to a previously-posted `question` (correlated via `.re` field). Phase agent uses the answer and proceeds. |
| `pause`     | Halt and poll. Resumes on `directive` or `info` resume signal. |
| `abort`     | Phase agent cleans up, calls phase-agent-emit-complete with `--status failed --reason aborted_by_orchestrator`, exits. |

Use the helper functions in `plugins/dev/scripts/catalyst-comms` directly —
do NOT reimplement send/poll logic per phase. The contract tests live in
`plugins/dev/scripts/__tests__/phase-agent-comms.test.sh`.

## Phase-specific work block (TEMPLATE)

```text
/goal "{{ transcript-evaluable goal condition for this phase }}"

{{ Phase-specific instructions. The actual work delegates to the canonical
   skill (e.g., /catalyst-dev:research-codebase) via the Task tool wherever
   possible. See plan §"Phase agents wrap canonical skills" for the mapping. }}
```

## End block (every phase agent copies this verbatim)

```bash
# Drain inbound comms one last time before emitting the complete event so
# we don't miss an abort sent in the final seconds.
if [[ -n "$COMMS" ]]; then
  COMMS_CHANNEL_FILE="${CATALYST_DIR:-$HOME/catalyst}/comms/channels/${CHANNEL}.jsonl"
  # (intentionally lightweight — full inbound handling is the prelude's job)
fi

# Emit phase-complete event + close signal file + end session.
EMIT="${PLUGIN_ROOT}/scripts/phase-agent-emit-complete"
if [[ -x "$EMIT" ]]; then
  "$EMIT" --phase "$PHASE" --ticket "$TICKET" --status complete
fi

# Best-effort: post done to the comms channel (final).
[[ -n "$COMMS" ]] && "$COMMS" done "$CHANNEL" --as "$TICKET" >/dev/null 2>&1 || true
```

## Failure handling

Any non-recoverable failure (turn cap hit, prior artifact missing, scope
conflict that the orchestrator cannot resolve):

```bash
"$EMIT" --phase "$PHASE" --ticket "$TICKET" --status failed \
  --reason "{{ short human-readable reason }}"
[[ -n "$COMMS" ]] && "$COMMS" send "$CHANNEL" "phase-${PHASE} failed: {{reason}}" \
  --as "$TICKET" --type attention --orch "$ORCH_ID" >/dev/null 2>&1 || true
exit 1
```

The orchestrator's Phase 4 monitor receives the `phase.<name>.failed.<ticket>`
event via the broker `phase_lifecycle` route and dispatches a fix-up phase
agent (same skill, `--resume` flag, prompt seeded with the prior failure
context). One retry; second failure escalates to user via `attention`.

## Why this is a template and not a base skill

Claude Code skills don't support inheritance — each SKILL.md is its own
unit. The template lives here so phase agents stay synchronized at edit
time (when adding a new phase, copy this file, fill in the placeholders),
not at runtime. If the contract changes, every phase SKILL.md needs to be
manually re-aligned — there is no automatic propagation.
