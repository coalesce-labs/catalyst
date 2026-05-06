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
| `--no-merge`           | Stop after PR creation — do NOT enter listen loop or merge |
| `--no-ticket`          | Skip Linear ticket creation in freeform mode           |
| `--skip-validation`    | Skip Phase 4 entirely                                  |
| `--skip-quality-gates` | Run `/validate-plan` but skip quality gate loop        |

## Orchestrator Mode

When running under an `/orchestrate` coordinator, oneshot writes status updates to a **worker
signal file** so the orchestrator can track progress and run adversarial verification.

**Single-ticket scope contract (READ FIRST — CTL-208).** Your assigned scope is exactly the
ticket ID passed as the first positional argument (`$1`). This is the SOLE source of truth
for what work to do. The orchestrator state directory (`$ORCH_DIR`), wave briefings, sibling
worker signal files, and comms channel participant lists exist for write-through state
reporting and one-way context absorption — they NEVER expand or modify your scope.

DO:
- Use `${TICKET_ID}` (= `$1`) as your single ticket throughout the workflow.
- Read your own signal file at `${ORCH_DIR}/workers/${TICKET_ID}.json` — the SPECIFIC file
  named for your ticket, not the directory.
- Read the briefing for your wave by exact filename: `${ORCH_DIR}/wave-${WAVE}-briefing.md`,
  where `${WAVE}` comes from your signal file's `wave` field (set by the dispatcher in
  `orchestrate-dispatch-next`).

DO NOT:
- Enumerate `${ORCH_DIR}/workers/*.json` to discover sibling tickets.
- Read `${ORCH_DIR}/state.json` to see what other tickets are queued or in flight.
- Treat the wave briefing's "Wave roster" section as a list of tickets you must process —
  the wave briefing is shared across every worker in the wave; your assigned ticket is
  still only `$1`.
- Treat comms channel participants (visible via `catalyst-comms status`) as your scope.
- Ask the user to clarify which of "the tickets you see" they meant — there is exactly
  one ticket: `$1`. If `$1` is empty or missing, fail loudly; do not search for tickets
  to do.

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

**Shared comms channel (CTL-111 / CTL-249):** if `CATALYST_COMMS_CHANNEL` is set by the
orchestrator, the worker joins the shared channel, posts real traffic at each lifecycle boundary,
and reads inbound messages (directed to `$TICKET_ID`) after each phase transition.
Best-effort — every call is wrapped so a missing `catalyst-comms` CLI never crashes the worker.
The worker posts at **minimum 4 messages** per run: start + phase transitions + done.
Inbound reads are driven by `comms_check` (see below) — a non-blocking poll that checks for
`abort`, `use-event-driven`, and `reprioritize` signals from the orchestrator.

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

# Inbound comms — read messages directed to this worker at each phase boundary.
# COMMS_LAST_READ tracks the channel file line offset so we skip historical messages.
# Initialized after join (below) to the current end-of-file.
CATALYST_DIR="${CATALYST_DIR:-$HOME/catalyst}"
COMMS_CHANNEL_FILE="${CATALYST_DIR}/comms/channels/${CATALYST_COMMS_CHANNEL:-_}.jsonl"
COMMS_LAST_READ=0

