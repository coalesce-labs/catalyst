---
name: briefing-followup
description:
  Interactive walk-through of today's morning briefing. Loads the briefing markdown at
  thoughts/briefings/YYYY-MM-DD.md (built by [[morning-briefing]]), parses the structured
  decisions: frontmatter, walks the user through each open decision, and executes the
  selected action via supported handlers — schedule calendar entry, file Linear ticket,
  dispatch orchestrator, draft email, plus ADR-drift-specific actions (update ADR / file
  code-drift ticket / defer with a drift note). Phase 4 (CTL-465) writes resolutions
  back to the briefing markdown.
disable-model-invocation: true
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Task, mcp__*
---

# Briefing Follow-up — load + present agenda (MVP)

## When to use

Invoke as `/catalyst-dev:briefing-followup` after `/catalyst-dev:morning-briefing` has
produced today's briefing. The skill reads that briefing's `decisions:` block and walks
the user through each open decision in turn. Phase 2 wires the real action handlers
listed below; ADR-drift-specific actions ship in Phase 3 (CTL-464) and resolution
write-back to the briefing markdown ships in Phase 4 (CTL-465). See
[[2026-05-16-catalyst-phase-agent-architecture]] §Initiative 3 Phase 2.

## Flags

| Flag | Meaning |
|---|---|
| `--date YYYY-MM-DD` | Target briefing date. Default: today (UTC). |
| `--file PATH` | Override path resolution entirely (test/dev usage). |
| `--status STATUS` | Decision-status filter: `open` (default) or `all`. |

## Step 1: Prelude — start session, resolve date, load briefing

```bash
SCRIPT_DIR="${CLAUDE_PLUGIN_ROOT:-plugins/dev}/scripts/briefing-followup"
SESSION_SCRIPT="${CLAUDE_PLUGIN_ROOT:-plugins/dev}/scripts/catalyst-session.sh"

CATALYST_SESSION_ID=$("$SESSION_SCRIPT" start --skill "briefing-followup" \
  --ticket "" --workflow "${CATALYST_SESSION_ID:-}")
export CATALYST_SESSION_ID

# Resolve briefing path. Pass --date / --file straight through from the user.
BRIEFING_PATH=$(bash "$SCRIPT_DIR/parse-briefing.sh" path "$@")
DATE=$(basename "$BRIEFING_PATH" .md)
echo "Briefing date: $DATE"
echo "Briefing path: $BRIEFING_PATH"

# Load + validate frontmatter (exits 1 with a helpful suggestion if missing,
# exits 2 if frontmatter is malformed or absent).
if ! FRONTMATTER_JSON=$(bash "$SCRIPT_DIR/parse-briefing.sh" load "$@"); then
  "$SESSION_SCRIPT" end "$CATALYST_SESSION_ID" --status failed \
    --reason "briefing not found or malformed"
  exit 1
fi
```

If the briefing doesn't exist, `parse-briefing.sh` prints the resolved path and a
suggestion to run `/catalyst-dev:morning-briefing` before failing. Surface that message
verbatim to the user.

## Step 2: Present the agenda

Render the open decisions as a numbered list with summary + type:

```bash
echo
echo "─── Agenda for $DATE ───"
bash "$SCRIPT_DIR/parse-briefing.sh" agenda "$@"
echo "───────────────────────"
echo

DECISION_COUNT=$(bash "$SCRIPT_DIR/parse-briefing.sh" decisions "$@" | jq 'length')
if [[ "$DECISION_COUNT" -eq 0 ]]; then
  echo "No open decisions in this briefing. Nothing to follow up on."
  "$SESSION_SCRIPT" end "$CATALYST_SESSION_ID" --status done \
    --reason "no open decisions"
  exit 0
fi
echo "$DECISION_COUNT open decision(s) to walk through."
```

## Step 3: Resolve log dir + resolution recorder

Resolve the log path before the loop. Inside an orchestrator dispatch
(`$CATALYST_ORCHESTRATOR_DIR` is set), prefer the orchestrator's run directory so the
record lands next to other worker artifacts; otherwise fall back to `/tmp` for local
runs. Phase 4 (CTL-465) of the parent plan replaces the placeholder log with a real
`resolutions:` write-back to the briefing markdown; for now the recorder writes both
a TSV log (Phase 1 contract) and a structured JSON file (Phase 2 contract that Phase 4
will consume).

