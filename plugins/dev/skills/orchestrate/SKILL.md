---
name: orchestrate
description:
  Coordinate multiple tickets in parallel across worktrees with wave-based execution, worker
  dispatch, and adversarial verification
disable-model-invocation: true
allowed-tools: Read, Write, Bash, Task, Grep, Glob, Agent
version: 1.0.0
---

# Orchestrate

Coordinate multiple Linear tickets in parallel across git worktrees. The orchestrator creates
worktrees, dispatches `/oneshot` workers, tracks progress via a dashboard, and enforces quality
gates through adversarial verification. **The orchestrator NEVER writes application code** — it only
coordinates, monitors, and verifies.

## Prerequisites

```bash
# 1. Git (REQUIRED)
if ! command -v git &>/dev/null; then
  echo "ERROR: Git is required"
  exit 1
fi

# 2. Linearis CLI (REQUIRED for ticket reading)
# See /catalyst-dev:linearis for CLI syntax reference
if ! command -v linearis &>/dev/null; then
  echo "ERROR: Linearis CLI required for ticket intake"
  echo "Install: npm install -g linearis"
  exit 1
fi

# 3. GitHub CLI (REQUIRED for PR monitoring)
if ! command -v gh &>/dev/null; then
  echo "ERROR: GitHub CLI required for PR/CI monitoring"
  exit 1
fi

# 4. Claude CLI (REQUIRED for worker dispatch)
if ! command -v claude &>/dev/null; then
  echo "ERROR: Claude CLI required for worker dispatch"
  exit 1
fi
```

## Invocation

```
/catalyst-dev:orchestrate PROJ-101 PROJ-102 PROJ-103             # explicit tickets
/catalyst-dev:orchestrate --project "Q2 API Redesign"              # pull from Linear project
/catalyst-dev:orchestrate --cycle current                           # pull from current cycle
/catalyst-dev:orchestrate --file tickets.txt                        # read ticket IDs from file
/catalyst-dev:orchestrate --auto 5                                  # auto-pick top 5 Todo tickets
```

## Flags

| Flag                     | Description                                                            |
| ------------------------ | ---------------------------------------------------------------------- |
| `--name <name>`          | Name this orchestrator instance (default: auto-generated from tickets) |
| `--project <name>`       | Pull tickets from a Linear project                                     |
| `--cycle current`        | Pull tickets from the current Linear cycle                             |
| `--file <path>`          | Read ticket IDs from a file (one per line)                             |
| `--auto <N>`             | Auto-pick top N Todo tickets: urgent/high priority first, newer first. Default N=3. |
| `--auto-merge`           | Workers auto-merge PRs when CI + verification pass                     |
| `--max-parallel <n>`     | Override config `maxParallel` (default: 3)                             |
| `--base-branch <branch>` | Base branch for worktrees (default: main)                              |
| `--interactive`          | Include PM intake phase before orchestration                           |
| `--prd <path>`           | Run PRD review panel + ticket creation before orchestration            |
| `--dry-run`              | Show wave plan without executing                                       |
| `--state-on-merge <name>` | Linear state to set on PR merge. Default: `stateMap.done` (typically "Done") |

## Configuration