comms_check() {
  [ -z "${CATALYST_COMMS_CHANNEL:-}" ] && return 0
  [ -n "$COMMS_BIN" ] || return 0
  [ -f "$COMMS_CHANNEL_FILE" ] || return 0
  local msgs next_pos
  # Snapshot line count BEFORE polling so messages arriving during the read
  # window are picked up on the next call rather than silently skipped.
  next_pos=$(wc -l < "$COMMS_CHANNEL_FILE" | tr -d ' ')
  msgs=$("$COMMS_BIN" poll "$CATALYST_COMMS_CHANNEL" \
    --filter-to "$TICKET_ID" --since "$COMMS_LAST_READ" 2>/dev/null || true)
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

# Once, at startup — right after orchestrator mode detection:
if [ -n "${CATALYST_COMMS_CHANNEL:-}" ] && [ -n "$COMMS_BIN" ]; then
  "$COMMS_BIN" join "$CATALYST_COMMS_CHANNEL" \
    --as "$TICKET_ID" \
    --capabilities "oneshot: ${TICKET_ID}" \
    --orch "${CATALYST_ORCHESTRATOR_ID:-}" \
    --parent orchestrator \
    --ttl 3600 >/dev/null 2>&1 || true
  comms_post info "started oneshot for $TICKET_ID"
  # Snapshot the channel file line count so comms_check skips pre-worker messages
  COMMS_CHANNEL_FILE="${CATALYST_DIR}/comms/channels/${CATALYST_COMMS_CHANNEL}.jsonl"
  [ -f "$COMMS_CHANNEL_FILE" ] && COMMS_LAST_READ=$(wc -l < "$COMMS_CHANNEL_FILE" | tr -d ' ')
fi

# CTL-269: catalyst-filter registration helpers. The worker registers a single
# semantic interest after PR creation that covers CI, comms, reviews, BEHIND,
# and Linear ticket changes. The Phase 5 listen loop then waits on a single
# `filter.wake.${CATALYST_SESSION_ID}` event instead of the per-concern jq
# filters. When the daemon is not running, the loop falls back to the existing
# direct `catalyst-events wait-for` pattern.

filter_daemon_running() {
  command -v catalyst-filter >/dev/null 2>&1 || return 1
  catalyst-filter status >/dev/null 2>&1
}

filter_register_worker() {
  # Args: $1 = PR_NUMBER, $2 = TICKET_ID, $3 = BRANCH_NAME
  filter_daemon_running || return 1
  [ -n "${CATALYST_SESSION_ID:-}" ] || return 1
  local pr="$1" ticket="$2" branch="$3"
  local prompt="Wake me when: CI passes or fails on PR ${pr}; PR ${pr} is merged or closed; PR ${pr} receives a review or changes-requested; the base branch of branch ${branch} receives a push (BEHIND state); I receive a comms message addressed to ${ticket}; or my Linear ticket ${ticket} status changes"
  "$STATE_SCRIPT" event "$(jq -nc \
    --arg sid "$CATALYST_SESSION_ID" \
    --arg orch "${CATALYST_ORCHESTRATOR_ID:-}" \
    --arg notify "filter.wake.${CATALYST_SESSION_ID}" \
    --arg prompt "$prompt" \
    --argjson pr "$pr" \
    --arg ticket "$ticket" \
    --arg branch "$branch" \
    '{ts: (now | todate), event: "filter.register",
      orchestrator: (if $orch == "" then null else $orch end),
      worker: null,
      detail: {
        interest_id: $sid,
        session_id: $sid,
        notify_event: $notify,
        persistent: true,
        prompt: $prompt,
        context: {pr_numbers: [$pr], tickets: [$ticket], branches: [$branch], workers: [$sid]}
      }}')" 2>/dev/null || return 1
  return 0
}

filter_deregister_worker() {
  filter_daemon_running || return 0
  [ -n "${CATALYST_SESSION_ID:-}" ] || return 0
  "$STATE_SCRIPT" event "$(jq -nc \
    --arg sid "$CATALYST_SESSION_ID" \
    '{ts: (now | todate), event: "filter.deregister", orchestrator: null, worker: null, detail: {interest_id: $sid}}')" 2>/dev/null || true
}