```bash
if [[ -n "${CATALYST_ORCHESTRATOR_DIR:-}" ]]; then
  LOG_DIR="$CATALYST_ORCHESTRATOR_DIR"
else
  LOG_DIR="/tmp"
fi
LOG_FILE="$LOG_DIR/briefing-followup-$DATE.log"
mkdir -p "$LOG_DIR"
: > "$LOG_FILE"  # truncate any prior run from today

log_response() {
  local id="$1" action="$2" note="${3:-}"
  printf '%s\t%s\t%s\t%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$id" "$action" "$note" \
    >> "$LOG_FILE"
}

# Structured resolution recorder — appends to a JSON array consumed by Phase 4.
# Call after a successful action with the action name and the action's JSON output.
record_resolution() {
  local id="$1" action="$2" result_json="${3:-{\}}"
  bash "$SCRIPT_DIR/record-resolution.sh" \
    --log-dir "$LOG_DIR" --date "$DATE" \
    --id "$id" --action "$action" --result "$result_json"
}
```

## Step 4: Loop over decisions

For each open decision, present the details and the action set filtered by decision
type. The action handlers live in sibling scripts and each emit a one-line JSON result
on stdout; the skill captures that JSON and feeds it to `record_resolution`.

```bash
DECISIONS_JSON=$(bash "$SCRIPT_DIR/parse-briefing.sh" decisions "$@")

# Iterate over the JSON array. `jq -c .[]` emits one decision per line.
INDEX=0
TOTAL="$DECISION_COUNT"
echo "$DECISIONS_JSON" | jq -c '.[]' | while IFS= read -r dec; do
  INDEX=$((INDEX + 1))
  ID=$(echo "$dec"      | jq -r '.id')
  TYPE=$(echo "$dec"    | jq -r '.type')
  SUMMARY=$(echo "$dec" | jq -r '.summary')
  PR_URL=$(echo "$dec"  | jq -r '.pr_url // empty')
  TICKET=$(echo "$dec"  | jq -r '.ticket // empty')
  ADR=$(echo "$dec"     | jq -r '.adr // empty')

  echo
  echo "═══ Decision $INDEX of $TOTAL ═══"
  echo "id:      $ID"
  echo "type:    $TYPE"
  echo "summary: $SUMMARY"
  [[ -n "$PR_URL" ]] && echo "pr:      $PR_URL"
  [[ -n "$TICKET" ]] && echo "ticket:  $TICKET"
  [[ -n "$ADR"    ]] && echo "adr:     $ADR"
  echo

  case "$TYPE" in
    blocked_pr)
      echo "Actions: [a]pprove · [r]eject · [d]efer · [o]rchestrate · [s]kip · [q]uit"
      ;;
    adr_drift)
      echo "Actions: [u]pdate ADR · [t]icket (code drift) · [D]efer · [s]kip · [q]uit"
      ;;
    *)
      echo "Actions: [a]pprove · [r]eject · [d]efer · [c]alendar · [t]icket · [o]rchestrate · [e]mail · [s]kip · [q]uit"
      ;;
  esac
done
```

When this skill runs in an interactive Claude Code session, present each decision as
above and use the model to interpret the user's natural-language response. Map intents
to action handlers as follows:

| User intent | Handler | Captures resolution? |
|---|---|---|
| approve / accept / yes / ship it | `log_response "$ID" approve "$NOTE"` | TSV log only |
| reject / no / dismiss | `log_response "$ID" reject "$NOTE"` | TSV log only |
| defer / later / skip for today | `log_response "$ID" defer "$NOTE"` | TSV log only |
| schedule meeting / book time / put on calendar | `action-schedule.sh` → `record_resolution "$ID" schedule_calendar "$JSON"` | TSV + JSON |
| file a ticket / open Linear issue | `action-ticket.sh` → `record_resolution "$ID" file_ticket "$JSON"` | TSV + JSON |
| dispatch orchestrator / kick off the work / run oneshot | `action-orchestrate.sh --bg` → `record_resolution "$ID" dispatch_orchestrator "$JSON"` | TSV + JSON |
| draft email / send a note to X / message Y | `action-email.sh` → `record_resolution "$ID" draft_email "$JSON"` | TSV + JSON |
| edit / update the ADR (adr_drift only) | `action-adr.sh --mode update --adr-file "$ADR"` → `record_resolution "$ID" adr_update "$JSON"` | TSV + JSON |
| file code-drift ticket / fix the code (adr_drift only) | `action-adr.sh --mode ticket --adr-file "$ADR" --team CTL --summary "$SUMMARY" --drift-status "$DRIFT_STATUS"` → `record_resolution "$ID" adr_ticket "$JSON"` | TSV + JSON |
| defer / note as intentional (adr_drift only) | `action-adr.sh --mode defer --adr-file "$ADR" --reason "$REASON"` → `record_resolution "$ID" adr_defer "$JSON"` | TSV + JSON |
| skip | move on without logging |
| quit / stop / done | break out of the loop |

