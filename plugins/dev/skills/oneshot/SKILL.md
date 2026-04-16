---
name: oneshot
description:
  "End-to-end autonomous workflow — research, plan, implement, validate, ship, and merge in one
  command. **ALWAYS use when** the user says 'oneshot', 'do everything end to end', 'full workflow',
  or wants to go from ticket/idea to merged PR autonomously. All phases run sequentially in the
  current session, using agent teams for parallelism when needed."
disable-model-invocation: true
allowed-tools:
  Read, Write, Bash, Task, Grep, Glob, mcp__deepwiki__ask_question,
  mcp__deepwiki__read_wiki_structure
version: 3.0.0
---

# Oneshot

End-to-end autonomous workflow that chains research → plan → implement → validate → ship → merge
in a single session. All phases run sequentially in the current Claude Code session, invoking
skills directly. Context is managed naturally via Claude's automatic compaction, and the
thoughts/ system provides persistent handoff documents between phases.

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
| `--label <text>`       | Custom display label for the session (overrides auto-derived) |
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
3. **Derives and writes `label`** to the signal file at startup (see Label Derivation below)
4. **Emits events** to the global event log at each phase transition
5. **Fills `definitionOfDone`** at Phase 4 (validation) and Phase 5 (ship) with actual results
6. **Reads wave briefing** if referenced in `${ORCH_DIR}/wave-*-briefing.md` before starting

**Label Derivation** (at startup, before first phase transition):

The `label` field in the signal file gives the session a human-readable display name. It is
derived automatically unless overridden with `--label`:

```bash
# If --label flag was provided, use it directly
if [ -n "$USER_LABEL" ]; then
  LABEL="$USER_LABEL"
else
  # Auto-derive: "<skill> <ticket>"
  SKILL_NAME="oneshot"   # or the current skill name
  LABEL="${SKILL_NAME} ${TICKET_ID}"
fi

# Write to signal file (once, at startup)
if [ -f "$SIGNAL_FILE" ]; then
  jq --arg label "$LABEL" '.label = $label' "$SIGNAL_FILE" > "${SIGNAL_FILE}.tmp" \
    && mv "${SIGNAL_FILE}.tmp" "$SIGNAL_FILE"
fi
```

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

**When worker creates a PR**, also update global state with PR details. Record
`prOpenedAt` immediately so the dashboard can show how long the PR has been open
separately from how long it took to merge:

```bash
PR_OPENED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ -n "$ORCH_ID" ] && [ -f "$STATE_SCRIPT" ]; then
  "$STATE_SCRIPT" worker "$ORCH_ID" "$TICKET_ID" \
    ".pr = {number: ${PR_NUMBER}, url: \"${PR_URL}\", ciStatus: \"pending\", prOpenedAt: \"${PR_OPENED_AT}\", autoMergeArmedAt: null, mergedAt: null}"
  "$STATE_SCRIPT" event "$(jq -nc \
    --arg ts "$PR_OPENED_AT" \
    --arg orch "$ORCH_ID" --arg w "$TICKET_ID" \
    --argjson pr "$PR_NUMBER" --arg url "$PR_URL" \
    '{ts: $ts, orchestrator: $orch, worker: $w, event: "worker-pr-created", detail: {pr: $pr, url: $url}}')"
fi
```

**When worker arms auto-merge** (right after PR open, before entering the poll loop), record the arming timestamp:

```bash
AUTO_MERGE_ARMED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ -f "$SIGNAL_FILE" ]; then
  jq --arg ts "$AUTO_MERGE_ARMED_AT" '.pr.autoMergeArmedAt = $ts' \
    "$SIGNAL_FILE" > "${SIGNAL_FILE}.tmp" && mv "${SIGNAL_FILE}.tmp" "$SIGNAL_FILE"
fi
if [ -n "$ORCH_ID" ] && [ -f "$STATE_SCRIPT" ]; then
  "$STATE_SCRIPT" worker "$ORCH_ID" "$TICKET_ID" \
    ".pr.autoMergeArmedAt = \"${AUTO_MERGE_ARMED_AT}\""
fi
```

**When CI is observed passing during the merge poll loop**, update signal + global state:

```bash
if [ -f "$SIGNAL_FILE" ]; then
  jq '.pr.ciStatus = "passing"' "$SIGNAL_FILE" > "${SIGNAL_FILE}.tmp" \
    && mv "${SIGNAL_FILE}.tmp" "$SIGNAL_FILE"
fi
if [ -n "$ORCH_ID" ] && [ -f "$STATE_SCRIPT" ]; then
  "$STATE_SCRIPT" worker "$ORCH_ID" "$TICKET_ID" '.pr.ciStatus = "passing"'
fi
```