# Belt-and-suspenders: trap on EXIT/INT/TERM ensures graceful deregister.
# Watchdog cleanup in the daemon handles crash cases via session_id matching.
trap 'filter_deregister_worker' EXIT INT TERM
```

If `ORCH_DIR` is detected, the worker:

1. **Reads its signal file** from `${ORCH_DIR}/workers/${TICKET_ID}.json` (the single named
   file for this worker — do NOT list other files in the workers/ directory)
2. **Updates status at each phase transition** — writes `status`, `phase`, and `updatedAt` to both
   the local signal file AND the global state at `~/catalyst/state.json`
3. **Derives and writes `label`** to the signal file at startup (see Label Derivation below)
4. **Emits events** to the global event log at each phase transition
5. **Fills `definitionOfDone`** at Phase 4 (validation) and Phase 5 (ship) with actual results
6. **Reads its wave briefing** at `${ORCH_DIR}/wave-${WAVE}-briefing.md` if it exists, where
   `${WAVE}` is read from the worker's own signal file's `wave` field (set by dispatcher).
   Do NOT glob `wave-*-briefing.md` — only the worker's own wave is in scope. If the signal
   file has no `wave` field (older orchestrators), skip briefing read entirely.

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

    # Emit phase-advance / terminal event via the central producer (CTL-229).
    # Routine info-tier transitions (researching → planning → …) coalesce
    # within the configured window; terminal transitions (pr-created, merging,
    # done, failed, stalled, deploy-failed) flush any pending queue and emit
    # immediately, with PR enrichment when --to is PR-bearing.
    EMITTER="${CLAUDE_PLUGIN_ROOT:-/Users/ryan/.claude/plugins/cache/catalyst/catalyst-dev/8.1.0}/scripts/emit-worker-status-change.sh"
    if [ -x "$EMITTER" ]; then
      "$EMITTER" emit \
        --orch "$ORCH_ID" \
        --ticket "$TICKET_ID" \
        --from "$OLD_STATUS" \
        --to "$NEW_STATUS" \
        --signal-file "$SIGNAL_FILE" >/dev/null 2>&1 || true
    fi
  fi

  # CTL-111: announce phase transition to shared comms channel. Runs 5× in the
  # normal path (researching → planning → implementing → validating → shipping),
  # comfortably above the ≥2-transition floor.
  comms_post info "${OLD_STATUS} → ${NEW_STATUS}"
fi
# CTL-249: check for inbound orchestrator messages after each phase transition.
comms_check
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

**When PR is merged** (CTL-252: written by the worker after active listen loop confirms CLEAN):

The worker actively merges its own PR after the listen loop confirms the PR is CLEAN (CI green +
reviews satisfied). The worker writes `pr.mergedAt` + `status: "done"` to the signal file and
transitions the Linear ticket. The **orchestrator's Phase 4** is a safety-net fallback for
workers that stalled or crashed before completing their own merge.

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

| Phase | Signal Status | Writer |
|-------|--------------|--------|
| 1 start | `researching` | worker |
| 2 start | `planning` | worker |
| 3 start | `implementing` | worker |
| 4 start | `validating` | worker |
| 5 start | `shipping` | worker |
| 5 PR opened | `pr-created` + `pr.prOpenedAt` + `pr.ciStatus: "pending"` | worker |
| 5 PR listen loop: inline blocker handled | (worker fixes CI/reviews and loops) | worker |
| 5 PR listen loop: human changes-requested | `status: "stalled"` + attention | worker |
| 5 PR listen loop: unresolvable conflicts | `status: "stalled"` + attention | worker |
| 5 PR merged by worker (skipDeployVerification=true or no deploy config) | `pr.ciStatus: "merged"` + `pr.mergedAt` + `status: "done"` + `completedAt` | worker |
| 5 PR merged by worker (skipDeployVerification=false, CTL-211) | `pr.ciStatus: "merged"` + `pr.mergedAt` + `pr.mergeCommitSha` + `deploy.startedAt` + `deploy.environment` → waits for `deployment_status` | worker |
| 5 deployment_status.success on production env | `status: "done"` + `deploy.completedAt` + `deploy.result: "success"` | worker (orchestrator Phase 4 as fallback) |
| 5 deployment_status.failure on production env | `status: "deploy-failed"` + `deploy.failedAttempts` + attention | worker (orchestrator Phase 4 as fallback) |
| 5 worker stalled/crashed — merge fallback | `pr.ciStatus: "merged"` + `pr.mergedAt` + `status: "done"` | orchestrator Phase 4 (safety net) |
| Any failure | `failed` | worker |

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

**Step 2: Active PR Listen Loop — Wait for CLEAN then Merge (replaces auto-merge)**

After the PR is created, enter an event-driven listen loop. The preferred wake mechanism (CTL-269)
is a single `filter.register` covering CI, comms inbound, reviews, BEHIND, and Linear ticket
changes — the worker then waits on `filter.wake.${CATALYST_SESSION_ID}` and the Groq-backed filter
daemon decides which raw events match. When the daemon is not running, the loop falls back to the
[[wait-for-github]] two-phase pattern with per-concern jq filters. See [[catalyst-filter]] for
registration recipes. The worker actively resolves blockers (CI failures, bot review threads,
BEHIND) inline and proceeds to Step 3 only when the PR is CLEAN (CI green + reviews satisfied). On
unrecoverable blockers (human changes-requested, persistent DIRTY) the worker writes
`status: "stalled"` and exits; the orchestrator's Phase 4 is a safety-net fallback.

```bash
REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')
PR_OPENED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Record PR opening immediately
jq --arg ts "$PR_OPENED_AT" '.pr.prOpenedAt = $ts | .status = "pr-created"' \
  "$SIGNAL_FILE" > "$SIGNAL_FILE.tmp" && mv "$SIGNAL_FILE.tmp" "$SIGNAL_FILE"

