---
name: orchestrate
description: Coordinate multiple tickets in parallel across worktrees with wave-based execution, worker dispatch, and adversarial verification
disable-model-invocation: true
allowed-tools: Read, Write, Bash, Task, Grep, Glob, Agent
version: 1.0.0
---

# Orchestrate

Coordinate multiple Linear tickets in parallel across git worktrees. The orchestrator creates
worktrees, dispatches `/oneshot` workers, tracks progress via a dashboard, and enforces quality
gates through adversarial verification. **The orchestrator NEVER writes application code** — it
only coordinates, monitors, and verifies.

## Prerequisites

```bash
# 1. Git (REQUIRED)
if ! command -v git &>/dev/null; then
  echo "ERROR: Git is required"
  exit 1
fi

# 2. Linearis CLI (REQUIRED for ticket reading)
if ! command -v linearis &>/dev/null; then
  echo "ERROR: Linearis CLI required for ticket intake"
  echo "Install: npm install -g @anthropic/linearis"
  exit 1
fi

# 3. GitHub CLI (REQUIRED for PR monitoring)
if ! command -v gh &>/dev/null; then
  echo "ERROR: GitHub CLI required for PR/CI monitoring"
  exit 1
fi

# 4. HumanLayer CLI (REQUIRED for worker dispatch)
if ! command -v humanlayer &>/dev/null; then
  echo "WARNING: HumanLayer CLI not found — falling back to direct claude CLI"
fi
```

## Invocation

```
/catalyst-dev:orchestrate PROJ-101 PROJ-102 PROJ-103             # explicit tickets
/catalyst-dev:orchestrate --project "Q2 API Redesign"              # pull from Linear project
/catalyst-dev:orchestrate --cycle current                           # pull from current cycle
/catalyst-dev:orchestrate --file tickets.txt                        # read ticket IDs from file
```

## Flags

| Flag | Description |
|------|-------------|
| `--name <name>` | Name this orchestrator instance (default: auto-generated from tickets) |
| `--project <name>` | Pull tickets from a Linear project |
| `--cycle current` | Pull tickets from the current Linear cycle |
| `--file <path>` | Read ticket IDs from a file (one per line) |
| `--auto-merge` | Workers auto-merge PRs when CI + verification pass |
| `--max-parallel <n>` | Override config `maxParallel` (default: 3) |
| `--base-branch <branch>` | Base branch for worktrees (default: main) |
| `--interactive` | Include PM intake phase before orchestration |
| `--prd <path>` | Run PRD review panel + ticket creation before orchestration |
| `--dry-run` | Show wave plan without executing |

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
- Dispatches worker sessions (via `humanlayer launch` or `claude` CLI)
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

1. **Resolve tickets**: Based on invocation mode:
   - Explicit IDs: validate each via `linearis issues get <ID>`
   - `--project`: `linearis issues list --project "<name>" --status "Todo,Backlog,In Progress"`
   - `--cycle current`: `linearis cycles list --current` then `linearis issues list --cycle <id>`
   - `--file`: read IDs from file, validate each

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

**Create ALL worktrees using `create-worktree.sh`** — both orchestrator and workers go
through the same script so they all get `.claude/`, `.catalyst/`, dependency install,
thoughts init, and custom hooks:

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

# 1. Create orchestrator worktree (same script, same initialization)
"$SCRIPT" "${ORCH_NAME}" "${BASE_BRANCH}" ${WT_DIR_FLAG} ${HOOKS_FLAG}
ORCH_DIR="${WORKTREES_BASE}/${ORCH_NAME}"

# 2. Create worker worktrees for current wave
for TICKET_ID in "${WAVE_TICKETS[@]}"; do
  "$SCRIPT" "${ORCH_NAME}-${TICKET_ID}" "${BASE_BRANCH}" ${WT_DIR_FLAG} ${HOOKS_FLAG}
done
```

**Where worktrees actually land** — the `create-worktree.sh` script resolves the base
directory in this priority order:

1. `--worktree-dir <path>` flag (from `catalyst.orchestration.worktreeDir` config)
2. `~/catalyst/wt/<projectKey>/` (default — reads `catalyst.projectKey` from config)
3. `~/catalyst/wt/<repo>/` (fallback if no config)

So for a project with `projectKey: "acme"` and no `worktreeDir` override, all worktrees
land in:

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
    "additionalDirectories": [
      "/Users/you/catalyst"
    ]
  }
}
```

**What `create-worktree.sh` does for EACH worktree** (orchestrator and workers alike):

