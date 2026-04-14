#!/usr/bin/env bash
# Test suite for workflow-context.sh, resolve-ticket.sh, update-workflow-context.sh,
# sync-plan-to-thoughts.sh, inject-plan-template.sh, and check-project-setup.sh
#
# Validates:
# - Context file creation and initialization
# - Document add/query operations
# - Path normalization (absolute, symlink-resolved, relative)
# - Project root resolution from subdirectories
# - most-recent cross-type query
# - Null ticket preservation
# - set-ticket (ticket-only, no document)
# - Dual-write (hook + skill) behavior
# - Array ordering invariant (newest-first)
# - sync-plan-to-thoughts.sh (title, slug, ticket, frontmatter, workflow-context update)
# - inject-plan-template.sh (plan mode gating, ticket prefix injection)
# - check-project-setup.sh (fatal vs warning exit codes, context init)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKFLOW_SCRIPT="$SCRIPT_DIR/workflow-context.sh"
RESOLVE_TICKET_SCRIPT="$SCRIPT_DIR/resolve-ticket.sh"
HOOK_SCRIPT="$SCRIPT_DIR/../hooks/update-workflow-context.sh"
SYNC_PLAN_SCRIPT="$SCRIPT_DIR/../hooks/sync-plan-to-thoughts.sh"
INJECT_PLAN_SCRIPT="$SCRIPT_DIR/../hooks/inject-plan-template.sh"
SETUP_SCRIPT="$SCRIPT_DIR/check-project-setup.sh"

PASS=true
TESTS=0
FAILURES=0

fail() {
	echo "  FAIL: $1"
	PASS=false
	FAILURES=$((FAILURES + 1))
}

pass() {
	echo "  PASS: $1"
}

run_test() {
	TESTS=$((TESTS + 1))
	echo ""
	echo "--- Test $TESTS: $1 ---"
}

# Create a temporary git repo that mimics the Catalyst project structure
setup_project() {
	local dir="$1"
	mkdir -p "$dir"
	(
		cd "$dir"
		git init -q .
		mkdir -p .catalyst
		mkdir -p thoughts/shared/research
		mkdir -p thoughts/shared/plans
		mkdir -p thoughts/shared/handoffs
		mkdir -p thoughts/shared/prs
		mkdir -p plugins/dev/scripts
		mkdir -p plugins/dev/hooks

		# Copy the scripts under test into the fake project
		cp "$WORKFLOW_SCRIPT" plugins/dev/scripts/workflow-context.sh
		cp "$RESOLVE_TICKET_SCRIPT" plugins/dev/scripts/resolve-ticket.sh
		cp "$HOOK_SCRIPT" plugins/dev/hooks/update-workflow-context.sh
		chmod +x plugins/dev/scripts/workflow-context.sh
		chmod +x plugins/dev/scripts/resolve-ticket.sh
		chmod +x plugins/dev/hooks/update-workflow-context.sh

		git add -A && git commit -q -m "initial"
	)
}

TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

# ── Test 1: init creates context file ──────────────────────────────────────

run_test "init creates .workflow-context.json"

TEST_DIR="$TMPDIR/test1"
setup_project "$TEST_DIR"

(cd "$TEST_DIR" && bash plugins/dev/scripts/workflow-context.sh init)

if [[ -f "$TEST_DIR/.catalyst/.workflow-context.json" ]]; then
	pass "Context file was created"
else
	fail "Context file was not created"
fi

# Validate JSON structure
if jq -e '.workflow.research' "$TEST_DIR/.catalyst/.workflow-context.json" >/dev/null 2>&1; then
	pass "JSON structure is valid with workflow.research array"
else
	fail "JSON structure is invalid or missing workflow.research"
fi

# ── Test 2: add inserts document and updates mostRecent ────────────────────

run_test "add inserts document and updates mostRecentDocument"

TEST_DIR="$TMPDIR/test2"
setup_project "$TEST_DIR"

(cd "$TEST_DIR" && bash plugins/dev/scripts/workflow-context.sh add research "thoughts/shared/research/2026-01-01-PROJ-123-auth.md" "PROJ-123")

RESULT=$(jq -r '.mostRecentDocument.path' "$TEST_DIR/.catalyst/.workflow-context.json")
if [[ $RESULT == "thoughts/shared/research/2026-01-01-PROJ-123-auth.md" ]]; then
	pass "mostRecentDocument.path is correct"
else
	fail "mostRecentDocument.path is '$RESULT', expected 'thoughts/shared/research/2026-01-01-PROJ-123-auth.md'"
fi

TICKET=$(jq -r '.currentTicket' "$TEST_DIR/.catalyst/.workflow-context.json")
if [[ $TICKET == "PROJ-123" ]]; then
	pass "currentTicket updated to PROJ-123"
else
	fail "currentTicket is '$TICKET', expected 'PROJ-123'"
fi

# ── Test 3: recent returns most recent document of type ────────────────────

run_test "recent returns most recent document of type"

