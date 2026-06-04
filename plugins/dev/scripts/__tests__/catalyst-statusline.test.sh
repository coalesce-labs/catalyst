#!/usr/bin/env bash
# Tests for catalyst-statusline.sh — the wrapper that Claude Code invokes as
# its statusLine command. The wrapper renders via ccstatusline (or any
# CATALYST_STATUSLINE_CMD-override) and, in the background, calls
# `catalyst-session.sh emit-context` so we get periodic session.context events.
#
# Hard requirement: the rendered statusline (stdout) MUST NEVER fail, even if
# the emit path errors. Claude Code wouldn't recover from a broken statusLine.
#
# Run: bash plugins/dev/scripts/__tests__/catalyst-statusline.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
WRAPPER="${REPO_ROOT}/plugins/dev/scripts/catalyst-statusline.sh"
SESSION_SCRIPT="${REPO_ROOT}/plugins/dev/scripts/catalyst-session.sh"
DB_SCRIPT="${REPO_ROOT}/plugins/dev/scripts/catalyst-db.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t catalyst-statusline-test-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

export CATALYST_DIR="$SCRATCH"
export CATALYST_DB_FILE="$SCRATCH/catalyst.db"
export CATALYST_MIGRATIONS_DIR="$REPO_ROOT/plugins/dev/scripts/db-migrations"
EVENTS_DIR="$SCRATCH/events"
mkdir -p "$EVENTS_DIR"

ok()   { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; [[ -n "${2:-}" ]] && echo "    $2"; }
expect_eq() {
  if [[ "$2" == "$3" ]]; then ok "$1"; else fail "$1" "expected '$2' got '$3'"; fi
}
expect_contains() {
  if [[ "$2" == *"$3"* ]]; then ok "$1"; else fail "$1" "'$3' not in '$2'"; fi
}

# Apply DB schema
"$DB_SCRIPT" init >/dev/null 2>&1 || { echo "FATAL: db init failed"; exit 1; }

# Build a mock ccstatusline binary that echoes a marker and stdin-derived data
MOCK_BIN_DIR="$SCRATCH/bin"
mkdir -p "$MOCK_BIN_DIR"
cat > "$MOCK_BIN_DIR/mock-ccstatusline" <<'STUB'
#!/usr/bin/env bash
# Reads stdin, writes a deterministic statusline marker to stdout.
input="$(cat || true)"
echo "STATUSLINE_RENDERED:$(printf '%s' "$input" | wc -c | tr -d ' ')"
STUB
chmod +x "$MOCK_BIN_DIR/mock-ccstatusline"

# Wrapper expects to find an executable to delegate to via CATALYST_STATUSLINE_CMD
export CATALYST_STATUSLINE_CMD="$MOCK_BIN_DIR/mock-ccstatusline"

# Build a sample Claude Code statusLine JSON input
STATUS_JSON='{
  "session_id": "claude-uuid-aaaa",
  "transcript_path": "/tmp/transcript.jsonl",
  "model": {"id": "claude-opus-4-7", "display_name": "Opus 4.7"},
  "context_window": {
    "context_window_size": 1000000,
    "current_usage": 245000,
    "used_percentage": 24,
    "remaining_percentage": 76
  },
  "cost": {
    "total_cost_usd": 23.02,
    "total_duration_ms": 100000,
    "total_api_duration_ms": 50000
  },
  "effort": {"level": "high"}
}'

# ─── 1. Pass-through rendering: wrapper forwards mock stdout ────────────────
OUT="$(printf '%s' "$STATUS_JSON" | bash "$WRAPPER" 2>/dev/null)"
expect_contains "wrapper forwards ccstatusline stdout" "$OUT" "STATUSLINE_RENDERED:"

# ─── 2. No matching session — wrapper renders but emits nothing ─────────────
# (no session created yet)
OUT2="$(printf '%s' "$STATUS_JSON" | bash "$WRAPPER" 2>/dev/null)"
expect_contains "wrapper renders even with no matching session" "$OUT2" "STATUSLINE_RENDERED:"

# Wait for any background emit to settle
sleep 1

EVENT_FILE="$EVENTS_DIR/$(date -u +%Y-%m).jsonl"
if [[ -f "$EVENT_FILE" ]]; then
  COUNT_BEFORE_SESSION="$(grep -c 'session.context' "$EVENT_FILE" 2>/dev/null || echo 0)"
