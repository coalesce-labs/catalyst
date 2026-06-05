#!/usr/bin/env bash
# Shell tests for setup-execution-core-states.sh (CTL-564 Phase 2).
#
# Two layers:
#   1. Unit  — source the script (sourcing guard suppresses main) and assert
#              its pure helpers directly.
#   2. E2E   — run the script with a fake `curl` earlier on PATH returning
#              canned GraphQL responses, against a fixture .catalyst/config.json.
#
# Run: bash plugins/dev/scripts/__tests__/setup-execution-core-states.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SCRIPT="${REPO_ROOT}/plugins/dev/scripts/setup-execution-core-states.sh"

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

echo "setup-execution-core-states tests"

# ─── Layer 1: pure helper unit tests (source with the guard suppressing main) ─
# shellcheck source=/dev/null
source "$SCRIPT"

# build_execution_core_state_map — exact 11-key collapse map.
STATE_MAP_JSON="$(build_execution_core_state_map)"

run "state map is valid JSON" \
  bash -c "echo '$STATE_MAP_JSON' | jq -e ."

run "state map has 12 keys" \
  bash -c "echo '$STATE_MAP_JSON' | jq -e 'length == 12'"

run "state map todo -> Ready" \
  bash -c "echo '$STATE_MAP_JSON' | jq -e '.todo == \"Ready\"'"

run "state map remediating -> Remediate (CTL-653)" \
  bash -c "echo '$STATE_MAP_JSON' | jq -e '.remediating == \"Remediate\"'"

run "state map triage -> Triage" \
  bash -c "echo '$STATE_MAP_JSON' | jq -e '.triage == \"Triage\"'"

run "state map research -> Research" \
  bash -c "echo '$STATE_MAP_JSON' | jq -e '.research == \"Research\"'"

run "state map planning -> Plan" \
  bash -c "echo '$STATE_MAP_JSON' | jq -e '.planning == \"Plan\"'"

run "state map inProgress -> Implement" \
  bash -c "echo '$STATE_MAP_JSON' | jq -e '.inProgress == \"Implement\"'"

run "state map verifying -> Validate" \
  bash -c "echo '$STATE_MAP_JSON' | jq -e '.verifying == \"Validate\"'"

run "state map reviewing -> Validate" \
  bash -c "echo '$STATE_MAP_JSON' | jq -e '.reviewing == \"Validate\"'"

run "state map inReview -> PR" \
  bash -c "echo '$STATE_MAP_JSON' | jq -e '.inReview == \"PR\"'"

run "state map backlog -> Backlog" \
  bash -c "echo '$STATE_MAP_JSON' | jq -e '.backlog == \"Backlog\"'"

run "state map done -> Done" \
  bash -c "echo '$STATE_MAP_JSON' | jq -e '.done == \"Done\"'"

run "state map canceled -> Canceled" \
  bash -c "echo '$STATE_MAP_JSON' | jq -e '.canceled == \"Canceled\"'"

# contract_states — exactly Ready Research Plan Implement Validate PR (no Triage).
CONTRACT="$(contract_states)"

run "contract_states lists the 6 contract names" \
  bash -c "[ \"\$(echo '$CONTRACT' | jq -r '.[].name' | sort | tr '\n' ' ')\" = 'Implement Plan PR Ready Research Validate ' ]"

run "contract_states excludes Triage" \
  bash -c "! echo '$CONTRACT' | jq -e '.[] | select(.name == \"Triage\")'"

run "contract_states: Ready is unstarted" \
  bash -c "echo '$CONTRACT' | jq -e '.[] | select(.name==\"Ready\") | .type == \"unstarted\"'"

run "contract_states: Research is unstarted" \
  bash -c "echo '$CONTRACT' | jq -e '.[] | select(.name==\"Research\") | .type == \"unstarted\"'"

run "contract_states: Plan is started" \
  bash -c "echo '$CONTRACT' | jq -e '.[] | select(.name==\"Plan\") | .type == \"started\"'"

