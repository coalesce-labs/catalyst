#!/usr/bin/env bash
# E2E test for plugins/dev/skills/phase-triage/SKILL.md (CTL-451 Initiative 1 Phase 5).
#
# Strategy:
#   1. Build a tempdir scratch orch/worker dir, pre-seeding the phase signal file
#      (status:"dispatched") the dispatcher would have written.
#   2. Stand up a fake `linearis` shim on PATH:
#        - `linearis issues read <id>` → prints fixture JSON
#        - `linearis issues discuss <id> --body <text>` → records call to a log
#      (phase-triage never calls `linearis issues update` for a `triaged`
#       label — there is no such label; triage completion is signaled by the
#       analysis comment plus the local triage.json.)
#   3. Point CATALYST_DIR at a scratch dir — CTL-1410 Phase A: terminal events now
#      go through the phase-agent-emit-complete WRAPPER, which appends to
#      $CATALYST_DIR/events/YYYY-MM.jsonl (NOT the lib-only $CATALYST_EVENTS_FILE)
#      and flips the phase signal file's `status` in-band.
#   4. Extract the executable bash body from the skill (fenced
#      `bash phase-triage-body`).
#   5. Run it with TICKET set; assert artifact + comment + event + signal flip.
#
# Run: bash plugins/dev/scripts/__tests__/phase-triage-e2e.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SKILL_FILE="${REPO_ROOT}/plugins/dev/skills/phase-triage/SKILL.md"
EMIT_WRAPPER="${REPO_ROOT}/plugins/dev/scripts/phase-agent-emit-complete"
# CTL-632 Phase 6 refactor: adopt the shared linearis-stub helper.
# shellcheck source=lib/linearis-stub.sh
source "${SCRIPT_DIR}/lib/linearis-stub.sh"

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
[ -x "$EMIT_WRAPPER" ] || {
	echo "FAIL: wrapper missing/not executable: $EMIT_WRAPPER"
	exit 1
}

