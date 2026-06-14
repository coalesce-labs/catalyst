---
name: phase-triage
description: Phase agent that triages a Linear ticket — expands acronyms, classifies (feature/bug/docs/refactor/chore), identifies genuine blockers (a semantic second-pass over the backlog — NOT a prose scrape; CTL-838), estimates scope, writes triage.json, and posts a triage analysis comment to Linear. Triage completion is signaled by that comment plus the local triage.json — there is no `triaged` label. Emits phase.triage.complete.<TICKET> on success and phase.triage.failed.<TICKET> on error. Dispatched by the phase-agent orchestrator (CTL-452) via slash command — `user-invocable: true` so the dispatcher's `claude --bg "/catalyst-dev:phase-triage ..."` resolves.
user-invocable: true
disable-model-invocation: false  # invocable by model (Skill tool) AND user (slash command)
allowed-tools: Bash, Read, Write, Grep
version: 1.0.0
---

# phase-triage

Greenfield phase agent shipped in CTL-451 (Initiative 1 Phase 5). Reads a Linear ticket, produces a
structured triage analysis, and lands the analysis as a Linear comment + label so subsequent phase
agents (research, plan, …) can rely on the classification.

The skill is dispatched in two modes:

- **Production**: An Opus phase agent reads `triage.json` placeholder fields produced by the bash
  body below, then refines them with model-quality analysis (acronym expansion, judgment-of-scope,
  dep inference) before the comment is posted.
- **CI / test runner**: The bash body alone is self-sufficient — it derives all five fields
  deterministically from the ticket JSON so e2e tests run without a model call.

Both modes produce the same `triage.json` shape and emit the same canonical phase event.

## Use-case conformance (Opus mode)

When refining the analysis, also assess whether the ticket meets the `/catalyst-dev:gherkin-ticket`
standard: an outcome-first title (not a mechanism/file/symbol name) and a body that opens with a
plain-English use case followed by tiered Gherkin acceptance criteria. If it does **not** conform,
add one line to the triage analysis comment flagging it — e.g. _"⚠️ Ticket does not lead with a
use-case (per gherkin-ticket); consider rewriting the title/opening for scannability."_ This
surfaces non-conformant tickets for the operator without auto-rewriting them — triage is a
documentarian, so **do not** edit the ticket's title or description here; flag only. (The
deterministic bash body and `triage.json` schema are unchanged.)

## /goal

```
/goal "I have written ${WORKER_DIR}/triage.json populated with all five fields —
       classification (feature|bug|docs|refactor|chore), estimated_scope,
       acronyms_expanded, dependencies, and a non-empty summary — refined with
       real analysis (not just the deterministic placeholders), AND posted the
       triage analysis comment to the Linear ticket, AND printed the triage.json
       path on stdout."
```

CTL-656: the `/goal` evaluator keeps the agent working until the triage is genuinely complete —
every field populated and the Linear comment posted — instead of emitting the first-pass
deterministic placeholder and exiting. A real blocker (unreadable ticket, a Linear 4xx on the
comment) surfaces as needs-input rather than a silently-thin `triage.json`. (Production/Opus mode
only; the CI bash body is self-sufficient and does not invoke the evaluator.)

## Triage completion signal

Triage completion is recorded by two artifacts, not a Linear label: the analysis comment this skill
posts to the ticket, and the local `triage.json` the coordinator reads (`hasTriageArtifact`). There
is no `triaged` workspace label — the daemon never writes one.

## Inputs

Environment:

- `TICKET` — Linear identifier (e.g. `CTL-451`). Required.
- `WORKER_DIR` — output directory for `triage.json`. Defaults to `${ORCH_DIR}/workers/${TICKET}` if
  set, else `$(pwd)`.
- `ORCH_DIR`, `CATALYST_ORCHESTRATOR_ID`, `CATALYST_SESSION_ID` — used for trace/span id derivation
  in the emitted event; all optional.

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

# 2a. Classification — first-match over a small regex table. Inlined (no helper
#    function) so the body carries no bare positional parameter. At dispatch the
#    skill is rendered as a slash command (`/catalyst-dev:phase-triage <TICKET>
#    --orch-dir <PATH>`) and Claude Code substitutes bare positional tokens
#    everywhere — including inside this fenced bash — so the second positional
#    would become the literal "--orch-dir" flag and break every match (CTL-602).
#    Keep this block free of bare positional tokens (a "$" immediately followed
#    by a digit); braced and command-substitution forms are unaffected.
_PT_LOWER="$(printf '%s' " $COMBINED " | tr '[:upper:]' '[:lower:]')"
case "$_PT_LOWER" in
  *' bug '*|*'fix'*|*'bugfix'*|*'broken'*|*'regression'*) CLASSIFICATION=bug ;;
  *' doc '*|*'docs'*|*'documentation'*|*'readme'*)        CLASSIFICATION=docs ;;
  *'refactor'*|*'rename'*|*'cleanup'*|*'extract '*)        CLASSIFICATION=refactor ;;
  *'chore'*|*'bump'*|*'dependency update'*|*'deps:'*)      CLASSIFICATION=chore ;;
  *)                                                       CLASSIFICATION=feature ;;
