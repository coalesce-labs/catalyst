---
name: briefing-followup
description:
  Interactive walk-through of today's morning briefing. Loads the briefing markdown at
  thoughts/briefings/YYYY-MM-DD.md (built by [[morning-briefing]]), parses the structured
  decisions: frontmatter, and walks the user through each open decision one at a time with
  placeholder Approve / Reject / Defer actions. Phase 1 MVP — Phase 2 wires real action
  handlers (calendar / ticket / orchestrator / email); Phase 4 writes resolutions back to
  the briefing markdown.
disable-model-invocation: true
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Task, mcp__*
---

# Briefing Follow-up — load + present agenda (MVP)

## When to use

Invoke as `/catalyst-dev:briefing-followup` after `/catalyst-dev:morning-briefing` has
produced today's briefing. The skill reads that briefing's `decisions:` block and walks
the user through each open decision in turn. Phase 1 surfaces placeholder actions; the
real action handlers ship in Phase 2 ([[2026-05-16-catalyst-phase-agent-architecture]]
§Initiative 3 Phase 2).

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

## Step 3: Decision-update placeholder log

Resolve the log path before the loop. Inside an orchestrator dispatch
(`$CATALYST_ORCHESTRATOR_DIR` is set), prefer the orchestrator's run directory so the
record lands next to other worker artifacts; otherwise fall back to `/tmp` for local
runs. Phase 4 of the parent plan replaces this placeholder with a real `resolutions:`
write-back to the briefing markdown.

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
```

## Step 4: Loop over decisions

For each open decision, present the details + the placeholder action set. In Phase 1
the action handlers are inert — they record the user's choice and continue. Phase 2
wires real handlers ([[2026-05-16-catalyst-phase-agent-architecture]] §Initiative 3
Phase 2).

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
  echo "Actions: [a]pprove · [r]eject · [d]efer · [s]kip · [q]uit"
done
```

When this skill runs in an interactive Claude Code session, present each decision as
above and use the model to interpret the user's natural-language response. Map common
intents to the placeholder actions:

| User says... | Action |
|---|---|
| approve / accept / yes / ship it | `approve` → `log_response "$ID" approve` |
| reject / no / dismiss | `reject` → `log_response "$ID" reject` |
| defer / later / skip for today | `defer`  → `log_response "$ID" defer` |
| skip | move on without logging |
| quit / stop / done | break out of the loop |

After each decision the user resolves, call `log_response` with the action and any free-form
note the user provided. Continue to the next decision until the queue is empty or the user
quits.

## Step 5: End session

```bash
echo
echo "Logged $(wc -l < "$LOG_FILE" | tr -d ' ') response(s) to $LOG_FILE"
"$SESSION_SCRIPT" end "$CATALYST_SESSION_ID" --status done \
  --reason "briefing-followup completed for $DATE"
```

## Output contract

- **Input**: `thoughts/briefings/YYYY-MM-DD.md` produced by [[morning-briefing]],
  validated against `plugins/dev/templates/briefing-frontmatter.schema.json`.
- **Output (Phase 1)**: a scratch log at `$CATALYST_ORCHESTRATOR_DIR/briefing-followup-<date>.log`
  (or `/tmp/briefing-followup-<date>.log` outside orchestrator mode), one TSV line per
  resolved decision: `<utc-timestamp>\t<id>\t<action>\t<note>`. Phase 4 of the parent
  plan rewrites this as a `resolutions:` block on the briefing markdown frontmatter.

## Phase 1 scope (this ticket)

Per [[2026-05-16-catalyst-phase-agent-architecture]] §Initiative 3 Phase 1 (CTL-462):
load briefing, parse decisions, walk the user through each one with placeholder
actions. **Action handlers ship in Phase 2 (CTL-463)** — schedule calendar entry, file
Linear ticket, dispatch orchestrator, draft email. ADR-drift resolution is its own
Phase 3 (CTL-464). Resolution write-back to the briefing is Phase 4 (CTL-465).
