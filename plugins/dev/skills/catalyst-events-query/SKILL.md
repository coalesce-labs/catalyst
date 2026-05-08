---
name: catalyst-events-query
description:
  Reference for the natural-language query subcommand of `catalyst-events`. Translates English
  queries through Groq into a structured DSL, compiles to a jq predicate, and runs against the
  canonical event log. Also documents the `:` / `?` keys in `catalyst-hud` (TUI) that drive the
  same compiler. Use when an agent needs to triage events without composing jq predicates by hand,
  or when documenting how to surface event subsets in dashboards.
disable-model-invocation: true
---

# catalyst-events query — natural-language event triage

## TL;DR

```bash
catalyst-events query "errors in the last hour"
catalyst-events query "show all gh events for ADV-292 and ADV-293 that are PR or CI" --explain
catalyst-events query "failed CI on main branch" --since 1d --limit 50
```

In the TUI (`catalyst-hud`):

| Key | Action |
|-----|--------|
| `:` | Open natural-language query input |
| `Enter` (in input) | Send to Groq, apply DSL filter to current view |
| `?` | Toggle the generated DSL overlay (only shown after a query is set) |
| `Esc` | Cancel input or drop the active DSL filter |

## When to use this

- You want to triage events across orchestrators / tickets / PRs and don't want to memorize the jq attribute paths.
- You're explaining a query in a doc or skill and want a copy-pasteable command.
- You're building a dashboard or report and want a one-liner that returns the right slice of the event log.

## When NOT to use this

- You're inside an automated waiter — use `catalyst-events wait-for --filter '<jq>'` directly. The `query` subcommand pays a Groq round-trip; waiters need to be deterministic.
- You're filtering by a single canonical attribute path you already know — `catalyst-events tail --filter '...'` is faster.

## DSL grammar

The compiler accepts a strict JSON DSL. You don't normally write this by hand — Groq emits it — but `--explain` shows it to you, and `--dsl` lets you bypass Groq for tests / scripts.

```ts
type Dsl = {
  filter: Node;
  sort?:  { field: string; order?: "asc" | "desc" } | null;
  limit?: number | null;
} | { error: string };

type Node = And | Or | Not | Leaf | {};
type And  = { and: Node[] };
type Or   = { or:  Node[] };
type Not  = { not: Node };
type Leaf = { field: string } & (
    { eq: any } | { ne: any }
  | { gt: any } | { gte: any } | { lt: any } | { lte: any }
  | { in: any[] }
  | { startsWith: string } | { endsWith: string } | { contains: string }
  | { exists: boolean }
);
```

`field` MUST be a path from the canonical event schema — see [[event-schema]] for the
authoritative list. Top-level fields (`ts`, `severityText`, `severityNumber`, `traceId`,
`spanId`, `resource."service.name"`, `body.message`) and all `attributes."<key>"` paths are
accepted. The validator rejects anything else with a "did you mean" suggestion.

## Acceptance examples (these all work)

| English | Generated DSL (abbreviated) |
|---|---|
| `show all gh events for ADV-292 and ADV-293 that are PR or CI` | `{filter: {and: [{field: 'attributes."catalyst.worker.ticket"', in: ["ADV-292","ADV-293"]}, {or: [{field:'attributes."event.name"', startsWith: "github.pr."}, {field:'attributes."event.name"', startsWith: "github.check_"}, {field:'attributes."event.name"', startsWith: "github.workflow_run."}]}]}, sort: {field:"ts", order:"desc"}, limit: 200}` |
| `errors in the last hour` | `{filter: {and: [{field:"severityText", eq:"ERROR"}, {field:"ts", gte:"{NOW-1h}"}]}, sort: {field:"ts", order:"desc"}, limit: 200}` |
| `all events for orch-adv-852-2026-05-07` | `{filter: {field:'attributes."catalyst.orchestrator.id"', eq:"orch-adv-852-2026-05-07"}, sort: {field:"ts", order:"asc"}, limit: 500}` |
| `failed CI on main branch` | `{filter: {and: [{field:'attributes."event.name"', startsWith:"github.check_"}, {field:'attributes."cicd.pipeline.run.conclusion"', eq:"failure"}, {field:'attributes."vcs.ref.name"', eq:"refs/heads/main"}]}, sort:{field:"ts",order:"desc"}, limit:100}` |
| `delete all heartbeat events` | `{error: "refused: query is read-only"}` (refused — query is read-only by design) |

