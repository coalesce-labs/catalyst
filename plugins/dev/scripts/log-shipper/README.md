# Catalyst daemon-log shipper (Grafana Alloy)

`config.alloy` is an **off-the-shelf [Grafana Alloy](https://grafana.com/docs/alloy/)
config** that tails the four long-running Catalyst daemon `.log` files on a host,
parses their pino-JSON lines into OpenTelemetry log records, tags every record
with both host identities, and exports OTLP/HTTP to the **existing shared
collector**. The collector fans the stream out to Loki/Prometheus, so the daemon
logs become Loki-greppable — including the execution-core liveness hold — without
having to `ssh` into the host and `tail` a file.

This directory ships **only the config**. Starting Alloy as a per-host process
(launcher + pid/status + wiring into `catalyst-stack START`) is a **sibling
ticket** — see [Status & scope](#status--scope). The config alone does not start
anything.

## Why off-the-shelf

The mechanism is deliberately a stock log shipper, not hand-rolled code:

- **No** bespoke shipper script.
- **No** in-process pino transport bolted onto the daemons.
- **No** OpenTelemetry Collector `filelog` receiver embedded in a daemon.

Alloy runs as its **own per-host process**, completely decoupled from the daemons
whose logs it tails. If the shipper dies, the daemons are unaffected; if a daemon
dies, its last lines are still on disk for Alloy to pick up.

## What it ships

| File                                   | service.name              | Format          |
| -------------------------------------- | ------------------------- | --------------- |
| `~/catalyst/broker.log`                | `catalyst.broker`         | pino JSON       |
| `~/catalyst/execution-core/daemon.log` | `catalyst.execution-core` | pino JSON       |
| `~/catalyst/otel-forward.log`          | `catalyst.otel-forward`   | pino JSON       |
| `~/catalyst/monitor.log`               | `catalyst.monitor`        | mixed/plain text|

`broker`, `execution-core`, and `otel-forward` emit pino JSON
(`{level,time(ms),pid,hostname,name,msg,...}`). `monitor.log` is mixed `console.*`
output and is **not** JSON — it ships best-effort as unstructured records and is
**never dropped** for a parse failure (there is no JSON stage in its pipeline).

## Pipeline

```
loki.source.file (per file, tags service_name)
        │
        ├── pino logs ──▶ loki.process "pino"  (stage.json → stage.timestamp →
        │                                        stage.structured_metadata → stage.output=msg)
        │
        └── monitor.log ▶ loki.process "plain" (passthrough, body = whole line)
                                   │
                                   ▼
                       otelcol.receiver.loki        (Loki labels → OTel attributes;
                                   │                  service_name → service.name)
                                   ▼
                       otelcol.processor.transform  (severity_number/text from level;
                                   │                  host.name + catalyst.host.name)
                                   ▼
                       otelcol.processor.batch
                                   ▼
                       otelcol.exporter.otlphttp  ──▶ http://100.65.193.30:4318
```

## OTel semconv mapping

The pino fields are mapped to the OTel logs data model:

| pino field      | OTel field                                    |
| --------------- | --------------------------------------------- |
| `level` (30/40/50/60) | `severityNumber` / `severityText` (see below) |
| `time` (Unix ms)| log record timestamp (Alloy converts ms → ns) |
| `msg`           | log record **body**                           |
| other context   | log-record **attributes**                     |
| `name`          | resource **service.name** as `catalyst.<name>`|

Severity:

| pino `level` | severityText | severityNumber |
| ------------ | ------------ | -------------- |
| 30           | INFO         | 9              |
| 40           | WARN         | 13             |
| 50           | ERROR        | 17             |
| 60           | FATAL        | 21             |

(The config uses the OTTL `SEVERITY_NUMBER_INFO/WARN/ERROR/FATAL` constants,
which are exactly 9/13/17/21.)

## Host tagging (load-bearing)

Every shipped record carries **two** host identities as resource attributes:

- `host.name` — the **OS hostname** (`constants.hostname`).
- `catalyst.host.name` — the **stable Catalyst node name**.

### Node name

The Catalyst node name must be resolved the **same way** as `getHostName()` in
`plugins/dev/scripts/execution-core/config.mjs`:

1. `CATALYST_HOST_NAME` environment variable, else
2. `catalyst.host.name` in the Layer-2 config (`~/.config/catalyst/config.json`), else
3. `os.hostname()` reduced to its **first DNS label** (strips `.local`, `.rozich`, …).

Because Alloy/River cannot read the Layer-2 JSON or compute the first-DNS-label
reduction itself, **the launcher is responsible for resolving the node name and
exporting it as `CATALYST_HOST_NAME`** before starting Alloy — using the exact
`getHostName()` precedence above. The config then reads
`coalesce(sys.env("CATALYST_HOST_NAME"), constants.hostname)`: if the launcher
provides the env var (the expected path) it is used verbatim; otherwise it falls
back to the OS hostname so records are still node-tagged.

> **The node name is NEVER the Tailscale device name.** Tailscale reports e.g.
> `RyansMini250233`, but the stable Catalyst node name is `mini`. Deriving the
> tag from the Tailscale device would split the stream across two identities and
> break cross-host queries. Always resolve via `getHostName()`.

A correct launcher prelude looks like:

```sh
# Resolve the stable node name exactly like getHostName() and hand it to Alloy.
export CATALYST_HOST_NAME="$(node -e '
  const { getHostName } = require("./plugins/dev/scripts/execution-core/config.mjs");
  process.stdout.write(getHostName());
')"
```

## Configuration (env)

All optional; safe defaults are baked in. The launcher should set these so the
defaults are never hit:

| Env var                    | Purpose                              | Default                       |
| -------------------------- | ------------------------------------ | ----------------------------- |
| `CATALYST_HOST_NAME`       | stable Catalyst node name (see above)| OS hostname (fallback only)   |
| `CATALYST_OTLP_ENDPOINT`   | collector OTLP/HTTP base URL         | `http://100.65.193.30:4318`   |
| `CATALYST_BROKER_LOG`      | broker.log path                      | `~/catalyst/broker.log`       |
| `CATALYST_DAEMON_LOG`      | execution-core daemon.log path       | `~/catalyst/execution-core/daemon.log` |
| `CATALYST_OTEL_FORWARD_LOG`| otel-forward.log path                | `~/catalyst/otel-forward.log` |
| `CATALYST_MONITOR_LOG`     | monitor.log path                     | `~/catalyst/monitor.log`      |

> The collector endpoint and Tailscale IP match the rest of the Catalyst telemetry
> stack (`otel-forward`, the cost-cap Prometheus reader). The export is plain HTTP
> (`tls { insecure = true }`) because the collector is on the trusted Tailscale net.

## Validating the config

The config is validated with the stock Alloy CLI (no Catalyst-specific harness):

```sh
brew install grafana-alloy          # or see grafana.com/docs/alloy install docs

alloy fmt      plugins/dev/scripts/log-shipper/config.alloy   # syntax / formatting
alloy validate plugins/dev/scripts/log-shipper/config.alloy   # full component-graph + OTTL check
```

`alloy validate` resolves the whole component graph, checks every argument, and
type-checks the OTTL statements — it is the authoritative "does this config
load?" gate. Both commands exit `0` for this config.

## Running it (manual, for now)

Until the sibling ticket wires it into `catalyst-stack START`, run Alloy by hand
on a host:

```sh
export CATALYST_HOST_NAME="<resolved via getHostName(), e.g. mini>"
alloy run plugins/dev/scripts/log-shipper/config.alloy \
  --storage.path "$HOME/catalyst/alloy-data"
```

`--storage.path` is where Alloy persists file-tail positions so a restart resumes
where it left off instead of re-shipping.

## Verifying Loki receipt (operator step)

This is an **operator/manual** verification — the config is **not** deployed to
live hosts by this ticket.

1. Start Alloy with the command above on a host that is actively running the
   daemons.
2. Generate a known line, e.g. the execution-core liveness hold writes
   `holding new-work dispatch` to `daemon.log`.
3. Query Loki (Grafana on `otel.rozich.com`, or the Loki API on
   `100.65.193.30:3100`) for the liveness stream shape from the AC:

   ```logql
   {service_name="catalyst.execution-core"} |= "holding new-work dispatch"
   ```

   Records should appear with:
   - `service_name="catalyst.execution-core"`,
   - the correct `host.name` (OS hostname) and `catalyst.host.name` (stable node
     name, e.g. `mini` — **not** `RyansMini250233`),
   - `severityText`/`severityNumber` derived from the pino level,
   - the pino `msg` as the log body.

4. Spot-check `monitor.log`'s plain-text lines arrive under
   `{service_name="catalyst.monitor"}` (unstructured, body = the raw line).

## Status & scope

This ticket (CTL-1261) delivers **only** `config.alloy` + this README. The
following are **separate tickets** in the *Control-Loop Observability* project,
intentionally out of scope here:

- **Per-host launcher + `catalyst-stack START` wiring** (its own pid/status). The
  AC's runtime query (`{service_name="catalyst.execution-core"} |= "holding
  new-work dispatch"` returning data) depends on this launcher, not on the config
  alone.
- **Recording rules** for the liveness signal — they depend on scheduler events
  that are held behind the cluster-membership work.
