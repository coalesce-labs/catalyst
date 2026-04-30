---
name: oneshot
description:
  "End-to-end autonomous workflow — research, plan, implement, validate, ship, and merge in one
  command. **ALWAYS use when** the user says 'oneshot', 'do everything end to end', 'full workflow',
  or wants to go from ticket/idea to merged PR autonomously. All phases run sequentially in the
  current session, using agent teams for parallelism when needed."
disable-model-invocation: false
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

**Shared comms channel (CTL-111):** if `CATALYST_COMMS_CHANNEL` is set by the orchestrator, the
worker joins the shared channel and will post real traffic at each lifecycle boundary.
Best-effort — every call is wrapped so a missing `catalyst-comms` CLI never crashes the worker.
The worker posts at **minimum 4 messages** per run: start + phase transitions + done.

```bash
# Resolve the catalyst-comms binary. Prefer the plugin-shipped copy so installs
# where `catalyst-comms` is only a shell alias (which doesn't propagate to
# subshells) still work. Fall back to PATH for users who have symlinked it.
COMMS_BIN="${CLAUDE_PLUGIN_ROOT:-}/scripts/catalyst-comms"
[ -x "$COMMS_BIN" ] || COMMS_BIN="$(command -v catalyst-comms 2>/dev/null || true)"
if [ -z "$COMMS_BIN" ] || [ ! -x "$COMMS_BIN" ]; then
  echo "warn: catalyst-comms not found — worker comms disabled" >&2
  COMMS_BIN=""
fi

# Helper — called at every hook point below. Silent no-op when comms is unavailable.
comms_post() {
  local type="$1" body="$2"
  [ -z "${CATALYST_COMMS_CHANNEL:-}" ] && return 0
  [ -n "$COMMS_BIN" ] || return 0
  "$COMMS_BIN" send "$CATALYST_COMMS_CHANNEL" "$body" \
    --as "$TICKET_ID" --type "$type" >/dev/null 2>&1 || true
}

# Once, at startup — right after orchestrator mode detection:
if [ -n "${CATALYST_COMMS_CHANNEL:-}" ] && [ -n "$COMMS_BIN" ]; then
  "$COMMS_BIN" join "$CATALYST_COMMS_CHANNEL" \
    --as "$TICKET_ID" \
    --capabilities "oneshot: ${TICKET_ID}" \
    --orch "${CATALYST_ORCHESTRATOR_ID:-}" \
    --parent orchestrator \
    --ttl 3600 >/dev/null 2>&1 || true
  comms_post info "started oneshot for $TICKET_ID"
fi
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

  # CTL-111: announce phase transition to shared comms channel. Runs 5× in the
  # normal path (researching → planning → implementing → validating → shipping),
  # comfortably above the ≥2-transition floor.
  comms_post info "${OLD_STATUS} → ${NEW_STATUS}"
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
# CTL-111: announce PR opening on the shared comms channel
comms_post info "pr:#${PR_NUMBER} opened"
```

**When worker arms auto-merge** (right after PR open, before exiting), record the arming timestamp:

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

**When PR is merged** (CTL-133: written by the orchestrator poll loop, not the worker):

The worker exits after arming auto-merge and writing `status: "merging"`. The **orchestrator's
Phase 4 poll loop** is the authoritative merge watcher — it detects `state=MERGED` via
`gh pr view`, writes `pr.mergedAt` + `status: "done"` to the signal file, and transitions the
Linear ticket. See `/orchestrate` skill Phase 4 for the implementation.

If running standalone (no orchestrator), the worker falls back to post-PR-creation behavior:
arm auto-merge, report status, and exit. The user can later run `/catalyst-dev:merge-pr` to
confirm and record the merge.

**When worker reaches terminal state** (done or failed):

**Mandatory `attention` on block** (per [[catalyst-comms]] § Posting Discipline §3): in
addition to the failure path below, the worker MUST also `comms_post attention "<reason>"`
when it hits any of the following mid-flight, even if it is not yet writing
`status: "failed"`:

