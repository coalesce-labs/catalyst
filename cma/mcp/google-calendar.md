# Google Calendar MCP wiring

## URLs

| Endpoint | Path | Auth | Headless |
|----------|------|------|----------|
| REST API | `https://www.googleapis.com/calendar/v3` | Bearer (OAuth access token from refresh) | **Yes** — recommended |
| Hosted MCP | `https://calendarmcp.googleapis.com/mcp/v1` | Bearer (same OAuth access token) | Pending verification |
| claude.ai connector | `claude.ai/customize/connectors` | OAuth user grant | Read-only; insufficient for routines that schedule events |

For Phase 1 Routines, **use Path A** (OAuth refresh token + Calendar
v3 REST). The hosted Google Calendar MCP is documented by Google but
not yet end-to-end verified by this project. The claude.ai first-party
Calendar connector exists and (unlike Google Drive) **does** pass
through to Claude Code sessions, but it is read-only — fine for
morning briefings, insufficient for the follow-up-skill use case
(Initiative 3) that needs to create events.

## Two paths for Phase 1

### Path A (recommended): OAuth refresh token + Calendar v3 REST

Calendar reuses the same OAuth client as Google Drive — one client,
one refresh token, multiple scopes. **Do the OAuth setup once in
[google-drive.md](google-drive.md)** (steps 1-5); when you run the
local consent flow, include the calendar scopes alongside the Drive
scope:

```python
SCOPES = [
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/calendar.events.readonly",
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
]
```

The same `client_id`, `client_secret`, `refresh_token` stored in the
CMA vault for Drive (`GOOGLE_OAUTH_*`) cover Calendar.

You must also **enable the Calendar API** in the same GCP project at
<https://console.cloud.google.com/apis/library/calendar-json.googleapis.com>.

REST usage from the agent (after exchanging the refresh token for an
access token — see [google-drive.md](google-drive.md) for the
`oauth2.googleapis.com/token` exchange):

```bash
# List today's events on the primary calendar
TODAY=$(date -u +%Y-%m-%dT00:00:00Z)
TOMORROW=$(date -u -v+1d +%Y-%m-%dT00:00:00Z 2>/dev/null \
  || date -u -d tomorrow +%Y-%m-%dT00:00:00Z)
curl -s -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  --get \
  --data-urlencode "timeMin=${TODAY}" \
  --data-urlencode "timeMax=${TOMORROW}" \
  --data-urlencode "singleEvents=true" \
  --data-urlencode "orderBy=startTime" \
  "https://www.googleapis.com/calendar/v3/calendars/primary/events" \
  | jq '.items[] | {summary, start, end}'

# List all calendars the user has access to (resolve non-primary
# calendarId values)
curl -s -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  "https://www.googleapis.com/calendar/v3/users/me/calendarList" \
  | jq '.items[] | {id, summary, accessRole}'
```

### Path B: Google Calendar hosted MCP (pending verification)

