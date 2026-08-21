# The /goal condition, the end block, and failure handling

Read this when writing a phase agent's exit path.

⛔ Assign every variable the end block uses BEFORE the phase-specific work, not inside
the end block. `phase-monitor-merge` assigned `EMIT` in its terminal block while using it
~240 lines earlier; under `set -u` that aborts the shell, so the branch emitted nothing and
the run was recorded as an undeclared abandonment (CTL-1998). The failure-handling fence is
a SEPARATE bash block — anything it references must already exist.

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

