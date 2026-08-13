# catalyst-agent (CTL-812)

A self-contained, standalone host-telemetry agent. It samples three domains on a
launchd `StartInterval` tick and emits OTel log envelopes (same shape as
execution-core events) so the catalyst-otel collector / Loki dashboards pick them
up uniformly.

- **Zero npm deps** — `node:*` builtins only; runs unchanged under `node>=18`
  and `bun`.
- **Does not import execution-core's runtime** — it is a separate process with its own
  config, envelope builder, and emit transports. There is exactly **one** exception, and
  it is a pure `node:*`-only leaf carrying data the agent must not have a second copy of:
  `execution-core/checkout-sync.mjs`'s `classifyExecutingRoots` (CTL-1808), the enumeration
  of checkouts this host runs code from. The currency gauge below measures that set, and a
  second enumeration written here would drift from the one the sync pass acts on. Nothing
  in that leaf reaches `execution-core/config.mjs` or its `bun:sqlite` graph, so the agent
  still loads under bare `node` with no `node_modules` — guarded by
  `check-import-graph.mjs`, a required step in `execution-core-tests.yml`, which imports
  every agent module under plain `node` (not a bundler: `bun build --target=node` resolves
  `bun:*` as an external and exits 0 on a graph `node` cannot load) and separately audits
  the source for any non-`node:` specifier. The source audit is the half that carries the
  contract — CI installs node_modules before the step runs, so on the runner a bare npm
  specifier resolves and the load probe cannot see it. It records **every** occurrence of
  an external specifier and exempts exactly one import by identity (`pino`, dynamic, in
  `config.mjs`, inside a `try {} catch`); a second `pino` import of any shape fails, and so
  does deleting the guarded one.

## Domains

| event.name                  | entity  | toggle (env)             |
| --------------------------- | ------- | ------------------------ |
| `account.ratelimit.sampled` | account | `CATALYST_AGENT_USAGE`   |
| `host.metrics.sampled`      | host    | `CATALYST_AGENT_HOST`    |
| `host.process.sampled`      | host    | `CATALYST_AGENT_PROCESS` |

Each toggle defaults **on**; set it to `0` to disable that domain.

A fourth domain (`version`, toggle `CATALYST_AGENT_VERSION`) emits **metrics**
rather than events — see [Code currency](#code-currency) below.

Each tick runs the enabled domains in order (usage → host → processes →
version). The sampler modules (`usage.mjs` + `accounts.mjs`, `host.mjs`,
`processes.mjs`, `version.mjs`) are imported lazily and adapted to a uniform
`runOnce(config)`; a domain that throws is isolated so it never stops the others.

## Code currency

| metric                            | shape                                                                       |
| --------------------------------- | --------------------------------------------------------------------------- |
| `catalyst.build.info`             | always `1`; label `vcs.ref.head.revision` = the **agent's own** commit       |
| `catalyst.vcs.commits_behind`     | **one series per executing Catalyst checkout**, label `catalyst.checkout.root` = path |
| `catalyst.vcs.commits_behind.max` | one value: the **stalest** Catalyst checkout on this host                    |

`commits_behind` is measured once per checkout this host actually executes code
from, resolved through CTL-1808's `classifyExecutingRoots`:

```
registry repoRoots  ∪  this checkout  ∪  Layer-2 catalyst.checkouts[]  ∪  <CATALYST_DIR>/plugin-source
```

**Which of those roots (CTL-1825 round 2).** That enumeration also carries the
enrolled **product** repos the CTL-1808 sync pass fast-forwards, and those are a
different repository's distance from a different `main`. Measured on the laptop,
nine of eleven roots were product repos and the stalest — `personal-os`, 58 behind
its own main — became this host's reported maximum, so a metric named for Catalyst
currency reported 58 for a personal repository and the pre-existing
`max by (host_name)(catalyst_vcs_commits_behind) > 20` alert fires on it. So each
root is classified and **only the `catalyst` role is measured**: the agent's own
tree and `<CATALYST_DIR>/plugin-source` (Catalyst by construction), plus any
enrolled or Layer-2-declared root carrying `.claude-plugin/marketplace.json` — the
Catalyst repo is itself enrolled (ADR-028), so the exclusion has to be by what a
tree IS, not by which source named it. One enumeration, two views: the sync pass
still fast-forwards every root.

**Why not just this checkout (CTL-1825).** It used to be `git -C <the directory
build-info.mjs lives in>`, which answers "is the tree the agent lives in
current?" — a different question from "is the code this host runs current?"
whenever those trees differ, and on this fleet they differ by design: workers
execute from `~/catalyst/plugin-source`, the laptop's plist runs the agent out of
the dev checkout. Measured 2026-08-13 on the laptop, the gauge read a healthy
**0** while `~/catalyst/plugin-source` was **24** commits behind. A gauge that can
only report 0 is worse than no gauge.

Two rules follow, and both are enforced by tests: a stale root is **its own
non-zero series** (never averaged away or overwritten), and the single aggregate
is the **MAXIMUM** across roots, never the agent's own. A root git cannot read
drops its own point — it never contributes a 0 that reads as "current".

Enrol a sibling checkout this host keeps current but is not enrolled to dispatch
into by adding it to Layer-2 (`~/.config/catalyst/config.json`):

```json
{ "catalyst": { "checkouts": ["/Users/me/code/catalyst-cloud"] } }
```

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
