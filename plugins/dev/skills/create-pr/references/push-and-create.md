# Title, Push, Create PR, and Link Linear (Steps 7–11)

## Step 7 — Generate the PR title

PR titles follow `<type>(<scope>): <ticket> ...` (CTL-783) so active work is identifiable from
GitHub alone. Prefer the first commit subject (it carries type/scope); inject the ticket via
`draft_pr_title`. Branch-derived title is the no-commit fallback.

```bash
source "${CLAUDE_PLUGIN_ROOT}/scripts/lib/draft-pr.sh"
commit_subj=$(git log --no-merges --format='%s' "origin/${base}..HEAD" 2>/dev/null | tail -1)
if [[ -n "$commit_subj" ]]; then
    title="$(draft_pr_title "$ticket" "$commit_subj")"
elif [[ "$ticket" ]]; then
    title="$ticket: $(echo "$branch" | sed "s/^$ticket-//" | tr '-' ' ')"
else
    title="$(echo "$branch" | tr '-' ' ')"
fi
```

## Step 8 — Push

```bash
source "${CLAUDE_PLUGIN_ROOT}/scripts/lib/draft-pr.sh"
PUSH_VERIFY_RC=0
VERIFIED_SHA="$(draft_pr_push_verify)" || PUSH_VERIFY_RC=$?
[[ $PUSH_VERIFY_RC -ne 0 ]] && { echo "create-pr: push-verify failed (rc=${PUSH_VERIFY_RC})" >&2; exit "$PUSH_VERIFY_RC"; }
```

`draft_pr_push_verify` is the same guarded helper every push site in this plugin uses (CTL-1051): a
pre-push safety gate (placeholder-identity / anomalous tree-wide-deletion commits refuse with
rc=4), fast-forward-then-force-with-lease retry, and a post-push origin==HEAD verify.

## Step 9 — Create the PR

**No Claude attribution** — the PR body is authored solely by the git user; never add "Generated
with Claude Code", "Co-Authored-By: Claude", or similar.

```bash
commits=$(git log origin/$base..HEAD --oneline --no-merges)
body="## Changes

$commits"
[[ "$ticket" ]] && body="$body

Refs: $ticket"

# Neutralize sibling Linear tokens embedded in the branch (CTL-623/633) before
# they can auto-link on PR-open. Full rationale:
# ../../describe-pr/references/linear-sibling-guard.md — this call site is
# branch-only (the transient body here is assembled from commit subjects, not
# prose, so there's nothing for body-mode to scan).
# shellcheck source=/dev/null
source "${CLAUDE_PLUGIN_ROOT}/scripts/lib/linear-pr-skip.sh"
skip_block="$(linear_sibling_skip_block_from_branch "$ticket" "$branch")"
[[ -n "$skip_block" ]] && body="$body

$skip_block"

gh pr create --title "$title" --body "$body" --base "$base"
```

The commit-message body makes the PR immediately readable even before `/describe-pr` runs.

## Track in Workflow Context (required)

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" add prs "https://github.com/org/repo/pull/NUMBER" "TICKET-ID"
```

## Step 10 — Auto-call /describe-pr

Immediately call `/describe-pr` with the PR number to generate the full description, run
verification, refine the title, save to `thoughts/`, and update Linear.

## Step 11 — Update the Linear ticket

If a ticket was extracted: update status to `stateMap.inReview` (`linearis issues usage` for exact
syntax) and add a PR-link comment through the app actor (`linear-reply.mjs --as <role>` or
`linear-comment-post.sh`) — never bare `linearis issues discuss`. Skip silently if the CLI is
unavailable.

**Skip the status transition when `CATALYST_PHASE` is set** — under a phase agent or a
`relay-ticket` session, the coordinator driving that ticket already owns the Linear status
write-back. This transition is for interactive `/catalyst-dev:create-pr` use only; the PR-link
comment is still posted in both modes.
