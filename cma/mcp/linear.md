# Linear MCP wiring

## URL

`https://mcp.linear.app/mcp` — Streamable HTTP transport. (Legacy SSE endpoint
`https://mcp.linear.app/sse` is being phased out; do not use for new wiring.)

Hosted by Linear in partnership with Cloudflare and Anthropic. Centrally
maintained — no self-hosting needed.

## Auth model

Linear MCP supports two modes; for headless CMA sessions use **API key**.

| Mode | Use case | CMA fit |
|------|----------|---------|
| OAuth 2.1 + dynamic client registration | Interactive hosts (Claude Desktop) | No — requires browser |
| Bearer (API key) | Headless agents | Yes — recommended |

### How to provision the API key

1. Linear UI -> **Settings** -> **Account** -> **Security & Access**
2. Create a personal API key (or a workspace-scoped restricted key for
   per-routine least privilege)
3. Copy the `lin_api_...` value

Recommended practice: create a separate restricted API key with read+write
on the Catalyst team only. Do not reuse a personal account-wide key.

## Vault entry

```yaml
# cma/vaults/example.yaml
- type: static_bearer
  mcp_server_url: https://mcp.linear.app/mcp
  token: ${LINEAR_API_KEY}        # lin_api_... from Linear settings
```

## Tools exposed

21+ tools, all read+write. Categories:

| Category | Tools |
|----------|-------|
| Issues | `list_issues`, `get_issue`, `create_issue`, `update_issue`, `list_my_issues` |
| Projects | `list_projects`, `get_project`, `create_project`, `update_project` |
| Teams | `list_teams`, `get_team` |
| Users | `list_users`, `get_user` |
| Comments | `list_comments`, `create_comment` |
| Status / labels | `list_issue_statuses`, `get_issue_status`, `manage_project_labels` |
| Initiatives (added Feb 2026) | `create_initiative`, `edit_initiative`, `create_initiative_update` |
| Milestones (added Feb 2026) | `create_project_milestone`, `edit_project_milestone`, `create_project_update` |

Read-only restrictions are enforced via key scoping in the Linear UI, not by
the MCP server.

## Network allowlist

Already in `cma/environment.yaml`:
- `mcp.linear.app` — MCP endpoint
- `api.linear.app` — REST fallback / underlying API

## Fallback (REST)

If the MCP path is unreachable for any reason, agents can call the Linear REST
API directly:

```bash
curl -H "Authorization: ${LINEAR_API_KEY}" \
     -H "Content-Type: application/json" \
     -d '{"query":"query { issue(id: \"CTL-286\") { title state { name } } }"}' \
     https://api.linear.app/graphql
```

This is the same path the Catalyst-local `linearis` CLI takes today.

## Known limitations

- No published rate limits; follows Linear's standard API limits (sufficient
  for routine workloads; not for high-frequency polling)
- Cannot scope tools at the MCP layer — all 21+ tools are surfaced to any
  agent attached to the connector. Use Linear UI restricted keys to limit
  blast radius.
- API key has no native rotation flow; rotate manually when needed.

## References

- [Linear MCP server docs](https://linear.app/docs/mcp)
- [Linear MCP launch changelog (May 2025)](https://linear.app/changelog/2025-05-01-mcp)
- [Initiative & milestone tools (Feb 2026)](https://linear.app/changelog/2026-02-05-linear-mcp-for-product-management)