**When PR is merged**, the WORKER writes the signal — the worker is responsible for polling
`gh pr view --json state,mergedAt` until `state=MERGED` and only then writing `pr.mergedAt`
and `status=done`. The orchestrator's poll loop is a safety net for stalled workers, not the
primary merge confirmation. The authoritative `mergedAt` is sourced from `gh pr view --json
mergedAt`:

```bash
# Executed by the WORKER after its poll loop confirms state=MERGED
PR_MERGED_AT=$(gh -R "$REPO" pr view "$PR_NUMBER" --json mergedAt --jq '.mergedAt')
jq --arg ts "$PR_MERGED_AT" '.pr.ciStatus = "merged" | .pr.mergedAt = $ts | .status = "done"' \
  "$SIGNAL_FILE" > "${SIGNAL_FILE}.tmp" && mv "${SIGNAL_FILE}.tmp" "$SIGNAL_FILE"
if [ -n "$ORCH_ID" ] && [ -f "$STATE_SCRIPT" ]; then
  "$STATE_SCRIPT" worker "$ORCH_ID" "$TICKET_ID" \
    ".pr.ciStatus = \"merged\" | .pr.mergedAt = \"${PR_MERGED_AT}\" | .status = \"done\""
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
| 5 PR opened | `pr-created` + `pr.prOpenedAt` + `pr.ciStatus: "pending"` |
| 5 auto-merge armed | `pr-created` + `pr.autoMergeArmedAt` |
| 5 poll loop observed CI pass | `pr.ciStatus: "passing"` |
| 5 poll loop entered (waiting on merge) | `merging` |
| 5 PR merged (written by the worker after `gh pr view` returns state=MERGED) | `pr.ciStatus: "merged"` + `pr.mergedAt` + `status: "done"` |
| Any failure | `failed` |

## Session Tracking

Start a catalyst-session at the very beginning of the workflow, before Phase 1. This session
spans the entire oneshot lifecycle and records phase transitions, PR creation, and completion.

```bash
SESSION_SCRIPT="${CLAUDE_PLUGIN_ROOT}/scripts/catalyst-session.sh"
if [[ -x "$SESSION_SCRIPT" ]]; then
  CATALYST_SESSION_ID=$("$SESSION_SCRIPT" start --skill "oneshot" \
    --ticket "${TICKET_ID:-}" \
    --workflow "${CATALYST_SESSION_ID:-}")
  export CATALYST_SESSION_ID
fi
```

**At each phase transition**, call BOTH the signal file update helper (above) AND the session
phase call. The session phase call is additive — it never replaces the signal file write:

```bash
if [[ -n "${CATALYST_SESSION_ID:-}" && -x "$SESSION_SCRIPT" ]]; then
  "$SESSION_SCRIPT" phase "$CATALYST_SESSION_ID" "$NEW_STATUS" --phase "$PHASE_NUM"
fi
```

**When a PR is created** (Phase 5), record it in the session:

```bash
if [[ -n "${CATALYST_SESSION_ID:-}" && -x "$SESSION_SCRIPT" ]]; then
  "$SESSION_SCRIPT" pr "$CATALYST_SESSION_ID" --number "$PR_NUMBER" --url "$PR_URL"
fi
```

**At terminal states** (done or failed), end the session:

```bash
if [[ -n "${CATALYST_SESSION_ID:-}" && -x "$SESSION_SCRIPT" ]]; then
  "$SESSION_SCRIPT" end "$CATALYST_SESSION_ID" --status done  # or --status failed