Google ships (per Google's developer docs) a hosted MCP server at
`https://calendarmcp.googleapis.com/mcp/v1` in Developer Preview. The
expected tool inventory:

| Tool | Operation |
|------|-----------|
| `list_calendars` | Enumerate accessible calendars |
| `list_events` | Retrieve events by time range and calendar ID |
| `get_event` | Fetch a single event |
| `suggest_time` | Find availability across calendars |
| `create_event` | Add an event |
| `update_event` | Modify an existing event |
| `delete_event` | Remove an event |
| `respond_to_event` | Accept / decline / tentative RSVP |

**Pending verification.** Same shape as the Drive Path B check —
present the access token to the MCP server and confirm `tools/list`:

```bash
curl -s -X POST https://calendarmcp.googleapis.com/mcp/v1 \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

If reachable, a follow-up PR uncomments
`calendarmcp.googleapis.com` in `cma/environment.yaml` and adds the
endpoint to `cma/agents/base.yaml`.

## Maintained community options (if Google's hosted MCP doesn't pan out)

Two OSS Google Calendar MCP servers worth knowing about:

| Repo | Auth | Service account? | Last release |
|------|------|------------------|--------------|
| [nspady/google-calendar-mcp](https://github.com/nspady/google-calendar-mcp) | OAuth 2.0 (Desktop app), tokens stored locally | No | v2.6.1 (2026-03-02) |
| [taylorwilsdon/google_workspace_mcp](https://github.com/taylorwilsdon/google_workspace_mcp) | OAuth 2.0/2.1 OR service account + DWD OR external bearer | Yes (Workspace domains only) | v1.20.4 (2026-05-07) |

`taylorwilsdon/google_workspace_mcp` is the more flexible option and
supports calendar-only deploys with `uvx workspace-mcp --tools calendar`.
Defer either of these only if Path A REST stops being sufficient.

## Anthropic claude.ai first-party Calendar connector

Unlike Google Drive (which has the open passthrough bug — see
[google-drive.md](google-drive.md)), the Calendar connector at
`claude.ai/customize/connectors` **does** pass through to Claude Code
sessions. However:

- It is **read-only** — cannot create, modify, or delete events; cannot
  send invitations
- It is single-account only (multi-account is the most-requested open
  feature as of 2026-05)
- It requires an interactive OAuth grant tied to a Claude account, not
  a vault-stored credential

For the morning-briefing Routine (read-only event listing), the
claude.ai connector is technically sufficient and could be used as a
backup. For the follow-up Routine (Initiative 3, schedules calendar
entries), the claude.ai connector is insufficient — Path A REST is
required.

Standardizing on Path A REST across both Routines avoids the surface-
area difference and keeps the vault as the single source of credentials.

## Tools exposed (Path B, pending verification)

See the Path B table above.

## Network allowlist

Already in `cma/environment.yaml` (added by CTL-456, shared with
[google-drive.md](google-drive.md)):

- `oauth2.googleapis.com` — refresh-token → access-token exchange
- `accounts.google.com` — initial OAuth consent (setup only)
- `www.googleapis.com` — Calendar v3 + Drive v3 REST

The hosted MCP endpoint `calendarmcp.googleapis.com` is documented in
the allowlist but commented out until end-to-end verification confirms
it.

Calendar adds no new hosts on top of Drive's allowlist — the OAuth +
REST stack is shared.

## OAuth scope minimums

For the morning-briefing Routine's "list today's events" use case:

| Scope | Purpose |
|-------|---------|
| `https://www.googleapis.com/auth/calendar.events.readonly` | View events on all calendars — minimum for `events.list` |
| `https://www.googleapis.com/auth/calendar.calendarlist.readonly` | See subscribed calendar list — needed to resolve non-primary `calendarId` values |

For Initiative 3 (follow-up routine that schedules events), add:

| Scope | Purpose |
|-------|---------|
| `https://www.googleapis.com/auth/calendar.events` | Create / update / delete events on calendars the user owns |

Avoid the broader `https://www.googleapis.com/auth/calendar` (includes
settings + ACL management) unless a future routine genuinely needs it.

## Service account vs OAuth user flow

Same considerations as Google Drive (see
[google-drive.md](google-drive.md) §"Service account vs OAuth user
flow"). Personal `@gmail.com` accounts cannot use service account +
Domain-Wide Delegation — OAuth refresh token is the only practical
headless path.

For Google Workspace domains, service account + DWD with the calendar
scopes above is also a valid headless path; document and switch only
if a Workspace-domain user adopts these Routines.

## Known limitations

- The hosted Google MCP (`calendarmcp.googleapis.com`) is in Developer
  Preview per Google's docs; not first-hand verified by this project
- The claude.ai first-party connector is read-only — fine for morning
  briefings, insufficient for Initiative 3's scheduling routine
- DWD requires a Google Workspace domain; personal `@gmail.com`
  accounts cannot use service account impersonation
- Calendar event-list responses include declined events by default;
  the morning-briefing skill should filter by `responseStatus` if
  needed
- The `singleEvents=true` parameter expands recurring events — without
  it, recurring events appear once with their RRULE and the routine
  has to expand them client-side

## References

- [Configure the Calendar MCP server — Google Developers](https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server)
- [MCP Reference: calendarmcp.googleapis.com — Google Developers](https://developers.google.com/workspace/calendar/api/v3/reference/mcp)
- [Calendar API v3 — events.list reference](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)
- [Choose Google Calendar API scopes](https://developers.google.com/workspace/calendar/api/auth)
- [nspady/google-calendar-mcp — community MCP server](https://github.com/nspady/google-calendar-mcp)
- [taylorwilsdon/google_workspace_mcp — community Workspace MCP server](https://github.com/taylorwilsdon/google_workspace_mcp)
- [Google Calendar connector — claude.com docs](https://claude.com/docs/connectors/google/calendar)
- [Use Google Workspace connectors — Claude Help Center](https://support.claude.com/en/articles/10166901-use-google-workspace-connectors)