- scope conflict with a sibling worker
- missing required access (CLI / credential / API)
- ambiguous spec the worker cannot resolve unilaterally
- same test/CI failure 3+ times after distinct fix attempts
- writing `status: "stalled"` (any phase)

Use a single `attention` per blocker (do not retry). Continue with whatever work is still
possible, or exit if the blocker is total. The orchestrator's poll loop will promote the
message to a state-level NEEDS ATTENTION item.

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
    # CTL-111: post attention on shared comms channel so sibling workers / orchestrator
    # monitoring loop can observe the blocker without reading the state file.
    comms_post attention "worker failed: ${ERROR_MSG:-unknown}"
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
| 5 worker exits after arming auto-merge | `merging` (terminal worker status) |
| 5 PR merged (written by orchestrator poll loop) | `pr.ciStatus: "merged"` + `pr.mergedAt` + `status: "done"` |
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

**Iteration counter** (see CTL-158): bump `--kind plan` whenever the plan is re-entered
(validate-plan kicks back to create-plan) and `--kind fix` whenever an automated fix retry runs
in Phase 4 (quality gates) or Phase 5 (CI auto-fix). The counts are flushed to OTLP as
`claude_code_iteration_count_total{linear_key,kind}` at session end so downstream estimation can
read rework signal per ticket:

```bash
if [[ -n "${CATALYST_SESSION_ID:-}" && -x "$SESSION_SCRIPT" ]]; then
  "$SESSION_SCRIPT" iteration "$CATALYST_SESSION_ID" --kind fix   # or --kind plan
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
     - After the fix attempt (pass OR fail), bump the iteration counter:
       catalyst-session.sh iteration "$CATALYST_SESSION_ID" --kind fix
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

**Step 2: Arm Auto-Merge, Record PR Open, Transition to Merging**

After `/create-pr` succeeds, immediately record the PR-open timestamp, optionally arm
`gh pr merge --auto --squash --delete-branch`, then transition the signal to `merging` and
proceed to Step 3 (exit). The orchestrator's Phase 4 poll loop handles merge confirmation.

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

**Step 3: Worker Exit (Orchestrator Takes Over) — CTL-133**

The worker's contract ends at `status: "merging"`. After arming auto-merge and recording the
signal, the worker exits successfully. The **orchestrator's Phase 4 poll loop** is the
authoritative merge watcher — it polls `gh pr view --json state,mergeStateStatus,mergedAt`,
writes `pr.mergedAt` + `status: "done"` to the signal file, and handles BEHIND/DIRTY/BLOCKED
states via `orchestrate-revive` and `orchestrate-auto-fixup`.

Transition signal status to `merging` and exit:

```bash
# Transition signal to merging (terminal worker status)
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq --arg ts "$TS" '.status = "merging" | .phase = 5 | .updatedAt = $ts | .phaseTimestamps.merging = $ts' \
  "$SIGNAL_FILE" > "$SIGNAL_FILE.tmp" && mv "$SIGNAL_FILE.tmp" "$SIGNAL_FILE"
```

**Why workers don't poll (CTL-133):** Workers dispatched via `claude -p` run one conversation
turn and exit. `ScheduleWakeup` only fires in `/loop` dynamic mode — in `-p` mode it silently
no-ops, causing false-positive worker deaths. The orchestrator's poll loop + `orchestrate-revive`
(default budget: 10) handles merge confirmation, BEHIND rebases, CI fix-ups, and review-thread
resolution by reviving workers when remediation is needed.

**Standalone mode** (no orchestrator): the worker arms auto-merge and reports PR status. The
user can later run `/catalyst-dev:merge-pr` to confirm the merge and run post-merge cleanup.

**Step 4: Optional Rollup Fragment Contribution (CTL-108)**

Before exiting, under orchestrator mode only (`ORCH_DIR` set), the worker MAY write a
short markdown fragment describing anything surprising, risky, or worth flagging to human
reviewers of the whole orchestrator's output:

```bash
if [ -n "$ORCH_DIR" ] && [ -d "$ORCH_DIR/workers" ]; then
  FRAGMENT_PATH="${ORCH_DIR}/workers/${TICKET_ID}-rollup.md"
  # Write a short note — first line is the one-liner used in the rollup "what shipped" list.
  cat > "$FRAGMENT_PATH" <<EOF