fi
```

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
5. **Conduct research** — follow the `/catalyst-dev:research-codebase` process exactly. This is the
   single source of truth for how codebase research works (including DeepWiki orientation, sub-agent
   spawning, synthesis, and document creation). The research document MUST be written to
   `thoughts/shared/research/` and tracked in workflow context before proceeding to Phase 2.

### Phase 2: Plan (Current Session)

Runs `/catalyst-dev:create-plan` directly in the current session.

```
/catalyst-dev:create-plan thoughts/shared/research/$RESEARCH_DOC
```

**What happens:**

- Reads research document from thoughts/
- Runs `/create-plan` interactively with the user
- Creates plan at `thoughts/shared/plans/YYYY-MM-DD-{ticket}-{description}.md`
- Syncs thoughts automatically

**User interaction**: The user interacts with the planning session normally. The plan is refined
iteratively until approved.

**Linear**: If ticket exists, move to `stateMap.planning` (default: "In Progress").

### Phase 3: Implement (Current Session)

After the plan is approved, runs implementation directly:

```
/catalyst-dev:implement-plan thoughts/shared/plans/$PLAN_DOC
```

**What happens:**

- Reads plan document from thoughts/
- Runs `/implement-plan` with full capabilities — follows TDD (tests written before implementation
  per phase)
- Can spawn agent teams for complex multi-file implementations (see --team mode)
- **Does NOT commit or create PR** — deferred to Phase 5

**Linear**: If ticket exists, move to `stateMap.inProgress` (default: "In Progress").

### Phase 4: Validate + Quality Gates (Current Session)

**Skip this phase entirely with `--skip-validation`.**

Runs validation and quality enforcement directly:

```
/catalyst-dev:validate-plan thoughts/shared/plans/$PLAN_DOC
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

### Phase 5: Ship (Current Session)

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

**Step 2: Arm Auto-Merge, Record PR Open, Begin Poll Loop**

After `/create-pr` succeeds, immediately record the PR-open timestamp, optionally arm
`gh pr merge --auto --squash --delete-branch`, then enter the **poll-until-merged loop** in
Step 3. The worker does NOT exit until `gh pr view` returns `state=MERGED` with a real
`mergedAt`.

```bash
REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')
PR_NUMBER=<set by /create-pr>
PR_OPENED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Record PR opening in signal file immediately
jq --arg ts "$PR_OPENED_AT" '.pr.prOpenedAt = $ts | .status = "pr-created"' \
  "$SIGNAL_FILE" > "$SIGNAL_FILE.tmp" && mv "$SIGNAL_FILE.tmp" "$SIGNAL_FILE"

# Arm auto-merge (unless --no-merge was set)
if [ -z "$NO_MERGE" ]; then
  gh pr merge $PR_NUMBER --squash --auto --delete-branch 2>/dev/null || true
  ARMED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  jq --arg ts "$ARMED_AT" '.pr.autoMergeArmedAt = $ts' \
    "$SIGNAL_FILE" > "$SIGNAL_FILE.tmp" && mv "$SIGNAL_FILE.tmp" "$SIGNAL_FILE"
fi
```

**Step 3: Poll Until Merged (Worker Contract — `state=MERGED` Required Before Exit)**

The **worker's success contract** is: `gh pr view --json state` returns `MERGED` and the worker
has written `pr.mergedAt` + `status: "done"` to its signal file. Auto-merge alone is not the
contract — auto-merge fails silently in many real scenarios (branch BEHIND main, CI failure
after rebase, repos with `allow_update_branch: false`, blocking review threads, merge conflicts).
The worker is responsible for diagnosing and resolving those blockers itself.

Transition signal status to `merging` and enter the poll loop:

```bash
# Transition signal to merging
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq --arg ts "$TS" '.status = "merging" | .phase = 5 | .updatedAt = $ts | .phaseTimestamps.merging = $ts' \
  "$SIGNAL_FILE" > "$SIGNAL_FILE.tmp" && mv "$SIGNAL_FILE.tmp" "$SIGNAL_FILE"
```

Poll cadence: every 30–60 seconds. On every iteration:

1. **Check merge state**:
   ```bash
   PR_STATE=$(gh pr view $PR_NUMBER --json state,mergeStateStatus,mergedAt)
   STATE=$(echo "$PR_STATE" | jq -r '.state')
   MERGE_STATE=$(echo "$PR_STATE" | jq -r '.mergeStateStatus')
   MERGED_AT=$(echo "$PR_STATE" | jq -r '.mergedAt')
   ```

2. **If `state == MERGED`**: write `pr.mergedAt`, `pr.ciStatus = "merged"`, `status = "done"` to
   signal + global state, then exit successfully. This is the only successful exit path.

3. **If `mergeStateStatus == BEHIND`**: the branch is behind base. Many repos disable GitHub's
   auto-update (`allow_update_branch: false`), so the worker must update the branch itself:
   ```bash
   gh api -X PUT "repos/${REPO}/pulls/${PR_NUMBER}/update-branch" 2>&1 | head -5
   ```
   After update-branch returns, CI will re-run on the new commit. Continue polling.

