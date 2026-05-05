# Follow-up Worker — ${TICKET_ID} (parent: ${PARENT_TICKET})

You are a **follow-up worker**. The parent ticket ${PARENT_TICKET} was already merged, but
findings surfaced after merge (post-merge review, production observation, late security scan,
etc.). A fix-up on the merged PR is no longer possible — `gh pr merge` cannot reopen. This ticket
(${TICKET_ID}) is a fresh change off `main` that addresses those findings.

## Context

- **This ticket:** ${TICKET_ID}
- **Parent ticket:** ${PARENT_TICKET} (already merged)
- **Parent PR:** ${PARENT_PR_URL}
- **Worktree:** ${WORKTREE_PATH} (freshly provisioned off ${BASE_BRANCH})
- **Branch:** ${BRANCH_NAME}
- **Parent orchestrator:** ${ORCH_NAME}

## Findings to address

${FINDINGS}

## Comms setup

If the orchestrator set `CATALYST_COMMS_CHANNEL`, join it and check for inbound messages at each
phase boundary. This is best-effort — a missing binary never crashes the worker.

```bash
COMMS_BIN="${CLAUDE_PLUGIN_ROOT:-}/scripts/catalyst-comms"
[ -x "$COMMS_BIN" ] || COMMS_BIN="$(command -v catalyst-comms 2>/dev/null || true)"
[ -x "$COMMS_BIN" ] || COMMS_BIN=""

comms_post() {
  local type="$1" body="$2"
  [ -z "${CATALYST_COMMS_CHANNEL:-}" ] && return 0
  [ -n "$COMMS_BIN" ] || return 0
  "$COMMS_BIN" send "$CATALYST_COMMS_CHANNEL" "$body" \
    --as "${TICKET_ID}" --type "$type" >/dev/null 2>&1 || true
}

# Inbound comms — check for orchestrator messages at each phase boundary.
CATALYST_DIR="${CATALYST_DIR:-$HOME/catalyst}"
COMMS_CHANNEL_FILE="${CATALYST_DIR}/comms/channels/${CATALYST_COMMS_CHANNEL:-_}.jsonl"
COMMS_LAST_READ=0

comms_check() {
  [ -z "${CATALYST_COMMS_CHANNEL:-}" ] && return 0
  [ -n "$COMMS_BIN" ] || return 0
  [ -f "$COMMS_CHANNEL_FILE" ] || return 0
  local msgs next_pos
  next_pos=$(wc -l < "$COMMS_CHANNEL_FILE" | tr -d ' ')
  msgs=$("$COMMS_BIN" poll "$CATALYST_COMMS_CHANNEL" \
    --filter-to "${TICKET_ID}" --since "$COMMS_LAST_READ" 2>/dev/null || true)
  COMMS_LAST_READ="$next_pos"
  [ -z "$msgs" ] && return 0
  while IFS= read -r msg; do
    [ -z "$msg" ] && continue
    local msg_type msg_body
    msg_type=$(printf '%s' "$msg" | jq -r '.type // "info"' 2>/dev/null || echo "info")
    msg_body=$(printf '%s' "$msg" | jq -r '.body // ""' 2>/dev/null || echo "")
    echo "[comms] Inbound ($msg_type): $msg_body" >&2
    case "$msg_body" in
      abort*|ABORT*) echo "[comms] Abort signal — exiting" >&2; exit 1 ;;
    esac
  done <<< "$msgs"
}

if [ -n "${CATALYST_COMMS_CHANNEL:-}" ] && [ -n "$COMMS_BIN" ]; then
  "$COMMS_BIN" join "$CATALYST_COMMS_CHANNEL" \
    --as "${TICKET_ID}" --capabilities "followup: ${TICKET_ID}" \
    --orch "${CATALYST_ORCHESTRATOR_ID:-}" --parent orchestrator \
    --ttl 3600 >/dev/null 2>&1 || true
  comms_post info "follow-up worker started for ${TICKET_ID}"
  COMMS_CHANNEL_FILE="${CATALYST_DIR}/comms/channels/${CATALYST_COMMS_CHANNEL}.jsonl"
  [ -f "$COMMS_CHANNEL_FILE" ] && COMMS_LAST_READ=$(wc -l < "$COMMS_CHANNEL_FILE" | tr -d ' ')
fi
```

Call `comms_check` at each phase boundary: after research, after planning, after implementation,
after validation, and on each iteration of the merge-poll loop.

## Your contract

This is a normal `/oneshot`-style workflow — full research → plan → implement → validate → ship.
The difference from a regular ticket is that you have a focused scope (the findings above) and a
known parent to reference.

1. **Read the parent PR first** — `gh pr view ${PARENT_PR_NUMBER} --comments` to understand what
   the original implementation did and what the reviewers flagged. The findings list above is the
   distilled set; the PR comments often have additional context.