# Pre-flight: verify event infrastructure (from [[wait-for-github]])
INFRA_STATUS=$(catalyst-monitor status --json 2>/dev/null)
TUNNEL=$(echo "$INFRA_STATUS" | jq -r '.webhookTunnel.state // "unknown"' 2>/dev/null)
USE_REST=false
[ "$TUNNEL" != "running" ] && { echo "WARN: tunnel not running — using REST fallback"; USE_REST=true; }

# CTL-269: register a single semantic interest covering CI, comms, reviews,
# BEHIND, and Linear ticket changes. When this succeeds, the loop waits on a
# single `filter.wake.${CATALYST_SESSION_ID}` event instead of running separate
# jq filters for each concern. When it fails (daemon not running, no session id),
# the loop falls back to the existing two-phase pattern below.
USE_FILTER_DAEMON=false
if filter_register_worker "$PR_NUMBER" "$TICKET_ID" "$(git branch --show-current)"; then
  USE_FILTER_DAEMON=true
  echo "[Phase 5] Registered filter interest for session ${CATALYST_SESSION_ID}"
fi

CI_FIX_ATTEMPTS=0
MAX_CI_FIX_ATTEMPTS=3
PR_DONE=false

while [ "$PR_DONE" = "false" ]; do
  # CTL-269 preferred path: single semantic wake covers all concerns.
  if [ "$USE_FILTER_DAEMON" = "true" ] && [ "$USE_REST" != "true" ]; then
    EVENT=$(catalyst-events wait-for \
      --filter ".event == \"filter.wake.${CATALYST_SESSION_ID}\"" \
      --timeout 600 2>/dev/null || true)
    if [ -n "$EVENT" ]; then
      WAKE_REASON=$(echo "$EVENT" | jq -r '.detail.reason // "unknown"' 2>/dev/null || echo "unknown")
      echo "[Phase 5] Filter wake: ${WAKE_REASON}"
    fi
    # Drain inbound comms inside the loop now that filter.wake fires on
    # comms.message.posted events too — comms_check is idempotent (advances
    # COMMS_LAST_READ atomically) and a no-op when nothing arrived.
    comms_check
  elif [ "$USE_REST" != "true" ]; then
    # Fallback: two-phase event wait (see [[wait-for-github]]).
    # Filter field reference: [[event-schema]] — note check_suite/workflow_run use
    # detail.prNumbers, not scope.pr. PR/review events DO populate scope.pr.
    EVENT=$(catalyst-events wait-for \
      --filter "(.scope.pr == ${PR_NUMBER} or (.detail.prNumbers // [] | contains([${PR_NUMBER}]))) and (
        .event == \"github.pr.merged\" or
        .event == \"github.check_suite.completed\" or
        (.event | startswith(\"github.pr_review\")) or
        .event == \"github.push\"
      )" \
      --timeout 180 2>/dev/null || true)

    if [ -z "$EVENT" ]; then
      # Phase 1 timed out — run diagnostics (see [[wait-for-github]] diagnostic block)
      _LOG_FILE=~/catalyst/events/$(date -u +%Y-%m).jsonl
      _LOG_LINES=$(wc -l < "$_LOG_FILE" 2>/dev/null | tr -d ' ')
      _SINCE_LINE=$(( ${_LOG_LINES:-0} > 500 ? ${_LOG_LINES:-0} - 500 : 0 ))
      HEARTBEATS=$(catalyst-events tail --since-line "$_SINCE_LINE" 2>/dev/null \
        | jq -c 'select(.event == "heartbeat")' | wc -l | tr -d ' ')
      TUNNEL_NOW=$(catalyst-monitor status --json 2>/dev/null \
        | jq -r '.webhookTunnel.state // "unknown"')
      if [ "${HEARTBEATS:-0}" -eq 0 ] || [ "$TUNNEL_NOW" != "running" ]; then
        echo "Infrastructure issue detected — switching to REST polling"
        USE_REST=true
      else
        # Infrastructure healthy — extend to Phase 2 (7200s)
        EVENT=$(catalyst-events wait-for \
          --filter "(.scope.pr == ${PR_NUMBER} or (.detail.prNumbers // [] | contains([${PR_NUMBER}]))) and (
            .event == \"github.pr.merged\" or
            .event == \"github.check_suite.completed\" or
            (.event | startswith(\"github.pr_review\")) or
            .event == \"github.push\"
          )" \
          --timeout 7200 2>/dev/null || true)
      fi
    fi
    # Drain inbound comms after each wake so messages don't sit until phase boundary.
    comms_check
  fi

  # Authoritative REST check — never gh pr view --json (GraphQL); REST only
  PR_JSON=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}" 2>/dev/null || echo '{}')
  PR_MERGED=$(echo "$PR_JSON" | jq -r '.merged // false')
  MERGE_STATE=$(echo "$PR_JSON" | jq -r '.mergeable_state // "unknown"')
  # REST .mergeable_state values: "clean", "blocked", "behind", "dirty", "unknown", "unstable"

  if [ "$PR_MERGED" = "true" ]; then
    PR_DONE=true; break
  fi

  # Check for human reviewer changes-requested (escalates to stalled)
  LAST_CR=$(gh pr view "$PR_NUMBER" --json reviews \
    --jq '[.reviews[] | select(.state == "CHANGES_REQUESTED")] | last | .author.login // ""' \
    2>/dev/null || echo "")
  if [ -n "$LAST_CR" ]; then
    ERROR_MSG="Changes requested by human reviewer ${LAST_CR} — operator action required"
    NEW_STATUS="stalled"; PHASE_NUM=5
    jq --arg status "stalled" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '.status = $status | .updatedAt = $ts' \
      "$SIGNAL_FILE" > "$SIGNAL_FILE.tmp" && mv "$SIGNAL_FILE.tmp" "$SIGNAL_FILE"
    comms_post attention "stalled: ${ERROR_MSG}"
    if [[ -n "${CATALYST_SESSION_ID:-}" && -x "$SESSION_SCRIPT" ]]; then
      "$SESSION_SCRIPT" end "$CATALYST_SESSION_ID" --status failed
    fi
    exit 1
  fi

  case "$MERGE_STATE" in
    clean)
      # CI passed and reviews satisfied — proceed to Step 3
      PR_DONE=true
      ;;
    blocked)
      # Unresolved bot review threads or CI failure
      UNRESOLVED=$(gh pr view "$PR_NUMBER" --json reviewThreads \
        --jq '[.reviewThreads[] | select(.isResolved == false)] | length' 2>/dev/null || echo 0)
      if [ "${UNRESOLVED:-0}" -gt 0 ]; then
        # Bot review threads — resolve via /review-comments, then loop
        /catalyst-dev:review-comments "$PR_NUMBER"
        if [[ -n "${CATALYST_SESSION_ID:-}" && -x "$SESSION_SCRIPT" ]]; then
          "$SESSION_SCRIPT" iteration "$CATALYST_SESSION_ID" --kind fix
        fi
      elif [ "$CI_FIX_ATTEMPTS" -lt "$MAX_CI_FIX_ATTEMPTS" ]; then
        # CI failure — attempt automated fix, push commit, then loop
        CI_FIX_ATTEMPTS=$((CI_FIX_ATTEMPTS + 1))
        if [[ -n "${CATALYST_SESSION_ID:-}" && -x "$SESSION_SCRIPT" ]]; then
          "$SESSION_SCRIPT" iteration "$CATALYST_SESSION_ID" --kind fix
        fi
        # Analyze CI failure from check run logs and push a targeted fix commit
        # (per the Phase 4 quality gate retry pattern)
      else
        ERROR_MSG="CI blocked after ${MAX_CI_FIX_ATTEMPTS} fix attempts — escalating"
        NEW_STATUS="stalled"; PHASE_NUM=5
        jq --arg status "stalled" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
          '.status = $status | .updatedAt = $ts' \
          "$SIGNAL_FILE" > "$SIGNAL_FILE.tmp" && mv "$SIGNAL_FILE.tmp" "$SIGNAL_FILE"
        comms_post attention "stalled: ${ERROR_MSG}"
        if [[ -n "${CATALYST_SESSION_ID:-}" && -x "$SESSION_SCRIPT" ]]; then
          "$SESSION_SCRIPT" end "$CATALYST_SESSION_ID" --status failed
        fi
        exit 1
      fi
      ;;
    behind)
      # Branch is behind base — rebase and push
      BASE_BRANCH_NAME=$(git remote show origin 2>/dev/null \
        | grep "HEAD branch" | awk '{print $NF}')
      git fetch origin && git rebase "origin/${BASE_BRANCH_NAME:-main}"
      git push --force-with-lease
      ;;
    dirty)
      ERROR_MSG="Merge conflicts (DIRTY) — cannot auto-resolve"
      NEW_STATUS="stalled"; PHASE_NUM=5
      jq --arg status "stalled" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '.status = $status | .updatedAt = $ts' \
        "$SIGNAL_FILE" > "$SIGNAL_FILE.tmp" && mv "$SIGNAL_FILE.tmp" "$SIGNAL_FILE"
      comms_post attention "stalled: ${ERROR_MSG}"
      if [[ -n "${CATALYST_SESSION_ID:-}" && -x "$SESSION_SCRIPT" ]]; then
        "$SESSION_SCRIPT" end "$CATALYST_SESSION_ID" --status failed
      fi
      exit 1
      ;;
    unknown|unstable)
      # Transient state — continue waiting for next event
      ;;
  esac

  # REST fallback sleep interval (no event tunnel)
  [ "$USE_REST" = "true" ] && sleep 300
