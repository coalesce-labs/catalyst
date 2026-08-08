# Linear read replica

The local Linear tier has three layers: the cloud-sync writer seeds and updates the SQLite
database, its writer-lock heartbeat proves the writer is alive independently of feed activity,
and the agent/daemon read paths serve single-ticket and board reads from that database.

## Configuration order

Two independent settings are required, and neither takes effect on its own: the token alone leaves
readers disconnected, and the flag alone produces replica misses against an empty file. Provision
the token FIRST, activate the writer, wait for a verified seed, and only then flip the read flag.

1. **Provision the resolved cloud-token variable.** The name defaults to `CATALYST_CLOUD_TOKEN`,
   but `resolveCloudTokenName` honours the `CATALYST_CLOUD_TOKEN_ENV` env override and the Layer-2
   `catalyst.cloud.tokenEnv` key — on a host that sets either, exporting `CATALYST_CLOUD_TOKEN`
   does **not** authenticate the writer. Export whichever name resolves, into
   `~/.config/catalyst/cloud-sync.env` (`chmod 600`).
2. **Activate the writer**: `catalyst-stack adopt-cloud-sync`. Provisioning the token does not
   itself install or start the supervised writer.
3. **Wait for a verified seed** — `catalyst doctor`'s `replica-fresh` PASS, or
   `sqlite3 ~/catalyst/catalyst-replica.db 'SELECT COUNT(*) FROM issues'` > 0.
4. **Then set `CATALYST_LINEAR_REPLICA=on`** and restart execution-core on a worker — an
   already-running process does not construct a reader just because the flag changed.

The canonical seed-before-flip runbook, including every key's precedence, lives in
`website/src/content/docs/reference/configuration.md`; this list is its replica-tier summary.

## Signals

| Signal | Where | Meaning |
| --- | --- | --- |
| `replica-schema WARN … 0 bytes` | `catalyst doctor` | The database was never seeded. |
| `replica-tier WARN … INERT` | `catalyst doctor` | The token and read flag gaps are both open. |
| `monitor.replica.degraded.<TEAM>` | Event log / Loki | N consecutive triage sweeps could not read the replica. |
| `monitor.replica.recovered.<TEAM>` | Event log / Loki | A degraded team's replica read recovered. |
| `catalyst.replica.read_fallback` | Event log / Loki | An agent read fell back to `linearis`. |

## Loki queries

`service_name` is the only stream label here; every other field — including the event name — arrives
as **structured metadata**, because `otel-forward` sends the body as a plain string and the event
attributes as OTLP log attributes (dots normalized to underscores). Do not `| json` these lines:
there is no JSON body to parse, and `attributes["event.name"]` never matches.

```logql
{service_name="catalyst.execution-core"} | event_name=~"monitor\\.replica\\.degraded\\..*"
```

```logql
{service_name="catalyst.linear-read"} | event_name="catalyst.replica.read_fallback"
```

The degradation streak rides the `replica_consecutive_degraded` metadata field on those events, so
`sum by (catalyst_team) (...)`-style aggregation over it works without touching the body.

Grafana alert provisioning belongs in the sibling `catalyst-otel` repository. Validate any rule
file against a throwaway Grafana before deploying it because malformed provisioned rules can stop
the shared Grafana instance from starting.
