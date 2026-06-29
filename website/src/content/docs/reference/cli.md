---
title: CLI command reference
description: Every catalyst-* command-line tool installed onto your PATH — purpose and key subcommands.
sidebar:
  order: 5
---

`catalyst` is the single front door to the toolchain. The tools below are the
complete set installed onto your PATH by
[`install-cli.sh`](https://github.com/coalesce-labs/catalyst/blob/main/plugins/dev/scripts/install-cli.sh)
(its `CLI_ENTRIES` allowlist) — run it as
[step 3 of getting started](/getting-started/#3-install-the-command-line-tools).
They install to `$HOME/.catalyst/bin`.

Most tools accept `-h`/`--help` for full syntax. For the service-stack lifecycle
in depth, see the dedicated [catalyst-stack reference](/reference/catalyst-stack/).

## catalyst (umbrella)

`catalyst` is a git-style dispatch router and the single front door to the
toolchain. It holds no business logic of its own: a curated set of lifecycle
verbs run the right tool, and any other `<command>` execs `catalyst-<command>`
by convention — so every existing and future `catalyst-*` tool is a subcommand
for free.

Lifecycle verbs:

| Verb | Delegates to | Purpose |
|---|---|---|
| `install` / `uninstall` / `reinstall` | `catalyst-install` | Provision / tear down this node for its class. |
| `start` / `stop` / `restart` / `status` | `catalyst-stack` | Class-appropriate services up/down. |
| `doctor` | `catalyst-doctor` | Class-aware health / activation grade. |
| `update` | `catalyst-stack hotpatch` | Refresh plugins now (one-shot pull). |
| `drain [--off]` | `catalyst-execution-core` | Pause / resume work pickup. |

```bash
catalyst status          # what's running on this node
catalyst doctor          # activation grade
catalyst events tail     # auto-delegates to catalyst-events
```

## Service & daemon tools

The three long-running services that make up the stack. Bring them up together
with `catalyst-stack start` (monitor → broker → execution-core).

### catalyst-broker

Manages the Catalyst **event broker daemon** — the event bus every agent and
the executor read and write through. Extends the older filter daemon with
structured agent identity (`agent.checkin`/`checkout`), auto-correlation of
ticket↔PR interests, and deterministic `ticket_lifecycle` routing for Linear
webhook events.

Commands: `start`, `stop`, `restart`, `probe` (exit 0 if responsive), `status`,
`logs`, `run` (foreground, for debugging).

### catalyst-monitor

On-demand **monitor server** management — watches your GitHub PRs and CI status
and emits events, and serves the orch-monitor web dashboard.

Commands: `start [--port N]`, `stop`, `status [--json]`, `open` (start if needed,
then open the dashboard in a browser), `url` (print the dashboard URL).

### catalyst-execution-core

Manages the **execution-core composing daemon** — the scheduler that picks up
Todo tickets and dispatches the phase-agent workers. It composes the Todo-state
monitor, the pull-loop scheduler, and the recovery contract into one long-lived,
machine-level process. `start`/`stop` here manage the daemon **process** (distinct
from `/orchestrate --stop`, which only deregisters a single project).

Commands: `start`, `stop`, `restart`. Also fronts `drain [--off]` to pause and
resume work pickup.

### catalyst-stack

The canonical command for bringing the whole **service stack** up and down in
dependency order (idempotent). Also installs the launchd LaunchAgents that
auto-start the stack on boot. Documented in full on its own page —
see the [catalyst-stack reference](/reference/catalyst-stack/).

Commands: `start`, `stop`, `restart`, `status`, `install-services`,
`uninstall-services`, `services-status`; flags include `--proxy` and `--hotpatch`.

## Event & observability tools

### catalyst-events

Tail and wait-for primitives over the global **event log** at
`~/catalyst/events/YYYY-MM.jsonl`. The base primitive most other observability
tools build on.

- `tail` — long-running follower; prints matching new lines to stdout.
- `wait-for` — blocks until the first matching line arrives, prints it, exits 0.

Both seek to EOF on first run (so historical heartbeat noise doesn't skew
filters) and use `fswatch` when available, falling back to poll.

### catalyst-filter

**Deprecated** — a backward-compatibility shim that delegates to
`catalyst-broker`, which superseded it (adding agent identity, `ticket_lifecycle`
routing, and auto-correlation). Existing scripts keep working; update callers to
use `catalyst-broker` directly.

### catalyst-otel-forward

Entry wrapper for the **otel-forward daemon**, which forwards Catalyst's OpenTelemetry
events to the observability backend (Loki/Prometheus/Grafana). Started and
stopped as part of `catalyst-stack`.

### catalyst-hud

The **Ink TUI** for the Catalyst event stream — a live, color-coded heads-up
display of orchestrator/worker/session activity.

Flags: `--repo PATTERN`, `--since TIME`, `--filter JQ`, `--since-line N`. For an
SSH-from-iPad / minimal-deps environment, use `catalyst-hud-classic` instead.

### catalyst-hud-classic

The **classic** color-coded terminal HUD over the event stream — a dependency-light
fallback for `catalyst-hud` (no Ink/bun runtime), suited to SSH-only sessions.
Built on `catalyst-events tail`.

### catalyst-why

Explains **why the daemon believes a worker is alive, stuck, or dead**. Renders
the belief → rule → source-facts trace for a ticket from the shadow belief store:
for the latest tick that observed the ticket, every belief, the rule that fired,
and each source fact with its timestamp and raw values.

```bash
catalyst-why CTL-123 [--tick N] [--json]
```

Read-only; requires the daemon's shadow belief mode to have been enabled.

### catalyst-transitions

A live, human-readable **transition log** for the execution-core. Tails the event
log and renders Linear state transitions and orchestrator phase events as they
happen (e.g. `CTL-123  Research → Plan`). Built on `catalyst-events tail`, which
does the file following, month rollover, and EOF-seek.

## Coordination & state tools

### catalyst-comms

File-based **agent communication channels** — an append-only JSONL messaging
system for agents across worktrees, sub-agents, agent teams, and orchestrators.
No HTTP, no server; storage lives under `~/catalyst/comms/`.

Commands: `join`, `send`, `poll`, `watch`, `done` (run `catalyst-comms --help`
for the full protocol).

### catalyst-session

Lifecycle CLI for **Catalyst agent sessions** — the universal write interface any
skill calls to report lifecycle events. Persists to the SQLite session store and
dual-writes a JSONL event line for legacy consumers.

Commands: `start --skill NAME [...]` (prints the new session id), `phase`,
`metric`, and more (`catalyst-session --help`).

### catalyst-state

Manages **global orchestrator state** at `~/catalyst/state.json` with
flock-protected read-modify-write for concurrent orchestrators and workers. Also
appends to the event log and archives history.

Commands: `init`, `register`, `update`, `worker`, `heartbeat`, `attention`,
`resolve-attention`, `event`.

### catalyst-db

The **SQLite-backed session store** (`~/catalyst/catalyst.db`) — the durable
source of truth for agent runs (solo and orchestrated). Owns the schema
migrations under `db-migrations/`.

Commands: `init`, `migrate`, and query/CRUD verbs (`catalyst-db --help`).

### catalyst-cluster

**Cluster administration** — manage the multi-host roster and liveness.

Commands: `join-token` (mint a one-time join token), `status`, `add`, `remove`,
`rename`, `set-anchor`, `drain`, `tune`.

### catalyst-linear-reconcile

**Reconciles Linear ticket state from PR reality.** Maps each PR to its delivered
ticket(s) and the Linear state the PR implies (merged → Done, open non-draft →
In-Review), then reports drift by default or corrects it with `--write`.
Idempotent and deterministic; safe to re-run.

## Setup & maintenance tools

### catalyst-doctor

A **fail-closed activation gate** / health check. Exit `0` means safe to activate;
non-zero is fail-closed. `--json` emits `{ok, pass, warn, fail, checks[]}`.

### catalyst-install

**Provisions or tears down this node for its class.** Composes the setup scripts
per node class and drives the `catalyst.install.*` telemetry contract so each run
is an observable trace. Invoked via the router as
`catalyst install | uninstall | reinstall …`.

### catalyst-backup

**Captures / restores a node's restorable state** — Layer-2 machine config and
secrets, thoughts credentials, the launchd agent inventory, `catalyst.db`
(WAL-safe), and runtime pointers (not large transient logs).

Commands: `backup [--out <dir>] [--label <name>]`, `restore <bundle> [--force]
[--dry-run]`, `list [--json]`.

### catalyst-thoughts

**Repairs and verifies** the HumanLayer thoughts system for a project.

Commands: `init-or-repair` (ensure `thoughts/` is a correct HumanLayer layout —
symlinks + subdirs), `check` (verify state; exits non-zero on the known
bug states like a clobbered symlink).

### workflow-context

Workflow-context management utilities — read and update the per-worktree
`.catalyst/.workflow-context.json` that chains skills together (e.g. pointing
`/implement-plan` at the most recent plan).

## Internal / plumbing

These are installed by `install-cli.sh` but are rarely invoked directly — they
back hooks, the status line, and the thoughts sync:

| Command | Purpose |
|---|---|
| `catalyst-statusline` | Claude Code `statusLine` wrapper that renders the status bar and emits periodic `session.context` events. |
| `catalyst-claude` | Wrapper around the `claude` CLI that registers a Catalyst session around the run. |
| `register-thought` | `PostToolUse` Write hook that auto-registers any `thoughts/shared/` write into the workflow context. |
| `thoughts-pull-sync` | Fast-forwards every HumanLayer thoughts checkout so cross-host research/plans read fresh peer state (ff-only; never clobbers in-flight work). |
| `emit-lifecycle-event` | Hook that appends a lifecycle event to the unified event log. |

## See also

- [catalyst-stack reference](/reference/catalyst-stack/) — the service stack, in depth
- [Install Catalyst](/getting-started/) — initial setup, including installing these tools
- [Configuration](/reference/configuration/) — the settings these tools read