run "contract_states: Implement is started" \
  bash -c "echo '$CONTRACT' | jq -e '.[] | select(.name==\"Implement\") | .type == \"started\"'"

run "contract_states: Validate is started" \
  bash -c "echo '$CONTRACT' | jq -e '.[] | select(.name==\"Validate\") | .type == \"started\"'"

run "contract_states: PR is started" \
  bash -c "echo '$CONTRACT' | jq -e '.[] | select(.name==\"PR\") | .type == \"started\"'"

# missing_contract_states — diff against a fetched-states JSON fixture.
FETCHED_PARTIAL='[{"name":"Triage","type":"started"},{"name":"Research","type":"unstarted"},{"name":"Plan","type":"started"}]'
MISSING="$(missing_contract_states "$FETCHED_PARTIAL")"

run "missing_contract_states returns the absent contract states" \
  bash -c "[ \"\$(echo '$MISSING' | tr ' ' '\n' | grep -v '^\$' | sort | tr '\n' ' ')\" = 'Implement PR Ready Validate ' ]"

FETCHED_ALL='[{"name":"Triage","type":"started"},{"name":"Ready","type":"unstarted"},{"name":"Research","type":"unstarted"},{"name":"Plan","type":"started"},{"name":"Implement","type":"started"},{"name":"Validate","type":"started"},{"name":"PR","type":"started"}]'

run "missing_contract_states returns empty when all present (idempotent)" \
  bash -c "[ -z \"\$(missing_contract_states '$FETCHED_ALL' | tr -d '[:space:]')\" ]"

# build_workflow_state_create_mutation — GraphQL mutation string.
MUTATION="$(build_workflow_state_create_mutation 'team-uuid-123' 'Validate' 'started' '#abcdef')"

run "mutation contains workflowStateCreate" \
  bash -c "echo '$MUTATION' | grep -q 'workflowStateCreate'"

run "mutation contains the teamId" \
  bash -c "echo '$MUTATION' | grep -q 'team-uuid-123'"

run "mutation contains the state name" \
  bash -c "echo '$MUTATION' | grep -q 'Validate'"

run "mutation contains the type" \
  bash -c "echo '$MUTATION' | grep -q 'started'"

# desired_git_automations — exactly start→PR, merge→Done, no review (CTL-759).
DESIRED_GA="$(desired_git_automations)"

run "desired_git_automations is valid JSON" \
  bash -c "echo '$DESIRED_GA' | jq -e ."

run "desired_git_automations has exactly 2 entries" \
  bash -c "echo '$DESIRED_GA' | jq -e 'length == 2'"

run "desired_git_automations start -> PR" \
  bash -c "echo '$DESIRED_GA' | jq -e '.[] | select(.event==\"start\") | .state == \"PR\"'"

run "desired_git_automations merge -> Done" \
  bash -c "echo '$DESIRED_GA' | jq -e '.[] | select(.event==\"merge\") | .state == \"Done\"'"

run "desired_git_automations has no review automation" \
  bash -c "! echo '$DESIRED_GA' | jq -e '.[] | select(.event==\"review\")'"

# reconcile_git_automation_states — drive the team to the contract. The function
# is best-effort and tolerant; we assert it issues the right mutations and never
# emits a null stateId. Fetched states carry PR (s-pr) and Done (s-done).
FETCHED_GA='[{"id":"s-pr","name":"PR","type":"started"},{"id":"s-done","name":"Done","type":"completed"},{"id":"s-triage","name":"Triage","type":"started"}]'