TEST_DIR="$TMPDIR/test3"
setup_project "$TEST_DIR"

(
	cd "$TEST_DIR"
	bash plugins/dev/scripts/workflow-context.sh add research "thoughts/shared/research/old.md" "null"
	bash plugins/dev/scripts/workflow-context.sh add research "thoughts/shared/research/new.md" "null"
)

RESULT=$(cd "$TEST_DIR" && bash plugins/dev/scripts/workflow-context.sh recent research)
if [[ $RESULT == "thoughts/shared/research/new.md" ]]; then
	pass "Most recent research document returned"
else
	fail "recent returned '$RESULT', expected 'thoughts/shared/research/new.md'"
fi

# ── Test 4: ticket query returns matching documents ────────────────────────

run_test "ticket query returns documents matching ticket ID"

TEST_DIR="$TMPDIR/test4"
setup_project "$TEST_DIR"

(
	cd "$TEST_DIR"
	bash plugins/dev/scripts/workflow-context.sh add research "thoughts/shared/research/r1.md" "ABC-100"
	bash plugins/dev/scripts/workflow-context.sh add plans "thoughts/shared/plans/p1.md" "ABC-100"
	bash plugins/dev/scripts/workflow-context.sh add research "thoughts/shared/research/r2.md" "XYZ-200"
)

RESULT=$(cd "$TEST_DIR" && bash plugins/dev/scripts/workflow-context.sh ticket ABC-100)
COUNT=$(echo "$RESULT" | wc -l | tr -d ' ')
if [[ $COUNT -eq 2 ]]; then
	pass "ticket query returned 2 documents for ABC-100"
else
	fail "ticket query returned $COUNT documents, expected 2"
fi

if echo "$RESULT" | grep -q "r2.md"; then
	fail "ticket query included wrong ticket's document"
else
	pass "ticket query excluded documents from other tickets"
fi

# ── Test 5: init from subdirectory uses git root ───────────────────────────

run_test "init from subdirectory resolves project root via git"

TEST_DIR="$TMPDIR/test5"
setup_project "$TEST_DIR"

# Run init from a subdirectory
(cd "$TEST_DIR/plugins/dev" && bash scripts/workflow-context.sh init)

if [[ -f "$TEST_DIR/.catalyst/.workflow-context.json" ]]; then
	pass "Context file created at project root from subdirectory"
else
	fail "Context file not found at project root"
fi

# ── Test 6: hook normalizes absolute paths ─────────────────────────────────

run_test "hook normalizes absolute paths to relative"

TEST_DIR="$TMPDIR/test6"
setup_project "$TEST_DIR"

CLAUDE_FILE_PATHS="${TEST_DIR}/thoughts/shared/plans/2026-01-01-PROJ-456-feature.md" \
	bash -c "cd '$TEST_DIR' && bash plugins/dev/hooks/update-workflow-context.sh"

RESULT=$(cd "$TEST_DIR" && bash plugins/dev/scripts/workflow-context.sh recent plans)
if [[ $RESULT == "thoughts/shared/plans/2026-01-01-PROJ-456-feature.md" ]]; then
	pass "Absolute path normalized to relative in context"
else
	fail "recent returned '$RESULT', expected relative path"
fi

# ── Test 7: hook normalizes symlink-resolved paths ─────────────────────────

run_test "hook normalizes symlink-resolved paths"

TEST_DIR="$TMPDIR/test7"
setup_project "$TEST_DIR"

# Create a symlink target and replace thoughts/shared with a symlink
SYMLINK_TARGET="$TMPDIR/external-thoughts/shared"
mkdir -p "$SYMLINK_TARGET/research"
rm -rf "$TEST_DIR/thoughts/shared"
ln -s "$SYMLINK_TARGET" "$TEST_DIR/thoughts/shared"

# Simulate Claude Code providing the resolved symlink path
CLAUDE_FILE_PATHS="${SYMLINK_TARGET}/research/2026-01-01-SYM-789-test.md" \
	bash -c "cd '$TEST_DIR' && bash plugins/dev/hooks/update-workflow-context.sh"

RESULT=$(cd "$TEST_DIR" && bash plugins/dev/scripts/workflow-context.sh recent research)
if [[ $RESULT == "thoughts/shared/research/2026-01-01-SYM-789-test.md" ]]; then
	pass "Symlink-resolved path normalized to thoughts/shared/..."
else
	fail "recent returned '$RESULT', expected 'thoughts/shared/research/2026-01-01-SYM-789-test.md'"
fi

# ── Test 8: hook extracts ticket from filename ─────────────────────────────

run_test "hook extracts ticket ID from filename"

TEST_DIR="$TMPDIR/test8"
setup_project "$TEST_DIR"

CLAUDE_FILE_PATHS="thoughts/shared/research/2026-04-04-CTL-24-workflow-context.md" \
	bash -c "cd '$TEST_DIR' && bash plugins/dev/hooks/update-workflow-context.sh"