done
```

**Step 3: Merge + Record Success**

PR is CLEAN (or already merged). Execute the merge directly (no `--auto`), optionally verify
deployment, write `status: "done"`, and exit.

```bash
# Execute merge now that PR is ready (no --auto; worker owns the merge in CTL-252 contract)
if [ "$PR_MERGED" != "true" ]; then
  gh pr merge "$PR_NUMBER" --squash --delete-branch
fi

# Confirm via REST (authoritative — never gh pr view --json)
MERGED_OK=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}" --jq '.merged' 2>/dev/null || echo "false")
if [ "$MERGED_OK" != "true" ]; then
  ERROR_MSG="gh pr merge succeeded but REST confirms PR not merged — escalating"
  comms_post attention "stalled: ${ERROR_MSG}"
  jq --arg status "stalled" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '.status = $status | .updatedAt = $ts' \
    "$SIGNAL_FILE" > "$SIGNAL_FILE.tmp" && mv "$SIGNAL_FILE.tmp" "$SIGNAL_FILE"
  if [[ -n "${CATALYST_SESSION_ID:-}" && -x "$SESSION_SCRIPT" ]]; then
    "$SESSION_SCRIPT" end "$CATALYST_SESSION_ID" --status failed
  fi
  exit 1
fi

MERGE_COMMIT_SHA=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}" \
  --jq '.merge_commit_sha // empty' 2>/dev/null || echo "")
