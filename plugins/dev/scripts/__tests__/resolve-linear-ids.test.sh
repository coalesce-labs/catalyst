#!/usr/bin/env bash
# Shell tests for resolve-linear-ids (CTL-207).
#
# Run: bash plugins/dev/scripts/__tests__/resolve-linear-ids.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
RESOLVE="${REPO_ROOT}/plugins/dev/scripts/resolve-linear-ids.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

run() {
  local name="$1"; shift
  if "$@" > "${SCRATCH}/out" 2>&1; then
    PASSES=$((PASSES+1))
    echo "  PASS: $name"
  else
    FAILURES=$((FAILURES+1))
    echo "  FAIL: $name"
    echo "    command: $*"
    echo "    output:"
    sed 's/^/      /' "${SCRATCH}/out"
  fi
}

expect_contains() {
  local file="$1" needle="$2"
  grep -qF "$needle" "$file"
}

# ─── Setup: fake curl that returns a canned GraphQL response ─────────────
FAKE_TEAM_ID="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
FAKE_STATE_BACKLOG_ID="11111111-2222-3333-4444-555555555555"
FAKE_STATE_INPROG_ID="22222222-3333-4444-5555-666666666666"
FAKE_STATE_REVIEW_ID="33333333-4444-5555-6666-777777777777"
FAKE_STATE_DONE_ID="44444444-5555-6666-7777-888888888888"

install_fake_curl() {
  local bin_dir="$1" exit_code="${2:-0}" response="${3:-}"
  mkdir -p "$bin_dir"

  if [ -z "$response" ]; then
    response=$(cat <<JSON
{"data":{"teams":{"nodes":[{"id":"${FAKE_TEAM_ID}","states":{"nodes":[
  {"id":"${FAKE_STATE_BACKLOG_ID}","name":"Backlog","type":"backlog"},
  {"id":"${FAKE_STATE_INPROG_ID}","name":"In Progress","type":"started"},
  {"id":"${FAKE_STATE_REVIEW_ID}","name":"In Review","type":"started"},
  {"id":"${FAKE_STATE_DONE_ID}","name":"Done","type":"completed"}
]}}]}}}
JSON
    )
  fi

  cat > "${bin_dir}/curl" <<SCRIPT
#!/usr/bin/env bash
echo '$response'
exit $exit_code
SCRIPT
  chmod +x "${bin_dir}/curl"
}

build_config() {
  local dir="$1"
  mkdir -p "${dir}/.catalyst"
  cat > "${dir}/.catalyst/config.json" <<'EOF'
{
  "catalyst": {
    "projectKey": "test-project",
    "linear": {
      "teamKey": "TST",
      "stateMap": {
        "backlog": "Backlog",
        "inProgress": "In Progress",
        "inReview": "In Review",
        "done": "Done"
      }
    }
  }
}
EOF
}

build_secrets() {
  local project_key="$1"
  mkdir -p "${SCRATCH}/home/.config/catalyst"
  cat > "${SCRATCH}/home/.config/catalyst/config-${project_key}.json" <<'EOF'
{
  "linear": {
    "apiToken": "lin_api_fake_token_12345"
  }
}
EOF
}

echo "resolve-linear-ids tests"

# ─── Test 1: resolves and writes teamId + stateIds to config ──────────────
WORK1="${SCRATCH}/t1"
BIN1="${SCRATCH}/t1/bin"
build_config "$WORK1"
build_secrets "test-project"
install_fake_curl "$BIN1"

run "resolves teamId and stateIds" \
  bash -c "HOME='$SCRATCH/home' PATH='$BIN1:$PATH' \
    '$RESOLVE' --config '$WORK1/.catalyst/config.json'"

run "teamId written to config" \
  bash -c "jq -e '.catalyst.linear.teamId == \"$FAKE_TEAM_ID\"' '$WORK1/.catalyst/config.json'"

run "stateIds written to config" \
  bash -c "jq -e '.catalyst.linear.stateIds[\"Backlog\"] == \"$FAKE_STATE_BACKLOG_ID\"' '$WORK1/.catalyst/config.json'"

run "stateIds contains all states" \
  bash -c "jq -e '.catalyst.linear.stateIds | length == 4' '$WORK1/.catalyst/config.json'"

run "existing config fields preserved" \
  bash -c "jq -e '.catalyst.linear.teamKey == \"TST\"' '$WORK1/.catalyst/config.json'"

run "stateMap preserved after write" \
  bash -c "jq -e '.catalyst.linear.stateMap.done == \"Done\"' '$WORK1/.catalyst/config.json'"

# ─── Test 2: --dry-run does not modify config ────────────────────────────
WORK2="${SCRATCH}/t2"
BIN2="${SCRATCH}/t2/bin"
build_config "$WORK2"
install_fake_curl "$BIN2"