# A fake curl that logs every request body, branches on git-automation ops, and
# returns a team whose automations are: start→Triage (WRONG), merge→Done (right),
# plus a review node (must be deleted).
make_ga_curl() {
  local bin_dir="$1" log="$2"
  mkdir -p "$bin_dir"
  cat > "${bin_dir}/curl" <<SCRIPT
#!/usr/bin/env bash
body="\$(cat 2>/dev/null)"
for a in "\$@"; do case "\$a" in {*) body="\$a";; esac; done
echo "\$body" >> "${log}"
case "\$body" in
  *gitAutomationStateCreate*) echo '{"data":{"gitAutomationStateCreate":{"success":true}}}' ;;
  *gitAutomationStateUpdate*) echo '{"data":{"gitAutomationStateUpdate":{"success":true}}}' ;;
  *gitAutomationStateDelete*) echo '{"data":{"gitAutomationStateDelete":{"success":true}}}' ;;
  *gitAutomationStates*) echo '{"data":{"team":{"gitAutomationStates":{"nodes":[{"id":"ga-start","event":"start","state":{"id":"s-triage","name":"Triage"}},{"id":"ga-merge","event":"merge","state":{"id":"s-done","name":"Done"}},{"id":"ga-review","event":"review","state":{"id":"s-val","name":"Validate"}}]}}}}' ;;
  *) echo '{"data":{}}' ;;
esac
exit 0
SCRIPT
  chmod +x "${bin_dir}/curl"
}

GA_BIN="${SCRATCH}/ga/bin"
GA_LOG="${SCRATCH}/ga/req.log"
mkdir -p "${SCRATCH}/ga"
: > "$GA_LOG"
make_ga_curl "$GA_BIN" "$GA_LOG"

PATH="$GA_BIN:$PATH" reconcile_git_automation_states "team-xyz" "fake-token" "$FETCHED_GA" \
  > "${SCRATCH}/ga-out" 2>&1

run "reconcile updates the wrong 'start' automation (Triage -> PR)" \
  bash -c "grep -q 'gitAutomationStateUpdate' '$GA_LOG' && grep -q 's-pr' '$GA_LOG'"

run "reconcile deletes the 'review' automation node" \
  bash -c "grep -q 'gitAutomationStateDelete' '$GA_LOG' && grep -q 'ga-review' '$GA_LOG'"

run "reconcile no-ops the already-correct 'merge' automation (no update for merge)" \
  bash -c "! grep -q 's-done' '$GA_LOG' || grep -q 'already correct' '${SCRATCH}/ga-out'"

run "reconcile never issues a create with a missing target state" \
  bash -c "echo '$FETCHED_GA' | jq -e 'map(.name) | index(\"PR\") and index(\"Done\")'"

# Missing target state => WARN, never a null stateId, exit stays 0.
FETCHED_NO_PR='[{"id":"s-done","name":"Done","type":"completed"},{"id":"s-triage","name":"Triage","type":"started"}]'
GA_BIN2="${SCRATCH}/ga2/bin"
GA_LOG2="${SCRATCH}/ga2/req.log"
mkdir -p "${SCRATCH}/ga2"
: > "$GA_LOG2"
make_ga_curl "$GA_BIN2" "$GA_LOG2"

PATH="$GA_BIN2:$PATH" reconcile_git_automation_states "team-xyz" "fake-token" "$FETCHED_NO_PR" \
  > "${SCRATCH}/ga2-out" 2>&1
GA2_RC=$?

run "missing target 'PR' => WARN about skipping start" \
  bash -c "grep -qi 'PR' '${SCRATCH}/ga2-out' && grep -qi 'skipping' '${SCRATCH}/ga2-out'"

run "missing target state => no null stateId issued in any request" \
  bash -c "! grep -qE 'stateId\":null|stateId\": *null' '$GA_LOG2'"

run "reconcile tolerant — returns 0 even with a missing target state" \
  bash -c "[ '$GA2_RC' = '0' ]"

# ─── Layer 2: E2E with a stubbed curl ────────────────────────────────────────

