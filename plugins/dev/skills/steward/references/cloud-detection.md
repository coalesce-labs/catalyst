# Cloud detection — before you trust the replica

Steward (and concierge) assume a live Catalyst Cloud replica by default. That assumption is not always
true — a single non-fleet operator, or a host with no mirror running, has neither. Ryan direction
(2026-08-25 evening, CTL-2218 Phase D): make the assumption a **checked, recoverable** fact, not a silent
one. This is the canonical version — pointed to, not copied, from `concierge`.

## The check — both parts, every time you boot or start a new scope pass

**1. Replica existence + freshness.** Reuse the existing freshness-gate helper — do not write a second
one:

```bash
source "${CLAUDE_PLUGIN_ROOT:?}/scripts/lib/linear-read-replica.sh"
replica_fresh   # rc 0: writer heartbeat lock recent AND sync_meta has a cursor row. rc 1: stale/absent.
```

**2. The `.catalyst` project-config marker.** Presence of a `.catalyst/config.json` walking up from the
worktree says this host is configured to run against the Catalyst Cloud stack at all — reuse the existing
resolver, do not hand-roll a second walk:

```bash
source "${CLAUDE_PLUGIN_ROOT:?}/scripts/lib/plugin-dirs.sh"
marker="$(plugin_dirs_repo_config_path)"   # path to .catalyst/config.json, or "" if none found
```

**Cloud mode requires BOTH.** `replica_fresh` failing OR `marker` empty means "no cloud" for this
session — treat the replica as **not** authoritative and take the fallback below.

## The fallback — loud, never silent

When either check fails, say so out loud before reading anything, the same "loud stale/absent" pattern
`linear_read_ticket` already uses for a single read:

```bash
if ! { replica_fresh && [[ -n "$marker" ]]; }; then
  echo "⚠️ cloud-detection: NO Catalyst Cloud mirror on this host (replica_fresh=$?, marker=${marker:-absent})." \
       "Falling back to direct linearis/Linear-API reads — the non-fleet path. See references/cloud-detection.md." >&2
  # now use `linearis issues list/search/read` directly for this pass
fi
```

For a **single ticket** read, don't hand-roll this at all — `linear_read_ticket <ID>` (same file) already
runs the freshness half of this gate and performs the loud fallback per-read; call it directly instead of
re-deriving the logic. The two-part check above is for the coarser, session-level question — "should I
even attempt scope-wide replica reads this pass" — which `linear_read_ticket` doesn't answer on its own.

## This fallback is the non-fleet path, not an equal alternative

The replica exists specifically so bulk Linear reads never hit the Linear API directly: a bare
`linearis`/API read draws on the **shared, rate-limited 2500/hr quota** the whole fleet shares, and
exhausting it stalls every agent on the host — measured, not hypothetical (the incident history behind
`detect-bare-linear-read.sh` and the replica-first house rule in `catalyst-dev:linearis`).

That makes the fallback **correct and safe for a single operator working alone without the cloud stack**,
and **actively wrong to recommend to anyone running the fleet-scale workflow this repo is built for.**
If you find yourself on the fallback path while other agents are active on this host, that is a
writer/mirror gap worth a ticket — not a state to normalize as "either path is fine."
