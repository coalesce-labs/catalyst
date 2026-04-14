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

**When worker arms auto-merge** (right before Phase 5 exit), record the arming timestamp:

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

**When CI is observed passing during the settle window**, update signal + global state:

```bash
if [ -f "$SIGNAL_FILE" ]; then
  jq '.pr.ciStatus = "passing"' "$SIGNAL_FILE" > "${SIGNAL_FILE}.tmp" \
    && mv "${SIGNAL_FILE}.tmp" "$SIGNAL_FILE"
fi
if [ -n "$ORCH_ID" ] && [ -f "$STATE_SCRIPT" ]; then
  "$STATE_SCRIPT" worker "$ORCH_ID" "$TICKET_ID" '.pr.ciStatus = "passing"'
fi
```

**When PR is merged**, the signal is written by the ORCHESTRATOR's Phase 4 poll loop (or, in
standalone mode, by `/merge-pr` in the current session) — **not** by the worker. This is
because the worker subprocess reliably exits at its final tool-use, before the merge actually
completes. A worker that writes `mergedAt` is writing a lie. The orchestrator writes both the
signal file and the global state with the authoritative `mergedAt` sourced from
`gh pr view --json mergedAt`:

```bash
# Executed by the orchestrator (NOT the worker) after confirming state=MERGED
PR_MERGED_AT=$(gh -R "$REPO" pr view "$PR_NUMBER" --json mergedAt --jq '.mergedAt')
jq --arg ts "$PR_MERGED_AT" '.pr.ciStatus = "merged" | .pr.mergedAt = $ts | .status = "done"' \
  "$SIGNAL_FILE" > "${SIGNAL_FILE}.tmp" && mv "${SIGNAL_FILE}.tmp" "$SIGNAL_FILE"
"$STATE_SCRIPT" worker "$ORCH_ID" "$TICKET_ID" \
  ".pr.ciStatus = \"merged\" | .pr.mergedAt = \"${PR_MERGED_AT}\" | .status = \"done\""
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
| 5 settle window observed CI pass | `pr.ciStatus: "passing"` |
| 5 worker exit (contract fulfilled) | `pr-created` — terminal state for the worker |
| 6 start (orchestrator or standalone /merge-pr) | `merging` |
| 6 PR merged (written by orchestrator or /merge-pr, never the worker) | `pr.ciStatus: "merged"` + `pr.mergedAt` |
| 6 complete | `done` |
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

**When launching sub-sessions** via `humanlayer launch`, pass CATALYST_SESSION_ID so child
sessions can link back to this parent workflow:

```bash
CATALYST_SESSION_ID="${CATALYST_SESSION_ID:-}" \
humanlayer launch --model opus --title "plan ${TICKET_ID:-oneshot}" \
  "/catalyst-dev:create-plan thoughts/shared/research/$RESEARCH_DOC"
```

Each child skill (create-plan, implement-plan, etc.) will pick up `CATALYST_SESSION_ID` from
the environment and pass it as `--workflow` to their own `catalyst-session start` call,
creating a linked parent-child session tree.

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
CATALYST_SESSION_ID="${CATALYST_SESSION_ID:-}" \
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
- Child session links back to parent via `--workflow` (from inherited `CATALYST_SESSION_ID`)

**User interaction**: The user interacts with the planning session normally. The plan is refined
iteratively until approved.

**Linear**: If ticket exists, move to `stateMap.planning` (default: "In Progress").

### Phase 3: Implement (New Session via `humanlayer launch` — Opus)

After the plan is approved, launches another fresh session:

```bash
CATALYST_SESSION_ID="${CATALYST_SESSION_ID:-}" \
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
CATALYST_SESSION_ID="${CATALYST_SESSION_ID:-}" \
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
CATALYST_SESSION_ID="${CATALYST_SESSION_ID:-}" \
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

**Step 2: Arm Auto-Merge and Clear Blockers (Worker Contract Ends Here)**

