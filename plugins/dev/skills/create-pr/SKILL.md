---
name: create-pr
description:
  "Create pull request with automatic Linear integration. **ALWAYS use when** the user says 'create
  a PR', 'open a pull request', 'ship this', 'ready for review', or wants to push changes and create
  a GitHub PR. Handles commit, rebase, push, PR creation, description generation, and Linear ticket
  update."
disable-model-invocation: false
allowed-tools: Bash(linearis *), Bash(git *), Bash(gh *), Read, Task
version: 1.0.0
---

# Create Pull Request

Orchestrates the complete PR creation flow: commit → rebase → push → create → describe → link Linear
ticket.

## Prerequisites

```bash
# Check project setup (thoughts, CLAUDE.md snippet, config)
if [[ -f "${CLAUDE_PLUGIN_ROOT}/scripts/check-project-setup.sh" ]]; then
  "${CLAUDE_PLUGIN_ROOT}/scripts/check-project-setup.sh" || exit 1
fi
```

## Configuration

Read team configuration from `.catalyst/config.json`:

```bash
CONFIG_FILE=".catalyst/config.json"
[[ ! -f "$CONFIG_FILE" ]] && CONFIG_FILE=".claude/config.json"
TEAM_KEY=$(jq -r '.catalyst.linear.teamKey // "PROJ"' "$CONFIG_FILE")
```

## Process:

### 1. Check for uncommitted changes

```bash
git status --porcelain
```

If there are uncommitted changes:

- Offer to commit: "You have uncommitted changes. Create commits now? [Y/n]"
- If yes: internally call `/commit` workflow
- If no: proceed (user may want to commit manually later)

### 2. Verify not on main/master branch

```bash
branch=$(git branch --show-current)
```

If on `main` or `master`:

- Error: "Cannot create PR from main branch. Create a feature branch first."
- Exit

### 3. Detect base branch

```bash
# Check which exists
if git show-ref --verify --quiet refs/heads/main; then
    base="main"
elif git show-ref --verify --quiet refs/heads/master; then
    base="master"
else
    base=$(git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@')
fi
```

### 4. Check if branch is up-to-date with base

```bash
# Fetch latest
git fetch origin $base

# Check if behind
if git log HEAD..origin/$base --oneline | grep -q .; then
    echo "Branch is behind $base"
fi
```

If behind:

- Auto-rebase: `git rebase origin/$base`
- If conflicts:
  - Show conflicting files
  - Error: "Rebase conflicts detected. Resolve conflicts and run /catalyst-dev:create-pr again."
  - Exit

### 5. Check for existing PR

```bash
gh pr view --json number,url,title,state 2>/dev/null
```

If PR exists:

- Show: "PR #{number} already exists: {title}\n{url}"
- Ask: "What would you like to do?\n [D] Describe/update this PR\n [S] Skip (do nothing)\n [A]
  Abort"
- If D: call `/describe-pr` and exit
- If S: exit with success message
- If A: exit
- **This is the ONLY interactive prompt in the happy path**

### 6. Extract ticket from branch name

```bash
branch=$(git branch --show-current)

# Extract pattern: PREFIX-NUMBER using configured team key
if [[ "$branch" =~ ($TEAM_KEY-[0-9]+) ]]; then
    ticket="${BASH_REMATCH[1]}"  # e.g., ENG-123
fi
```

### 7. Generate PR title from branch and ticket

```bash
# Branch format examples:
# - ENG-123-implement-pr-lifecycle → "ENG-123: implement pr lifecycle"
# - feature-add-validation → "add validation"

# Extract description from branch name
if [[ "$ticket" ]]; then
    # Remove ticket prefix from branch
    desc=$(echo "$branch" | sed "s/^$ticket-//")
    # Convert kebab-case to spaces
    desc=$(echo "$desc" | tr '-' ' ')
    # Capitalize first word
    desc="$(tr '[:lower:]' '[:upper:]' <<< ${desc:0:1})${desc:1}"

    title="$ticket: $desc"
else
    # No ticket in branch
    desc=$(echo "$branch" | tr '-' ' ')
    desc="$(tr '[:lower:]' '[:upper:]' <<< ${desc:0:1})${desc:1}"
    title="$desc"
fi
```