MERGED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Optional deployment verification (CTL-211)
SKIP_DEPLOY=$(jq -r --arg repo "${REPO}" \
  '.catalyst.deploy[$repo].skipDeployVerification // true' .catalyst/config.json 2>/dev/null \
  || echo "true")
PROD_ENV=$(jq -r --arg repo "${REPO}" \
  '.catalyst.deploy[$repo].productionEnvironment // "production"' .catalyst/config.json 2>/dev/null)
DEPLOYMENT_URL=""

if [ "$SKIP_DEPLOY" != "true" ] && [ -n "$MERGE_COMMIT_SHA" ]; then
  # Two-phase wait for deployment_status (see [[wait-for-github]])
  DEPLOY_TIMEOUT=$(jq -r --arg repo "${REPO}" \
    '.catalyst.deploy[$repo].timeoutSec // 1800' .catalyst/config.json 2>/dev/null || echo 1800)

  DEPLOY_EVENT=$(catalyst-events wait-for \
    --filter "(.event | startswith(\"github.deployment_status\")) and
              .detail.environment == \"${PROD_ENV}\" and
              .detail.sha == \"${MERGE_COMMIT_SHA}\"" \
    --timeout 180 2>/dev/null || true)

  # Authoritative deploy lookup (REST — see [[wait-for-github]] REST fallback pattern)
  DEPLOY_JSON=$(gh api -X GET "/repos/${REPO}/deployments" \
    -f sha="$MERGE_COMMIT_SHA" -f environment="$PROD_ENV" --jq '.[0] // empty' 2>/dev/null || echo "")
  if [ -n "$DEPLOY_JSON" ]; then
    DEPLOY_ID=$(echo "$DEPLOY_JSON" | jq -r '.id // empty')
    STATUS_JSON=$(gh api "/repos/${REPO}/deployments/${DEPLOY_ID}/statuses" \
      --jq '.[0] // empty' 2>/dev/null || echo "")
    DEPLOY_STATE=$(echo "$STATUS_JSON" | jq -r '.state // "pending"')
    DEPLOYMENT_URL=$(echo "$STATUS_JSON" | jq -r '.environment_url // empty')

    if [ "$DEPLOY_STATE" = "failure" ] || [ "$DEPLOY_STATE" = "error" ]; then
      jq --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '.status = "deploy-failed" | .updatedAt = $ts' \
        "$SIGNAL_FILE" > "$SIGNAL_FILE.tmp" && mv "$SIGNAL_FILE.tmp" "$SIGNAL_FILE"
      comms_post attention "deploy-failed: ${PROD_ENV} deploy failed for PR #${PR_NUMBER}"
      if [[ -n "${CATALYST_SESSION_ID:-}" && -x "$SESSION_SCRIPT" ]]; then
        "$SESSION_SCRIPT" end "$CATALYST_SESSION_ID" --status failed
      fi
      exit 1
    fi
  fi
