# phase_lifecycle Interest Type (CTL-447)

_Read this when an orchestrator needs to wake on phase-agent boundary events (complete / failed /
turn-cap-exhausted) to advance a ticket through the pipeline._

Deterministic routing for phase-agent boundary events. The orchestrator subscribes once per
ticket per set of phases and is woken when a phase agent emits its terminal event:

- `phase.<name>.complete.<ticket>` — phase succeeded; orchestrator dispatches the next one.
- `phase.<name>.failed.<ticket>` — phase failed; orchestrator runs the fix-up path.
- `phase.<name>.turn-cap-exhausted.<ticket>` (CTL-484) — phase agent self-stopped at its `/goal` turn cap; orchestrator dispatches a continuation worker on a separate budget (the agent has already written a handoff at `body.payload.handoff_path`).

The match is keyed on `(ticket, phase_name)` so a single orchestrator can run many tickets
in parallel without cross-talk.

## Schema

```json
{
  "interest_id": "<orch-id>",
  "interest_type": "phase_lifecycle",
  "notify_event": "filter.wake.<orch-id>",
  "persistent": true,
  "ticket": "CTL-100",
  "phase_names": ["triage", "research", "plan", "implement", "validate", "ship"]
}
```

## Registering

```bash
jq -nc \
  --arg orch "${CATALYST_ORCHESTRATOR_ID}" \
  --arg ticket "$TICKET_ID" \
  --argjson phases '["triage","research","plan","implement","validate","ship"]' \
  '{ts: (now | todate), event: "filter.register",
    orchestrator: $orch,
    worker: null,
    detail: {
      interest_id: $orch,
      interest_type: "phase_lifecycle",
      notify_event: ("filter.wake." + $orch),
      persistent: true,
      ticket: $ticket,
      phase_names: $phases
    }}' >> $(ls -t ~/catalyst/events/*.jsonl | head -1)
```

## Match logic (no Groq call)

| Trigger | Condition |
|---|---|
| `event.name` matches `phase.<name>.(complete\|failed\|turn-cap-exhausted).<ticket>` | always required |
| `<ticket>` == `reg.ticket` | required |
| `<name>` ∈ `reg.phase_names` | required |