4. **If CI is failing** (mergeStateStatus `UNSTABLE`, `BLOCKED`, or any check `conclusion=failure`):
   investigate the failure, push a fix, continue polling. Apply the same auto-fix budget as the
   create-pr/CI handling above (max 3 distinct fix attempts per failure type).

5. **If review comments / Codex threads have appeared**: address them via `/review-comments`
   (resolve threads, push fixes), continue polling. The worker keeps doing this — there is no
   "one settle pass" cap; if more comments arrive after the first pass, address them too.

6. **If `mergeStateStatus == DIRTY`** (merge conflicts): attempt `gh pr checkout && git fetch &&
   git rebase origin/<base>` and resolve mechanically when possible. If conflicts cannot be
   resolved automatically, write `status: "stalled"` with a clear message and exit non-success —
   this is a genuine human-gated blocker.

7. **If `mergeStateStatus == BLOCKED` and the only remaining requirement is human review** (no
   approvals available to the worker), write `status: "stalled"` with details of which approval
   is missing and exit non-success.

8. **Otherwise** (PENDING, HAS_HOOKS, UNKNOWN, hooks-pending, etc.): wait one cadence cycle and
   re-poll.

**Maximum wait**: there is no fixed timeout — the worker polls indefinitely while CI/checks are
still progressing. Exit non-success only when a genuine human-gated blocker is identified
(unresolvable conflict, required reviewer not the worker, branch protection requirement that
cannot be satisfied).

**On successful merge**, after writing the merged signal, run the post-merge cleanup that
`/merge-pr` does (or invoke `/merge-pr` to do it): pull latest base, delete local branch, move
Linear ticket to `stateMap.done`, save post-merge tasks. The orchestrator's Phase 4 loop is now a
safety net that can re-dispatch a fix-up worker if the primary worker gets stuck.

**If `--no-merge` was set**, skip Steps 2–3 entirely and report PR status instead:

```
PR ready: https://github.com/org/repo/pull/{number}

Merge state: $mergeStateStatus
  ✅ CI passed
  ✅ Threads resolved ({N} addressed)
  ✅ Reviews addressed
  ❌ Review required — 1 approval needed (if applicable)

Merge later with: /catalyst-dev:merge-pr
```

**Linear**: `/create-pr` moves ticket to `stateMap.inReview` (default: "In Review"). The worker
moves it to `stateMap.done` itself when its poll loop confirms `state=MERGED`.

### Phase 6: (deprecated)

Phase 6 used to run `/merge-pr` separately. The poll-until-merged loop is now part of Phase 5
Step 3 and runs in every oneshot invocation (orchestrated and standalone alike), unless
`--no-merge` was set. The worker does not exit until the PR is merged or a genuine human-gated
blocker is hit. `/merge-pr` is still useful as a standalone tool for merging an existing PR
opened outside the oneshot flow, and oneshot may invoke it from Step 3 to handle post-merge
cleanup; it is no longer a separate phase.

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

## Context Management Strategy

All phases run in a single session. Context is managed through:

1. **Automatic compaction** — Claude Code compresses prior messages as the conversation approaches
   context limits. This happens transparently and allows long-running workflows.
2. **Thoughts as persistent handoff** — Each phase writes its output to `thoughts/shared/` (research
   documents, plans). Subsequent phases read these files, so the essential information is always
   available even after compaction.
3. **Agent teams for parallelism** — When a phase needs to do parallel work (research sub-agents,
   team-mode implementation), it spawns Agent subagents. Each subagent gets its own context window
   and returns a summary, keeping the main session's context lean.

