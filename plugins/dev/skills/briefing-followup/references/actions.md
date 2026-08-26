# Actions — mapping user intent to a handler

For each open decision, present its fields and the action set filtered by decision type (`blocked_pr`, `adr_drift`, a `pending:` compound proposal, or the general case) — approve / reject / defer / calendar / ticket / dispatch / email / update / skip / quit, as fits the type. When run interactively, use the model to interpret the user's natural-language response and map it to a handler:

| User intent | Handler | Captures resolution? |
|---|---|---|
| approve / accept / yes / ship it | `log_response "$ID" approve "$NOTE"` | TSV log only |
| reject / no / dismiss | `log_response "$ID" reject "$NOTE"` | TSV log only |
| defer / later / skip for today | `log_response "$ID" defer "$NOTE"` | TSV log only |
| schedule meeting / book time / put on calendar | `action-schedule.sh` → `record_resolution "$ID" schedule_calendar "$JSON"` | TSV + JSON |
| file a ticket / open Linear issue | `action-ticket.sh` → `record_resolution "$ID" file_ticket "$JSON"` | TSV + JSON |
| dispatch the work / start relay-ticket / run the ticket | launch `/relay-ticket <TICKET>` (below) → `record_resolution "$ID" dispatch_relay_ticket "$JSON"` | TSV + JSON |
| draft email / send a note to X / message Y | `action-email.sh` → `record_resolution "$ID" draft_email "$JSON"` | TSV + JSON |
| edit / update the ADR (adr_drift only) | `action-adr.sh --mode update --adr-file "$ADR"` → `record_resolution "$ID" adr_update "$JSON"` | TSV + JSON |
| file code-drift ticket (adr_drift only) | `action-adr.sh --mode ticket --adr-file "$ADR" --team CTL --summary "$SUMMARY" --drift-status "$DRIFT_STATUS"` → `record_resolution "$ID" adr_ticket "$JSON"` | TSV + JSON |
| defer / note as intentional (adr_drift only) | `action-adr.sh --mode defer --adr-file "$ADR" --reason "$REASON"` → `record_resolution "$ID" adr_defer "$JSON"` | TSV + JSON |
| skip | move on without logging |
| quit / stop / done | break out of the loop |

The compound-engineering (`pending:`) intents are in the section below.

## Invoking a script handler

Each sibling script emits one JSON line on stdout and exits 0 on success or soft-skip (`{"status": "skipped", "reason": "..."}`); non-zero exit is a hard failure. Capture the JSON, show the relevant field, then call `record_resolution`:

```bash
RESULT=$(bash "$SCRIPT_DIR/action-schedule.sh" \
  --title "$EVENT_TITLE" --start "$START_ISO8601" --end "$END_ISO8601" \
  --description "$EVENT_DESCRIPTION")

STATUS=$(echo "$RESULT" | jq -r '.status')
case "$STATUS" in
  scheduled) echo "Scheduled — $(echo "$RESULT" | jq -r '.html_link')" ;;
  skipped)   echo "Skipped: $(echo "$RESULT" | jq -r '.reason')" ;;
  *)         echo "Failed: $(echo "$RESULT" | jq -r '.reason // "unknown"')" ;;
esac
record_resolution "$ID" schedule_calendar "$RESULT"
log_response "$ID" schedule_calendar "$STATUS"
```

The same pattern applies to `action-ticket.sh`, `action-email.sh`, and `action-adr.sh` — only the script name and the action label change.

## Dispatching work — launch `/relay-ticket`, not a script

There is no dedicated script handler for this one, unlike the actions above. Dispatching a ticket's work is launching a `/relay-ticket <TICKET>` session yourself (`Task`, or your environment's background session primitive) — the same dispatch verb `steward` uses (`steward/references/dispatch.md`). The legacy single-session runner and any retired background-dispatch path are gone (CTL-2218); do not fall back to either.

