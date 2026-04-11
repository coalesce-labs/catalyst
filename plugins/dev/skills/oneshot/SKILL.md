---
name: oneshot
description:
  "End-to-end autonomous workflow — research, plan, implement, validate, ship, and merge in one
  command. **ALWAYS use when** the user says 'oneshot', 'do everything end to end', 'full workflow',
  or wants to go from ticket/idea to merged PR autonomously. Each phase runs in a fresh session for
  context isolation."
disable-model-invocation: true
allowed-tools: Read, Write, Bash, Task, Grep, Glob
version: 3.0.0
---

# Oneshot

End-to-end autonomous workflow that chains research → plan → implement → validate → ship → merge
with context isolation between phases via `humanlayer launch`. Each phase runs in a fresh Claude
Code session with full capabilities.

## Prerequisites

```bash
# 1. Validate thoughts system (REQUIRED)
if [[ ! -d "thoughts/shared" ]]; then
  echo "❌ ERROR: Thoughts system not configured"
  echo "Run: ./scripts/humanlayer/init-project.sh . {project-name}"
  exit 1
fi

# 2. Validate humanlayer CLI (REQUIRED for session launching)
if ! command -v humanlayer &>/dev/null; then
  echo "❌ ERROR: HumanLayer CLI required for oneshot workflow"
  echo "Install: pip install humanlayer"
  exit 1
fi
```

## Input Modes

Supports two input modes:

**Ticket-based:**

```
/oneshot PROJ-123
```

Reads ticket from Linear, uses title/description as research query.

**Freeform:**

```
/oneshot "How does authentication work and can we add OAuth?"
```

Uses the provided text as the research query directly.

## Flags

| Flag                   | Description                                            |
| ---------------------- | ------------------------------------------------------ |
| `--team`               | Use agent teams for parallel implementation in Phase 3 |
| `--auto-merge`         | Phase 5 waits for CI and auto-invokes Phase 6          |
| `--no-ticket`          | Skip Linear ticket creation in freeform mode           |
| `--skip-validation`    | Skip Phase 4 entirely                                  |
| `--skip-quality-gates` | Run `/validate-plan` but skip quality gate loop        |

## Orchestrator Mode

When running under an `/orchestrate` coordinator, oneshot writes status updates to a **worker
signal file** so the orchestrator can track progress and run adversarial verification.

**Detection (checked once at startup):**

```bash
# 1. CATALYST_ORCHESTRATOR_DIR env var (set by orchestrator in dispatch)
ORCH_DIR="${CATALYST_ORCHESTRATOR_DIR:-}"

# 2. Sibling directory with workers/ subdirectory (convention-based)
if [ -z "$ORCH_DIR" ]; then
  PARENT=$(dirname "$(pwd)")
  for DIR in "$PARENT"/*/workers; do
    if [ -d "$DIR" ]; then
      ORCH_DIR=$(dirname "$DIR")
      break
    fi
  done
fi
```

If `ORCH_DIR` is detected, the worker:

1. **Reads its signal file** from `${ORCH_DIR}/workers/${TICKET_ID}.json` (created by orchestrator)
2. **Updates status at each phase transition** — writes `status`, `phase`, and `updatedAt`
3. **Fills `definitionOfDone`** at Phase 4 (validation) and Phase 5 (ship) with actual results
4. **Reads wave briefing** if referenced in `${ORCH_DIR}/wave-*-briefing.md` before starting

**Signal file update helper** (run at each phase boundary):

```bash
SIGNAL_FILE="${ORCH_DIR}/workers/${TICKET_ID}.json"
if [ -f "$SIGNAL_FILE" ]; then
  jq --arg status "$NEW_STATUS" \
     --arg phase "$PHASE_NUM" \
     --arg updated "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
     '.status = $status | .phase = ($phase | tonumber) | .updatedAt = $updated' \
     "$SIGNAL_FILE" > "${SIGNAL_FILE}.tmp" && mv "${SIGNAL_FILE}.tmp" "$SIGNAL_FILE"
fi
```

**Phase-to-status mapping for signal file:**

| Phase | Signal Status |
|-------|--------------|
| 1 start | `researching` |
| 2 start | `planning` |
| 3 start | `implementing` |
| 4 start | `validating` |
| 5 start | `shipping` |
| 5 PR created | `pr-created` |
| 6 start | `merging` |
| 6 complete | `done` |
| Any failure | `failed` |

## Workflow Phases

### Phase 1: Research (Current Session — Opus)

This phase runs in the current session to allow user interaction during research.

