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
| `replica-schema FAIL … 0 bytes` | `catalyst doctor` | An opted-in node's database was never seeded. An opted-out node retains advisory WARN grading. |
| `replica-tier FAIL … INERT` | `catalyst doctor` | An opted-in node has both the token and read-flag gaps open. |
| `replica-health FAIL` | `catalyst doctor` | An opted-in node has one or more teams whose degraded-read latch is alerting. |
| `monitor.replica.degraded.<TEAM>` | Event log / Loki | N consecutive triage sweeps could not read the replica. |
| `monitor.replica.recovered.<TEAM>` | Event log / Loki | A degraded team's replica read recovered. |
| `catalyst.replica.read_fallback` | Event log / Loki | An agent read fell back to `linearis`. |

Doctor treats either an installed cloud-sync LaunchAgent or `CATALYST_LINEAR_REPLICA=on` as an
opt-in signal. Broken-tier findings can FAIL only after one of those signals is present, so a fresh
node that never requested the tier keeps the prior advisory-only behavior.

## Writer died and was never restarted

The characteristic symptoms are `triage_source: replica-miss`, an alerting `replica-health`
marker with a set `lastHealthyTs`, and a stale `<db>.writer.lock`. A set timestamp means the tier
worked and regressed; `null` means it was never healthy on this node.

Recover in this order:

1. Run `catalyst-stack verify-cloud-sync`.
2. Provision the resolved cloud token in `~/.config/catalyst/cloud-sync.env` and run `chmod 600 ~/.config/catalyst/cloud-sync.env`.
3. Run `catalyst-stack adopt-cloud-sync`.
4. Re-run `catalyst-stack verify-cloud-sync` until every gating check is green.
5. Run `catalyst-stack activate-replica`.

The LaunchAgent uses `KeepAlive={SuccessfulExit:false}`. A tokenless writer deliberately exits 0,
so launchd does not restart it; “agent installed” does not imply “writer running.”

Label writes short-circuited by the Linear breaker now report `circuit-open` and write a temporary
marker under `~/catalyst/execution-core/.label-cooldowns/`. The marker carries the breaker's
remaining window, suppresses per-tick retries, and is not terminal: the label is retried after expiry.

Known divergences remain: the read path, doctor, and setup check use different freshness windows,
and doctor verifies the two tables it reads while `verify-cloud-sync` verifies the full six-table
writer schema. These are documented follow-up work rather than silently reconciled here.

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
