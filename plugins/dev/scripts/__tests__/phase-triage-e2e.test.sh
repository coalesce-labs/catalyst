#!/usr/bin/env bash
# E2E test for plugins/dev/skills/phase-triage/SKILL.md (CTL-451 Initiative 1 Phase 5).
#
# Strategy:
#   1. Build a tempdir scratch worker dir.
#   2. Stand up a fake `linearis` shim on PATH:
#        - `linearis issues read <id>` → prints fixture JSON
#        - `linearis issues discuss <id> --body <text>` → records call to a log
#        - `linearis issues update <id> --labels ... --label-mode add` → records call
#   3. Point CATALYST_EVENTS_FILE at a tempfile.
#   4. Extract the executable bash body from the skill (fenced by
#      `bash phase-triage-body`).
#   5. Run it with TICKET set; assert artifact + comment + label + event.
#
# Run: bash plugins/dev/scripts/__tests__/phase-triage-e2e.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SKILL_FILE="${REPO_ROOT}/plugins/dev/skills/phase-triage/SKILL.md"
EMIT_HELPER="${REPO_ROOT}/plugins/dev/scripts/lib/phase-emit-complete.sh"

PASS=0
FAIL=0

ok() {
	PASS=$((PASS + 1))
	printf '  PASS: %s\n' "$1"
}
fail() {
	FAIL=$((FAIL + 1))
	printf '  FAIL: %s\n    %s\n' "$1" "$2"
}

assert_eq() { if [ "$2" = "$3" ]; then ok "$1"; else fail "$1" "expected '$2' got '$3'"; fi; }
assert_nonempty() { if [ -n "$2" ]; then ok "$1"; else fail "$1" "expected non-empty value"; fi; }
assert_file_exists() { if [ -f "$2" ]; then ok "$1"; else fail "$1" "missing file: $2"; fi; }

[ -f "$SKILL_FILE" ] || {
	echo "FAIL: skill missing: $SKILL_FILE"
	exit 1
}
[ -f "$EMIT_HELPER" ] || {
	echo "FAIL: helper missing: $EMIT_HELPER"
	exit 1
}

# Extract the executable bash body delimited by ```bash phase-triage-body``` fences.
SKILL_BODY_FILE="$(mktemp -t phase-triage-body.XXXXXX.sh)"
awk '
  /^```bash phase-triage-body$/ {capture=1; next}
  /^```$/ {if (capture) {capture=0}}
  capture { print }
' "$SKILL_FILE" >"$SKILL_BODY_FILE"

if [ ! -s "$SKILL_BODY_FILE" ]; then
	echo "FAIL: could not extract phase-triage-body block from $SKILL_FILE" >&2
	exit 1
fi

# Per-case runner. $1=case-name, $2=fixture-json-path, $3=ticket, $4=expected-status
TMPROOT="$(mktemp -d -t phase-triage-test.XXXXXX)"
trap 'rm -rf "$TMPROOT" "$SKILL_BODY_FILE"' EXIT

run_case() {
	local case_name="$1" fixture="$2" ticket="$3"
	local case_dir="$TMPROOT/$case_name"
	mkdir -p "$case_dir/bin"

	# Build the `linearis` stub.
	cat >"$case_dir/bin/linearis" <<EOF
#!/usr/bin/env bash
LOG="$case_dir/linearis-calls.log"
case "\$1" in
  issues)
    case "\$2" in
      read)
        printf '%s\n' "\$@" >> "\$LOG"
        cat "$fixture"
        ;;
      discuss)
        printf '%s\n' "\$@" >> "\$LOG"
        # Mirror linearis: return JSON-ish "ok"
        echo '{"ok": true, "kind": "discuss"}'
        ;;
      update)
        printf '%s\n' "\$@" >> "\$LOG"
        echo '{"ok": true, "kind": "update"}'
        ;;
      *)
        printf 'linearis stub: unsupported issues subcommand: %s\n' "\$2" >&2
        exit 2
        ;;
    esac
    ;;
  *)
    printf 'linearis stub: unsupported domain: %s\n' "\$1" >&2
    exit 2
    ;;
esac
EOF
	chmod +x "$case_dir/bin/linearis"

	# Run the skill body with the stub on PATH.
	local events_file="$case_dir/events.jsonl"

	PATH="$case_dir/bin:$PATH" \
		TICKET="$ticket" \
		WORKER_DIR="$case_dir/worker" \
		CATALYST_EVENTS_FILE="$events_file" \
		PHASE_AGENT_REPO_ROOT="$REPO_ROOT" \
		PHASE_EMIT_HELPER="$EMIT_HELPER" \
		bash "$SKILL_BODY_FILE" >"$case_dir/stdout.log" 2>"$case_dir/stderr.log"
	echo $? >"$case_dir/exit-code"

	# Stash for later assertions
	echo "$case_dir"
}

# ─────────────────────────────────────────────────────────────────────────────
# Case 1: happy path — a feature-classified ticket with multiple deps + acronyms.

echo "phase-triage e2e tests"

