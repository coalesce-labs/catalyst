#!/usr/bin/env bash
# Shell tests for resolve-linear-ids (CTL-207, CTL-577).
#
# CTL-577: stateIds is no longer written into .catalyst/config.json. It is
# written to a machine-level registry at ~/.config/catalyst/linear-state-ids.json,
# keyed by Linear teamKey. teamId is still written to config.json. Tests fake
# HOME so the registry path resolves into a scratch dir.
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

# build_secrets <home_dir> <project_key>
build_secrets() {
  local home_dir="$1" project_key="$2"
  mkdir -p "${home_dir}/.config/catalyst"
  cat > "${home_dir}/.config/catalyst/config-${project_key}.json" <<'EOF'
{
  "linear": {
    "apiToken": "lin_api_fake_token_12345"
  }
}
EOF
}

# registry path for a given faked HOME
reg_path() { echo "$1/.config/catalyst/linear-state-ids.json"; }

echo "resolve-linear-ids tests"

# ─── Test 1: resolves teamId to config, stateIds to the registry ──────────
WORK1="${SCRATCH}/t1"; HOME1="${WORK1}/home"; BIN1="${WORK1}/bin"
build_config "$WORK1"
build_secrets "$HOME1" "test-project"
install_fake_curl "$BIN1"
REG1="$(reg_path "$HOME1")"

run "resolves teamId and stateIds" \
  bash -c "HOME='$HOME1' PATH='$BIN1:$PATH' \
    '$RESOLVE' --config '$WORK1/.catalyst/config.json'"

run "teamId written to config" \
  bash -c "jq -e '.catalyst.linear.teamId == \"$FAKE_TEAM_ID\"' '$WORK1/.catalyst/config.json'"

run "stateIds NOT written to config" \
  bash -c "jq -e '.catalyst.linear | has(\"stateIds\") | not' '$WORK1/.catalyst/config.json'"

run "stateIds written to registry under teamKey" \
  bash -c "jq -e '.[\"TST\"].stateIds[\"Backlog\"] == \"$FAKE_STATE_BACKLOG_ID\"' '$REG1'"

run "registry entry contains all states" \
  bash -c "jq -e '.[\"TST\"].stateIds | length == 4' '$REG1'"

run "registry entry records resolvedAt" \
  bash -c "jq -e '.[\"TST\"].resolvedAt | type == \"string\" and (length > 0)' '$REG1'"

run "existing config fields preserved" \
  bash -c "jq -e '.catalyst.linear.teamKey == \"TST\"' '$WORK1/.catalyst/config.json'"

run "stateMap preserved after write" \
  bash -c "jq -e '.catalyst.linear.stateMap.done == \"Done\"' '$WORK1/.catalyst/config.json'"

# ─── Test 2: --dry-run does not modify config or registry ─────────────────
WORK2="${SCRATCH}/t2"; HOME2="${WORK2}/home"; BIN2="${WORK2}/bin"
build_config "$WORK2"
build_secrets "$HOME2" "test-project"
install_fake_curl "$BIN2"
REG2="$(reg_path "$HOME2")"

BEFORE=$(cat "$WORK2/.catalyst/config.json")

run "--dry-run exits 0" \
  bash -c "HOME='$HOME2' PATH='$BIN2:$PATH' \
    '$RESOLVE' --config '$WORK2/.catalyst/config.json' --dry-run"

AFTER=$(cat "$WORK2/.catalyst/config.json")
run "--dry-run does not modify config" \
  bash -c "[ '$BEFORE' = '$AFTER' ]"

run "--dry-run does not create registry" \
  bash -c "[ ! -f '$REG2' ]"

# ─── Test 3: --json produces JSON output ──────────────────────────────────
WORK3="${SCRATCH}/t3"; HOME3="${WORK3}/home"; BIN3="${WORK3}/bin"
OUT3="${WORK3}/stdout"
build_config "$WORK3"
build_secrets "$HOME3" "test-project"
install_fake_curl "$BIN3"

HOME="$HOME3" PATH="$BIN3:$PATH" \
  "$RESOLVE" --config "$WORK3/.catalyst/config.json" --json > "$OUT3" 2>&1 || true

run "--json output has action" \
  bash -c "jq -e '.action == \"resolved\"' '$OUT3'"

run "--json output has teamId" \
  bash -c "jq -e '.teamId == \"$FAKE_TEAM_ID\"' '$OUT3'"

run "--json output has stateCount" \
  bash -c "jq -e '.stateCount == 4' '$OUT3'"

# ─── Test 4: skips when stateIds already cached in the registry ───────────
WORK4="${SCRATCH}/t4"; HOME4="${WORK4}/home"; BIN4="${WORK4}/bin"
build_config "$WORK4"
build_secrets "$HOME4" "test-project"
install_fake_curl "$BIN4"
REG4="$(reg_path "$HOME4")"
mkdir -p "$(dirname "$REG4")"
echo '{"TST":{"resolvedAt":"2026-01-01T00:00:00Z","stateIds":{"Backlog":"existing-uuid"}}}' > "$REG4"

run "skips when stateIds already cached" \
  bash -c "HOME='$HOME4' PATH='$BIN4:$PATH' \
    '$RESOLVE' --config '$WORK4/.catalyst/config.json' 2>&1 | grep -q 'already cached'"

# ─── Test 5: --force re-resolves even when cached ────────────────────────
WORK5="${SCRATCH}/t5"; HOME5="${WORK5}/home"; BIN5="${WORK5}/bin"
build_config "$WORK5"
build_secrets "$HOME5" "test-project"
install_fake_curl "$BIN5"
REG5="$(reg_path "$HOME5")"
mkdir -p "$(dirname "$REG5")"
echo '{"TST":{"resolvedAt":"2026-01-01T00:00:00Z","stateIds":{"Backlog":"old-uuid"}}}' > "$REG5"

