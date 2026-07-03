---
name: _phase-agent-template
description: |
  Reference template every phase-agent skill copies (CTL-448). The leading
  underscore on the directory name prevents the skill loader from picking this
  up — it is NOT a runnable skill, only a structural template the nine real
  phase agents (phase-triage, phase-research, phase-plan, phase-implement,
  phase-verify, phase-review, phase-pr, phase-monitor-merge, phase-monitor-deploy)
  clone and specialize. The real phase skills MUST set `user-invocable: true`
  so `phase-agent-dispatch`'s `claude --bg "/catalyst-dev:phase-X ..."` slash
  command resolves (CTL-490).
user-invocable: true
disable-model-invocation: false  # invocable by model (Skill tool) AND user (slash command)
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
from registering it. The real phase skills set `user-invocable: true` because
`phase-agent-dispatch` spawns them via `claude --bg "/catalyst-dev:phase-X ..."` —
the bg session parses that as a user slash command (CTL-490).

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

6. **Linear reads → local replica.** For a single-ticket read call
   `linear_read_ticket <ID>` (never a bare `linearis issues read <ID>` — it 429s
   the shared quota); writes and list/search stay on `linearis`. See the `linearis`
   skill's "Reading Linear".

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

# 0. Codified bg_job_id yield (CTL-615). If the signal file's bg_job_id
#    names a DIFFERENT live bg job, we are a redispatch duplicate of a
#    still-running canonical worker. Bow out without touching the signal,
#    without emitting any phase event. The helper writes a yield sidecar
#    `${ORCH_DIR}/workers/${TICKET}/.phase-${PHASE}-yield` so the
#    operator/daemon can attribute the no-op. Exit 0 by design — this is
#    NOT a failure; the canonical worker keeps running.
YIELD_CHECK="${PLUGIN_ROOT}/scripts/phase-agent-yield-check.sh"
if [[ -x "$YIELD_CHECK" ]] && bash "$YIELD_CHECK" \
     --signal "$SIGNAL_FILE" \
     --phase "$PHASE" \
     --worker-dir "$(dirname "$SIGNAL_FILE")"; then
  echo "phase-${PHASE}: yielding to canonical worker (CTL-615)" >&2
  exit 0
fi

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

# 3. Mark the signal file as "running" + record the start timestamp +
#    persist catalystSessionId (CTL-496: orchestrate-roll-usage --phase
#    reads this to attribute cost to the right session_metrics row without
#    relying on the ticket+skill_name DB-lookup heuristic).
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TMP="${SIGNAL_FILE}.tmp.$$"
jq --arg ts "$TS" --arg sid "${CATALYST_SESSION_ID:-}" '
  .status = "running"
  | .updatedAt = $ts
  | if $sid != "" then .catalystSessionId = $sid else . end
' "$SIGNAL_FILE" > "$TMP" \
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

# Self-halt after complete to prevent zombie workers (CTL-778 step 2).
# Read our own bg_job_id from the signal file and ask Claude to stop us.
# Best-effort: a failed stop is covered by the daemon reaper backstop.
if [[ -n "${ORCH_DIR:-}" && -f "${ORCH_DIR}/workers/${TICKET}/phase-${PHASE}.json" ]]; then
  _SELF_BG=$(jq -r '.bg_job_id // empty' \
    "${ORCH_DIR}/workers/${TICKET}/phase-${PHASE}.json" 2>/dev/null || true)
  [[ -n "$_SELF_BG" ]] && claude stop "${_SELF_BG:0:8}" >/dev/null 2>&1 || true
fi

# Best-effort: post done to the comms channel (final).
[[ -n "$COMMS" ]] && "$COMMS" done "$CHANNEL" --as "$TICKET" >/dev/null 2>&1 || true
```

## Structured escalation explanation (CTL-1130)

Whenever a phase writes a failed/stalled signal that will be shown to the
operator (e.g. via the Inbox "Needs you" section), it MUST populate an
`explanation` block alongside `failureReason`. The contract is a **tagged
union** discriminated by `escalation_type`:

```json
// MANUAL: the agent physically cannot execute any path (missing credential/scope)
{
  "escalation_type": "manual",
  "problem":              "<specific symptom>",
  "call_to_action":       "<one specific, answerable question for the operator>",
  "blocked_capability":   "<what the agent cannot do>",
  "instructions":         ["<step 1>", "<step 2>"],
  "remediation_then_retry": "<what to do then re-run>",
  "why_not_auto":         "<concrete capability boundary — not a vague phrase>"
}

// AUTHORIZATION: agent can act; only risk/blast-radius stops it
{
  "escalation_type": "authorization",
  "problem":                    "<specific symptom>",
  "call_to_action":             "<one specific, answerable question>",
  "recommendation":             "<what the agent recommends>",
  "risk":                       "<concrete risk — not a vague phrase>",
  "why_asking":                 "<risk-authority gate, not a capability gap>",
  "could_higher_tier_resolve":  false,
  "authorize_label":            "<short label for the authorize button>"
}

