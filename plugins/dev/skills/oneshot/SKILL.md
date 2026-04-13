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
# 0. Check project setup (thoughts, config, workflow context init)
if [[ -f "${CLAUDE_PLUGIN_ROOT}/scripts/check-project-setup.sh" ]]; then
  "${CLAUDE_PLUGIN_ROOT}/scripts/check-project-setup.sh" || exit 1
fi

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
/catalyst-dev:oneshot PROJ-123
```

Reads ticket from Linear, uses title/description as research query.

**Freeform:**

```
/catalyst-dev:oneshot "How does authentication work and can we add OAuth?"
```

Uses the provided text as the research query directly.

## Flags

| Flag                   | Description                                            |
| ---------------------- | ------------------------------------------------------ |
| `--team`               | Use agent teams for parallel implementation in Phase 3 |
| `--no-merge`           | Stop after PR creation — do NOT auto-merge             |
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

# 2. CATALYST_ORCHESTRATOR_ID env var (set by orchestrator in dispatch)
ORCH_ID="${CATALYST_ORCHESTRATOR_ID:-}"

# 3. Sibling directory with workers/ subdirectory (convention-based)
if [ -z "$ORCH_DIR" ]; then
  PARENT=$(dirname "$(pwd)")
  for DIR in "$PARENT"/*/workers; do
    if [ -d "$DIR" ]; then
      ORCH_DIR=$(dirname "$DIR")
      break
    fi
  done
fi

# Resolve global state script path
STATE_SCRIPT="${CLAUDE_PLUGIN_ROOT}/scripts/catalyst-state.sh"
```

If `ORCH_DIR` is detected, the worker:

1. **Reads its signal file** from `${ORCH_DIR}/workers/${TICKET_ID}.json` (created by orchestrator)
2. **Updates status at each phase transition** — writes `status`, `phase`, and `updatedAt` to both
   the local signal file AND the global state at `~/catalyst/state.json`
3. **Emits events** to the global event log at each phase transition
4. **Fills `definitionOfDone`** at Phase 4 (validation) and Phase 5 (ship) with actual results
5. **Reads wave briefing** if referenced in `${ORCH_DIR}/wave-*-briefing.md` before starting

**Signal file + global state update helper** (run at each phase boundary):

```bash
SIGNAL_FILE="${ORCH_DIR}/workers/${TICKET_ID}.json"
if [ -f "$SIGNAL_FILE" ]; then
  OLD_STATUS=$(jq -r '.status' "$SIGNAL_FILE")
  TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # Update local signal file. Atomically records phaseTimestamps[$status] = $ts
  # so the monitor can build a Gantt timeline. Sets completedAt for terminal states.
  IS_TERMINAL="false"
  case "$NEW_STATUS" in done|failed|stalled) IS_TERMINAL="true" ;; esac

  jq --arg status "$NEW_STATUS" \
     --arg phase "$PHASE_NUM" \
     --arg ts "$TS" \
     --argjson terminal "$IS_TERMINAL" \
     '.status = $status
      | .phase = ($phase | tonumber)
      | .updatedAt = $ts
      | .phaseTimestamps = ((.phaseTimestamps // {}) | .[$status] = $ts)
      | (if $terminal then .completedAt = $ts else . end)' \
     "$SIGNAL_FILE" > "${SIGNAL_FILE}.tmp" && mv "${SIGNAL_FILE}.tmp" "$SIGNAL_FILE"

  # Update global state (if orchestrator ID is known)
  if [ -n "$ORCH_ID" ] && [ -f "$STATE_SCRIPT" ]; then
    "$STATE_SCRIPT" worker "$ORCH_ID" "$TICKET_ID" \
      ".status = \"$NEW_STATUS\" | .phase = $PHASE_NUM"

    # Emit status change event
    "$STATE_SCRIPT" event "$(jq -nc \
      --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --arg orch "$ORCH_ID" \
      --arg w "$TICKET_ID" \
      --arg from "$OLD_STATUS" \
      --arg to "$NEW_STATUS" \
      '{ts: $ts, orchestrator: $orch, worker: $w, event: "worker-status-change", detail: {from: $from, to: $to}}')"
  fi
fi
```

**When worker creates a PR**, also update global state with PR details:

