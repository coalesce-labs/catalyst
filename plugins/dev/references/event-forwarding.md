# Event Forwarding Reference

The `catalyst-otel-forward` daemon tails the canonical Catalyst event JSONL log and fans out events in parallel to OTLP/HTTP, PostHog, and Cloudflare Analytics Engine.

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

Only canonical events (lines with a top-level `attributes` key, per CTL-300) are forwarded. Legacy format lines are skipped.

## Configuration

Config lives in `~/.config/catalyst/config-{projectKey}.json` under
`catalyst.observability.forwarders`. All forwarders are disabled by default.

### OTLP

Minimal shape to enable it — the two keys with no default. Every tunable (`batchSize`, `flushIntervalMs`, `lokiAcceptWindowMs`, `maxRetryElapsedMs`, …) and its default value live ONLY in the configuration reference; see "Config knobs" below.

```json
{
  "catalyst": {
    "observability": {
      "forwarders": {
        "otlp": {
          "enabled": true,
          "endpoint": "http://localhost:4318"
        }
      }
    }
  }
}
```

### Status classification & age-drop (CTL-1506)

The OTLP sender classifies every HTTP response and partitions each outgoing batch by record age before any network call:

**HTTP status classification:**

| Status | Class | Action |
|--------|-------|--------|
| `2xx` | — | Delivered |
| `429` | retryable | Exponential backoff up to `maxRetryElapsedMs`, then DLQ |
| `5xx` | retryable | Same |
| Network error | retryable | Same |
| `4xx` (not 429) | **terminal** | Dropped with `forward_dropped` event, **never DLQ'd** |

**Age-partitioning:** Before any send, aged records are split out, dropped with a `forward_dropped` event (`drop_reason: "aged"`), and the fresh remainder is sent — preventing aged co-riders from dragging fresh records into the DLQ. The send-time cutoff is slightly stricter than `lokiAcceptWindowMs`: `lokiAcceptWindowMs − min(timeoutMs, lokiAcceptWindowMs/4)`, a delivery margin so a near-cutoff record can't age past Loki's window mid-request (see the configuration reference for the authoritative schema).

**DLQ drain:** On each successful primary delivery, the bounded drain also age-partitions queued batches. A fully-aged DLQ entry is discarded (`drop_reason: "aged"`); a terminal 4xx during drain is discarded (`drop_reason: "terminal_4xx"`); a retryable error stops the drain and requeues (preserving CTL-1060 backpressure).

**Config knobs:** the authoritative schema for every forwarder key — including
`lokiAcceptWindowMs` and `maxRetryElapsedMs`, their defaults, and the effective age cutoff — lives
in the user-facing configuration reference,
`website/src/content/docs/reference/configuration.md` (§ "Event forwarders"). It is intentionally
not duplicated here.

**`forward_dropped` event:** Emitted as a canonical event (`catalyst.observability.forward_dropped`) with attribute `catalyst.observability.drop_reason` (`"aged"` or `"terminal_4xx"`) and `body.payload.count`. Loop-guarded by `isSelfBatch` (same as `forward_failed`).

### Drop surface — `~/catalyst/otel-forward-drops.json` (CTL-1818)

A discard is the one forwarder failure **no other instrument can see**:

| signal          | how it is normally caught                                      | does it catch an aged drop?                                            |
| --------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `forward_failed` | DLQ grows → CTL-1502 watchdog P1 (DLQ file size)               | **No** — an aged record never rides the DLQ, so the file stays flat     |
| `forward_lag`    | checkpoint `lastForwardedTs` freezes → watchdog P2             | **No** — the checkpoint advances; a discard *is* read progress          |
| `forward_dropped`| an event on the log…                                           | **No** — that event ships through the path that just discarded something |

So the drop is accounted for **on the host**, out of band of the forwarder's own OTLP egress:

- **Counters** — exact, per reason, in both events (batches) and records. Recorded in
  `emitDrop` **before** its `!eventLogPath` / `isSelfBatch` guards, so a discard that emits no event at all is still counted.
- **Marker** — `~/catalyst/otel-forward-drops.json` (atomic tmp+rename, beside the checkpoint and
  the DLQ). Carries host, pid, per-reason `process` and restart-carried `cumulative` totals, the rolling-window verdict, and the alert latch. Read it directly:

  ```bash
  jq '{host, cumulative, window, alert}' ~/catalyst/otel-forward-drops.json
  ```

- **Alarm** — the daemon's pino `~/catalyst/otel-forward.log`, which Alloy ships to Loki
  **independently** of this daemon's OTLP egress. A first-sighting warning per reason plus exponentially-spaced heartbeats (the CTL-1817 count-every/log-sparsely gate, `lib/sparse-warn.ts`), and one `ERROR` line when the discard rate stays above threshold for the sustain window — naming the host and the reason.

**Alert-only.** The sustained-loss alert raises a log line and latches the marker; it never restarts anything. An aged drop is a Loki-accept-window / backlog condition, and a restart does not fix it — it only loses the in-memory buffer. This is deliberately *not* a third predicate in `classifyDaemonStuck`, whose `tripped` list feeds `restart()` in the CTL-1502 probe.

Thresholds (`windowMs`, `thresholdRecords`, `sustainMs`) resolve **env > `forwarders.otlp.dropSurface`
> frozen default**; the authoritative schema and defaults live in
`website/src/content/docs/reference/configuration.md`.

The `OTEL_EXPORTER_OTLP_ENDPOINT` environment variable overrides `endpoint` (port 4317 is automatically rewritten to 4318 for HTTP).

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

The daemon saves its read position to `~/catalyst/otel-forward.checkpoint.json` every 10 seconds. On restart, it resumes from the last checkpoint (at most 10 seconds of events may be re-delivered; destinations should be idempotent).

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
