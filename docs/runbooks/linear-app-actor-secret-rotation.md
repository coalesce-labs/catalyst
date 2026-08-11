---
title: Linear app-actor secret rotation
status: accepted
ticket: CAT-158
created: 2026-08-11
---

# Linear app-actor secret rotation

Use this procedure when an app-actor bearer token reaches a log, transcript, or screen share; when
an actor identity may be compromised; or as scheduled credential hygiene. CAT-158 is the worked
example: the `orchestrator` and `linearis` actor credentials require rotation after their minted
tokens appeared in a persisted transcript. The `worker` actor was not exposed and is not part of
that incident.

Rotation is an operator action. Never paste a client secret into a ticket, chat, transcript, shell
history, or committed file.

## Blast radius

Each actor is a distinct Linear OAuth application, so rotating one does not invalidate the others.

| Actor | Consumers |
| --- | --- |
| `orchestrator` | Execution-core, broker, and monitor run-level Linear operations |
| `worker` | Phase-agent mirror comments and worker-facing writes |
| `linearis` | Phase-agent workers' `linearis` operations, where this actor is configured |

The `linearis` app-actor row and four-argument mint helper currently exist in the installed
plugin-source tree. A checkout without that row cannot mint this actor locally; rotate and verify it
from a host whose installed Catalyst configuration includes it.

## Procedure for each affected actor

1. In Linear's workspace OAuth application settings, select the OAuth application for the actor and
   regenerate its client secret. Record the application `clientId` and new `clientSecret` only in
   the approved secret-handling channel.
2. Project `{clientId, clientSecret}` to `catalyst.linear.bot.<actor>` on every applicable host:

   - For a node-local installation, edit `~/.config/catalyst/config.json` directly and retain its
     restrictive permissions. Sophon currently uses this model: it has neither
     `~/catalyst/catalyst-cluster` nor `~/.config/catalyst/age.key`.
   - For a SOPS-enrolled fleet, update and commit the encrypted `cluster-bots.sops.json` source once,
     then let cluster sync project it to node configs. Check each host for the cluster clone and age
     key instead of assuming enrollment.

3. Apply the restart behavior in the matrix below.
4. Run the verification steps before declaring the rotation complete.

Repeat all four steps separately for `orchestrator` and `linearis` in the CAT-158 incident. Do not
rotate `worker` for CAT-158 unless independent evidence shows that credential was exposed.

## Restart matrix

| Consumer class | Restart after a node-local edit? | Behavior |
| --- | --- | --- |
| Shell-level start-time mints (`catalyst-execution-core`, `catalyst-broker`, `catalyst-monitor`) | Required | Restart each affected service so it mints with the new secret. |
| In-process re-minters (`linear-remint.mjs`) | No | The secret is re-read from disk on the next 401 or timer attempt; the ordinary cooldown is 60 seconds. |
| Phase-agent workers using `linearis` | No | A fresh token is minted for each dispatch. The next dispatch reads the rotated credential. |

For the SOPS GitOps model, secrets decrypt at boot. A secret rotation therefore requires a worker
restart even when the consumer category would otherwise re-read a node-local file.

## Verification

On every updated host, verify each configured actor by minting with its stored client credentials
and checking the resulting Linear viewer identity:

```bash
catalyst-doctor --verify-app-actors
```

For machine-readable output:

```bash
catalyst-doctor --verify-app-actors --json \
  | jq '.checks[] | select(.name | startswith("app-actor"))'
```

Each actor must PASS and its viewer id must match `catalyst.linear.bot.<actor>.botUserId`. A rejected
mint points back to that actor's `clientSecret`; an identity mismatch usually means credentials were
placed under the wrong actor key.

As a secondary startup check, look for `authenticated as … (isolated 5000/hr bucket)`. The launcher
shell emits this before each daemon's `nohup` redirect, so it appears on the starting terminal or in
`~/catalyst/stack-launchd.log`, not reliably in `daemon.log`, `broker.log`, or `monitor.log`.
In-process recovery messages such as `ctl-785: orchestrator token re-minted after auth error` do
land in `daemon.log`.

## Known limitations

- Catalyst does not read or act on Linear's OAuth `expires_in`; rotation is the only definitive
  invalidation procedure documented here for a leaked bearer token.
- Rotation does not remove bearer tokens from daemon process environments. That exposure remains
  outside CAT-158's implementation scope.
- Actor availability differs between the installed plugin-source tree and older checkouts. The
  verifier enumerates the live Layer-2 `catalyst.linear.bot` object rather than assuming a fixed
  actor registry.