# Read the phase event line from a case's wrapper event sink
# ($CATALYST_DIR/events/YYYY-MM.jsonl). catalyst-session.sh end (which the wrapper
# also invokes) may append session lines after, so we grep the phase prefix.
read_phase_event() {
	local catalyst_dir="$1" month
	month=$(date -u +%Y-%m)
	local logfile="${catalyst_dir}/events/${month}.jsonl"
	[ -f "$logfile" ] || {
		echo ""
		return 1
	}
	grep -F '"event.name":"phase.' "$logfile" | tail -1
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

# ─────────────────────────────────────────────────────────────────────────────
# CTL-602 static guard: the body must contain NO bare $<digit> token. Claude
# Code's slash-command arg substitution ($0→ticket, $1→--orch-dir, …) rewrites
# bare $N everywhere — including inside fenced bash — at dispatch, corrupting the
# deterministic fallback. Braced ${N} and parenthesized $(N) are not bare $N and
# are allowed; this filter excludes them.
echo "phase-triage CTL-602 substitution-resilience guards"
BARE_POSITIONALS="$(grep -nE '\$[0-9]' "$SKILL_BODY_FILE" | grep -vE '\$\{|\$\(' || true)"
if [ -n "$BARE_POSITIONALS" ]; then
	fail "ctl602-static: body has no bare \$<digit> (would be clobbered by slash-arg substitution)" \
		"offending lines:$(printf '\n%s' "$BARE_POSITIONALS")"
else
	ok "ctl602-static: body has no bare \$<digit> tokens"
fi

# Per-case runner. $1=case-name, $2=fixture-json-path, $3=ticket,
# $4=optional body-file override (defaults to the extracted $SKILL_BODY_FILE).
TMPROOT="$(mktemp -d -t phase-triage-test.XXXXXX)"
trap 'rm -rf "$TMPROOT" "$SKILL_BODY_FILE"' EXIT

# CTL-1397: the triage body reads via direct SQL (linear_read_ticket). Point the
# replica at a path that does not exist so `replica_fresh` is always false and the
# helper deterministically falls back to the `linearis` stub installed on PATH —
# hermetic, independent of any real replica in the runner's HOME.
export CATALYST_REPLICA_DB="$TMPROOT/no-such-replica.db"

# CTL-1410 Phase A: resolve a case's worker dir (triage.json + phase-triage.json
# both live here, modeling production: WORKER_DIR == ORCH_DIR/workers/TICKET).
case_worker_dir() { echo "$TMPROOT/$1/orch/workers/$2"; }
case_catalyst_dir() { echo "$TMPROOT/$1/catalyst"; }

run_case() {
	local case_name="$1" fixture="$2" ticket="$3"
	local body_file="${4:-$SKILL_BODY_FILE}"
	local case_dir="$TMPROOT/$case_name"
	local orch_dir="$case_dir/orch"
	local worker="$orch_dir/workers/$ticket"
	local catalyst_dir="$case_dir/catalyst"
	mkdir -p "$case_dir/bin" "$worker" "$catalyst_dir/events"

	# Pre-seed the phase signal file exactly as the dispatcher would leave it
	# (status:"dispatched") so the wrapper's terminal flip to done/failed is
	# observable on disk.
	printf '{"status":"dispatched","ticket":"%s","phase":"triage"}\n' "$ticket" \
		>"$worker/phase-triage.json"

	# CTL-632: use the shared helper instead of inlining the stub body.
	linearis_stub_install "$case_dir/bin" "$case_dir/linearis-calls.log" "$fixture"
	linear_comment_post_stub_install "$case_dir/bin" "$case_dir/comment-post-calls.log"

	PATH="$case_dir/bin:$PATH" \
		TICKET="$ticket" \
		WORKER_DIR="$worker" \
		CATALYST_DIR="$catalyst_dir" \
		CATALYST_ORCHESTRATOR_DIR="$orch_dir" \
		CATALYST_ORCHESTRATOR_ID="orch-test" \
		PHASE_AGENT_REPO_ROOT="$REPO_ROOT" \
		bash "$body_file" >"$case_dir/stdout.log" 2>"$case_dir/stderr.log"
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
HAPPY_WORKER="$(case_worker_dir happy CTL-9999)"
HAPPY_CATALYST="$(case_catalyst_dir happy)"

# Assert: skill exited 0
EXIT_CODE="$(cat "$CASE_DIR/exit-code")"
assert_eq "happy: exit code 0" 0 "$EXIT_CODE"

# Assert: triage.json exists and parses
TRIAGE_FILE="$HAPPY_WORKER/triage.json"
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
	# CTL-838: the bash body does NOT scrape ticket ids from prose. "See CTL-447 and
	# CTL-448 for prior art" is a mention, not a dependency — deterministic deps are
	# always []. Real prerequisites come from author-set blocker links + the Opus
	# semantic pass, neither of which the bash fallback performs.
	EXPECTED_DEPS='[]'
	assert_eq "happy: dependencies are empty (CTL-838: no prose scraping)" "$EXPECTED_DEPS" "$DEPS"
fi

# Assert: skill ran to completion (comment post is best-effort / fail-open in test)
# The real linear-comment-post.sh is called but fails without credentials;
# the skill logs a warning and continues — verified by exit code 0 above.
LINEARIS_LOG="$CASE_DIR/linearis-calls.log"

# There is no `triaged` label (removed). phase-triage must never call
# `linearis issues update` — triage completion is signaled by the analysis
# comment plus the local triage.json, never a Linear label write.
if grep -q '^update$' "$LINEARIS_LOG" 2>/dev/null; then
	fail "happy: no label update call" "phase-triage calls 'linearis issues update' — there is no triaged label to write"
else
	ok "happy: phase-triage does not write any Linear label (no triaged label exists)"
fi

# Assert: emitted event has the right shape (CTL-1410: from the wrapper sink)
HAPPY_EVENT="$(read_phase_event "$HAPPY_CATALYST")"
EVENT_NAME="$(printf '%s' "$HAPPY_EVENT" | jq -r '.attributes."event.name"' 2>/dev/null)"
assert_eq "happy: emitted event name" "phase.triage.complete.CTL-9999" "$EVENT_NAME"

EVENT_TICKET="$(printf '%s' "$HAPPY_EVENT" | jq -r '.attributes."linear.issue.identifier"' 2>/dev/null)"
assert_eq "happy: event has linear.issue.identifier" "CTL-9999" "$EVENT_TICKET"

EVENT_PHASE="$(printf '%s' "$HAPPY_EVENT" | jq -r '.body.payload.phase_name' 2>/dev/null)"
assert_eq "happy: event payload has phase_name" "triage" "$EVENT_PHASE"

EVENT_CLASS="$(printf '%s' "$HAPPY_EVENT" | jq -r '.body.payload.classification' 2>/dev/null)"
assert_nonempty "happy: event payload includes classification" "$EVENT_CLASS"

# CTL-1410 Phase A: the wrapper flips the phase signal file to done in-band.
HAPPY_SIGNAL="$HAPPY_WORKER/phase-triage.json"
SIG_STATUS="$(jq -r '.status' "$HAPPY_SIGNAL" 2>/dev/null)"
assert_eq "happy: signal status flipped to done (CTL-1410)" "done" "$SIG_STATUS"
HAS_COMPLETED="$(jq -r 'has("completedAt")' "$HAPPY_SIGNAL" 2>/dev/null)"
assert_eq "happy: signal gained completedAt (terminal)" "true" "$HAS_COMPLETED"

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

TRIAGE_ACR="$(case_worker_dir acronyms CTL-9998)/triage.json"
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

TRIAGE_MD="$(case_worker_dir markdown CTL-9997)/triage.json"
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

BUG_TRIAGE="$(case_worker_dir bug CTL-7777)/triage.json"
if [ -f "$BUG_TRIAGE" ]; then
	CLASS2="$(jq -r '.classification' "$BUG_TRIAGE")"
	assert_eq "bug: classified as bug" "bug" "$CLASS2"

	SCOPE2="$(jq -r '.estimated_scope' "$BUG_TRIAGE")"
	assert_eq "bug: scope is small" "small" "$SCOPE2"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Case 3: linearis read fails — skill must emit failed event + nonzero exit +
# flip the signal to failed (CTL-1410 Phase A).

FAIL_DIR="$TMPROOT/lin-fail"
FAIL_ORCH="$FAIL_DIR/orch"
FAIL_WORKER="$FAIL_ORCH/workers/CTL-9001"
FAIL_CATALYST="$FAIL_DIR/catalyst"
mkdir -p "$FAIL_DIR/bin" "$FAIL_WORKER" "$FAIL_CATALYST/events"
printf '{"status":"dispatched","ticket":"CTL-9001","phase":"triage"}\n' >"$FAIL_WORKER/phase-triage.json"
# CTL-1397: the triage body reads via direct SQL and falls back to `linearis`
# when the replica is absent (which it is here — CATALYST_REPLICA_DB points at a
# nonexistent file). Simulate a hard read failure by stubbing a failing
# `linearis issues read`.
cat >"$FAIL_DIR/bin/linearis" <<'EOF'
#!/usr/bin/env bash
echo "linearis stub: simulated read failure" >&2
exit 1
EOF
chmod +x "$FAIL_DIR/bin/linearis"

PATH="$FAIL_DIR/bin:$PATH" \
	TICKET=CTL-9001 \
	WORKER_DIR="$FAIL_WORKER" \
	CATALYST_DIR="$FAIL_CATALYST" \
	CATALYST_ORCHESTRATOR_DIR="$FAIL_ORCH" \
	CATALYST_ORCHESTRATOR_ID="orch-test" \
	PHASE_AGENT_REPO_ROOT="$REPO_ROOT" \
	bash "$SKILL_BODY_FILE" >"$FAIL_DIR/stdout.log" 2>"$FAIL_DIR/stderr.log"
FAIL_EXIT=$?

if [ "$FAIL_EXIT" -ne 0 ]; then
	ok "lin-fail: exits non-zero when linearis read fails"
else
	fail "lin-fail: exit code" "expected non-zero, got $FAIL_EXIT"
fi

FAIL_EVENT="$(read_phase_event "$FAIL_CATALYST" | jq -r '.attributes."event.name"' 2>/dev/null)"
assert_eq "lin-fail: emits phase.triage.failed event" "phase.triage.failed.CTL-9001" "$FAIL_EVENT"

FAIL_SIG_STATUS="$(jq -r '.status' "$FAIL_WORKER/phase-triage.json" 2>/dev/null)"
assert_eq "lin-fail: signal flipped to failed (CTL-1410)" "failed" "$FAIL_SIG_STATUS"

# ─────────────────────────────────────────────────────────────────────────────
# Case 4 (CTL-614): linearis issues discuss returns 429 — must NOT fail phase.
# triage.json + phase.triage.complete event must still be produced, and the
# 429 stderr must surface to the skill's stderr (no longer swallowed).

DISCUSS_429_DIR="$TMPROOT/discuss-429"
D429_ORCH="$DISCUSS_429_DIR/orch"
D429_WORKER="$D429_ORCH/workers/CTL-9002"
D429_CATALYST="$DISCUSS_429_DIR/catalyst"
mkdir -p "$DISCUSS_429_DIR/bin" "$D429_WORKER" "$D429_CATALYST/events"
printf '{"status":"dispatched","ticket":"CTL-9002","phase":"triage"}\n' >"$D429_WORKER/phase-triage.json"

FIXTURE_429="$TMPROOT/fixture-429.json"
cat >"$FIXTURE_429" <<'EOF'
{
  "identifier": "CTL-9002",
  "title": "Some real ticket",
  "description": "Fix a thing.",
  "labels": {"nodes": []}
}
EOF

cat >"$DISCUSS_429_DIR/bin/linearis" <<EOF
#!/usr/bin/env bash
case "\$1" in
  issues)
    case "\$2" in
      read)
        cat "$FIXTURE_429"
        ;;
      *)
        echo "linearis stub: unsupported issues subcommand: \$2" >&2
        exit 2
        ;;
    esac
    ;;
  *)
    echo "linearis stub: unsupported domain: \$1" >&2
    exit 2
    ;;
