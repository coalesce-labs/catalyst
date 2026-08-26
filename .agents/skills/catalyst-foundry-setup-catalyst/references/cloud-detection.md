# Cloud mirror detection — Ryan direction 2026-08-25

`setup-catalyst` is one of the skills that reads Linear state (workflow states, git automations,
the `botUserId` guard — see [linear-workspace.md](linear-workspace.md)) and diagnoses the local
`catalyst-replica.db` mirror. Don't treat that replica as authoritative silently — detect whether
THIS host actually runs the Catalyst Cloud mirror first, and say so out loud either way.

## The check — two signals, both required

1. **Replica presence + freshness.** Reuse the freshness-gate helper `catalyst-dev:linearis`'s
   reading rule already implements — do not hand-roll a second check:
   ```bash
   source "${CLAUDE_PLUGIN_ROOT:-plugins/foundry}/scripts/require-catalyst-dev.sh" \
       "${CLAUDE_PLUGIN_ROOT:-plugins/foundry}" || exit 1
   source "${CATALYST_DEV_SCRIPTS}/lib/linear-read-replica.sh"
   replica_fresh && echo "replica fresh" || echo "replica stale/absent"
   ```
   `replica_fresh` passes when the writer heartbeat (`<db>.writer.lock` mtime) is < 5 min old AND
   `sync_meta` has a non-empty `cursor` row (seed complete, not mid-reseed) — the same gate the
   daemon's `execution-core/replica-read.mjs` and the `linear_read_ticket` helper use.
2. **The project-config marker.** `.catalyst/config.json → catalyst.linearReplica.mode == "on"` —
   the project has explicitly opted into replica reads (the same key
   `plugins/dev/scripts/check-project-setup.sh` checks).

Both signals present → this host is cloud-mirrored; read the replica and trust it. Either one
missing → **no cloud** for this session.

## Loud fallback — not a silent reroute

When either signal is absent, say so out loud (the same loud stale/absent pattern the reading
contract already uses for staleness), then fall back to direct `linearis`/Linear-API reads for the
rest of the session:

> No Catalyst Cloud replica mirror detected on this host (no fresh `catalyst-replica.db` and/or
> `.catalyst/config.json` lacks `linearReplica.mode: "on"`). Falling back to direct `linearis`
> reads for this setup session.

Never silently degrade, guess, or read nothing with no signal — the message exists so a future
reader (human or agent) can tell which path ran.

**This fallback is the non-fleet path, not an equal alternative.** A bare `linearis` read hits the
shared, rate-limited 2500/hr Linear API quota the whole fleet draws from — the incident history
behind `detect-bare-linear-read.sh` and the replica-first house rule. It is correct and safe for a
single non-cloud user setting up Catalyst alone; it is actively the wrong thing to recommend to
anyone running the fleet-scale relay/cloud workflow this repo is built for. Say so plainly when you
take this branch — don't let a reader mistake it for "either path is fine."

## Cloud replica writer health (replaces the old daemon proxy audit)

There is no execution-core daemon proxy to audit any more. What `check-setup.sh` diagnoses instead
is the per-node `catalyst-cloud-sync` writer that keeps the replica current — its Phase 1 output
carries these checks directly, nothing extra to run:

| Symptom | Meaning | Fix |
|---|---|---|
| "cloud-sync agent not loaded" | The launchd writer isn't adopted on this host | `catalyst-stack adopt-cloud-sync` |
| "no local replica db" | Writer never connected — this host reads Linear directly (see above) | Provision a cloud token: `setup-catalyst.sh --cloud-token <token> --cloud-account <id>` (or `CATALYST_CLOUD_TOKEN`/`CATALYST_CLOUD_ACCOUNT`) |
| "replica db present but unreadable" | Locked or corrupt | Check for a stuck writer process; needs-user-input |
| "replica db empty (0 issues)" | Writer connected but not seeded yet | Wait for first sync, or check writer logs |
| "replica newest change is >1h old" | Writer may be down/stale | Check `catalyst-stack` status; restart the writer agent |
| "`CATALYST_LINEAR_REPLICA=on` but no local replica db" | Reads MISS through to `linearis` on every call | Provision the token (above) or turn the flag off |
| Cloud token not in the launchd-sourced files | `~/.config/catalyst/cloud-sync.env` missing/unreadable | Needs user input — never write the token yourself; see [needs-user-input.md](needs-user-input.md) |

All of these are **needs-user-input or manual-only**, never auto-fixable: the cloud token is a
credential and the account id is workspace-specific.
