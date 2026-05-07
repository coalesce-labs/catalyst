# Slack MCP wiring

## URL

`https://mcp.slack.com/mcp` — Streamable HTTP (JSON-RPC 2.0). GA since
2026-02-17.

## Auth model

Slack MCP requires **confidential OAuth 2.0** with a user-token flow against
a Slack app that is either:
- Published in the Slack App Directory, OR
- Installed as an internal app in the user's workspace

There is **no API-key / bearer-token shortcut** for the MCP server. Headless
CMA sessions cannot complete the OAuth dance autonomously — a one-time
human-driven flow is required, after which the resulting access + refresh
tokens are stored in the vault.

For Phase 1 routines, the recommended path is the **bot-token REST fallback**
(see below) until a routine actually needs a tool that REST does not expose
(canvas operations, full message search). The MCP path can be wired later
without re-architecting.

## Two paths for Phase 1

### Path A (recommended for now): Slack REST with a bot token

This is simpler, takes ~5 minutes, and works headlessly.

1. Create a Slack app at <https://api.slack.com/apps> -> **Create New App** -> **From scratch**
2. Name it (e.g., `Catalyst Routines`)
3. Choose your workspace
4. Under **OAuth & Permissions** -> **Bot Token Scopes**, add the scopes the
   routine needs. Common minimum:
   - `chat:write` — post messages
   - `channels:read`, `channels:history` — read public channel messages
   - `users:read` — look up users by name
5. Click **Install to Workspace**, approve
6. Copy the **Bot User OAuth Token** (starts with `xoxb-`)
7. Invite the bot to each channel it will post in: `/invite @Catalyst Routines`
   from inside Slack

Vault entry:

```yaml
# cma/vaults/example.yaml
- type: static_bearer
  mcp_server_url: https://slack.com/api/
  token: ${SLACK_BOT_TOKEN}       # xoxb-...
```

(The vault's `mcp_server_url` field is purely a credential index here — the
agent calls Slack REST directly, not via an MCP server.)

REST usage from the agent:

```bash
curl -X POST \
  -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
  -H "Content-Type: application/json; charset=utf-8" \
  --data '{"channel":"C012345","text":"Daily update: ..."}' \
  https://slack.com/api/chat.postMessage
```

### Path B: Slack MCP (hosted, OAuth)

Required when a routine needs:
- `search_messages_and_files` (workspace-wide message search)
- `create_canvas` / `update_canvas` / `read_canvas` (Slack canvases)
- User-token operations (acting as a specific user, not a bot)

Setup:

1. Build a Slack app (same as Path A) OR use a directory-published app
2. Configure OAuth in the app:
   - Authorization endpoint: `https://slack.com/oauth/v2_user/authorize`
   - Token endpoint: `https://slack.com/api/oauth.v2.user.access`
3. Add **User Token Scopes** (these are different from bot scopes):
   - `search:read.public`, `search:read.private`, `search:read.mpim`,
     `search:read.im`, `search:read.files` — message/file search
   - `search:read.users` — user search
   - `channels:history`, `groups:history`, `mpim:history`, `im:history`
     — channel/thread reads
   - `chat:write` — send message as user
   - `canvases:read`, `canvases:write` — canvas ops
   - `users:read`, `users:read.email` — profile reads
4. Install the app in workspace and complete the OAuth user-authorize flow
   manually once. Capture `access_token` and `refresh_token` from the
   `oauth.v2.user.access` response.
5. Store in vault as `mcp_oauth`:

```yaml
# Add to vault AFTER OAuth dance is complete
- type: mcp_oauth
  mcp_server_url: https://mcp.slack.com/mcp
  client_id: ${SLACK_CLIENT_ID}
  client_secret: ${SLACK_CLIENT_SECRET}
  access_token: ${SLACK_ACCESS_TOKEN}
  refresh_token: ${SLACK_REFRESH_TOKEN}
```

CMA refreshes access tokens server-side using the refresh token.

## Tools exposed (Path B only)

11 tools, mix of read+write:

| Tool | Type |
|------|------|
| `search_messages_and_files` | read |
| `search_users` | read |
| `search_channels` | read |
| `send_message` | write |
| `read_channel` | read |
| `read_thread` | read |
| `draft_message` | write |
| `create_canvas` | write |
| `update_canvas` | write |
| `read_canvas` | read |
| `read_user_profile` | read |

## Network allowlist

Already in `cma/environment.yaml`:
- `mcp.slack.com` — MCP endpoint (Path B)
- `slack.com` — REST API (Path A)

## Rate limits

Tier 2 (20+/min): user/channel searches, canvas creation
Tier 3 (50+/min): channel reads, canvas updates
Tier 4 (100+/min): canvas reads, profile reads

For daily-update routines (CTL-291), Tier 4 is fine; Tier 2 limits
search-heavy routines to ~1200 ops/hour.

## Known limitations

- Path B requires a Slack workspace admin to install or directory-publish
  the app. Unpublished dev apps cannot use the remote MCP.
- Bot tokens (Path A) cannot do message search, cannot impersonate users,
  and require explicit channel invites for `chat:write`.
- User tokens (Path B) act as a specific user; rate limits are per-user.

## References

- [Announcing the Slack MCP server (Feb 2026)](https://docs.slack.dev/changelog/2026/02/17/slack-mcp/)
- [Slack MCP overview](https://docs.slack.dev/ai/slack-mcp-server/)
- [Guide to the Slack MCP server](https://slack.com/help/articles/48855576908307-Guide-to-the-Slack-MCP-server)