1. `git worktree add -b <name> <path> <base-branch>` — creates the worktree
2. Copies `.claude/` directory (Claude Code native config, plugins, rules)
3. Copies `.catalyst/` directory (Catalyst workflow config, if it exists)
4. **Runs `catalyst.worktree.setup` commands from config** — dependency install, thoughts init,
   permission grants, or any project-specific setup (like Conductor's `conductor.json` lifecycle hooks)
5. If no `catalyst.worktree.setup` configured, falls back to auto-detected setup: `make setup`
   or `bun/npm install`, then `humanlayer thoughts init` + `sync`
6. Runs additional orchestration hooks from `--hooks-json` (from `catalyst.orchestration.hooks.setup`)

**Available variables in setup commands:** `${WORKTREE_PATH}`, `${BRANCH_NAME}`, `${TICKET_ID}`,
`${REPO_NAME}`, `${DIRECTORY}`, `${PROFILE}`

**After worktree creation, set up the orchestrator's status directory:**

```bash
mkdir -p "${ORCH_DIR}/workers"
```

Initialize `DASHBOARD.md` from the template:

```bash
cp "${CLAUDE_PLUGIN_ROOT}/templates/orchestrate-dashboard.md" "${ORCH_DIR}/DASHBOARD.md"
```

Create the orchestrator's status directory:

```
${ORCH_DIR}/
├── DASHBOARD.md                    # human-readable status (from template)
├── state.json                      # machine-readable orchestration state
└── workers/                        # worker signal files written here
    ├── ${TICKET_1}.json
    ├── ${TICKET_2}.json
    └── ...
```

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

### Phase 3: Dispatch Workers

For each provisioned worker worktree, dispatch a `/oneshot` session.

**Dispatch mechanism (priority order):**

1. **`humanlayer launch`** (preferred — context isolation + named sessions):
   ```bash
   WORKER_DIR="${WORKTREES_BASE}/${ORCH_NAME}-${TICKET_ID}"

   CATALYST_ORCHESTRATOR_DIR="${ORCH_DIR}" \
   humanlayer launch \
     --model "${WORKER_MODEL}" \
     --title "${ORCH_NAME}-${TICKET_ID}" \
     -w "${WORKER_DIR}" \
     "${WORKER_COMMAND} ${TICKET_ID} --auto-merge"
   ```

2. **Direct `claude` CLI** (fallback):
   ```bash
   CATALYST_ORCHESTRATOR_DIR="${ORCH_DIR}" \
   claude \
     -n "${ORCH_NAME}-${TICKET_ID}" \
     -w "${WORKER_DIR}" \
     -p "${WORKER_COMMAND} ${TICKET_ID} --auto-merge" &
   ```

**Worker dispatch prompt includes mandatory testing requirements:**

```
MANDATORY: Before marking this ticket as complete:
1. TDD — write failing tests BEFORE implementation for every feature
2. Unit tests — required for all new functions/methods
3. Integration/API tests — required for every new/modified API endpoint
4. Security review — must pass /security-review or equivalent
5. Code review — must pass code-reviewer agent
6. All quality gates in config must pass

Your work will be independently verified by the orchestrator. Do NOT mark as done
until all test types exist. Write your status to the worker signal file at:
  ${ORCH_DIR}/workers/${TICKET_ID}.json

Update the signal file at each phase transition using the worker-signal.json schema.
```

**Initialize worker signal file** (orchestrator writes the initial state):

```json
{
  "ticket": "PROJ-101",
  "orchestrator": "<name>",
  "workerName": "<orch-name>-PROJ-101",
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

The orchestrator polls worker status on a regular interval. Use `/loop` if available, otherwise
poll manually.

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

### Phase 5: Independent Verification (Anti-Reward-Hacking)

When a worker signals "done" (PR created, CI green), the orchestrator does NOT trust it.
It spawns an **adversarial verification agent** in the worker's worktree:

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

1. **Unit tests**: For each new/modified source file, verify a corresponding test file exists.
   Run the test suite, verify tests pass.
2. **API tests**: If API routes were added/modified, verify test coverage exists (Bruno
   collections, integration tests, etc.).
3. **Functional tests**: If UI was changed, verify functional/E2E test coverage exists.
4. **Type safety**: Run typecheck command, verify no errors.
5. **Security**: Check for OWASP top 10 patterns in new code.
6. **Reward hacking scan**: Run `/scan-reward-hacking` on changed files — check for `as any`,
   `@ts-ignore`, void patterns, suppressed errors.

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

1. **Merge PRs**: If `--auto-merge`, run `/merge-pr` in each worker worktree. Otherwise, flag
   PRs for human review on the dashboard.

2. **Write wave briefing** for the next wave (see Wave Briefing section below).

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

6. **Update dashboard and state**: Advance `currentWave`, update wave statuses.

### Phase 7: Completion

When all waves are complete:

1. **Write final summary** to `${ORCH_DIR}/SUMMARY.md`:
   - Total tickets completed
   - Total PRs merged
   - Test coverage summary across all tickets
   - Timeline (start to finish, per-wave durations)
   - Any verification failures that required remediation

2. **Verify Linear states**: Check all tickets are in `stateMap.done`. If any are stuck,
   update them:
   ```bash
   linearis issues update "${TICKET_ID}" --status "${STATE_MAP_DONE}"
   ```

3. **Clean up all worktrees** (including orchestrator worktree, unless user wants to keep it).

4. **Sync thoughts**: `humanlayer thoughts sync` to persist any shared documents.

5. **Report to user**:
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
   ```

## Wave Briefing Documents

Before dispatching each wave after Wave 1, the orchestrator writes a **briefing document**
to `${ORCH_DIR}/wave-${N}-briefing.md` summarizing what prior waves learned.

**How the briefing is created:**

1. Read each completed worker's PR description
2. Read git diff summaries from each merged PR (`git diff --stat`)
3. Read any research documents workers saved to `thoughts/shared/`
4. Synthesize into: patterns established, new dependencies added, test helpers created,
   gotchas discovered

Use the wave briefing template from `plugins/dev/templates/orchestrate-wave-briefing.md`.

**Why this matters:** This is a unique advantage over other frameworks. GSD executors are
stateless. Gas Town Polecats don't share findings. Wave briefings mean:
- Wave 2+ workers know which patterns to follow
- Wave 2+ workers know which test helpers exist
- Wave 2+ workers know about gotchas discovered by earlier waves
- Knowledge compounds across waves

## Testing Enforcement (3 Layers)

### Layer 1 — Dispatch Prompt (Prevention)

Every worker dispatch includes mandatory testing requirements in the prompt itself.
Not a suggestion — a hard requirement. The prompt explicitly states that work will be
independently verified and workers should not claim done without tests.

### Layer 2 — Quality Gates (Automated)

The existing quality gate system (`/validate-type-safety`, `/security-review`,
`code-reviewer`, `pr-test-analyzer`) plus config-based gates run inside each worker's
`/oneshot` pipeline. These are the worker's own self-checks.

### Layer 3 — Independent Verification (Adversarial)

The orchestrator's own verification script audits the worker's output AFTER the worker
claims done. This is the anti-reward-hacking layer — the worker can't game its own quality
gates because the orchestrator runs a separate, adversarial check. The verification agent
has no incentive to pass — it's scored on catching gaps, not shipping fast.

## Dashboard

The orchestrator maintains a live dashboard at `${ORCH_DIR}/DASHBOARD.md`. Updated after
each monitoring poll. Uses the template from `plugins/dev/templates/orchestrate-dashboard.md`.

The dashboard includes:
- Orchestrator metadata (name, start time, project, base branch)
- Current wave progress
- Per-worker status table with test coverage columns
- Blocked waves with dependency information
- Timestamped event log

## Linear Integration

The orchestrator manages Linear state transitions as a safety net:

| Event | Linear Action |
|-------|--------------|
| Worker dispatched | Move ticket to `stateMap.inProgress` |
| Worker creates PR | Verify ticket is `stateMap.inReview` — fix if not |
| Worker passes verification | No change (already in review) |
| PR merged | Verify ticket is `stateMap.done` — fix if not |
| Worker fails/stalls | Add comment with status, keep `inProgress` |

The orchestrator also adds comments to tickets for visibility:
```bash
linearis comments create "${TICKET_ID}" \
  --body "Orchestrator [${ORCH_NAME}]: Worker dispatched. Phase: research."
```

## Named Orchestrators & Remote Control

Start the orchestrator with remote control for access from claude.ai/code:
```bash
claude --remote-control "${ORCH_NAME}" -w "${ORCH_DIR}"
```

Workers should NOT use remote control — they're autonomous. The human monitors workers
through the orchestrator's dashboard.

**Multiple orchestrators** can run concurrently. Worktree names are prefixed with the
orchestrator name to avoid collisions:
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

Workers write status updates to `${ORCH_DIR}/workers/${TICKET_ID}.json`. The `/oneshot`
skill detects orchestrator presence by checking for a sibling `orchestrator/` directory or
the `CATALYST_ORCHESTRATOR_DIR` environment variable.

**Worker signal file schema:** See `plugins/dev/templates/worker-signal.json` for the full
JSON schema including the `definitionOfDone` block.

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

## Error Handling

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

**Worktree conflicts:**
- If a worktree path already exists, skip creation and check if it's from a previous run
- If it has a valid worker signal file, treat as a resumed worker

## Important

- The orchestrator lives in its own worktree and **never modifies code**
- Workers are fully autonomous — they run `/oneshot` with all its phases
- Wave advancement requires ALL tickets in the wave to pass verification
- The `--auto-merge` flag applies to workers, not the orchestrator
- Dashboard and state files are ephemeral — they don't survive worktree removal
- Wave briefings are the key differentiator — knowledge compounds across waves
- The 3-layer testing enforcement prevents the observed failure mode of agents skipping tests
- CTL-26 dependency: Uses `.catalyst/` paths. Falls back to `.claude/` if `.catalyst/` doesn't exist
