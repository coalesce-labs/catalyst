---
name: phase-verify
description: |
  Phase agent for the verify step of the 9-phase orchestrator pipeline (CTL-450).
  NEW skill — has no canonical wrapper. Runs read-only adversarial verification
  against the implement-phase diff: tsc, tests, lint, security scan, reward-hacking
  scan, code review, test coverage, silent-failure hunt. Writes
  ${ORCH_DIR}/workers/<TICKET>/verify.json then emits phase.verify.complete.<ticket>.
  Reads phase-implement.json as its prior-phase artifact. NEVER writes application
  code — only test files allowed. Spawned via phase-agent-dispatch via slash
  command — hence `user-invocable: true`.
user-invocable: true
disable-model-invocation: false  # invocable by model (Skill tool) AND user (slash command)
allowed-tools:
  - Read
  - Write
  - Grep
  - Glob
  - Task
  - Bash
---

# phase-verify

You are the **verify phase agent**. You run inside `claude --bg` and own a single
responsibility: read-only adversarial verification of the implement phase's diff,
producing `${ORCH_DIR}/workers/<TICKET>/verify.json` with `regression_risk`,
`findings`, and `tests_attempted` fields. You then emit
`phase.verify.complete.<ticket>` and exit. Built on the [[_phase-agent-template]]
contract.

## CRITICAL CONSTRAINT: NEVER write application code

You are a **read-only verifier**. The only files you may create or edit are:

- Test files (under `**/__tests__/`, `*.test.*`, `*.spec.*`, `test/**`, `tests/**`)
- The `verify.json` artifact in the worker directory
- Signal files via the standard emitter helper

Editing application code from this phase is a contract violation. If verification
surfaces a bug that requires code changes, you **record the finding** and let
[[phase-review]] (which IS allowed to write remediation commits) act on it.

## Prelude

```bash
set -uo pipefail

: "${CATALYST_ORCHESTRATOR_DIR:?required (set by phase-agent-dispatch)}"
: "${CATALYST_ORCHESTRATOR_ID:?required}"
: "${CATALYST_PHASE:?required}"
: "${CATALYST_TICKET:?required}"

ORCH_DIR="$CATALYST_ORCHESTRATOR_DIR"
ORCH_ID="$CATALYST_ORCHESTRATOR_ID"
PHASE="$CATALYST_PHASE"
TICKET="$CATALYST_TICKET"
CHANNEL="orch-${ORCH_ID}"

SIGNAL_FILE="${ORCH_DIR}/workers/${TICKET}/phase-${PHASE}.json"
[[ -f "$SIGNAL_FILE" ]] || { echo "phase-${PHASE}: signal file missing" >&2; exit 1; }

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/../../.." && pwd)}"

COMMS="${PLUGIN_ROOT}/scripts/catalyst-comms"
[[ -x "$COMMS" ]] || COMMS="$(command -v catalyst-comms 2>/dev/null || true)"
if [[ -n "$COMMS" ]]; then
  "$COMMS" join "$CHANNEL" --as "$TICKET" \
    --capabilities "phase-${PHASE}: ${TICKET}" \
    --orch "$ORCH_ID" --parent orchestrator --ttl 3600 >/dev/null 2>&1 || true
  "$COMMS" send "$CHANNEL" "phase-verify started" --as "$TICKET" --type info \
    --orch "$ORCH_ID" >/dev/null 2>&1 || true
fi

SESSION_SCRIPT="${PLUGIN_ROOT}/scripts/catalyst-session.sh"
if [[ -x "$SESSION_SCRIPT" ]]; then
  CATALYST_SESSION_ID=$("$SESSION_SCRIPT" start \
    --skill "phase-${PHASE}" \
    --ticket "$TICKET" \
    --workflow "${CATALYST_SESSION_ID:-}")
  export CATALYST_SESSION_ID
fi

TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TMP="${SIGNAL_FILE}.tmp.$$"
# CTL-496: persist catalystSessionId so orchestrate-roll-usage --phase can
# attribute cost to the right session_metrics row.
jq --arg ts "$TS" --arg sid "${CATALYST_SESSION_ID:-}" '
  .status = "running"
  | .updatedAt = $ts
  | if $sid != "" then .catalystSessionId = $sid else . end
' "$SIGNAL_FILE" > "$TMP" \
  && mv "$TMP" "$SIGNAL_FILE"

# Prior-phase artifact: phase-implement.json.
IMPLEMENT_SIGNAL="${ORCH_DIR}/workers/${TICKET}/phase-implement.json"
if [[ ! -f "$IMPLEMENT_SIGNAL" ]]; then
  echo "phase-verify: prior phase-implement.json missing" >&2
  "${PLUGIN_ROOT}/scripts/phase-agent-emit-complete" \
    --phase "$PHASE" --ticket "$TICKET" --status failed \
    --reason "prior_artifact_missing:phase-implement.json"
  exit 1
fi
```

