---
name: phase-review
description: |
  Phase agent for the review step of the 9-phase orchestrator pipeline (CTL-450).
  Wraps the /review skill (gstack) — explicitly skips /ultrareview per user decision.
  Reads verify.json from the prior phase, runs /review against the diff, writes
  ${ORCH_DIR}/workers/<TICKET>/review.json, and creates a remediation commit for
  any HIGH-severity finding that has a deterministic fix. Emits
  phase.review.complete.<ticket>. Spawned via phase-agent-dispatch via slash
  command — hence `user-invocable: true`.
user-invocable: true
disable-model-invocation: false  # invocable by model (Skill tool) AND user (slash command)
allowed-tools:
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Task
  - Bash
---

# phase-review

You are the **review phase agent**. You run inside `claude --bg` and own a single
responsibility: pre-landing review of the worker branch using the gstack
[[review]] skill, producing `${ORCH_DIR}/workers/<TICKET>/review.json` and at most
one remediation commit. You then emit `phase.review.complete.<ticket>` and exit.
Built on the [[_phase-agent-template]] contract.

You **do not** invoke `/ultrareview` — that command is reserved for the user to
trigger interactively (it costs real money via the multi-agent cloud review).

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
  "$COMMS" send "$CHANNEL" "phase-review started" --as "$TICKET" --type info \
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

# Prior-phase artifact: verify.json from phase-verify.
VERIFY_ARTIFACT="${ORCH_DIR}/workers/${TICKET}/verify.json"
if [[ ! -f "$VERIFY_ARTIFACT" ]]; then
  echo "phase-review: prior verify.json missing" >&2
  "${PLUGIN_ROOT}/scripts/phase-agent-emit-complete" \
    --phase "$PHASE" --ticket "$TICKET" --status failed \
    --reason "prior_artifact_missing:verify.json"
  exit 1
fi
REGRESSION_RISK=$(jq -r '.regression_risk // 0' "$VERIFY_ARTIFACT")
```

<!-- Linear status is written by the coordinator (CTL-558): the execution-core
     scheduler / orchestrate-phase-advance applies the mapped state on every
     committed phase transition. The phase agent no longer transitions Linear. -->


## /goal

```
/goal "I have written ${ORCH_DIR}/workers/${TICKET}/review.json with
       {findings:[...], remediationCommit:string|null, reviewPassed:bool} AND any
       HIGH-severity finding with a deterministic fix has a corresponding
       remediation commit on HEAD. I have printed the path on stdout."
```

## Work block

### 1. Run /review (gstack) — never /ultrareview

```text
Invoke the /review skill via the Task tool. It analyzes the diff against the base
branch for SQL safety, LLM trust boundary violations, conditional side effects,
and other structural issues. Capture its output as raw text and parse into the
review findings array.
```

DO NOT invoke `/ultrareview` from this phase. If a future iteration wants
multi-agent cloud review, the user runs it interactively before merge.

### 2. Merge findings from verify.json

The `findings` array in `verify.json` (from [[phase-verify]]) is the upstream
source of truth. Treat each verify finding as a candidate review item:

- HIGH severity + deterministic fix → remediation commit
- HIGH severity + ambiguous fix → record in `review.json` for human attention
- MEDIUM / LOW → record but do not commit

The fix decision is deterministic when:

- The finding's `recommendation` is a single concrete code change with a clear
  before/after, AND
- The fix is local (no cross-file refactor), AND
- The fix doesn't change a public API or test expectation.

### 3. Create at most ONE remediation commit

If you make any code changes, batch them into a single commit:

```bash
git add -A
git commit -m "fix(${ticket-scope}): phase-review remediations for ${TICKET}

Addresses HIGH-severity findings surfaced by phase-verify and /review:
- <one line per finding>

Refs: ${TICKET}"
```

Scope (`dev`/`pm`/`meta` etc.) comes from the project's existing convention; if
unclear, use `dev`. Never use `--no-verify` or `--no-gpg-sign`.

### 4. Write the artifact

```bash
ARTIFACT="${ORCH_DIR}/workers/${TICKET}/review.json"
REMEDIATION_SHA=$(git log -1 --grep="phase-review remediations for ${TICKET}" \
  --format=%H 2>/dev/null || echo "")
