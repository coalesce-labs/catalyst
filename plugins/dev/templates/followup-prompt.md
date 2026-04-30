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

9. **Worker contract ends at `state=MERGED`** (CTL-80) — same as a normal worker. After PR open
   and auto-merge armed, poll until merged. CRITICAL: always include `sleep 30` — a tight loop
   exhausts GitHub's 5,000/hr GraphQL rate limit in minutes.

   ```bash
   while true; do
     MERGE_STATE=$(gh pr view ${PR_NUMBER} --json state,mergeStateStatus,mergedAt)
     STATE=$(echo "$MERGE_STATE" | jq -r '.state')
     [ "$STATE" = "MERGED" ] && break
     # Resolve BEHIND/CI/review blockers
     sleep 30
   done
   ```

   Only exit when `state=MERGED` and you have written `pr.mergedAt` + `status: "done"` to
   your signal file.

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
- Do NOT exit at `pr-created` if the PR has not merged — under CTL-80 the worker owns the
  poll-until-MERGED loop.