run "--force re-resolves even when cached" \
  bash -c "HOME='$HOME5' PATH='$BIN5:$PATH' \
    '$RESOLVE' --config '$WORK5/.catalyst/config.json' --force"

run "--force overwrites old stateIds in registry" \
  bash -c "jq -e '.[\"TST\"].stateIds[\"Backlog\"] == \"$FAKE_STATE_BACKLOG_ID\"' '$REG5'"

# ─── Test 6: fails gracefully when API token missing ─────────────────────
WORK6="${SCRATCH}/t6"; HOME6="${WORK6}/home"
build_config "$WORK6"
mkdir -p "${HOME6}/.config/catalyst"
echo '{}' > "${HOME6}/.config/catalyst/config-test-project.json"

run "fails when API token missing" \
  bash -c "! HOME='$HOME6' '$RESOLVE' --config '$WORK6/.catalyst/config.json' 2>/dev/null"

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
WORK9="${SCRATCH}/t9"; HOME9="${WORK9}/home"; BIN9="${WORK9}/bin"
build_config "$WORK9"
build_secrets "$HOME9" "test-project"
install_fake_curl "$BIN9" 22 ""

run "API failure returns exit 2" \
  bash -c "HOME='$HOME9' PATH='$BIN9:$PATH' \
    '$RESOLVE' --config '$WORK9/.catalyst/config.json' 2>/dev/null; [ \$? -eq 2 ]"

# ─── Test 10: registry write preserves sibling team entries ──────────────
WORK10="${SCRATCH}/t10"; HOME10="${WORK10}/home"; BIN10="${WORK10}/bin"
build_config "$WORK10"
build_secrets "$HOME10" "test-project"
install_fake_curl "$BIN10"
REG10="$(reg_path "$HOME10")"
mkdir -p "$(dirname "$REG10")"
echo '{"ADV":{"resolvedAt":"2026-01-01T00:00:00Z","stateIds":{"Done":"adv-done-uuid"}}}' > "$REG10"

run "resolves TST alongside an existing ADV entry" \
  bash -c "HOME='$HOME10' PATH='$BIN10:$PATH' \
    '$RESOLVE' --config '$WORK10/.catalyst/config.json' --force"

run "sibling ADV entry preserved after TST resolve" \
  bash -c "jq -e '.[\"ADV\"].stateIds[\"Done\"] == \"adv-done-uuid\"' '$REG10'"

run "TST entry written alongside ADV" \
  bash -c "jq -e '.[\"TST\"].stateIds[\"Done\"] == \"$FAKE_STATE_DONE_ID\"' '$REG10'"

# ─── Test 11: creates the registry directory when absent ─────────────────
WORK11="${SCRATCH}/t11"; HOME11="${WORK11}/home"; BIN11="${WORK11}/bin"
build_config "$WORK11"
build_secrets "$HOME11" "test-project"
install_fake_curl "$BIN11"
REG11="$(reg_path "$HOME11")"
# Note: build_secrets created ~/.config/catalyst; remove it to prove mkdir -p.
rm -rf "${HOME11}/.config/catalyst/linear-state-ids.json"

run "creates registry when the file does not exist" \
  bash -c "HOME='$HOME11' PATH='$BIN11:$PATH' \
    '$RESOLVE' --config '$WORK11/.catalyst/config.json'"

run "registry file exists after resolve" \
  bash -c "[ -f '$REG11' ] && jq -e '.[\"TST\"].stateIds | length == 4' '$REG11'"

# ─── Test 12: a corrupt registry file is recovered, not silently kept ────
WORK12="${SCRATCH}/t12"; HOME12="${WORK12}/home"; BIN12="${WORK12}/bin"
build_config "$WORK12"
build_secrets "$HOME12" "test-project"
install_fake_curl "$BIN12"
REG12="$(reg_path "$HOME12")"
mkdir -p "$(dirname "$REG12")"
printf 'not json{{{' > "$REG12"

run "resolves over a corrupt registry file" \
  bash -c "HOME='$HOME12' PATH='$BIN12:$PATH' \
    '$RESOLVE' --config '$WORK12/.catalyst/config.json' --force"

run "corrupt registry replaced with valid resolved data" \
  bash -c "jq -e '.[\"TST\"].stateIds[\"Done\"] == \"$FAKE_STATE_DONE_ID\"' '$REG12'"

# ─── Test 13: --dry-run leaves an already-populated registry unchanged ────
WORK13="${SCRATCH}/t13"; HOME13="${WORK13}/home"; BIN13="${WORK13}/bin"
build_config "$WORK13"
build_secrets "$HOME13" "test-project"
install_fake_curl "$BIN13"
REG13="$(reg_path "$HOME13")"
mkdir -p "$(dirname "$REG13")"
echo '{"ADV":{"resolvedAt":"2026-01-01T00:00:00Z","stateIds":{"Done":"adv-done"}}}' > "$REG13"
REG13_BEFORE=$(cat "$REG13")

run "--dry-run --force exits 0 with a populated registry" \
  bash -c "HOME='$HOME13' PATH='$BIN13:$PATH' \
    '$RESOLVE' --config '$WORK13/.catalyst/config.json' --dry-run --force"

REG13_AFTER=$(cat "$REG13")
run "--dry-run does not modify the existing registry" \
  bash -c "[ '$REG13_BEFORE' = '$REG13_AFTER' ]"

echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[ "$FAILURES" = "0" ]