One-sentence summary of what shipped and any reviewer heads-up.

Additional context, migration notes, follow-up tickets, etc.
EOF
fi
```

- **File name**: MUST match `${TICKET_ID}-rollup.md` exactly — the orch-monitor scans for this
  pattern to assemble the orchestrator-level rollup briefing.
- **Content**: keep it short. The first non-blank line becomes the one-liner in the "What
  shipped" list in the orch-monitor UI. The rest appears under a `### ${TICKET_ID}` heading in
  the "Gotchas" section.
- **Optional**: skip the fragment if there is nothing reviewers need to know beyond the PR
  title — not having a fragment is the norm, not the exception.
- **No orchestrator mode**: do nothing (standalone oneshot runs do not write fragments).

The orchestrator's Phase 4 poll loop transitions the Linear ticket to `stateMap.done` when it
confirms `state=MERGED` via the shared helper (CTL-69):

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/linear-transition.sh" \
  --ticket "$TICKET_ID" --transition done --config .catalyst/config.json
```

In standalone mode (no orchestrator), the user runs `/catalyst-dev:merge-pr` which handles
this transition.

**Step 5: File improvement findings (CTL-176 / CTL-183 routing)**

Drain the findings queue and file one ticket per entry. Orchestrator-dispatched oneshot runs
share the orchestrator's queue (`$CATALYST_FINDINGS_FILE=$ORCH_DIR/findings.jsonl`) and the
orchestrator's Phase 7 files everything — this step is still safe to run and will find an
empty queue in that case. Standalone oneshot runs (no orchestrator) use a session-scoped
queue path derived from `$CATALYST_SESSION_ID`, falling back to `.catalyst/findings/current.jsonl`.

**Recording findings during the run.** The moment you notice friction worth fixing (workflow
gaps, bugs spotted in adjacent code, recurring manual steps), record it on the queue:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/add-finding.sh" \
  --title "Short imperative title" \
  --body "Reproduction + expected + observed + any links" \
  --skill oneshot --severity low
```

Record inline, not as a post-run retrospective — context compaction loses observations that
wait. Don't prompt the user; don't batch. Step 5 below files the whole queue in one pass.

**What counts:** friction the maintainer would want fixed, bugs in adjacent catalyst code
spotted incidentally, gaps in tooling, manual steps that should be automated.
**What doesn't:** this ticket's own follow-up TODOs (PR body), user preferences that should
be durable memory, routine debugging. In orchestrator-dispatched workers, stdin is not a TTY
and `CATALYST_AUTONOMOUS=1` is expected to be set — the helper silently skips filing when
consent is not already granted, never prompts. Standalone oneshot runs prompt interactively
once and persist "yes":

```bash
FEEDBACK="${CLAUDE_PLUGIN_ROOT}/scripts/file-feedback.sh"
CONSENT="${CLAUDE_PLUGIN_ROOT}/scripts/feedback-consent.sh"
FINDINGS_FILE="${CATALYST_FINDINGS_FILE:-.catalyst/findings/${CATALYST_SESSION_ID:-current}.jsonl}"

if [ -x "$FEEDBACK" ] && [ -f "$FINDINGS_FILE" ] && [ -s "$FINDINGS_FILE" ]; then
  COUNT=$(wc -l < "$FINDINGS_FILE" | tr -d ' ')
  if [ "$("$CONSENT" check)" != "granted" ] && [ -z "${CATALYST_AUTONOMOUS:-}" ] && [ -t 0 ]; then
    read -r -p "File $COUNT improvement tickets at end of run? [Y/n] " yn
    case "$yn" in [Nn]*) : ;; *) "$CONSENT" grant >/dev/null ;; esac
  fi
  if [ "$("$CONSENT" check)" = "granted" ]; then
    FILED=0
    while IFS= read -r line; do
      TITLE=$(jq -r '.title' <<<"$line")
      BODY=$(jq -r '.body' <<<"$line")
      SKILL=$(jq -r '.skill // "oneshot"' <<<"$line")
      RESULT=$("$FEEDBACK" --title "$TITLE" --body "$BODY" --skill "$SKILL" --json 2>/dev/null || true)
      STATUS=$(jq -r '.status // "failed"' <<<"$RESULT")
      if [ "$STATUS" = "filed" ]; then
        ID=$(jq -r '.identifier // .url // ""' <<<"$RESULT")
        echo "  filed: $ID  ($TITLE)"
        FILED=$((FILED + 1))
      fi
    done < "$FINDINGS_FILE"
    [ "$FILED" -eq "$COUNT" ] && rm -f "$FINDINGS_FILE"
  fi
fi
```

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