TICKET=$(jq -r '.currentTicket' "$TEST_DIR/.catalyst/.workflow-context.json")
if [[ $TICKET == "CTL-24" ]]; then
	pass "Ticket CTL-24 extracted from filename"
else
	fail "currentTicket is '$TICKET', expected 'CTL-24'"
fi

# ── Test 9: hook ignores non-thoughts files ────────────────────────────────

run_test "hook ignores non-thoughts file paths"

TEST_DIR="$TMPDIR/test9"
setup_project "$TEST_DIR"

CLAUDE_FILE_PATHS="src/index.ts" \
	bash -c "cd '$TEST_DIR' && bash plugins/dev/hooks/update-workflow-context.sh"

if [[ ! -f "$TEST_DIR/.catalyst/.workflow-context.json" ]]; then
	pass "No context file created for non-thoughts file"
else
	MOST_RECENT=$(jq -r '.mostRecentDocument' "$TEST_DIR/.catalyst/.workflow-context.json")
	if [[ $MOST_RECENT == "null" ]]; then
		pass "Context file exists but no document tracked"
	else
		fail "Non-thoughts file was tracked in context"
	fi
fi

# ── Test 10: hook with CLAUDE_TOOL_INPUT fallback ──────────────────────────

run_test "hook falls back to CLAUDE_TOOL_INPUT when CLAUDE_FILE_PATHS is empty"

TEST_DIR="$TMPDIR/test10"
setup_project "$TEST_DIR"

CLAUDE_TOOL_INPUT='{"file_path":"thoughts/shared/prs/2026-01-01-PR-42.md"}' \
	bash -c "cd '$TEST_DIR' && bash plugins/dev/hooks/update-workflow-context.sh"

RESULT=$(cd "$TEST_DIR" && bash plugins/dev/scripts/workflow-context.sh recent prs)
if [[ $RESULT == "thoughts/shared/prs/2026-01-01-PR-42.md" ]]; then
	pass "CLAUDE_TOOL_INPUT fallback worked correctly"
else
	fail "recent returned '$RESULT', expected 'thoughts/shared/prs/2026-01-01-PR-42.md'"
fi

# ── Test 11: multiple types tracked independently ──────────────────────────

run_test "different document types tracked independently"

TEST_DIR="$TMPDIR/test11"
setup_project "$TEST_DIR"

(
	cd "$TEST_DIR"
	bash plugins/dev/scripts/workflow-context.sh add research "thoughts/shared/research/r.md" "null"
	bash plugins/dev/scripts/workflow-context.sh add plans "thoughts/shared/plans/p.md" "null"
	bash plugins/dev/scripts/workflow-context.sh add handoffs "thoughts/shared/handoffs/h.md" "null"
	bash plugins/dev/scripts/workflow-context.sh add prs "thoughts/shared/prs/pr.md" "null"
)

R=$(cd "$TEST_DIR" && bash plugins/dev/scripts/workflow-context.sh recent research)
P=$(cd "$TEST_DIR" && bash plugins/dev/scripts/workflow-context.sh recent plans)
H=$(cd "$TEST_DIR" && bash plugins/dev/scripts/workflow-context.sh recent handoffs)
PR=$(cd "$TEST_DIR" && bash plugins/dev/scripts/workflow-context.sh recent prs)

if [[ $R == *"r.md" && $P == *"p.md" && $H == *"h.md" && $PR == *"pr.md" ]]; then
	pass "All four document types tracked independently"
else
	fail "Type tracking mismatch: research=$R plans=$P handoffs=$H prs=$PR"
fi

# ── Test 12: check-project-setup.sh initializes context ────────────────────

run_test "check-project-setup.sh creates context file when missing"

TEST_DIR="$TMPDIR/test12"
setup_project "$TEST_DIR"

# Copy setup script and adjust — it has additional checks that may warn, but should not fail
cp "$SETUP_SCRIPT" "$TEST_DIR/plugins/dev/scripts/check-project-setup.sh"
chmod +x "$TEST_DIR/plugins/dev/scripts/check-project-setup.sh"

# Ensure no context file exists
rm -f "$TEST_DIR/.catalyst/.workflow-context.json"

# Create minimal CLAUDE.md so the script doesn't error on missing it
echo "# Test Project" >"$TEST_DIR/CLAUDE.md"

# Create config.json so the script doesn't warn too much
cat >"$TEST_DIR/.catalyst/config.json" <<'CONF'
{"catalyst":{"projectKey":"test","project":{"ticketPrefix":"TEST"},"linear":{"teamKey":"TEST","stateMap":{"backlog":"Backlog"}}}}
CONF

# Suppress warnings — the temp project is intentionally minimal; we only
# care whether the script creates the context file as a side effect.
(cd "$TEST_DIR" && bash plugins/dev/scripts/check-project-setup.sh >/dev/null 2>&1) || true

if [[ -f "$TEST_DIR/.catalyst/.workflow-context.json" ]]; then
	pass "check-project-setup.sh created the context file"
