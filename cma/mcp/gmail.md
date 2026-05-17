# Gmail MCP wiring

## URLs

| Endpoint | Path | Auth | Headless |
|----------|------|------|----------|
| REST API | `https://gmail.googleapis.com/gmail/v1` | Bearer (OAuth access token from refresh) | **Yes** — recommended |
| Hosted MCP | `https://gmailmcp.googleapis.com/mcp/v1` | Bearer (same OAuth access token) | Pending verification |
| claude.ai connector | `claude.ai/customize/connectors` | OAuth user grant | Read-only; insufficient for drafts |

For the briefing-followup skill (Initiative 3 / CTL-463), **use Path A**
(OAuth refresh token + Gmail v1 REST). The hosted Gmail MCP is documented
by Google but not yet end-to-end verified by this project. The claude.ai
first-party Gmail connector exists but is read-only — fine for context
gathering, insufficient for drafting messages.

## Path A (recommended): OAuth refresh token + Gmail v1 REST

Gmail uses the **same OAuth client** as Google Drive / Google Calendar —
one client, one refresh token, multiple scopes. Reuse the OAuth setup
documented in [google-drive.md](google-drive.md) (steps 1-5); when running
the local consent flow, add the Gmail-specific scope alongside the Drive
and Calendar scopes:

```python
SCOPES = [
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/gmail.compose",
]
```

The `client_id`, `client_secret`, and `refresh_token` stored in the CMA
vault for Drive/Calendar (`GOOGLE_OAUTH_*`) also cover Gmail — but the
**access token exchanged from that refresh token is a separate Bearer
token** for Gmail because the OAuth scopes are distinct.

You must also **enable the Gmail API** in the same GCP project at
<https://console.cloud.google.com/apis/library/gmail.googleapis.com>.

### Environment variable contract

The briefing-followup `action-email.sh` script reads
`GMAIL_OAUTH_ACCESS_TOKEN`. It is **distinct from**
`GOOGLE_OAUTH_ACCESS_TOKEN` to avoid silently sending email with a token
that was minted only for Drive/Calendar scopes. Set both env vars in your
CMA vault by exchanging the same refresh token twice — once with the
Drive+Calendar scope subset, once with `gmail.compose` — and exporting
each result under its own name.

### Draft-message REST usage

```bash
# Create a draft message
RAW=$(printf 'To: alice@example.com\r\nSubject: Hi\r\n\r\nHello.' \
  | python3 -c 'import sys, base64; sys.stdout.write(
      base64.urlsafe_b64encode(sys.stdin.buffer.read()).decode("ascii").rstrip("="))')

curl -fsSL -X POST \
  -H "Authorization: Bearer ${GMAIL_OAUTH_ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$(jq -nc --arg raw "$RAW" '{message: {raw: $raw}}')" \
  https://gmail.googleapis.com/gmail/v1/users/me/drafts
```

The response contains the draft `id`. To send the draft, POST to
`/users/me/drafts/{id}/send`. The briefing-followup skill creates drafts
only — sending is a manual review step.

## Path B: Google Gmail hosted MCP (pending verification)

Google ships a hosted Gmail MCP server (per Google's developer docs) in
Developer Preview. Expected tool inventory:

| Tool | Operation |
|------|-----------|
| `list_messages` | Search / enumerate messages |
| `get_message` | Fetch a single message |
| `send_message` | Send a new message |
| `create_draft` | Create a draft (parallel to REST `drafts.create`) |
| `update_draft` | Modify an existing draft |
| `delete_draft` | Delete a draft |

**Pending verification.** If reachable, a follow-up PR uncomments
`gmailmcp.googleapis.com` in `cma/environment.yaml` and adds the endpoint
to `cma/agents/base.yaml`.

## Maintained community options (if Google's hosted MCP doesn't pan out)

Worth knowing about:

| Repo | Auth | Service account? |
|------|------|------------------|
| [taylorwilsdon/google_workspace_mcp](https://github.com/taylorwilsdon/google_workspace_mcp) | OAuth 2.0/2.1 OR service account + DWD | Yes (Workspace domains only) |

`google_workspace_mcp` supports gmail-only deploys with
`uvx workspace-mcp --tools gmail`.

## Network allowlist

Add to `cma/environment.yaml` (alongside the existing Drive/Calendar
hosts):

- `gmail.googleapis.com` — Gmail v1 REST

The OAuth host (`oauth2.googleapis.com`) is already allowlisted for
Drive/Calendar; Gmail reuses it.

## OAuth scope minimums

For drafting (the only operation the briefing-followup skill performs):

| Scope | Purpose |
|-------|---------|
| `https://www.googleapis.com/auth/gmail.compose` | Create, read, update, delete drafts; send mail |

Avoid the broader `https://mail.google.com/` (full mailbox access) unless
a future routine genuinely needs it.

## Soft-skip semantics

If `GMAIL_OAUTH_ACCESS_TOKEN` is unset when the briefing-followup skill
encounters a `draft_email` action, `action-email.sh` emits
`{"status":"skipped","reason":"GMAIL_OAUTH_ACCESS_TOKEN not set ..."}`
and exits 0. The skill surfaces the skip to the user and continues with
the next decision — no failure, no nag. This file is the canonical pointer
the skip message references when the user wants to wire up Gmail.

## References

- [Gmail API v1 — drafts.create reference](https://developers.google.com/gmail/api/reference/rest/v1/users.drafts/create)
- [Gmail API v1 — drafts.send reference](https://developers.google.com/gmail/api/reference/rest/v1/users.drafts/send)
- [Choose Gmail API scopes](https://developers.google.com/gmail/api/auth/scopes)
- [taylorwilsdon/google_workspace_mcp — community Workspace MCP server](https://github.com/taylorwilsdon/google_workspace_mcp)
