---
name: phase-remediate
description: |
  Phase-agent that fixes a failing verify verdict so the pipeline self-heals
  instead of stalling to needs-human (CTL-653). Reads
  `${ORCH_DIR}/workers/<ticket>/verify.json`, fixes the `findings[]` (every
  severity:"high" plus the regression_risk drivers) directly via Edit/Write,
  commits the remediation, and emits `phase.remediate.complete.<ticket>`. The
  scheduler's router then re-dispatches `verify` to re-check (the verify⇄remediate
  cycle, cap 3). Dispatched as a `claude --bg` job by `phase-agent-dispatch`,
  which invokes it via slash command — hence `user-invocable: true`.
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

# phase-remediate

Phase-agent that owns the **fix** half of the verify⇄remediate cycle (CTL-653).
Today a failing `verify` is a dead-end: the router marches into `review` against
a known-bad branch, or a verify crash revives once then stalls to needs-human.
`phase-remediate` is the conditional detour the router takes when `verify`
produces a verdict-fail (`regression_risk ≥ 5` OR any `severity:"high"`
finding): it reads `verify.json.findings[]` as its brief, fixes the code,
commits, and hands back to a fresh `verify`. The loop repeats up to 3 times
before escalating — so a verify failure self-heals autonomously.

Unlike `phase-implement` (a thin wrapper around `/catalyst-dev:implement-plan`),
there is **no canonical "fix-findings" skill** to delegate to — the fix work
lives in this skill body. It is otherwise the same fix-capable envelope
(Edit/Write/Task, CTL-615 yield check, CTL-632 Linear mirror, terminal emit).

## Prerequisites

- `CATALYST_ORCHESTRATOR_DIR`, `CATALYST_ORCHESTRATOR_ID`, `CATALYST_PHASE=remediate`, `CATALYST_TICKET` set by [[phase-agent-dispatch]].
- A `verify.json` exists at `${ORCH_DIR}/workers/<ticket>/verify.json` — the dispatcher's prior-artifact gate (`signal:verify.json`) already validates this; this skill re-reads it.
- Current working directory is the ticket's worktree (already carries the implement-phase commits).

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

# CTL-484: continuation-worker orientation. Set by orchestrate-revive's
# continuation branch when this skill is resumed via `claude --bg --resume`
# after a previous session hit its /goal turn cap. Read the handoff doc and
# trust its summary instead of re-deriving the fix set from scratch.
if [[ "${CATALYST_IS_CONTINUATION:-}" == "true" ]]; then
  CONT_HANDOFF="${CATALYST_HANDOFF_PATH:-}"
  CONT_N="${CATALYST_CONTINUATION_COUNT:-?}"
  if [[ -n "$CONT_HANDOFF" && -f "$CONT_HANDOFF" ]]; then
    echo "phase-remediate: continuation #${CONT_N} — resuming from ${CONT_HANDOFF}"
    echo "phase-remediate: reading handoff (do NOT re-derive the fix set from scratch)"
    cat "$CONT_HANDOFF"
  else
    echo "warn: CATALYST_IS_CONTINUATION=true but handoff path missing or unreadable" >&2
  fi
fi

SIGNAL_FILE="${ORCH_DIR}/workers/${TICKET}/phase-${PHASE}.json"
[[ -f "$SIGNAL_FILE" ]] || { echo "phase-${PHASE}: signal file missing" >&2; exit 1; }

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
[[ -n "$PLUGIN_ROOT" ]] || PLUGIN_ROOT="$(dirname "$(dirname "$(dirname "$(realpath "${BASH_SOURCE[0]:-$0}" 2>/dev/null || echo .)")")")"

# 0. Codified bg_job_id yield (CTL-615). If the signal file's bg_job_id names a
#    DIFFERENT live bg job, we are a redispatch duplicate of a still-running
#    canonical worker. Bow out without touching the signal, without emitting any
#    phase event. Encodes operator memories #43/#44/#49/#50. phase-remediate
#    commits code (like implement), so it carries the gate.
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
    --capabilities "phase-remediate: ${TICKET}" \
    --orch "$ORCH_ID" --parent orchestrator --ttl 3600 >/dev/null 2>&1 || true
  "$COMMS" send "$CHANNEL" "phase-remediate started" --as "$TICKET" --type info \
    --orch "$ORCH_ID" >/dev/null 2>&1 || true
