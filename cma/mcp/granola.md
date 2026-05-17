# Granola MCP wiring

## URLs

| Endpoint | Path | Auth | Headless |
|----------|------|------|----------|
| REST API | `https://public-api.granola.ai/v1` | Bearer (Personal API key) | **Yes** — recommended |
| Hosted MCP | `https://mcp.granola.ai/mcp` | OAuth 2.1 + Dynamic Client Registration | No — browser-only |

The hosted MCP server at `mcp.granola.ai` cannot be used by a headless
CMA session. Granola's docs explicitly state there is no API key or
service-account auth path for the MCP server — only OAuth 2.1 + DCR,
which requires a live browser. For Routines, use Path A (REST).

## Two paths for Phase 1

### Path A (recommended for now): Granola REST with a Personal API key

This is the only headless path and takes ~2 minutes.

1. Open the Granola **desktop app** (the key is not provisioned from
   the web app)
2. **Settings** -> **Connectors** -> **API Keys** -> **Create new key**
3. Select **Personal API key**, give it a label (e.g.,
   `Catalyst Routines`)
4. Copy the `grn_...` value once shown — Granola does not display it
   again
5. (Enterprise workspaces only) An admin must first enable personal
   API keys at **Settings** -> **Workspace** -> **Allow personal API
   keys**

Vault entry:

```yaml
# cma/vaults/example.yaml
- type: static_bearer
  mcp_server_url: https://public-api.granola.ai/v1/
  token: ${GRANOLA_API_KEY}        # grn_... Personal API key from the desktop app
```

(The vault's `mcp_server_url` is purely a credential index here — the
agent calls Granola REST directly, not an MCP server.)

REST usage from the agent:

```bash
# List the last 3 meeting notes (page_size 1-30, default 10)
curl -s \
  -H "Authorization: Bearer ${GRANOLA_API_KEY}" \
  "https://public-api.granola.ai/v1/notes?page_size=3" \
  | jq '.notes[] | {id, title, created_at}'

# Get a specific note + its transcript (paid plans only for transcripts)
curl -s \
  -H "Authorization: Bearer ${GRANOLA_API_KEY}" \
  "https://public-api.granola.ai/v1/notes/${NOTE_ID}?include=transcript"

# List folders (paid plans for private folders; team folders never
# accessible via the public API)
curl -s \
  -H "Authorization: Bearer ${GRANOLA_API_KEY}" \
  "https://public-api.granola.ai/v1/folders"
```

Useful query params for `GET /v1/notes`:

| Param | Meaning |
|-------|---------|
| `created_after` / `created_before` | ISO 8601 filter on note creation time |
| `updated_after` | ISO 8601 filter on last update |
| `page_size` | 1-30, default 10 |
| `cursor` | pagination cursor from a prior response |

Note ID format: `not_[A-Za-z0-9]{14}`. Only notes with a completed AI
summary appear; notes still being processed return 404 on direct fetch.

### Path B: Granola hosted MCP (deferred — browser OAuth only)

Granola launched an official MCP server (`https://mcp.granola.ai/mcp`,
Streamable HTTP) in early 2026. The server authenticates exclusively
with OAuth 2.1 + Dynamic Client Registration, which requires an
interactive browser session. There is no Bearer / API key / service
account path documented.

This makes the hosted MCP **unusable for headless CMA Routines**
without a one-time human-in-the-loop authorization step that produces
storable access + refresh tokens — and even then, Granola has not
published the token endpoints required to do programmatic refresh.

If a future routine genuinely needs the MCP-only tools listed below
(e.g., paid-plan `get_meeting_transcript`), the wiring would be to
complete the OAuth dance manually once, capture both tokens, store them
in the vault as an `mcp_oauth` entry, and rely on Granola's
server-side refresh. Until that's needed, stay on Path A.

## Tools exposed (Path B only)

| Tool | Plan tier |
|------|-----------|
| `list_meetings` | All |
| `get_meetings` | All |
| `query_granola_meetings` | All |
| `get_account_info` | All |
| `list_meeting_folders` | Paid only |
| `get_meeting_transcript` | Paid only |

Free plan limits: own notes only, last 30 days, no transcripts. Team
folders are not surfaced via MCP regardless of plan.

## Network allowlist

Minimum set for headless REST-only use:

- `public-api.granola.ai` — REST API (primary)
- `api.granola.ai` — Granola internal API routes (some endpoints
  cross-call into this host)
- `auth.granola.ai` — token validation
- `api.workos.com` — WorkOS identity backend used by Granola for auth

The Path B MCP endpoint `mcp.granola.ai` is documented but not
allowlisted by default in `cma/environment.yaml`. Uncomment it when the
hosted MCP becomes wireable for headless sessions.

## Rate limits

- Burst: 25 requests in 5 seconds
- Sustained: 5 req/s (300/min)
- Exceeded: `429 Too Many Requests`

The morning-briefing Routine makes at most a single `notes` list call
+ a handful of `notes/{id}` fetches per run — far below the limits.

## Known limitations

- The hosted MCP server has no headless auth path; Path A is the only
  realistic option for cloud Routines today
- Only AI-summarized notes are returned from `/v1/notes` — notes still
  being summarized return 404 if fetched directly
- Transcripts (`?include=transcript`) require a paid Granola plan
- Team folders are never exposed via the public API, only personal and
  shared folders
- The Personal API key has no native rotation UI flow — rotate by
  revoking + creating a new key when needed
- Enterprise workspaces gate personal API keys behind a per-workspace
  admin toggle

## References

- [Introducing Granola MCP — Granola Blog](https://www.granola.ai/blog/granola-mcp)
- [Granola MCP — Official Docs](https://docs.granola.ai/help-center/sharing/integrations/mcp)
- [Granola API Introduction — Official Docs](https://docs.granola.ai/introduction)
- [Personal API Docs](https://docs.granola.ai/help-center/sharing/integrations/personal-api.md)
- [List Notes Endpoint — API Reference](https://docs.granola.ai/api-reference/list-notes.md)
- [Get Note Endpoint — API Reference](https://docs.granola.ai/api-reference/get-note.md)
- [Network Troubleshooting & Allowlist — Granola Docs](https://docs.granola.ai/help-center/troubleshooting/network-troubleshooting)
- [OpenAPI Spec](https://docs.granola.ai/api-reference/openapi.json)
