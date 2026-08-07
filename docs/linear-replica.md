# Linear read replica

The local Linear tier has three layers: the cloud-sync writer seeds and updates the SQLite
database, its writer-lock heartbeat proves the writer is alive independently of feed activity,
and the agent/daemon read paths serve single-ticket and board reads from that database.

## Configuration order

Two independent settings are required. Provision `CATALYST_CLOUD_TOKEN` first so the writer can
authenticate and seed a schema. Then set `CATALYST_LINEAR_REPLICA=on` so readers use it. The token
alone leaves readers disconnected; the flag alone produces replica misses against an empty file.

## Signals

| Signal | Where | Meaning |
| --- | --- | --- |
| `replica-schema WARN … 0 bytes` | `catalyst doctor` | The database was never seeded. |
| `replica-tier WARN … INERT` | `catalyst doctor` | The token and read flag gaps are both open. |
| `monitor.replica.degraded.<TEAM>` | Event log / Loki | N consecutive triage sweeps could not read the replica. |
| `monitor.replica.recovered.<TEAM>` | Event log / Loki | A degraded team's replica read recovered. |
| `catalyst.replica.read_fallback` | Event log / Loki | An agent read fell back to `linearis`. |

## Loki queries

```logql
{service_name="catalyst.execution-core"} | field="event.name" =~ "monitor\\.replica\\.degraded\\..*"
```

```logql
{service_name="catalyst.linear-read"} | field="event.name" = "catalyst.replica.read_fallback"
```

Grafana alert provisioning belongs in the sibling `catalyst-otel` repository. Validate any rule
file against a throwaway Grafana before deploying it because malformed provisioned rules can stop
the shared Grafana instance from starting.