fi

# 2. Start a catalyst-session for cost/token instrumentation.
SESSION_SCRIPT="${PLUGIN_ROOT}/scripts/catalyst-session.sh"
if [[ -x "$SESSION_SCRIPT" ]]; then
  CATALYST_SESSION_ID=$("$SESSION_SCRIPT" start \
    --skill "phase-remediate" \
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
# but BEFORE any commit work, so reclaimDeadWorkIfPossible's remediate-probe
# returns false on the next staleness tick and the revive path engages. Mode
# suffix `${PHASE}:after-prelude` keeps the env var phase-agnostic.
if [[ "${CATALYST_TEST_KILL_PHASE:-}" == "${PHASE}:after-prelude" ]]; then
  echo "[CTL-587 test-kill] aborting after prelude" >&2
  exit 137
fi

# 4. Locate verify.json — the fix brief. The dispatcher already gated on its
#    existence; we re-read to extract the findings + regression_risk.
VERIFY_ARTIFACT="${ORCH_DIR}/workers/${TICKET}/verify.json"
[[ -f "$VERIFY_ARTIFACT" ]] || { echo "phase-remediate: verify.json missing for ${TICKET}" >&2; exit 1; }
REGRESSION_RISK="$(jq -r '.regression_risk // 0' "$VERIFY_ARTIFACT")"
HIGH_COUNT="$(jq -r '[.findings[]? | select(.severity == "high")] | length' "$VERIFY_ARTIFACT")"
echo "phase-remediate: verify.json = ${VERIFY_ARTIFACT} (regression_risk=${REGRESSION_RISK}, high findings=${HIGH_COUNT})"
jq -r '.findings[]? | "- [\(.severity)] \(.kind) \(.file // "?"):\(.line // "?") — \(.message)\n    fix: \(.recommendation // "(none)")"' "$VERIFY_ARTIFACT" || true

# 5. Linear status is written by the coordinator (CTL-558): the execution-core
#    scheduler applies the `remediating` → Remediate state when it dispatches
#    this phase. The phase agent no longer transitions Linear itself.
```

## /goal condition

Transcript-evaluable so a `/goal` evaluator (which only sees Claude's text
output, not the filesystem) can decide pass/fail from what the agent prints.

```
/goal "I have read verify.json's findings[] and addressed every severity:high
       finding (plus the lower-severity regression_risk drivers I can fix
       deterministically), committed the remediation so `git diff <base>..HEAD`
       includes my new fix commit, and printed the commit subject + a targeted
       gate (tsc/test/lint on the touched files) showing `exit 0` to my
       transcript. The router re-dispatches `verify` to re-check the whole
       diff (CTL-653) — I do NOT re-run the full verify suite myself.
       (Linear status is written by the coordinator — CTL-558 — not this agent.)"
```

## Phase-specific work

Remediate is **fix-capable** and reads `verify.json.findings[]` as its brief.
There is no canonical wrapper — do the fix work here:

1. **Triage the findings.** Order by severity (every `severity:"high"` is
   must-fix) and by `kind` (`type` / `test` / `lint` / `security` /
   `reward-hacking` are deterministic; `review` / `coverage` / `silent-failure`
   may need judgment). Each finding carries `file`, `line`, `message`, and a
   `recommendation` — that recommendation is what `phase-verify` asks for.

2. **Apply the fixes** via Edit/Write directly on the named files. Stay scoped
   to what the findings call out — phase-remediate is a fix pass, not a redesign.
   If a finding is a false positive or already addressed on HEAD, note it in the
   transcript and skip it (do not fabricate a change to satisfy it).

3. **Re-run the targeted gates** for the files you touched (the project's tsc /
   test / lint, e.g. via `/catalyst-dev:validate-type-safety` scoped to the
   diff). Print the command and its `exit 0` to the transcript so `/goal` has
   signal. You do NOT need to re-run the full eight-gate verify suite — that is
   the next `verify` pass's job (the router cycles back to it).

4. **Commit the remediation** as a discrete commit, e.g.
   `fix(<scope>): ${TICKET} remediate verify findings (regression_risk N)`.
   The empty-branch gate below refuses to emit complete on a branch with zero
   commits ahead of the integration base.

> **Why remediate always emits `complete` (not `failed`) on a normal run.**
> Mirroring `phase-verify`'s always-`complete` semantics: the *verdict* lives in
> the re-run `verify.json`, not in this phase's status. The router re-verifies
> after every remediation and the cycle counter (cap 3) owns escalation — so a
> remediation that did not fully fix the issue is caught by the next `verify`,
> not by emitting `failed` here. `--status failed` is reserved for remediation
> *itself* breaking (the failure-handling block below).

## End block (terminal emit — copy verbatim)

Mirror the phase output to Linear as a single comment (CTL-632). Re-derives the
commit list at end-block time, falling back to `_base branch unknown_` if
neither `origin/main` nor `main` exists. Fail-open and idempotent via the
per-phase marker file. Uniquely-named fence so the e2e test can extract just
this block.

```bash phase-remediate-mirror
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
  REGRESSION_RISK="$(jq -r '.regression_risk // "?"' "${ORCH_DIR}/workers/${TICKET}/verify.json" 2>/dev/null || echo "?")"
  MIRROR_BODY="$(cat <<EOF
**Phase Remediate**

- **Branch**: \`${BRANCH_NAME}\`
- **Commits**: ${COMMIT_COUNT}
- **Files**: ${FILES_ADDED} added, ${FILES_MODIFIED} modified, ${FILES_DELETED} deleted
- **Lines**: +${LINES_ADDED} / -${LINES_DELETED}
- **Diff**: ${DIFF_STAT}
- **Acted on verify.json regression_risk**: ${REGRESSION_RISK}

<details>
<summary>Commit list</summary>

${COMMIT_LIST}

</details>

_Posted automatically by phase-remediate (CTL-653 / CTL-632). The router
re-dispatches verify to re-check; the verify⇄remediate cycle caps at 3._
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
    echo "phase-remediate: linear-comment-post failed (continuing)" >&2
  fi
fi
```

Then the empty-branch self-emit gate (CTL-608). Runs **before** the terminal
`--status complete` so a worker cannot self-report remediate success on an empty
ticket branch (0 commits ahead of its integration base). Uses only POSIX/zsh-safe
`git rev-list --count`. Fail-open (warn + allow) only when the base is
unresolvable. Uniquely-named fence so the e2e harness can extract+exercise it.

```bash phase-remediate-empty-branch-gate
EMPTY_BRANCH_GATE_BASE=""
if git rev-parse --verify --quiet origin/main >/dev/null 2>&1; then
  EMPTY_BRANCH_GATE_BASE="origin/main"
elif git rev-parse --verify --quiet main >/dev/null 2>&1; then
  EMPTY_BRANCH_GATE_BASE="main"
fi
if [[ -n "${EMPTY_BRANCH_GATE_BASE}" ]]; then
  AHEAD="$(git rev-list --count "${EMPTY_BRANCH_GATE_BASE}..HEAD" 2>/dev/null || echo 0)"
  if [[ "${AHEAD:-0}" -le 0 ]]; then
    echo "phase-remediate: 0 commits ahead of ${EMPTY_BRANCH_GATE_BASE}; refusing to emit complete on an empty branch (CTL-608)" >&2
    "${PLUGIN_ROOT}/scripts/phase-agent-emit-complete" \
      --phase "$PHASE" --ticket "$TICKET" --status failed \
      --reason "empty_branch:0_commits_ahead_of_${EMPTY_BRANCH_GATE_BASE}"
    [[ -n "$COMMS" && -x "$COMMS" ]] && "$COMMS" send "$CHANNEL" \
      "phase-remediate failed: empty branch (0 commits ahead of ${EMPTY_BRANCH_GATE_BASE})" \
      --as "$TICKET" --type attention --orch "$ORCH_ID" >/dev/null 2>&1 || true
    exit 1
  fi
else
  echo "phase-remediate: could not resolve integration base (no origin/main or main); skipping empty-branch gate (CTL-608)" >&2
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
`stalled`/`needs-human`, populate an `explanation` block per CTL-1065 using
the CLI shim (always exits 0; degrades gracefully on bad input):

```bash
REASON="${1:-remediation failed}"  # caller-supplied short string

# CTL-1130: AUTHORIZATION — agent can re-remediate; only regression risk stops it.
EXPL_JSON="$(node "${PLUGIN_ROOT}/scripts/execution-core/escalation-explain.mjs" \
  --ticket "$TICKET" --phase "$PHASE" \
  --type authorization \
  --problem "remediation failed: ${REASON}" \
  --call-to-action "should ${TICKET} be re-remediated manually, or should verify findings be waived?" \
  --recommendation "re-run verify with the updated remediation" \
  --risk "${REGRESSION_RISK:+regression_risk ${REGRESSION_RISK} with ${HIGH_COUNT:-?} HIGH finding(s) — merging risks a regression}${REGRESSION_RISK:-remediation budget exhausted with unresolvable verify failures}" \
  --why-asking "risk-authority gate, not a capability gap" \
  --authorize-label "re-remediate ${TICKET}" \
  --could-higher-tier-resolve false \
  --can-execute true \
  2>/dev/null || echo '{}')"

# Hard-error: emit failed + attention, exit non-zero. A `failed` event lets
# the FSM revive remediate once (REVIVE_BUDGET) before stalling — distinct
# from the verdict-cycle cap, which counts `complete` events.
"$EMIT" --phase "$PHASE" --ticket "$TICKET" --status failed --reason "$REASON"
[[ -n "$COMMS" && -x "$COMMS" ]] && "$COMMS" send "$CHANNEL" \
  "phase-remediate failed: ${REASON}" \
  --as "$TICKET" --type attention --orch "$ORCH_ID" >/dev/null 2>&1 || true
exit 1
```

The orchestrator receives `phase.remediate.complete.${TICKET}` and the
scheduler's router (`deriveAdvancement` + `maybeResetForRemediateCycle`,
CTL-653) deletes the verify+remediate cycle signals and re-dispatches a fresh
`verify`. `countRemediateCycles` counts this `complete` event toward the cap of
3; the 3rd remediation is still re-verified, and only a verify verdict-fail
*after* the budget is spent escalates to `stalled` → `needs-human` (the sole
human entry).

## Comms discipline

Inherits the contract from [[_phase-agent-template]]:

| Type        | When                                                                                  |
|-------------|--------------------------------------------------------------------------------------|
| `info`      | At start; once after the fix pass commits. |
| `attention` | Missing verify.json, unfixable findings, hard error. (Turn caps are enforced daemon-side — CTL-748 — not self-detected by this skill.) |
| `question`  | A finding the agent cannot resolve unilaterally.                                      |
| `done`      | Emitted by `phase-agent-emit-complete` on success.                                   |

Read inbound `directive` / `pause` / `abort` after each fix round — the
orchestrator may abort the worker while remediation is in flight.

## Why remediate is a phase, not a `verify` branch

CTL-653 keeps the pure FSM (`transition()` in `lib/phase-fsm.mjs`) a single-
successor table — `verify → review` stays the happy-path edge so the FSM's edge
tests are untouched. `remediate` is a **router-orchestrated conditional detour**
(`deriveAdvancement` reads the verify verdict and branches), not a linear FSM
edge. This skill is the worker that detour dispatches. It is designed reusably
(any fix-capable phase could mirror it), but only the verify⇄remediate edge is
wired today. See `thoughts/shared/plans/2026-05-27-ctl-653.md` for the full
design.