### 8. Push branch

```bash
# Check if branch has upstream
if ! git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null; then
    # No upstream, push with -u
    git push -u origin HEAD
else
    # Has upstream, check if up-to-date
    git push
fi
```

### 9. Create PR

**CRITICAL: NO CLAUDE ATTRIBUTION**

DO NOT add any of the following to the PR:

- ❌ "Generated with Claude Code" or similar messages
- ❌ "Co-Authored-By: Claude" lines
- ❌ Any reference to AI assistance
- ❌ Links to Claude Code or Anthropic

The PR should be authored solely by the user (git author). Keep the description clean and
professional.

```bash
# Generate a meaningful initial body from commit messages (NO CLAUDE ATTRIBUTION)
commits=$(git log origin/$base..HEAD --oneline --no-merges)
body="## Changes

$commits"

# If ticket exists, add reference
if [[ "$ticket" ]]; then
    body="$body

Refs: $ticket"
fi

# Create PR (author will be the git user)
gh pr create --title "$title" --body "$body" --base "$base"
```

The initial body uses commit messages so the PR is immediately readable even before `/describe-pr`
generates the full description.

Capture PR number and URL from output.

### Track in Workflow Context (REQUIRED)

After creating the PR, track it — substitute the actual PR URL and ticket:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" add prs "https://github.com/org/repo/pull/NUMBER" "TICKET-ID"
```

### 10. Auto-call /describe-pr

Immediately call `/describe-pr` with the PR number to:

- Generate comprehensive description
- Run verification checks
- Update PR title (refined from code analysis)
- Save to thoughts/
- Update Linear ticket

### 11. Update Linear ticket (if ticket found)

If ticket was extracted from branch:

```bash
# If Linearis CLI is available:
# 1. Update ticket status to stateMap.inReview from config
# 2. Add a comment with the PR link
# Use `linearis issues usage` and `linearis comments usage` for exact syntax.
# Skip silently if CLI not available.
```

### 12. Post-PR Monitoring & Resolution Loop

**CRITICAL: Creating the PR is NOT the end of this skill.** You MUST monitor CI checks, wait for
automated reviewer comments, address them, and only report success when the PR is in a clean,
mergeable state — or genuinely blocked on a human gate (like approval from a specific person).

Do NOT just say "PR created" or "PR created with auto-merge" and stop. That leaves the user to do
all the follow-up work manually.

**Step 12a: Wait for CI checks and automated reviewers (event-driven)**

Automated review agents (Codex, security scanners, linters) typically post
comments within 3–5 minutes of PR creation. CI checks also need time to run.
Use the canonical "Reactive PR lifecycle" pattern from [[monitor-events]] §
Pattern 3 (CTL-228) — a single multi-event subscription that wakes on PR
merged, PR closed, CI completed, review submitted, or push to the base
branch — instead of `sleep 30` polling.

```bash
REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')
BASE_BRANCH=$(gh api "repos/${REPO}/pulls/${pr_number}" --jq '.base.ref' 2>/dev/null || echo "main")

