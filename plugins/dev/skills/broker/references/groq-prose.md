# Groq Prose Registration (Env-gated off — CTL-357)

_Read this when you need fuzzy / multi-condition interest matching and have confirmed the
deterministic interest types cannot cover the use case._

> **Off by default.** `CATALYST_BROKER_PROSE_ENABLED=0` is the new default. Empirical evidence
> (`orch-ctl-352-354-2026-05-12`) showed a ~95% false-positive rate on prose wakes — every
> session heartbeat, every unrelated Linear ticket change, and every info comms post matched
> nominally narrow interests. Prose interests already on disk are loaded but never matched against
> events. On startup, if any prose interests are found, the broker emits a single
> `broker.daemon.prose_disabled` info event so the operator can see them at a glance.
>
> Set `CATALYST_BROKER_PROSE_ENABLED=1` in the environment when launching the daemon to re-enable
> Groq classification for prompt-based interests. Prefer the deterministic types
> (`pr_lifecycle`, `ticket_lifecycle`, `comms_lifecycle`) for anything routine.

For complex / multi-condition interests that genuinely need fuzzy matching, register with a
natural-language prompt:

```bash
jq -nc \
  --arg orch "${CATALYST_ORCHESTRATOR_ID:-}" \
  --arg sid "$CATALYST_SESSION_ID" \
  '{ts: (now | todate), event: "filter.register",
    orchestrator: $orch,
    worker: null,
    detail: {
      interest_id: $sid,
      notify_event: ("filter.wake." + $sid),
      prompt: "Wake me when any of my workers has a CI failure or gets changes-requested",
      context: {pr_numbers: [501, 502], tickets: ["CTL-275", "CTL-276"]},
      persistent: true
    }}' >> ~/catalyst/events/$(date -u +%Y-%m).jsonl
```

Requires `GROQ_API_KEY` or `groq.apiKey` in `~/.config/catalyst/config.json`.
