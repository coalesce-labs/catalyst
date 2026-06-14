# catalyst-agent (CTL-812)

A self-contained, standalone host-telemetry agent. It samples three domains on a
launchd `StartInterval` tick and emits OTel log envelopes (same shape as
execution-core events) so the catalyst-otel collector / Loki dashboards pick them
up uniformly.

- **Zero npm deps** — `node:*` builtins only; runs unchanged under `node>=18`
  and `bun`.
- **Does not import from execution-core** — it is a separate process with its own
  config, envelope builder, and emit transports.

## Domains

| event.name                  | entity  | toggle (env)             |
| --------------------------- | ------- | ------------------------ |
| `account.ratelimit.sampled` | account | `CATALYST_AGENT_USAGE`   |
| `host.metrics.sampled`      | host    | `CATALYST_AGENT_HOST`    |
| `host.process.sampled`      | host    | `CATALYST_AGENT_PROCESS` |

Each toggle defaults **on**; set it to `0` to disable that domain.

Each tick runs the enabled domains in order (usage → host → processes). The
sampler modules (`usage.mjs` + `accounts.mjs`, `host.mjs`, `processes.mjs`) are
imported lazily and adapted to a uniform `runOnce(config)`; a domain that throws
is isolated so it never stops the others.

## Run

```sh
node catalyst-agent.mjs --once      # one tick of each enabled domain, then exit 0
node catalyst-agent.mjs --loop      # run continuously on the configured interval
node catalyst-agent.mjs --install   # print launchd install instructions
node catalyst-agent.mjs --help      # usage

bun test                            # run the unit suite
```

### launchd (macOS)

```sh
./install.sh                        # idempotent: substitute tokens, copy plist, (re)load
```

The plist runs the agent with `--once` every `StartInterval` (default 300s);
launchd re-launches it each tick.

## Env knobs

| Variable                      | Default                       | Meaning                                            |
| ----------------------------- | ----------------------------- | -------------------------------------------------- |
| `CATALYST_AGENT_EMIT`         | `eventlog`                    | `eventlog` \| `otlp` \| `both`                     |
| `CATALYST_AGENT_OTLP_ENDPOINT`| _none_                        | base URL; `/v1/logs` is appended on POST           |
| `CATALYST_AGENT_OTLP_HEADERS` | _none_                        | extra OTLP headers, `k=v,k=v`                       |
| `CATALYST_AGENT_INTERVAL_MS`  | `300000` (floor `180000`)     | tick cadence                                       |
| `CATALYST_AGENT_TOP_N`        | `10`                          | top-N processes by RSS (`host.process.sampled`)    |
| `CATALYST_AGENT_USAGE`        | on                            | `0` disables the account rate-limit domain         |
| `CATALYST_AGENT_HOST`         | on                            | `0` disables the host.metrics domain               |
| `CATALYST_AGENT_PROCESS`      | on                            | `0` disables the host.process domain               |
| `CATALYST_DIR`                | `~/catalyst`                  | event-log root (`<dir>/events/<YYYY-MM>.jsonl`)    |

## Emit

- **eventlog** (Approach A) — append each envelope as one JSONL line to
  `~/catalyst/events/<YYYY-MM UTC>.jsonl` (synchronous `appendFileSync`).
- **otlp** (Approach B) — POST OTLP/HTTP JSON logs to
  `<CATALYST_AGENT_OTLP_ENDPOINT>/v1/logs`. The POST is **awaited before the tick
  returns**, so `--once` never exits with a request still in flight (numbers are
  emitted as `doubleValue` for a stable per-key OTLP type).
- **both** — do both.

## Notes

- **Process parsing is cross-platform.** `processes.mjs` parses `ps` per platform:
  macOS renders the `comm` column at a fixed 16-char width (and truncates deep
  paths), so the command name is healed from the full `argv[0]` in the `args`
  column; Linux renders `comm` at its natural width. A rewritten `argv[0]`
  (a login shell's `-zsh`) still defers to `comm`.
