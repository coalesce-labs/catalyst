---
title: orch-monitor API
description:
  Read-only HTTP surfaces served by the orch-monitor process, including the per-node Claude-account
  posture endpoint.
sidebar:
  order: 25
---

The orch-monitor process serves the dashboards (web + HUD) and a set of read-only HTTP endpoints.
This page documents the **Claude-account posture** surface (CTL-1653); it is per-node and token-free
by construction.

## `GET /api/accounts`

Returns **this node's** Claude-account posture: the active account, each account's 5h/7d utilization
/ reset times / status, and a sibling account with headroom. The response is derived from the
CTL-1650 durable-token probe run in a token-scoped subshell, so **no token value ever appears in the
response** (or in the monitor's own environment).

- **Cached** (~5 min TTL). Repeated calls within the TTL are served from cache — the same `probedAt`
  is returned and no inference call is spent.
- **`?refresh=true`** forces a fresh probe (operator-initiated; the only per-request probe path).
  Requires the `X-Catalyst-Refresh` header (any value) **and** a trusted `Origin` when one is
  present. The header is what actually stops the vector: this route is a GET, so a browser
  navigating to (or embedding) the URL directly sends no `Origin` at all, and neither a header-less
  request nor an untrusted `Origin` is accepted — a plain read (no `refresh`) needs neither.
  ```bash
  curl -H "X-Catalyst-Refresh: 1" "http://localhost:7400/api/accounts?refresh=true"
  ```
- **Disabled** — on a node with no `claude-accounts.env` (or when the probe is disabled), the
  endpoint returns `{ "available": false, "node": "<host>" }`.

```json
{
  "available": true,
  "node": "mini-2",
  "generatedAt": "2026-08-05T12:00:00.000Z",
  "probedAt": 1754395200000,
  "cached": false,
  "status": "rejected",
  "active": {
    "label": "acctA",
    "email": "a@example.io",
    "overallStatus": "rejected",
    "representativeClaim": "seven_day",
    "bindingWindow": "seven_day",
    "bindingStatus": "rejected",
    "fiveHour": { "pct": 40, "resetsAt": "2026-08-05T13:00:00.000Z", "status": "allowed" },
    "sevenDay": { "pct": 100, "resetsAt": "2026-08-06T00:00:00.000Z", "status": "rejected" },
    "error": null
  },
  "accounts": [/* one token-free view per account */],
  "siblingWithHeadroom": { "label": "acctB", "email": "b@example.io" }
}
```

The node-level `status` is one of:

| `status`   | Meaning                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------- |
| `ok`       | The active account's binding window is `allowed`.                                        |
| `degraded` | The binding window is `allowed_warning` (nearing the limit).                             |
| `rejected` | The active account is exhausted (binding window `rejected`) — the loud state.            |
| `error`    | The probe hit a transport failure (the sensor is broken, **not** the account exhausted). |
| `unknown`  | No account is active (`CLAUDE_CODE_OAUTH_TOKEN` unset).                                  |

## `GET /api/accounts/stream`

An SSE stream of the same posture. On connect it emits the current cached summary immediately; a
periodic probe (default 5 min) then pushes a fresh frame on each refresh. Each event:

```text
event: account
data: { …the /api/accounts summary body… }

```

The web footer + HUD strip subscribe to this stream so the active-account indicator and the loud
exhausted banner/overlay update live without a reload. When the active account's binding window
transitions `ok`↔`rejected`, the monitor also appends one edge-triggered
[`account.status.changed`](/reference/cluster-config-mirror/#account-status-transition-event-ctl-1653)
event to the unified event log.

## Related

- [`catalyst-stack claude-account`](/reference/catalyst-stack/#claude-account-ctl-1650) — the CLI
  that inspects and switches the fleet's active account.
- [Account status-transition event](/reference/cluster-config-mirror/#account-status-transition-event-ctl-1653)
  — the `account.status.changed` v2 event schema.
