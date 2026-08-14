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

## Supplemental display reads (CTL-1806)

Three resolvers outside the eligible path used to call the Linear GraphQL API with no replica
consultation at all. Two are now replica-first; the third cannot be, and says so.

| Resolver | Local tier | Gate | On a miss |
| --- | --- | --- | --- |
| `orch-monitor/lib/linear-estimate-fallback.mjs` | `replica-read.mjs` `estimates()` | file presence | `catalyst.linear.read {source:"linearis_miss", op:"estimate"}` |
| `orch-monitor/lib/linear-title-description-fallback.mjs` | `details()` (+ `relations()`) | file presence | `… {source:"linearis_miss", op:"title_desc"}` |
| `execution-core/linear-estimation-method.mjs` | **none — see below** | 7-day on-disk TTL | `… {source:"linearis", op:"team_method"}` |

Three properties are deliberate and easy to "fix" wrongly:

- **File presence, never writer liveness.** A liveness gate on a *display* read falls through to
  Linear precisely when the board is UNCHANGED (a live writer on a quiet feed reads as stale —
  CTL-1397), turning a healthy quiet period into a burst of API calls. That is backwards for a read
  whose purpose is removing them.
- **A replica `NULL` estimate is a MISS, not an authoritative null.** Locally, "Linear has none" and
  "this row predates the estimate projection" are indistinguishable, so serving the null would drop
  the board chip for a refresh. Mirrors what `titles()` already does with an empty title.
- **The team estimation method has no replica source and must not be defaulted.** The replica has no
  `teams` table and carries no `issueEstimation`; the `$.team` projection is `{id,key,name}` only. So
  its Linear fetch stays, labelled and bounded at 8 team keys per host per TTL. It is **never**
  defaulted to a scale: the value gates a real Linear write (`applyEstimate` on the triage→research
  advance), where `null` makes the scheduler SKIP the write and a guess would write a Fibonacci
  number into a tShirt team's estimate field. The durable fix is a cloud-side `teams.issue_estimation`
  column, not a local guess.

`state.type` is not in the replica either (the enrichment pass overwrites `raw` with a projection
that drops it). It is **synthesized from lifecycle timestamps** — `canceled_at` → `completed_at` →
`started_at` → `backlog` — deliberately not from the state NAME, which would hardcode this
workspace's contract states and break under a bring-your-own-workspace tenant. Measured 109/109
exact on every class the consumer renders distinctly, against a committed ground-truth fixture
(`execution-core/__fixtures__/state-type-ground-truth.json`); the one residual is a true `unstarted`
collapsing to `backlog`, which costs a stroke-dash difference on a muted ring. The type is carried
rather than omitted because it also selects the 24h-vs-5min cache TTL, and dropping it would move
every terminal ticket to the short TTL — a quota regression inside a quota reduction. The durable
fix is a cloud-side `workflow_states` table (`issues.state_id` is already fully populated).

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