### Invoking an external action

When the user picks a real action handler, call the corresponding script and pass any
context the user supplied. Each handler emits one JSON line on stdout — capture it,
display the relevant field to the user, then call `record_resolution` so Phase 4 can
write it back to the briefing markdown.

```bash
# Example — schedule_calendar from a judgment_call decision:
RESULT=$(bash "$SCRIPT_DIR/action-schedule.sh" \
  --title "$EVENT_TITLE" \
  --start "$START_ISO8601" \
  --end "$END_ISO8601" \
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

The same pattern applies to `action-ticket.sh`, `action-orchestrate.sh`, and
`action-email.sh` — only the script name and the action label change. All four handlers
soft-skip cleanly when their underlying tool is missing or unauthenticated; the
returned `{"status": "skipped", "reason": "..."}` JSON is captured the same way as a
success result so the resolution log faithfully records what happened.

### Free-form note capture

Per-decision the user may attach a one-line note (e.g., why they rejected, what the
calendar event is for). Pass it as the third argument to `log_response` and, when
relevant, as `--description` / `--body` to the action handler.

## Step 5: Write resolutions back to the briefing markdown (Phase 4 — CTL-465)

Before ending the session, persist the recorded resolutions into the briefing
markdown's frontmatter `resolutions:` block and append a "## Decisions Made
Today" section to the body. The script commits to the routine-scoped branch
(when running inside the morning-briefing routine's writable clone) and emits
a `briefing.followup.complete.<date>` event so the next morning's briefing
routine can surface yesterday's decisions as carryovers.

```bash
WRITEBACK_RESULT=$(bash "$SCRIPT_DIR/writeback.sh" \
  --briefing "$BRIEFING_PATH" \
  --resolutions "$LOG_DIR/briefing-followup-$DATE-resolutions.json" \
  --date "$DATE" 2>&1)

WRITEBACK_STATUS=$(echo "$WRITEBACK_RESULT" | jq -r '.status // "failed"')
case "$WRITEBACK_STATUS" in
  updated)
    COMMIT_SHA=$(echo "$WRITEBACK_RESULT" | jq -r '.commit_sha // "none"')
    echo "Wrote resolutions back to $BRIEFING_PATH (commit: $COMMIT_SHA)"
    ;;
  skipped)
    REASON=$(echo "$WRITEBACK_RESULT" | jq -r '.reason // "no resolutions"')
    echo "Skipped write-back: $REASON"
    ;;
  *)
    echo "Write-back failed: $WRITEBACK_RESULT" >&2
    ;;
esac
```

Flags that callers may pass to `writeback.sh`:

| Flag | Meaning |
|---|---|
| `--no-commit` | Update the markdown in place but do not run `git commit`. |
| `--no-push` | Commit but do not push. Default in cloud routine mode is push. |
| `--no-event` | Skip emitting `briefing.followup.complete.<date>`. |
| `--events-dir DIR` | Override the event log dir (defaults to `$CATALYST_DIR/events`). |

The script is idempotent: re-running with the same resolutions file produces
the same markdown (the previous "## Decisions Made Today" block is stripped
before the new one is appended, and the `resolutions:` array is replaced
rather than amended).

## Step 6: End session

```bash
echo
echo "Logged $(wc -l < "$LOG_FILE" | tr -d ' ') response(s) to $LOG_FILE"
"$SESSION_SCRIPT" end "$CATALYST_SESSION_ID" --status done \
  --reason "briefing-followup completed for $DATE"
