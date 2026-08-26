# Data source — where each field actually comes from today

## `estimate_at_start` — the replica, gated

The helper reads the ticket's starting estimate via `linear_read_ticket`, the same replica-backed,
freshness-gated helper `linearis`/`steward` use (`steward/references/cloud-detection.md`) — never
a bare `linearis issues read`. The team's estimation config (T-shirt, Fibonacci, linear) is
applied client-side when re-scoring in the process's step 3.

## `cost_usd` — local aggregates, in this order

1. **`--cost-usd <float>`** — an explicit override always wins.
2. **A per-run cost aggregate keyed to an active orchestrator run** — this path only fires when a
   session still sets the orchestrator-run environment variable the retired background scheduler
   used to set. Under relay-dispatch (CTL-2218), nothing sets it, so in practice this source is
   **inert today**, not primary — it is dead code the helper still carries, not a live dependency.
3. **Local session-history aggregate** (`catalyst-session.sh history --ticket <TICKET> --limit
   1`) — this is the source that actually resolves `cost_usd` under relay-dispatch, since (2)
   never fires.

If none resolve, the helper fails loud and asks for `--cost-usd` explicitly — pass it rather than
guess.

## The Prometheus overlay — gated, not yet wired

`CATALYST_PROMETHEUS_URL`, when set, makes the helper log a note to stderr; the HTTP client itself
is a follow-up (the intended eventual primary source once `claude-code-otel` + Prometheus land
here — referenced in the original spec, not yet wired up in this repo). Until then, (3) above is
the real default.

## Why this changed

Before CTL-2218, source (2) was actually primary for anyone running the retired
background-scheduler pipeline — a live orchestrator run set the environment variable it keys on,
so most invocations resolved cost there. That pipeline is retired; nothing dispatches through it
anymore, so what was
"primary in orchestrator mode" is now dead weight the helper still probes first and then falls
through. This reference describes the **current, relay-dispatch-era** resolution order — what
actually fires — not the helper's literal probe order, which is unchanged (out of scope: the
helper is a sibling script, not part of this rewrite).
