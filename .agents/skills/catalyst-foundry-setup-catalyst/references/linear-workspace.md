# Linear workspace scaffolding

These checks are Linear-side team infrastructure the relay/cloud dispatch model depends on — steward's Todo dispatch, relay-ticket's phase transitions, the app-actor's threaded replies — not anything specific to the retired execution-core daemon. Gate all of this on [cloud-detection.md](cloud-detection.md) first: these steps write to Linear directly via `linearis`, so they run regardless of replica state, but any *read* they do first should follow the detection + fallback pattern.

## Workflow states (CTL-564)

`setup_execution_core_states` (delegates to `plugins/dev/scripts/setup-execution-core-states.sh`) ensures the team's Linear workflow states exist — `Todo`, `Research`, `Plan`, `Implement`, `Validate`, `PR` (`Triage` already exists on every team) — and upserts the team's entry in `~/catalyst/execution-core/registry.json`. **The states themselves, and what moves a ticket between them, are documented once in `catalyst-dev:linearis` — this reference does not restate that table.** A Linear-permission failure here never aborts setup; it's best-effort and idempotent — safe to re-run per team: `setup-execution-core-states.sh --config .catalyst/config.json [--dry-run] [--json]`.

## Git automations (CTL-759)

As its last Linear step, the same script reconciles Linear's built-in "move ticket on git event" automations: pins exactly two (`start` → `PR`, `merge` → `Done`) and deletes any `review` automation, so ticket-state transitions stay deterministic under relay dispatch instead of racing a stray Linear automation. Best-effort — a permission/transport failure prints a WARNING and continues; it never aborts setup or alters the script's exit codes.

Linear's **branch-name "magic words" toggle** (Settings → Team → Workflow → Git) has no API surface and **cannot** be reconciled — it must be turned OFF by hand, or it races a relay worker mid-flight and moves a ticket's state out from under it.

## Linear app-actor self-echo guard (`botUserId`, CTL-550/CTL-749/CTL-549)

`catalyst.monitor.linear.botUserId` is the Linear user UUID of the Catalyst app-actor — the "Linear for Agents" identity every steward/concierge/relay-ticket reply is authored as (`catalyst-dev:ask`'s threading contract, `linear-reply.mjs`). Anything that watches Linear comments to decide "did a human reply" needs this value to tell the app-actor's own threaded replies apart from a human's — without it, an agent's own comment can be misread as human input and re-trigger work.

Workspace-specific, not shipped in the committed template (`config.template.json` keeps it `null`). Not secret — it appears on every comment the app posts — but it must be obtained per workspace and written into `.catalyst/config.json → catalyst.monitor.linear.botUserId`:

```bash
TOKEN=$(jq -r '.catalyst.linear.agent.accessToken' ~/.config/catalyst/config-<projectKey>.json)
BOT_ID=$(curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"query{viewer{id name}}"}' | jq -r .data.viewer.id)
```

(Alternatively, mint a fresh app token via `grant_type=client_credentials` with `actor=app` and `scope="app:mentionable,app:assignable"` at `POST https://api.linear.app/oauth/token`, then run the same `viewer{id}` query.) This is a **needs-user-input** step — it requires the app-actor's own credentials — never write the value for the user without confirming it came from their own token.