<!-- Linear status is written by the coordinator (CTL-558): the execution-core
     scheduler / orchestrate-phase-advance applies the mapped state on every
     committed phase transition. The phase agent no longer transitions Linear. -->


## /goal

```
/goal "I have written ${ORCH_DIR}/workers/${TICKET}/verify.json with the schema
       {regression_risk:int, findings:[...], tests_attempted:int, gates:{...}} AND
       I have NOT modified any application source files (only test files). I have
       printed the path on stdout."
```

## Work block

Run the same adversarial verification suite the current `oneshot` Phase 4 runs,
but record findings instead of attempting fixes.

### 1. Determine the base branch and diff

```bash
BASE_BRANCH=$(git remote show origin 2>/dev/null \
  | grep "HEAD branch" | awk '{print $NF}')
BASE_BRANCH="${BASE_BRANCH:-main}"
DIFF_RANGE="origin/${BASE_BRANCH}...HEAD"
```

#### CTL-608: empty-branch backstop

Defense-in-depth for the live `phase-implement` empty-branch gate. That gate runs
in the phase-implement End block, but the execution-core **reclaim-dead-work**
path emits `implement-complete` on a worker's behalf *without* running that End
block — so an empty branch (0 commits ahead) can still reach verify. Counting
commits-ahead here means an empty branch emits `phase.verify.failed` instead of
running the full gate suite and advancing an empty branch to `phase-pr`. Reuses
`BASE_BRANCH` from step 1; uses only POSIX/zsh-safe `git rev-list --count`.
Fail-open (warn + continue) when the base is unresolvable, matching
phase-implement and the mirror block's `_base branch unknown_` tolerance.
Uniquely-named fence so the e2e harness can extract+exercise it.

```bash phase-verify-empty-branch-gate
# CTL-608: backstop — an empty branch (0 commits ahead) means there is nothing
# to verify and advancing would open an empty PR. phase-implement's gate should
# already have caught this; this is defense-in-depth for the reclaim path.
# Fail-open if the base is unresolvable (warn + continue), matching phase-implement.
VERIFY_GATE_BASE=""
if git rev-parse --verify --quiet "origin/${BASE_BRANCH}" >/dev/null 2>&1; then
  VERIFY_GATE_BASE="origin/${BASE_BRANCH}"
elif git rev-parse --verify --quiet "${BASE_BRANCH}" >/dev/null 2>&1; then
  VERIFY_GATE_BASE="${BASE_BRANCH}"
fi
if [[ -n "${VERIFY_GATE_BASE}" ]]; then
  VERIFY_AHEAD="$(git rev-list --count "${VERIFY_GATE_BASE}..HEAD" 2>/dev/null || echo 0)"
  if [[ "${VERIFY_AHEAD:-0}" -le 0 ]]; then
    echo "phase-verify: 0 commits ahead of ${VERIFY_GATE_BASE}; empty branch, nothing to verify (CTL-608)" >&2
    "${PLUGIN_ROOT}/scripts/phase-agent-emit-complete" \
      --phase "$PHASE" --ticket "$TICKET" --status failed \
      --reason "empty_branch:0_commits_ahead_of_${VERIFY_GATE_BASE}"
    [[ -n "$COMMS" && -x "$COMMS" ]] && "$COMMS" send "$CHANNEL" \
      "phase-verify failed: empty branch (0 commits ahead of ${VERIFY_GATE_BASE})" \
      --as "$TICKET" --type attention --orch "$ORCH_ID" >/dev/null 2>&1 || true
    exit 1
  fi
else
  echo "phase-verify: could not resolve integration base (no origin/${BASE_BRANCH} or ${BASE_BRANCH}); skipping empty-branch gate (CTL-608)" >&2
fi
```