The `{NOW-1h}` / `{TODAY}` placeholders are rewritten to ISO timestamps by the caller (CLI or TUI) before evaluation, so the model can stay deterministic.

## Flags

| Flag | Purpose |
|---|---|
| `--explain` | Print the parsed DSL + compiled jq predicate, exit without running. Useful for debugging or auditing what Groq returned. |
| `--limit N` | Override the limit Groq chose. |
| `--since DURATION` | Pre-trim by `ts >= now - DURATION`. Accepts `Ns`, `Nm`, `Nh`, `Nd`, or `today`. Relative only in v1. |
| `--dsl '<json>'` | Skip Groq entirely; pass a hand-written DSL. The validator and compiler still run. Used by tests and power users who don't want the round-trip. |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success (zero matches is success — no output, exit 0) |
| 2 | Usage error (unknown flag, missing required arg) |
| 3 | Groq HTTP error, malformed JSON, or refusal (`{"error": "refused: …"}`) |
| 4 | DSL validation error (unknown field, bad operator) |

The compiler error always names the bad field on stderr:

```
$ catalyst-events query --dsl '{"filter":{"field":"bogus.field","eq":1}}'
{"error":"unknown field: bogus.field","code":"unknown_field","field":"bogus.field"}
```

## Configuration

| Env var | Purpose |
|---|---|
| `GROQ_API_KEY` | Groq API key. Falls back to `~/.config/catalyst/config.json::groq.apiKey`. |
| `FILTER_GROQ_MODEL` | Override the model. Default `llama-3.1-8b-instant` (sub-second, ~$0.05/M input). |

## Internals

- The CLI is `plugins/dev/scripts/catalyst-events::cmd_query`. It shells to `plugins/dev/scripts/lib/dsl-cli.mjs` (Node), which calls Groq, parses, validates, and emits compiled artifacts on stdout. The bash wrapper then splices the jq predicate into the existing `apply_filter` pipeline.
- The TUI imports the same `compile()` and `groqTranslate()` from `plugins/dev/scripts/lib/dsl-compile.mjs` directly — no subprocess. The DSL produces a JS predicate function evaluated in-memory against the TUI's event backbuffer.
- The system prompt + few-shot examples live in `plugins/dev/scripts/lib/dsl-prompt.mjs` and the canonical field whitelist in `plugins/dev/scripts/lib/dsl-fields.mjs`. Both are read by tests, so prompt/validator drift is caught.
- See [[event-schema]] for the canonical attribute paths the DSL targets, and [[wait-for-github]] for the deterministic-filter pattern when you need to block on a known event shape.

## Out of scope

- Trace pivot from PR number ("show events with the same trace as PR #501") — needs a two-step lookup (PR → traceId → query). Returns `refused` for now; future ticket will add a `{lookup, then}` DSL.
- Streaming / `--follow` mode — `query` is one-shot; use `catalyst-events tail --filter '<jq>'` for live tail.
- Free-text NLP over `body.payload` — the DSL is structured-attribute only.

## Related

- [[event-schema]] — canonical envelope and attribute reference
- [[monitor-events]] — wait-for / tail patterns for automated waiters
- [[wait-for-github]] — REST + event-tunnel two-phase wait for PR/CI lifecycle
- [[broker]] — the daemon that uses Groq for semantic event routing (not event queries)
