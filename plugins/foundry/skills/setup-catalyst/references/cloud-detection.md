# Cloud mirror detection — Ryan direction 2026-08-25

`setup-catalyst` is one of the skills that reads Linear state (workflow states, git automations, the `botUserId` guard — see [linear-workspace.md](linear-workspace.md)) and diagnoses the local `catalyst-replica.db` mirror. Don't treat that replica as authoritative silently — detect whether THIS host actually runs the Catalyst Cloud mirror first, and say so out loud either way.

## The check — two signals, both required

1. **Replica presence + freshness.** Reuse the freshness-gate helper `catalyst-dev:linearis`'s reading rule already implements — do not hand-roll a second check:
   ```bash
   source "${CLAUDE_PLUGIN_ROOT:-plugins/foundry}/scripts/require-catalyst-dev.sh" \
       "${CLAUDE_PLUGIN_ROOT:-plugins/foundry}" || exit 1
   source "${CATALYST_DEV_SCRIPTS}/lib/linear-read-replica.sh"
   replica_fresh && echo "replica fresh" || echo "replica stale/absent"
   ```
   `replica_fresh` passes when the writer heartbeat (`<db>.writer.lock` mtime) is < 5 min old AND `sync_meta` has a non-empty `cursor` row (seed complete, not mid-reseed) — the same gate the daemon's `execution-core/replica-read.mjs` and the `linear_read_ticket` helper use.
2. **The opt-in marker.** `check-setup.sh` (Phase 1) resolves this the same way: `catalyst.linearReplica.mode == "on"` in the **Layer-2** runtime config (`${XDG_CONFIG_HOME:-$HOME/.config}/catalyst/config.json` — this is a per-node setting written by `catalyst-stack activate-replica`, NOT the project-level `.catalyst/config.json`), **or** the `CATALYST_LINEAR_REPLICA=on`/`=1` environment variable, which always wins when set. Read both the same way check-setup.sh does — don't invent a third source.

Both signals present → this host is cloud-mirrored; read the replica and trust it. Either one missing → **no cloud** for this session.

## Loud fallback — not a silent reroute, and never a bare `linearis` shell-out

When either signal is absent, say so out loud (the same loud stale/absent pattern the reading contract already uses for staleness):

> No Catalyst Cloud replica mirror detected on this host (no fresh `catalyst-replica.db` and/or the runtime config lacks `linearReplica.mode: "on"` / `CATALYST_LINEAR_REPLICA`). Falling back for this setup session.

For any **single-ticket** read after that message, still call `linear_read_ticket <ID>` (from the same `lib/linear-read-replica.sh` sourced above) rather than shelling `linearis issues read` directly — the helper re-runs its own freshness gate, applies the timeout cap, and emits the read-outcome telemetry event; a bare `linearis` call skips all three and can also be rejected outright by the `detect-bare-linear-read.sh` PreToolUse hook. Reserve a direct `linearis` invocation for writes and for list/search operations that have no replica form (see `catalyst-dev:linearis`). Never silently degrade, guess, or read nothing with no signal — the point of the loud message is that a future reader (human or agent) can tell which path ran.

**This fallback is the non-fleet path, not an equal alternative.** A bare `linearis` read hits the shared, rate-limited 2500/hr Linear API quota the whole fleet draws from — the incident history behind `detect-bare-linear-read.sh` and the replica-first house rule. It is correct and safe for a single non-cloud user setting up Catalyst alone; it is actively the wrong thing to recommend to anyone running the fleet-scale relay/cloud workflow this repo is built for. Say so plainly when you take this branch — don't let a reader mistake it for "either path is fine."

## Cloud replica writer health

`check-setup.sh`'s Phase 1 output carries these checks directly — the per-node `catalyst-cloud-sync` writer that keeps the replica current, nothing extra to run:

| Symptom | Meaning | Fix |
|---|---|---|
| "cloud-sync agent not loaded" | The launchd writer isn't adopted on this host | `catalyst-stack adopt-cloud-sync` |
| "no local replica db" | Writer never connected — this host reads Linear directly (see above) | Provision a cloud token: `setup-catalyst.sh --cloud-token <token> --cloud-account <id>` (or `CATALYST_CLOUD_TOKEN`/`CATALYST_CLOUD_ACCOUNT`) |
| "replica db present but unreadable" | Locked or corrupt | Check for a stuck writer process; needs-user-input |
| "replica db empty (0 issues)" | Writer connected but not seeded yet | Wait for first sync, or check writer logs |
| "replica newest change is >1h old" | Writer may be down/stale | Check `catalyst-stack` status; restart the writer agent |
| "`CATALYST_LINEAR_REPLICA=on` but no local replica db" | Reads MISS through to `linearis` on every call | Provision the token (above) or turn the flag off |
| Cloud token not in the launchd-sourced files | `~/.config/catalyst/cloud-sync.env` missing/unreadable | Needs user input — never write the token yourself; see [needs-user-input.md](needs-user-input.md) |

All of these are **needs-user-input or manual-only**, never auto-fixable: the cloud token is a credential and the account id is workspace-specific.

## Execution-core daemon proxy audit (still a live check — machine-local, opt-in)

The legacy execution-core daemon is not this skill's diagnostic focus any more — it is not the live dispatch mechanism (relay/cloud is) — but `check-setup.sh` still runs this audit today, so a host that has `~/.config/catalyst/execution-core.env` (override: `CATALYST_EXECUTION_CORE_ENV`) still gets it checked, and you still need to relay the result. An absent file is a no-op and the common case. When the file sets a proxy, `check-setup.sh` verifies it and warns on: (a) the proxy port not listening, (b) `NODE_EXTRA_CA_CERTS` pointing at a missing file, or (c) `NODE_USE_ENV_PROXY=1` missing (Node's native fetch ignores `HTTPS_PROXY`/`HTTP_PROXY` without it). Treat any of these as **needs-user-input** — relay the specific warning and fix from `check-setup.sh`'s own output, never write a machine-specific path for the user, and remind them to restart whatever consumes the env file after editing it. This is orthogonal to the cloud-mirror checks above: a host can have both, either, or neither configured.