fi

# Record merge in signal file — worker writes status=done (CTL-252 contract)
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq --arg ts "$MERGED_AT" --arg now "$TS" --arg sha "${MERGE_COMMIT_SHA:-}" \
   --arg deploy_url "${DEPLOYMENT_URL:-}" \
  '.pr.mergedAt = $ts | .pr.ciStatus = "merged"
   | (if $sha != "" then .pr.mergeCommitSha = $sha else . end)
   | .status = "done" | .phase = 5 | .updatedAt = $now
   | .completedAt = $now | .phaseTimestamps.done = $now
   | (if $deploy_url != "" then .deployment = {url: $deploy_url} else . end)' \
  "$SIGNAL_FILE" > "${SIGNAL_FILE}.tmp" && mv "${SIGNAL_FILE}.tmp" "$SIGNAL_FILE"

# Update global state
if [ -n "$ORCH_ID" ] && [ -f "$STATE_SCRIPT" ]; then
  "$STATE_SCRIPT" worker "$ORCH_ID" "$TICKET_ID" \
    ".status = \"done\" | .phase = 5 | .pr.mergedAt = \"${MERGED_AT}\" | .pr.ciStatus = \"merged\""
  "$STATE_SCRIPT" event "$(jq -nc \
    --arg ts "$TS" --arg orch "$ORCH_ID" --arg w "$TICKET_ID" \
    --argjson pr "$PR_NUMBER" --arg mt "$MERGED_AT" \
    '{ts:$ts, orchestrator:$orch, worker:$w, event:"worker-pr-merged", detail:{pr:$pr, mergedAt:$mt}}')"
  "$STATE_SCRIPT" event "$(jq -nc --arg ts "$TS" --arg orch "$ORCH_ID" --arg w "$TICKET_ID" \
    '{ts:$ts, orchestrator:$orch, worker:$w, event:"worker-done", detail:null}')"
fi

# Transition Linear ticket to done (worker owns this in CTL-252 contract)
"${CLAUDE_PLUGIN_ROOT}/scripts/linear-transition.sh" \
  --ticket "$TICKET_ID" --transition done --config .catalyst/config.json 2>/dev/null || true

# End session
if [[ -n "${CATALYST_SESSION_ID:-}" && -x "$SESSION_SCRIPT" ]]; then
  "$SESSION_SCRIPT" pr "$CATALYST_SESSION_ID" --number "$PR_NUMBER" --url "$PR_URL"
  "$SESSION_SCRIPT" end "$CATALYST_SESSION_ID" --status done
fi

