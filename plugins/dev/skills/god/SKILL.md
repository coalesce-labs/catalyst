---
name: god
description:
  "Cross-project omniscient status view — like `top` for Catalyst work streams. **ALWAYS use when**
  the user says '/god', 'what's happening across projects', 'what's running', 'show me all active
  work', 'what orchestrators are active', 'what sessions are running', or asks a free-form question
  about cross-project Catalyst state (e.g. 'what PRs are open?', 'which workers are stuck?',
  'what happened in the last hour?'). Shows orchestrators with wave/worker progress, active PM and
  oneshot sessions with recency, and recent event activity (last 30 min) from the event log.
  Encodes all data-source locations and naming conventions as skill knowledge."
disable-model-invocation: false
allowed-tools: Read, Glob, Bash(ls *), Bash(find *), Bash(git *), Bash(gh *), Bash(jq *), Bash(linearis *), Bash(stat *), Bash(wc *), Bash(date *), Bash(tail *), Bash(cat *), Bash(plugins/dev/scripts/god-gather.sh *), Bash(kill *)
version: 1.0.0
---

# god — Cross-Project Omniscient Status View

Combines static state (where things are) with the live event log (how they got there and what's
happening right now). Default invocation produces a full dashboard; args narrow the scope or
switch interaction mode.

## Invocation

```
/god                        — full multi-project status dashboard
/god <project>              — filter to one project (e.g., adva, catalyst)
/god <orch-name>            — deep-dive into one orchestrator
/god restart                — list crashed/interrupted sessions with restart commands
free-form question          — "what PRs are open?", "which workers are stuck?",
                              "what happened in the last hour?"
```

## Data Sources

| Source | Path / Command | What it gives |
|---|---|---|
| Global orchestrator state | `~/catalyst/state.json` | All orchestrators, progress, worker map |
| Per-run state | `~/catalyst/runs/<orch-id>/state.json` | Wave breakdown, queue, current wave |
| Worker signal files | `~/catalyst/runs/<orch-id>/workers/*.json` | Phase, PR, heartbeat, needsAttention |
| Session database | `catalyst-session.sh list --active --json` | Active Claude sessions |
| Worktree inventory | `ls ~/catalyst/wt/` | Projects and their worktrees |
| Claude session recency | `ls -lt ~/.claude/projects/` | Which sessions were recently active (by mtime) |
| Event log | `~/catalyst/events/YYYY-MM.jsonl` | Last 30–60 min of activity |
| Orchestrator dashboard | `~/catalyst/runs/<orch-id>/DASHBOARD.md` | Human-readable orch summary |
| Rollup fragments | `~/catalyst/runs/<orch-id>/workers/<TICKET>-rollup.md` | Post-completion summaries |

### Naming conventions

- `~/catalyst/wt/<project>/` — top-level project directories (e.g., `adva/`, `catalyst-workspace/`)
- `orch-<slug>` — orchestrator leader worktree (no ticket suffix)
- `orch-<slug>-<TICKET>` — orchestrator worker worktree
- `PM` / `pm` — persistent PM session worktree
- `<TICKET>` (e.g., `ADV-454`) — standalone oneshot worktree
- `~/catalyst/runs/<orch-id>/` — orchestrator run state dir (matches `orch-<slug>` above)
- `~/.claude/projects/-Users-ryan-catalyst-wt-<project>-<worktree>/` — Claude Code session data

## Procedure

### Step 0: Parse invocation mode

Determine mode from the argument:
- No argument → **default dashboard**
- Known project directory name (matches `ls ~/catalyst/wt/`) → **project filter**
- Starts with `orch-` → **orchestrator deep-dive**
- Exactly `restart` → **restart mode**
- Otherwise → **free-form Q&A** (treat the full input as a question)

### Step 1: Run the data-gather helper

The helper script collects all state in one pass and outputs JSON:

```bash
plugins/dev/scripts/god-gather.sh 2>/dev/null
```

The script returns a JSON object with keys: `ts`, `projects`, `sessions`, `recentEvents`,
`global`. Parse it with `jq` for the sections you need.

If the helper is unavailable or errors, fall back to gathering data directly (see
**Manual fallback commands** below).

### Step 2: Present the dashboard

Format the output using the **Dashboard format** section below. Use the gathered JSON.

For project-filter mode, skip all sections not matching the requested project.
For orchestrator deep-dive, show the full worker table and the DASHBOARD.md contents.
For restart mode, follow the **Restart mode** section.
For free-form questions, answer naturally using the gathered data as context.

