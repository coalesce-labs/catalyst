# Notion MCP wiring

## URLs

| Endpoint | Path | Auth | Headless |
|----------|------|------|----------|
| Hosted | `https://mcp.notion.com/mcp` | OAuth user-only | **No** — explicitly forbids bearer tokens |
| Self-host | Your URL — `makenotion/notion-mcp-server` Docker image | `NOTION_TOKEN` env var | Yes |

The hosted endpoint at `mcp.notion.com` cannot be used by a headless CMA
session. Notion's docs explicitly state it does not support bearer-token auth.

## Two paths for Phase 1

### Path A (recommended for now): Notion REST with an integration token

This is simpler, takes ~3 minutes, and works headlessly.

1. Notion -> **Settings** -> **Connections** -> **Develop or manage integrations**
2. **+ New integration** -> Internal, choose your workspace
3. Give it a name (e.g., `Catalyst Routines`)
4. Capabilities: Read, Update, Insert (set per least-privilege need)
5. Copy the **Internal Integration Secret** (starts with `secret_` or `ntn_`)
6. **Critical:** Share each page or database the integration needs to access
   in Notion's UI. Open the page -> click `...` -> **Connections** -> add the
   integration. The integration cannot access anything not explicitly shared.

Vault entry:

```yaml
# cma/vaults/example.yaml
- type: static_bearer
  mcp_server_url: https://api.notion.com/v1/
  token: ${NOTION_TOKEN}          # secret_... or ntn_...
```

REST usage from the agent:

```bash
# Read a page
curl -H "Authorization: Bearer ${NOTION_TOKEN}" \
     -H "Notion-Version: 2025-09-03" \
     https://api.notion.com/v1/pages/${PAGE_ID}

# Append blocks (e.g., post a daily-update entry)
curl -X PATCH \
  -H "Authorization: Bearer ${NOTION_TOKEN}" \
  -H "Notion-Version: 2025-09-03" \
  -H "Content-Type: application/json" \
  --data '{"children":[{"object":"block","type":"paragraph","paragraph":{"rich_text":[{"type":"text","text":{"content":"..."}}]}}]}' \
  https://api.notion.com/v1/blocks/${PAGE_ID}/children
```

Pin a specific `Notion-Version` header per Notion's API versioning policy.

### Path B: Self-hosted Notion MCP

Required when a routine needs the AI-optimized tooling that the OSS server
provides (markdown-flavored page CRUD, structured search) without re-implementing it
on top of REST.

Setup:

1. Deploy the OSS server `makenotion/notion-mcp-server` to a public endpoint:
   - Docker: `ghcr.io/makenotion/notion-mcp-server:latest`
   - Host options: Fly.io, Cloud Run, AWS ECS Fargate, any Docker host
2. Configure environment variables on the deployment:
   - `NOTION_TOKEN=secret_...` (the integration token from Path A)
   - `AUTH_TOKEN=<your-own-bearer-secret>` (the bearer the CMA agent presents
     to the MCP server itself; rotate this independent of the Notion token)
3. Expose on HTTPS at `https://your-notion-mcp.example.com/mcp`
4. Update `cma/agents/base.yaml`:
   ```yaml
   mcp_servers:
     - name: notion
       type: streamable_http
       url: https://your-notion-mcp.example.com/mcp
   ```
5. Add to vault:
   ```yaml
   - type: static_bearer
     mcp_server_url: https://your-notion-mcp.example.com/mcp
     token: ${NOTION_MCP_AUTH_TOKEN}   # the AUTH_TOKEN from step 2
   ```
6. Add `your-notion-mcp.example.com` to `cma/environment.yaml`'s
   `allowed_hosts` (or rely on `allow_mcp_servers: true`)

The hosted-endpoint URL placeholder in `cma/agents/base.yaml`
(`https://placeholder.notion-mcp.invalid/mcp`) is a deliberate canary — if
a session attempts to call it, the network allowlist will reject the call,
making the unwired state visible rather than silently failing later.

## Tools exposed (Path B only)

13 tools derived from Notion's OpenAPI:

| Category | Tools |
|----------|-------|
| Users | `get_user`, `get_users` |
| Pages | `retrieve_a_page`, `retrieve_a_page_property`, `create_a_page`, `patch_page` |
| Databases | `get_databases`, `post_database_query`, `retrieve_a_database`, `create_a_database`, `update_a_database` |
| Blocks | `get_block_children`, `retrieve_a_block`, `patch_block_children`, `update_a_block`, `delete_a_block` |
| Comments | `retrieve_a_comment`, `create_a_comment` |
| Search | `post_search` |

The hosted `mcp.notion.com` endpoint adds AI-optimized tools (`create_pages`,
`update_page`, markdown-aware `search`) that the OSS self-host does not have.
Database deletion is intentionally excluded everywhere.

## Network allowlist

Already in `cma/environment.yaml`:
- `api.notion.com` — REST API (Path A)
- `mcp.notion.com` — hosted MCP (allowlist entry; not currently usable headlessly)

For Path B, add the self-host URL host to `allowed_hosts` when you deploy.

## Known limitations

- Path A: integration token only sees pages/databases explicitly shared with
  it in Notion's UI. Discoverability is limited — `post_search` only returns
  shared resources.
- Path B: requires you to host and maintain a separate MCP server.
- The hosted `mcp.notion.com` endpoint may eventually support bearer tokens;
  if Notion ships that, this doc should be updated and Path A becomes optional.

## References

- [Notion MCP getting started](https://developers.notion.com/guides/mcp/get-started-with-mcp)
- [Hosting a local MCP server](https://developers.notion.com/docs/hosting-open-source-mcp)
- [makenotion/notion-mcp-server (GitHub)](https://github.com/makenotion/notion-mcp-server)
- [Notion's hosted MCP server: an inside look](https://www.notion.com/blog/notions-hosted-mcp-server-an-inside-look)