REVIEW_PASSED=$([[ -z "$BLOCKING_FINDINGS" ]] && echo "true" || echo "false")

jq -nc \
  --argjson findings "$REVIEW_FINDINGS_JSON" \
  --arg sha "$REMEDIATION_SHA" \
  --argjson passed "$REVIEW_PASSED" \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{findings: $findings,
    remediationCommit: (if $sha == "" then null else $sha end),
    reviewPassed: $passed,
    generatedAt: $ts}' > "${ARTIFACT}.tmp" \
  && mv "${ARTIFACT}.tmp" "$ARTIFACT"
```

**Findings array shape** — each entry mirrors phase-verify's shape plus an
`addressedBy` field:

```json
{
  "severity": "high|medium|low",
  "kind": "review|sql|trust-boundary|side-effect|...",
  "file": "path/to/file.ts",
  "line": 42,
  "message": "Short description",
  "addressedBy": "remediation-commit|deferred-to-human|none"
}
```

### Inbox check (CTL-749)

After `/review` Task returns, check for mid-flight context updates from the human:

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
the PASS/FAIL result label, findings-by-severity, remediation commit SHA,
and the full findings JSON inside a `<details>` block. Body is
hard-truncated to 30,000 bytes. Fail-open and idempotent via the
per-phase marker file.

```bash phase-review-mirror
LINEAR_MIRROR_MARKER="${ORCH_DIR}/workers/${TICKET}/.linear-mirror-${PHASE}"
if [[ ! -e "${LINEAR_MIRROR_MARKER}" ]]; then
  if [[ "${REVIEW_PASSED}" == "true" ]]; then
    RESULT_LABEL="PASS"
  else
    RESULT_LABEL="FAIL"
  fi
  FINDINGS_COUNT="$(printf '%s' "${REVIEW_FINDINGS_JSON}" | jq -r 'length' 2>/dev/null || echo 0)"
  FINDINGS_BY_SEVERITY="$(printf '%s' "${REVIEW_FINDINGS_JSON}" | jq -r '
    group_by(.severity)
    | map("- " + (.[0].severity // "unknown") + ": " + (length|tostring))
    | join("\n")' 2>/dev/null)"
  FINDINGS_PRETTY="$(printf '%s' "${REVIEW_FINDINGS_JSON}" | jq -r '.' 2>/dev/null)"
  if [[ -n "${REMEDIATION_SHA}" ]]; then
    REMEDIATION_LINE="- **Remediation commit**: \`${REMEDIATION_SHA}\`"
  else
    REMEDIATION_LINE="- **Remediation commit**: _none_"
  fi
  MIRROR_BODY="$(cat <<EOF
**Phase Review**

- **Result**: ${RESULT_LABEL}
- **Findings**: ${FINDINGS_COUNT}
${REMEDIATION_LINE}

**Findings by severity**:
${FINDINGS_BY_SEVERITY:-_none_}

<details>
<summary>Full findings JSON</summary>

\`\`\`json
${FINDINGS_PRETTY}
\`\`\`

</details>

_Posted automatically by phase-review (CTL-632)._
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
    echo "phase-review: linear-comment-post failed (continuing)" >&2
  fi
fi
```

```bash
"${PLUGIN_ROOT}/scripts/phase-agent-emit-complete" \
  --phase "$PHASE" --ticket "$TICKET" --status complete

[[ -n "$COMMS" ]] && "$COMMS" done "$CHANNEL" --as "$TICKET" >/dev/null 2>&1 || true
```

## Failure handling

```bash
"${PLUGIN_ROOT}/scripts/phase-agent-emit-complete" \
  --phase "$PHASE" --ticket "$TICKET" --status failed \
  --reason "<short reason>"
[[ -n "$COMMS" ]] && "$COMMS" send "$CHANNEL" \
  "phase-review failed: <reason>" --as "$TICKET" --type attention \
  --orch "$ORCH_ID" >/dev/null 2>&1 || true
exit 1
```