---

## Dashboard Format

Use Unicode box-drawing characters for section headers. Present in this order:

```
[as of 2026-05-07T11:44:00Z]

═══ ADVA (2 orchestrators, 1 PM, 1 oneshot) ═══

ORCH  orch-deal-to-opportunity-2026-04-24    Wave 2/7   active
  ├── ADV-462  pr-created   PR #291 ✅ CI passing
  ├── ADV-474  implementing  (no PR yet)
  └── ADV-475  implementing  (no PR yet)

ORCH  orch-industry-packs-2026-04-24         Wave 1/2   active
  ├── ADV-480  pr-created   PR #293 ❌ CI failing
  ├── ADV-481  researching
  ├── ADV-482  queued
  └── ADV-483  queued

PM    ~/catalyst/wt/adva/PM                  last active: 2 min ago
SHOT  ADV-454 (design tokens in docs)        last active: 8 min ago

═══ CATALYST (1 orchestrator, 1 PM) ═══

ORCH  orch-ctl-275-2026-05-07                Wave 1/2   active
  ├── CTL-280  done         PR #465 ✅ merged
  └── CTL-193  implementing  (no PR yet)

PM    ~/catalyst/wt/catalyst-workspace/PM    last active: 3 min ago

─── Recent activity (last 30 min) ─────────────────────────────

  ADV-480: implementing → pr-created [PR #293, CI pending]
  CTL-280: pr-created → done [PR #465 merged]
  github: 3× check_suite completed (2 passing, 1 failing)
  Linear: ADV-474 state → In Review
```

### Status icons

| CI state | Icon |
|---|---|
| passing / merged | ✅ |
| pending / in-progress | ⏳ |
| failing | ❌ |
| no PR yet / unknown | (omit icon) |

### Worker status values

Map signal-file `status` to display text:
- `dispatched` → `queued`
- `researching` → `researching`
- `planning` → `planning`
- `implementing` → `implementing`
- `validating` → `validating`
- `shipping` → `shipping`
- `pr-created` → `pr-created` (append PR info)
- `done` → `done`
- `failed` → `❌ failed`
- `stalled` → `⚠️ stalled`
- `deploy-failed` → `❌ deploy-failed`

Workers with `needsAttention: true` get a `⚠️` prefix regardless of status.

---

## Orchestrator Deep-Dive (`/god <orch-name>`)

When the arg matches an orchestrator name, show:

1. Header with orch ID, project, status, start time, elapsed
2. Wave breakdown table from per-run `state.json`:
   ```
   Wave 1/2  ✅ done   (CTL-275, CTL-276, CTL-277, CTL-278, CTL-279)
   Wave 2/2  🔵 active (CTL-280, CTL-193)
   ```
3. Full worker table with phase, PR, CI status, last heartbeat
4. Attention items if any
5. Contents of `~/catalyst/runs/<orch-id>/DASHBOARD.md` (verbatim, truncated to 60 lines)
6. Recent events for this orchestrator (last 60 min, filtered by `.orchestrator == "<orch-id>"`)

---

## Restart Mode (`/god restart`)

Show sessions that appear interrupted (were active but have no running process):

### Detection

```bash
# Find worker signal files with non-terminal status but stale heartbeat
find ~/catalyst/runs -name "*.json" -path "*/workers/*.json" 2>/dev/null | while read f; do
  jq -r --arg f "$f" \
    'select(.status != "done" and .status != "failed" and .status != null) |
     "\(.status) \(.lastHeartbeat // "unknown") \(.pid // "?") \(.ticket // .workerName) \($f)"' \
    "$f" 2>/dev/null
done
```

For each candidate:
1. Check if the PID is still running: `kill -0 <pid> 2>/dev/null && echo "running" || echo "dead"`
2. Calculate time since last heartbeat
3. Mark as crashed if: PID dead AND heartbeat > 15 min ago

For each crashed session, show the restart command:

```
⚠️  CTL-193 (implementing) — last heartbeat 42 min ago, PID 81220 dead
    Worktree: ~/catalyst/wt/catalyst-workspace/orch-ctl-275-2026-05-07-CTL-193
    Resume:   cd ~/catalyst/wt/catalyst-workspace/orch-ctl-275-2026-05-07-CTL-193
              claude --resume

⚠️  ADV-474 (planning) — last heartbeat 23 min ago, PID 79441 dead
    Resume:   cd ~/catalyst/wt/adva/orch-deal-to-opportunity-2026-04-24-ADV-474
              claude --resume
```

