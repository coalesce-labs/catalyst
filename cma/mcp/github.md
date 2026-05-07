# GitHub MCP wiring

## URL

`https://api.githubcopilot.com/mcp/` — GitHub-managed remote MCP server.
Streamable HTTP transport. Zero-install.

URL path modifiers (alternative to header-based control):
- `/readonly` — global read-only mode
- `/x/<toolset>` — restrict to a specific toolset (e.g. `/x/issues`)
- `/insiders` — enable experimental tools

Header-based control:
- `X-MCP-Toolsets: repos,issues,pull_requests`
- `X-MCP-Readonly: true`
- `X-MCP-Insiders: true`

## Auth model

| Mode | Use case | CMA fit |
|------|----------|---------|
| OAuth via GitHub App | Interactive hosts | No — requires browser |
| Personal Access Token (fine-grained) | Headless agents | Yes — recommended |
| Personal Access Token (classic) | Legacy | Acceptable; fine-grained preferred |

### How to provision the PAT

1. GitHub -> **Settings** -> **Developer settings** -> **Personal access tokens** -> **Fine-grained tokens** -> **Generate new token**
2. Name it (e.g., `cma-routines-base`)
3. Set expiration (90 days recommended; rotate before expiry)
4. **Repository access:** select the specific repos this token covers
5. **Repository permissions:** see scope below
6. Copy the `github_pat_...` value once shown

### Required scope (CTL-286 decision: PAT also handles thoughts clone)

This single PAT is used both for the GitHub MCP server **and** for the
session-startup `git clone` of the thoughts repo (per the
`cma/decisions/2026-05-07-thoughts-strategy.md` ADR).

**Repository access:**
- `coalesce-labs/catalyst` (read+write for code review and CI fixup routines)
- `coalesce-labs/thoughts` (read-only for the startup git clone)

**Repository permissions on `coalesce-labs/catalyst`:**

| Permission | Level | Why |
|------------|-------|-----|
| Contents | Read+Write | Push fix commits in CI auto-fix routine |
| Pull requests | Read+Write | Open/comment/review/merge PRs |
| Issues | Read+Write | Open issues from drift detection routine |
| Metadata | Read | Required by all PATs |
| Actions | Read | Read CI logs for failure diagnosis |
| Checks | Read | Read CI check status |

**Repository permissions on `coalesce-labs/thoughts`:**

| Permission | Level | Why |
|------------|-------|-----|
| Contents | Read | git clone --depth=1 of the thoughts repo |
| Metadata | Read | Required by all PATs |

Trade-off explicitly accepted by CTL-286: the same PAT covers both repos.
A leak compromises both. Mitigation: rotate or split into two PATs later;
CTL-295 may revisit when thoughts write-back is designed.

## Vault entry

```yaml
# cma/vaults/example.yaml
- type: static_bearer
  mcp_server_url: https://api.githubcopilot.com/mcp/
  token: ${GITHUB_PAT}            # github_pat_... fine-grained token
```

The same `${GITHUB_PAT}` env var is also injected into the session container
for the thoughts-repo `git clone` (referenced from the base agent's startup
ritual in `cma/agents/base-system-prompt.md`).

## Tools exposed

30+ tools across 15+ toolsets. Default toolsets enabled:

| Toolset | Sample tools |
|---------|--------------|
| `context` | `get_me`, `get_teams` (read-only) |
| `repos` | `search_repositories`, `get_file_contents`, `list_commits`, `list_branches`, `create_or_update_file`, `create_repository`, `fork_repository`, `create_branch`, `push_files`, `delete_file`, `star_repository` |
| `issues` | `list_issues`, `search_issues`, `create_issue`, `add_issue_comment` |
| `pull_requests` | `list_pull_requests`, `create_pull_request`, `merge_pull_request`, `update_pull_request_branch`, `add_pull_request_review` |
| `users` | `search_users` (read-only) |
| `copilot` | `assign_copilot_to_issue`, `request_copilot_review` |

Optional toolsets (require explicit enable via `X-MCP-Toolsets` or URL path):
- `actions` — workflow runs/jobs/logs (needed by CI auto-fix routine)
- `code_security`, `dependabot` — security alerts
- `discussions`, `gists`, `labels`, `notifications`, `orgs`, `projects`,
  `security_advisories`

For the **CI failure auto-fix routine** (CTL-289), enable the `actions`
toolset by setting `X-MCP-Toolsets: actions,context,repos,issues,pull_requests`
on the agent's MCP wiring (or use URL path `/x/actions` if header control
isn't preferred).

## Network allowlist

Already in `cma/environment.yaml`:
- `api.githubcopilot.com` — MCP endpoint
- `api.github.com` — REST fallback
- `github.com` — git clone, gh CLI auth
- `objects.githubusercontent.com` — release assets / large objects
- `raw.githubusercontent.com` — raw file fetches

## Fallback (gh CLI)

The environment installs `gh` (GitHub CLI) via the apt package list. Pre-CMA-
session setup:

```bash
# Use the same PAT as the MCP server
echo "${GITHUB_PAT}" | gh auth login --with-token
```

Once `gh auth` is set, all Catalyst skills that shell out via `Bash(gh *)`
work the same as locally.

## Known limitations

- Read-only mode (`X-MCP-Readonly: true` or `/readonly`) is global —
  cannot mix read-only and write tools in one connection.
- Classic PATs do startup scope filtering (tools requiring missing scopes
  are hidden); fine-grained PATs do dynamic scope challenges per call.
- Some toolsets are remote-only (`copilot_spaces`, `github_support_docs_search`)
  and not available if you switch to the self-hosted Docker image.

## References

- [GitHub MCP Server repo](https://github.com/github/github-mcp-server)
- [Remote server docs](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md)
- [Toolset reference](https://github.com/github/github-mcp-server/blob/main/docs/toolsets.md)
