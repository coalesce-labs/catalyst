#!/usr/bin/env bash
# CAT-158: secret-shaped worker settings and dispatch env values must be
# redacted from stdout dumps without changing the real worker spawn payload.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
DISPATCH="${REPO_ROOT}/plugins/dev/scripts/phase-agent-dispatch"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t cat-158-settings-redaction-XXXXXX)"
TEST_DISPATCH="${REPO_ROOT}/plugins/dev/scripts/.phase-agent-dispatch-cat158-test.$$"
trap 'rm -rf "$SCRATCH"; rm -f "$TEST_DISPATCH"' EXIT

pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
assert_eq() {
	local expected="$1" actual="$2" label="$3"
	if [[ $expected == "$actual" ]]; then pass "$label"; else fail "$label — expected '$expected', got '$actual'"; fi
}
assert_contains() {
	local haystack="$1" needle="$2" label="$3"
	if [[ $haystack == *"$needle"* ]]; then pass "$label"; else fail "$label — missing '$needle'"; fi
}
assert_not_contains() {
	local haystack="$1" needle="$2" label="$3"
	if [[ $haystack != *"$needle"* ]]; then pass "$label"; else fail "$label — leaked '$needle'"; fi
}

# Load only the two pure helpers. This deliberately fails in the red phase when
# the CAT-158 functions do not exist yet, without executing dispatcher startup.
HELPERS=$(awk '
  /^redacted_worker_settings_json\(\)/ { capture=1 }
  /^redacted_dispatch_env_json\(\)/ { capture=1 }
  capture { print }
  capture && /^}/ { capture=0 }
' "$DISPATCH")
eval "$HELPERS"

TOKEN="lin_oauth_AAAAAAAABBBBBBBBCCCCCCCC"
SETTINGS=$(jq -nc --arg token "$TOKEN" '{
  env: {
    LINEAR_API_TOKEN: $token,
    LINEAR_API_KEY: "linear-key-secret",
    CATALYST_PHASE_AGENT_LINEARIS_TOKEN: "linearis-secret",
    GITHUB_TOKEN: "github-secret",
    CATALYST_CLOUD_TOKEN: "cloud-secret",
    DATABASE_SECRET: "database-secret",
    PATH: "/test/bin",
    CATALYST_TICKET: "CAT-158",
    CATALYST_PHASE: "implement",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
    AGENT_BROWSER_IDLE_TIMEOUT_MS: "300000"
  },
  worktree: {bgIsolation: "none"},
  statusLine: {type: "command", command: "/tmp/statusline"}
}')

echo "Test 1: settings helper redacts secret-shaped env keys only"
REDACTED=$(redacted_worker_settings_json "$SETTINGS")
for key in LINEAR_API_TOKEN LINEAR_API_KEY CATALYST_PHASE_AGENT_LINEARIS_TOKEN GITHUB_TOKEN CATALYST_CLOUD_TOKEN DATABASE_SECRET; do
	assert_eq "[REDACTED]" "$(jq -r --arg key "$key" '.env[$key]' <<<"$REDACTED")" "$key is redacted"
done
assert_not_contains "$REDACTED" "$TOKEN" "raw Linear token absent from redacted settings"

echo "Test 2: benign env and non-env settings survive unchanged"
for key in PATH CATALYST_TICKET CATALYST_PHASE OTEL_EXPORTER_OTLP_ENDPOINT AGENT_BROWSER_IDLE_TIMEOUT_MS; do
	assert_eq "$(jq -r --arg key "$key" '.env[$key]' <<<"$SETTINGS")" \
		"$(jq -r --arg key "$key" '.env[$key]' <<<"$REDACTED")" "$key survives verbatim"
done
assert_eq "none" "$(jq -r '.worktree.bgIsolation' <<<"$REDACTED")" "worktree settings survive"
assert_eq "$(jq -c '.statusLine' <<<"$SETTINGS")" "$(jq -c '.statusLine' <<<"$REDACTED")" "statusLine survives unchanged"

echo "Test 3: dispatch env helper redacts KEY=VALUE entries"
ENV_JSON=$(redacted_dispatch_env_json \
	"LINEAR_API_TOKEN=$TOKEN" "CATALYST_TICKET=CAT-158" "PATH=/test/bin")
assert_contains "$(jq -r '.[]' <<<"$ENV_JSON")" "LINEAR_API_TOKEN=[REDACTED]" "secret dispatch env entry redacted"
assert_contains "$(jq -r '.[]' <<<"$ENV_JSON")" "CATALYST_TICKET=CAT-158" "benign dispatch env entry survives"
assert_not_contains "$ENV_JSON" "$TOKEN" "raw token absent from dispatch env JSON"