# Build a fixture repo with .catalyst/config.json + a git repo + secrets.
build_repo() {
  local dir="$1" team_key="${2:-CTL}"
  mkdir -p "${dir}/.catalyst"
  cat > "${dir}/.catalyst/config.json" <<EOF
{
  "catalyst": {
    "projectKey": "test-project",
    "linear": {
      "teamKey": "${team_key}",
      "stateMap": {
        "backlog": "Backlog",
        "inProgress": "In Progress",
        "inReview": "In Review",
        "done": "Done"
      }
    },
    "orchestration": {
      "dispatchMode": "execution-core",
      "executionCore": { "eligibleQuery": { "status": "Todo" } }
    }
  }
}
EOF
  git -C "$dir" init -q 2>/dev/null || true
}

build_secrets() {
  local home="$1"
  mkdir -p "${home}/.config/catalyst"
  cat > "${home}/.config/catalyst/config-test-project.json" <<'EOF'
{
  "catalyst": { "linear": { "apiToken": "lin_api_fake_token_12345" } }
}
EOF
}

FAKE_TEAM_ID="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

# install_fake_curl — a curl stub. The states query returns whichever set the
# caller specifies; the workflowStateCreate mutation either succeeds or errors.
# $1 = bin dir, $2 = "all"|"partial", $3 = "ok"|"create-fails"
install_fake_curl() {
  local bin_dir="$1" states="$2" create="${3:-ok}"
  mkdir -p "$bin_dir"

  local states_nodes
  if [ "$states" = "all" ]; then
    states_nodes='{"id":"s-triage","name":"Triage","type":"started"},{"id":"s-ready","name":"Ready","type":"unstarted"},{"id":"s-research","name":"Research","type":"unstarted"},{"id":"s-plan","name":"Plan","type":"started"},{"id":"s-impl","name":"Implement","type":"started"},{"id":"s-val","name":"Validate","type":"started"},{"id":"s-pr","name":"PR","type":"started"},{"id":"s-backlog","name":"Backlog","type":"backlog"},{"id":"s-done","name":"Done","type":"completed"},{"id":"s-cancel","name":"Canceled","type":"canceled"}'
  else
    states_nodes='{"id":"s-triage","name":"Triage","type":"started"},{"id":"s-research","name":"Research","type":"unstarted"},{"id":"s-plan","name":"Plan","type":"started"},{"id":"s-backlog","name":"Backlog","type":"backlog"},{"id":"s-done","name":"Done","type":"completed"}'
  fi

  local create_resp
  if [ "$create" = "create-fails" ]; then
    create_resp='{"errors":[{"message":"insufficient permissions"}]}'
  else
    create_resp='{"data":{"workflowStateCreate":{"success":true,"workflowState":{"id":"new-state-id"}}}}'
  fi

  cat > "${bin_dir}/curl" <<SCRIPT
#!/usr/bin/env bash
# Read the request body to distinguish a states query from a create mutation.
body=""
for arg in "\$@"; do
  case "\$arg" in
    *workflowStateCreate*) body="create" ;;
    *states*) [ -z "\$body" ] && body="query" ;;
  esac
done
# -d @- form: body comes from stdin
if [ -z "\$body" ]; then
  stdin_body="\$(cat)"
  case "\$stdin_body" in
    *workflowStateCreate*) body="create" ;;
    *) body="query" ;;
  esac
fi
if [ "\$body" = "create" ]; then
  echo '${create_resp}'
else
  echo '{"data":{"teams":{"nodes":[{"id":"${FAKE_TEAM_ID}","states":{"nodes":[${states_nodes}]}}]}}}'
fi
exit 0
SCRIPT
  chmod +x "${bin_dir}/curl"
}

# ─── Test: --dry-run --json reports actions, writes nothing ───────────────────
WORK_DR="${SCRATCH}/dryrun"
BIN_DR="${SCRATCH}/dryrun/bin"
HOME_DR="${SCRATCH}/dryrun/home"
build_repo "$WORK_DR"
build_secrets "$HOME_DR"
install_fake_curl "$BIN_DR" "all" "ok"
BEFORE_DR="$(cat "${WORK_DR}/.catalyst/config.json")"