```bash
if [ -n "$ORCH_ID" ] && [ -f "$STATE_SCRIPT" ]; then
  "$STATE_SCRIPT" worker "$ORCH_ID" "$TICKET_ID" \
    ".pr = {number: ${PR_NUMBER}, url: \"${PR_URL}\", ciStatus: \"pending\"}"
  "$STATE_SCRIPT" event "$(jq -nc \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg orch "$ORCH_ID" --arg w "$TICKET_ID" \
    --argjson pr "$PR_NUMBER" --arg url "$PR_URL" \
    '{ts: $ts, orchestrator: $orch, worker: $w, event: "worker-pr-created", detail: {pr: $pr, url: $url}}')"
fi
```

**When CI passes** (during Phase 5 blocker resolution or Phase 6 pre-merge), update signal + global state:

```bash
if [ -f "$SIGNAL_FILE" ]; then
  jq '.pr.ciStatus = "passing"' "$SIGNAL_FILE" > "${SIGNAL_FILE}.tmp" \
    && mv "${SIGNAL_FILE}.tmp" "$SIGNAL_FILE"
fi
if [ -n "$ORCH_ID" ] && [ -f "$STATE_SCRIPT" ]; then
  "$STATE_SCRIPT" worker "$ORCH_ID" "$TICKET_ID" '.pr.ciStatus = "passing"'
fi
```

**When PR is merged** (Phase 6 completes), update signal + global state with merge timestamp:

```bash
MERGE_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ -f "$SIGNAL_FILE" ]; then
  jq --arg ts "$MERGE_TS" '.pr.ciStatus = "merged" | .pr.mergedAt = $ts' \
    "$SIGNAL_FILE" > "${SIGNAL_FILE}.tmp" && mv "${SIGNAL_FILE}.tmp" "$SIGNAL_FILE"
fi
if [ -n "$ORCH_ID" ] && [ -f "$STATE_SCRIPT" ]; then
  "$STATE_SCRIPT" worker "$ORCH_ID" "$TICKET_ID" \
    ".pr.ciStatus = \"merged\" | .pr.mergedAt = \"${MERGE_TS}\""
fi
```

**When worker reaches terminal state** (done or failed):

```bash
if [ -n "$ORCH_ID" ] && [ -f "$STATE_SCRIPT" ]; then
  if [ "$NEW_STATUS" = "done" ]; then
    "$STATE_SCRIPT" event "$(jq -nc --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --arg orch "$ORCH_ID" --arg w "$TICKET_ID" \
      '{ts: $ts, orchestrator: $orch, worker: $w, event: "worker-done", detail: null}')"
  elif [ "$NEW_STATUS" = "failed" ]; then
    "$STATE_SCRIPT" event "$(jq -nc --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --arg orch "$ORCH_ID" --arg w "$TICKET_ID" --arg reason "$ERROR_MSG" \
      '{ts: $ts, orchestrator: $orch, worker: $w, event: "worker-failed", detail: {reason: $reason}}')"
    "$STATE_SCRIPT" attention "$ORCH_ID" "waiting-for-user" "$TICKET_ID" \
      "Worker failed: ${ERROR_MSG}"
  fi
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
| 5 PR created | `pr-created` + `pr.ciStatus: "pending"` |
| 5 CI passes | `pr.ciStatus: "passing"` |
| 5 monitoring | `monitoring` |
| 6 start | `merging` |
| 6 PR merged | `pr.ciStatus: "merged"` + `pr.mergedAt` |
| 6 complete | `done` |
| Any failure | `failed` |

## Workflow Phases

### Phase 1: Research (Current Session — Opus)

This phase runs in the current session to allow user interaction during research.

1. **Parse input**: Determine if ticket ID or freeform query
2. **Register ticket in workflow context (REQUIRED if ticket-based)** — immediately after parsing:
   ```bash
   "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" set-ticket "TICKET-ID"
   ```
   This ensures `.catalyst/.workflow-context.json` exists and `currentTicket` is set before any
   other work begins. Downstream skills and hooks depend on this file existing.
3. **If ticket**: Read ticket details via Linearis CLI, move to `stateMap.research` (default: "In
   Progress")
4. **If freeform (and NOT `--no-ticket`)**: After research completes, offer to create a Linear
   ticket from the findings:
   ```
   Research complete. Would you like to create a Linear ticket from these findings?
   [y/N]
   ```
   If yes, create a ticket via the Linearis CLI (run `linearis issues usage` for create syntax) using the research summary as description,
   then register the ticket ID: `workflow-context.sh set-ticket "NEW-TICKET-ID"`
5. **Conduct research**: Spawn parallel sub-agents (same as `/research-codebase`):
   - **codebase-locator**: Find relevant files
   - **codebase-analyzer**: Understand current implementation
   - **codebase-pattern-finder**: Find similar patterns
   - **thoughts-locator**: Find existing context (if relevant)
   - **external-research**: Research frameworks/libraries (if relevant)
6. **Synthesize findings**: Create research document at
   `thoughts/shared/research/YYYY-MM-DD-{ticket}-{description}.md`
7. **Sync**: `humanlayer thoughts sync`
8. **Track in workflow context (REQUIRED)** — substitute actual path and ticket:
   ```bash
   "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" add research "thoughts/shared/research/YYYY-MM-DD-description.md" "TICKET-ID"
   ```
9. **Verify**: `"${CLAUDE_PLUGIN_ROOT}/scripts/workflow-context.sh" recent research` must print the
   path

### Phase 2: Plan (New Session via `humanlayer launch` — Opus)

Launches a fresh Claude Code session with full context isolation.

```bash
humanlayer launch \
  --model opus \
  --title "plan ${TICKET_ID:-oneshot}" \
  "/catalyst-dev:create-plan thoughts/shared/research/$RESEARCH_DOC"
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
  "/catalyst-dev:implement-plan thoughts/shared/plans/$PLAN_DOC"
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
  "Run /catalyst-dev:validate-plan then run quality gates. Plan: thoughts/shared/plans/$PLAN_DOC"
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