### 2. Run read-only gates

Run each gate; record pass/fail/skip into the in-memory results map. Do not stop
on first failure — verification is exhaustive.

| Gate | Tool | Skill / agent |
|---|---|---|
| Type check | `tsc --noEmit` (or project's `typecheckCommand`) | [[validate-type-safety]] |
| Reward-hacking scan | grep-based pattern check | [[scan-reward-hacking]] |
| Unit tests | project test command | [[validate-type-safety]] |
| Lint | project lint command | [[validate-type-safety]] |
| Security review | dependency + secret scan | `/security-review` (built-in) |
| Code review | style/guideline adherence | [[pr-review-toolkit:code-reviewer]] agent |
| Test coverage | per-file coverage on diff | [[pr-review-toolkit:pr-test-analyzer]] agent |
| Silent failures | unchecked try/catch + fallback hunting | [[pr-review-toolkit:silent-failure-hunter]] agent |

For each gate, run via `Bash` for the CLI ones and the `Task` tool for the agent
ones. Capture exit code + a one-line summary per gate.

### 3. Compute `regression_risk` (0–10)

Aggregate signal:

| Signal | Risk delta |
|---|---|
| Any required CLI gate failed (tsc/test/lint/security) | +3 each |
| `scan-reward-hacking` flagged a HIGH-severity pattern | +3 |
| `code-reviewer` flagged a structural issue | +2 |
| `pr-test-analyzer` reports < 50% diff coverage | +2 |
| `silent-failure-hunter` flagged unchecked catch / fallback | +2 |
| Any agent surfaced a `must-fix` finding | +3 |

Clamp to `[0, 10]`. A regression_risk ≥ 5 means [[phase-review]] should create
remediation commits before the PR opens.

### 4. Optionally write **test-only** files

If `pr-test-analyzer` identifies an uncovered code path that has obvious tests, you
MAY add tests under `**/__tests__/` or `**/*.test.*`. Track each file added in the
`tests_attempted` count. **Do not edit application code under any circumstance**;
silent-failure-hunter's findings go into `findings`, never into a fix.

### 5. Write the artifact

```bash
ARTIFACT="${ORCH_DIR}/workers/${TICKET}/verify.json"
# Build $RESULTS_JSON in-memory and write atomically.
jq -nc \
  --argjson risk "$REGRESSION_RISK" \
  --argjson findings "$FINDINGS_JSON" \
  --argjson tests "$TESTS_ATTEMPTED" \
  --argjson gates "$GATES_JSON" \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{regression_risk: $risk, findings: $findings, tests_attempted: $tests,
    gates: $gates, generatedAt: $ts}' > "${ARTIFACT}.tmp" \
  && mv "${ARTIFACT}.tmp" "$ARTIFACT"
```

**Findings array shape** — each entry:

```json
{
  "severity": "high|medium|low",
  "kind": "type|test|lint|security|review|coverage|silent-failure|reward-hacking",
  "file": "path/to/file.ts",
  "line": 42,
  "message": "Short human-readable description",
  "recommendation": "What phase-review should do about this"
}
```

**Gates object shape** — keyed by gate name:

```json
{
  "typecheck": { "status": "pass|fail|skip", "exitCode": 0, "summary": "..." },
  "tests":     { "status": "pass", "exitCode": 0, "summary": "..." }
}
```

### Inbox check (CTL-749)

After all gates have run, check for mid-flight context updates from the human:

1. If `${ORCH_DIR}/workers/${TICKET}/inbox.jsonl` exists and is non-empty, read it fully.
2. Parse each JSONL line — entries have `kind: "comment"` or `kind: "description_changed"`.
3. For each entry, decide:
   - **Absorb and continue**: the update is additive context (clarification, extra constraints,
     "also handle X") — fold it into your working context and continue. Post a brief reply comment
     acknowledging the update (one sentence).
   - **Pause and replan**: the update fundamentally changes scope or invalidates the current
     approach — emit `failed` with `reason: "mid_flight_replan_needed"` via
     `${PLUGIN_ROOT}/scripts/phase-agent-emit-complete` and post the reason to Linear as a
     comment before exiting.
4. After reading, archive processed entries:
   ```bash
   [[ -f "${ORCH_DIR}/workers/${TICKET}/inbox.jsonl" ]] && \
     mv "${ORCH_DIR}/workers/${TICKET}/inbox.jsonl" \
        "${ORCH_DIR}/workers/${TICKET}/inbox.processed-$(date +%s).jsonl" || true
   ```
5. If no inbox file or it is empty, continue normally.

## End block

```bash
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TMP="${SIGNAL_FILE}.tmp.$$"
jq --arg ts "$TS" --arg artifact "$ARTIFACT" \
  '.updatedAt = $ts | .artifact = $artifact' \
  "$SIGNAL_FILE" > "$TMP" && mv "$TMP" "$SIGNAL_FILE"
```

Mirror the phase output to Linear as a single comment (CTL-632). Renders
regression risk, per-gate pass/fail/skip, findings-by-severity, and the
full findings JSON inside a `<details>` block. Body is hard-truncated to
30,000 bytes (well under Linear's effective comment cap) with a marker.
Fail-open and idempotent via the per-phase marker file.

```bash phase-verify-mirror
LINEAR_MIRROR_MARKER="${ORCH_DIR}/workers/${TICKET}/.linear-mirror-${PHASE}"
if [[ ! -e "${LINEAR_MIRROR_MARKER}" ]]; then
  GATES_RENDERED="$(printf '%s' "${GATES_JSON}" | jq -r '
    to_entries
    | map("- **" + .key + "**: " + (.value.status // "unknown")
          + (if .value.summary then " — " + .value.summary else "" end))
    | join("\n")' 2>/dev/null)"
  FINDINGS_COUNT="$(printf '%s' "${FINDINGS_JSON}" | jq -r 'length' 2>/dev/null || echo 0)"
  FINDINGS_BY_SEVERITY="$(printf '%s' "${FINDINGS_JSON}" | jq -r '
    group_by(.severity)
    | map("- " + (.[0].severity // "unknown") + ": " + (length|tostring))
    | join("\n")' 2>/dev/null)"
  FINDINGS_PRETTY="$(printf '%s' "${FINDINGS_JSON}" | jq -r '.' 2>/dev/null)"
  MIRROR_BODY="$(cat <<EOF
**Phase Verify**

- **Regression risk**: ${REGRESSION_RISK} / 10
- **Tests attempted**: ${TESTS_ATTEMPTED}
- **Findings**: ${FINDINGS_COUNT}

**Gates**:
${GATES_RENDERED}

**Findings by severity**:
${FINDINGS_BY_SEVERITY:-_none_}

<details>
<summary>Full findings JSON</summary>

\`\`\`json
${FINDINGS_PRETTY}
\`\`\`

</details>

_Posted automatically by phase-verify (CTL-632)._
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
  if [[ -n "$COMMENT_POST" && -x "$COMMENT_POST" ]] && "$COMMENT_POST" "${TICKET}" "${MIRROR_BODY}" >/dev/null 2>&1; then
    : > "${LINEAR_MIRROR_MARKER}"
  else
    echo "phase-verify: linear-comment-post failed (continuing)" >&2
  fi
fi
```

```bash
"${PLUGIN_ROOT}/scripts/phase-agent-emit-complete" \
  --phase "$PHASE" --ticket "$TICKET" --status complete

[[ -n "$COMMS" ]] && "$COMMS" done "$CHANNEL" --as "$TICKET" >/dev/null 2>&1 || true
```

## Failure handling

A failure here means verification itself broke (e.g., a gate process crashed),
not that a gate failed — gate failures are recorded into `findings` and the phase
still emits `complete`.

```bash
"${PLUGIN_ROOT}/scripts/phase-agent-emit-complete" \
  --phase "$PHASE" --ticket "$TICKET" --status failed \
  --reason "<short reason>"
[[ -n "$COMMS" ]] && "$COMMS" send "$CHANNEL" \
  "phase-verify failed: <reason>" --as "$TICKET" --type attention \
  --orch "$ORCH_ID" >/dev/null 2>&1 || true
exit 1
```

## Why this is a separate skill from validate-plan

[[validate-plan]] checks that a plan was executed against a known plan document.
phase-verify is adversarial — it doesn't read the plan; it reads the diff and
hunts for regressions. The orchestrator's pipeline may run both (validate-plan
inside implement, then verify on the resulting branch).