1. **Parse input**: Determine if ticket ID or freeform query
2. **If ticket**: Read ticket details via Linearis CLI, move to `stateMap.research` (default: "In
   Progress")
3. **If freeform (and NOT `--no-ticket`)**: After research completes, offer to create a Linear
   ticket from the findings:
   ```
   Research complete. Would you like to create a Linear ticket from these findings?
   [y/N]
   ```
   If yes, create a ticket via `linearis issue create` using the research summary as description,
   then track the ticket ID for subsequent phases.
4. **Conduct research**: Spawn parallel sub-agents (same as `/research-codebase`):
   - **codebase-locator**: Find relevant files
   - **codebase-analyzer**: Understand current implementation
   - **codebase-pattern-finder**: Find similar patterns
   - **thoughts-locator**: Find existing context (if relevant)
   - **external-research**: Research frameworks/libraries (if relevant)
5. **Synthesize findings**: Create research document at
   `thoughts/shared/research/YYYY-MM-DD-{ticket}-{description}.md`
6. **Sync**: `humanlayer thoughts sync`
7. **Track in workflow context (REQUIRED)** — substitute actual path and ticket:
   ```bash
   "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" add research "thoughts/shared/research/YYYY-MM-DD-description.md" "TICKET-ID"
   ```
8. **Verify**: `"${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" recent research` must print the
   path

### Phase 2: Plan (New Session via `humanlayer launch` — Opus)

Launches a fresh Claude Code session with full context isolation.

```bash
humanlayer launch \
  --model opus \
  --title "plan ${TICKET_ID:-oneshot}" \
  "/create-plan thoughts/shared/research/$RESEARCH_DOC"
```

**What happens in the launched session:**

- Fresh context window (no research tokens consumed)
- Reads research document from thoughts/
- Runs `/create-plan` interactively with the user
- Creates plan at `thoughts/shared/plans/YYYY-MM-DD-{ticket}-{description}.md`
- Syncs thoughts automatically

**User interaction**: The user interacts with the planning session normally. The plan is refined
iteratively until approved.

**Linear**: If ticket exists, move to `stateMap.planning` (default: "In Progress").

### Phase 3: Implement (New Session via `humanlayer launch` — Opus)

After the plan is approved, launches another fresh session:

```bash
humanlayer launch \
  --model opus \
  --title "implement ${TICKET_ID:-oneshot}" \
  "/implement-plan thoughts/shared/plans/$PLAN_DOC"
```

**What happens in the launched session:**

- Fresh context window (no planning tokens consumed)
- Reads plan document from thoughts/
- Runs `/implement-plan` with full capabilities — follows TDD (tests written before implementation
  per phase)
- Can spawn agent teams for complex multi-file implementations (see --team mode)
- **Does NOT commit or create PR** — deferred to Phase 5

**Linear**: If ticket exists, move to `stateMap.inProgress` (default: "In Progress").

### Phase 4: Validate + Quality Gates (New Session via `humanlayer launch` — Opus)

**Skip this phase entirely with `--skip-validation`.**

Launches a fresh session for validation and quality enforcement:

```bash
humanlayer launch \
  --model opus \
  --title "validate ${TICKET_ID:-oneshot}" \
  "Run /validate-plan then run quality gates. Plan: thoughts/shared/plans/$PLAN_DOC"
```

**Step 1: Validate plan implementation**

- Runs `/validate-plan` against the plan document
- Produces a validation report with phase completion status and deviations

**Step 2: Run skill-based quality gates** (skip with `--skip-quality-gates`)

Run these skill/agent gates in order:

```
Gate 1: /validate-type-safety  → tsc + reward hacking scan + tests + lint
Gate 2: /security-review       → security vulnerability scan (built-in)
Gate 3: code-reviewer agent    → style/guideline adherence
Gate 4: pr-test-analyzer agent → test coverage verification
```

For each gate: run it, if it fails and is auto-fixable (gates 1 and 2), attempt to fix and re-run.
Gates 3 and 4 produce advisory findings — address them if significant.

**Step 3: Run config-based quality gates**

Reads additional gates from `.catalyst/config.json` under `catalyst.qualityGates` (see Configuration
section below). Runs each gate in `order` sequence:

```
For each gate (sorted by order):
  1. Run gate.command
  2. If passes → mark ✅, continue to next gate
  3. If fails AND gate.autofix is true:
     - Analyze errors
     - Attempt automated fix
     - Re-run gate.command
  4. If fails AND gate.autofix is false OR autofix attempt failed:
     - Log failure, continue to next gate
  5. After all gates, if any required gate failed:
     - Retry from first failed gate (up to maxRetries total cycles)
```

**After max retries exhausted with failures:** Present the user with options:

```
⚠️  Quality gates failed after {maxRetries} attempts:
  ❌ typecheck: 3 errors remaining
  ❌ test: 2 failing tests

Options:
  [1] Fix manually and re-run gates
  [2] Continue to Ship phase anyway (gates marked as skipped)
  [3] Create handoff document and stop
```

**Fallback behavior (no `qualityGates` config):** If `catalyst.qualityGates` is not configured,
construct default gates from legacy config keys:

| Legacy Key                     | Gate      | Order |
| ------------------------------ | --------- | ----- |
| `catalyst.pr.typecheckCommand` | typecheck | 1     |
| `catalyst.pr.lintCommand`      | lint      | 2     |
| `catalyst.pr.testCommand`      | test      | 3     |
| `catalyst.pr.buildCommand`     | build     | 4     |

If none of those keys exist either, skip quality gates entirely (validation-only mode).

### Phase 5: Ship (New Session via `humanlayer launch` — Sonnet)

Launches a Sonnet session for the structured PR workflow:

```bash
humanlayer launch \
  --model sonnet \
  --title "ship ${TICKET_ID:-oneshot}" \
  "Ship changes: smart PR create/update, CI polling, comment monitoring. Ticket: ${TICKET_ID:-none}"
```

**Step 1: Smart PR Creation/Update**

Check if a PR already exists for the current branch:

```bash
EXISTING_PR=$(gh pr list --head "$(git branch --show-current)" --json number --jq '.[0].number' 2>/dev/null)
```

- **If PR exists** (`$EXISTING_PR` is not empty):
  - Commit and push new changes
  - Update PR description with `/describe-pr`
  - Log: "Updated existing PR #$EXISTING_PR"

- **If no PR exists**:
  - Run `/create-pr` (handles commit, push, PR creation, description, Linear linking)

**Step 2: Wait for Automated Reviewers**

Automated review agents (Codex, Direnv, etc.) typically post comments within 3-5 minutes of PR
creation. Wait for them before processing comments, so we can address everything in one pass.

```bash
REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')
OWNER=$(echo "$REPO" | cut -d'/' -f1)
NAME=$(echo "$REPO" | cut -d'/' -f2)

# Wait 3 minutes, then start checking for comments
sleep 180

# Poll for up to 2 more minutes (5 min total) — check every 30s
WAITED=180
MAX_WAIT=300
while [ $WAITED -lt $MAX_WAIT ]; do
  COMMENT_COUNT=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}/comments" --jq 'length')
  REVIEW_COUNT=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}/reviews" \
    --jq '[.[] | select(.state != "APPROVED" and .state != "DISMISSED")] | length')

  if [ "$COMMENT_COUNT" -gt 0 ] || [ "$REVIEW_COUNT" -gt 0 ]; then
    echo "Found review comments — proceeding to address them"
    break
  fi

  sleep 30
  WAITED=$((WAITED + 30))
done

if [ "$COMMENT_COUNT" -eq 0 ] && [ "$REVIEW_COUNT" -eq 0 ]; then
  echo "No automated review comments after ${MAX_WAIT}s — proceeding"
fi
```

**Step 3: Address and Resolve Review Comments**

Check for unresolved review threads and address them. This step loops until all threads are resolved
or no new comments arrive after a fix push.

```bash
MAX_COMMENT_ROUNDS=3
ROUND=0

while [ $ROUND -lt $MAX_COMMENT_ROUNDS ]; do
  # Check for unresolved threads
  UNRESOLVED=$(gh api graphql -f query='
  query($owner: String!, $name: String!, $pr: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $pr) {
        reviewThreads(first: 100) {
          nodes { id isResolved comments(first: 1) { nodes { body author { login } } } }
        }
      }
    }
  }' -f owner="$OWNER" -f name="$NAME" -F pr="$PR_NUMBER" \
    --jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false)] | length')

  if [ "$UNRESOLVED" -eq 0 ]; then
    echo "All review threads resolved"
    break
  fi

  echo "$UNRESOLVED unresolved thread(s) — running /review-comments"

  # /review-comments now handles: fetch, categorize, fix/reply, commit, push, AND resolve threads
  /review-comments $PR_NUMBER

  ROUND=$((ROUND + 1))

  # Brief pause for any new automated comments triggered by the fix push
  if [ $ROUND -lt $MAX_COMMENT_ROUNDS ]; then
    sleep 60
  fi
done

if [ "$UNRESOLVED" -gt 0 ]; then
  echo "⚠️  $UNRESOLVED unresolved thread(s) remain after $MAX_COMMENT_ROUNDS rounds"
  echo "Manual review may be needed before merge"
fi
```

**Step 4: CI Polling with Auto-Fix**

After comments are addressed (fixes may have been pushed), poll CI checks:

```bash
# Poll CI — max 3 fix attempts
ATTEMPT=0
MAX_ATTEMPTS=3

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
  gh pr checks $PR_NUMBER --watch --fail-fast

  if [ $? -eq 0 ]; then
    break  # CI passed
  fi

  ATTEMPT=$((ATTEMPT + 1))
  if [ $ATTEMPT -lt $MAX_ATTEMPTS ]; then
    # Analyze CI failures
    # Attempt automated fix
    # Commit and push fix
    # Re-poll
  fi
done
```

If CI fails after all attempts, present the user with options:

```
CI failed after {ATTEMPT} fix attempts:
  ❌ {check name}: {failure reason}

Options:
  [1] Fix manually and re-poll
  [2] Continue to merge anyway (if branch protections allow)
  [3] Create handoff and stop
```

**Step 5: Final Comment Check**

After CI passes, do one final check for any new comments that arrived during CI fixes:

```bash
FINAL_UNRESOLVED=$(gh api graphql -f query='...' \
  --jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false)] | length')

if [ "$FINAL_UNRESOLVED" -gt 0 ]; then
  echo "$FINAL_UNRESOLVED new unresolved thread(s) — running /review-comments"
  /review-comments $PR_NUMBER
fi
```

**Step 6: Present options**

```
PR ready: https://github.com/org/repo/pull/{number}

CI:       ✅ passed
Threads:  ✅ all resolved ({N} addressed)
Reviews:  {N} comments addressed / no comments

Options:
  [1] Wait for approval and auto-merge (runs Phase 6 automatically)
  [2] Exit — merge later with /merge-pr
```

**If `--auto-merge` flag was set:** Skips the prompt, waits for CI, and proceeds to Phase 6
automatically.

**Linear**: `/create-pr` moves ticket to `stateMap.inReview` (default: "In Review").

### Phase 6: Merge (Same Session as Phase 5 or Manual — Sonnet)

Only runs automatically if:

- User selected option [1] in Phase 5, OR
- `--auto-merge` flag was passed

Otherwise, user merges manually later with `/merge-pr`.

```
/merge-pr
```

**What happens:**

- Runs `/merge-pr` which internally handles: CI verification, rebase if needed, squash merge, branch
  cleanup
- Moves Linear ticket to `stateMap.done` (default: "Done")

## Team Mode (Optional)

For complex implementations spanning multiple files/layers:

```
/oneshot --team PROJ-123
```

In team mode, Phase 3 uses agent teams for parallel implementation:

- Lead agent (Opus) coordinates the implementation
- Teammates (Sonnet) each own distinct file groups
- Each teammate can spawn their own research sub-agents
- Lead reviews teammate work via plan approval gates

**When to use `--team`:**

- Implementation spans 3+ files across different domains (frontend + backend + tests)
- Multiple independent components can be implemented in parallel
- Complex cross-cutting features

**When NOT to use `--team`:**

- Simple sequential changes
- Changes to a single file or closely related files
- Quick bug fixes

## Context Isolation Strategy

The key benefit of oneshot is **context isolation between phases**:

```
Phase 1: Research (current session — Opus)
  - Spawns parallel sub-agents for research
  - Saves research document to thoughts/
  - Context consumed: ~60-80% (research is token-heavy)

Phase 2: Plan (NEW session — Opus)
  - Starts with 0% context used
  - Reads only research document (~5-10% context)
  - Full context available for interactive planning

Phase 3: Implement (NEW session — Opus)
  - Starts with 0% context used
  - Reads only plan document (~5-10% context)
  - Full context available for implementation

Phase 4: Validate + Quality Gates (NEW session — Opus)
  - Starts with 0% context used
  - Reads plan + runs validation + quality gate loop
  - Can attempt fixes without context pressure

Phase 5: Ship (NEW session — Sonnet)
  - Starts with 0% context used
  - Lightweight: commit, PR, CI polling
  - Sonnet is sufficient for structured workflow

Phase 6: Merge (same session as Phase 5 or manual — Sonnet)
  - Reuses Phase 5 context (minimal usage)
  - Procedural: verify, merge, cleanup
```

## Configuration

### Quality Gates

Configure quality gates in the consuming project's `.catalyst/config.json`:

```json
{
  "catalyst": {
    "qualityGates": {
      "enabled": true,
      "maxRetries": 3,
      "gates": [
        {
          "name": "typecheck",
          "command": "npm run type-check",
          "required": true,
          "autofix": true,
          "order": 1
        },
        {
          "name": "lint",
          "command": "npm run lint:fix",
          "required": true,
          "autofix": true,
          "order": 2
        },
        {
          "name": "test",
          "command": "npm run test",
          "required": true,
          "autofix": false,
          "order": 3
        },
        {
          "name": "build",
          "command": "npm run build",
          "required": true,
          "autofix": false,
          "order": 4
        }
      ]
    }
  }
}
```

**Schema:**

| Field              | Type    | Description                                                          |
| ------------------ | ------- | -------------------------------------------------------------------- |
| `enabled`          | boolean | Master toggle for quality gates (default: `true`)                    |
| `maxRetries`       | number  | Max retry cycles across all gates (default: `3`)                     |
| `gates[].name`     | string  | Display name for the gate                                            |
| `gates[].command`  | string  | Shell command to run                                                 |
| `gates[].required` | boolean | If `true`, failure blocks shipping. If `false`, failure is a warning |
| `gates[].autofix`  | boolean | If `true`, attempt automated fixes on failure before retrying        |
| `gates[].order`    | number  | Execution order (lowest first)                                       |

**Backward compatibility:** If `qualityGates` is absent, the command falls back to constructing
gates from `catalyst.pr.typecheckCommand`, `catalyst.pr.lintCommand`, `catalyst.pr.testCommand`, and
`catalyst.pr.buildCommand`. If none of those exist, quality gates are skipped entirely.

### Model Selection Per Phase

| Phase         | Model  | Rationale                         |
| ------------- | ------ | --------------------------------- |
| 1 Research    | Opus   | Complex analysis, parallel agents |
| 2 Plan        | Opus   | Interactive planning, reasoning   |
| 3 Implement   | Opus   | Complex implementation            |
| 4 Validate+QG | Opus   | Error analysis, fix generation    |
| 5 Ship        | Sonnet | Structured PR workflow            |
| 6 Merge       | Sonnet | Procedural verification           |

## Linear Integration

State transitions throughout the lifecycle:

| Phase                              | Transition   | Config Key            | Default       |
| ---------------------------------- | ------------ | --------------------- | ------------- |
| 1 start                            | → research   | `stateMap.research`   | "In Progress" |
| 1 end (ticket created in freeform) | → backlog    | `stateMap.backlog`    | "Backlog"     |
| 2 start                            | → planning   | `stateMap.planning`   | "In Progress" |
| 3 start                            | → inProgress | `stateMap.inProgress` | "In Progress" |
| 5 (PR created)                     | → inReview   | `stateMap.inReview`   | "In Review"   |
| 6 (merged)                         | → done       | `stateMap.done`       | "Done"        |

## Error Handling

**If research phase fails:**

- Save partial findings to thoughts/
- Present error to user
- Suggest running `/research-codebase` manually

**If humanlayer launch fails:**

- Fall back to manual workflow:

  ```
  Could not launch new session automatically.

  Please start a new session and run:
    /create-plan thoughts/shared/research/$RESEARCH_DOC
  ```

**If implementation fails:**

- Partial work is preserved (uncommitted)
- Handoff document created automatically
- User can resume with `/resume-handoff`

**If quality gates fail after max retries:**

- Present failures with options (fix, continue, handoff)
- If user continues, gates are marked as skipped in PR description
- If user creates handoff, remaining phases are documented for next session

**If CI checks fail in Phase 5:**

- Auto-fix up to 3 attempts (analyze errors, fix, push, re-poll)
- After max attempts, present failures with options (fix manually, continue, handoff)
- Do not auto-merge if CI is red

**Automatic handoff on stop:** When the workflow stops at any phase (user choice, unrecoverable
error, context exhaustion):

- Invoke `/create-handoff` with: phases completed, current phase status, unresolved issues,
  CI/review status, and remaining phases
- Save handoff to `thoughts/shared/handoffs/`
- User can resume with `/resume-handoff`

## Important

- **Phase 1 (research) is interactive** — user can guide the research
- **Phases 2-6 launch separate sessions** — user interacts with each independently
- **thoughts/ is the handoff mechanism** — all documents persist between sessions
- **`humanlayer launch` is required** — no fallback for context isolation
- **NEVER add Claude attribution** to any generated artifacts
- **Use wiki-links** for cross-references between thoughts documents (e.g., `[[filename]]`), not
  full paths
- **Phase 3 does NOT commit** — all git operations are deferred to Phase 5
- **Phase 6 is opt-in** — requires `--auto-merge` or explicit user choice

**IMPORTANT: Document Storage Rules**

- ALWAYS write to `thoughts/shared/` (research, plans, prs subdirectories)
- NEVER write to `thoughts/searchable/` — this is a read-only search index