esac

# 2b. Estimated scope — word count thresholds.
WORD_COUNT="$(printf '%s' "$DESCRIPTION" | wc -w | tr -d ' ')"
if   [ "$WORD_COUNT" -lt 150  ]; then ESTIMATED_SCOPE=small
elif [ "$WORD_COUNT" -lt 400  ]; then ESTIMATED_SCOPE=medium
elif [ "$WORD_COUNT" -lt 1000 ]; then ESTIMATED_SCOPE=large
else                                  ESTIMATED_SCOPE=epic
fi

# 2c. Acronym expansion — built-in dictionary; only emit acronyms actually present
#    in the title+description. Inlined (no helper function) so the body carries no
#    bare positional parameter, which slash-command arg substitution would clobber
#    at dispatch (CTL-602). The jq variables below ($t and friends) are not bare
#    "$"-then-digit tokens, so they are unaffected.
ACRONYMS_EXPANDED="$(jq -nc --arg t "$COMBINED" '
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
')"

# 2d. Dependencies — DELIBERATELY EMPTY in the deterministic path (CTL-838).
#     Catalyst does NOT infer dependencies from prose. The old behavior scraped
#     every TEAM-NNN token out of the title+description and the scheduler (CTL-755
#     STEP E) persisted each as a durable `blocked_by` edge — turning prior-art
#     mentions, incident examples, "see also" references and cross-team ids into
#     FALSE blockers that deadlocked tickets against work they do not depend on.
#     Real prerequisites are first-class, captured two ways, NEVER by scraping:
#       1. The ticket AUTHOR sets formal Linear `blocked_by` LINKS at creation time
#          (see the gherkin-ticket / linear / create-tickets skills). Those are
#          already durable Linear relations the scheduler honors directly.
#       2. An Opus-mode triage pass acts as a SECOND PAIR OF EYES — it examines the
#          backlog and records only GENUINE missed blockers (see "2c" below).
#     The bash fallback therefore emits an empty list (safe: no false blocks). It
#     must never reintroduce a regex over mentioned ids.
DEPENDENCIES="[]"

