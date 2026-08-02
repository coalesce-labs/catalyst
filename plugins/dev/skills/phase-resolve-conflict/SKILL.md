---
name: phase-resolve-conflict
description: |
  Phase-agent that rebases a stalled ticket branch onto origin/main using the
  additive resolution guidance in `resolve-conflict-brief.json` (ADR-028,
  #1461). Dispatched by `resolve-conflict-sweep.mjs`'s mark-and-dispatch seam,
  through the standard `dispatch.mjs → phase-agent-dispatch` envelope, once
  `classifyMergeTree` has confirmed the stall is resolvable. Reads
  `${ORCH_DIR}/workers/<ticket>/resolve-conflict-brief.json`
  (conflictFiles/conflictTypes/base/attempt), resolves each conflict
  additively (preserving both sides' intent), runs a targeted gate, commits,
  and emits `phase.resolve-conflict.complete.<ticket>`. The sweep — not this
  skill — clears the original stalled phase's signal once it observes the
  complete event, dropping the ticket back into `isTicketInFlight`. Capped at
  3 attempts via `RESOLVE_CONFLICT_CYCLE_CAP`
  (env override `CATALYST_RESOLVE_CONFLICT_CYCLE_CAP`). Dispatched as a
  `claude --bg` job by `phase-agent-dispatch`, which invokes it via slash
  command — hence `user-invocable: true`.
user-invocable: true
disable-model-invocation: false  # invocable by model (Skill tool) AND user (slash command)
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Edit
  - Write
  - Task
---

# phase-resolve-conflict

Phase-agent that owns the **resolve** half of the resolve-conflict sweep
(ADR-028, #1461). Today a sibling-PR-merge source conflict stalls a ticket
generically (`stalledReason: source_conflict_ctl708_unavailable`, written at
dispatch-time pre-flight rebase for whichever phase — implement/verify/review
— was about to run) with no dedicated resolver: `unstuck-sweep`'s
`sourceConflictActSeam` (ADR-024) only force-pushes an already-clean branch
past a stale flag and throws on a genuine conflict, and `recovery-pass`
(ADR-025) tells its LLM to "resolve it yourself" ad hoc with no structured
brief or cycle cap. `resolve-conflict-sweep.mjs` closes that gap: it classifies
the live conflict with the existing, unmodified `classifyMergeTree`
(`stale-pr-rescue.mjs`), and only when the shape is resolvable does it mark
the stall `source_conflict_resolvable`, write `resolve-conflict-brief.json`,
and dispatch this skill. `phase-resolve-conflict` reads that brief, rebases
onto the base additively per the classified conflict files/types, runs a
targeted gate, commits, and hands back a `complete` event. The sweep's own
completions pass then clears the original phase's stalled signal — this skill
never redispatches the stalled phase itself. The loop repeats up to
`RESOLVE_CONFLICT_CYCLE_CAP` (default 3) attempts before escalating.

Like `phase-remediate`, there is **no canonical "resolve-conflict" skill** to
delegate to — the rebase/resolve work lives in this skill body. It is
otherwise the same fix-capable envelope (Edit/Write/Task, CTL-615 yield check,
CTL-632 Linear mirror, terminal emit).

## Prerequisites

- `CATALYST_ORCHESTRATOR_DIR`, `CATALYST_ORCHESTRATOR_ID`, `CATALYST_PHASE=resolve-conflict`, `CATALYST_TICKET` set by [[phase-agent-dispatch]].
- A `resolve-conflict-brief.json` exists at `${ORCH_DIR}/workers/<ticket>/resolve-conflict-brief.json` — the dispatcher's prior-artifact gate (`signal:resolve-conflict-brief.json`, wired in `lib/phase-artifact-gate.sh`) already validates this; this skill re-reads it.
- Current working directory is the ticket's worktree — the branch that failed its original phase's dispatch-time pre-flight rebase and is now stalled mid-conflict-classification.

## Prelude (template — copy verbatim into the running session)

```bash
set -euo pipefail

: "${CATALYST_ORCHESTRATOR_DIR:?required (set by phase-agent-dispatch)}"
: "${CATALYST_ORCHESTRATOR_ID:?required}"
: "${CATALYST_PHASE:?required}"
: "${CATALYST_TICKET:?required}"

ORCH_DIR="$CATALYST_ORCHESTRATOR_DIR"
ORCH_ID="$CATALYST_ORCHESTRATOR_ID"
PHASE="$CATALYST_PHASE"
TICKET="$CATALYST_TICKET"
CHANNEL="${ORCH_ID}"

SIGNAL_FILE="${ORCH_DIR}/workers/${TICKET}/phase-${PHASE}.json"
[[ -f "$SIGNAL_FILE" ]] || { echo "phase-${PHASE}: signal file missing" >&2; exit 1; }

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
[[ -n "$PLUGIN_ROOT" ]] || PLUGIN_ROOT="$(dirname "$(dirname "$(dirname "$(realpath "${BASH_SOURCE[0]:-$0}" 2>/dev/null || echo .)")")")"

# 0. Codified bg_job_id yield (CTL-615). If the signal file's bg_job_id names a
#    DIFFERENT live bg job, we are a redispatch duplicate of a still-running
#    canonical worker. Bow out without touching the signal, without emitting any
#    phase event. Encodes operator memories #43/#44/#49/#50. phase-resolve-conflict
#    commits code (like implement/remediate), so it carries the gate.
YIELD_CHECK="${PLUGIN_ROOT}/scripts/phase-agent-yield-check.sh"
if [[ -x "$YIELD_CHECK" ]] && bash "$YIELD_CHECK" \
     --signal "$SIGNAL_FILE" \
     --phase "$PHASE" \
     --worker-dir "$(dirname "$SIGNAL_FILE")"; then
  echo "phase-${PHASE}: yielding to canonical worker (CTL-615)" >&2
  exit 0
fi

# 1. Join the shared comms channel (best-effort).
COMMS="${PLUGIN_ROOT}/scripts/catalyst-comms"
[[ -x "$COMMS" ]] || COMMS="$(command -v catalyst-comms 2>/dev/null || true)"
if [[ -n "$COMMS" && -x "$COMMS" ]]; then
  "$COMMS" join "$CHANNEL" --as "$TICKET" \
    --capabilities "phase-resolve-conflict: ${TICKET}" \
    --orch "$ORCH_ID" --parent orchestrator --ttl 3600 >/dev/null 2>&1 || true
  "$COMMS" send "$CHANNEL" "phase-resolve-conflict started" --as "$TICKET" --type info \
    --orch "$ORCH_ID" >/dev/null 2>&1 || true
fi

# 2. Start a catalyst-session for cost/token instrumentation.
SESSION_SCRIPT="${PLUGIN_ROOT}/scripts/catalyst-session.sh"
if [[ -x "$SESSION_SCRIPT" ]]; then
  CATALYST_SESSION_ID=$("$SESSION_SCRIPT" start \
    --skill "phase-resolve-conflict" \
    --ticket "$TICKET" \
    --workflow "${CATALYST_SESSION_ID:-}")
  export CATALYST_SESSION_ID
fi

# 3. Mark the signal file as running + persist catalystSessionId (CTL-496:
#    orchestrate-roll-usage --phase reads this to attribute cost).
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TMP="${SIGNAL_FILE}.tmp.$$"
jq --arg ts "$TS" --arg sid "${CATALYST_SESSION_ID:-}" '
  .status = "running"
  | .updatedAt = $ts
  | if $sid != "" then .catalystSessionId = $sid else . end
' "$SIGNAL_FILE" > "$TMP" \
  && mv "$TMP" "$SIGNAL_FILE"

# CTL-587: test-kill after-prelude. Exits AFTER the signal is flipped to running
# but BEFORE any commit work, so reclaimDeadWorkIfPossible's probe returns false
# on the next staleness tick and the revive path engages. Mode suffix
# `${PHASE}:after-prelude` keeps the env var phase-agnostic.
if [[ "${CATALYST_TEST_KILL_PHASE:-}" == "${PHASE}:after-prelude" ]]; then
  echo "[CTL-587 test-kill] aborting after prelude" >&2
  exit 137
fi

# 4. Locate resolve-conflict-brief.json — the resolve brief. The dispatcher
#    already gated on its existence (signal:resolve-conflict-brief.json); we
#    re-read it to extract the stalled phase, base, and conflict evidence.
BRIEF="${ORCH_DIR}/workers/${TICKET}/resolve-conflict-brief.json"
[[ -f "$BRIEF" ]] || { echo "phase-resolve-conflict: resolve-conflict-brief.json missing for ${TICKET}" >&2; exit 1; }
STALLED_PHASE="$(jq -r '.stalledPhase' "$BRIEF")"
BASE_REF="$(jq -r '.base' "$BRIEF")"
CONFLICT_FILES="$(jq -r '.conflictFiles[]?' "$BRIEF")"
CONFLICT_TYPES="$(jq -r '.conflictTypes[]?' "$BRIEF")"
echo "phase-resolve-conflict: ${TICKET} stalled on ${STALLED_PHASE}; base=${BASE_REF}"
echo "phase-resolve-conflict: conflict files: ${CONFLICT_FILES}"
echo "phase-resolve-conflict: conflict types: ${CONFLICT_TYPES}"

# 5. Linear status is written by the coordinator (mirrors CTL-558's pattern
#    for phase-remediate): the execution-core scheduler / resolve-conflict-sweep
#    owns any Linear state transition around this dispatch. The phase agent
#    itself never transitions Linear.
```

## /goal condition

Transcript-evaluable so a `/goal` evaluator (which only sees Claude's text
output, not the filesystem) can decide pass/fail from what the agent prints.

```
/goal "I have rebased this branch onto ${BASE_REF} (origin/main), resolved the
       conflicts in the files resolve-conflict-brief.json named additively
       (preserving both sides' intent — a content conflict keeps both edits
       where they don't logically collide; an add/add conflict keeps both
       files, renaming if the same path was independently added), run a
       targeted gate (tsc/test/lint) on the touched files showing exit 0, and
       committed so `git diff <base>..HEAD` includes the resolution. The
       resolve-conflict-sweep clears the original stall once it sees
       phase.resolve-conflict.complete — I do NOT redispatch the stalled phase
       myself. (Linear status is written by the coordinator, not this agent.)"
```

## Phase-specific work

Resolve-conflict is **fix-capable** and reads `resolve-conflict-brief.json` as
its brief. There is no canonical wrapper — do the resolution work here:

1. Fetch and rebase: `git fetch origin ${BASE_REF}` then `git rebase origin/${BASE_REF}`.
2. On each conflict, resolve ADDITIVELY per the conflict type resolve-conflict-brief.json
   named: for a `content` conflict, read both sides and merge them so neither
   ticket's change is silently dropped (this is bounded — the brief's
   `classifyMergeTree` gate already confirmed only `content`/`add/add` types and a
   file count within the cap; if a conflict marker is found that ISN'T one of
   these types, STOP and emit `failed` — see Failure handling, do not attempt an
   unbounded resolution). For `add/add`, keep both files; rename one if the same
   logical path was independently created for two different purposes.
3. `git rebase --continue` after each resolution; repeat until the rebase completes.
4. Run the targeted gate (tsc/test/lint scoped to the resolved files, e.g. via
   `/catalyst-dev:validate-type-safety` scoped to the diff) and print its `exit 0`.
5. The rebase itself IS the "commit" here (no separate fix-commit like remediate —
   the resolution lands as part of the rebased history). Force-push is NOT this
   skill's job — the redispatched phase (after the sweep clears the stall) will
   push normally as part of its own work.

## End block (terminal emit — copy verbatim)

Mirror the phase output to Linear as a single comment (CTL-632). Re-derives the
commit list at end-block time, falling back to `_base branch unknown_` if
neither `origin/main` nor `main` exists. Fail-open and idempotent via the
per-phase marker file. Uniquely-named fence so the e2e test can extract just
this block.

```bash phase-resolve-conflict-mirror
LINEAR_MIRROR_MARKER="${ORCH_DIR}/workers/${TICKET}/.linear-mirror-${PHASE}"
if [[ ! -e "${LINEAR_MIRROR_MARKER}" ]]; then
  BASE_REF=""
  if git rev-parse --verify --quiet origin/main >/dev/null 2>&1; then
    BASE_REF="origin/main"
  elif git rev-parse --verify --quiet main >/dev/null 2>&1; then
    BASE_REF="main"
  fi
  BASE_SHA=""
  if [[ -n "${BASE_REF}" ]]; then
    BASE_SHA="$(git merge-base HEAD "${BASE_REF}" 2>/dev/null || true)"
  fi
  if [[ -n "${BASE_SHA}" ]]; then
    COMMIT_LIST="$(git log --no-merges --oneline "${BASE_SHA}..HEAD" 2>/dev/null | sed 's/^/- /')"
    COMMIT_COUNT="$(printf '%s\n' "${COMMIT_LIST}" | grep -c '^- ' || true)"
    : "${COMMIT_COUNT:=0}"
    DIFF_STAT="$(git diff --stat "${BASE_SHA}..HEAD" 2>/dev/null | tail -1)"
    NAME_STATUS="$(git diff --name-status "${BASE_SHA}..HEAD" 2>/dev/null)"
    FILES_ADDED="$(printf '%s\n' "${NAME_STATUS}" | grep -c '^A' || true)"
    FILES_MODIFIED="$(printf '%s\n' "${NAME_STATUS}" | grep -c '^M' || true)"
    FILES_DELETED="$(printf '%s\n' "${NAME_STATUS}" | grep -c '^D' || true)"
    LINES_ADDED="$(git diff --numstat "${BASE_SHA}..HEAD" 2>/dev/null | awk '$1 ~ /^[0-9]+$/ {a+=$1} END {print a+0}')"
    LINES_DELETED="$(git diff --numstat "${BASE_SHA}..HEAD" 2>/dev/null | awk '$2 ~ /^[0-9]+$/ {d+=$2} END {print d+0}')"
  else
    COMMIT_LIST="_base branch unknown_"
    COMMIT_COUNT="?"
    DIFF_STAT="_unavailable_"
    FILES_ADDED="?"; FILES_MODIFIED="?"; FILES_DELETED="?"
    LINES_ADDED="?"; LINES_DELETED="?"
  fi
  BRANCH_NAME="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "${TICKET}")"
  CONFLICT_FILES_JOINED="$(jq -r '.conflictFiles // [] | join(", ")' "${ORCH_DIR}/workers/${TICKET}/resolve-conflict-brief.json" 2>/dev/null || echo "?")"
  MIRROR_BODY="$(cat <<EOF
**Phase Resolve-Conflict**

- **Branch**: \`${BRANCH_NAME}\`
- **Commits**: ${COMMIT_COUNT}
- **Files**: ${FILES_ADDED} added, ${FILES_MODIFIED} modified, ${FILES_DELETED} deleted
- **Lines**: +${LINES_ADDED} / -${LINES_DELETED}
- **Diff**: ${DIFF_STAT}
- **Resolved conflict in**: ${CONFLICT_FILES_JOINED}

<details>
<summary>Commit list</summary>

${COMMIT_LIST}

</details>

_Posted automatically by phase-resolve-conflict (ADR-028 / CTL-632). The
resolve-conflict-sweep clears the original stall on this complete event and
redispatches the phase that stalled; the resolve-conflict cycle caps at
RESOLVE_CONFLICT_CYCLE_CAP (default 3)._
EOF
)"
  MIRROR_FOOTER=""
  if [[ -n "${PLUGIN_ROOT:-}" && -x "${PLUGIN_ROOT}/scripts/lib/phase-mirror-footer.sh" ]]; then
    MIRROR_FOOTER="$("${PLUGIN_ROOT}/scripts/lib/phase-mirror-footer.sh" --orch-dir "${ORCH_DIR}" --ticket "${TICKET}" --phase "${PHASE}" 2>/dev/null || true)"
  fi
  [[ -n "${MIRROR_FOOTER}" ]] && MIRROR_BODY="${MIRROR_BODY}
${MIRROR_FOOTER}"
  if [[ ${#MIRROR_BODY} -gt 30000 ]]; then
    MIRROR_BODY="${MIRROR_BODY:0:30000}

_... (truncated)_"
  fi
  COMMENT_POST="${CATALYST_COMMENT_POST_HELPER:-${PLUGIN_ROOT}/scripts/lib/linear-comment-post.sh}"
  if [[ ! -x "$COMMENT_POST" ]]; then COMMENT_POST="$(command -v linear-comment-post.sh 2>/dev/null || true)"; fi
  if [[ -n "$COMMENT_POST" && -x "$COMMENT_POST" ]] && "$COMMENT_POST" "${TICKET}" "${MIRROR_BODY}" >/dev/null; then
    : > "${LINEAR_MIRROR_MARKER}"
  else
    echo "phase-resolve-conflict: linear-comment-post failed (continuing)" >&2
  fi
fi
```

Then the empty-branch self-emit gate (CTL-608). Runs **before** the terminal
`--status complete` so a worker cannot self-report resolve-conflict success on
an empty ticket branch (0 commits ahead of its integration base). Uses only
POSIX/zsh-safe `git rev-list --count`. Fail-open (warn + allow) only when the
base is unresolvable. Uniquely-named fence so the e2e harness can
extract+exercise it.

```bash phase-resolve-conflict-empty-branch-gate
EMPTY_BRANCH_GATE_BASE=""
if git rev-parse --verify --quiet origin/main >/dev/null 2>&1; then
  EMPTY_BRANCH_GATE_BASE="origin/main"
elif git rev-parse --verify --quiet main >/dev/null 2>&1; then
  EMPTY_BRANCH_GATE_BASE="main"
fi
if [[ -n "${EMPTY_BRANCH_GATE_BASE}" ]]; then
  AHEAD="$(git rev-list --count "${EMPTY_BRANCH_GATE_BASE}..HEAD" 2>/dev/null || echo 0)"
  if [[ "${AHEAD:-0}" -le 0 ]]; then
    echo "phase-resolve-conflict: 0 commits ahead of ${EMPTY_BRANCH_GATE_BASE}; refusing to emit complete on an empty branch (CTL-608)" >&2
    "${PLUGIN_ROOT}/scripts/phase-agent-emit-complete" \
      --phase "$PHASE" --ticket "$TICKET" --status failed \
      --reason "empty_branch:0_commits_ahead_of_${EMPTY_BRANCH_GATE_BASE}"
    [[ -n "$COMMS" && -x "$COMMS" ]] && "$COMMS" send "$CHANNEL" \
      "phase-resolve-conflict failed: empty branch (0 commits ahead of ${EMPTY_BRANCH_GATE_BASE})" \
      --as "$TICKET" --type attention --orch "$ORCH_ID" >/dev/null 2>&1 || true
    exit 1
  fi
else
  echo "phase-resolve-conflict: could not resolve integration base (no origin/main or main); skipping empty-branch gate (CTL-608)" >&2
fi
```

```bash
EMIT="${PLUGIN_ROOT}/scripts/phase-agent-emit-complete"
if [[ -x "$EMIT" ]]; then
  # No --reason on success: phase-agent-emit-complete stamps --reason into
  # .failureReason even on --status complete (operator memory).
  "$EMIT" --phase "$PHASE" --ticket "$TICKET" --status complete
fi
[[ -n "$COMMS" && -x "$COMMS" ]] && "$COMMS" done "$CHANNEL" --as "$TICKET" >/dev/null 2>&1 || true
```

## Failure handling

One failure mode — hard error (caller-supplied reason). When escalating to
`stalled`/`needs-human`, populate an `explanation` block per CTL-1130 using
the CLI shim (always exits 0; degrades gracefully on bad input):

```bash
REASON="${1:-conflict resolution failed}"  # caller-supplied short string

# ADR-028: AUTHORIZATION — the agent can re-attempt resolution; only an
# out-of-scope conflict shape or an exhausted cycle budget stops it.
EXPL_JSON="$(node "${PLUGIN_ROOT}/scripts/execution-core/escalation-explain.mjs" \
  --ticket "$TICKET" --phase "$PHASE" \
  --type authorization \
  --problem "resolve-conflict failed: ${REASON}" \
  --call-to-action "should ${TICKET}'s rebase onto ${BASE_REF:-origin/main} be resolved manually, or should the resolve-conflict cycle cap be raised?" \
  --recommendation "resolve the remaining conflict manually in the ${TICKET} worktree, then let the sweep clear the stall on the next tick" \
  --risk "a conflict type outside {content, add/add} surfaced mid-rebase, or a third conflict wave appeared after the classified files were resolved — attempting an unbounded resolution risks silently dropping one side's change" \
  --why-asking "risk-authority gate, not a capability gap" \
  --authorize-label "manually resolve ${TICKET}" \
  --could-higher-tier-resolve false \
  --can-execute true \
  2>/dev/null || echo '{}')"

# Hard-error: emit failed + attention, exit non-zero. A `failed` event lets
# the FSM revive resolve-conflict once (REVIVE_BUDGET) before stalling —
# distinct from the sweep's own cycle counter (RESOLVE_CONFLICT_CYCLE_CAP),
# which counts `complete` events via `countResolveConflictCycles`.
"$EMIT" --phase "$PHASE" --ticket "$TICKET" --status failed --reason "$REASON"
[[ -n "$COMMS" && -x "$COMMS" ]] && "$COMMS" send "$CHANNEL" \
  "phase-resolve-conflict failed: ${REASON}" \
  --as "$TICKET" --type attention --orch "$ORCH_ID" >/dev/null 2>&1 || true
exit 1
```

The orchestrator receives `phase.resolve-conflict.complete.${TICKET}` and
`resolve-conflict-sweep.mjs`'s own completions pass
(`defaultCollectResolveConflictCompletions`) — not this skill — finds the
`phase-resolve-conflict.json` signal at `status:"done"`, reads
`resolve-conflict-brief.json.stalledPhase`, and mechanically clears that
phase's own stalled signal, dropping the ticket back into `isTicketInFlight`
so the ordinary dispatch loop redispatches the phase that originally stalled.
`countResolveConflictCycles` counts this `complete` event toward
`RESOLVE_CONFLICT_CYCLE_CAP` (default 3, env override
`CATALYST_RESOLVE_CONFLICT_CYCLE_CAP`); cap-exhausted routes to
`stalledReason: resolve-conflict-cycle-cap-exhausted` and an escalation
comment instead of another resolve-conflict dispatch — the sole human entry
for this path.

## Comms discipline

Inherits the contract from [[_phase-agent-template]]:

| Type        | When                                                                                  |
|-------------|--------------------------------------------------------------------------------------|
| `info`      | At start; once after the rebase resolution completes and the targeted gate passes. |
| `attention` | Missing resolve-conflict-brief.json, an out-of-scope conflict type, hard error. (Turn caps are enforced daemon-side — CTL-748 — not self-detected by this skill.) |
| `question`  | A conflict the agent cannot resolve unilaterally without dropping one side's intent. |
| `done`      | Emitted by `phase-agent-emit-complete` on success.                                   |

Read inbound `directive` / `pause` / `abort` after each resolution round — the
orchestrator may abort the worker while resolution is in flight.

## Why this sweep, not a `deriveAdvancement` detour

`isTicketInFlight` excludes any `stalled` ticket, so `deriveAdvancement`'s
verify⇄remediate-style router (CTL-653) never sees a ticket stalled on
`source_conflict_ctl708_unavailable` in the first place — a
`deriveAdvancement` branch, as #1461 originally proposed, cannot reach these
tickets without threading the in-flight gate itself. ADR-028 (`docs/adrs.md`)
instead runs `resolve-conflict-sweep.mjs` as its own dedicated tick-loop pass,
structurally mirroring `stall-janitor`/`unstuck-sweep` (ADR-024): it scans
stalled signals directly, re-classifies the live conflict with the existing
`classifyMergeTree`, and only dispatches this skill once that classification
says the shape is resolvable. This skill is the worker that sweep dispatches;
because the original stall reason is written generically at dispatch time for
whichever phase was about to run, the sweep — and this skill — cover
implement/verify/review uniformly by construction, with no FSM predecessor
changes needed. See `docs/adrs.md`'s "ADR-028: Deterministic resolvable-conflict
sweep" section for the full design and rejected alternatives.