If no crashed sessions: print `✅ All active sessions appear healthy.`

---

## Free-Form Q&A

When the input is a question, gather the relevant data and answer naturally:

| Question type | Data to gather |
|---|---|
| "what PRs are open?" | `gh pr list --repo <each-repo>` or parse `pr` field from worker signal files |
| "which workers are stuck?" | Worker signal files where `needsAttention: true` or `status == "stalled"` |
| "what happened in the last hour?" | Event log tail, last 60 min |
| "which orchestrators are done?" | `state.json` orchestrators where `status == "completed"` |
| "how much did the last orch cost?" | `state.json` `.orchestrators[<orch-id>].usage.costUSD` |
| "what's the CI status of PR #N?" | `gh api repos/<repo>/pulls/<N>` |

Always gather the specific data first, then answer. Do not speculate from memory.

---

## Manual Fallback Commands

If `god-gather.sh` is unavailable:

```bash
# Global orchestrator state
cat ~/catalyst/state.json 2>/dev/null | jq '.orchestrators | to_entries[] | {
  id: .key,
  status: .value.status,
  projectKey: .value.projectKey,
  progress: .value.progress,
  worktreeDir: .value.worktreeDir
}' 2>/dev/null

# Worktree inventory
for project in $(ls ~/catalyst/wt/ 2>/dev/null); do
  echo "=== $project ==="; ls ~/catalyst/wt/"$project"/ 2>/dev/null
done

# Active sessions (if catalyst-session.sh is available)
SESS=$(ls ~/.claude/plugins/cache/catalyst/catalyst-dev/*/scripts/catalyst-session.sh 2>/dev/null | head -1)
[ -x "$SESS" ] && "$SESS" list --active --json 2>/dev/null | jq '.' || echo "session tracking unavailable"

# Recent Claude session activity (mtime of project dirs)
ls -lt ~/.claude/projects/ 2>/dev/null | grep "catalyst-wt" | head -15

# Recent events (last 30 min)
EVENTS_FILE=~/catalyst/events/$(date +%Y-%m).jsonl
if [ -f "$EVENTS_FILE" ]; then
  TOTAL=$(wc -l < "$EVENTS_FILE" | tr -d ' ')
  SINCE=$(( TOTAL > 2000 ? TOTAL - 2000 : 0 ))
  CUTOFF=$(date -u -v-30M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
           date -u --date='30 minutes ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)
  tail -n +"$((SINCE + 1))" "$EVENTS_FILE" 2>/dev/null | jq -c \
    --arg cutoff "$CUTOFF" '
    select(.ts >= $cutoff) | select(
      (.event | startswith("worker-")) or
      (.event | startswith("filter.wake")) or
      .event == "github.pr.merged" or
      .event == "github.check_suite.completed" or
      .event == "attention-raised" or
      .event == "linear.issue.state_changed" or
      (.event == "comms.message.posted" and (.detail.type // "") == "attention")
    )' 2>/dev/null
fi

# Per-run state (waves and worker list)
for STATE in $(find ~/catalyst/runs -name "state.json" -maxdepth 2 2>/dev/null); do
  jq '{run: .orchestrator, currentWave: .currentWave, totalWaves: .totalWaves, waves: [.waves[] | {wave: .wave, status: .status, tickets: .tickets}]}' "$STATE" 2>/dev/null
done

# Worker signal files for active orchestrators
find ~/catalyst/runs -name "*.json" -path "*/workers/*.json" -not -name "*-rollup.md" 2>/dev/null | \
  xargs jq -c '{ticket: .ticket, status: .status, phase: .phase, pr: .pr, needsAttention: .needsAttention, lastHeartbeat: .lastHeartbeat, pid: .pid}' 2>/dev/null
```

---

## Related

- `orchestrate` — launches multi-ticket orchestrators whose state `/god` reads
- `oneshot` — launches standalone workers whose state `/god` tracks
- `teardown` — archives completed orchestrators (moves them out of `~/catalyst/runs/`)
- [[monitor-events]] — event-log patterns and filter cookbook
- [[catalyst-filter]] — Groq-backed semantic event router (filter daemon)
- [[catalyst-comms]] — agent-to-agent pub/sub; `attention` posts surface in `/god restart`
- `CTL-282` — HUD-panel / 30-minute briefing variant of this skill (child ticket)
- `CTL-192` — session state tracking and crash-resilient restart (related)
