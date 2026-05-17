# Google Drive MCP wiring

## URLs

| Endpoint | Path | Auth | Headless |
|----------|------|------|----------|
| REST API | `https://www.googleapis.com/drive/v3` | Bearer (OAuth access token from refresh) | **Yes** — recommended |
| Hosted MCP | `https://drivemcp.googleapis.com/mcp/v1` | Bearer (same OAuth access token) | Pending verification |

For Phase 1 Routines, **use Path A** (OAuth refresh token + Drive v3
REST). The hosted Google MCP endpoint is documented by Google but has
not been end-to-end verified by this project; once it is, the same
Bearer token used in Path A can be presented to the MCP server.

Anthropic's first-party Google Drive connector at
`claude.ai/customize/connectors` is **not currently usable from headless
sessions** — see "Why not the claude.ai connector" below.

## Two paths for Phase 1

### Path A (recommended): OAuth refresh token + Drive v3 REST

A single OAuth client covers both Google Drive and Google Calendar
(see [google-calendar.md](google-calendar.md) for the calendar
scopes). Do this once locally, capture the refresh token, store it in
the CMA vault.

1. **Create the OAuth client** at
   <https://console.cloud.google.com/apis/credentials>:
   - Project: any GCP project you own (create one if needed)
   - Credentials -> **+ Create credentials** -> **OAuth client ID**
   - Application type: **Desktop app** (simpler consent screen than
     Web)
   - Name it (e.g., `Catalyst Routines`)
   - Note the `client_id` and `client_secret`
2. **Enable the Drive API** at
   <https://console.cloud.google.com/apis/library/drive.googleapis.com>
3. **Publish the OAuth consent screen** (Status: "In production")
   so refresh tokens do not expire after 7 days. For a single-user
   solo-dev setup, External + In production with yourself as the only
   user is fine — the verification banner can be dismissed.
4. **Run a local consent flow once** to obtain the `refresh_token`.
   Any short Python or Node snippet using
   `google-auth-oauthlib`/`googleapis` works; the minimum is:

   ```python
   from google_auth_oauthlib.flow import InstalledAppFlow
   SCOPES = [
       "https://www.googleapis.com/auth/drive.readonly",
       "https://www.googleapis.com/auth/calendar.events.readonly",
       "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
   ]
   flow = InstalledAppFlow.from_client_secrets_file("client_secret.json", SCOPES)
   creds = flow.run_local_server(port=0)
   print(creds.refresh_token)
   ```

5. Store `client_id`, `client_secret`, `refresh_token` in the CMA
   vault.

Vault entry:

```yaml
# cma/vaults/example.yaml — same entry shared by Drive + Calendar
- type: static_bearer
  mcp_server_url: https://www.googleapis.com/
  token: ${GOOGLE_OAUTH_ACCESS_TOKEN}   # exchanged from refresh at runtime; see below
  # Stored alongside as separate vault fields (CMA does not yet have
  # an `oauth_refresh` type — the agent does the exchange itself):
  # ${GOOGLE_OAUTH_CLIENT_ID}
  # ${GOOGLE_OAUTH_CLIENT_SECRET}
  # ${GOOGLE_OAUTH_REFRESH_TOKEN}
```

Per-run token exchange (the agent runs this once per session before
making Drive or Calendar calls):

```bash
ACCESS_TOKEN=$(curl -s -X POST https://oauth2.googleapis.com/token \
  --data-urlencode "client_id=${GOOGLE_OAUTH_CLIENT_ID}" \
  --data-urlencode "client_secret=${GOOGLE_OAUTH_CLIENT_SECRET}" \
  --data-urlencode "refresh_token=${GOOGLE_OAUTH_REFRESH_TOKEN}" \
  --data-urlencode "grant_type=refresh_token" \
  | jq -r .access_token)
```

REST usage from the agent:

```bash
# Find a folder by name
FOLDER_ID=$(curl -s -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  --get \
  --data-urlencode "q=name='Meeting notes' and mimeType='application/vnd.google-apps.folder'" \
  "https://www.googleapis.com/drive/v3/files" \
  | jq -r '.files[0].id')

# List files in that folder modified in the last 7 days
SINCE=$(date -u -v-7d +%Y-%m-%dT00:00:00Z 2>/dev/null \
  || date -u -d "7 days ago" +%Y-%m-%dT00:00:00Z)
curl -s -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  --get \
  --data-urlencode "q='${FOLDER_ID}' in parents and modifiedTime > '${SINCE}'" \
  --data-urlencode "orderBy=modifiedTime desc" \
  --data-urlencode "pageSize=10" \
  "https://www.googleapis.com/drive/v3/files" \
  | jq '.files[] | {id, name, modifiedTime}'
```

### Path B: Google Drive hosted MCP (pending verification)