FIXTURE_HAPPY="$TMPROOT/fixture-happy.json"
cat >"$FIXTURE_HAPPY" <<'EOF'
{
  "identifier": "CTL-9999",
  "title": "Add OTel exporter for the CLI",
  "description": "Wire the CLI tool to emit OTel events on every API call. See CTL-447 and CTL-448 for prior art. The PR should follow MVP scope — no fancy span sampling, just basic E2E coverage.",
  "labels": {"nodes": []}
}
EOF

CASE_DIR="$(run_case happy "$FIXTURE_HAPPY" CTL-9999)"

# Assert: skill exited 0
EXIT_CODE="$(cat "$CASE_DIR/exit-code")"
assert_eq "happy: exit code 0" 0 "$EXIT_CODE"

# Assert: triage.json exists and parses
TRIAGE_FILE="$CASE_DIR/worker/triage.json"
assert_file_exists "happy: triage.json created" "$TRIAGE_FILE"

if [ -f "$TRIAGE_FILE" ]; then
	CLASSIFICATION="$(jq -r '.classification' "$TRIAGE_FILE")"
	case "$CLASSIFICATION" in
	feature | bug | docs | refactor | chore) ok "happy: classification is a valid enum value" ;;
	*) fail "happy: classification enum" "got '$CLASSIFICATION'" ;;
	esac

	SCOPE="$(jq -r '.estimated_scope' "$TRIAGE_FILE")"
	case "$SCOPE" in
	small | medium | large | epic) ok "happy: estimated_scope is a valid enum value" ;;
	*) fail "happy: scope enum" "got '$SCOPE'" ;;
	esac

	ACRONYM_COUNT="$(jq '.acronyms_expanded | length' "$TRIAGE_FILE")"
	if [ "${ACRONYM_COUNT:-0}" -ge 1 ]; then
		ok "happy: at least one acronym expanded (OTel/CLI/API/PR/MVP/E2E all present)"
	else
		fail "happy: acronym count" "expected ≥1 acronym, got $ACRONYM_COUNT"
	fi

	DEPS="$(jq -c '.dependencies' "$TRIAGE_FILE")"
	# Expect CTL-447 and CTL-448, but NOT CTL-9999 (self).
	EXPECTED_DEPS='["CTL-447","CTL-448"]'
	assert_eq "happy: dependencies match (excludes self)" "$EXPECTED_DEPS" "$DEPS"
fi

# Assert: linearis discuss + update were called
LINEARIS_LOG="$CASE_DIR/linearis-calls.log"
if grep -q '^discuss$' "$LINEARIS_LOG" 2>/dev/null; then
	ok "happy: linearis issues discuss was called"
else
	fail "happy: discuss call" "no 'discuss' entry in linearis log:$(printf '\n%s' "$(cat "$LINEARIS_LOG" 2>/dev/null)")"
fi

if grep -q '^update$' "$LINEARIS_LOG" 2>/dev/null; then
	ok "happy: linearis issues update was called"
else
	fail "happy: update call" "no 'update' entry in linearis log"
fi

# Assert: emitted event has the right shape
EVENT_NAME="$(jq -r '.attributes."event.name"' "$CASE_DIR/events.jsonl" 2>/dev/null | head -1)"
assert_eq "happy: emitted event name" "phase.triage.complete.CTL-9999" "$EVENT_NAME"

EVENT_TICKET="$(jq -r '.attributes."linear.issue.identifier"' "$CASE_DIR/events.jsonl" 2>/dev/null | head -1)"
assert_eq "happy: event has linear.issue.identifier" "CTL-9999" "$EVENT_TICKET"

EVENT_PHASE="$(jq -r '.body.payload.phase_name' "$CASE_DIR/events.jsonl" 2>/dev/null | head -1)"
assert_eq "happy: event payload has phase_name" "triage" "$EVENT_PHASE"

EVENT_CLASS="$(jq -r '.body.payload.classification' "$CASE_DIR/events.jsonl" 2>/dev/null | head -1)"
assert_nonempty "happy: event payload includes classification" "$EVENT_CLASS"

# ─────────────────────────────────────────────────────────────────────────────
# Case 1b: all-caps + project-vocab acronyms (CTL-498 Bug 1).
# Asserts the case-insensitive match and the extended dictionary.

FIXTURE_ACRONYMS="$TMPROOT/fixture-acronyms.json"
cat >"$FIXTURE_ACRONYMS" <<'EOF'
{
  "identifier": "CTL-9998",
  "title": "Wire OTEL exporter and PromQL queries",
  "description": "Trace the bg job via OTEL spans and surface them in the HUD. Capture metrics with PromQL; document the decision in an ADR.",
  "labels": {"nodes": []}
}
EOF

CASE_DIR_ACR="$(run_case acronyms "$FIXTURE_ACRONYMS" CTL-9998)"

assert_eq "acronyms: exit code 0" 0 "$(cat "$CASE_DIR_ACR/exit-code")"

TRIAGE_ACR="$CASE_DIR_ACR/worker/triage.json"
assert_file_exists "acronyms: triage.json created" "$TRIAGE_ACR"

