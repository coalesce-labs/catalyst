# Session — prelude, present the agenda, end

## Prelude: start session, resolve date, load briefing

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

If the briefing doesn't exist, `parse-briefing.sh` prints the resolved path and a suggestion to
run `/catalyst-dev:morning-briefing` before failing. Surface that message verbatim to the user.

## Present the agenda

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

## Resolve the scratch log dir

One flat scratch dir under `$TMPDIR` — there is no run-scoped directory to nest under (the
retired background scheduler that used to provide one is gone, CTL-2218):

```bash
LOG_DIR="${TMPDIR:-/tmp}/catalyst-briefing-followup"
LOG_FILE="$LOG_DIR/$DATE.log"
mkdir -p "$LOG_DIR"
: > "$LOG_FILE"  # truncate any prior run from today

log_response() {
  local id="$1" action="$2" note="${3:-}"
  printf '%s\t%s\t%s\t%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$id" "$action" "$note" \
    >> "$LOG_FILE"
}

# Structured resolution recorder — appends to a JSON array the write-back step reads.
record_resolution() {
  local id="$1" action="$2" result_json="${3:-{\}}"
  bash "$SCRIPT_DIR/record-resolution.sh" \
    --log-dir "$LOG_DIR" --date "$DATE" \
    --id "$id" --action "$action" --result "$result_json"
}
```

## End the session

```bash
echo
echo "Logged $(wc -l < "$LOG_FILE" | tr -d ' ') response(s) to $LOG_FILE"
"$SESSION_SCRIPT" end "$CATALYST_SESSION_ID" --status done \
  --reason "briefing-followup completed for $DATE"
```