else
	fail "check-project-setup.sh did not create the context file"
fi

# ── Test 13: most-recent returns latest across all types ───────────────────

run_test "most-recent returns latest document across all types"

TEST_DIR="$TMPDIR/test13"
setup_project "$TEST_DIR"

(
	cd "$TEST_DIR"
	bash plugins/dev/scripts/workflow-context.sh add research "thoughts/shared/research/r.md" "null"
	bash plugins/dev/scripts/workflow-context.sh add plans "thoughts/shared/plans/p.md" "null"
	bash plugins/dev/scripts/workflow-context.sh add handoffs "thoughts/shared/handoffs/h.md" "null"
)

RESULT=$(cd "$TEST_DIR" && bash plugins/dev/scripts/workflow-context.sh most-recent)
if [[ $RESULT == "thoughts/shared/handoffs/h.md" ]]; then
	pass "most-recent returned the last-added document (handoff)"
else
	fail "most-recent returned '$RESULT', expected 'thoughts/shared/handoffs/h.md'"
fi

# ── Test 14: null ticket does not overwrite currentTicket ──────────────────

run_test "adding doc with null ticket preserves existing currentTicket"

TEST_DIR="$TMPDIR/test14"
setup_project "$TEST_DIR"

(
	cd "$TEST_DIR"
	bash plugins/dev/scripts/workflow-context.sh add research "thoughts/shared/research/r1.md" "PROJ-100"
	bash plugins/dev/scripts/workflow-context.sh add plans "thoughts/shared/plans/p1.md" "null"
)

TICKET=$(jq -r '.currentTicket' "$TEST_DIR/.catalyst/.workflow-context.json")
if [[ $TICKET == "PROJ-100" ]]; then
	pass "currentTicket preserved as PROJ-100 after null-ticket add"
else
	fail "currentTicket is '$TICKET', expected 'PROJ-100'"
fi

# ── Test 15: dual-write (hook + manual add) keeps recent correct ───────────

run_test "dual-write from hook and manual add both resolve correctly via recent"

TEST_DIR="$TMPDIR/test15"
setup_project "$TEST_DIR"

DOC_PATH="thoughts/shared/research/2026-01-01-DUAL-1-test.md"

# Simulate what happens in practice: hook fires, then skill also calls add
CLAUDE_FILE_PATHS="$DOC_PATH" \
	bash -c "cd '$TEST_DIR' && bash plugins/dev/hooks/update-workflow-context.sh"
(cd "$TEST_DIR" && bash plugins/dev/scripts/workflow-context.sh add research "$DOC_PATH" "DUAL-1")

RESULT=$(cd "$TEST_DIR" && bash plugins/dev/scripts/workflow-context.sh recent research)
if [[ $RESULT == "$DOC_PATH" ]]; then
	pass "recent returns correct path despite dual-write"
else
	fail "recent returned '$RESULT', expected '$DOC_PATH'"
fi

# Verify duplicates exist but don't break ticket query
TICKET_RESULTS=$(cd "$TEST_DIR" && bash plugins/dev/scripts/workflow-context.sh ticket DUAL-1)
TICKET_COUNT=$(echo "$TICKET_RESULTS" | wc -l | tr -d ' ')
if [[ $TICKET_COUNT -ge 1 ]]; then
	pass "ticket query returns results (dual-write produces $TICKET_COUNT entries)"
else
	fail "ticket query returned no results"
fi

# ── Test 16: array ordering — newest always at index 0 ─────────────────────

run_test "newest-first ordering is maintained across adds"

TEST_DIR="$TMPDIR/test16"
setup_project "$TEST_DIR"

(
	cd "$TEST_DIR"
	bash plugins/dev/scripts/workflow-context.sh add plans "thoughts/shared/plans/first.md" "null"
	bash plugins/dev/scripts/workflow-context.sh add plans "thoughts/shared/plans/second.md" "null"
	bash plugins/dev/scripts/workflow-context.sh add plans "thoughts/shared/plans/third.md" "null"
)

IDX0=$(jq -r '.workflow.plans[0].path' "$TEST_DIR/.catalyst/.workflow-context.json")
IDX1=$(jq -r '.workflow.plans[1].path' "$TEST_DIR/.catalyst/.workflow-context.json")
IDX2=$(jq -r '.workflow.plans[2].path' "$TEST_DIR/.catalyst/.workflow-context.json")

if [[ $IDX0 == *"third.md" && $IDX1 == *"second.md" && $IDX2 == *"first.md" ]]; then
	pass "Array order is newest-first: third, second, first"
else
	fail "Array order wrong: [0]=$IDX0 [1]=$IDX1 [2]=$IDX2"
fi

# ── Test 17: sync-plan-to-thoughts title extraction and slug ───────────────

run_test "sync-plan-to-thoughts extracts title and generates slug"

TEST_DIR="$TMPDIR/test17"
setup_project "$TEST_DIR"

