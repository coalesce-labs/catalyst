---
name: phase-triage
description: Phase agent that triages a Linear ticket — expands acronyms, classifies (feature/bug/docs/refactor/chore), identifies dependencies, estimates scope, writes triage.json, posts a triaged comment to Linear, and applies the `triaged` label. Emits phase.triage.complete.<TICKET> on success and phase.triage.failed.<TICKET> on error. Dispatched by the phase-agent orchestrator (CTL-452) via slash command — `user-invocable: true` so the dispatcher's `claude --bg "/catalyst-dev:phase-triage ..."` resolves.
user-invocable: true
disable-model-invocation: false  # invocable by model (Skill tool) AND user (slash command)
allowed-tools: Bash, Read, Write, Grep
version: 1.0.0
---

# phase-triage

Greenfield phase agent shipped in CTL-451 (Initiative 1 Phase 5). Reads a Linear ticket,
produces a structured triage analysis, and lands the analysis as a Linear comment + label
so subsequent phase agents (research, plan, …) can rely on the classification.

The skill is dispatched in two modes:

- **Production**: An Opus phase agent reads `triage.json` placeholder fields produced by
  the bash body below, then refines them with model-quality analysis (acronym expansion,
  judgment-of-scope, dep inference) before the comment is posted.
- **CI / test runner**: The bash body alone is self-sufficient — it derives all five
  fields deterministically from the ticket JSON so e2e tests run without a model call.

Both modes produce the same `triage.json` shape and emit the same canonical phase event.

## Setup prerequisite

The `triaged` workspace label must already exist in Linear. The skill applies it via
`linearis issues update --labels triaged --label-mode add` and tolerates a non-zero exit
(logs a warning, does not fail the phase). Future work in CTL-452 may add a
`linearis labels create` call to bootstrap the label.

## Inputs

Environment:
- `TICKET` — Linear identifier (e.g. `CTL-451`). Required.
- `WORKER_DIR` — output directory for `triage.json`. Defaults to
  `${ORCH_DIR}/workers/${TICKET}` if set, else `$(pwd)`.
- `ORCH_DIR`, `CATALYST_ORCHESTRATOR_ID`, `CATALYST_SESSION_ID` — used for trace/span
  id derivation in the emitted event; all optional.

## Body