```bash
# TICKET comes from the decision's `.ticket` field (present on blocked_pr / judgment_call types).
if [[ -z "$TICKET" ]]; then
  RESULT='{"status":"skipped","reason":"decision has no ticket field"}'
else
  # Launch the session (Task tool, or `claude --bg "/relay-ticket $TICKET"` outside an
  # interactive session) — do not do the phase work yourself.
  RESULT=$(jq -nc --arg t "$TICKET" '{ticket: $t, status: "dispatched"}')
fi
echo "$RESULT" | jq -r 'if .status == "dispatched" then "Dispatched \(.ticket) via relay-ticket" else "Skipped: \(.reason)" end'
record_resolution "$ID" dispatch_relay_ticket "$RESULT"
log_response "$ID" dispatch_relay_ticket "$(echo "$RESULT" | jq -r .status)"
```

Confirming the dispatch actually landed a phase is **phase-completion evidence** (`steward/references/dispatch.md`) — this skill only launches the session; it does not itself watch it to completion.

## Compound-engineering ADR proposals (`pending:`)

A decision carrying a `pending:` path is a queued ADR proposal from the `ticket-compound` curator (`thoughts/shared/compound/pending/*.md`), surfaced by `morning-briefing` as `type: judgment_call` (the frontmatter schema's `type` enum has no `compound_adr` value):

| User intent | Handler | Captures resolution? |
|---|---|---|
| apply / approve the proposal | `action-compound.sh --mode apply --pending "$PENDING" --ticket "$TICKET"` → `record_resolution "$ID" compound_apply "$JSON"` | TSV + JSON |
| edit / tweak then apply | `action-compound.sh --mode edit --pending "$PENDING" --ticket "$TICKET"` → `record_resolution "$ID" compound_edit "$JSON"` | TSV + JSON |
| defer / not yet | `action-compound.sh --mode defer --pending "$PENDING" --ticket "$TICKET" --reason "$REASON"` → `record_resolution "$ID" compound_defer "$JSON"` | TSV + JSON |
| reject / decline | `action-compound.sh --mode reject --pending "$PENDING" --ticket "$TICKET" --reason "$REASON"` → `record_resolution "$ID" compound_reject "$JSON"` | TSV + JSON |

```bash
RESULT=$(bash "$SCRIPT_DIR/action-compound.sh" --mode apply --pending "$PENDING" --ticket "$TICKET")
STATUS=$(echo "$RESULT" | jq -r '.status')
case "$STATUS" in
  applied)  echo "Applied — $(echo "$RESULT" | jq -r '.target') $(echo "$RESULT" | jq -r '.adr_id') @ $(echo "$RESULT" | jq -r '.commit_sha')" ;;
  deferred) echo "Deferred — proposal left pending" ;;
  rejected) echo "Rejected — $(echo "$RESULT" | jq -r '.reason')" ;;
  skipped)  echo "Skipped: $(echo "$RESULT" | jq -r '.reason')" ;;
  *)        echo "Failed: $(echo "$RESULT" | jq -r '.reason // "unknown"')" ;;
esac
record_resolution "$ID" compound_apply "$RESULT"
```

`action-compound.sh --mode apply` (and `edit`, which tweaks then applies) is the **only** writer of `docs/adrs.md` — `ticket-compound` only ever *proposes*; a human approves here.

## Handler reference

| Action | Script | Output JSON (success) | Soft-skip trigger |
|---|---|---|---|
| Schedule a calendar event | `action-schedule.sh` | `{event_id, html_link, status: "scheduled"}` | `GOOGLE_OAUTH_ACCESS_TOKEN` unset |
| File a Linear ticket | `action-ticket.sh` | `{identifier, url, status: "filed"}` | `linearis` not on PATH |
| Dispatch relay-ticket | none — launch `/relay-ticket <TICKET>` directly, above | `{ticket, status: "dispatched"}` | decision has no `.ticket` field |
| Draft an email | `action-email.sh` | `{draft_id, status: "drafted"}` | `GMAIL_OAUTH_ACCESS_TOKEN` unset |
| Update / ticket / defer ADR (adr_drift) | `action-adr.sh --mode update\|ticket\|defer` | `{adr_file, adr_id, commit_sha, status}` | `$EDITOR` unset, ADR not in git, or `linearis` missing |
| Apply / edit / defer / reject proposal (`pending:`) | `action-compound.sh --mode apply\|edit\|defer\|reject` | `{adrs_file, adr_id, target, commit_sha, status}` | proposal missing, not in git, or `$EDITOR` unset (edit) |

A soft-skip's JSON is captured and recorded exactly like a success result, so the resolution log faithfully records what happened. Each handler accepts `--help` for its full flag set.