# Create a fake plan file
PLAN_DIR="$TEST_DIR/.claude-test-plans"
mkdir -p "$PLAN_DIR"
cat >"$PLAN_DIR/plan.md" <<'PLAN'
# CTL-42 Add OAuth Support

## Overview
Implement OAuth 2.0 for third-party integrations.

## Phase 1: Setup
- Add OAuth library
PLAN

# Feed hook via stdin JSON, override HOME so it reads our fake plan file
echo '{"cwd":"'"$TEST_DIR"'"}' |
	HOME="$TEST_DIR/.claude-test-home" \
		CLAUDE_PROJECT_DIR="$TEST_DIR" \
		bash -c "
		mkdir -p '$TEST_DIR/.claude-test-home/.claude/plans'
		cp '$PLAN_DIR/plan.md' '$TEST_DIR/.claude-test-home/.claude/plans/plan.md'
		export HOME='$TEST_DIR/.claude-test-home'
		bash '$SYNC_PLAN_SCRIPT'
	"

# Find the output file
OUT_FILE=$(find "$TEST_DIR/thoughts/shared/plans" -name "*ctl-42-add-oauth-support*" -type f 2>/dev/null | head -1)

if [[ -n $OUT_FILE && -f $OUT_FILE ]]; then
	pass "Plan file was written to thoughts/shared/plans/"

	if grep -q "source_ticket: CTL-42" "$OUT_FILE"; then
		pass "Ticket CTL-42 extracted and written to frontmatter"
	else
		fail "source_ticket not found in frontmatter"
	fi

	if grep -q "source: plan-mode" "$OUT_FILE"; then
		pass "source: plan-mode marker present"
	else
		fail "source: plan-mode marker missing"
	fi

	if grep -q "Implement OAuth 2.0" "$OUT_FILE"; then
		pass "Plan content preserved in output"
	else
		fail "Plan content missing from output"
	fi
else
	fail "No plan output file found in thoughts/shared/plans/"
	ls -la "$TEST_DIR/thoughts/shared/plans/" 2>/dev/null || true
fi

# ── Test 18: sync-plan-to-thoughts updates workflow-context ────────────────

run_test "sync-plan-to-thoughts registers plan in workflow-context"

# Reuse test17's directory
if [[ -f "$TEST_DIR/.catalyst/.workflow-context.json" ]]; then
	RECENT_PLAN=$(cd "$TEST_DIR" && bash plugins/dev/scripts/workflow-context.sh recent plans)
	if [[ $RECENT_PLAN == *"ctl-42"* ]]; then
		pass "Plan registered in workflow-context"
	else
		fail "recent plans returned '$RECENT_PLAN', expected path containing 'ctl-42'"
	fi
else
	fail "workflow-context.json not created by sync-plan-to-thoughts"
fi

# ── Test 19: sync-plan-to-thoughts handles untitled plan ───────────────────

run_test "sync-plan-to-thoughts defaults to 'Untitled Plan' when no heading"

TEST_DIR="$TMPDIR/test19"
setup_project "$TEST_DIR"

PLAN_DIR="$TEST_DIR/.claude-test-plans"
mkdir -p "$PLAN_DIR"
cat >"$PLAN_DIR/plan.md" <<'PLAN'
Just some text without a heading.

- Step 1
- Step 2
PLAN

echo '{"cwd":"'"$TEST_DIR"'"}' |
	HOME="$TEST_DIR/.claude-test-home" \
		CLAUDE_PROJECT_DIR="$TEST_DIR" \
		bash -c "
		mkdir -p '$TEST_DIR/.claude-test-home/.claude/plans'
		cp '$PLAN_DIR/plan.md' '$TEST_DIR/.claude-test-home/.claude/plans/plan.md'
		export HOME='$TEST_DIR/.claude-test-home'
		bash '$SYNC_PLAN_SCRIPT'
	"

OUT_FILE=$(find "$TEST_DIR/thoughts/shared/plans" -name "*untitled-plan*" -type f 2>/dev/null | head -1)
if [[ -n $OUT_FILE && -f $OUT_FILE ]]; then
	pass "Untitled plan saved with 'untitled-plan' slug"
else
	fail "No output file with 'untitled-plan' slug found"
	ls -la "$TEST_DIR/thoughts/shared/plans/" 2>/dev/null || true
fi

# ── Test 20: sync-plan-to-thoughts extracts ticket from body ───────────────

run_test "sync-plan-to-thoughts extracts ticket from plan body when not in title"

TEST_DIR="$TMPDIR/test20"
setup_project "$TEST_DIR"

PLAN_DIR="$TEST_DIR/.claude-test-plans"
mkdir -p "$PLAN_DIR"
cat >"$PLAN_DIR/plan.md" <<'PLAN'
# Add Dark Mode Support

## Context
This implements BRAVO-789 from the backlog.

## Phase 1
- Update theme config
PLAN