if [ -f "$TRIAGE_ACR" ]; then
	# Build a space-separated string of acronyms for substring assertions.
	ACR_LIST="$(jq -r '.acronyms_expanded[].acronym' "$TRIAGE_ACR" | tr '\n' ' ')"

	for needed in OTEL PromQL bg HUD ADR; do
		case " $ACR_LIST " in
		*" $needed "*) ok "acronyms: detected $needed" ;;
		*) fail "acronyms: missing $needed" "got: '$ACR_LIST'" ;;
		esac
	done
fi

# ─────────────────────────────────────────────────────────────────────────────
# Case 1c: markdown-prefixed description (CTL-498 Bug 2).
# Asserts the summary skips a leading "## Problem" header and starts with prose.

FIXTURE_MD="$TMPROOT/fixture-markdown.json"
cat >"$FIXTURE_MD" <<'EOF'
{
  "identifier": "CTL-9997",
  "title": "Surface phase-triage summary correctly",
  "description": "## Problem\n\nThe baseline summary extraction returns the literal markdown header instead of the first sentence of prose. This breaks downstream consumers of the summary field.\n\n## Fix sketch\n\nSkip leading header lines before applying the paragraph rule.",
  "labels": {"nodes": []}
}
EOF

CASE_DIR_MD="$(run_case markdown "$FIXTURE_MD" CTL-9997)"

assert_eq "markdown: exit code 0" 0 "$(cat "$CASE_DIR_MD/exit-code")"

TRIAGE_MD="$CASE_DIR_MD/worker/triage.json"
assert_file_exists "markdown: triage.json created" "$TRIAGE_MD"

if [ -f "$TRIAGE_MD" ]; then
	SUMMARY_MD="$(jq -r '.summary' "$TRIAGE_MD")"

	# Summary must NOT be the literal "## Problem" header.
	case "$SUMMARY_MD" in
	"## Problem"*) fail "markdown: summary skipped header" "summary='$SUMMARY_MD' (still starts with literal header)" ;;
	*) ok "markdown: summary does not start with markdown header" ;;
	esac

	# Summary must START WITH the first sentence of prose.
	case "$SUMMARY_MD" in
	"The baseline summary extraction"*)
		ok "markdown: summary starts with the first prose sentence"
		;;
	*)
		fail "markdown: summary content" "expected prefix 'The baseline summary extraction', got '$SUMMARY_MD'"
		;;
	esac
fi

# ─────────────────────────────────────────────────────────────────────────────
# Case 2: explicit bug classification + small scope

FIXTURE_BUG="$TMPROOT/fixture-bug.json"
cat >"$FIXTURE_BUG" <<'EOF'
{
  "identifier": "CTL-7777",
  "title": "Bug: catalyst-events tail leaks fd",
  "description": "Found in prod. Fix the leak.",
  "labels": {"nodes": []}
}
EOF

CASE_DIR2="$(run_case bug "$FIXTURE_BUG" CTL-7777)"
EXIT_CODE2="$(cat "$CASE_DIR2/exit-code")"
assert_eq "bug: exit code 0" 0 "$EXIT_CODE2"

if [ -f "$CASE_DIR2/worker/triage.json" ]; then
	CLASS2="$(jq -r '.classification' "$CASE_DIR2/worker/triage.json")"
	assert_eq "bug: classified as bug" "bug" "$CLASS2"

	SCOPE2="$(jq -r '.estimated_scope' "$CASE_DIR2/worker/triage.json")"
	assert_eq "bug: scope is small" "small" "$SCOPE2"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Case 3: linearis read fails — skill must emit failed event + nonzero exit

FAIL_DIR="$TMPROOT/lin-fail"
mkdir -p "$FAIL_DIR/bin"
cat >"$FAIL_DIR/bin/linearis" <<'EOF'
#!/usr/bin/env bash
echo "linearis stub: simulated failure" >&2
exit 1
EOF
chmod +x "$FAIL_DIR/bin/linearis"

PATH="$FAIL_DIR/bin:$PATH" \
	TICKET=CTL-9001 \
	WORKER_DIR="$FAIL_DIR/worker" \
	CATALYST_EVENTS_FILE="$FAIL_DIR/events.jsonl" \
	PHASE_AGENT_REPO_ROOT="$REPO_ROOT" \
	PHASE_EMIT_HELPER="$EMIT_HELPER" \
	bash "$SKILL_BODY_FILE" >"$FAIL_DIR/stdout.log" 2>"$FAIL_DIR/stderr.log"
FAIL_EXIT=$?

if [ "$FAIL_EXIT" -ne 0 ]; then
	ok "lin-fail: exits non-zero when linearis read fails"
else
	fail "lin-fail: exit code" "expected non-zero, got $FAIL_EXIT"
fi

FAIL_EVENT="$(jq -r '.attributes."event.name"' "$FAIL_DIR/events.jsonl" 2>/dev/null | head -1)"
assert_eq "lin-fail: emits phase.triage.failed event" "phase.triage.failed.CTL-9001" "$FAIL_EVENT"

# ─────────────────────────────────────────────────────────────────────────────
# Summary

echo
echo "Results: ${PASS} passed, ${FAIL} failed"

if [ "$FAIL" -ne 0 ]; then
	exit 1
fi
exit 0