```
Phase 1: Research — spawns parallel sub-agents, writes to thoughts/shared/research/
Phase 2: Plan — reads research doc, runs /create-plan, writes to thoughts/shared/plans/
Phase 3: Implement — reads plan doc, runs /implement-plan (can use --team for agent teams)
Phase 4: Validate — reads plan doc, runs /validate-plan + quality gates
Phase 5: Ship — runs /create-pr, arms auto-merge, polls gh pr view until state=MERGED,
         resolves BEHIND/CI/review blockers along the way, writes pr.mergedAt to signal
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

### Model Selection

All phases run in the current session using whatever model the session was started with. When
running as an orchestrator worker, the model is set by the orchestrator's `workerModel` config
(default: Opus).

## Linear Integration

State transitions throughout the lifecycle:

| Phase                              | Transition   | Config Key            | Default       |
| ---------------------------------- | ------------ | --------------------- | ------------- |
| 1 start                            | → research   | `stateMap.research`   | "In Progress" |
| 1 end (ticket created in freeform) | → backlog    | `stateMap.backlog`    | "Backlog"     |
| 2 start                            | → planning   | `stateMap.planning`   | "In Progress" |
| 3 start                            | → inProgress | `stateMap.inProgress` | "In Progress" |
| 5 (PR created)                     | → inReview   | `stateMap.inReview`   | "In Review"   |
| 5 (PR merged, written by worker)   | → done       | `stateMap.done`       | "Done"        |

The worker transitions the ticket to `stateMap.done` itself when its poll loop confirms
`state=MERGED`. The orchestrator's poll loop is a safety net: if the worker stalls before
recording mergedAt, the orchestrator can detect a merged PR and reconcile state, but the worker
is the primary recorder.

## Error Handling

**All error paths must end the session.** Before presenting errors or creating handoffs, always
run:

```bash
if [[ -n "${CATALYST_SESSION_ID:-}" && -x "$SESSION_SCRIPT" ]]; then
  "$SESSION_SCRIPT" end "$CATALYST_SESSION_ID" --status failed
fi
```

**If research phase fails:**

- End session with `--status failed`
- Save partial findings to thoughts/
- Present error to user
- Suggest running `/catalyst-dev:research-codebase` manually

**If implementation fails:**

- End session with `--status failed`
- Partial work is preserved (uncommitted)
- Handoff document created automatically
- User can resume with `/catalyst-dev:resume-handoff`

**If quality gates fail after max retries:**

- Present failures with options (fix, continue, handoff)
- If user continues, gates are marked as skipped in PR description
- If user creates handoff, end session with `--status failed`, remaining phases are documented for
  next session

**If CI checks fail in Phase 5:**

- Auto-fix up to 3 attempts (analyze errors, fix, push, re-poll)
- After max attempts, present failures with options (fix manually, continue, handoff)
- Do not auto-merge if CI is red

**Automatic handoff on stop:** When the workflow stops at any phase (user choice, unrecoverable
error, context exhaustion):

- End session with `--status failed`
- Invoke `/create-handoff` with: phases completed, current phase status, unresolved issues,
  CI/review status, and remaining phases
- Save handoff to `thoughts/shared/handoffs/`
- User can resume with `/catalyst-dev:resume-handoff`

## Important

- **All phases run in the current session** — no separate processes are spawned
- **thoughts/ is the handoff mechanism** — all documents persist between phases and survive compaction
- **NEVER add Claude attribution** to any generated artifacts
- **Use wiki-links** for cross-references between thoughts documents (e.g., `[[filename]]`), not
  full paths
- **Phase 3 does NOT commit** — all git operations are deferred to Phase 5
- **Worker's success contract is `state=MERGED`** — the worker polls
  `gh pr view --json state,mergeStateStatus,mergedAt` every 30–60s and only exits successfully
  when `state == "MERGED"` and it has written `pr.mergedAt` + `status: "done"` to its signal
  file. Auto-merge alone is not the contract — auto-merge fails silently (BEHIND main, CI failure
  after rebase, blocking review threads, repos with `allow_update_branch: false`); the worker
  resolves those blockers itself in the poll loop
- **Worker handles BEHIND by calling `gh api PUT /repos/{owner}/{repo}/pulls/{number}/update-branch`**
  — many repos disable GitHub's auto-update, so auto-merge alone leaves PRs stuck. The worker
  rebases via the API and continues polling
- **Worker keeps resolving review comments and CI failures throughout the poll loop**, not just
  in a one-shot settle window. Codex / security scanners / human reviewers may post comments
  minutes after PR open or after a push; the worker addresses each new round and pushes fixes
- **Worker exits non-success only on genuine human-gated blockers** — unresolvable merge
  conflicts, required reviewer that the worker cannot satisfy, branch protection rule that
  cannot be met. In those cases write `status: "stalled"` with details
- **Orchestrator poll loop is now a safety net, not the primary merge confirmation** — if the
  worker reliably writes `pr.mergedAt`, the orchestrator's poll loop is reconciliation only.
  The orchestrator may still re-dispatch a fix-up worker if the primary worker exits stalled

**IMPORTANT: Document Storage Rules**

- ALWAYS write to `thoughts/shared/` (research, plans, prs subdirectories)
- NEVER write to `thoughts/searchable/` — this is a read-only search index