esac
EOF
chmod +x "$DISCUSS_429_DIR/bin/linearis"
# CTL-1397: triage reads via direct SQL now; CATALYST_REPLICA_DB is absent so the
# read falls back to the `linearis issues read` stub above (→ fixture), reaching
# the best-effort comment-post path this case exercises.
linear_comment_post_stub_install_failing "$DISCUSS_429_DIR/bin" "$DISCUSS_429_DIR/comment-post-calls.log"

PATH="$DISCUSS_429_DIR/bin:$PATH" \
	TICKET=CTL-9002 \
	WORKER_DIR="$D429_WORKER" \
	CATALYST_DIR="$D429_CATALYST" \
	CATALYST_ORCHESTRATOR_DIR="$D429_ORCH" \
	CATALYST_ORCHESTRATOR_ID="orch-test" \
	PHASE_AGENT_REPO_ROOT="$REPO_ROOT" \
	bash "$SKILL_BODY_FILE" >"$DISCUSS_429_DIR/stdout.log" 2>"$DISCUSS_429_DIR/stderr.log"
D429_EXIT=$?

assert_eq "discuss-429: exit code 0 (best-effort)" 0 "$D429_EXIT"
assert_file_exists "discuss-429: triage.json written despite discuss failure" \
	"$D429_WORKER/triage.json"