else
  COUNT_BEFORE_SESSION=0
fi
expect_eq "no session.context emitted when no catalyst session matches" "0" "$COUNT_BEFORE_SESSION"

# ─── 3. With matching session — wrapper emits one session.context event ─────
SID="$(bash "$SESSION_SCRIPT" start --skill wraptest \
        --claude-session-id "claude-uuid-aaaa")"

OUT3="$(printf '%s' "$STATUS_JSON" | bash "$WRAPPER" 2>/dev/null)"
expect_contains "wrapper renders with matching session" "$OUT3" "STATUSLINE_RENDERED:"

# Background emit may need a tick to land
WAITED=0
while (( WAITED < 20 )); do
  if [[ -f "$EVENT_FILE" ]] && grep -q "session.context" "$EVENT_FILE" 2>/dev/null; then
    break
  fi
  sleep 0.25
  WAITED=$((WAITED + 1))
done

CTX_LINE="$(grep '"session.context"' "$EVENT_FILE" 2>/dev/null | grep "$SID" | tail -n 1)"
[[ -n "$CTX_LINE" ]] && ok "wrapper emitted session.context event for matching session" \
  || fail "wrapper emit" "no session.context line found"

if [[ -n "$CTX_LINE" ]]; then
  PCT="$(printf '%s' "$CTX_LINE" | jq -r '.attributes."claude.context.used_pct"')"
  expect_eq "wrapper-emitted context_pct matches input" "24" "$PCT"

  TOKENS="$(printf '%s' "$CTX_LINE" | jq -r '.attributes."claude.context.tokens"')"
  expect_eq "wrapper-emitted context_tokens matches input" "245000" "$TOKENS"

  MODEL="$(printf '%s' "$CTX_LINE" | jq -r '.attributes."claude.model"')"
  expect_eq "wrapper-emitted claude.model matches input" "claude-opus-4-7" "$MODEL"

  COST="$(printf '%s' "$CTX_LINE" | jq -r '.body.payload.cost_usd')"
  expect_eq "wrapper-emitted cost in body.payload" "23.02" "$COST"
fi

# ─── 3b. CTL-760: rate-limit 5h/7d % forwarded to catalyst-session.sh ───────
# Stub catalyst-session.sh via CATALYST_SESSION_BIN to capture the argv the
# wrapper forwards. The stub records its args and exits 0 so the foreground
# render path is unaffected.
RL_CAPTURE="$SCRATCH/rl-emit-args.log"
RL_SESSION_STUB="$MOCK_BIN_DIR/mock-session-rl.sh"
cat > "$RL_SESSION_STUB" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$@" > "$RL_CAPTURE"
exit 0
STUB
chmod +x "$RL_SESSION_STUB"

# Build an input that carries the rate_limits block Claude Code's statusLine
# payload provides (proven from ccstatusline's input schema).
RL_STATUS_JSON='{
  "session_id": "claude-uuid-aaaa",
  "model": {"id": "claude-opus-4-7"},
  "context_window": {"used_percentage": 24, "current_usage": 245000},
  "rate_limits": {
    "five_hour":    {"used_percentage": 26, "resets_at": "2026-06-03T05:00:00Z"},
    "seven_day":    {"used_percentage": 15, "resets_at": "2026-06-10T00:00:00Z"},
    "seven_day_opus":   {"used_percentage": 12, "resets_at": "2026-06-10T00:00:00Z"},
    "seven_day_sonnet": {"used_percentage": 9,  "resets_at": "2026-06-10T00:00:00Z"}
  }
}'

CATALYST_SESSION_BIN="$RL_SESSION_STUB" \
  bash "$WRAPPER" >/dev/null 2>&1 <<<"$RL_STATUS_JSON"

# Wait for the background emit to land.
RL_WAITED=0
while (( RL_WAITED < 20 )); do
  [[ -f "$RL_CAPTURE" ]] && break
  sleep 0.25
  RL_WAITED=$((RL_WAITED + 1))
done