echo '{"cwd":"'"$TEST_DIR"'"}' |
	HOME="$TEST_DIR/.claude-test-home" \
		CLAUDE_PROJECT_DIR="$TEST_DIR" \
		bash -c "
		mkdir -p '$TEST_DIR/.claude-test-home/.claude/plans'
		cp '$PLAN_DIR/plan.md' '$TEST_DIR/.claude-test-home/.claude/plans/plan.md'
		export HOME='$TEST_DIR/.claude-test-home'
		bash '$SYNC_PLAN_SCRIPT'
	"

OUT_FILE=$(find "$TEST_DIR/thoughts/shared/plans" -name "*BRAVO-789*" -type f 2>/dev/null | head -1)
if [[ -n $OUT_FILE && -f $OUT_FILE ]]; then
	pass "Ticket BRAVO-789 extracted from body and used in filename"
	if grep -q "source_ticket: BRAVO-789" "$OUT_FILE"; then
		pass "source_ticket: BRAVO-789 in frontmatter"
	else
		fail "source_ticket not BRAVO-789 in frontmatter"
	fi
else
	fail "No output file containing BRAVO-789 found"
	ls -la "$TEST_DIR/thoughts/shared/plans/" 2>/dev/null || true
fi

# ── Test 21: inject-plan-template emits guidance in plan mode ──────────────

run_test "inject-plan-template emits JSON guidance in plan mode"

RESULT=$(echo '{"permission_mode":"plan","cwd":"/tmp"}' | bash "$INJECT_PLAN_SCRIPT")

if echo "$RESULT" | jq -e '.additionalContext' >/dev/null 2>&1; then
	pass "Valid JSON with additionalContext emitted"
else
	fail "Output is not valid JSON with additionalContext: $RESULT"
fi

if echo "$RESULT" | jq -r '.additionalContext' | grep -q "Implementation Phases"; then
	pass "Guidance content includes plan structure sections"
else
	fail "Guidance content missing expected sections"
fi

# ── Test 22: inject-plan-template is silent outside plan mode ──────────────

run_test "inject-plan-template emits nothing outside plan mode"

RESULT=$(echo '{"permission_mode":"default","cwd":"/tmp"}' | bash "$INJECT_PLAN_SCRIPT")

if [[ -z $RESULT ]]; then
	pass "No output in default mode"
else
	fail "Unexpected output in default mode: $RESULT"
fi

RESULT2=$(echo '{"cwd":"/tmp"}' | bash "$INJECT_PLAN_SCRIPT")

if [[ -z $RESULT2 ]]; then
	pass "No output when permission_mode is absent"
else
	fail "Unexpected output when permission_mode absent: $RESULT2"
fi

# ── Test 23: inject-plan-template uses ticket prefix from config ───────────

run_test "inject-plan-template reads ticket prefix from project config"

TEST_DIR="$TMPDIR/test23"
setup_project "$TEST_DIR"
cat >"$TEST_DIR/.catalyst/config.json" <<'CONF'
{"catalyst":{"project":{"ticketPrefix":"ACME"}}}
CONF

RESULT=$(echo '{"permission_mode":"plan"}' |
	CLAUDE_PROJECT_DIR="$TEST_DIR" bash "$INJECT_PLAN_SCRIPT")

if echo "$RESULT" | jq -r '.additionalContext' | grep -q "ACME-123"; then
	pass "Ticket prefix ACME injected into guidance"
else
	fail "Ticket prefix ACME not found in guidance"
fi

# ── Test 24: check-project-setup.sh exits 1 when thoughts/shared missing ──

run_test "check-project-setup.sh exits fatal when thoughts/shared is missing"

TEST_DIR="$TMPDIR/test24"
mkdir -p "$TEST_DIR/.catalyst"
(cd "$TEST_DIR" && git init -q . && git commit -q --allow-empty -m "init")
cp "$SETUP_SCRIPT" "$TEST_DIR/check-project-setup.sh"
chmod +x "$TEST_DIR/check-project-setup.sh"
mkdir -p "$TEST_DIR/plugins/dev/scripts"
cp "$WORKFLOW_SCRIPT" "$TEST_DIR/plugins/dev/scripts/workflow-context.sh"
chmod +x "$TEST_DIR/plugins/dev/scripts/workflow-context.sh"

EXIT_CODE=0
(cd "$TEST_DIR" && bash check-project-setup.sh >/dev/null 2>&1) || EXIT_CODE=$?

if [[ $EXIT_CODE -ne 0 ]]; then
	pass "Exit code $EXIT_CODE (fatal) when thoughts/shared missing"
else
	fail "Exit code 0 (success) when thoughts/shared is missing — should be fatal"
fi

# ── Test 25: check-project-setup.sh exits 0 for warnings ──────────────────

run_test "check-project-setup.sh exits 0 (warning only) for non-fatal issues"