```

## Output contract

- **Input**: `thoughts/briefings/YYYY-MM-DD.md` produced by [[morning-briefing]],
  validated against `plugins/dev/templates/briefing-frontmatter.schema.json`.
- **Output (Phase 1, retained)**: a scratch log at
  `$CATALYST_ORCHESTRATOR_DIR/briefing-followup-<date>.log` (or `/tmp/...` outside
  orchestrator mode), one TSV line per resolved decision:
  `<utc-timestamp>\t<id>\t<action>\t<note>`.
- **Output (Phase 2, new)**: a structured JSON array at
  `$LOG_DIR/briefing-followup-<date>-resolutions.json`, one entry per resolution that
  invoked an action handler. Each entry is
  `{decision_id, action, timestamp, result}` where `result` is the JSON the handler
  returned. Phase 4 (CTL-465) reads this file to write the `resolutions:` block back
  to the briefing markdown frontmatter.

## Action handlers (Phase 2 — CTL-463; Phase 3 — CTL-464)

Per [[2026-05-16-catalyst-phase-agent-architecture]] §Initiative 3 Phase 2, the
following sibling scripts implement the supported actions. Each emits one JSON line on
stdout and exits 0 on success or soft-skip (`{"status": "skipped", "reason": "..."}`);
non-zero exit indicates a hard failure (handler reached but the underlying API
returned no usable result).

| Action | Script | Output JSON (success) | Soft-skip trigger |
|---|---|---|---|
| Schedule a calendar event | `action-schedule.sh` | `{event_id, html_link, status: "scheduled"}` | `GOOGLE_OAUTH_ACCESS_TOKEN` unset |
| File a Linear ticket | `action-ticket.sh` | `{identifier, url, status: "filed"}` | `linearis` not on PATH |
| Dispatch orchestrator | `action-orchestrate.sh` | `{orchestrator_id, status: "dispatched"}` | `claude` (or `$CATALYST_DISPATCH_CLAUDE_BIN`) not on PATH |
| Draft an email | `action-email.sh` | `{draft_id, status: "drafted"}` | `GMAIL_OAUTH_ACCESS_TOKEN` unset |
| Update ADR (adr_drift) | `action-adr.sh --mode update` | `{adr_file, adr_id, commit_sha, status: "updated"}` | `$EDITOR` unset, no save, or ADR not in a git repo |
| File code-drift ticket (adr_drift) | `action-adr.sh --mode ticket` | `{identifier, url, adr_id, status: "filed"}` | `linearis` not on PATH |
| Defer ADR drift (adr_drift) | `action-adr.sh --mode defer` | `{adr_file, adr_id, commit_sha, status: "deferred"}` | ADR not in a git repo |

See `cma/mcp/google-calendar.md` and `cma/mcp/gmail.md` for the OAuth setup required
to bypass the calendar / email soft-skip paths. Linear and orchestrator handlers
require no extra setup beyond having `linearis` / `claude` on PATH (the standard local
dev environment provides both).

Each handler accepts `--help` to print its flag set. The skill captures the JSON,
surfaces the relevant field to the user, then calls `record_resolution "$ID" <action>
"$JSON"` so the result lands in the resolutions JSON file for Phase 4 write-back.

## Phase scope summary

- **Phase 1 (CTL-462, done)**: load briefing, parse decisions, walk user through with
  placeholder Approve / Reject / Defer.
- **Phase 2 (CTL-463, done)**: action handlers — schedule calendar, file
  Linear ticket, dispatch orchestrator, draft email.
- **Phase 3 (CTL-464, this skill version)**: ADR-drift resolution — `action-adr.sh`
  with `--mode update|ticket|defer` for the three options per the parent plan.
- **Phase 4 (CTL-465, this skill version)**: resolutions write-back from the
  JSON file to the briefing markdown frontmatter `resolutions:` block via
  `writeback.sh`. Also appends a "## Decisions Made Today" section to the body,
  commits to the routine-scoped branch (`routines/briefings` in the cloud
  routine), and emits `briefing.followup.complete.<date>` so the next morning's
  briefing routine reads yesterday's resolutions as carryovers.
- **Phase 5 (CTL-466, planned)**: end-to-end real-briefing review session.