echo "Test 4: malformed settings fail closed"
MALFORMED='not-json-lin_oauth_MALFORMED_SENTINEL'
assert_eq '{}' "$(redacted_worker_settings_json "$MALFORMED")" "malformed input becomes empty object"
assert_not_contains "$(redacted_worker_settings_json "$MALFORMED")" "$MALFORMED" "malformed raw input is never passed through"

# Build a same-directory copy so SCRIPT_DIR and all sourced libraries remain
# real. Replace only the composition assignment with the fixture payload; all
# dump and spawn call sites are the production implementation under test.
awk '
  /^WORKER_SETTINGS_JSON="\$\(compose_worker_settings_json\)"$/ {
    print "WORKER_SETTINGS_JSON=\"${CATALYST_TEST_WORKER_SETTINGS_JSON-}\""
    next
  }
	  { print }
' "$DISPATCH" >"$TEST_DISPATCH"
chmod +x "$TEST_DISPATCH"

setup_fixture() {
	local tag="$1"
	TEST_DIR="${SCRATCH}/${tag}"
	ORCH_DIR="${TEST_DIR}/orch"
	WORKTREE="${TEST_DIR}/worktree"
	BIN_DIR="${TEST_DIR}/bin"
	mkdir -p "$ORCH_DIR/workers/CAT-158" "$WORKTREE" "$BIN_DIR"
	cat >"${BIN_DIR}/claude" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$CLAUDE_STUB_LOG"
printf 'backgrounded · deadbeef\n'
STUB
	cat >"${BIN_DIR}/linearis" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
	chmod +x "${BIN_DIR}/claude" "${BIN_DIR}/linearis"
	export PATH="${BIN_DIR}:${ORIGINAL_PATH}"
	export CLAUDE_STUB_LOG="${TEST_DIR}/claude.log"
	export CATALYST_DISPATCH_CLAUDE_BIN="${BIN_DIR}/claude"
	export CATALYST_MACHINE_CONFIG="${TEST_DIR}/machine-config-absent.json"
	export CATALYST_HOST_NAME="test-host"
	export CATALYST_TEST_WORKER_SETTINGS_JSON="$SETTINGS"
}
ORIGINAL_PATH="$PATH"

echo "Test 5: --dry-run dump redacts settings and full stdout"
setup_fixture dry
DRY_OUT=$(cd "$WORKTREE" && "$TEST_DISPATCH" --dry-run --phase triage --ticket CAT-158 \
	--orch-dir "$ORCH_DIR" --orch-id CAT-158 --worktree "$WORKTREE" 2>/dev/null)
assert_eq "[REDACTED]" "$(jq -r '.settings.env.LINEAR_API_TOKEN' <<<"$DRY_OUT")" "dry-run settings token redacted"
assert_not_contains "$DRY_OUT" "$TOKEN" "dry-run full stdout contains no raw token"

echo "Test 6: real spawn payload remains unredacted"
setup_fixture spawn
(cd "$WORKTREE" && "$TEST_DISPATCH" --phase triage --ticket CAT-158 \
	--orch-dir "$ORCH_DIR" --orch-id CAT-158 --worktree "$WORKTREE" >/dev/null 2>&1)
SPAWN_LOG=$(cat "$CLAUDE_STUB_LOG")
assert_contains "$SPAWN_LOG" "$TOKEN" "claude --settings argv receives the real token"
assert_not_contains "$SPAWN_LOG" '[REDACTED]' "spawn payload is not redacted"

echo "Test 7: prelaunch-only dump has the same redaction guarantee"
setup_fixture prelaunch
PRE_OUT=$(cd "$WORKTREE" && "$TEST_DISPATCH" --phase triage --ticket CAT-158 \
	--orch-dir "$ORCH_DIR" --orch-id CAT-158 --worktree "$WORKTREE" --launch-mode prelaunch-only 2>/dev/null)
assert_eq "[REDACTED]" "$(jq -r '.settings.env.LINEAR_API_TOKEN' <<<"$PRE_OUT")" "prelaunch settings token redacted"
assert_not_contains "$PRE_OUT" "$TOKEN" "prelaunch full stdout contains no raw token"
assert_eq "prelaunch-ready" "$(jq -r '.status' <<<"$PRE_OUT")" "prelaunch launch spec still emitted"
[[ ! -f $CLAUDE_STUB_LOG ]] && pass "prelaunch-only does not spawn claude" || fail "prelaunch-only unexpectedly spawned claude"

echo
echo "phase-agent-dispatch settings redaction: ${PASSES} passed, ${FAILURES} failed"
[[ $FAILURES -eq 0 ]]