TEST_DIR="$TMPDIR/test25"
setup_project "$TEST_DIR"
cp "$SETUP_SCRIPT" "$TEST_DIR/plugins/dev/scripts/check-project-setup.sh"
chmod +x "$TEST_DIR/plugins/dev/scripts/check-project-setup.sh"

rm -f "$TEST_DIR/.catalyst/config.json"

EXIT_CODE=0
(cd "$TEST_DIR" && bash plugins/dev/scripts/check-project-setup.sh >/dev/null 2>&1) || EXIT_CODE=$?

if [[ $EXIT_CODE -eq 0 ]]; then
	pass "Exit code 0 for warning-only conditions"
else
	fail "Exit code $EXIT_CODE — warnings should not be fatal"
fi

# ── Test 26: resolve-ticket.sh returns explicit argument ──────────────────

run_test "resolve-ticket.sh returns explicit ticket argument"

TEST_DIR="$TMPDIR/test26"
setup_project "$TEST_DIR"

RESULT=$(cd "$TEST_DIR" && bash "$RESOLVE_TICKET_SCRIPT" "PROJ-999")
if [[ $RESULT == "PROJ-999" ]]; then
	pass "Explicit ticket PROJ-999 returned"
else
	fail "resolve-ticket returned '$RESULT', expected 'PROJ-999'"
fi

# ── Test 27: resolve-ticket.sh extracts from branch name ─────────────────

run_test "resolve-ticket.sh extracts ticket from branch name"

TEST_DIR="$TMPDIR/test27"
setup_project "$TEST_DIR"

# Create a branch with ticket ID in name
(cd "$TEST_DIR" && git checkout -qb ryan/ctl-42-add-feature)

RESULT=$(cd "$TEST_DIR" && bash "$RESOLVE_TICKET_SCRIPT")
if [[ $RESULT == "CTL-42" ]]; then
	pass "Ticket CTL-42 extracted from branch name"
else
	fail "resolve-ticket returned '$RESULT', expected 'CTL-42'"
fi

# ── Test 28: resolve-ticket.sh falls back to currentTicket ───────────────

run_test "resolve-ticket.sh falls back to currentTicket from workflow-context"

TEST_DIR="$TMPDIR/test28"
setup_project "$TEST_DIR"

# Set currentTicket in workflow-context
(cd "$TEST_DIR" && bash plugins/dev/scripts/workflow-context.sh add research "thoughts/shared/research/r1.md" "ABC-100")

# Create a branch with NO ticket ID
(cd "$TEST_DIR" && git checkout -qb feature/no-ticket-here)

RESULT=$(cd "$TEST_DIR" && bash "$RESOLVE_TICKET_SCRIPT")
if [[ $RESULT == "ABC-100" ]]; then
	pass "currentTicket ABC-100 used as fallback"
else
	fail "resolve-ticket returned '$RESULT', expected 'ABC-100'"
fi

# ── Test 29: resolve-ticket.sh reads source_ticket from frontmatter ──────

run_test "resolve-ticket.sh reads source_ticket from most recent document"

TEST_DIR="$TMPDIR/test29"
setup_project "$TEST_DIR"

# Create a document with source_ticket frontmatter
cat >"$TEST_DIR/thoughts/shared/plans/test-plan.md" <<'DOC'
---
source_ticket: XYZ-500
status: ready_for_implementation
---

# Test Plan
DOC

# Register it in workflow context
(cd "$TEST_DIR" && bash plugins/dev/scripts/workflow-context.sh add plans "thoughts/shared/plans/test-plan.md" "null")

# Create a branch with NO ticket ID
(cd "$TEST_DIR" && git checkout -qb feature/plain-branch)

RESULT=$(cd "$TEST_DIR" && bash "$RESOLVE_TICKET_SCRIPT")
if [[ $RESULT == "XYZ-500" ]]; then
	pass "source_ticket XYZ-500 read from frontmatter"
else
	fail "resolve-ticket returned '$RESULT', expected 'XYZ-500'"
fi

# ── Test 30: set-ticket sets currentTicket without adding a document ────

run_test "workflow-context.sh set-ticket sets currentTicket without adding a document"

TEST_DIR="$TMPDIR/test30"
setup_project "$TEST_DIR"

(cd "$TEST_DIR" && bash plugins/dev/scripts/workflow-context.sh set-ticket "PROJ-42")

TICKET=$(cd "$TEST_DIR" && jq -r '.currentTicket' .catalyst/.workflow-context.json)
UPDATED=$(cd "$TEST_DIR" && jq -r '.lastUpdated' .catalyst/.workflow-context.json)
RESEARCH_COUNT=$(cd "$TEST_DIR" && jq '.workflow.research | length' .catalyst/.workflow-context.json)

if [[ $TICKET == "PROJ-42" ]]; then
	pass "currentTicket set to PROJ-42"
else
	fail "currentTicket is '$TICKET', expected 'PROJ-42'"
fi
if [[ -n $UPDATED && $UPDATED != "" ]]; then
	pass "lastUpdated is set"
else
	fail "lastUpdated should be set after set-ticket"