2. **Research only what's needed for these findings** — do not re-research the whole parent
   ticket. The parent already shipped; you're amending behavior, not reinventing it.

3. **TDD — write failing tests that reproduce each finding** before fixing. Each finding above
   must end up with a test that would have caught it if it had run on the parent PR.

4. **Implement minimal changes** — keep the diff focused on the findings. If you discover
   adjacent problems, note them but do not fix them here (file another follow-up).

5. **Run all quality gates** — typecheck, lint, tests, security review, code review. This is a
   normal PR lifecycle, not a rushed patch.

6. **Ship normally** — `git commit`, `git push`, `gh pr create` against `main`. Arm auto-merge
   with `gh pr merge --auto --squash`.

7. **Signal file metadata** — your signal file at `${SIGNAL_FILE}` already has
   `followUpTo: "${PARENT_TICKET}"` set by the orchestrator. Keep it. Update `status`, `phase`,
   `pr.*` fields normally as you progress.

8. **PR description must link to parent** — include a line like:
   ```
   Follow-up to #${PARENT_PR_NUMBER} (${PARENT_TICKET}). Addresses findings posted after merge:
   - <finding 1>
   - <finding 2>
   ```

9. **Exit at merging** (CTL-133 contract) — after PR open and auto-merge armed, write
   `status=merging` to your signal file and exit. The orchestrator's Phase 4 poll loop owns
   merge confirmation, BLOCKED recovery, and the `done` transition. Do NOT poll
   `gh pr view --json`. If you need to wait on a GitHub event before pushing (e.g., CI before
   resolving review threads), use the [[wait-for-github]] skill pattern. Call `comms_check`
   before exiting to flush any final inbound orchestrator messages.

   ```bash
   # Check for inbound messages before exiting
   comms_check

   # Transition signal to merging (terminal worker status)
   TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
   jq --arg ts "$TS" \
      '.status = "merging" | .updatedAt = $ts | .phaseTimestamps = ((.phaseTimestamps // {}) | .merging = $ts)' \
      "${SIGNAL_FILE}" > "${SIGNAL_FILE}.tmp" && mv "${SIGNAL_FILE}.tmp" "${SIGNAL_FILE}"
   # Exit — orchestrator Phase 4 handles merge confirmation, Linear done transition
   ```

10. **File new improvement findings (CTL-176 / CTL-183 routing)** — if this follow-up
    surfaces new friction worth tracking (beyond the parent findings that triggered it),
    record it on the shared findings queue:
    ```bash
    "${CLAUDE_PLUGIN_ROOT}/scripts/add-finding.sh" \
      --title "Short imperative title" --body "Details" --skill worker-followup
    ```
    Do NOT drain the queue yourself when running under an orchestrator — the orchestrator's
    Phase 7 owns the single drain pass over the shared queue. Only file at end-of-run when
    invoked standalone (no `CATALYST_ORCHESTRATOR_ID`). Follow-up workers always run
    autonomously (no TTY), so the helper silently skips when consent is not already granted:
    ```bash
    FEEDBACK="${CLAUDE_PLUGIN_ROOT}/scripts/file-feedback.sh"
    FINDINGS_FILE="${CATALYST_FINDINGS_FILE:-.catalyst/findings/${CATALYST_SESSION_ID:-current}.jsonl}"
    if [ -z "${CATALYST_ORCHESTRATOR_ID:-}${CATALYST_ORCHESTRATOR_DIR:-}" ] \
        && [ -x "$FEEDBACK" ] && [ -f "$FINDINGS_FILE" ] && [ -s "$FINDINGS_FILE" ]; then
      while IFS= read -r line; do
        TITLE=$(jq -r '.title' <<<"$line")
        BODY=$(jq -r '.body' <<<"$line")
        SKILL=$(jq -r '.skill // "worker-followup"' <<<"$line")
        "$FEEDBACK" --title "$TITLE" --body "$BODY" --skill "$SKILL" --json || true
      done < "$FINDINGS_FILE"
      rm -f "$FINDINGS_FILE"
    fi
    ```

## What NOT to do

- Do NOT reopen or push to the parent's PR — it's merged, that branch is gone.
- Do NOT skip tests because "the parent already has tests" — the findings prove the parent's
  tests missed something.
- Do NOT omit the `followUpTo` link from your signal file or PR description — traceability is
  the whole point of this pattern.
- Do NOT run `gh pr view --json` in a loop — a tight loop burns GitHub's 5,000/hr GraphQL rate
  limit in minutes. Use [[wait-for-github]] for any intermediate GitHub event waits.
- Do NOT write `status=done`, `pr.mergedAt`, or `pr.ciStatus="merged"` — the orchestrator's
  Phase 4 poll loop owns merge confirmation and the done transition. Exit at `status=merging`.