```bash phase-triage-body
set -uo pipefail

# Resolve repo root from the skill location so the helper path works whether
# run from a worktree, the plugin cache, or a checked-out clone.
__PT_SCRIPT_PATH="${BASH_SOURCE[0]:-${0}}"
__PT_SKILL_DIR="$(cd "$(dirname "$__PT_SCRIPT_PATH")" && pwd 2>/dev/null || pwd)"
__PT_REPO_ROOT="${PHASE_AGENT_REPO_ROOT:-$(cd "$__PT_SKILL_DIR/../../../.." 2>/dev/null && pwd || pwd)}"
__PT_LIB="${PHASE_EMIT_HELPER:-${__PT_REPO_ROOT}/plugins/dev/scripts/lib/phase-emit-complete.sh}"

if [[ ! -r "$__PT_LIB" ]]; then
  echo "phase-triage: cannot find phase-emit-complete.sh at $__PT_LIB" >&2
  exit 1
fi
# shellcheck disable=SC1090
. "$__PT_LIB"

: "${TICKET:?phase-triage: TICKET env var required}"

WORKER_DIR="${WORKER_DIR:-${ORCH_DIR:+${ORCH_DIR}/workers/${TICKET}}}"
WORKER_DIR="${WORKER_DIR:-$(pwd)}"
mkdir -p "$WORKER_DIR"

# 1. Read ticket via linearis (test stubs override $PATH).
TICKET_JSON_FILE="$(mktemp)"
trap 'rm -f "$TICKET_JSON_FILE"' EXIT

if ! linearis issues read "$TICKET" > "$TICKET_JSON_FILE" 2>/dev/null; then
  emit_phase_complete --phase triage --ticket "$TICKET" --status failed \
    --reason "linearis issues read failed"
  exit 1
fi

if ! jq -e . "$TICKET_JSON_FILE" >/dev/null 2>&1; then
  emit_phase_complete --phase triage --ticket "$TICKET" --status failed \
    --reason "linearis returned non-JSON output"
  exit 1
fi

TITLE="$(jq -r '.title // ""' "$TICKET_JSON_FILE")"
DESCRIPTION="$(jq -r '.description // ""' "$TICKET_JSON_FILE")"
COMBINED="${TITLE}
${DESCRIPTION}"

# 2. Derive the five triage fields deterministically (the bash fallback path).

# 2a. Classification — first-match over a small regex table.
classify() {
  local txt; txt="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "$txt" in
    *' bug '*|*'fix'*|*'bugfix'*|*'broken'*|*'regression'*) echo bug ;;
    *' doc '*|*'docs'*|*'documentation'*|*'readme'*)        echo docs ;;
    *'refactor'*|*'rename'*|*'cleanup'*|*'extract '*)        echo refactor ;;
    *'chore'*|*'bump'*|*'dependency update'*|*'deps:'*)      echo chore ;;
    *)                                                       echo feature ;;
  esac
}
CLASSIFICATION="$(classify " $COMBINED ")"

# 2b. Estimated scope — word count thresholds.
WORD_COUNT="$(printf '%s' "$DESCRIPTION" | wc -w | tr -d ' ')"
if   [ "$WORD_COUNT" -lt 150  ]; then ESTIMATED_SCOPE=small
elif [ "$WORD_COUNT" -lt 400  ]; then ESTIMATED_SCOPE=medium
elif [ "$WORD_COUNT" -lt 1000 ]; then ESTIMATED_SCOPE=large
else                                  ESTIMATED_SCOPE=epic
fi

# 2c. Acronym expansion — built-in dictionary; only emit acronyms actually present
#    in the title+description.
acronyms_json() {
  local txt="$1"
  jq -nc --arg t "$txt" '
    [
      {a:"PR",     e:"Pull Request"},
      {a:"CI",     e:"Continuous Integration"},
      {a:"CLI",    e:"Command-Line Interface"},
      {a:"API",    e:"Application Programming Interface"},
      {a:"MVP",    e:"Minimum Viable Product"},
      {a:"TDD",    e:"Test-Driven Development"},
      {a:"E2E",    e:"End-to-End"},
      {a:"SHA",    e:"Secure Hash Algorithm"},
      {a:"UUID",   e:"Universally Unique Identifier"},
      {a:"JSON",   e:"JavaScript Object Notation"},
      {a:"OTEL",   e:"OpenTelemetry"},
      {a:"OTLP",   e:"OpenTelemetry Line Protocol"},
      {a:"PromQL", e:"Prometheus Query Language"},
      {a:"bg",     e:"background"},
      {a:"HUD",    e:"Heads-Up Display"},
      {a:"ADR",    e:"Architecture Decision Record"}
    ]
    | ($t | ascii_downcase) as $tl
    | map(.a as $acr
          | (.a | ascii_downcase) as $acl
          | select($tl | test("\\b" + $acl + "\\b")))
    | map({acronym: .a, expansion: .e})
  '
}
ACRONYMS_EXPANDED="$(acronyms_json "$COMBINED")"

# 2d. Dependencies — other CTL-style identifiers referenced in body, excluding self.
#     Match any TEAM-NNN pattern; dedupe; exclude the ticket itself.
DEPENDENCIES="$(printf '%s\n' "$COMBINED" \
  | grep -oE '[A-Z][A-Z0-9_]*-[0-9]+' 2>/dev/null \
  | sort -u \
  | grep -v -x "$TICKET" \
  | jq -R . | jq -sc .)"
DEPENDENCIES="${DEPENDENCIES:-[]}"

# 2e. Summary — first paragraph of description, trimmed.
SUMMARY="$(printf '%s' "$DESCRIPTION" | awk 'BEGIN{RS=""} {print; exit}' | head -c 400)"

# 3. Compose triage.json.
TRIAGE_FILE="$WORKER_DIR/triage.json"
jq -nc \
  --arg ticket "$TICKET" \
  --arg classification "$CLASSIFICATION" \
  --arg scope "$ESTIMATED_SCOPE" \
  --argjson acronyms "$ACRONYMS_EXPANDED" \
  --argjson dependencies "$DEPENDENCIES" \
  --arg summary "$SUMMARY" \
  --arg generated_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{
    ticket: $ticket,
    classification: $classification,
    estimated_scope: $scope,
    acronyms_expanded: $acronyms,
    dependencies: $dependencies,
    summary: $summary,
    generated_at: $generated_at
  }' > "$TRIAGE_FILE"

# 4. Post triage comment to Linear.
# Render the dep + acronym lists with jq using single-quoted jq programs and
# Unicode escapes for backticks (`) so the surrounding bash heredoc does
# not need to escape them.
DEPS_RENDERED="$(printf '%s' "$DEPENDENCIES" | jq -r '
  if length == 0 then "_none detected_"
  else map("`" + . + "`") | join(", ")
  end
')"
ACR_RENDERED="$(printf '%s' "$ACRONYMS_EXPANDED" | jq -r '
  if length == 0 then "_none detected_"
  else map("`" + .acronym + "`=" + .expansion) | join(", ")
  end
')"

COMMENT_BODY="$(cat <<EOF
**Phase Triage**

- **Classification**: ${CLASSIFICATION}
- **Estimated scope**: ${ESTIMATED_SCOPE} (description word count: ${WORD_COUNT})
- **Dependencies**: ${DEPS_RENDERED}
- **Acronyms expanded**: ${ACR_RENDERED}

_Triaged automatically by the phase-triage agent (CTL-451)._
EOF
)"

if ! linearis issues discuss "$TICKET" --body "$COMMENT_BODY" >/dev/null 2>&1; then
  emit_phase_complete --phase triage --ticket "$TICKET" --status failed \
    --reason "linearis issues discuss failed"
  exit 1
fi

# 5. Apply the `triaged` label. Tolerate failure (label may not exist yet).
if ! linearis issues update "$TICKET" --labels triaged --label-mode add >/dev/null 2>&1; then
  echo "phase-triage: warning — could not apply triaged label (does it exist in the workspace?)" >&2
fi

# 6. Emit the canonical phase event.
emit_phase_complete --phase triage --ticket "$TICKET" --status complete \
  --payload-json "$(cat "$TRIAGE_FILE")"
exit 0
```

## What an Opus-mode invocation adds

The bash body above is fully self-sufficient — the e2e test exercises only that. When an
Opus agent runs this skill, it should:

1. Run the bash body to produce the baseline `triage.json` and Linear comment.
2. Read the ticket back, refine the classification + scope estimate with model-quality
   judgement, and re-write `triage.json` if anything changed.
3. If the refined fields differ materially, post a follow-up `linearis issues discuss`
   comment marking the refinement.

The refinement step is deliberately optional — the orchestrator hand-off in CTL-452 only
needs the `phase.triage.complete.<TICKET>` event, and the bash body already emits that.