**Linear**: `/create-pr` moves ticket to `stateMap.inReview` (default: "In Review"). The
orchestrator's Phase 4 poll loop moves it to `stateMap.done` when it confirms `state=MERGED`.

### Phase 6: (deprecated)

Phase 6 used to run `/merge-pr` separately. Workers now exit at `status: "merging"` after
arming auto-merge (CTL-133). The orchestrator's Phase 4 poll loop is the authoritative merge
watcher. `/merge-pr` is still useful as a standalone tool for merging an existing PR opened
outside the oneshot flow, or in standalone (non-orchestrated) runs.

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
Phase 5: Ship — runs /create-pr, arms auto-merge, writes status=merging, exits.
         Orchestrator Phase 4 poll loop handles merge confirmation + blocker resolution
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
| 5 (PR merged, written by orchestrator) | → done   | `stateMap.done`       | "Done"        |

The orchestrator's Phase 4 poll loop is the authoritative merge watcher. It transitions the
ticket to `stateMap.done` when it confirms `state=MERGED` via `gh pr view`. Workers exit at
`status: "merging"` after arming auto-merge (CTL-133).

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

- Worker does not poll for CI — it arms auto-merge and exits at `status: "merging"`
- The orchestrator's Phase 4 poll loop detects CI failures and dispatches fix-up workers
  via `orchestrate-auto-fixup` (CTL-64) or revives the original worker via `orchestrate-revive`

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
- **Worker's success contract is `status: "merging"` (CTL-133)** — the worker opens the PR,
  arms auto-merge, writes `status: "merging"` to its signal file, and exits. It does NOT poll
  for merge. Workers dispatched via `claude -p` cannot use `ScheduleWakeup` (it only fires in
  `/loop` dynamic mode), so polling in the worker is unreliable. The orchestrator's Phase 4 poll
  loop is the authoritative merge watcher
- **Orchestrator handles BEHIND, DIRTY, CI failures, and review comments** — the Phase 4 poll
  loop detects these states via `gh pr view` and dispatches `orchestrate-auto-fixup` (CTL-64)
  or revives the original worker via `orchestrate-revive` (budget: 10) when remediation is needed
- **Orchestrator writes `pr.mergedAt` + `status: "done"`** — when the Phase 4 poll loop confirms
  `state=MERGED`, it writes the merge signal and transitions the Linear ticket. The worker never
  writes `status: "done"`
- **Worker exits cleanly, not as a failure** — writing `status: "merging"` and exiting is the
  expected success path, not a stall. The orchestrator distinguishes this from genuine stalls
  (no PR, no progress for 15+ minutes)
- **Worker comms discipline** — when posting to the shared comms channel, follow the rules
  in [[catalyst-comms]] § Posting Discipline: `info` is the default heartbeat (phase
  transitions only, ~5–7 per session), `attention` is reserved for orchestrator action
  (0–2 per session, MANDATORY on the escalation triggers listed there — scope conflict,
  missing access, ambiguous spec, 3+ repeated CI failures, `status="stalled"`), `done`
  fires once at terminal success via the `done` subcommand. The existing `comms_post`
  helper in this skill already routes correctly — these rules govern *when* you call it.

**IMPORTANT: Document Storage Rules**

- ALWAYS write to `thoughts/shared/` (research, plans, prs subdirectories)
- NEVER write to `thoughts/searchable/` — this is a read-only search index