Google ships (per Google's developer docs) a hosted MCP server at
`https://drivemcp.googleapis.com/mcp/v1`. The same OAuth access token
exchanged above is presented as a Bearer header. The expected tool
inventory includes `list_recent_files`, `search_files`,
`get_file_metadata`, plus file-content readers.

**Pending verification.** Before this project relies on the hosted
MCP, do a one-shot manual check:

```bash
curl -s -X POST https://drivemcp.googleapis.com/mcp/v1 \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

If this returns a populated `tools` array, the endpoint is reachable
and a follow-up PR can:

1. Uncomment `drivemcp.googleapis.com` in `cma/environment.yaml`
2. Add a `mcp_servers:` entry pointing at the endpoint in
   `cma/agents/base.yaml`

Until then, Path A is the shipped path.

## Why not the claude.ai connector

Anthropic's first-party Google Drive connector at
`claude.ai/customize/connectors` is account-scoped OAuth that links
your Google account to Claude's web/desktop sessions. The connector
docs claim it surfaces tools across "Claude, Claude Desktop, Claude
Code, and the API". For Google Drive specifically, two open Anthropic
bugs contradict that promise:

- [anthropics/claude-code#39422](https://github.com/anthropics/claude-code/issues/39422)
  — Google Drive connector tools **do not pass through** to Claude
  Code sessions even when OAuth is fully authorized. Gmail and
  Calendar do pass through. Drive is the outlier.
- [anthropics/claude-code#53442](https://github.com/anthropics/claude-code/issues/53442)
  — Shared Drive content returns empty results.

Both are unresolved as of 2026-05. The morning-briefing Routine reads
personal-Drive files only, so the Shared Drive bug isn't a blocker,
but the connector-passthrough bug is — Routines run via the API and
would not see the tools. Path A REST sidesteps both bugs and works
under both architectures.

Re-evaluate the claude.ai connector once the passthrough bug is
closed. The runtime cost of switching from Path A REST to the
claude.ai connector then is trivial (it's a configuration change, not
an agent rewrite).

## Tools exposed (Path B, pending verification)

When the hosted MCP works, expected tools include:

| Category | Tools |
|----------|-------|
| Discovery | `list_recent_files`, `search_files`, `get_file_metadata` |
| Content | `read_file`, `export_file` (for Google Docs / Sheets / Slides) |
| Folders | `list_folder`, `get_folder_metadata` |

The exact inventory depends on the Google MCP server version — confirm
via the `tools/list` check above.

## Network allowlist

Already in `cma/environment.yaml` (added by CTL-456):

- `oauth2.googleapis.com` — refresh-token → access-token exchange
- `accounts.google.com` — initial OAuth consent screen (setup only)
- `www.googleapis.com` — Drive v3 + Calendar v3 REST (shared with
  [google-calendar.md](google-calendar.md))

The hosted MCP endpoint `drivemcp.googleapis.com` is documented in the
allowlist but commented out until end-to-end verification confirms it.

## OAuth scope minimums

For the morning-briefing Routine's "list files in 'Meeting notes'
folder" use case:

| Scope | Purpose |
|-------|---------|
| `https://www.googleapis.com/auth/drive.readonly` | Read-only browsing of all files the user owns or has been shared on — the minimum that lets the routine find a folder by name and list its contents |

Avoid:

- `https://www.googleapis.com/auth/drive.file` — only covers files the
  app itself created; not useful for reading pre-existing Gemini notes
- `https://www.googleapis.com/auth/drive` — full read/write; broader
  than the morning-briefing Routine needs

If a future Routine needs to write files (e.g., upload a briefing PDF
back to Drive), add `drive.file` to the OAuth client's scope list and
re-run the consent flow once.

## Service account vs OAuth user flow

| Option | Headless | Personal Gmail | Workspace domain |
|--------|----------|----------------|------------------|
| OAuth refresh token (recommended) | Yes (after one-time browser consent) | Yes | Yes |
| Service account, file-shared | Yes | Yes — but each folder must be shared with the service account's `*.gserviceaccount.com` email | Yes |
| Service account + Domain-Wide Delegation | Yes | **No** — DWD requires a Workspace domain | Yes |

For a solo dev with personal `@gmail.com`, the OAuth refresh-token
path is the practical headless solution. Service account + DWD only
works if you're using Google Workspace.

## Known limitations

- The hosted Google MCP (`drivemcp.googleapis.com`) is documented but
  not first-hand verified by this project. Path A REST is what ships.
- The claude.ai first-party connector has an open bug (#39422)
  preventing tool passthrough to Claude Code / API sessions for Drive
  specifically.
- Shared Drive content has its own open bug (#53442) in the claude.ai
  connector path; the routine reads personal Drive only, so this is a
  non-issue today.
- Service accounts cannot read personal `@gmail.com` Drive without
  per-folder sharing — DWD only works on Google Workspace domains.
- OAuth consent screens in test mode expire refresh tokens after 7
  days. Publish the OAuth consent screen ("In production") to get
  long-lived refresh tokens.

## References

- [Configure the Drive MCP server — Google Developers](https://developers.google.com/workspace/drive/api/guides/configure-mcp-server)
- [MCP Reference: drivemcp.googleapis.com — Google Developers](https://developers.google.com/workspace/drive/api/reference/mcp)
- [Drive API v3 — files.list reference](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list)
- [Use Google Workspace connectors — Claude Help Center](https://support.claude.com/en/articles/10166901-use-google-workspace-connectors)
- [Use connectors to extend Claude's capabilities — Claude Help Center](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities)
- [Bug: Google Drive MCP not passed through to Claude Code — anthropics/claude-code #39422](https://github.com/anthropics/claude-code/issues/39422)
- [Bug: Cowork Google Drive MCP cannot see Shared Drive content — anthropics/claude-code #53442](https://github.com/anthropics/claude-code/issues/53442)
- [isaacphi/mcp-gdrive — community OSS MCP server](https://github.com/isaacphi/mcp-gdrive)