if command -v catalyst-events >/dev/null 2>&1; then
  # Reactive event-driven path. Wakes on the first actionable signal
  # (CI complete, comment, review, merge, base advance, or 5-min timeout).
  # Two-phase compliant cadence loop — see [[wait-for-github]].
  EVENT_JSON=$(catalyst-events wait-for \
    --filter '
      (.event == "github.pr.merged" and .scope.pr == '"$pr_number"') or
      (.event == "github.pr.closed" and .scope.pr == '"$pr_number"') or
      (.event == "github.check_suite.completed"
         and (.detail.prNumbers // [] | index('"$pr_number"') != null)) or
      (.event == "github.pr_review.submitted"
         and .scope.pr == '"$pr_number"') or
      (.event == "github.issue_comment.created"
         and .scope.pr == '"$pr_number"') or
      (.event == "github.pr_review_comment.created"
         and .scope.pr == '"$pr_number"') or
      (.event == "github.push" and .scope.ref == "refs/heads/'"$BASE_BRANCH"'")
    ' \
    --timeout 300 || true)

  # MANDATORY authoritative REST re-check on every wake-up.
  PR_DATA=$(gh api "repos/${REPO}/pulls/${pr_number}" \
    --jq '{merged: .merged, state: .state, head_sha: .head.sha}' 2>/dev/null || echo '{}')
  PR_STATE=$(echo "$PR_DATA" | jq -r 'if .merged then "MERGED" elif .state == "closed" then "CLOSED" else "OPEN" end')
  HEAD_SHA=$(echo "$PR_DATA" | jq -r '.head_sha // ""')
  CI_STATUS="unknown"
  if [ -n "$HEAD_SHA" ]; then
    CI_STATUS=$(gh api "repos/${REPO}/commits/${HEAD_SHA}/check-runs" \
      --jq '[.check_runs[] | .conclusion // .status] | unique | join(",")' 2>/dev/null || echo "pending")
  fi
  echo "wake: state=${PR_STATE} CI=${CI_STATUS} event=$(echo "$EVENT_JSON" | jq -r '.event // "(timeout)"')"
else
  # Fallback when catalyst-events CLI is not installed — REST-only poll.
  # See [[wait-for-github]] for the full two-phase pattern.
  COUNT=0
  MAX=24  # 2-hour limit at 5-min intervals
  MERGED_FLAG="false"
  while [ "$MERGED_FLAG" != "true" ] && [ $COUNT -lt $MAX ]; do
    sleep 300
    COUNT=$((COUNT + 1))
    PR_DATA=$(gh api "repos/${REPO}/pulls/${pr_number}" 2>/dev/null || echo '{"merged":false}')
    MERGED_FLAG=$(echo "$PR_DATA" | jq -r '.merged')
    COMMENT_COUNT=$(gh api "repos/${REPO}/pulls/${pr_number}/comments" --jq 'length' 2>/dev/null || echo "0")
    REVIEW_COUNT=$(gh api "repos/${REPO}/pulls/${pr_number}/reviews" \
      --jq '[.[] | select(.state != "APPROVED" and .state != "DISMISSED")] | length' 2>/dev/null || echo "0")
    echo "REST poll @$((COUNT * 5))min: merged=${MERGED_FLAG} comments=${COMMENT_COUNT} reviews=${REVIEW_COUNT}"
    [ "$MERGED_FLAG" = "true" ] && break
    { [ "$COMMENT_COUNT" -gt 0 ] || [ "$REVIEW_COUNT" -gt 0 ]; } && break
  done
fi
```

The reactive path replaces the `sleep 180 + sleep 30` poll cadence with
event-driven wake-ups. The `--timeout 300` floor prevents indefinite blocks
when the orch-monitor daemon is down. The fallback path uses REST-only polling
(`gh api` at 5-min intervals) — no `gh pr checks --json` or `gh pr view --json`
in any loop. See `[[wait-for-github]]` for the full two-phase diagnostic pattern.
The fallback path is preserved verbatim for installs without the `catalyst-events` CLI.

**Step 12b: Address all review comments**

If any comments or reviews exist, run `/review-comments $pr_number` to:

- Fetch and categorize all comments (inline, review threads, issue comments)
- Implement requested code changes
- Resolve review threads via GraphQL
- Push a single addressing commit

**Step 12c: Diagnose and resolve merge blockers**

Read and follow `"${CLAUDE_PLUGIN_ROOT}/references/merge-blocker-diagnosis.md"`. Run the full
blocker diagnosis and resolution loop (max 3 rounds):

- `ci-failing` → analyze failure logs, fix code, push, re-poll
- `unresolved-threads` → run `/review-comments` (addresses + resolves threads)
- `branch-behind` → rebase and push
- `draft` → `gh pr ready`
- `changes-requested` → check if addressed; attempt to fix

**CRITICAL MISDIAGNOSIS WARNING**: Do NOT confuse "unresolved review threads" with "needs approving
reviewer." Code comments from automated reviewers (Codex, security scanners) create **threads** that
YOU can resolve by addressing the feedback and resolving the thread via GraphQL. These are NOT a
human approval gate. Only `review-required` (no approving reviews at all) is a genuine human gate.
Read the merge-blocker-diagnosis reference carefully.

**Step 12d: Re-poll until clean or genuinely human-blocked**

After each fix cycle, re-query the merge state. Continue looping until:

- `mergeStateStatus` is `CLEAN` → PR is ready to merge, report success
- Only remaining blocker is `review-required` (needs human approval) → report what's needed
- Max attempts (3) exhausted → report exactly what's still blocking with actionable guidance

### 13. Report final state

Report based on the **actual merge state** after monitoring — not just "PR created."

**If CLEAN (ready to merge):**

```
✅ PR #{number} ready to merge

PR: #{number} - {title}
URL: {url}
Base: {base_branch}
Ticket: {ticket} (moved to "In Review")

Status:
  ✅ CI checks passed
  ✅ Review comments addressed ({N} resolved)
  ✅ No merge blockers

Merge with: /catalyst-dev:merge-pr
```

**If blockers remain (report exactly what's needed):**

```
PR #{number} created — {N} blocker(s) remain

PR: #{number} - {title}
URL: {url}

Resolved:
  ✅ {what was fixed}

Still blocking:
  ❌ {specific blocker and exactly what's needed to resolve it}
```

## Error Handling

**On main/master branch:**

```
❌ Cannot create PR from main branch.

Create a feature branch first:
  git checkout -b TICKET-123-feature-name
```

**Rebase conflicts:**

```
❌ Rebase conflicts detected

Conflicting files:
  - src/file1.ts
  - src/file2.ts

Resolve conflicts and run:
  git add <resolved-files>
  git rebase --continue
  /catalyst-dev:create-pr
```

**GitHub CLI not configured:**

```
❌ GitHub CLI not configured

Run: gh auth login
Then: gh repo set-default
```

**Linearis CLI not found:**

```
⚠️  Linearis CLI not found

PR created successfully, but Linear ticket not updated.

Install Linearis:
  npm install -g linearis

Configure:
  export LINEAR_API_TOKEN=your_token
```

**Linear ticket not found:**

```
⚠️  Could not find Linear ticket for {ticket}

PR created successfully, but ticket not updated.
Update manually or check ticket ID.
```

## Configuration

Uses `.catalyst/config.json`:

```json
{
  "catalyst": {
    "project": {
      "ticketPrefix": "PROJ"
    },
    "linear": {
      "teamKey": "PROJ",
      "stateMap": {
        "inReview": "In Review"
      }
    }
  }
}
```

State names are read from `stateMap` with sensible defaults. See `.catalyst/config.json` for all
keys.

## Examples

**Branch: `ENG-123-implement-pr-lifecycle`**

```
Extracting ticket: ENG-123
Generated title: "ENG-123: Implement pr lifecycle"
Creating PR...
✅ PR #2 created
Calling /catalyst-dev:describe-pr to generate description...
Updating Linear ticket ENG-123 → In Review
✅ Complete!
```

**Branch: `feature-add-validation` (no ticket)**

```
No ticket found in branch name
Generated title: "Feature add validation"
Creating PR...
✅ PR #3 created
Calling /describe-pr...
⚠️  No Linear ticket to update
✅ Complete!
```

## Integration with Other Commands

- **Calls `/commit`** - if uncommitted changes (optional)
- **Calls `/describe-pr`** - always, to generate comprehensive description
- **Sets up for `/merge-pr`** - PR is now ready for review and eventual merge

## Remember:

- **NEVER stop at "PR created"** — poll every 30s (after 3-min minimum wait) checking CI, reviews,
  and PR state. Address any comments, fix CI failures, confirm clean merge state
- **"PR created with auto-merge" is NOT done** — poll until state=MERGED or genuinely human-blocked
- **Automated reviewer comments are YOUR job** — address Codex/scanner feedback, don't wait for human
- **Minimize prompts** — only ask when PR already exists
- **Auto-rebase** — keep branch up-to-date with base
- **Auto-link Linear** — extract ticket from branch, update status with Linearis CLI
- **Auto-describe** — comprehensive description generated immediately
- **Fail fast** — stop on conflicts or errors with clear messages
- **Graceful degradation** — if Linearis not installed, warn but continue
- For Linearis CLI syntax, see the `linearis` skill reference