RL_ARGS="$(cat "$RL_CAPTURE" 2>/dev/null | tr '\n' ' ')"
expect_contains "wrapper forwards --ratelimit-5h-pct 26 to catalyst-session.sh" "$RL_ARGS" "--ratelimit-5h-pct 26"
expect_contains "wrapper forwards --ratelimit-7d-pct 15 to catalyst-session.sh" "$RL_ARGS" "--ratelimit-7d-pct 15"
expect_contains "wrapper forwards --ratelimit-5h-reset to catalyst-session.sh" "$RL_ARGS" "--ratelimit-5h-reset 2026-06-03T05:00:00Z"
expect_contains "wrapper forwards --ratelimit-7d-reset to catalyst-session.sh" "$RL_ARGS" "--ratelimit-7d-reset 2026-06-10T00:00:00Z"
# CTL-763: per-model 7d split forwarded flags.
expect_contains "wrapper forwards --ratelimit-7d-opus-pct 12" "$RL_ARGS" "--ratelimit-7d-opus-pct 12"
expect_contains "wrapper forwards --ratelimit-7d-sonnet-pct 9" "$RL_ARGS" "--ratelimit-7d-sonnet-pct 9"
expect_contains "wrapper forwards --ratelimit-7d-opus-reset" "$RL_ARGS" "--ratelimit-7d-opus-reset 2026-06-10T00:00:00Z"
expect_contains "wrapper forwards --ratelimit-7d-sonnet-reset" "$RL_ARGS" "--ratelimit-7d-sonnet-reset 2026-06-10T00:00:00Z"

# CTL-763: negative path — when per-model fields are absent, no per-model flags emitted.
RL_CAPTURE_BASELINE="$TMPDIR/rl-capture-baseline-$$"
RL_SESSION_STUB_BASELINE="$TMPDIR/rl-stub-baseline-$$.sh"
cat >"$RL_SESSION_STUB_BASELINE" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$@" > "$RL_CAPTURE_BASELINE"
exit 0
STUB
chmod +x "$RL_SESSION_STUB_BASELINE"
RL_STATUS_BASELINE='{
  "session_id": "claude-uuid-baseline",
  "model": {"id": "claude-opus-4-7"},
  "context_window": {"used_percentage": 24, "current_usage": 245000},
  "rate_limits": {
    "five_hour": {"used_percentage": 26, "resets_at": "2026-06-03T05:00:00Z"},
    "seven_day": {"used_percentage": 15, "resets_at": "2026-06-10T00:00:00Z"}
  }
}'
CATALYST_SESSION_BIN="$RL_SESSION_STUB_BASELINE" \
  bash "$WRAPPER" >/dev/null 2>&1 <<<"$RL_STATUS_BASELINE"
RL_WAITED_B=0
while (( RL_WAITED_B < 20 )); do
  [[ -f "$RL_CAPTURE_BASELINE" ]] && break
  sleep 0.25
  RL_WAITED_B=$((RL_WAITED_B + 1))
done
RL_ARGS_BASELINE="$(cat "$RL_CAPTURE_BASELINE" 2>/dev/null | tr '\n' ' ')"
case "$RL_ARGS_BASELINE" in
  *--ratelimit-7d-opus-pct*) fail "no per-model field → no opus flag" "flag present unexpectedly" ;;
  *) ok "no per-model field → no opus flag" ;;
esac

# ─── 4. Resilience: even if emit fails, wrapper still renders ───────────────
# Point the session script at a bogus path so emit silently fails.
export CATALYST_SESSION_BIN="/does/not/exist-$$"
OUT4="$(printf '%s' "$STATUS_JSON" | bash "$WRAPPER" 2>/dev/null)"
expect_contains "wrapper renders even when emit path is broken" "$OUT4" "STATUSLINE_RENDERED:"
unset CATALYST_SESSION_BIN

# ─── 5. Malformed stdin JSON: wrapper still renders ─────────────────────────
OUT5="$(printf 'not json at all' | bash "$WRAPPER" 2>/dev/null)"
expect_contains "wrapper renders on malformed JSON input" "$OUT5" "STATUSLINE_RENDERED:"

# ─── 6. Empty stdin: wrapper still renders ──────────────────────────────────
OUT6="$(printf '' | bash "$WRAPPER" 2>/dev/null)"
expect_contains "wrapper renders on empty stdin" "$OUT6" "STATUSLINE_RENDERED:"

echo ""
echo "Total: $((PASSES + FAILURES)), Passed: $PASSES, Failed: $FAILURES"
exit "$FAILURES"
