# 2026-08-08: Replace the ad hoc OTel stack with a real coalesce-labs/catalyst-otel clone

## Context

The fleet's OTel host (aldebaran) had been running a hand-rolled docker-compose stack (collector,
Loki, Prometheus, Grafana) stood up 2026-08-01 as a stopgap. It worked as a pure log sink for
`catalyst-log-shipper` but had zero Grafana dashboards provisioned, no container log-rotation
policy, and floated on `:latest` images.

The upstream maintainer confirmed the real `coalesce-labs/catalyst-otel` repo can be installed via
`docker compose` and pointed at by Claude Code, Codex, and Catalyst directly — the intended,
maintained way to run this stack, not something we needed to build ourselves.

## Decision

Replaced the ad hoc stack in place with a real `git clone` of `coalesce-labs/catalyst-otel`, using
its base `docker-compose.yml` (5 services: collector, Prometheus, Loki, Tempo, Grafana — Tempo
tracing is included in the base file, not exclusive to the separate `docker-compose-lgtm.yml`
all-in-one variant, which lacks the curated dashboards, collector config, log rotation, and
alerting the base file has).

## Outcome

Healthy, 0 container restarts. ~7 days of pre-existing Loki/Prometheus history preserved. 14 real
Grafana dashboards now provisioned (fleet ops, ticket lifecycle, scheduler health, control-loop
live view, Claude Code, Codex Usage, Operator Usage, and more — the repo has grown well past what
its README documents). The old stack's config was backed up locally (not deleted) before removal.

## Key technical decisions and gotchas (reusable for future Compose-override work)

- **Volume reuse across a stack swap**: the "obvious" approach of overriding a `.env`-driven
  volume-name variable (`${OTEL_LOKI_DATA:-otel-loki-data}`) to point at a differently-named
  pre-existing volume does **not** work — Compose only resolves the left side of a service's
  volume mapping against a top-level `volumes:` key that literally matches, not an arbitrary
  string. The correct mechanism is redeclaring the top-level key in a
  `docker-compose.override.yml` with `external: true` and the real `name:` of the pre-existing
  volume.
- **List-valued keys in Compose overrides merge by appending, not replacing.** A bare `ports:` or
  `volumes:` key in an override file adds to the base file's list rather than superseding it. This
  bit us twice (once remapping Grafana's port, once dropping a broken volume mount) before we
  started using the `ports: !override` / `volumes: !override` YAML tag (Compose Spec / Docker
  Compose v2.24+) to force full replacement of just that key.
- **A declared-but-unreferenced OTel Collector exporter still needs valid config.** The repo
  intentionally leaves a fan-out exporter block declared (for a private overlay deployment we
  don't run) with an env-var-driven endpoint. Even though no public pipeline in this repo routes
  to it, the Collector validates every *declared* exporter at startup — an empty endpoint
  crash-loops the whole collector. Fixed with a harmless placeholder value in a local `.env`, same
  pattern the repo already uses for its own unconfigured alert-webhook placeholder.

## Known gaps, tracked as follow-ups (not fixed as part of this migration — out of scope)

- **CAT-120**: 8 real Catalyst alert-rule files (survivability, fleet-ops, scheduler-health,
  ticket-lifecycle, replica-freshness, updater-install, tier-b, read-path) fail this Grafana
  version's alert-rule schema validation (`__dashboardUid__`/`__panelId__` annotations now
  required) and crash-loop Grafana at boot. Worked around by dropping the alerting provisioning
  mount entirely for now — **none of these 8 files' alerts are currently active anywhere.**
- **CAT-121**: Codex CLI is not sending telemetry to the stack at all (confirmed: zero Codex data
  present). The *receiving* side is already fully built for it — production-tuned trace filtering
  for `codex-app-server`'s own spans, plus an existing "Codex Usage" dashboard — strongly
  suggesting this is a simple client-side env-var wiring gap (the same pattern Claude Code already
  uses), not missing design work.

## Notes for future work in this area

- Claude Code telemetry was independently confirmed already correctly wired fleet-wide before this
  migration touched anything — nested under a `.env.OTEL_EXPORTER_OTLP_ENDPOINT` key in
  `~/.claude/settings.json`, not a top-level key.
- The fleet's actual OTel collector network address is intentionally **not** recorded in this
  public repo, per the standing rule against committing our tailnet IP or hostnames here — see
  local (untracked) LaunchAgent/`.env` configuration on each host for the real endpoint.
