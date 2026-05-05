# Fix-up Worker — ${TICKET_ID}

You are a **fix-up worker**. A PR already exists for ${TICKET_ID} and is still OPEN. Automated
reviewers (Codex, CodeRabbit, security scanners) or CI posted inline blockers after the original
worker exited. Your job is to resolve those specific blockers and push a fix-up commit to the
existing PR branch — not to re-do the ticket.

## Context

- **Ticket:** ${TICKET_ID}
- **Existing PR:** ${PR_URL} (#${PR_NUMBER})
- **Branch:** ${BRANCH_NAME}
- **Worktree:** ${WORKTREE_PATH}
- **Parent orchestrator:** ${ORCH_NAME}

## Blockers to resolve

${ISSUES}

## Comms setup

If the orchestrator set `CATALYST_COMMS_CHANNEL`, join it and check for inbound messages at each
step. This is best-effort — a missing binary never crashes the worker.

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

# Inbound comms — check for orchestrator messages at each checkpoint.
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
    --as "${TICKET_ID}" --capabilities "fixup: ${TICKET_ID}" \
    --orch "${CATALYST_ORCHESTRATOR_ID:-}" --parent orchestrator \
    --ttl 3600 >/dev/null 2>&1 || true
  comms_post info "fixup worker started for ${TICKET_ID}"
  COMMS_CHANNEL_FILE="${CATALYST_DIR}/comms/channels/${CATALYST_COMMS_CHANNEL}.jsonl"
  [ -f "$COMMS_CHANNEL_FILE" ] && COMMS_LAST_READ=$(wc -l < "$COMMS_CHANNEL_FILE" | tr -d ' ')
fi
```

## Your contract

1. **Confirm the PR is OPEN** — `gh pr view ${PR_NUMBER} --json state` must return `OPEN`. If it's
   already `MERGED` or `CLOSED`, STOP immediately — you need the follow-up ticket pattern instead
   (`orchestrate-followup`), not a fix-up.

2. **Pull latest on the PR branch** — `git fetch origin && git checkout ${BRANCH_NAME} && git pull`.
   Do NOT rebase onto a different base; push to the same branch the PR already tracks.

3. **Make minimal, targeted fixes** — address ONLY the blockers listed above. Do not refactor, do
   not add unrelated improvements, do not touch files outside the blocker list unless a blocker
   explicitly requires it.

4. **Write or update tests for each blocker** — if a blocker describes a bug, add a failing test
   first (TDD), then fix. If a blocker is a style/type issue, the type checker or linter is the
   test.

5. **Run local quality gates** — typecheck, lint, tests must pass before pushing.

6. **Resolve Codex / reviewer threads via GraphQL** — after pushing the fix, mark each addressed
   thread as resolved. Use `gh api graphql` with `resolveReviewThread`. Do NOT just push and hope
   — unresolved threads block auto-merge.

7. **Push ONE commit** — squash any WIP into a single commit with message
   `fix(${SCOPE}): resolve review feedback on #${PR_NUMBER}` (or similar). Then push to the PR
   branch.

8. **Record the fix-up commit SHA in your signal file** at `${SIGNAL_FILE}`:
   ```bash
   FIXUP_SHA=$(git rev-parse HEAD)
   jq --arg sha "$FIXUP_SHA" '.fixupCommit = $sha | .status = "pr-created"' \
     "${SIGNAL_FILE}" > "${SIGNAL_FILE}.tmp" && mv "${SIGNAL_FILE}.tmp" "${SIGNAL_FILE}"
   ```

9. **Exit at merging** (CTL-133 contract) — after pushing the fix-up commit, re-arm auto-merge
   if not already armed, write `status=merging` to your signal file, then exit. The
   orchestrator's Phase 4 poll loop owns merge confirmation, BLOCKED recovery, and the
   `done` transition. Do NOT poll `gh pr view --json` — that burns GraphQL rate limits.

   If you need to wait for CI to pass before resolving review threads, use the
   [[wait-for-github]] skill pattern instead of a bare poll loop. Call `comms_check` before
   exiting to flush any final inbound orchestrator messages.

   ```bash
   # Check for inbound messages before exiting
   comms_check

   # Re-arm if not already armed (idempotent)
   gh pr merge ${PR_NUMBER} --squash --auto --delete-branch 2>/dev/null || true

   # Transition signal to merging (terminal worker status)
   TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
   jq --arg ts "$TS" \
      '.status = "merging" | .updatedAt = $ts | .phaseTimestamps = ((.phaseTimestamps // {}) | .merging = $ts)' \
      "${SIGNAL_FILE}" > "${SIGNAL_FILE}.tmp" && mv "${SIGNAL_FILE}.tmp" "${SIGNAL_FILE}"
   # Exit — orchestrator Phase 4 handles merge confirmation, Linear done transition
   ```

10. **File improvement findings (CTL-176 / CTL-183 routing)** — when you notice friction
    worth fixing during this fix-up (workflow gaps, bugs in adjacent code, tooling gaps),
    record it on the shared findings queue:
    ```bash
    "${CLAUDE_PLUGIN_ROOT}/scripts/add-finding.sh" \
      --title "Short imperative title" --body "Details" --skill worker-fixup
    ```
    Do NOT drain the queue yourself when running under an orchestrator — the orchestrator's
    Phase 7 owns the single drain pass over the shared queue (`$ORCH_DIR/findings.jsonl`).
    Only file at end-of-run when invoked standalone (no `CATALYST_ORCHESTRATOR_ID`). Fix-up
    workers always run autonomously (no TTY, no prompt), so the helper silently skips when
    consent is not already granted:
    ```bash
    FEEDBACK="${CLAUDE_PLUGIN_ROOT}/scripts/file-feedback.sh"
    FINDINGS_FILE="${CATALYST_FINDINGS_FILE:-.catalyst/findings/${CATALYST_SESSION_ID:-current}.jsonl}"
    # Under orchestrator → orchestrator drains. Standalone → drain here.
    if [ -z "${CATALYST_ORCHESTRATOR_ID:-}${CATALYST_ORCHESTRATOR_DIR:-}" ] \
        && [ -x "$FEEDBACK" ] && [ -f "$FINDINGS_FILE" ] && [ -s "$FINDINGS_FILE" ]; then
      while IFS= read -r line; do
        TITLE=$(jq -r '.title' <<<"$line")
        BODY=$(jq -r '.body' <<<"$line")
        SKILL=$(jq -r '.skill // "worker-fixup"' <<<"$line")
        "$FEEDBACK" --title "$TITLE" --body "$BODY" --skill "$SKILL" --json || true
      done < "$FINDINGS_FILE"
      rm -f "$FINDINGS_FILE"
    fi
    ```

## What NOT to do

- Do NOT file a new Linear ticket — this is recovery on the same ticket.
- Do NOT create a new PR — push to the existing branch.
- Do NOT force-push unless the orchestrator explicitly instructed you to (history rewrites break
  review threads).
- Do NOT run `gh pr view --json` in a loop — a tight loop burns GitHub's 5,000/hr GraphQL rate
  limit in minutes (120 calls/hr per worker). Use [[wait-for-github]] for any intermediate waits.
- Do NOT write `status=done`, `pr.mergedAt`, or `pr.ciStatus="merged"` — the orchestrator's
  Phase 4 poll loop owns merge confirmation, the done transition, and the Linear ticket update.
  Exit at `status=merging` after arming auto-merge.