Reads orchestration config from `.catalyst/config.json` (or `.claude/config.json` if `.catalyst/`
doesn't exist). Falls back to sensible defaults if no orchestration block exists.

```json
{
  "catalyst": {
    "orchestration": {
      "worktreeDir": null,
      "maxParallel": 3,
      "hooks": {
        "setup": [],
        "teardown": []
      },
      "workerCommand": "/catalyst-dev:oneshot",
      "workerModel": "opus",
      "thoughts": {
        "profile": null,
        "directory": null
      },
      "testRequirements": {
        "backend": ["unit"],
        "frontend": ["unit"],
        "fullstack": ["unit"]
      },
      "verifyBeforeMerge": true,
      "allowSelfReportedCompletion": false
    }
  }
}
```

See config template for full schema documentation.

## Core Principle: The Orchestrator Never Writes Code

The orchestrator operates ONLY from its own worktree. It:

- Creates/removes worker worktrees
- Dispatches worker sessions (via `claude` CLI with streaming JSON output)
- Reads status from worker signal files and git
- Writes dashboard and briefing documents for the human
- Runs adversarial verification agents in worker worktrees
- Updates Linear ticket states when workers fail to do so

It NEVER:

- Modifies application code
- Writes test code
- Changes configuration in worker worktrees
- Commits to worker branches

## Workflow

### Phase 1: Intake & Dependency Analysis

1. **Resolve tickets**: Based on invocation mode, use the Linearis CLI to fetch ticket data. **For
   exact CLI syntax, run `linearis issues usage` or `linearis cycles usage`** — do not guess.
   - Explicit IDs: read each ticket's full details
   - `--project`: list issues filtered by project name
   - `--cycle current`: list the active cycle, then list its issues
   - `--file`: read IDs from file, then read each ticket's details
   - `--auto <N>`: list `status=Todo` issues, then select the top N. Ranking: urgent/high
     priority first (Linear priority 1 = Urgent → 4 = Low, with 0 = "No priority" sorted
     LAST), then newest `createdAt` first. Example jq after `linearis issues list --status Todo`:
     `sort_by((if .priority == 0 then 5 else .priority end), (-(.createdAt | fromdateiso8601))) | .[:N]`
     Present the auto-picked tickets to the user as part of the wave plan before proceeding.

2. **Read ticket details**: For each ticket, extract:
   - Title, description, estimate
   - Dependencies (linked blocking/blocked-by issues)
   - Labels (to detect scope: backend, frontend, fullstack)

3. **Build dependency graph**: Identify which tickets in the set depend on each other.

4. **Group into waves**:
   - **Wave 1**: tickets with no dependencies on other tickets in the set
   - **Wave 2**: tickets that depend only on Wave 1 tickets
   - **Wave N**: tickets that depend on Wave N-1 tickets
   - Tickets with circular dependencies → flag to user, do NOT proceed

5. **Present wave plan for approval**:

```
Orchestration Plan — "api-redesign"
Total: 6 tickets | 3 waves | Max parallel: 3

Wave 1 (parallel, 3 workers):
  PROJ-101: Auth middleware rewrite [backend, 3pt]
  PROJ-102: Rate limiting service [backend, 2pt]
  PROJ-103: Email templates [frontend, 1pt]

Wave 2 (after Wave 1, 2 workers):
  PROJ-104: OAuth integration [fullstack, 5pt] — depends on PROJ-101
  PROJ-105: API usage dashboard [frontend, 3pt] — depends on PROJ-102

Wave 3 (after Wave 2, 1 worker):
  PROJ-106: Self-service API keys [fullstack, 5pt] — depends on PROJ-104, PROJ-105

Estimated waves: 3 sequential rounds
Proceed? [Y/n]
```

6. **If `--dry-run`**: Print wave plan and exit.

### Phase 2: Provision Worktrees

Determine worktree base directory (in priority order):

1. `catalyst.orchestration.worktreeDir` from config
2. `${GITHUB_SOURCE_ROOT}/<org>/<repo>-worktrees/` (from env var + git remote)
3. `~/wt/<repo>/` (fallback)

**Read config for orchestration settings:**

```bash
# Resolve config file (.catalyst/ first, then .claude/)
CONFIG_FILE=""
for CFG in ".catalyst/config.json" ".claude/config.json"; do
  if [ -f "$CFG" ]; then CONFIG_FILE="$CFG"; break; fi
done

# Read orchestration config (all have defaults)
WORKTREE_DIR=$(jq -r '.catalyst.orchestration.worktreeDir // empty' "$CONFIG_FILE" 2>/dev/null)
MAX_PARALLEL=$(jq -r '.catalyst.orchestration.maxParallel // 3' "$CONFIG_FILE" 2>/dev/null)
SETUP_HOOKS=$(jq -c '.catalyst.orchestration.hooks.setup // []' "$CONFIG_FILE" 2>/dev/null)
TEARDOWN_HOOKS=$(jq -c '.catalyst.orchestration.hooks.teardown // []' "$CONFIG_FILE" 2>/dev/null)
WORKER_COMMAND=$(jq -r '.catalyst.orchestration.workerCommand // "/catalyst-dev:oneshot"' "$CONFIG_FILE" 2>/dev/null)
WORKER_MODEL=$(jq -r '.catalyst.orchestration.workerModel // "opus"' "$CONFIG_FILE" 2>/dev/null)
```

**Create ALL worktrees using `create-worktree.sh`** — both orchestrator and workers go through the
same script so they all get `.claude/`, `.catalyst/`, dependency install, thoughts init, and custom
hooks:

```bash
# The create-worktree.sh script lives relative to this plugin
SCRIPT="${CLAUDE_PLUGIN_ROOT}/scripts/create-worktree.sh"

# Resolve --worktree-dir to pass through (omit flag if not configured — script uses its own defaults)
WT_DIR_FLAG=""
if [ -n "$WORKTREE_DIR" ]; then
  WT_DIR_FLAG="--worktree-dir ${WORKTREE_DIR}"
fi

# Resolve --hooks-json to pass custom setup hooks from config
HOOKS_FLAG=""
if [ "$SETUP_HOOKS" != "[]" ] && [ -n "$SETUP_HOOKS" ]; then
  HOOKS_FLAG="--hooks-json '${SETUP_HOOKS}'"
fi

# Pass --orchestration so all worktrees record which run they belong to
ORCH_FLAG="--orchestration ${ORCH_NAME}"

# 1. Create orchestrator worktree (same script, same initialization)
"$SCRIPT" "${ORCH_NAME}" "${BASE_BRANCH}" ${WT_DIR_FLAG} ${HOOKS_FLAG} ${ORCH_FLAG}
ORCH_WORKTREE="${WORKTREES_BASE}/${ORCH_NAME}"

# Per-orchestrator state lives under ~/catalyst/runs/<id>/ (decoupled from the
# git worktree — CTL-59). state.json, DASHBOARD.md, workers/, wave briefings,
# and SUMMARY.md all live here. Claude CLI output (streams/stderr) lands in
# workers/output/ so it sits alongside the signal files but does not pollute
# watchers that scan workers/*.json.
ORCH_DIR="$("${CLAUDE_PLUGIN_ROOT}/scripts/catalyst-state.sh" ensure-run-dir "${ORCH_NAME}")"

# 2. Create worker worktrees for current wave
for TICKET_ID in "${WAVE_TICKETS[@]}"; do
  "$SCRIPT" "${ORCH_NAME}-${TICKET_ID}" "${BASE_BRANCH}" ${WT_DIR_FLAG} ${HOOKS_FLAG} ${ORCH_FLAG}
done
```

**Where worktrees actually land** — the `create-worktree.sh` script resolves the base directory in
this priority order:

1. `--worktree-dir <path>` flag (from `catalyst.orchestration.worktreeDir` config)
2. `~/catalyst/wt/<projectKey>/` (default — reads `catalyst.projectKey` from config)
3. `~/catalyst/wt/<repo>/` (fallback if no config)

So for a project with `projectKey: "acme"` and no `worktreeDir` override, all worktrees land in:

```
~/catalyst/wt/acme/
├── api-redesign/                         # orchestrator
├── api-redesign-ACME-101/                # worker
├── api-redesign-ACME-102/                # worker
└── api-redesign-ACME-103/                # worker
```

With `worktreeDir: "~/catalyst/api"` explicitly configured:

```
~/catalyst/api/
├── api-redesign/                         # orchestrator
├── api-redesign-ACME-101/                # worker
├── api-redesign-ACME-102/                # worker
└── api-redesign-ACME-103/                # worker
```

**Recommended**: Add `~/catalyst` to Claude Code's `additionalDirectories` in
`~/.claude/settings.json` so all worktrees across projects are automatically trusted:

```json
{
  "permissions": {
    "additionalDirectories": ["/Users/you/catalyst"]
  }
}
```

**What `create-worktree.sh` does for EACH worktree** (orchestrator and workers alike):

1. `git worktree add -b <name> <path> <base-branch>` — creates the worktree
2. Copies `.claude/` directory (Claude Code native config, plugins, rules)
3. Copies `.catalyst/` directory (Catalyst workflow config, if it exists)
4. **Runs `catalyst.worktree.setup` commands from config** — dependency install, thoughts init,
   permission grants, or any project-specific setup (like Conductor's `conductor.json` lifecycle
   hooks)
5. If no `catalyst.worktree.setup` configured, falls back to auto-detected setup: `make setup` or
   `bun/npm install`, then `humanlayer thoughts init` + `sync`
6. Runs additional orchestration hooks from `--hooks-json` (from
   `catalyst.orchestration.hooks.setup`)

**Available variables in setup commands:** `${WORKTREE_PATH}`, `${BRANCH_NAME}`, `${TICKET_ID}`,
`${REPO_NAME}`, `${DIRECTORY}`, `${PROFILE}`

**After worktree creation, set up the orchestrator's status directory:**

```bash
# ORCH_DIR is the per-orchestrator state dir under ~/catalyst/runs/<id>/ (created
# by `catalyst-state.sh ensure-run-dir` above, which already makes workers/output/).
# This mkdir is a no-op for fresh runs but keeps the skill robust when ORCH_DIR
# is reconstructed on resume.
mkdir -p "${ORCH_DIR}/workers/output"
```

Initialize `DASHBOARD.md` from the template:

```bash
cp "${CLAUDE_PLUGIN_ROOT}/templates/orchestrate-dashboard.md" "${ORCH_DIR}/DASHBOARD.md"
```

Create the orchestrator's status directory:

```
${ORCH_DIR}/                                    # ~/catalyst/runs/${ORCH_NAME}/
├── DASHBOARD.md                                # human-readable status (from template)
├── state.json                                  # machine-readable orchestration state
├── wave-1-briefing.md                          # per-wave briefings
├── SUMMARY.md                                  # final run summary (post-Phase 5)
└── workers/
    ├── ${TICKET_1}.json                        # worker signal (schema: worker-signal.json)
    ├── ${TICKET_2}.json
    └── output/                                 # claude CLI output (streams, stderr)
        ├── ${TICKET_1}-stream.jsonl            # streaming JSON events from claude
        ├── ${TICKET_1}-stderr.log              # worker stderr (silent exits diagnosable)
        ├── ${TICKET_2}-stream.jsonl
        └── ${TICKET_2}-stderr.log
```

**Note on the runs/ split (CTL-59):** `ORCH_DIR` lives at `~/catalyst/runs/${ORCH_NAME}/` and
is decoupled from the git worktree at `${ORCH_WORKTREE}` (e.g.
`~/catalyst/wt/${PROJECT_KEY}/${ORCH_NAME}/`). This lets state survive worktree cleanup and keeps
`git status` clean. Claude CLI output (stream + stderr) lands in `workers/output/` to keep
file watchers that scan `workers/*.json` free of noise from large stream files.

**Debugging silent worker exits:** If `workers/output/${TICKET_ID}-stream.jsonl` is 0 bytes AND
`workers/output/${TICKET_ID}-stderr.log` is 0 bytes, the worker exited before emitting its first
event — check `git -C ${WORKER_DIR} log --oneline -5` and the worktree's `.claude/` directory for
setup issues. A non-empty stderr log will identify permission, path, or environment errors.

Initialize `state.json`:

```json
{
  "orchestrator": "<name>",
  "startedAt": "<ISO timestamp>",
  "baseBranch": "main",
  "totalTickets": 6,
  "totalWaves": 3,
  "currentWave": 1,
  "worktreeBase": "<path>",
  "waves": [
    {
      "wave": 1,
      "status": "provisioning",
      "tickets": ["PROJ-101", "PROJ-102", "PROJ-103"]
    },
    {
      "wave": 2,
      "status": "blocked",
      "tickets": ["PROJ-104", "PROJ-105"],
      "dependsOn": [1]
    }
  ],
  "workers": {}
}
```

**Register with global state** (immediately after local state initialization):

```bash
STATE_SCRIPT="${CLAUDE_PLUGIN_ROOT}/scripts/catalyst-state.sh"

# Resolve the catalyst-comms binary. Prefer the plugin-shipped copy so installs
# where `catalyst-comms` is only a shell alias (which doesn't propagate to
# subshells) still work. Fall back to PATH for users who have symlinked it.
COMMS_BIN="${CLAUDE_PLUGIN_ROOT:-}/scripts/catalyst-comms"
[ -x "$COMMS_BIN" ] || COMMS_BIN="$(command -v catalyst-comms 2>/dev/null || true)"
if [ -z "$COMMS_BIN" ] || [ ! -x "$COMMS_BIN" ]; then
  echo "warn: catalyst-comms not found — comms disabled (install: plugins/dev/scripts/install-cli.sh)" >&2
  COMMS_BIN=""
fi

# Build the registration JSON with all workers from all waves
# Use linearis CLI to read ticket titles (run `linearis issues usage` for syntax)
WORKERS_JSON="{}"
for TICKET_ID in "${ALL_TICKETS[@]}"; do
  TITLE=$(linearis issues read "$TICKET_ID" | jq -r '.title')  # see `linearis issues usage`
  WORKERS_JSON=$(echo "$WORKERS_JSON" | jq \
    --arg tid "$TICKET_ID" --arg title "$TITLE" \
    '. + {($tid): {ticketId: $tid, title: $title, status: "dispatched", phase: 0, branch: null, pr: null, updatedAt: "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'", needsAttention: false, attentionReason: null}}')
done

# Detect repository from git remote
REPO=$(git remote get-url origin 2>/dev/null | sed 's|.*github.com[:/]||;s|\.git$||')

"$STATE_SCRIPT" register "${ORCH_NAME}" "$(jq -nc \
  --arg id "${ORCH_NAME}" \
  --arg pk "$(jq -r '.catalyst.projectKey // "unknown"' "$CONFIG_FILE")" \
  --arg repo "$REPO" \
  --arg bb "${BASE_BRANCH}" \
  --arg wtd "${ORCH_DIR}" \
  --arg sf "${ORCH_DIR}/state.json" \
  --argjson total "${#ALL_TICKETS[@]}" \
  --argjson waves "$TOTAL_WAVES" \
  --argjson workers "$WORKERS_JSON" \
  '{
    id: $id, projectKey: $pk, repository: $repo, baseBranch: $bb,
    status: "active", startedAt: (now | strftime("%Y-%m-%dT%H:%M:%SZ")),
    worktreeDir: $wtd, stateFile: $sf,
    progress: {totalTickets: $total, completedTickets: 0, failedTickets: 0, inProgressTickets: 0, currentWave: 1, totalWaves: $waves},
    usage: {inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUSD: 0, numTurns: 0, durationMs: 0, durationApiMs: 0, model: null},
    workers: $workers, attention: []
  }')"
```

The `CATALYST_ORCHESTRATOR_ID` is set to `${ORCH_NAME}` for use by workers (passed via environment
variable alongside `CATALYST_ORCHESTRATOR_DIR`).

**Create the shared comms channel (CTL-111):** the orchestrator creates a file-based channel that
every worker will auto-join via `CATALYST_COMMS_CHANNEL` in its dispatch env. Best-effort — the
orchestrator does not crash if `catalyst-comms` is missing.

```bash
# Shared channel for this run. Workers will join at dispatch time.
if [ -n "$COMMS_BIN" ]; then
  "$COMMS_BIN" join "orch-${ORCH_NAME}" \
    --as orchestrator \
    --capabilities "coordinates workers" \
    --orch "${ORCH_NAME}" \
    --ttl 7200 >/dev/null 2>&1 || true
fi
```

**Start session tracking** (alongside the global state registration above):

```bash
SESSION_SCRIPT="${CLAUDE_PLUGIN_ROOT}/scripts/catalyst-session.sh"
if [[ -x "$SESSION_SCRIPT" ]]; then
  CATALYST_SESSION_ID=$("$SESSION_SCRIPT" start --skill "orchestrate" \
    --label "${ORCH_NAME}" \
    --workflow "${CATALYST_SESSION_ID:-}")
  export CATALYST_SESSION_ID
  "$SESSION_SCRIPT" phase "$CATALYST_SESSION_ID" "dispatching" --phase 3
fi
```

### Phase 3: Dispatch Workers

For each provisioned worker worktree, dispatch a `/oneshot` session.

**Preferred entrypoint — `orchestrate-dispatch-next` (CTL-116):**

The canonical dispatcher drains `state.json`'s `.queue.waveNPending` for every `N`
(dynamically, so wave 1/2/3/…/N all work without code changes), respects
`maxParallel - currentlyRunning`, writes dispatched/phase-0 signal files, launches
workers via `nohup`, updates global state, removes dispatched tickets from whichever
`waveNPending` list they lived in, and runs the post-dispatch healthcheck:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/orchestrate-dispatch-next" \
  --orch-dir "${ORCH_DIR}" \
  --orch-id "${ORCH_NAME}"
# Emits a one-line JSON summary: {"running":R,"slotsAfter":S,"dispatched":[...][,"queueEmpty":true]}
# Reads `orchestrator`, `worktreeBase`, `maxParallel` from state.json by default.
# Pass --session-id / --worker-command / --worker-args / --comms-channel to override.
# Pass --dry-run to preview without writing state or launching claude.
```

Call this once when the current wave is ready to dispatch, and again whenever a
worker slot frees up. It supersedes the hand-rolled `dispatch-next.sh` pattern from
pre-CTL-116 orchestration runs (which hardcoded `wave1Pending + wave2Pending + wave3Pending`).
The inline block below is preserved as reference for the underlying machinery.

**Dispatch mechanism — `claude` CLI with streaming JSON:**

```bash
WORKER_DIR="${WORKTREES_BASE}/${ORCH_NAME}-${TICKET_ID}"
WORKER_STREAM="${ORCH_DIR}/workers/output/${TICKET_ID}-stream.jsonl"
WORKER_STDERR="${ORCH_DIR}/workers/output/${TICKET_ID}-stderr.log"
SIGNAL_FILE="${ORCH_DIR}/workers/${TICKET_ID}.json"

# `claude -w` takes a *name* and creates a new worktree — it does NOT accept a
# path to an existing worktree. The worker worktree was already provisioned in
# Phase 2, so `cd` into it inside a backgrounded subshell and `exec` claude so
# its PID is reachable from the outer shell as `$!`.
# `--dangerously-skip-permissions` is required because headless workers have no
# TTY to answer permission prompts; the worktree is pre-trusted via Catalyst's
# setup hooks. `nohup` keeps the worker alive after the orchestrator shell
# exits. Stderr goes to a real file (not /dev/null) so a silent worker exit
# stays debuggable.
(
  cd "${WORKER_DIR}" || exit 1
  CATALYST_ORCHESTRATOR_DIR="${ORCH_DIR}" \
  CATALYST_ORCHESTRATOR_ID="${ORCH_NAME}" \
  CATALYST_COMMS_CHANNEL="orch-${ORCH_NAME}" \
  CATALYST_SESSION_ID="${CATALYST_SESSION_ID:-}" \
  exec nohup claude \
    -n "${ORCH_NAME}-${TICKET_ID}" \
    --output-format stream-json \
    --verbose \
    --dangerously-skip-permissions \
    -p "${WORKER_COMMAND} ${TICKET_ID} --auto-merge"
) > "$WORKER_STREAM" 2> "$WORKER_STDERR" &

WORKER_PID=$!

# Record the worker's PID + initial heartbeat into its signal file so the
# monitor can perform kill-0 liveness checks.
if [ -f "$SIGNAL_FILE" ]; then
  jq --argjson pid "$WORKER_PID" '.pid = $pid | .lastHeartbeat = .updatedAt' \
    "$SIGNAL_FILE" > "${SIGNAL_FILE}.tmp" && mv "${SIGNAL_FILE}.tmp" "$SIGNAL_FILE"
fi
```

**Streaming JSON output** (`--output-format stream-json --verbose`) emits NDJSON to stdout, one
event per line, in real-time as the worker runs. The monitor can tail the stream file to show live
worker activity. Key event types:

| Event                                                                                                             | What it signals                                                 |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `{"type":"system","subtype":"init"}`                                                                              | Worker session started; contains `session_id`                   |
| `{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","name":"..."}}}` | Worker is now invoking a specific tool (Bash, Read, Edit, etc.) |
| `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta"}}}`                    | Worker is generating reasoning/response text                    |
| `{"type":"assistant"}`                                                                                            | Complete assistant turn with all content blocks                 |
| `{"type":"system","subtype":"api_retry"}`                                                                         | Worker hit rate limit / error; shows attempt and delay          |
| `{"type":"result"}`                                                                                               | Worker finished; contains final answer and usage stats          |

**Worker usage / cost is rolled in by the monitor pass (CTL-115).** The dispatch shell
backgrounds workers with `&` and never `wait`s on them, so usage/cost extraction cannot
happen here. Phase 4 invokes `plugins/dev/scripts/orchestrate-roll-usage.sh` once per
worker per cycle to parse the final `result` event from the worker's stream file and:

1. Mirror cost into the worker's signal file (`.cost = USAGE`) — the dashboard reads
   signal files (not global state) for per-worker cost columns.
2. Write `state.workers[ticket].usage`.
3. Roll the delta into `state.usage` for the orchestrator-level aggregate.

The helper is idempotent (gated on `signal.cost == null`) and safe to call every cycle.

**Emit dispatch event and update global state** after each worker dispatch:

```bash
"$STATE_SCRIPT" worker "${ORCH_NAME}" "${TICKET_ID}" '.status = "dispatched" | .phase = 0'
"$STATE_SCRIPT" update "${ORCH_NAME}" '.progress.inProgressTickets += 1'
"$STATE_SCRIPT" event "$(jq -nc \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg orch "${ORCH_NAME}" --arg w "${TICKET_ID}" \
  '{ts: $ts, orchestrator: $orch, worker: $w, event: "worker-dispatched", detail: null}')"
```

**Post-dispatch health check (CTL-87):**

After the wave's per-worker dispatch loop has completed, run the batch health check
**once per wave**. It sleeps briefly (default 15s — configurable via `--grace-seconds`),
then verifies that every worker still sitting at `status="dispatched"`/`phase=0` has a
live PID. Any worker whose PID has already died is transitioned to `status="failed"`
with `failureReason="launch-failure"`, an attention item of type `launch-failure` is
raised, and a `worker-launch-failed` event is emitted. This means dead-on-arrival
workers surface in under 30 seconds instead of after the 15-minute stalled-worker
timeout, and the orchestrator can re-dispatch them (via `orchestrate-fixup` or a
manual redispatch) in the same wave.

```bash
# Run ONCE, after all workers in this wave have been dispatched.
"${CLAUDE_PLUGIN_ROOT}/scripts/orchestrate-healthcheck" \
  --orch-dir "${ORCH_DIR}" \
  --orch-id "${ORCH_NAME}"
# Prints a JSON summary on stdout: {"checked":N,"dead":M,"deadTickets":[...]}.
# Launch failures also appear in the attention list and as `worker-launch-failed`
# events in the global state log.
```

Healthy workers are untouched. Workers that have already advanced past `dispatched`
(e.g. into `researching`) are skipped because reaching a later status is itself
proof of life. This check complements the 15-minute stalled-worker detection in
Phase 4 — healthcheck catches launch failures, the stalled-worker scan catches
workers that die mid-run.

**Worker dispatch prompt includes mandatory testing AND lifecycle requirements:**

```
MANDATORY: Before completing your contract:
1. TDD — write failing tests BEFORE implementation for every feature
2. Unit tests — required for all new functions/methods
3. Integration/API tests — required for every new/modified API endpoint
4. Security review — must pass /security-review or equivalent
5. Code review — must pass code-reviewer agent
6. All quality gates in config must pass

Your success contract ENDS at:
  ✓ PR open (gh pr create succeeded)
  ✓ Auto-merge armed (gh pr merge --auto succeeded)
  ✓ CI passed and PR merged — gh pr view --json state returns MERGED
  ✓ pr.mergedAt + status="done" written to signal file
  ✓ Linear ticket transitioned to Done

POLL until state=MERGED. After arming auto-merge, run a poll loop:
  every 30-60s call gh pr view --json state,mergeStateStatus,mergedAt
  - if state=MERGED: write pr.mergedAt + status="done", transition Linear, exit success
  - if mergeStateStatus=BEHIND: gh api -X PUT /repos/{owner}/{repo}/pulls/{n}/update-branch
    (most repos disable allow_update_branch, so manual update is required)
  - if CI failing: investigate, fix, push, continue polling
  - if review comments arrive: address via /review-comments, push, continue polling
  - if mergeStateStatus=DIRTY (conflicts): attempt rebase; if unresolvable, write
    status="stalled" and exit non-success
  - if blocked on a required reviewer you cannot satisfy: write status="stalled"
    and exit non-success
  - otherwise: wait one cycle and re-poll

There is no fixed timeout — keep polling while CI/checks are still progressing.
Apply per-failure-type fix budgets (max ~3 distinct attempts per failure mode) so
you never spin on a stuck failure.

Write these fields into your signal file as they become available:
  pr.number
  pr.url
  pr.prOpenedAt       (ISO timestamp when gh pr create returned)
  pr.autoMergeArmedAt (ISO timestamp when gh pr merge --auto returned)
  pr.ciStatus         (pending | passing | failing | merged)
  pr.mergedAt         (ISO timestamp from gh pr view when state=MERGED)
  status              (pr-created → merging → done)

Your work will be independently verified by the orchestrator. The orchestrator's
poll loop is a safety net for stalled workers — if you exit successfully with
pr.mergedAt set, the orchestrator simply reconciles. If you exit at "stalled" or
"failed", the orchestrator can dispatch a fix-up worker.

COMMS DISCIPLINE: when posting to the shared comms channel, follow the rules in the
catalyst-comms skill (plugins/dev/skills/catalyst-comms/SKILL.md § Posting Discipline):
  - info = phase transitions + PR-opened only (default heartbeat, ~5-7 per session)
  - attention = orchestrator action required (0-2 per session, MANDATORY on: scope
    conflict, missing access, ambiguous spec, 3+ repeated CI failures, status=stalled)
  - done = exactly 1, only via the `done` subcommand at terminal success
  - never use attention as a heartbeat — it triggers the orchestrator's NEEDS ATTENTION
    banner

Write your status to the worker signal file at:
  ${ORCH_DIR}/workers/${TICKET_ID}.json

Update the signal file at each phase transition using the worker-signal.json schema.
```

**Initialize worker signal file** (orchestrator writes the initial state):

```json
{
  "ticket": "PROJ-101",
  "orchestrator": "<name>",
  "workerName": "<orch-name>-PROJ-101",
  "label": "oneshot PROJ-101",
  "status": "dispatched",
  "phase": 0,
  "startedAt": "<ISO timestamp>",
  "updatedAt": "<ISO timestamp>",
  "worktreePath": "<path>",
  "pr": null,
  "linearState": null,
  "definitionOfDone": {
    "testsWrittenFirst": false,
    "unitTests": { "exists": false, "count": 0 },
    "apiTests": { "exists": false, "count": 0 },
    "functionalTests": { "exists": false, "count": 0 },
    "typeCheck": { "passed": false },
    "securityReview": { "passed": false },
    "codeReview": { "passed": false },
    "rewardHackingScan": { "passed": false }
  }
}
```

### Phase 4: Monitor & Track

```bash
if [[ -n "${CATALYST_SESSION_ID:-}" && -x "$SESSION_SCRIPT" ]]; then
  "$SESSION_SCRIPT" phase "$CATALYST_SESSION_ID" "monitoring" --phase 4
fi
```

The orchestrator polls worker status on a regular interval. Use `/loop` if available, otherwise poll
manually.

**Ground truth is git + PR, not the signal file.** The signal file is *advisory* — it reports
the worker's self-described phase. Authoritative decisions (done, stalled) come from
`gh pr view` / `gh pr list --head <branch>` and `git rev-list --count <base>..<branch>`. A
merged upstream PR on a worker's branch means the worker is done, regardless of what the signal
file says. A worker with a live upstream PR is not stalled even if its signal file is stale.
When the signal disagrees with git/PR, the orchestrator reconciles the signal from the
authoritative source.

**Monitoring loop (every 2-3 minutes):**

```bash
# For each active worker:
for WORKER_SIGNAL in ${ORCH_DIR}/workers/*.json; do
  TICKET=$(jq -r '.ticket' "$WORKER_SIGNAL")
  WORKER_DIR="${WORKTREE_BASE}/${ORCH_NAME}-${TICKET}"

  # 1. Read worker signal file for self-reported status
  STATUS=$(jq -r '.status' "$WORKER_SIGNAL")

  # 2. Check git state in worker worktree
  cd "$WORKER_DIR"
  BRANCH=$(git branch --show-current)
  COMMIT_COUNT=$(git rev-list --count "${BASE_BRANCH}..HEAD" 2>/dev/null || echo 0)

  # 3. Check for PR
  PR_URL=$(gh pr list --head "$BRANCH" --json url --jq '.[0].url' 2>/dev/null || echo "")

  # 4. If PR exists, check CI
  if [ -n "$PR_URL" ]; then
    CI_STATUS=$(gh pr checks "$BRANCH" --json state --jq '.[].state' 2>/dev/null | sort -u)
  fi

  # 5. Update dashboard
done
```

**Update `DASHBOARD.md`** after each poll using the dashboard template. Include:

- Wave progress (current wave, tickets per wave)
- Per-worker status table (ticket, status, PR, test coverage columns)
- Event log (timestamped significant events)

**Update `state.json`** with machine-readable state for crash recovery.

**Update global state and heartbeat** after each monitoring poll:

```bash
# Heartbeat — proves the orchestrator is alive
"$STATE_SCRIPT" heartbeat "${ORCH_NAME}"

# Sync each worker's status from signal file to global state
for WORKER_SIGNAL in ${ORCH_DIR}/workers/*.json; do
  TICKET=$(jq -r '.ticket' "$WORKER_SIGNAL")
  W_STATUS=$(jq -r '.status' "$WORKER_SIGNAL")
  W_PHASE=$(jq -r '.phase' "$WORKER_SIGNAL")
  W_BRANCH=$(git -C "${WORKTREE_BASE}/${ORCH_NAME}-${TICKET}" branch --show-current 2>/dev/null || echo "")
  W_PR=$(jq -c '.pr // null' "$WORKER_SIGNAL")

  "$STATE_SCRIPT" worker "${ORCH_NAME}" "${TICKET}" \
    ".status = \"${W_STATUS}\" | .phase = ${W_PHASE} | .branch = \"${W_BRANCH}\" | .pr = ${W_PR}"
done

# Roll worker usage/cost into orch.usage (CTL-115). Idempotent: the helper
# no-ops when signal.cost is already populated, so calling it every cycle
# costs only a `jq` read per worker until the worker's stream first contains
# a `result` event.
for WORKER_SIGNAL in ${ORCH_DIR}/workers/*.json; do
  TICKET=$(jq -r '.ticket' "$WORKER_SIGNAL")
  "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrate-roll-usage.sh" \
    --orch "${ORCH_NAME}" --ticket "${TICKET}" --orch-dir "${ORCH_DIR}" \
    >/dev/null 2>&1 || true
done
```

**Orchestrator poll-until-MERGED safety net (CTL-31, refined by CTL-80):**

Workers now poll-until-MERGED themselves and write `pr.mergedAt` + `status: "done"` directly to
their signal file. The orchestrator's poll loop is a **safety net**: it independently confirms
merges so that if a worker stalls, exits early, or never gets to write `mergedAt`, the
orchestrator can detect the merge from GitHub and reconcile state. On each monitoring cycle,
for every worker whose signal does not yet show `pr.mergedAt`, ping GitHub directly:

```bash
for WORKER_SIGNAL in ${ORCH_DIR}/workers/*.json; do
  TICKET=$(jq -r '.ticket' "$WORKER_SIGNAL")
  W_STATUS=$(jq -r '.status' "$WORKER_SIGNAL")
  PR_NUMBER=$(jq -r '.pr.number // empty' "$WORKER_SIGNAL")
  PR_URL=$(jq -r '.pr.url // empty' "$WORKER_SIGNAL")
  MERGED_AT=$(jq -r '.pr.mergedAt // empty' "$WORKER_SIGNAL")

  # Skip terminal failure states and already-reconciled merges early.
  [ -n "$MERGED_AT" ] && continue
  [ "$W_STATUS" = "failed" ] && continue
  [ "$W_STATUS" = "stalled" ] && continue

  # If the signal does not have a PR number, try to discover one from the worker's
  # branch. This catches workers that merged their PR but died before writing
  # pr.number to their signal file (the ADV-224 class of failure — CTL-32).
  if [ -z "$PR_NUMBER" ]; then
    WORKER_DIR="${WORKTREE_BASE}/${ORCH_NAME}-${TICKET}"
    BRANCH=$(git -C "$WORKER_DIR" branch --show-current 2>/dev/null || echo "")
    [ -z "$BRANCH" ] && continue
    REPO_SLUG=$(git -C "$WORKER_DIR" remote get-url origin 2>/dev/null \
      | sed -E 's|.*github\.com[:/]([^/]+/[^/.]+)(\.git)?$|\1|')
    [ -z "$REPO_SLUG" ] && continue

    DISCOVERED=$(gh -R "$REPO_SLUG" pr list \
      --head "$BRANCH" --state all \
      --json number,state,mergedAt,url --limit 1 2>/dev/null || echo "[]")
    PR_NUMBER=$(echo "$DISCOVERED" | jq -r '.[0].number // empty')
    PR_URL=$(echo "$DISCOVERED" | jq -r '.[0].url // empty')
    [ -z "$PR_NUMBER" ] && continue

    # Record the discovery in the signal so future polls take the fast path.
    jq --argjson n "$PR_NUMBER" --arg u "$PR_URL" \
      '.pr = ((.pr // {}) | .number = ($n | tonumber) | .url = $u)' \
      "$WORKER_SIGNAL" > "$WORKER_SIGNAL.tmp" && mv "$WORKER_SIGNAL.tmp" "$WORKER_SIGNAL"
  fi

  # Parse repo from PR URL (e.g. https://github.com/org/repo/pull/123)
  REPO=$(echo "$PR_URL" | sed -E 's|https://github.com/([^/]+/[^/]+)/pull/.*|\1|')

  # Ask GitHub the authoritative question
  PR_JSON=$(gh -R "$REPO" pr view "$PR_NUMBER" \
    --json state,mergeStateStatus,mergedAt,mergeable,mergedBy 2>/dev/null || echo '{}')
  PR_STATE=$(echo "$PR_JSON" | jq -r '.state // "UNKNOWN"')
  MERGE_STATE=$(echo "$PR_JSON" | jq -r '.mergeStateStatus // "UNKNOWN"')
  PR_MERGED_AT=$(echo "$PR_JSON" | jq -r '.mergedAt // empty')

  case "$PR_STATE" in
    MERGED)
      # Record merge in signal + global state, advance worker to done
      jq --arg ts "$PR_MERGED_AT" \
        '.pr.ciStatus = "merged" | .pr.mergedAt = $ts | .status = "done"
         | .completedAt = $ts | .phaseTimestamps.done = $ts | .phase = 6' \
        "$WORKER_SIGNAL" > "$WORKER_SIGNAL.tmp" && mv "$WORKER_SIGNAL.tmp" "$WORKER_SIGNAL"

      "$STATE_SCRIPT" worker "${ORCH_NAME}" "${TICKET}" \
        ".status = \"done\" | .phase = 6 | .pr.ciStatus = \"merged\" | .pr.mergedAt = \"${PR_MERGED_AT}\""

      "$STATE_SCRIPT" event "$(jq -nc \
        --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg orch "${ORCH_NAME}" \
        --arg w "${TICKET}" --argjson pr "$PR_NUMBER" --arg mt "$PR_MERGED_AT" \
        '{ts:$ts, orchestrator:$orch, worker:$w, event:"worker-pr-merged", detail:{pr:$pr, mergedAt:$mt}}')"

      # Transition Linear ticket via the shared helper (CTL-69). The helper
      # reads stateMap from `.catalyst/config.json`, is idempotent, and
      # respects --state-on-merge when the operator wants a non-default
      # state (e.g., "Shipped"). Workers now drive this themselves on merge;
      # this call is a safety net for cases where the worker exited early.
      STATE_ON_MERGE_FLAG=""
      if [ -n "${STATE_ON_MERGE:-}" ]; then
        STATE_ON_MERGE_FLAG="--state ${STATE_ON_MERGE}"
      fi
      "${CLAUDE_PLUGIN_ROOT}/scripts/linear-transition.sh" \
        --ticket "${TICKET}" \
        --transition done \
        --config "$CONFIG_FILE" \
        ${STATE_ON_MERGE_FLAG} >/dev/null 2>&1 || true
      ;;

    CLOSED)
      # PR was closed without merge — surface for attention
      "$STATE_SCRIPT" attention "${ORCH_NAME}" "pr-closed" "${TICKET}" \
        "PR #${PR_NUMBER} was closed without merging"
      ;;

    OPEN)
      # Not merged yet — this is normal. Adjust poll cadence in the outer loop
      # based on MERGE_STATE (CLEAN=pass, BLOCKED=review/CI gating, UNSTABLE=CI
      # failed, BEHIND=needs rebase, DIRTY=conflicts). Only raise attention for
      # genuinely stuck states that a worker cannot unblock.
      case "$MERGE_STATE" in
        DIRTY)
          "$STATE_SCRIPT" attention "${ORCH_NAME}" "merge-conflicts" "${TICKET}" \
            "PR #${PR_NUMBER} has merge conflicts — needs rebase"
          ;;
        BEHIND)
          # Often auto-resolves when auto-merge rebases; log only
          ;;
        BLOCKED)
          # Out-of-band: orchestrate-auto-fixup runs after this loop and handles
          # BLOCKED (unresolved review threads, failing checks, review-required)
          # once the state has been stable for ≥10 minutes (CTL-64).
          ;;
      esac
      ;;
  esac
done
```

**Poll cadence**: 60–120s while CI is running (MERGE_STATE in {UNKNOWN, PENDING, BLOCKED}); 30s
while merge is imminent (MERGE_STATE=CLEAN but not yet MERGED). Under the CTL-80 contract the
worker is responsible for polling its own PR and writing `mergedAt` itself; this orchestrator
loop is a safety net that catches merges the worker missed (e.g., if the worker exited
prematurely on a transient error).

**Poll shared comms channel for attention (CTL-111):**

Workers post `type:attention` messages to `orch-${ORCH_NAME}` when blocked. On each monitoring
cycle, the orchestrator scans new messages and promotes any `attention` to a state-level
attention item so the dashboard's NEEDS ATTENTION banner surfaces it (with author + reason).

A small cursor file `${ORCH_DIR}/.comms-cursor` tracks the line count already processed so
repeated polls don't re-surface the same message. Single-writer (this loop) so no race.

```bash
if [ -n "$COMMS_BIN" ]; then
  CURSOR_FILE="${ORCH_DIR}/.comms-cursor"
  SINCE=$(cat "$CURSOR_FILE" 2>/dev/null || echo 0)
  CH_FILE="${HOME}/catalyst/comms/channels/orch-${ORCH_NAME}.jsonl"
  TOTAL=$(wc -l < "$CH_FILE" 2>/dev/null | tr -d ' ' || echo 0)

  if [ "${TOTAL:-0}" -gt "${SINCE:-0}" ]; then
    "$COMMS_BIN" poll "orch-${ORCH_NAME}" --since "$SINCE" 2>/dev/null | \
    while IFS= read -r MSG; do
      MSG_TYPE=$(echo "$MSG" | jq -r '.type // ""' 2>/dev/null)
      MSG_FROM=$(echo "$MSG" | jq -r '.from // ""' 2>/dev/null)
      MSG_BODY=$(echo "$MSG" | jq -r '.body // ""' 2>/dev/null)

      if [ "$MSG_TYPE" = "attention" ]; then
        # Extract the ticket id from the author name (workers use their TICKET_ID as --as)
        MSG_TICKET=$(echo "$MSG_FROM" | grep -oE '^[A-Z]+-[0-9]+' || echo "$MSG_FROM")
        "$STATE_SCRIPT" attention "${ORCH_NAME}" "comms-attention" "$MSG_TICKET" \
          "[$MSG_FROM] $MSG_BODY" 2>/dev/null || true
      fi
    done
    echo "$TOTAL" > "$CURSOR_FILE"
  fi
fi
```

**Detect stalled workers and raise attention:**

Before raising `stalled`, consult git + PR state. A stale signal file is not stall evidence on
its own — if the worker's upstream branch has an OPEN or MERGED PR, the worker is progressing
(or finished) regardless of what the signal file says. Only escalate when no authoritative
source shows activity.

```bash
for WORKER_SIGNAL in ${ORCH_DIR}/workers/*.json; do
  TICKET=$(jq -r '.ticket' "$WORKER_SIGNAL")
  W_STATUS=$(jq -r '.status' "$WORKER_SIGNAL")
  UPDATED=$(jq -r '.updatedAt' "$WORKER_SIGNAL")

  # If no update in 15+ minutes and not in a terminal state, consider escalating.
  if [[ "$W_STATUS" != "done" && "$W_STATUS" != "failed" && "$W_STATUS" != "stalled" ]]; then
    STALE_CUTOFF=$(date -u -v-15M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
      || date -u -d "15 minutes ago" +%Y-%m-%dT%H:%M:%SZ)
    if [[ "$UPDATED" < "$STALE_CUTOFF" ]]; then
      # Before raising stalled, consult git + PR state. CTL-32: a stale signal
      # on its own is not stall evidence when the PR shows real progress.
      WORKER_DIR="${WORKTREE_BASE}/${ORCH_NAME}-${TICKET}"
      BRANCH=$(git -C "$WORKER_DIR" branch --show-current 2>/dev/null || echo "")
      COMMITS_AHEAD=0
      HAS_UPSTREAM=0
      PR_STATE="NONE"

      if [ -n "$BRANCH" ]; then
        COMMITS_AHEAD=$(git -C "$WORKER_DIR" rev-list --count \
          "${BASE_BRANCH}..HEAD" 2>/dev/null || echo 0)
        if git -C "$WORKER_DIR" ls-remote --heads origin "$BRANCH" 2>/dev/null | grep -q .; then
          HAS_UPSTREAM=1
        fi
        REPO_SLUG=$(git -C "$WORKER_DIR" remote get-url origin 2>/dev/null \
          | sed -E 's|.*github\.com[:/]([^/]+/[^/.]+)(\.git)?$|\1|')
        if [ -n "$REPO_SLUG" ]; then
          PR_STATE=$(gh -R "$REPO_SLUG" pr list --head "$BRANCH" --state all \
            --json state --jq '.[0].state // "NONE"' 2>/dev/null || echo "NONE")
        fi
      fi

      case "$PR_STATE" in
        MERGED|OPEN)
          # Worker's PR is the authoritative progress signal. Clear any prior
          # stalled attention that the previous poll may have raised on signal
          # staleness alone (Subloop B will reconcile to done if MERGED).
          "$STATE_SCRIPT" resolve-attention "${ORCH_NAME}" "${TICKET}" 2>/dev/null || true
          ;;
        *)
          "$STATE_SCRIPT" attention "${ORCH_NAME}" "stalled" "${TICKET}" \
            "No progress for 15+ minutes (last update: ${UPDATED}); branch=${BRANCH:-?} commits=${COMMITS_AHEAD} pushed=${HAS_UPSTREAM} pr=${PR_STATE}"
          ;;
      esac
    fi
  fi
done
```

**Auto-revive dead/wedged workers (CTL-63, CTL-62):**

After the stalled-worker scan, attempt to resume any dead, heartbeat-stale,
or API-stream-idle-timeout'd worker from its original `session_id`. Resumed
sessions preserve tool-call history, plan context, and PR state at ~10×
lower cost than a fresh redispatch.

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/orchestrate-revive" \
  --orch-dir "$ORCH_DIR" \
  --orch-id "$ORCH_NAME"
```

The script checks every non-terminal worker signal and revives when any of:

1. **PID dead** — `kill -0 <pid>` fails (CTL-63)
2. **Heartbeat stale** — `lastHeartbeat` older than 15 minutes (catches
   zombie-sleep PIDs whose process is alive but idle) (CTL-63)
3. **API stream idle timeout** — the tail of
   `workers/output/<ticket>-stream.jsonl` contains a `type=result`,
   `is_error=true` event whose `api_error_status` or `result` mentions
   `Stream idle timeout` or `partial response received`, and whose `uuid`
   differs from the signal's `lastApiErrorUuid` (CTL-62)

Each successful revive records `lastReviveReason`
(`pid-dead` / `heartbeat-stale` / `api-stream-idle-timeout`) in the signal
file and emits a `worker-revived` event with the same reason in its detail.
The per-ticket revive budget (default 2) applies across all reasons
combined. Workers whose budget is exhausted or whose session_id cannot be
found transition to `status=stalled` with an attention item so you can
decide between manual intervention and a fresh redispatch. Session resume
uses `workers/output/<ticket>-stream.jsonl` (with legacy / transcript
fallbacks) to find the original `session_id`.

**Auto-dispatch fix-up workers for BLOCKED PRs (CTL-64):**

After revive, a second pass detects PRs stuck in `state=OPEN,
mergeStateStatus=BLOCKED` and either auto-dispatches `orchestrate-fixup`
or escalates to an attention item depending on the cause.

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/orchestrate-auto-fixup" \
  --orch-dir "$ORCH_DIR" \
  --orch-id "$ORCH_NAME"
```

The script records `blockedSince` on the worker signal the first time it
observes BLOCKED, then — once the state has been stable for
`--stable-minutes` (default 10) — classifies the cause via `gh pr view`
and an `api graphql` query for unresolved review threads:

| Classification       | Trigger                                               | Action                                                                   |
| -------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------ |
| `ci-running`         | any check `status ∈ {IN_PROGRESS, QUEUED, PENDING}`   | defer — try again next tick                                              |
| `checks-failing`     | any check `conclusion ∈ {FAILURE, TIMED_OUT, …}`      | raise `checks-failing` attention (worker's own loop / revive handles it) |
| `threads-unresolved` | checks pass AND unresolved review threads exist       | dispatch `orchestrate-fixup` with `--issues` composed from thread bodies |
| `review-required`    | checks pass AND `reviewDecision = REVIEW_REQUIRED`    | raise `review-required` attention (human must approve)                   |
| `blocked-unknown`    | none of the above (rare — shape not yet classified)   | raise `blocked-unknown` attention                                        |

Each auto-dispatch bumps `fixupAttempts` on the signal. When
`fixupAttempts ≥ --max-fixups` (default 2), the script raises
`fixup-budget-exhausted` attention instead of dispatching again, so a
human can decide between manual intervention and abandonment.

Signal-file fields the script reads/writes:

| Field                    | Written by                | Purpose                                                    |
| ------------------------ | ------------------------- | ---------------------------------------------------------- |
| `blockedSince`           | orchestrate-auto-fixup    | First observation of BLOCKED; cleared when PR leaves BLOCKED |
| `fixupAttempts`          | orchestrate-auto-fixup    | Auto-dispatch counter (max = `--max-fixups`)               |
| `lastFixupDispatchedAt`  | orchestrate-auto-fixup    | Timestamp of the most recent dispatch (for the dashboard)  |

### Phase 5: Independent Verification (Anti-Reward-Hacking)

```bash
if [[ -n "${CATALYST_SESSION_ID:-}" && -x "$SESSION_SCRIPT" ]]; then
  "$SESSION_SCRIPT" phase "$CATALYST_SESSION_ID" "verifying" --phase 5
fi
```

When a worker signals "done" (PR created, CI green), the orchestrator does NOT trust it. It spawns
an **adversarial verification agent** in the worker's worktree:

```bash
# Run adversarial verification
"${CLAUDE_PLUGIN_ROOT}/scripts/orchestrate-verify.sh" \
  --worktree "${WORKER_DIR}" \
  --ticket "${TICKET_ID}" \
  --base-branch "${BASE_BRANCH}" \
  --signal-file "${ORCH_DIR}/workers/${TICKET_ID}.json" \
  --test-requirements "${TEST_REQUIREMENTS}"
```

The verification script checks:

1. **Unit tests**: For each new/modified source file, verify a corresponding test file exists. Run
   the test suite, verify tests pass.
2. **API tests**: If API routes were added/modified, verify test coverage exists (Bruno collections,
   integration tests, etc.).
3. **Functional tests**: If UI was changed, verify functional/E2E test coverage exists.
4. **Type safety**: Run typecheck command, verify no errors.
5. **Security**: Check for OWASP top 10 patterns in new code.
6. **Reward hacking scan**: Run `/scan-reward-hacking` on changed files — check for `as any`,
   `@ts-ignore`, void patterns, suppressed errors.

**Emit verification events:**

```bash
# Before running verification
"$STATE_SCRIPT" event "$(jq -nc --arg ts "$(now_iso)" --arg orch "${ORCH_NAME}" --arg w "${TICKET_ID}" \
  '{ts: $ts, orchestrator: $orch, worker: $w, event: "verification-started", detail: null}')"

# After verification
if [[ $VERIFY_EXIT -eq 0 ]]; then
  "$STATE_SCRIPT" event "$(jq -nc --arg ts "$(now_iso)" --arg orch "${ORCH_NAME}" --arg w "${TICKET_ID}" \
    '{ts: $ts, orchestrator: $orch, worker: $w, event: "verification-passed", detail: null}')"
  "$STATE_SCRIPT" resolve-attention "${ORCH_NAME}" "${TICKET_ID}"
else
  "$STATE_SCRIPT" event "$(jq -nc --arg ts "$(now_iso)" --arg orch "${ORCH_NAME}" --arg w "${TICKET_ID}" \
    '{ts: $ts, orchestrator: $orch, worker: $w, event: "verification-failed", detail: null}')"
  "$STATE_SCRIPT" attention "${ORCH_NAME}" "verification-failed" "${TICKET_ID}" \
    "Independent verification found gaps — remediation required"
fi
```

**Verification outcomes:**

- **PASS**: All required coverage types present and passing. Worker advances to merge.
- **FAIL**: Specific gaps identified. Orchestrator:
  1. Updates dashboard with specific failures
  2. Sends worker back with explicit remediation instructions
  3. Does NOT allow the ticket to advance to merge
  4. Re-verifies after worker reports fix

**Send worker back (on failure):**

Write remediation instructions to a file the worker can read:

```
${ORCH_DIR}/workers/${TICKET_ID}-remediation.md

# Verification Failed — ${TICKET_ID}

The following gaps were found by independent verification:

## Missing Coverage
- [ ] No unit tests for src/auth/middleware.ts (new file)
- [ ] No Bruno API tests for POST /api/auth/token (new endpoint)

## Quality Issues
- [ ] `as any` cast at src/auth/types.ts:42

## Required Actions
1. Write unit tests for the middleware
2. Add Bruno collection for the auth endpoint
3. Remove the `as any` cast, use proper type guard

Update your worker signal file when fixed. The orchestrator will re-verify.
```

### Phase 6: Wave Advancement

When ALL tickets in the current wave pass verification:

1. **Confirm merges**: If `--auto-merge`, the Phase 4 orchestrator-owned poll loop already observed
   `state=MERGED` for each worker and recorded `pr.mergedAt`. Before advancing the wave,
   double-check every worker in this wave has `status="done"` with a non-null `pr.mergedAt` in its
   signal file. If any still show `pr-created` or `merging`, run one more Phase 4 poll cycle before
   proceeding. If `--auto-merge` is off, flag these PRs for human review on the dashboard instead of
   advancing.

2. **Write wave briefing** for the next wave (see Wave Briefing section below). Then persist a copy
   to the thoughts repository so it survives worktree cleanup:

   ```bash
   HANDOFF_DIR="thoughts/shared/handoffs/${ORCH_NAME}"
   mkdir -p "${HANDOFF_DIR}"
   TIMESTAMP=$(date +"%Y-%m-%d_%H-%M-%S")
   cp "${ORCH_DIR}/wave-${WAVE}-briefing.md" \
      "${HANDOFF_DIR}/${TIMESTAMP}_wave-${WAVE}-briefing.md"
   ```

3. **Clean up completed worktrees**: Run teardown hooks from config, then remove.

   ```bash
   WORKER_DIR="${WORKTREES_BASE}/${ORCH_NAME}-${TICKET_ID}"
   BRANCH_NAME="${ORCH_NAME}-${TICKET_ID}"

   # Run teardown hooks from catalyst.orchestration.hooks.teardown
   # Variable substitution: ${WORKTREE_PATH}, ${BRANCH_NAME}, ${TICKET_ID}, ${REPO_NAME}
   for HOOK in $(echo "$TEARDOWN_HOOKS" | jq -r '.[]'); do
     HOOK="${HOOK//\$\{WORKTREE_PATH\}/$WORKER_DIR}"
     HOOK="${HOOK//\$\{BRANCH_NAME\}/$BRANCH_NAME}"
     HOOK="${HOOK//\$\{TICKET_ID\}/$TICKET_ID}"
     eval "$HOOK" || true
   done

   # If teardown hooks didn't already remove the worktree, do it now
   if [ -d "$WORKER_DIR" ]; then
     git worktree remove "$WORKER_DIR" 2>/dev/null || true
     git branch -D "$BRANCH_NAME" 2>/dev/null || true
   fi
   ```

4. **Provision next wave**: Create worktrees for Wave N+1 tickets using the same
   `create-worktree.sh` invocation from Phase 2.

5. **Dispatch next wave workers**: Include wave briefing in dispatch prompt:

   ```
   IMPORTANT: Read the Wave ${PREV} briefing before starting:
     ${ORCH_DIR}/wave-${PREV}-briefing.md

   This briefing contains patterns, conventions, test helpers, and gotchas
   discovered by the previous wave. Build ON TOP of these — do not reinvent.
   ```

6. **Update dashboard, local state, and global state**: Advance `currentWave`, update wave statuses.

```bash
# Update global state for wave advancement
"$STATE_SCRIPT" update "${ORCH_NAME}" \
  ".progress.currentWave = ${NEXT_WAVE} | .progress.completedTickets += ${COMPLETED_COUNT}"
"$STATE_SCRIPT" event "$(jq -nc \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg orch "${ORCH_NAME}" \
  --argjson wave $NEXT_WAVE \
  --argjson tickets "$(printf '%s\n' "${NEXT_WAVE_TICKETS[@]}" | jq -R . | jq -sc .)" \
  '{ts: $ts, orchestrator: $orch, worker: null, event: "wave-started", detail: {wave: $wave, tickets: $tickets}}')"
```

### Phase 7: Completion

When all waves are complete:

1. **Write final summary** to `${ORCH_DIR}/SUMMARY.md`:
   - Total tickets completed
   - Total PRs merged
   - Test coverage summary across all tickets
   - Timeline (start to finish, per-wave durations)
   - Any verification failures that required remediation

   Then persist summary and any remaining briefings to thoughts:

   ```bash
   HANDOFF_DIR="thoughts/shared/handoffs/${ORCH_NAME}"
   mkdir -p "${HANDOFF_DIR}"
   TIMESTAMP=$(date +"%Y-%m-%d_%H-%M-%S")
   cp "${ORCH_DIR}/SUMMARY.md" \
      "${HANDOFF_DIR}/${TIMESTAMP}_${ORCH_NAME}-summary.md"
   ```

2. **Archive orchestrator artifacts** (CTL-110).

   Before any worktree cleanup, sweep artifacts from the runs dir and worktrees into
   `~/catalyst/archives/${ORCH_NAME}/` and index them in `~/catalyst/catalyst.db`. The sweep
   is **filesystem-first**: blobs are written to the archive root BEFORE the SQLite rows are
   inserted. If SQLite write fails, the filesystem artifacts remain on disk (syncable later
   via `catalyst-archive sync`).

   ```bash
   bun "${CLAUDE_PLUGIN_ROOT}/scripts/orch-monitor/catalyst-archive.ts" sweep "${ORCH_NAME}"
   ```

   The sweep is idempotent (`ON CONFLICT` upserts). Re-running is safe. If it fails, capture
   the exit code and `stderr` but proceed with the remaining cleanup steps — artifacts can be
   re-swept later before teardown.

3. **Verify Linear states**: Check all tickets are in `stateMap.done`. If any are stuck, update them
   using the Linearis CLI (run `linearis issues usage` for update syntax).

4. **File improvement findings (CTL-176 / CTL-183 routing):** Drain the shared findings queue
   and file one ticket per entry. The orchestrator and every dispatched worker share one queue
   (dispatch sets `CATALYST_FINDINGS_FILE=$ORCH_DIR/findings.jsonl`), so this one pass covers
   everything surfaced across the whole run. Runs as a no-op when the queue is empty.

   **Recording findings during the run.** The moment you or a worker notices friction worth
   fixing (workflow gaps, bugs spotted in adjacent code, recurring manual steps, gaps in
   tooling), record it on the shared queue:

   ```bash
   "${CLAUDE_PLUGIN_ROOT}/scripts/add-finding.sh" \
     --title "Short imperative title" \
     --body "Reproduction + expected + observed + any links" \
     --skill orchestrate --severity low
   ```

   Record inline, the moment it's observed — context compaction loses it otherwise. Don't
   prompt the user mid-run; don't wait for the end; don't batch. Step 4 below files the whole
   queue in one pass.

   **What counts:** friction the maintainer would want fixed, bugs in adjacent catalyst code
   spotted incidentally, gaps in tooling, manual steps that should be automated.
   **What doesn't:** this run's own ticket TODOs (those go in the PR body), user preferences
   that should be durable memory, routine debugging.

   ```bash
   FEEDBACK="${CLAUDE_PLUGIN_ROOT}/scripts/file-feedback.sh"
   CONSENT="${CLAUDE_PLUGIN_ROOT}/scripts/feedback-consent.sh"
   FINDINGS_FILE="${CATALYST_FINDINGS_FILE:-${ORCH_DIR}/findings.jsonl}"

   if [ -x "$FEEDBACK" ] && [ -f "$FINDINGS_FILE" ] && [ -s "$FINDINGS_FILE" ]; then
     COUNT=$(wc -l < "$FINDINGS_FILE" | tr -d ' ')
     # Autonomous mode (orchestrator runs without a TTY): file only when consent
     # is already granted — never prompt. Interactive maintainer invocations
     # prompt once, then persist on yes.
     if [ "$("$CONSENT" check)" != "granted" ] && [ -z "${CATALYST_AUTONOMOUS:-}" ] && [ -t 0 ]; then
       read -r -p "File $COUNT improvement tickets at end of run? [Y/n] " yn
       case "$yn" in [Nn]*) : ;; *) "$CONSENT" grant >/dev/null ;; esac
     fi
     if [ "$("$CONSENT" check)" = "granted" ]; then
       FILED=0
       while IFS= read -r line; do
         TITLE=$(jq -r '.title' <<<"$line")
         BODY=$(jq -r '.body' <<<"$line")
         SKILL=$(jq -r '.skill // "orchestrate"' <<<"$line")
         RESULT=$("$FEEDBACK" --title "$TITLE" --body "$BODY" --skill "$SKILL" --json 2>/dev/null || true)
         STATUS=$(jq -r '.status // "failed"' <<<"$RESULT")
         if [ "$STATUS" = "filed" ]; then
           ID=$(jq -r '.identifier // .url // ""' <<<"$RESULT")
           echo "  filed: $ID  ($TITLE)"
           FILED=$((FILED + 1))
         fi
       done < "$FINDINGS_FILE"
       # Preserve queue on partial failure; delete on full success.
       [ "$FILED" -eq "$COUNT" ] && rm -f "$FINDINGS_FILE"
     fi
   fi
   ```

5. **Clean up all worktrees** (including orchestrator worktree, unless user wants to keep it).
   Use `/catalyst-dev:teardown ${ORCH_NAME}` for a safe, archive-gated deletion. Teardown
   refuses to run unless step 2's sweep succeeded (use `--force` to override).

6. **Sync thoughts**: `humanlayer thoughts sync` to persist any shared documents.

7. **Complete and archive global state**:

```bash
# CTL-111: post orchestrator done to shared comms channel. Workers have already
# posted their own done messages via their poll loops; this closes out the orch
# participant and is advisory — rc is ignored. Channel cleanup is deferred to
# CTL-110's archive sweep (do NOT call `catalyst-comms gc` here — gc is global).
if [ -n "$COMMS_BIN" ]; then
  "$COMMS_BIN" done "orch-${ORCH_NAME}" --as orchestrator >/dev/null 2>&1 || true
fi

# Mark completed in global state
"$STATE_SCRIPT" update "${ORCH_NAME}" \
  '.status = "completed" | .completedAt = $now | .progress.completedTickets = .progress.totalTickets | .progress.inProgressTickets = 0'
"$STATE_SCRIPT" event "$(jq -nc --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg orch "${ORCH_NAME}" \
  '{ts: $ts, orchestrator: $orch, worker: null, event: "orchestrator-completed", detail: null}')"

# Mark worktree as done (distinguishes done vs in-progress in ls)
touch "${WORKTREE_PATH}/.done" 2>/dev/null || true

# Archive to history (removes from active state)
"$STATE_SCRIPT" archive "${ORCH_NAME}"

# End session tracking
if [[ -n "${CATALYST_SESSION_ID:-}" && -x "$SESSION_SCRIPT" ]]; then
  "$SESSION_SCRIPT" end "$CATALYST_SESSION_ID" --status done
fi
```

8. **Report to user**:

   ```
   Orchestration Complete — "api-redesign"

   Waves: 3/3 complete
   Tickets: 6/6 merged
   PRs: #87, #88, #89, #91, #92, #93
   Duration: 2h 14m

   Verification: 2 tickets required remediation
     - PROJ-101: Missing Bruno API tests (fixed on retry)
     - PROJ-105: as any cast (fixed on retry)

   Summary: ${ORCH_DIR}/SUMMARY.md
   History: ~/catalyst/history/${ORCH_NAME}--<timestamp>.json
   ```

## Wave Briefing Documents

Before dispatching each wave after Wave 1, the orchestrator writes a **briefing document** to
`${ORCH_DIR}/wave-${N}-briefing.md` summarizing what prior waves learned.

**How the briefing is created:**

1. Read each completed worker's PR description
2. Read git diff summaries from each merged PR (`git diff --stat`)
3. Read any research documents workers saved to `thoughts/shared/`
4. Synthesize into: patterns established, new dependencies added, test helpers created, gotchas
   discovered
5. **Pre-assign Supabase migration numbers** for the upcoming wave (see Migration Number Assignments
   below)

Use the wave briefing template from `plugins/dev/templates/orchestrate-wave-briefing.md`.

### Migration Number Assignments (CTL-29)

When two tickets in the same wave both add a Supabase migration, they can race on the same `NNN_`
filename prefix — whichever PR merges first wins, the other must rebase post-PR. The orchestrator
pre-assigns numbers in the briefing to prevent this.

**Generation step** (run before rendering the template):

```bash
# Scan migrations dir and assign numbers to migration-likely tickets in the NEXT wave.
# Prints a Markdown "## Migration Number Assignments" section, or nothing if the
# project has no supabase/migrations/ directory or no ticket in the wave is migration-
# likely. Safe to append unconditionally to the briefing.
MIG_SECTION=$("${CLAUDE_PLUGIN_ROOT}/scripts/pre-assign-migrations.sh" \
  --migrations-dir "${ORCH_WORKTREE}/supabase/migrations" \
  --tickets "${NEXT_WAVE_TICKETS[*]}") || MIG_SECTION=""
```

The script replaces the `${MIGRATION_ASSIGNMENTS}` placeholder in the briefing template.

**Detection heuristic** (matches `pre-assign-migrations.sh`):

- Label match (case-insensitive): `database`, `migration`, `schema`
- Keyword match in title or description (case-insensitive): `supabase/migrations`, `migration`,
  `schema`, `ALTER TABLE`, `CREATE TABLE`

**Behavior:**

- If `supabase/migrations/` does not exist in the orchestrator worktree, the script emits nothing
  (repo-agnostic — projects without Supabase are unaffected).
- If no ticket in the wave is migration-likely, it emits nothing.
- Otherwise it scans for the highest existing `NNN_` prefix and assigns `NNN+1`, `NNN+2`, ... to
  each migration-likely ticket in input order.

**Tests:** `plugins/dev/scripts/__tests__/pre-assign-migrations.test.sh` covers the detection
heuristic, the scanning logic, repo-agnostic fallback, and sequential assignment.

**Thoughts persistence:** Every briefing is copied to `thoughts/shared/handoffs/${ORCH_NAME}/` with
timestamped filenames (`YYYY-MM-DD_HH-MM-SS_wave-N-briefing.md`). This ensures briefings survive
worktree cleanup and are available via thoughts sync across workspaces. The final `SUMMARY.md` is
also persisted there at completion.

**Why this matters:** This is a unique advantage over other frameworks. GSD executors are stateless.
Gas Town Polecats don't share findings. Wave briefings mean:

- Wave 2+ workers know which patterns to follow
- Wave 2+ workers know which test helpers exist
- Wave 2+ workers know about gotchas discovered by earlier waves
- Knowledge compounds across waves

## Orchestrator Rollup Briefing (CTL-108)

In addition to per-wave briefings (which summarize upstream for downstream workers), the
orchestrator also exposes an **aggregate rollup briefing** for humans reviewing the whole run.
The rollup is **not written by the orchestrator** — it is derived on-read by the orch-monitor
from:

1. Worker signal files (`${ORCH_DIR}/workers/${ticket}.json`) — provides the "what shipped"
   list (any worker with `pr.number` set).
2. Per-worker rollup fragments (`${ORCH_DIR}/workers/${ticket}-rollup.md`) — optional markdown
   files written by workers after a successful merge (see `oneshot/SKILL.md` Phase 5 Step 4).
   Each fragment contributes a `### ${ticket}` section to the "Gotchas" area and its first
   non-blank line becomes the one-liner next to the shipped PR.

The orch-monitor assembles these on every snapshot — there is no persisted rollup file to
maintain, no sync step for the orchestrator to run. Workers that do not write a fragment
simply appear in "What shipped" with PR title only.

The rollup surfaces in the orch-monitor UI under the existing Briefing tab (first section,
above per-wave briefings) and as a small `rollup` pill on the orchestrator dashboard card.

## Testing Enforcement (3 Layers)

### Layer 1 — Dispatch Prompt (Prevention)

Every worker dispatch includes mandatory testing requirements in the prompt itself. Not a suggestion
— a hard requirement. The prompt explicitly states that work will be independently verified and
workers should not claim done without tests.

### Layer 2 — Quality Gates (Automated)

The existing quality gate system (`/validate-type-safety`, `/security-review`, `code-reviewer`,
`pr-test-analyzer`) plus config-based gates run inside each worker's `/oneshot` pipeline. These are
the worker's own self-checks.

### Layer 3 — Independent Verification (Adversarial)

The orchestrator's own verification script audits the worker's output AFTER the worker claims done.
This is the anti-reward-hacking layer — the worker can't game its own quality gates because the
orchestrator runs a separate, adversarial check. The verification agent has no incentive to pass —
it's scored on catching gaps, not shipping fast.

## Dashboard

The orchestrator maintains a live dashboard at `${ORCH_DIR}/DASHBOARD.md`. Updated after each
monitoring poll. Uses the template from `plugins/dev/templates/orchestrate-dashboard.md`.

The dashboard includes:

- Orchestrator metadata (name, start time, project, base branch)
- Current wave progress
- Per-worker status table with test coverage columns
- Blocked waves with dependency information
- Timestamped event log

## Linear Integration

The orchestrator manages Linear state transitions as a safety net:

| Event                      | Linear Action                                     |
| -------------------------- | ------------------------------------------------- |
| Worker dispatched          | Move ticket to `stateMap.inProgress`              |
| Worker creates PR          | Verify ticket is `stateMap.inReview` — fix if not |
| Worker passes verification | No change (already in review)                     |
| PR merged                  | Verify ticket is `stateMap.done` — fix if not     |
| Worker fails/stalls        | Add comment with status, keep `inProgress`        |

The orchestrator also adds comments to tickets for visibility using the Linearis CLI (run
`linearis comments usage` for syntax).

### Single source of truth: `linear-transition.sh`

All Linear state transitions (by the orchestrator's safety net AND by workers at end of
`/oneshot`) go through `plugins/dev/scripts/linear-transition.sh`. It reads `stateMap` from
`.catalyst/config.json`, is idempotent (no-op when the ticket is already in the target state),
and exits 0 when the `linearis` CLI is not installed (graceful skip).

```bash
# Transition via transition-key (reads stateMap.done from config):
"${CLAUDE_PLUGIN_ROOT}/scripts/linear-transition.sh" \
  --ticket PROJ-123 --transition done --config .catalyst/config.json

# Override with an explicit state name (e.g., --state-on-merge "Shipped"):
"${CLAUDE_PLUGIN_ROOT}/scripts/linear-transition.sh" \
  --ticket PROJ-123 --state "Shipped" --config .catalyst/config.json
```

The `--state-on-merge` flag on orchestrate is passed through to this helper whenever it is set.

### Retroactive bulk-close: `orchestrate-bulk-close`

For runs that predated the state-transition wiring (or where the orchestrator's poll loop exited
before reconciling tickets), run the bulk-close helper. It walks `workers/*.json`, inspects each
PR via `gh`, and transitions tickets via `linear-transition.sh`:

- Merged PR with non-empty diff → `stateMap.done`
- Merged PR with zero diff (subsumed) → `stateMap.canceled`
- No PR, signal `status=done` (zero-scope) → `stateMap.canceled`
- Worker still in progress → skip (bulk-close is for reconciliation only)

```bash
# Preview what the helper would do (no changes):
plugins/dev/scripts/orchestrate-bulk-close --orch-dir ~/catalyst/runs/<orch-name> --dry-run

# Actually transition tickets:
plugins/dev/scripts/orchestrate-bulk-close --orch-dir ~/catalyst/runs/<orch-name>

# JSON summary for scripting:
plugins/dev/scripts/orchestrate-bulk-close --orch-dir ~/catalyst/runs/<orch-name> --json
```

Flags mirror orchestrate: `--state-on-merge <name>` and `--state-on-canceled <name>` override the
respective defaults.

## Named Orchestrators & Remote Control

Start the orchestrator with remote control for access from claude.ai/code. The orchestrator worktree
was already created in Phase 2, so `cd` into it — do not pass `-w` (that would ask claude to create
a _new_ worktree using the path as a name):

```bash
( cd "${ORCH_WORKTREE}" && claude --remote-control "${ORCH_NAME}" )
```

Workers should NOT use remote control — they're autonomous. The human monitors workers through the
orchestrator's dashboard.

**Multiple orchestrators** can run concurrently. Worktree names are prefixed with the orchestrator
name to avoid collisions:

```
${WORKTREE_BASE}/
├── auth-orch/                    # orchestrator 1
├── auth-orch-PROJ-101/           # orchestrator 1's worker
├── auth-orch-PROJ-102/           # orchestrator 1's worker
├── dash-orch/                    # orchestrator 2
├── dash-orch-PROJ-201/           # orchestrator 2's worker
└── dash-orch-PROJ-202/           # orchestrator 2's worker
```

## Worker Communication

Workers write status updates to `${ORCH_DIR}/workers/${TICKET_ID}.json`. The `/oneshot` skill
detects orchestrator presence by checking for a sibling `orchestrator/` directory or the
`CATALYST_ORCHESTRATOR_DIR` environment variable.

**Worker signal file schema:** See `plugins/dev/templates/worker-signal.json` for the full JSON
schema including the `definitionOfDone` block.

**How workers detect orchestrator mode:**

```bash
# Detection order:
# 1. CATALYST_ORCHESTRATOR_DIR env var (set by orchestrator in dispatch)
# 2. Sibling directory matching *-orchestrator or <prefix>/ pattern
# 3. ../*/workers/ directory exists (convention-based)
ORCH_DIR="${CATALYST_ORCHESTRATOR_DIR:-}"
if [ -z "$ORCH_DIR" ]; then
  # Check for sibling orchestrator directory
  PARENT=$(dirname "$(pwd)")
  ORCH_DIR=$(find "$PARENT" -maxdepth 1 -name "*/workers" -type d 2>/dev/null | head -1 | sed 's|/workers$||')
fi
```

## Recovery Paths: Fix-up Worker vs Follow-up Ticket

Under the CTL-80 contract, workers poll until `state=MERGED` and exit at `done`. If a worker
exits earlier (`stalled`, `failed`, or process crash), or if findings surface after merge, the
orchestrator triages them. Two recovery patterns cover the cases that came up in
`orch-data-import-2026-04-13` Round 2:

### Decision Tree

```
Did the PR already merge?
├── No — PR is still OPEN
│   └── Blockers on the existing PR (Codex inline threads, CI failure, missed review point).
│       → Pattern A: FIX-UP WORKER  (orchestrate-fixup)
│
└── Yes — PR is MERGED
    └── Findings surfaced AFTER merge (late scan, post-merge review, prod observation).
        → Pattern B: FOLLOW-UP TICKET  (orchestrate-followup)
```

Ask `gh pr view $PR_NUMBER --json state` before choosing. `OPEN` → fix-up. `MERGED`/`CLOSED` →
follow-up. If the PR is `MERGED` you physically cannot push to that branch anymore; a fix-up attempt
will fail silently or push to an orphan branch.

### Pattern A: Fix-up Worker (PR still open)

Used on ADV-219 / PR #130 and ADV-220 / PR #132 during `orch-data-import-2026-04-13`. Either the
original worker exited at `stalled` because Codex or a security scanner posted inline threads it
could not resolve in its own poll loop, or the worker process died before reaching MERGED.
Auto-merge is blocked on unresolved threads.

**When to use:**

- `pr.state = OPEN`
- Blockers are specific and file:line-scoped (inline review comments, CI test failures, lint errors)
- The remediation is a small targeted patch, not a re-design

**How the orchestrator dispatches:**

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/orchestrate-fixup" "${TICKET}" \
  --issues "src/auth/middleware.ts:42: handle null session token
src/auth/middleware.ts:89: Codex flagged timing-attack comparison
test/auth.test.ts: add regression test for the null-token path" \
  --pr "${PR_NUMBER}" \
  --dispatch
```

What this does:

1. Renders `templates/fixup-prompt.md` → `${ORCH_DIR}/workers/fixup-${TICKET}-prompt.md`
2. Renders `templates/dispatch-fixup.sh.template` →
   `${ORCH_DIR}/workers/dispatch-fixup-${TICKET}.sh`
3. With `--dispatch`, runs the dispatch script in the background (via `claude -p` with streaming
   JSON output)

The fix-up worker:

- Pulls latest on the existing PR branch (does NOT create a new branch)
- Resolves ONLY the listed blockers
- Pushes ONE commit with message `fix(...): resolve review feedback on #${PR}`
- Resolves review threads via `gh api graphql resolveReviewThread`
- Writes its commit SHA to the worker signal file as `fixupCommit`
- Polls until `state=MERGED` (CTL-80 contract), writes `pr.mergedAt` + `status: "done"`,
  transitions Linear, then exits

The orchestrator's Phase 4 poll loop is a safety net: if the fix-up worker exits stalled or
crashes before merge, the orchestrator can still observe the eventual `MERGED` state and
reconcile. `fixupCommit` is metadata for the dashboard.

**Typical cost:** ~$2 (much cheaper than a fresh worker because scope is narrow).

### Pattern B: Follow-up Ticket (PR already merged)

Used on ADV-221 → ADV-222 / PR #133 during `orch-data-import-2026-04-13`. The parent PR merged
cleanly; a post-merge security review or prod observation surfaced issues later. A fix-up is
physically impossible — the merged branch is gone.

**When to use:**

- `pr.state = MERGED`
- New findings that would have blocked merge if they had arrived 10 minutes earlier
- Traceability to the parent is important (audit, incident response)

**How the orchestrator dispatches:**

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/orchestrate-followup" "${PARENT_TICKET}" \
  --findings "post-merge: validateSessionToken allows empty string (src/auth/middleware.ts:42)
post-merge: missing rate-limit on POST /api/auth/token (src/api/auth.ts:18)"
```

What this does:

1. Files a new Linear ticket via `linearis issues create`, with description that references the
   parent and enumerates the findings. Title defaults to
   `Follow-up: <PARENT_TICKET> post-merge findings`; override with `--title`.
2. Provisions a fresh worktree off `main` via `create-worktree.sh`, named
   `${ORCH_NAME}-${NEW_TICKET}`.
3. Seeds the new worker's signal file with `followUpTo: "${PARENT_TICKET}"` — the orchestrator and
   dashboard both use this field to render the ancestry.
4. Renders `templates/followup-prompt.md` → `${ORCH_DIR}/workers/${NEW_TICKET}-prompt.md`, which
   points the worker at the findings, the parent PR, and the TDD contract.
5. Prints the `claude -p` command to actually start the worker — it does NOT auto-dispatch
   (follow-up tickets are heavier and warrant human confirmation).

The follow-up worker runs the full `/oneshot` pipeline (research → plan → implement → validate →
ship), same as any other worker. Its PR description must reference the parent PR number; the prompt
enforces this.

**Typical cost:** ~$4 (full pipeline, but scoped to the findings).

**Skip Linear ticket creation** with `--ticket <id>` if you filed the ticket manually or Linear is
unavailable. The rest of the flow proceeds with the given ticket ID.

### Signal file metadata

| Field         | Written by                     | Pattern |
| ------------- | ------------------------------ | ------- |
| `fixupCommit` | fix-up worker (after push)     | A       |
| `followUpTo`  | orchestrator (at provisioning) | B       |

These fields are additive — they do not conflict with `pr.prOpenedAt`, `pr.autoMergeArmedAt`, or
`pr.mergedAt` (which remain worker-owned / orchestrator-owned per the normal split).

### Dashboard columns

`DASHBOARD.md` has two additional columns: `Fix-up Commit` (short SHA, empty for normal workers) and
`Follow-up To` (parent ticket ID, empty for normal workers and fix-up workers). See
`templates/orchestrate-dashboard.md`.

### Known limitation

`orchestrate-verify.sh` currently only matches open PRs via `gh pr list --head`; already-merged PRs
(the exact target of Pattern B) slip past its checks as false-negatives. This is tracked separately
and does not block recovery — follow-up workers run full quality gates from their `/oneshot`
pipeline, which is the real verification.

## Error Handling

**All error paths that stop the orchestrator must end the session:**

```bash
if [[ -n "${CATALYST_SESSION_ID:-}" && -x "$SESSION_SCRIPT" ]]; then
  "$SESSION_SCRIPT" end "$CATALYST_SESSION_ID" --status failed
fi
```

**Worker crashes or stalls:**

- Monitor detects no progress for 15+ minutes (no commits, no signal updates)
- Dashboard marks worker as "stalled"
- Orchestrator does NOT auto-restart — flags for human decision
- Options presented: restart worker, skip ticket, investigate manually

**Orchestrator crash recovery:**

- All state is in `${ORCH_DIR}/state.json` + worker signal files
- Resume with: `/catalyst-dev:orchestrate --resume ${ORCH_DIR}`
- Reads state.json, determines current wave, checks each worker's actual status
- Picks up where it left off
- On resume, start a new session (the old one leaked — this is acceptable)

**Worktree conflicts:**

- If a worktree path already exists, skip creation and check if it's from a previous run
- If it has a valid worker signal file, treat as a resumed worker

## Important

- The orchestrator lives in its own worktree and **never modifies code**
- Workers are fully autonomous — they run `/oneshot` with all its phases
- Wave advancement requires ALL tickets in the wave to pass verification
- The `--auto-merge` flag applies to workers, not the orchestrator
- Dashboard and state files are ephemeral — they don't survive worktree removal
- Wave briefings and summaries are persisted to `thoughts/shared/handoffs/${ORCH_NAME}/` for
  archival
- Wave briefings are the key differentiator — knowledge compounds across waves
- The 3-layer testing enforcement prevents the observed failure mode of agents skipping tests
- CTL-26 dependency: Uses `.catalyst/` paths. Falls back to `.claude/` if `.catalyst/` doesn't exist