**Step 2: Monitor Through Merge**

After creating/updating the PR, enter a monitoring loop. Do NOT exit until the PR is **actually
merged** or genuinely blocked on human approval. "PR created with auto-merge" is NOT done.

**Minimum 3-minute wait:** CI checks and automated reviewers (Codex, security scanners) need time
to run. Always wait at least 3 minutes from PR creation before even checking status. Then poll
every 30 seconds.

```bash
REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')
MIN_WAIT=180  # 3 minutes — CI and reviewers need time

# Initial wait — do not skip this
sleep $MIN_WAIT

# Poll until merged or human-blocked (max 15 min total)
MAX_WAIT=900
WAITED=$MIN_WAIT
while [ $WAITED -lt $MAX_WAIT ]; do
  # 1. Check PR merge state — the primary exit condition
  PR_STATE=$(gh pr view $PR_NUMBER --json state --jq '.state')
  if [ "$PR_STATE" = "MERGED" ]; then
    echo "✅ PR #${PR_NUMBER} merged"
    break
  fi
  if [ "$PR_STATE" = "CLOSED" ]; then
    echo "PR #${PR_NUMBER} was closed unexpectedly"
    break
  fi

  # 2. Check CI status
  CI_STATUS=$(gh pr checks $PR_NUMBER --json state \
    --jq '[.[].state] | unique | join(",")' 2>/dev/null || echo "PENDING")

  # 3. Check for review comments/threads
  COMMENT_COUNT=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}/comments" --jq 'length')
  REVIEW_COUNT=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}/reviews" \
    --jq '[.[] | select(.state != "APPROVED" and .state != "DISMISSED")] | length')

  echo "Poll @${WAITED}s: state=${PR_STATE} CI=${CI_STATUS} comments=${COMMENT_COUNT} reviews=${REVIEW_COUNT}"

  # 4. Address review comments if any arrived
  if [ "$COMMENT_COUNT" -gt 0 ] || [ "$REVIEW_COUNT" -gt 0 ]; then
    # Run /review-comments, resolve threads via GraphQL, push fixes
    # Then continue polling — auto-merge will proceed once threads resolved
  fi

  # 5. If CI failed, investigate and fix
  if echo "$CI_STATUS" | grep -q "FAILURE"; then
    # Analyze failure logs, fix code, push — then continue polling
  fi

  sleep 30
  WAITED=$((WAITED + 30))
done
```

On each poll cycle, handle what you find:

- **PR state = MERGED** → exit loop, proceed to post-merge cleanup
- **Review comments/threads exist** → address them: run `/review-comments ${PR_NUMBER}`, resolve
  threads via GraphQL, push fixes. Then continue polling — auto-merge will retry once threads
  are resolved and `required_conversation_resolution` is satisfied