HOME="$HOME_DR" PATH="$BIN_DR:$PATH" CATALYST_DIR="${SCRATCH}/dryrun/catalyst" \
  "$SCRIPT" --config "${WORK_DR}/.catalyst/config.json" --dry-run --json \
  > "${SCRATCH}/dryrun-out" 2>&1 || true

run "--dry-run --json emits JSON" \
  bash -c "jq -e . '${SCRATCH}/dryrun-out'"

AFTER_DR="$(cat "${WORK_DR}/.catalyst/config.json")"
run "--dry-run writes nothing to config" \
  bash -c "[ \"\$BEFORE_DR\" = \"\$AFTER_DR\" ]"

run "--dry-run creates no registry file" \
  bash -c "[ ! -f '${SCRATCH}/dryrun/catalyst/execution-core/registry.json' ]"

# ─── Test: states all present -> writes stateMap, no workflowStateCreate ──────
WORK_OK="${SCRATCH}/ok"
BIN_OK="${SCRATCH}/ok/bin"
HOME_OK="${SCRATCH}/ok/home"
build_repo "$WORK_OK"
build_secrets "$HOME_OK"
install_fake_curl "$BIN_OK" "all" "ok"

run "exit 0 when all contract states present" \
  bash -c "HOME='$HOME_OK' PATH='$BIN_OK:$PATH' CATALYST_DIR='${SCRATCH}/ok/catalyst' \
    '$SCRIPT' --config '${WORK_OK}/.catalyst/config.json'"

run "writes execution-core stateMap (verifying -> Validate)" \
  bash -c "jq -e '.catalyst.linear.stateMap.verifying == \"Validate\"' '${WORK_OK}/.catalyst/config.json'"

run "writes execution-core stateMap (inReview -> PR)" \
  bash -c "jq -e '.catalyst.linear.stateMap.inReview == \"PR\"' '${WORK_OK}/.catalyst/config.json'"

run "upserts a registry entry for the team" \
  bash -c "jq -e '.projects[] | select(.team == \"CTL\")' '${SCRATCH}/ok/catalyst/execution-core/registry.json'"

# ─── Test: idempotent — re-run produces identical config ─────────────────────
CONFIG_AFTER1="$(cat "${WORK_OK}/.catalyst/config.json")"
HOME="$HOME_OK" PATH="$BIN_OK:$PATH" CATALYST_DIR="${SCRATCH}/ok/catalyst" \
  "$SCRIPT" --config "${WORK_OK}/.catalyst/config.json" > /dev/null 2>&1 || true
CONFIG_AFTER2="$(cat "${WORK_OK}/.catalyst/config.json")"
run "re-run is idempotent (config unchanged)" \
  bash -c "[ \"\$CONFIG_AFTER1\" = \"\$CONFIG_AFTER2\" ]"

# ─── Test: workflowStateCreate fails -> states_incomplete + fallback printed ──
WORK_FAIL="${SCRATCH}/fail"
BIN_FAIL="${SCRATCH}/fail/bin"
HOME_FAIL="${SCRATCH}/fail/home"
build_repo "$WORK_FAIL"
build_secrets "$HOME_FAIL"
install_fake_curl "$BIN_FAIL" "partial" "create-fails"

HOME="$HOME_FAIL" PATH="$BIN_FAIL:$PATH" CATALYST_DIR="${SCRATCH}/fail/catalyst" \
  "$SCRIPT" --config "${WORK_FAIL}/.catalyst/config.json" \
  > "${SCRATCH}/fail-out" 2>&1
FAIL_RC=$?

run "create-failure prints admin fallback instructions" \
  bash -c "grep -qi 'linear' '${SCRATCH}/fail-out' && grep -qiE 'admin|app|manually' '${SCRATCH}/fail-out'"

run "create-failure flags states_incomplete (exit 3)" \
  bash -c "[ '$FAIL_RC' = '3' ]"