fi
if [[ $RESEARCH_COUNT -eq 0 ]]; then
	pass "No documents added (workflow arrays empty)"
else
	fail "research array has $RESEARCH_COUNT items, expected 0"
fi

# ── Test 31: backward compat — reads from .claude/ if .catalyst/ missing ─

run_test "workflow-context.sh reads from .claude/ when .catalyst/ doesn't exist"

TEST_DIR="$TMPDIR/test31"
mkdir -p "$TEST_DIR"
(
	cd "$TEST_DIR"
	git init -q .
	mkdir -p .claude
	mkdir -p thoughts/shared/research
	mkdir -p plugins/dev/scripts
	cp "$WORKFLOW_SCRIPT" plugins/dev/scripts/workflow-context.sh
	chmod +x plugins/dev/scripts/workflow-context.sh

	# Write context directly to .claude/ (legacy location)
	cat >".claude/.workflow-context.json" <<'EOF'
{
  "lastUpdated": "2026-01-01T00:00:00Z",
  "currentTicket": "LEGACY-1",
  "mostRecentDocument": {"type": "research", "path": "thoughts/shared/research/old.md", "created": "2026-01-01T00:00:00Z", "ticket": "LEGACY-1"},
  "workflow": {
    "research": [{"path": "thoughts/shared/research/old.md", "created": "2026-01-01T00:00:00Z", "ticket": "LEGACY-1"}],
    "plans": [],
    "handoffs": [],
    "prs": []
  }
}
EOF
	git add -A && git commit -q -m "initial"
)

RESULT=$(cd "$TEST_DIR" && bash plugins/dev/scripts/workflow-context.sh recent research)
if [[ $RESULT == "thoughts/shared/research/old.md" ]]; then
	pass "Legacy .claude/ context read correctly"
else
	fail "recent returned '$RESULT', expected 'thoughts/shared/research/old.md'"
fi

# ── Test 32: set-orchestration sets orchestration field ───────────────────

run_test "workflow-context.sh set-orchestration sets orchestration field"

TEST_DIR="$TMPDIR/test32"
setup_project "$TEST_DIR"

(cd "$TEST_DIR" && bash plugins/dev/scripts/workflow-context.sh set-orchestration "orch-data-import-2026-04-13")

ORCH=$(cd "$TEST_DIR" && jq -r '.orchestration' .catalyst/.workflow-context.json)
UPDATED=$(cd "$TEST_DIR" && jq -r '.lastUpdated' .catalyst/.workflow-context.json)

if [[ $ORCH == "orch-data-import-2026-04-13" ]]; then
	pass "orchestration set correctly"
else
	fail "orchestration is '$ORCH', expected 'orch-data-import-2026-04-13'"
fi
if [[ -n $UPDATED && $UPDATED != "" ]]; then
	pass "lastUpdated is set"
else
	fail "lastUpdated should be set after set-orchestration"
fi

# ── Test 33: init includes orchestration field ───────────────────────────

run_test "workflow-context.sh init creates context with orchestration field"

TEST_DIR="$TMPDIR/test33"
setup_project "$TEST_DIR"

(cd "$TEST_DIR" && bash plugins/dev/scripts/workflow-context.sh init)

ORCH=$(cd "$TEST_DIR" && jq -r '.orchestration' .catalyst/.workflow-context.json)
if [[ $ORCH == "null" ]]; then
	pass "orchestration defaults to null"
else
	fail "orchestration is '$ORCH', expected 'null'"
fi

# ── Test 34: set-orchestration preserves currentTicket ───────────────────

run_test "set-orchestration does not overwrite currentTicket"

TEST_DIR="$TMPDIR/test34"
setup_project "$TEST_DIR"

(
	cd "$TEST_DIR"
	bash plugins/dev/scripts/workflow-context.sh set-ticket "ADV-220"
	bash plugins/dev/scripts/workflow-context.sh set-orchestration "orch-data-import-2026-04-13"
)

TICKET=$(cd "$TEST_DIR" && jq -r '.currentTicket' .catalyst/.workflow-context.json)
ORCH=$(cd "$TEST_DIR" && jq -r '.orchestration' .catalyst/.workflow-context.json)

if [[ $TICKET == "ADV-220" ]]; then
	pass "currentTicket preserved as ADV-220"
else
	fail "currentTicket is '$TICKET', expected 'ADV-220'"
fi
if [[ $ORCH == "orch-data-import-2026-04-13" ]]; then
	pass "orchestration set correctly alongside ticket"
else
	fail "orchestration is '$ORCH', expected 'orch-data-import-2026-04-13'"
fi

# ── Summary ────────────────────────────────────────────────────────────────

echo ""
echo "=============================="
echo "Tests: $TESTS | Failures: $FAILURES"
if [[ $PASS == true ]]; then
	echo "ALL TESTS PASSED"
	exit 0
else
	echo "SOME TESTS FAILED"
	exit 1
fi
