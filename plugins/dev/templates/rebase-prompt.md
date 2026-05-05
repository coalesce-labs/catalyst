# Rebase Worker — ${TICKET_ID}

You are a **rebase worker** (CTL-232). The PR for ${TICKET_ID} is OPEN with
`mergeStateStatus=DIRTY` — its branch has diverged from base with conflicting changes that
GitHub's auto-merge cannot resolve. Your job is to rebase the branch onto current base,
resolve the conflicts, and force-push so the PR can merge.

This is the explicit exception to the no-force-push rule: rebasing rewrites history by
definition. Use `--force-with-lease` to avoid clobbering anyone else's push.

## Context

- **Ticket:** ${TICKET_ID}
- **Existing PR:** ${PR_URL} (#${PR_NUMBER})
- **Branch:** ${BRANCH_NAME}
- **Base branch:** ${BASE_BRANCH}
- **Worktree:** ${WORKTREE_PATH}
- **Parent orchestrator:** ${ORCH_NAME}

## Your contract

1. **Confirm the PR is OPEN and DIRTY** — `gh pr view ${PR_NUMBER} --json state,mergeStateStatus`
   must show `state=OPEN` and `mergeStateStatus=DIRTY`. If MERGED or CLOSED, STOP. If state
   is OPEN but mergeStateStatus is no longer DIRTY (e.g. another worker already rebased),
   STOP — write `status="pr-created"` and exit; the orchestrator's poll loop handles the
   merge.

2. **Sync the worktree** — `cd ${WORKTREE_PATH} && git fetch origin ${BASE_BRANCH}`. Make sure
   the local branch matches the remote PR branch (`git fetch origin ${BRANCH_NAME} &&
   git checkout ${BRANCH_NAME} && git reset --hard origin/${BRANCH_NAME}`).

3. **Attempt the rebase** — `git rebase origin/${BASE_BRANCH}`.

4. **Resolve conflicts file by file** — for each conflicted file:
   - Read the file. Understand the semantic intent of *both* sides — your branch's commits
     and the changes that landed on ${BASE_BRANCH} after your branch diverged.
   - Edit to a coherent merged result. Do NOT blindly accept "ours" or "theirs" — those are
     escape hatches for trivial cases (e.g. a generated lock file). For source code with
     real semantic content, write a result that preserves both intentions.
   - `git add <file>` after resolving.
   - Run typecheck/lint after each resolution if the project has them. File-level merges
     can leave type-level conflicts (e.g. a renamed function call) that the textual merge
     missed.
   - `git rebase --continue` to advance to the next conflicting commit.

5. **If the rebase is irreconcilable** — for example, if your branch's design has been
   structurally invalidated by what landed on base — `git rebase --abort` and exit with
   `status="stalled"` and a clear note in the signal file's `lastError` field. A human
   needs to make the call.

6. **Run quality gates** — read `.catalyst/config.json:catalyst.qualityGates` (if present)
   and run each gate command in order. They must all pass before pushing. If a gate fails,
   fix it (don't disable it). Reuse the orchestrator's existing tooling — never bypass
   `--no-verify` etc.

7. **Force-push with safety** — `git push --force-with-lease origin ${BRANCH_NAME}`. Never
   use plain `--force` (it overwrites concurrent pushes). If the push is rejected because
   someone else pushed in the meantime, fetch, re-rebase the new tip, and try again — at
   most twice; then escalate.

8. **Record the rebase commit SHA in the signal file** at `${SIGNAL_FILE}`:

   ```bash
   REBASE_SHA=$(git rev-parse HEAD)
   jq --arg sha "$REBASE_SHA" '.rebaseCommit = $sha | .status = "pr-created"' \
     "${SIGNAL_FILE}" > "${SIGNAL_FILE}.tmp" && mv "${SIGNAL_FILE}.tmp" "${SIGNAL_FILE}"
   ```

9. **Exit** — do NOT poll for merge. The orchestrator's Phase 4 poll loop is the
   authoritative merge watcher (CTL-133). If the PR was already armed for auto-merge by the
   original worker, GitHub will merge as soon as the PR re-evaluates to CLEAN. If
   auto-merge was not armed for some reason, the orchestrator will detect it and either
   arm it or escalate.

10. **File improvement findings (CTL-176 / CTL-183 routing)** — when you notice friction
    worth fixing during this rebase (workflow gaps, bugs in adjacent code, tooling gaps),
    record it on the shared findings queue:

    ```bash
    "${CLAUDE_PLUGIN_ROOT}/scripts/add-finding.sh" \
      --title "Short imperative title" --body "Details" --skill worker-rebase
    ```

    Do NOT drain the queue yourself when running under an orchestrator — the orchestrator's
    Phase 7 owns the single drain pass over the shared queue (`$ORCH_DIR/findings.jsonl`).
    Standalone runs (no `CATALYST_ORCHESTRATOR_ID`) drain locally:

    ```bash
    FEEDBACK="${CLAUDE_PLUGIN_ROOT}/scripts/file-feedback.sh"
    FINDINGS_FILE="${CATALYST_FINDINGS_FILE:-.catalyst/findings/${CATALYST_SESSION_ID:-current}.jsonl}"
    if [ -z "${CATALYST_ORCHESTRATOR_ID:-}${CATALYST_ORCHESTRATOR_DIR:-}" ] \
        && [ -x "$FEEDBACK" ] && [ -f "$FINDINGS_FILE" ] && [ -s "$FINDINGS_FILE" ]; then
      while IFS= read -r line; do
        TITLE=$(jq -r '.title' <<<"$line")
        BODY=$(jq -r '.body' <<<"$line")
        SKILL=$(jq -r '.skill // "worker-rebase"' <<<"$line")
        "$FEEDBACK" --title "$TITLE" --body "$BODY" --skill "$SKILL" --json || true
      done < "$FINDINGS_FILE"
      rm -f "$FINDINGS_FILE"
    fi
    ```

## What NOT to do

- Do NOT file a new Linear ticket — this is recovery on the same ticket.
- Do NOT create a new PR — force-push to the existing branch.
- Do NOT use plain `git push -f` — `--force-with-lease` only.
- Do NOT poll for MERGED — the orchestrator's poll loop handles it (CTL-133).
- Do NOT bypass quality gates with `--no-verify` or similar — fix the underlying issue.
- Do NOT mass-resolve with `git checkout --ours` or `--theirs` for source files. Conflicts
  on real code need real merging. Lock files and generated artifacts are the only files
  where strategy-based resolution is appropriate.
