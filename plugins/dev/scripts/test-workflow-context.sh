#!/usr/bin/env bash
# Test suite for workflow-context.sh and update-workflow-context.sh
#
# Validates:
# - Context file creation and initialization
# - Document add/query operations
# - Path normalization (absolute, symlink-resolved, relative)
# - Project root resolution from subdirectories
# - check-project-setup.sh integration

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKFLOW_SCRIPT="$SCRIPT_DIR/workflow-context.sh"
HOOK_SCRIPT="$SCRIPT_DIR/../hooks/update-workflow-context.sh"
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
		mkdir -p .claude
		mkdir -p thoughts/shared/research
		mkdir -p thoughts/shared/plans
		mkdir -p thoughts/shared/handoffs
		mkdir -p thoughts/shared/prs
		mkdir -p plugins/dev/scripts
		mkdir -p plugins/dev/hooks

		# Copy the scripts under test into the fake project
		cp "$WORKFLOW_SCRIPT" plugins/dev/scripts/workflow-context.sh
		cp "$HOOK_SCRIPT" plugins/dev/hooks/update-workflow-context.sh
		chmod +x plugins/dev/scripts/workflow-context.sh
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

if [[ -f "$TEST_DIR/.claude/.workflow-context.json" ]]; then
	pass "Context file was created"
else
	fail "Context file was not created"
fi

# Validate JSON structure
if jq -e '.workflow.research' "$TEST_DIR/.claude/.workflow-context.json" >/dev/null 2>&1; then
	pass "JSON structure is valid with workflow.research array"
else
	fail "JSON structure is invalid or missing workflow.research"
fi

# ── Test 2: add inserts document and updates mostRecent ────────────────────

run_test "add inserts document and updates mostRecentDocument"

TEST_DIR="$TMPDIR/test2"
setup_project "$TEST_DIR"

(cd "$TEST_DIR" && bash plugins/dev/scripts/workflow-context.sh add research "thoughts/shared/research/2026-01-01-PROJ-123-auth.md" "PROJ-123")

RESULT=$(jq -r '.mostRecentDocument.path' "$TEST_DIR/.claude/.workflow-context.json")
if [[ "$RESULT" == "thoughts/shared/research/2026-01-01-PROJ-123-auth.md" ]]; then
	pass "mostRecentDocument.path is correct"
else
	fail "mostRecentDocument.path is '$RESULT', expected 'thoughts/shared/research/2026-01-01-PROJ-123-auth.md'"
fi

TICKET=$(jq -r '.currentTicket' "$TEST_DIR/.claude/.workflow-context.json")
if [[ "$TICKET" == "PROJ-123" ]]; then
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
if [[ "$RESULT" == "thoughts/shared/research/new.md" ]]; then
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
if [[ "$COUNT" -eq 2 ]]; then
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

if [[ -f "$TEST_DIR/.claude/.workflow-context.json" ]]; then
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
if [[ "$RESULT" == "thoughts/shared/plans/2026-01-01-PROJ-456-feature.md" ]]; then
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
if [[ "$RESULT" == "thoughts/shared/research/2026-01-01-SYM-789-test.md" ]]; then
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

TICKET=$(jq -r '.currentTicket' "$TEST_DIR/.claude/.workflow-context.json")
if [[ "$TICKET" == "CTL-24" ]]; then
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

if [[ ! -f "$TEST_DIR/.claude/.workflow-context.json" ]]; then
	pass "No context file created for non-thoughts file"
else
	MOST_RECENT=$(jq -r '.mostRecentDocument' "$TEST_DIR/.claude/.workflow-context.json")
	if [[ "$MOST_RECENT" == "null" ]]; then
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
if [[ "$RESULT" == "thoughts/shared/prs/2026-01-01-PR-42.md" ]]; then
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

if [[ "$R" == *"r.md" && "$P" == *"p.md" && "$H" == *"h.md" && "$PR" == *"pr.md" ]]; then
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
rm -f "$TEST_DIR/.claude/.workflow-context.json"

# Create minimal CLAUDE.md so the script doesn't error on missing it
echo "# Test Project" >"$TEST_DIR/CLAUDE.md"

# Create config.json so the script doesn't warn too much
cat >"$TEST_DIR/.claude/config.json" <<'CONF'
{"catalyst":{"projectKey":"test","project":{"ticketPrefix":"TEST"},"linear":{"teamKey":"TEST","stateMap":{"backlog":"Backlog"}}}}
CONF

(cd "$TEST_DIR" && bash plugins/dev/scripts/check-project-setup.sh 2>&1) || true

if [[ -f "$TEST_DIR/.claude/.workflow-context.json" ]]; then
	pass "check-project-setup.sh created the context file"
else
	fail "check-project-setup.sh did not create the context file"
fi

# ── Summary ────────────────────────────────────────────────────────────────

echo ""
echo "=============================="
echo "Tests: $TESTS | Failures: $FAILURES"
if [[ "$PASS" == true ]]; then
	echo "ALL TESTS PASSED"
	exit 0
else
	echo "SOME TESTS FAILED"
	exit 1
fi