D429_EVENT="$(read_phase_event "$D429_CATALYST" | jq -r '.attributes."event.name"' 2>/dev/null)"
assert_eq "discuss-429: emits phase.triage.complete (not failed)" \
	"phase.triage.complete.CTL-9002" "$D429_EVENT"

if grep -q 'linear-comment-post failed (continuing)' "$DISCUSS_429_DIR/stderr.log" 2>/dev/null; then
	ok "discuss-429: skill stderr logs the comment-post failure (operator visibility)"
else
	fail "discuss-429: stderr surfacing" \
		"expected 'linear-comment-post failed (continuing)' in stderr; got: $(cat "$DISCUSS_429_DIR/stderr.log" 2>/dev/null)"
fi

# ─────────────────────────────────────────────────────────────────────────────
# CTL-602 dynamic guard: simulate Claude Code slash-command arg substitution on
# the extracted body, then run the SUBSTITUTED body. A real dispatch is
# `/catalyst-dev:phase-triage <TICKET> --orch-dir <PATH>`, so $0→<TICKET>,
# $1→--orch-dir, $2→<PATH>. The sed targets bare $N only (the `[0-9]` immediately
# follows `$`); `${N}` and `$(N)` are untouched, matching the documented behavior.
# Pre-fix this corrupts classify()/acronyms_json()/awk and the case fails; the
# fixed (no-bare-$N) body is unaffected by the sed and still produces correct output.

SUBST_BODY="$(mktemp -t phase-triage-subst.XXXXXX.sh)"
# shellcheck disable=SC2064
trap 'rm -rf "$TMPROOT" "$SKILL_BODY_FILE" "$SUBST_BODY"' EXIT
# Single quotes are deliberate: sed must receive the literal patterns \$0/\$1/\$2,
# not shell-expanded values. (shellcheck SC2016 is a false positive here.)
# shellcheck disable=SC2016
sed -e 's/\$0/CTL-9999/g' \
	-e 's/\$1/--orch-dir/g' \
	-e 's#\$2#/tmp/orch#g' \
	"$SKILL_BODY_FILE" >"$SUBST_BODY"