The **worker's success contract is**: PR open + auto-merge armed + CI triggered + no unresolved
inline blockers. The worker does NOT poll until the PR is merged — the subprocess running this
session reliably exits on the final tool-use emission regardless of any polling loop, so a
worker-side poll-until-MERGED burns tokens and produces false signals. Poll-until-MERGED is the
**orchestrator's responsibility** (see the orchestrate skill's Phase 4 monitoring loop); for a
standalone (non-orchestrated) oneshot, see the "Standalone merge confirmation" subsection below.

**Worker success criteria** (update signal file with these when satisfied):

| Field                     | Value                                                  |
| ------------------------- | ------------------------------------------------------ |
| `pr.number`               | PR number                                              |
| `pr.url`                  | PR URL                                                 |
| `pr.prOpenedAt`           | ISO timestamp when PR was opened                       |
| `pr.autoMergeArmedAt`     | ISO timestamp when auto-merge was armed (or `null`)    |
| `pr.ciStatus`             | `pending` \| `passing` \| `failing` \| `unknown`       |
| `status`                  | `pr-created` (terminal success for the worker)         |

**Brief settle window** (address immediate inline blockers before exit):

After creating the PR, wait ~3 minutes for CI and automated reviewers (Codex, security scanners)
to post initial results, then do a short pass of blocker resolution. Do NOT loop waiting for
MERGED.

```bash
REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')
PR_NUMBER=<set by /create-pr>
PR_OPENED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Record PR opening in signal file immediately (do not wait for settle window)
jq --arg ts "$PR_OPENED_AT" '.pr.prOpenedAt = $ts | .status = "pr-created"' \
  "$SIGNAL_FILE" > "$SIGNAL_FILE.tmp" && mv "$SIGNAL_FILE.tmp" "$SIGNAL_FILE"

# Arm auto-merge (if not already) and record when
gh pr merge $PR_NUMBER --squash --auto 2>/dev/null || true
ARMED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq --arg ts "$ARMED_AT" '.pr.autoMergeArmedAt = $ts' \
  "$SIGNAL_FILE" > "$SIGNAL_FILE.tmp" && mv "$SIGNAL_FILE.tmp" "$SIGNAL_FILE"

# Short settle window (~3 min) — let CI start, let automated reviewers post first pass
sleep 180

# One pass of blocker resolution (NOT a loop):
CI_STATUS=$(gh pr checks $PR_NUMBER --json state \
  --jq '[.[].state] | unique | join(",")' 2>/dev/null || echo "PENDING")
COMMENT_COUNT=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}/comments" --jq 'length')

# If automated reviewers left inline comments, address and push fixes ONCE.
# Do not loop — the orchestrator will re-queue remediation if more issues appear.
if [ "$COMMENT_COUNT" -gt 0 ]; then
  # Run /review-comments $PR_NUMBER, resolve threads, push
  :
fi

# If CI already failed (not pending), investigate and push one fix attempt.
if echo "$CI_STATUS" | grep -q "FAILURE"; then
  # Analyze failure logs, fix, push
  :
fi

# Record final ciStatus observation in signal file, then EXIT.
jq --arg ci "${CI_STATUS:-pending}" \
  '.pr.ciStatus = (if $ci == "" then "pending" else ($ci | ascii_downcase | sub("success";"passing") | sub("failure";"failing")) end)' \
  "$SIGNAL_FILE" > "$SIGNAL_FILE.tmp" && mv "$SIGNAL_FILE.tmp" "$SIGNAL_FILE"
```

After this, **return control** — the worker has fulfilled its contract. The orchestrator (or the
standalone confirmation fallback below) owns everything from here: polling PR state until MERGED,
transitioning Linear to Done, deleting branches, running teardown hooks.

**Why this split**: subprocesses dispatched via `claude --print` (and even some `humanlayer launch`
configurations) terminate when the model emits its final tool-use, regardless of how the prompt
instructs the model to "keep polling." Any worker-side poll-until-MERGED loop is therefore a
fiction that wastes tokens, produces misleading logs ("waiting for merge" while the process has
already exited), and lets bugs like Codex races go undetected. Moving the long poll to the
orchestrator fixes all four of these.

**Step 3: Standalone Merge Confirmation (non-orchestrated oneshot only)**