# CTL-111: post done to shared comms channel
if [ -n "${CATALYST_COMMS_CHANNEL:-}" ] && [ -n "$COMMS_BIN" ]; then
  "$COMMS_BIN" done "$CATALYST_COMMS_CHANNEL" --as "$TICKET_ID" >/dev/null 2>&1 || true
fi
```

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

**If `--no-merge` was set**, skip Steps 2–3 (listen loop and merge) entirely and report PR status instead:

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
transitions it to `stateMap.done` after merge in Step 3; the orchestrator's Phase 4 handles this
only as a fallback for stalled workers.

### Phase 6: (deprecated)

Phase 6 used to run `/merge-pr` separately. Workers now exit at `status: "done"` after actively
merging their own PR and verifying deployment (CTL-252). `/merge-pr` is still useful as a
standalone tool for merging a PR opened outside the oneshot flow.

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
Phase 5: Ship — runs /create-pr, enters active listen loop (event-driven, resolves CI/review
         blockers inline), merges when CLEAN, verifies deployment, writes status=done, exits.
         Orchestrator Phase 4 is a safety-net fallback for stalled/crashed workers only.
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
| 5 (PR merged by worker)            | → done       | `stateMap.done`       | "Done"        |

The worker transitions the ticket to `stateMap.done` after actively merging the PR in Step 3.
The orchestrator's Phase 4 handles this transition only as a fallback for workers that stalled
before completing their own merge (CTL-252).

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

- Worker detects the CI failure in the active listen loop (Step 2) via REST check on `mergeable_state`
- Worker attempts automated fix (up to 3 times) — analyzes CI failure, pushes fix commit, continues loop
- After 3 failed fix attempts, worker writes `status: "stalled"` and posts `attention` to comms
- The orchestrator's Phase 4 then dispatches a fix-up worker via `orchestrate-auto-fixup` (CTL-64)

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
- **Worker's success contract is `status: "done"` (CTL-252)** — the worker opens the PR,
  enters an event-driven listen loop using `catalyst-events wait-for`, resolves CI/review
  blockers inline, merges when CLEAN with `gh pr merge --squash --delete-branch` (no `--auto`),
  and writes `status: "done"` with `pr.mergedAt` and `deployment.url` (if applicable). Workers
  do NOT use `ScheduleWakeup` (unreliable in `-p` mode) — they use `catalyst-events wait-for`
  which is a blocking subprocess call that works reliably in non-interactive sessions
- **Worker handles BEHIND, CI failures, and bot review threads inline** — in the Phase 5 listen
  loop; the orchestrator's Phase 4 is a safety-net fallback for workers that write `status: "stalled"`
- **Worker writes `pr.mergedAt` + `status: "done"`** — after actively merging the PR in Phase 5
  Step 3. The orchestrator's Phase 4 handles this only for workers that stalled before completing
- **Worker exits cleanly after writing `status: "done"`** — this is the expected success path.
  The orchestrator distinguishes this from stalls (no PR, no progress for 15+ minutes)
- **Worker comms discipline** — when posting to the shared comms channel, follow the rules
  in [[catalyst-comms]] § Posting Discipline: `info` is the default heartbeat (phase
  transitions only, ~5–7 per session), `attention` is reserved for orchestrator action
  (0–2 per session, MANDATORY on the escalation triggers listed there — scope conflict,
  missing access, ambiguous spec, 3+ repeated CI failures, `status="stalled"`), `done`
  fires once at terminal success via the `done` subcommand. The existing `comms_post`
  helper in this skill already routes correctly — these rules govern *when* you call it.
- **Worker inbound reads (CTL-249)** — `comms_check` is called after each phase transition via
  the signal-file update block. It polls for messages directed to `$TICKET_ID` (skipping
  pre-worker history via `$COMMS_LAST_READ`), logs all inbound messages, and exits on `abort`.
  `catalyst-comms send` already emits `comms.message.posted` events to the global event log
  (CTL-210), so Option B event emission is complete — extending `catalyst-events wait-for`
  to include `comms.message` filters is tracked in CTL-247 (wait-for-github skill).

**IMPORTANT: Document Storage Rules**

- ALWAYS write to `thoughts/shared/` (research, plans, prs subdirectories)
- NEVER write to `thoughts/searchable/` — this is a read-only search index
