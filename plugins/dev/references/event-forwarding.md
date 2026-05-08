# Event Forwarding Reference

The `catalyst-otel-forward` daemon tails the canonical Catalyst event JSONL log and fans out
events in parallel to OTLP/HTTP, PostHog, and Cloudflare Analytics Engine.

## Architecture

```
~/catalyst/events/YYYY-MM.jsonl
         │
         ▼ (byte-offset tail, 200ms poll)
  catalyst-otel-forward
         │
    ┌────┼────────────────┐
    ▼    ▼                ▼
  OTLP  PostHog    Cloudflare AE
  /v1/logs  /batch   datasets/{name}
    │    │                │
    └────┴────────────────┘
         │ (all independent — one failure never blocks others)
         ▼
  ~/catalyst/otel-forward-dlq-{dest}.jsonl  (dead-letter queue)
```

Only canonical events (lines with a top-level `attributes` key, per CTL-300) are forwarded.
Legacy format lines are skipped.

## Configuration

Config lives in `~/.config/catalyst/config-{projectKey}.json` under
`catalyst.observability.forwarders`. All forwarders are disabled by default.

### OTLP

```json
{
  "catalyst": {
    "observability": {
      "forwarders": {
        "otlp": {
          "enabled": true,
          "endpoint": "http://localhost:4318",
          "batchSize": 100,
          "flushIntervalMs": 5000
        }
      }
    }
  }
}
```

The `OTEL_EXPORTER_OTLP_ENDPOINT` environment variable overrides `endpoint` (port 4317 is
automatically rewritten to 4318 for HTTP).

### PostHog

```json
{
  "catalyst": {
    "observability": {
      "forwarders": {
        "posthog": {
          "enabled": true,
          "apiKey": "phc_YOUR_API_KEY",
          "host": "https://us.i.posthog.com",
          "batchSize": 50,
          "flushIntervalMs": 10000
        }
      }
    }
  }
}
```

### Cloudflare Analytics Engine

```json
{
  "catalyst": {
    "observability": {
      "forwarders": {
        "cloudflareAE": {
          "enabled": true,
          "accountId": "YOUR_CF_ACCOUNT_ID",
          "apiToken": "YOUR_CF_API_TOKEN",
          "dataset": "catalyst_events",
          "batchSize": 100,
          "flushIntervalMs": 5000
        }
      }
    }
  }
}
```

## Lifecycle

```bash
# Start daemon in background
catalyst-monitor.sh forward-start

# Check status
catalyst-monitor.sh forward-status

# Stop daemon
catalyst-monitor.sh forward-stop

# Alternatively, use the direct entry script
catalyst-otel-forward
```

## Checkpoint

The daemon saves its read position to `~/catalyst/otel-forward.checkpoint.json` every 10
seconds. On restart, it resumes from the last checkpoint (at most 10 seconds of events may
be re-delivered; destinations should be idempotent).

To reset and reprocess from the beginning of the current month:
```bash
rm ~/catalyst/otel-forward.checkpoint.json
```

## Dead-Letter Queues

When a destination fails after all retry attempts, events are written to a per-destination DLQ:

- `~/catalyst/otel-forward-dlq-otlp.jsonl`
- `~/catalyst/otel-forward-dlq-posthog.jsonl`
- `~/catalyst/otel-forward-dlq-cae.jsonl`

DLQ batches are automatically replayed on the next successful flush to that destination.

To discard a DLQ without replaying:
```bash
rm ~/catalyst/otel-forward-dlq-otlp.jsonl
```

## Debugging

```bash
# Tail daemon logs
tail -f ~/catalyst/otel-forward.log

# Verify OTLP connectivity (requires a running collector on :4318)
curl -s http://localhost:4318/v1/logs \
  -H "Content-Type: application/json" \
  -d '{"resourceLogs":[]}' | jq .

# Count events in current log
wc -l ~/catalyst/events/$(date +%Y-%m).jsonl

# Count canonical vs legacy
grep -c '"attributes"' ~/catalyst/events/$(date +%Y-%m).jsonl || true
```

## Validation Queries

### PostHog

In the PostHog UI, filter by event name `session.heartbeat` or create a funnel:
```
Source: session.heartbeat
→ worker.done (where distinct_id matches)
```

### Cloudflare Analytics Engine

```sql
SELECT
  blob1 as event_json,
  index1 as event_name,
  index2 as service_name,
  count() as total
FROM catalyst_events
WHERE timestamp > NOW() - INTERVAL '1' HOUR
GROUP BY event_name, service_name
ORDER BY total DESC
LIMIT 20
```