// DECISION: 2+ non-dominated paths; tie-break is human preference
{
  "escalation_type": "decision",
  "problem":      "<specific symptom>",
  "call_to_action": "<one specific, answerable question>",
  "options":      [{"label":"<choice>","tradeoff":"<what is risked/lost>"}],
  "why_you":      "<why the agent cannot compute the tie-break>"
}
```

All types accept optional `observed` (object) and `attempts` (array)
passthrough fields.

Use the CLI shim so the shell can build the JSON without risk of syntax
errors or missing fields:

```bash
# MANUAL example (push rejected — workflow OAuth scope missing)
EXPL_JSON="$(node "${PLUGIN_ROOT}/scripts/execution-core/escalation-explain.mjs" \
  --ticket "$TICKET" --phase "$PHASE" \
  --type manual \
  --problem "{{ specific symptom }}" \
  --call-to-action "{{ specific question for the operator }}" \
  --blocked-capability "{{ what the agent cannot do }}" \
  --instructions '["{{ step 1 }}","{{ step 2 }}"]' \
  --remediation-then-retry "{{ what to do, then re-run }}" \
  --why-not-auto "{{ concrete capability boundary }}" \
  --can-execute false \
  --observed "$(jq -nc '{key:"value"}' 2>/dev/null || echo '{}')" \
  2>/dev/null || echo '{}')"

# AUTHORIZATION example (restart with risk)
EXPL_JSON="$(node "${PLUGIN_ROOT}/scripts/execution-core/escalation-explain.mjs" \
  --ticket "$TICKET" --phase "$PHASE" \
  --type authorization \
  --problem "{{ specific symptom }}" \
  --call-to-action "{{ specific question }}" \
  --recommendation "{{ what to do }}" \
  --risk "{{ concrete risk — specific file/line/data at stake }}" \
  --why-asking "risk-authority gate, not a capability gap" \
  --authorize-label "{{ short label }}" \
  --could-higher-tier-resolve false \
  --can-execute true \
  2>/dev/null || echo '{}')"

# DECISION example (multiple non-dominated paths)
EXPL_JSON="$(node "${PLUGIN_ROOT}/scripts/execution-core/escalation-explain.mjs" \
  --ticket "$TICKET" --phase "$PHASE" \
  --type decision \
  --problem "{{ specific symptom }}" \
  --call-to-action "{{ specific question }}" \
  --options '[{"label":"{{ choice A }}","tradeoff":"{{ what is risked }}"},{"label":"{{ choice B }}","tradeoff":"{{ what is lost }}"}]' \
  --why-you "{{ why the agent cannot compute the tie-break }}" \
  2>/dev/null || echo '{}')"
```

Then merge it into the signal alongside `failureReason`. Guard the value on a
prior line and pass the variable directly — never inline `${EXPL_JSON:-{}}`: the
bash parser closes the parameter expansion at the FIRST `}`, so a non-empty value
like `{"a":1}` expands to `{"a":1}}` (trailing brace → invalid JSON → jq exits
non-zero → the `&& mv` is skipped and the signal is never written). Verified in
bash 3.2 and 5.x.

```bash
[ -n "$EXPL_JSON" ] || EXPL_JSON='{}'
jq --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson expl "$EXPL_JSON" \
   '.status = "failed" | .failureReason = "{{ reason }}" | .explanation = $expl | .updatedAt = $ts' \
   "$SIGNAL_FILE" > "$SIGNAL_FILE.tmp.$$" && mv "$SIGNAL_FILE.tmp.$$" "$SIGNAL_FILE"
```

### Banned call_to_action phrases (tautology gate)

The CLI shim rejects these with `degraded: true` and substitutes a
generic fallback. Never write:

- "needs a human" / "requires human intervention" / "needs human review"
- "a human must decide" / "someone must decide"
- "escalate to operator" / "escalate to human"
- "requires intervention" / "requires action" (bare)
- "needs attention" (bare)

Write the **specific question** instead:
- Bad: "this phase needs human attention"
- Good: "should the rebase conflict in foo/bar.ts be resolved by discarding
  the local change or by cherry-picking the remote version?"

### Banned risk / why_not_auto phrases (RISK_VAGUE_RE)

These vague bare platitudes are also rejected (anchored `^…$` — a concrete
sentence that *contains* one of these phrases is accepted):

- "involves trade-offs" (bare)
- "no single fix path" / "no single automated fix path…"
- "requires human judgment" / "requires human judgement"

Write a **concrete** risk instead:
- Bad: "involves trade-offs"
- Good: "restarting discards 42 minutes of elapsed work and 0 commits on the CTL-1 branch"

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