# ─── Test: missing node_modules/pino in execution-core dir (CTL-578) ─────────
# Repro: when `plugins/dev/scripts/execution-core/node_modules` is absent,
# `registry.mjs` fails to load because `config.mjs` cannot resolve `pino`.
# After Phases 2-3 land, setup auto-installs (or the shim absorbs the miss)
# and the upsert succeeds.
WORK_PINO="${SCRATCH}/pino"
BIN_PINO="${SCRATCH}/pino/bin"
HOME_PINO="${SCRATCH}/pino/home"
build_repo "$WORK_PINO"
build_secrets "$HOME_PINO"
install_fake_curl "$BIN_PINO" "all" "ok"

STAGED_SCRIPT_DIR="${SCRATCH}/pino/scripts"
mkdir -p "${STAGED_SCRIPT_DIR}/execution-core"
cp "$SCRIPT" "${STAGED_SCRIPT_DIR}/setup-execution-core-states.sh"
cp "${REPO_ROOT}/plugins/dev/scripts/resolve-linear-ids.sh" \
   "${STAGED_SCRIPT_DIR}/resolve-linear-ids.sh" 2>/dev/null || true
cp "${REPO_ROOT}/plugins/dev/scripts/execution-core/registry.mjs" \
   "${STAGED_SCRIPT_DIR}/execution-core/registry.mjs"
cp "${REPO_ROOT}/plugins/dev/scripts/execution-core/config.mjs" \
   "${STAGED_SCRIPT_DIR}/execution-core/config.mjs"
cp "${REPO_ROOT}/plugins/dev/scripts/execution-core/package.json" \
   "${STAGED_SCRIPT_DIR}/execution-core/package.json"
cp "${REPO_ROOT}/plugins/dev/scripts/execution-core/bun.lock" \
   "${STAGED_SCRIPT_DIR}/execution-core/bun.lock" 2>/dev/null || true
# Intentionally NO bun install — node_modules/ absent.

HOME="$HOME_PINO" PATH="$BIN_PINO:$PATH" \
  CATALYST_DIR="${SCRATCH}/pino/catalyst" \
  "${STAGED_SCRIPT_DIR}/setup-execution-core-states.sh" \
    --config "${WORK_PINO}/.catalyst/config.json" \
    > "${SCRATCH}/pino-out" 2>&1
PINO_RC=$?

run "missing-pino: registry.json contains team after setup" \
  bash -c "jq -e '.projects[] | select(.team == \"CTL\")' \
    '${SCRATCH}/pino/catalyst/execution-core/registry.json'"

run "missing-pino: setup exits 0 only when the team is actually registered" \
  bash -c "[ '$PINO_RC' = '0' ]"

# ─── Test: missing-pino with bun unavailable -> fail loudly (CTL-578) ────────
WORK_LOUD="${SCRATCH}/loud"
BIN_LOUD="${SCRATCH}/loud/bin"
HOME_LOUD="${SCRATCH}/loud/home"
build_repo "$WORK_LOUD"
build_secrets "$HOME_LOUD"
install_fake_curl "$BIN_LOUD" "all" "ok"

STAGED_LOUD_DIR="${SCRATCH}/loud/scripts"
mkdir -p "${STAGED_LOUD_DIR}/execution-core"
cp "$SCRIPT" "${STAGED_LOUD_DIR}/setup-execution-core-states.sh"
cp "${REPO_ROOT}/plugins/dev/scripts/resolve-linear-ids.sh" \
   "${STAGED_LOUD_DIR}/resolve-linear-ids.sh" 2>/dev/null || true
cp "${REPO_ROOT}/plugins/dev/scripts/execution-core/registry.mjs" \
   "${STAGED_LOUD_DIR}/execution-core/registry.mjs"
cp "${REPO_ROOT}/plugins/dev/scripts/execution-core/config.mjs" \
   "${STAGED_LOUD_DIR}/execution-core/config.mjs"