CASE_DIR_SUBST="$(run_case subst "$FIXTURE_HAPPY" CTL-9999 "$SUBST_BODY")"

assert_eq "ctl602-dynamic: substituted body exits 0" 0 "$(cat "$CASE_DIR_SUBST/exit-code")"

TRIAGE_SUBST="$(case_worker_dir subst CTL-9999)/triage.json"
assert_file_exists "ctl602-dynamic: substituted body produced triage.json" "$TRIAGE_SUBST"

if [ -f "$TRIAGE_SUBST" ]; then
	# FIXTURE_HAPPY has no bug/doc/refactor/chore keyword → must classify as feature.
	# Pre-fix, $1→--orch-dir means the case never matches and it accidentally still
	# yields feature — so also assert acronyms + summary, which pre-fix break hard.
	CLASS_SUBST="$(jq -r '.classification' "$TRIAGE_SUBST")"
	assert_eq "ctl602-dynamic: classification survives substitution" "feature" "$CLASS_SUBST"

	ACR_SUBST="$(jq '.acronyms_expanded | length' "$TRIAGE_SUBST")"
	if [ "${ACR_SUBST:-0}" -ge 1 ]; then
		ok "ctl602-dynamic: acronym expansion survives substitution (≥1)"
	else
		fail "ctl602-dynamic: acronym expansion" "expected ≥1 acronym after substitution, got $ACR_SUBST"
	fi

	SUMMARY_SUBST="$(jq -r '.summary' "$TRIAGE_SUBST")"
	# Pre-fix, awk $0→CTL-9999 collapses every line to the number -9999; the fixed
	# body yields the real first prose sentence. Assert it starts with the fixture's
	# opening prose and is not the corrupted numeric form.
	case "$SUMMARY_SUBST" in
	"Wire the CLI tool"*) ok "ctl602-dynamic: summary survives substitution (real prose, not awk-corrupted)" ;;
	*) fail "ctl602-dynamic: summary content" "expected prefix 'Wire the CLI tool', got '$SUMMARY_SUBST'" ;;
	esac
fi

# ─────────────────────────────────────────────────────────────────────────────
# Case: CTL-838 — the deterministic body NEVER scrapes ticket ids from prose. A
# description dense with mentions (parent epic, "depends on", sibling ids) must
# still yield an empty dependency list. Real prerequisites are author-set blocker
# links + the Opus semantic pass — never a regex over what's written in the body.

FIXTURE_MENTIONS="$TMPROOT/fixture-mentions.json"
cat >"$FIXTURE_MENTIONS" <<'EOF'
{
  "identifier": "CTL-863",
  "title": "Implement takeover/healing for a downed daemon node",
  "description": "Part of the CTL-859 multi-host epic. Depends on CTL-850 (HRW claim). See CTL-718 for prior art and OTL-4 for the dashboard. When a node dies, the survivor must resume from the draft PR.",
  "parent": { "identifier": "CTL-859" },
  "labels": {"nodes": []}
}
EOF

CASE_DIR_MENTIONS="$(run_case mentions "$FIXTURE_MENTIONS" CTL-863)"
assert_eq "ctl838-noscrape: exit code 0" 0 "$(cat "$CASE_DIR_MENTIONS/exit-code")"
TRIAGE_MENTIONS="$(case_worker_dir mentions CTL-863)/triage.json"
assert_file_exists "ctl838-noscrape: triage.json created" "$TRIAGE_MENTIONS"
if [ -f "$TRIAGE_MENTIONS" ]; then
	DEPS_MENTIONS="$(jq -c '.dependencies' "$TRIAGE_MENTIONS")"
	# Five ticket ids appear in the prose (CTL-859 parent, CTL-850 "depends on",
	# CTL-718/OTL-4 mentions, CTL-863 self) — NONE become dependencies.
	EXPECTED_DEPS_MENTIONS='[]'
	assert_eq "ctl838-noscrape: prose mentions are NOT scraped into dependencies" "$EXPECTED_DEPS_MENTIONS" "$DEPS_MENTIONS"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Summary

echo
echo "Results: ${PASS} passed, ${FAIL} failed"

if [ "$FAIL" -ne 0 ]; then
	exit 1
fi
exit 0