- **CI failing** → analyze failure logs, fix code, push, continue polling
- **CI pending** → normal, continue polling
- **Genuinely blocked on human approval** (`review-required` with no other fixable blockers) →
  report what's needed and stop

The agent does NOT need to decide whether to merge. Auto-merge handles that. The agent's job is to
**keep the path clear** (address reviews, fix CI) and **confirm it actually happened**.

If the PR has not merged after 15 minutes of polling, run the full merge blocker diagnosis
(`merge-blocker-diagnosis.md`) to identify exactly what's stuck and report to the user.

**Step 3: Post-Merge Cleanup (only after PR state = MERGED)**

Only execute this step after confirming `PR_STATE = "MERGED"` in the poll loop above.

- Move Linear ticket to `stateMap.done` (default: "Done") via Linearis CLI
- Delete local branch: `git branch -D "$BRANCH" 2>/dev/null || true`
- Update primary worktree: `git -C "$PRIMARY_WORKTREE" pull --rebase 2>/dev/null || true`

**If `--no-merge` was set**, skip the poll loop and report PR status instead:

```
PR ready: https://github.com/org/repo/pull/{number}

Merge state: $mergeStateStatus
  ✅ CI passed
  ✅ Threads resolved ({N} addressed)
  ✅ Reviews addressed
  ❌ Review required — 1 approval needed (if applicable)

Merge later with: /catalyst-dev:merge-pr
```

**Linear**: `/create-pr` moves ticket to `stateMap.inReview` (default: "In Review").

### Phase 6: Merge (Only When Auto-Merge is NOT Armed)

If auto-merge is armed, Phase 5 Step 2's poll loop already confirms merge — skip Phase 6.

If auto-merge is NOT armed (manual merge flow), run merge-pr after the poll loop confirms
a clean merge state:

```
/catalyst-dev:merge-pr
```

**What happens:**

- Runs `/merge-pr` which runs the blocker diagnosis loop (see `merge-blocker-diagnosis.md`) —
  resolves any remaining blockers and only merges when all branch protection requirements are
  satisfied
- If blockers cannot be resolved, reports exactly what's needed and stops
- Moves Linear ticket to `stateMap.done` (default: "Done")

## Team Mode (Optional)

For complex implementations spanning multiple files/layers:

```
/catalyst-dev:oneshot --team PROJ-123
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
  - Lightweight: commit, PR, CI polling, comment resolution
  - Sonnet is sufficient for structured workflow

Phase 6: Merge (same session as Phase 5 — Sonnet)
  - Reuses Phase 5 context (minimal usage)
  - Procedural: verify, merge, cleanup
  - Runs by default (skip with --no-merge)
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
- Suggest running `/catalyst-dev:research-codebase` manually

**If humanlayer launch fails:**

- Fall back to manual workflow:

  ```
  Could not launch new session automatically.

  Please start a new session and run:
    /catalyst-dev:create-plan thoughts/shared/research/$RESEARCH_DOC
  ```

**If implementation fails:**

- Partial work is preserved (uncommitted)
- Handoff document created automatically
- User can resume with `/catalyst-dev:resume-handoff`

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
- User can resume with `/catalyst-dev:resume-handoff`

## Important

- **Phase 1 (research) is interactive** — user can guide the research
- **Phases 2-6 launch separate sessions** — user interacts with each independently
- **thoughts/ is the handoff mechanism** — all documents persist between sessions
- **`humanlayer launch` is required** — no fallback for context isolation
- **NEVER add Claude attribution** to any generated artifacts
- **Use wiki-links** for cross-references between thoughts documents (e.g., `[[filename]]`), not
  full paths
- **Phase 3 does NOT commit** — all git operations are deferred to Phase 5
- **Phase 6 (merge) runs by default** — use `--no-merge` to opt out
- **NEVER stop at "PR created"** — poll every 30s (after 3-min minimum wait) checking CI, reviews,
  and merge state. "PR created with auto-merge" is NOT done — poll until state=MERGED
- **Automated reviewer comments are the agent's job** — Codex, security scanners, and linters post
  code comments that create unresolved threads. These are NOT "needs approving reviewer" — they are
  fixable blockers. Address the feedback, resolve the threads, and continue

**IMPORTANT: Document Storage Rules**

- ALWAYS write to `thoughts/shared/` (research, plans, prs subdirectories)
- NEVER write to `thoughts/searchable/` — this is a read-only search index