# Find host jq + git binaries so we can hand-build a minimal PATH that
# lacks bun (so ensure_execution_core_deps must fail-loudly).
HOST_JQ=$(command -v jq); HOST_GIT=$(command -v git)
ln -sf "$HOST_JQ"  "${BIN_LOUD}/jq"  2>/dev/null || cp "$HOST_JQ"  "${BIN_LOUD}/jq"
ln -sf "$HOST_GIT" "${BIN_LOUD}/git" 2>/dev/null || cp "$HOST_GIT" "${BIN_LOUD}/git"

HOME="$HOME_LOUD" PATH="$BIN_LOUD:/usr/bin:/bin" \
  CATALYST_DIR="${SCRATCH}/loud/catalyst" \
  "${STAGED_LOUD_DIR}/setup-execution-core-states.sh" \
    --config "${WORK_LOUD}/.catalyst/config.json" \
    > "${SCRATCH}/loud-out" 2>&1
LOUD_RC=$?

run "no-bun + no-deps: runner stderr surfaced (mentions pino/registry/module)" \
  bash -c "grep -qiE 'pino|registry|cannot find package|module not found|node_modules' '${SCRATCH}/loud-out'"

run "no-bun + no-deps: exits non-zero (registry upsert is a hard failure)" \
  bash -c "[ '$LOUD_RC' != '0' ]"

# ─── Test: post-upsert verification — corrupt registry detection (CTL-578) ───
# After upsert returns 0, the script jq-reads registry.json to confirm the team
# landed. If the runner is a noop that exits 0 without writing the file, the
# script must fail rather than silently trust the runner's exit code.
WORK_VERIFY="${SCRATCH}/verify"
HOME_VERIFY="${SCRATCH}/verify/home"
BIN_VERIFY="${SCRATCH}/verify/bin"
build_repo "$WORK_VERIFY"
build_secrets "$HOME_VERIFY"
install_fake_curl "$BIN_VERIFY" "all" "ok"

STAGED_VERIFY_DIR="${SCRATCH}/verify/scripts"
mkdir -p "${STAGED_VERIFY_DIR}/execution-core/node_modules"
# Stub node_modules so ensure_execution_core_deps short-circuits.
cp "$SCRIPT" "${STAGED_VERIFY_DIR}/setup-execution-core-states.sh"
cp "${REPO_ROOT}/plugins/dev/scripts/resolve-linear-ids.sh" \
   "${STAGED_VERIFY_DIR}/resolve-linear-ids.sh" 2>/dev/null || true
cat > "${STAGED_VERIFY_DIR}/execution-core/registry.mjs" <<'NOOP'
#!/usr/bin/env node
// Noop fake — exit 0, write nothing. Simulates a runner that "succeeded"
// without actually mutating registry.json.
process.exit(0);
NOOP
chmod +x "${STAGED_VERIFY_DIR}/execution-core/registry.mjs"
mkdir -p "${SCRATCH}/verify/catalyst/execution-core"
echo '{"projects":[]}' > "${SCRATCH}/verify/catalyst/execution-core/registry.json"

HOME="$HOME_VERIFY" PATH="$BIN_VERIFY:$PATH" \
  CATALYST_DIR="${SCRATCH}/verify/catalyst" \
  "${STAGED_VERIFY_DIR}/setup-execution-core-states.sh" \
    --config "${WORK_VERIFY}/.catalyst/config.json" \
    > "${SCRATCH}/verify-out" 2>&1
VERIFY_RC=$?

run "post-upsert verification fails when team not in registry.json (exit 4)" \
  bash -c "[ '$VERIFY_RC' = '4' ]"

run "post-upsert verification surfaces the missing-team in stderr" \
  bash -c "grep -qiE 'not present|missing|not registered|verify' '${SCRATCH}/verify-out'"

echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[ "$FAILURES" = "0" ]