# 2e. Summary — first paragraph of prose, trimmed.
#     Skip leading markdown headers (^#+\s+) and bullet markers (^[-*+]\s+) so a
#     description that opens with "## Problem" yields the first sentence of prose,
#     not the literal header. Falls back to an empty summary if the description is
#     entirely headers/bullets/blank lines.
#     Implemented as a pure-bash loop rather than awk: awk's whole-line field is a
#     bare positional token, which Claude Code's slash-command arg substitution
#     would rewrite to the ticket id at dispatch, turning every line into broken
#     awk arithmetic (CTL-602). This loop uses only bash+zsh-safe constructs
#     ([[ =~ ]], <<<, head -c) and carries no bare "$"-then-digit token.
SUMMARY=""
_PT_SKIPPING=1
while IFS= read -r line; do
  if [ "$_PT_SKIPPING" -eq 1 ]; then
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    [[ "$line" =~ ^#+[[:space:]]+ ]] && continue
    [[ "$line" =~ ^[-*+][[:space:]]+ ]] && continue
    _PT_SKIPPING=0
  fi
  [[ "$line" =~ ^[[:space:]]*$ ]] && break
  if [ -z "$SUMMARY" ]; then SUMMARY="$line"; else SUMMARY="$SUMMARY $line"; fi
done <<< "$DESCRIPTION"
SUMMARY="$(printf '%s' "$SUMMARY" | head -c 400)"

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

# 4. Post triage comment to Linear (best-effort: failure does not escalate the phase, CTL-614).
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

# Append the shared run-metadata footer (CTL-632 follow-on): model, sub-agent
# count, active working duration, session ids, cwd. Fail-soft — a missing helper
# or unresolved orch dir simply omits the footer.
__PT_FOOTER="${__PT_REPO_ROOT}/plugins/dev/scripts/lib/phase-mirror-footer.sh"
if [[ -n "${ORCH_DIR:-}" && -x "${__PT_FOOTER}" ]]; then
  MIRROR_FOOTER="$("${__PT_FOOTER}" --orch-dir "${ORCH_DIR}" --ticket "${TICKET}" --phase "triage" 2>/dev/null || true)"
  [[ -n "${MIRROR_FOOTER}" ]] && COMMENT_BODY="${COMMENT_BODY}
${MIRROR_FOOTER}"
fi

# CTL-614 / CTL-550: the Linear comment post is best-effort. triage.json is
# already on disk; the canonical pipeline contract is
# `phase.triage.complete.<TICKET>` (see CTL-452). A comment-post failure must
# NOT escalate the ticket to `needs-human`.
# CTL-864: cross-host fence — bow out if a takeover superseded us. No-op single-host.
"${__PT_REPO_ROOT}/plugins/dev/scripts/lib/cluster-fence-guard.sh" --phase "${CATALYST_PHASE:-triage}" --ticket "$TICKET" || exit 10
__PT_COMMENT_POST="${CATALYST_COMMENT_POST_HELPER:-${__PT_REPO_ROOT}/plugins/dev/scripts/lib/linear-comment-post.sh}"
if [[ ! -x "$__PT_COMMENT_POST" ]]; then __PT_COMMENT_POST="$(command -v linear-comment-post.sh 2>/dev/null || true)"; fi
if [[ -n "$__PT_COMMENT_POST" && -x "$__PT_COMMENT_POST" ]] && "$__PT_COMMENT_POST" "${TICKET}" "${COMMENT_BODY}" >/dev/null; then
  true
else
  echo "phase-triage: linear-comment-post failed (continuing)" >&2
fi

# 5. There is no `triaged` label. Triage completion is signaled by the
#    analysis comment posted above plus the local triage.json the coordinator
#    reads — the phase agent and the daemon both leave Linear labels alone.
#    (Historical note for anyone grepping CTL-558: the old coordinator label
#    sweep that tagged `triaged` was removed.)

# 6. Emit the canonical phase event.
emit_phase_complete --phase triage --ticket "$TICKET" --status complete \
  --payload-json "$(cat "$TRIAGE_FILE")"

# Self-halt after complete to prevent zombie workers (CTL-778 step 2).
# Read our own bg_job_id from the signal file and ask Claude to stop us.
# Best-effort: a failed stop is covered by the daemon reaper backstop.
if [[ -n "${ORCH_DIR:-}" && -f "${ORCH_DIR}/workers/${TICKET}/phase-triage.json" ]]; then
  _SELF_BG=$(jq -r '.bg_job_id // empty' \
    "${ORCH_DIR}/workers/${TICKET}/phase-triage.json" 2>/dev/null || true)
  [[ -n "$_SELF_BG" ]] && claude stop "${_SELF_BG:0:8}" >/dev/null 2>&1 || true
fi
exit 0
```

## What an Opus-mode invocation adds

The bash body above is fully self-sufficient — the e2e test exercises only that. When an Opus agent
runs this skill, it should:

1. Run the bash body to produce the baseline `triage.json` and Linear comment.

2. Read the ticket back, refine the classification + scope estimate with model-quality judgement,
   and re-write `triage.json` if anything changed.

**2b. Anchor a numeric estimate against the reference class (CTL-751, CTL-954).**

The goal is ONE numeric estimate written in the team's configured scale (fibonacci / tShirt /
exponential / linear — whatever `issueEstimation.type` the team has set in Linear).

**Step 1 (preferred): reference-class lookup.** Run:

```bash
bun "${REPO_ROOT}/plugins/pm/scripts/estimate/reference-class-lookup.ts" \
  --corpus "${REPO_ROOT}/plugins/pm/scripts/estimate/reference-class-corpus.json" \
  --title "<ticket title>" --json
```

where `REPO_ROOT` is the repo root (the worktree's checkout path, e.g. the directory containing
`plugins/`). Parse `reference_class.points` from the JSON output.

**Step 2 (fallback when Step 1 errors or returns nothing): scope → method mapping.** Fetch the
team's estimation method with a single GraphQL call:

```bash
curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: ${LINEAR_API_TOKEN:-$LINEAR_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"query":"query($k:String!){teams(filter:{key:{eq:$k}}){nodes{issueEstimation{type allowZero extended}}}}", "variables":{"k":"<TEAM_KEY>"}}' \
  | jq -r '.data.teams.nodes[0].issueEstimation.type'
```

Map the bash-body's `estimated_scope` to the method's scale using this table (select the column
matching the team's `type`):

| scope  | fibonacci | tShirt | exponential | linear |
| ------ | --------- | ------ | ----------- | ------ |
| xs     | 1         | 0 (XS) | 1           | 1      |
| small  | 1         | 1 (S)  | 1           | 1      |
| medium | 3         | 2 (M)  | 2           | 2      |
| large  | 5         | 3 (L)  | 4           | 3      |
| epic   | 8         | 5 (XL) | 8           | 5      |

Write the result to `triage.json` as **both** `"estimate": <points>` AND
`"estimateMethod": "<type>"` (e.g. `"estimateMethod": "tShirt"`). The scheduler reads
`estimateMethod` to validate the value against the correct scale without a second network call.

If both Step 1 and Step 2 fail, leave `triage.json` without an `estimate` field — the coordinator
skips the Linear estimate write for this ticket (fail-open; forward progress is unaffected). The
bash body intentionally does **not** write `estimate` (CTL-558 guard).

**2c. Identify genuine blockers — semantic second-pass, READ-ONLY (CTL-838).** Catalyst does **not**
parse or infer dependencies from the description text. The bash body writes an empty `dependencies`
list by design (CTL-838 killed the old `2d` regex scrape). Real prerequisites come from two places,
and your job here is the second one:

1. **Formal author links (primary).** The agent that authored the ticket records its real
   prerequisites as Linear `blocked_by` LINKS at creation time (the gherkin-ticket / linear /
   create-tickets skills now instruct this). Those are already durable Linear relations and the
   admission gate honors them directly from the live graph — triage does **not** need to re-derive
   or re-emit them.

2. **Triage as a SECOND PAIR OF EYES (your job).** You are NOT a parser. Do **not** add a dependency
   because an id appears in the prose. Instead: read the ticket's intent, then **examine the
   relevant backlog** — `linearis issues list` for the ticket's team / area (and
   `linearis issues read <id>` to confirm a candidate) — and judge whether any in-flight or planned
   work is a **true prerequisite the author may have missed**: work that must reach a terminal state
   before this ticket can sensibly start (a shared interface not yet built, a migration that must
   land first, an explicit "must follow" sequencing). Record **only** blockers you can justify, in
   the rich shape with a `reason`:

```jsonc
"dependencies": [
  { "id": "CTL-123", "exists": true, "blockerState": "Implement", "reason": "defines the API this ticket consumes" }
]
```

If you find no genuine missed blocker, leave `dependencies` as the empty list the bash body wrote. A
mention is not a dependency; a shared topic is not a dependency; "see also / prior art / regression
of / example" is not a dependency. When in doubt, leave it out — a false blocker deadlocks real
work, a missed one is caught on the next pass.

**Hard constraint — the skill makes ZERO Linear writes for dependencies.** Do NOT call
`linearis issues update ... --blocked-by` (or any `linearis issues update`) from this skill. The
admission gate's durable `blocked_by` persistence lives in the execution-core scheduler (CTL-755
STEP E, `scheduler.mjs` — it reads `triage.json.dependencies`, re-validates each id via
`fetchTicketState`, and drops unresolvable / terminal / cycle-closing / **parent-epic (CTL-878)** /
**cross-team (CTL-838)** ids before writing the durable edge with `applyBlockedByRelation`). Keeping
the write scheduler-side preserves the CTL-497/CTL-558 contract — the phase-triage e2e negative
guard fails the build if this skill ever emits a `linearis issues update` call.
`linearis issues read` is read-only and is fine. STEP E tolerates BOTH the flat-string and the rich
`{id}` shapes.

3. If the refined fields differ materially, post a follow-up `linearis issues discuss` comment
   marking the refinement.

The refinement step is deliberately optional — the orchestrator hand-off in CTL-452 only needs the
`phase.triage.complete.<TICKET>` event, and the bash body already emits that.

## Structured escalation (CTL-1065)

If triage genuinely cannot proceed (e.g., the ticket description is too
ambiguous to classify, or a required external resource is unavailable), emit
`failed` with a structured `explanation` block. Use the CLI shim:

```bash
EXPL_JSON="$(node "${PLUGIN_ROOT}/scripts/execution-core/escalation-explain.mjs" \
  --ticket "$TICKET" --phase triage \
  --what-failed "{{ specific symptom }}" \
  --why-gave-up "{{ reason autonomous triage cannot complete }}" \
  --human-question "{{ one specific answerable question }}" \
  2>/dev/null || echo '{}')"
```

The `human_question` MUST be specific and answerable — never:
- "needs a human" / "requires human review"
- "a human must decide" / "escalate to operator"

Write the specific question instead:
- Good: "should CTL-NNN be classified as a feature or a refactor — the
  description mentions both adding a new API and removing the old one?"