BEFORE=$(cat "$WORK2/.catalyst/config.json")

run "--dry-run exits 0" \
  bash -c "HOME='$SCRATCH/home' PATH='$BIN2:$PATH' \
    '$RESOLVE' --config '$WORK2/.catalyst/config.json' --dry-run"

AFTER=$(cat "$WORK2/.catalyst/config.json")
run "--dry-run does not modify config" \
  bash -c "[ '$BEFORE' = '$AFTER' ]"

# ─── Test 3: --json produces JSON output ──────────────────────────────────
WORK3="${SCRATCH}/t3"
BIN3="${SCRATCH}/t3/bin"
OUT3="${SCRATCH}/t3/stdout"
build_config "$WORK3"
install_fake_curl "$BIN3"

HOME="$SCRATCH/home" PATH="$BIN3:$PATH" \
  "$RESOLVE" --config "$WORK3/.catalyst/config.json" --json > "$OUT3" 2>&1 || true

run "--json output has action" \
  bash -c "jq -e '.action == \"resolved\"' '$OUT3'"

run "--json output has teamId" \
  bash -c "jq -e '.teamId == \"$FAKE_TEAM_ID\"' '$OUT3'"

run "--json output has stateCount" \
  bash -c "jq -e '.stateCount == 4' '$OUT3'"

# ─── Test 4: skips when stateIds already cached ──────────────────────────
WORK4="${SCRATCH}/t4"
BIN4="${SCRATCH}/t4/bin"
build_config "$WORK4"
install_fake_curl "$BIN4"

jq '.catalyst.linear.stateIds = {"Backlog": "existing-uuid"}' \
  "$WORK4/.catalyst/config.json" > "$WORK4/.catalyst/config.json.tmp" \
  && mv "$WORK4/.catalyst/config.json.tmp" "$WORK4/.catalyst/config.json"

run "skips when stateIds already cached" \
  bash -c "HOME='$SCRATCH/home' PATH='$BIN4:$PATH' \
    '$RESOLVE' --config '$WORK4/.catalyst/config.json' 2>&1 | grep -q 'already cached'"

# ─── Test 5: --force re-resolves even when cached ────────────────────────
WORK5="${SCRATCH}/t5"
BIN5="${SCRATCH}/t5/bin"
build_config "$WORK5"
install_fake_curl "$BIN5"

jq '.catalyst.linear.stateIds = {"Backlog": "old-uuid"}' \
  "$WORK5/.catalyst/config.json" > "$WORK5/.catalyst/config.json.tmp" \
  && mv "$WORK5/.catalyst/config.json.tmp" "$WORK5/.catalyst/config.json"

run "--force re-resolves even when cached" \
  bash -c "HOME='$SCRATCH/home' PATH='$BIN5:$PATH' \
    '$RESOLVE' --config '$WORK5/.catalyst/config.json' --force"

run "--force overwrites old stateIds" \
  bash -c "jq -e '.catalyst.linear.stateIds[\"Backlog\"] == \"$FAKE_STATE_BACKLOG_ID\"' '$WORK5/.catalyst/config.json'"

# ─── Test 6: fails gracefully when API token missing ─────────────────────
WORK6="${SCRATCH}/t6"
build_config "$WORK6"
mkdir -p "${SCRATCH}/home6/.config/catalyst"
echo '{}' > "${SCRATCH}/home6/.config/catalyst/config-test-project.json"

run "fails when API token missing" \
  bash -c "! HOME='$SCRATCH/home6' '$RESOLVE' --config '$WORK6/.catalyst/config.json' 2>/dev/null"

# ─── Test 7: fails gracefully when config missing ────────────────────────
run "fails when config missing" \
  bash -c "! '$RESOLVE' --config '/nonexistent/config.json' 2>/dev/null"

# ─── Test 8: fails gracefully when teamKey missing ───────────────────────
WORK8="${SCRATCH}/t8"
mkdir -p "${WORK8}/.catalyst"
echo '{"catalyst":{"projectKey":"test","linear":{}}}' > "${WORK8}/.catalyst/config.json"

run "fails when teamKey missing" \
  bash -c "! '$RESOLVE' --config '$WORK8/.catalyst/config.json' 2>/dev/null"

# ─── Test 9: API error returns exit code 2 ────────────────────────────────
WORK9="${SCRATCH}/t9"
BIN9="${SCRATCH}/t9/bin"
build_config "$WORK9"
install_fake_curl "$BIN9" 22 ""

run "API failure returns exit 2" \
  bash -c "HOME='$SCRATCH/home' PATH='$BIN9:$PATH' \
    '$RESOLVE' --config '$WORK9/.catalyst/config.json' 2>/dev/null; [ \$? -eq 2 ]"

echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[ "$FAILURES" = "0" ]
