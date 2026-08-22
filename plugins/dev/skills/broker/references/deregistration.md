# Deregistration, Querying Agent State, and Broker Fallback

_Read this when explicitly deregistering an interest, querying the broker's SQLite agent table,
or when the broker is not running and you need a direct wait-for fallback._

## 7. Deregistration

```bash
jq -nc --arg sid "$CATALYST_SESSION_ID" \
  '{ts: (now | todate), event: "filter.deregister",
    detail: {interest_id: $sid}}' >> $(ls -t ~/catalyst/events/*.jsonl | head -1)
```

Auto-deregistration happens on:
- `agent.checkout` for auto-correlated interests
- Orchestrator termination (`orchestrator-completed` / `orchestrator-failed`)
- One-shot interests after their first wake
- Watchdog stale-session cleanup

## 8. Querying Agent State

The broker persists agent identity to SQLite (`~/catalyst/filter-state.db`). You can query it:

```bash
sqlite3 ~/catalyst/filter-state.db \
  "SELECT agent_name, ticket, claimed_pr, status FROM agents WHERE status = 'active';"
```

## 9. Fallback When Broker Is Not Running

```bash
if ! catalyst-broker status | grep -q "^running"; then
  # jq direct wait — no broker, no Groq
  EVENT=$(catalyst-events wait-for \
    --filter ".attributes.\"vcs.pr.number\" == ${PR_NUMBER}" \
    --timeout 300 2>/dev/null || true)
fi
```