If this oneshot session is NOT running under an orchestrator (`CATALYST_ORCHESTRATOR_DIR` unset),
the calling session itself is responsible for confirming merge. Use `/catalyst-dev:merge-pr` —
its blocker-diagnosis loop is designed to run synchronously in the current session and will only
exit when the PR is actually merged or a genuine human-gated blocker is hit.

```bash
if [ -z "${CATALYST_ORCHESTRATOR_DIR:-}" ]; then
  # Standalone mode — we own the long poll
  /catalyst-dev:merge-pr
fi
```

If the orchestrator IS in control (`CATALYST_ORCHESTRATOR_DIR` set), skip this — the orchestrator's
Phase 4 monitoring loop handles polling, merge detection, Linear transition, and teardown.

**If `--no-merge` was set**, skip arming auto-merge and report PR status instead:

```
PR ready: https://github.com/org/repo/pull/{number}

Merge state: $mergeStateStatus
  ✅ CI passed
  ✅ Threads resolved ({N} addressed)
  ✅ Reviews addressed
  ❌ Review required — 1 approval needed (if applicable)

Merge later with: /catalyst-dev:merge-pr
```

**Linear**: `/create-pr` moves ticket to `stateMap.inReview` (default: "In Review"). The
orchestrator (or standalone `/merge-pr`) moves it to `stateMap.done` on merge — the worker does
NOT do this transition itself.

### Phase 6: Merge (Only When Auto-Merge is NOT Armed AND Non-Orchestrated)

When running under an orchestrator, skip Phase 6 entirely — the orchestrator's Phase 4 loop
owns merge confirmation and teardown.

When running standalone (no orchestrator) AND auto-merge is NOT armed, run merge-pr:

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
  - Lightweight: commit, PR, arm auto-merge, short settle window, one pass of blocker resolution
  - Worker exits at "PR open + auto-merge armed + CI triggered" — does NOT poll until MERGED
  - Sonnet is sufficient for structured workflow

Phase 6: Merge (standalone only — Sonnet)
  - Under an orchestrator: skipped (orchestrator's Phase 4 owns merge confirmation)
  - Standalone: runs /merge-pr synchronously (blocker-diagnosis loop polls until merged)
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
| 6 (merged, standalone)             | → done       | `stateMap.done`       | "Done"        |

Under an orchestrator, the orchestrator transitions the ticket to `stateMap.done` when it
observes the PR merged — not the worker.

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

**If humanlayer launch fails:**

- End session with `--status failed`
- Fall back to manual workflow:

  ```
  Could not launch new session automatically.

  Please start a new session and run:
    /catalyst-dev:create-plan thoughts/shared/research/$RESEARCH_DOC
  ```

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

- **Phase 1 (research) is interactive** — user can guide the research
- **Phases 2-6 launch separate sessions** — user interacts with each independently
- **thoughts/ is the handoff mechanism** — all documents persist between sessions
- **`humanlayer launch` is required** — no fallback for context isolation
- **NEVER add Claude attribution** to any generated artifacts
- **Use wiki-links** for cross-references between thoughts documents (e.g., `[[filename]]`), not
  full paths
- **Phase 3 does NOT commit** — all git operations are deferred to Phase 5
- **Phase 6 (merge) runs only in standalone mode** — under an orchestrator it is skipped;
  use `--no-merge` (standalone) to opt out of the final merge
- **Worker's success contract ends at "PR open + auto-merge armed + CI triggered"** — poll-until-
  MERGED is the orchestrator's job (orchestrate Phase 4) or, in standalone mode, `/merge-pr`'s
  blocker-diagnosis loop. The worker subprocess reliably exits on its final tool-use regardless
  of polling language in the prompt, so a worker-side long poll produces false signals
- **Automated reviewer comments are still the worker's job on its one settle-window pass** —
  Codex, security scanners, and linters post inline comments that create unresolved threads.
  On the short settle pass, address what's already posted. Further rounds of remediation are
  handled by the orchestrator (it can re-dispatch the worker with remediation instructions)

**IMPORTANT: Document Storage Rules**

- ALWAYS write to `thoughts/shared/` (research, plans, prs subdirectories)
- NEVER write to `thoughts/searchable/` — this is a read-only search index
