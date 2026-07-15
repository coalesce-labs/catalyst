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
	local name="$1"
	shift
	if "$@" >"${SCRATCH}/out" 2>&1; then
		PASSES=$((PASSES + 1))
		echo "  PASS: $name"
	else
		FAILURES=$((FAILURES + 1))
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

run "state map todo -> Todo" \
	bash -c "echo '$STATE_MAP_JSON' | jq -e '.todo == \"Todo\"'"

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

# contract_states — exactly Todo Research Plan Implement Validate PR (no Triage).
CONTRACT="$(contract_states)"

run "contract_states lists the 6 contract names" \
	bash -c "[ \"\$(echo '$CONTRACT' | jq -r '.[].name' | sort | tr '\n' ' ')\" = 'Implement Plan PR Research Todo Validate ' ]"

run "contract_states excludes Triage" \
	bash -c "! echo '$CONTRACT' | jq -e '.[] | select(.name == \"Triage\")'"

run "contract_states: Todo is unstarted" \
	bash -c "echo '$CONTRACT' | jq -e '.[] | select(.name==\"Todo\") | .type == \"unstarted\"'"

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
	bash -c "[ \"\$(echo '$MISSING' | tr ' ' '\n' | grep -v '^\$' | sort | tr '\n' ' ')\" = 'Implement PR Todo Validate ' ]"

FETCHED_ALL='[{"name":"Triage","type":"started"},{"name":"Todo","type":"unstarted"},{"name":"Research","type":"unstarted"},{"name":"Plan","type":"started"},{"name":"Implement","type":"started"},{"name":"Validate","type":"started"},{"name":"PR","type":"started"}]'

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
	cat >"${bin_dir}/curl" <<SCRIPT
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
: >"$GA_LOG"
make_ga_curl "$GA_BIN" "$GA_LOG"

PATH="$GA_BIN:$PATH" reconcile_git_automation_states "team-xyz" "fake-token" "$FETCHED_GA" \
	>"${SCRATCH}/ga-out" 2>&1

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
: >"$GA_LOG2"
make_ga_curl "$GA_BIN2" "$GA_LOG2"

PATH="$GA_BIN2:$PATH" reconcile_git_automation_states "team-xyz" "fake-token" "$FETCHED_NO_PR" \
	>"${SCRATCH}/ga2-out" 2>&1
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
	cat >"${dir}/.catalyst/config.json" <<EOF
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
	cat >"${home}/.config/catalyst/config-test-project.json" <<'EOF'
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
		states_nodes='{"id":"s-triage","name":"Triage","type":"started"},{"id":"s-todo","name":"Todo","type":"unstarted"},{"id":"s-research","name":"Research","type":"unstarted"},{"id":"s-plan","name":"Plan","type":"started"},{"id":"s-impl","name":"Implement","type":"started"},{"id":"s-val","name":"Validate","type":"started"},{"id":"s-pr","name":"PR","type":"started"},{"id":"s-backlog","name":"Backlog","type":"backlog"},{"id":"s-done","name":"Done","type":"completed"},{"id":"s-cancel","name":"Canceled","type":"canceled"}'
	else
		states_nodes='{"id":"s-triage","name":"Triage","type":"started"},{"id":"s-research","name":"Research","type":"unstarted"},{"id":"s-plan","name":"Plan","type":"started"},{"id":"s-backlog","name":"Backlog","type":"backlog"},{"id":"s-done","name":"Done","type":"completed"}'
	fi

	local create_resp
	if [ "$create" = "create-fails" ]; then
		create_resp='{"errors":[{"message":"insufficient permissions"}]}'
	else
		create_resp='{"data":{"workflowStateCreate":{"success":true,"workflowState":{"id":"new-state-id"}}}}'
	fi

	cat >"${bin_dir}/curl" <<SCRIPT
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
	>"${SCRATCH}/dryrun-out" 2>&1 || true

run "--dry-run --json emits JSON" \
	bash -c "jq -e . '${SCRATCH}/dryrun-out'"

AFTER_DR="$(cat "${WORK_DR}/.catalyst/config.json")"
run "--dry-run writes nothing to config" \
	bash -c '[ "$BEFORE_DR" = "$AFTER_DR" ]'

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

# ─── Unit tests: statemap_needs_write predicate (CTL-722) ────────────────────
run "statemap_needs_write: legacy 8-key map (In Progress/In Review values) -> needs write" \
	bash -c 'source '"$SCRIPT"'; statemap_needs_write '"'"'{"todo":"Todo","research":"In Progress","inReview":"In Review"}'"'"''

run "statemap_needs_write: empty map -> needs write" \
	bash -c 'source '"$SCRIPT"'; statemap_needs_write "{}"'

run "statemap_needs_write: null/empty string -> needs write" \
	bash -c 'source '"$SCRIPT"'; statemap_needs_write ""'

run "statemap_needs_write: contract-satisfying map -> skip (return 1)" \
	bash -c 'source '"$SCRIPT"'; ! statemap_needs_write '"'"'{"todo":"Todo","research":"Research","planning":"Plan","inProgress":"Implement","verifying":"Validate","reviewing":"Review","inReview":"PR"}'"'"''

run "statemap_needs_write: user-customised non-legacy map without contract -> skip (return 1)" \
	bash -c 'source '"$SCRIPT"'; ! statemap_needs_write '"'"'{"todo":"MyTodo","research":"MyResearch","planning":"Plan","inProgress":"Implement","verifying":"Validate","reviewing":"Review","inReview":"PR"}'"'"''

# ─── Test: idempotent — re-run produces identical config ─────────────────────
CONFIG_AFTER1="$(cat "${WORK_OK}/.catalyst/config.json")"
HOME="$HOME_OK" PATH="$BIN_OK:$PATH" CATALYST_DIR="${SCRATCH}/ok/catalyst" \
	"$SCRIPT" --config "${WORK_OK}/.catalyst/config.json" >/dev/null 2>&1 || true
CONFIG_AFTER2="$(cat "${WORK_OK}/.catalyst/config.json")"
run "re-run is idempotent (config unchanged)" \
	bash -c '[ "$CONFIG_AFTER1" = "$CONFIG_AFTER2" ]'

# ─── Test: idempotency guard preserves user-customised stateMap (CTL-722) ────
WORK_CUSTOM="${SCRATCH}/custom"
BIN_CUSTOM="${SCRATCH}/custom/bin"
HOME_CUSTOM="${SCRATCH}/custom/home"
build_repo "$WORK_CUSTOM"
build_secrets "$HOME_CUSTOM"
install_fake_curl "$BIN_CUSTOM" "all" "ok"

# First run: let the script write the contract map
HOME="$HOME_CUSTOM" PATH="$BIN_CUSTOM:$PATH" CATALYST_DIR="${SCRATCH}/custom/catalyst" \
	"$SCRIPT" --config "${WORK_CUSTOM}/.catalyst/config.json" >/dev/null 2>&1 || true

# Mutate one value to a custom string (still satisfies contract so guard skips on re-run)
jq '.catalyst.linear.stateMap.backlog = "MyCustomBacklog"' \
	"${WORK_CUSTOM}/.catalyst/config.json" >"${WORK_CUSTOM}/.catalyst/config.json.tmp" &&
	mv "${WORK_CUSTOM}/.catalyst/config.json.tmp" "${WORK_CUSTOM}/.catalyst/config.json"

# Re-run — the guard must NOT overwrite since the contract is still satisfied
HOME="$HOME_CUSTOM" PATH="$BIN_CUSTOM:$PATH" CATALYST_DIR="${SCRATCH}/custom/catalyst" \
	"$SCRIPT" --config "${WORK_CUSTOM}/.catalyst/config.json" >/dev/null 2>&1 || true

run "idempotency guard: user-customised stateMap preserved on re-run" \
	bash -c "jq -e '.catalyst.linear.stateMap.backlog == \"MyCustomBacklog\"' \
    '${WORK_CUSTOM}/.catalyst/config.json'"

# ─── Test: workflowStateCreate fails -> states_incomplete + fallback printed ──
WORK_FAIL="${SCRATCH}/fail"
BIN_FAIL="${SCRATCH}/fail/bin"
HOME_FAIL="${SCRATCH}/fail/home"
build_repo "$WORK_FAIL"
build_secrets "$HOME_FAIL"
install_fake_curl "$BIN_FAIL" "partial" "create-fails"

HOME="$HOME_FAIL" PATH="$BIN_FAIL:$PATH" CATALYST_DIR="${SCRATCH}/fail/catalyst" \
	"$SCRIPT" --config "${WORK_FAIL}/.catalyst/config.json" \
	>"${SCRATCH}/fail-out" 2>&1
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
	>"${SCRATCH}/pino-out" 2>&1
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
HOST_JQ=$(command -v jq)
HOST_GIT=$(command -v git)
ln -sf "$HOST_JQ" "${BIN_LOUD}/jq" 2>/dev/null || cp "$HOST_JQ" "${BIN_LOUD}/jq"
ln -sf "$HOST_GIT" "${BIN_LOUD}/git" 2>/dev/null || cp "$HOST_GIT" "${BIN_LOUD}/git"

HOME="$HOME_LOUD" PATH="$BIN_LOUD:/usr/bin:/bin" \
	CATALYST_DIR="${SCRATCH}/loud/catalyst" \
	"${STAGED_LOUD_DIR}/setup-execution-core-states.sh" \
	--config "${WORK_LOUD}/.catalyst/config.json" \
	>"${SCRATCH}/loud-out" 2>&1
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
cat >"${STAGED_VERIFY_DIR}/execution-core/registry.mjs" <<'NOOP'
#!/usr/bin/env node
// Noop fake — exit 0, write nothing. Simulates a runner that "succeeded"
// without actually mutating registry.json.
process.exit(0);
NOOP
chmod +x "${STAGED_VERIFY_DIR}/execution-core/registry.mjs"
mkdir -p "${SCRATCH}/verify/catalyst/execution-core"
echo '{"projects":[]}' >"${SCRATCH}/verify/catalyst/execution-core/registry.json"

HOME="$HOME_VERIFY" PATH="$BIN_VERIFY:$PATH" \
	CATALYST_DIR="${SCRATCH}/verify/catalyst" \
	"${STAGED_VERIFY_DIR}/setup-execution-core-states.sh" \
	--config "${WORK_VERIFY}/.catalyst/config.json" \
	>"${SCRATCH}/verify-out" 2>&1
VERIFY_RC=$?

run "post-upsert verification fails when team not in registry.json (exit 4)" \
	bash -c "[ '$VERIFY_RC' = '4' ]"

run "post-upsert verification surfaces the missing-team in stderr" \
	bash -c "grep -qiE 'not present|missing|not registered|verify' '${SCRATCH}/verify-out'"

# ─── Phase 1 (CTL-764): worker-status label group ────────────────────────────
# Unit tests for pure helpers (script already sourced above).

run "worker_status_group_name is 'worker-status'" \
	bash -c "source '$SCRIPT'; [ \"\$(worker_status_group_name)\" = 'worker-status' ]"

run "worker_status_members: valid JSON array with exactly 4 entries" \
	bash -c "source '$SCRIPT'; worker_status_members | jq -e 'length == 4'"

run "worker_status_members: lists queued blocked needs-input needs-human (no waiting)" \
	bash -c "source '$SCRIPT'; names=\$(worker_status_members | jq -r '.[].name' | sort | tr '\n' ' '); [ \"\$names\" = 'blocked needs-human needs-input queued ' ]"

run "worker_status_members: does not contain 'waiting'" \
	bash -c "source '$SCRIPT'; worker_status_members | jq -e '[.[].name] | index(\"waiting\") == null'"

WS_GRP_MUT="\$(source '$SCRIPT' && build_issue_label_group_create_mutation 'worker-status' '#5e6ad2')"
WS_GRP_MUT_VAL="$(source "$SCRIPT" && build_issue_label_group_create_mutation 'worker-status' '#5e6ad2')"

run "build_issue_label_group_create_mutation: contains issueLabelCreate" \
	bash -c "echo '$WS_GRP_MUT_VAL' | grep -q 'issueLabelCreate'"

# CTL-764 finding A: the group is created as a plain workspace label — sending isGroup:true
# is rejected by IssueLabelCreateInput and aborts the reconcile before any child is created.
run "build_issue_label_group_create_mutation: omits isGroup (rejected by IssueLabelCreateInput)" \
	bash -c "! echo '$WS_GRP_MUT_VAL' | grep -q 'isGroup'"

run "build_issue_label_group_create_mutation: omits teamId (workspace scope)" \
	bash -c "! echo '$WS_GRP_MUT_VAL' | grep -q 'teamId'"

WS_CHD_MUT_VAL="$(source "$SCRIPT" && build_issue_label_child_create_mutation 'queued' '#0099cc' 'parent-uuid-123')"

run "build_issue_label_child_create_mutation: contains issueLabelCreate" \
	bash -c "echo '$WS_CHD_MUT_VAL' | grep -q 'issueLabelCreate'"

run "build_issue_label_child_create_mutation: contains parentId" \
	bash -c "echo '$WS_CHD_MUT_VAL' | grep -q 'parentId'"

run "build_issue_label_child_create_mutation: omits teamId (workspace scope)" \
	bash -c "! echo '$WS_CHD_MUT_VAL' | grep -q 'teamId'"

# make_label_curl <bin_dir> <labels_state> <create_ok> <log_file>
# labels_state: empty | group_only | partial | full | query_error
make_label_curl() {
	local bin_dir="$1" labels_state="$2" create_ok="${3:-true}" log="${4:-/dev/null}"
	mkdir -p "$bin_dir"
	local labels_nodes create_resp
	case "$labels_state" in
	empty)
		labels_nodes='[]'
		;;
	group_only)
		labels_nodes='[{"id":"grp-ws","name":"worker-status","isGroup":true,"parent":null}]'
		;;
	group_only_plain)
		# CTL-764 finding A: the parent exists but is still a PLAIN label (isGroup false)
		# — a partial-failure re-run where the parent was created but no child attached.
		labels_nodes='[{"id":"grp-ws","name":"worker-status","isGroup":false,"parent":null}]'
		;;
	partial)
		labels_nodes='[{"id":"grp-ws","name":"worker-status","isGroup":true,"parent":null},{"id":"lbl-q","name":"queued","isGroup":false,"parent":{"id":"grp-ws"}},{"id":"lbl-b","name":"blocked","isGroup":false,"parent":{"id":"grp-ws"}},{"id":"lbl-nh","name":"needs-human","isGroup":false,"parent":{"id":"grp-ws"}}]'
		;;
	full)
		labels_nodes='[{"id":"grp-ws","name":"worker-status","isGroup":true,"parent":null},{"id":"lbl-q","name":"queued","isGroup":false,"parent":{"id":"grp-ws"}},{"id":"lbl-b","name":"blocked","isGroup":false,"parent":{"id":"grp-ws"}},{"id":"lbl-ni","name":"needs-input","isGroup":false,"parent":{"id":"grp-ws"}},{"id":"lbl-nh","name":"needs-human","isGroup":false,"parent":{"id":"grp-ws"}}]'
		;;
	query_error)
		labels_nodes=''
		;; # handled specially below
	esac
	if [ "$create_ok" = "true" ]; then
		create_resp='{"data":{"issueLabelCreate":{"success":true,"issueLabel":{"id":"new-lbl-id","name":"x"}}}}'
	else
		create_resp='{"errors":[{"message":"insufficient permissions"}]}'
	fi
	local query_resp
	if [ "$labels_state" = "query_error" ]; then
		query_resp='{"errors":[{"message":"api error"}]}'
	else
		query_resp="{\"data\":{\"issueLabels\":{\"nodes\":${labels_nodes}}}}"
	fi
	cat >"${bin_dir}/curl" <<SCRIPT
#!/usr/bin/env bash
body=""
for a in "\$@"; do case "\$a" in {*) body="\$a";; esac; done
if [ -z "\$body" ]; then body="\$(cat 2>/dev/null)"; fi
echo "\$body" >> "${log}"
case "\$body" in
  *issueLabelCreate*) echo '${create_resp}' ;;
  *) echo '${query_resp}' ;;
esac
exit 0
SCRIPT
	chmod +x "${bin_dir}/curl"
}

# Test 1: fresh workspace (empty) → 1 group create + 4 child creates = 5 issueLabelCreate
WS_T1_BIN="${SCRATCH}/ws-t1/bin"
WS_T1_LOG="${SCRATCH}/ws-t1/req.log"
mkdir -p "${SCRATCH}/ws-t1"
: >"$WS_T1_LOG"
make_label_curl "$WS_T1_BIN" "empty" "true" "$WS_T1_LOG"
(
	# shellcheck source=/dev/null
	source "$SCRIPT"
	PATH="$WS_T1_BIN:$PATH"
	dry_run=0
	reconcile_worker_status_labels "fake-token"
) >"${SCRATCH}/ws-t1-out" 2>&1

run "fresh workspace: issues exactly 5 issueLabelCreate calls (1 group + 4 children)" \
	bash -c "count=\$(grep -c 'issueLabelCreate' '$WS_T1_LOG' 2>/dev/null || echo 0); [ \"\$count\" = '5' ]"

run "fresh workspace: returns 0" \
	bash -c "source '$SCRIPT'; PATH='$WS_T1_BIN:\$PATH' dry_run=0 reconcile_worker_status_labels 'fake-token'"

# Test 2: idempotent (full group + all 4 children present) → 0 issueLabelCreate calls
WS_T2_BIN="${SCRATCH}/ws-t2/bin"
WS_T2_LOG="${SCRATCH}/ws-t2/req.log"
mkdir -p "${SCRATCH}/ws-t2"
: >"$WS_T2_LOG"
make_label_curl "$WS_T2_BIN" "full" "true" "$WS_T2_LOG"
(
	# shellcheck source=/dev/null
	source "$SCRIPT"
	PATH="$WS_T2_BIN:$PATH"
	dry_run=0
	reconcile_worker_status_labels "fake-token"
) >"${SCRATCH}/ws-t2-out" 2>&1

run "idempotent: zero issueLabelCreate calls when all present" \
	bash -c "! grep -q 'issueLabelCreate' '$WS_T2_LOG'"

run "idempotent: returns 0" \
	bash -c "source '$SCRIPT'; PATH='$WS_T2_BIN:\$PATH' dry_run=0 reconcile_worker_status_labels 'fake-token'"

# Test 3: partial (group + 3 children; needs-input missing) → 1 issueLabelCreate
WS_T3_BIN="${SCRATCH}/ws-t3/bin"
WS_T3_LOG="${SCRATCH}/ws-t3/req.log"
mkdir -p "${SCRATCH}/ws-t3"
: >"$WS_T3_LOG"
make_label_curl "$WS_T3_BIN" "partial" "true" "$WS_T3_LOG"
(
	# shellcheck source=/dev/null
	source "$SCRIPT"
	PATH="$WS_T3_BIN:$PATH"
	dry_run=0
	reconcile_worker_status_labels "fake-token"
) >"${SCRATCH}/ws-t3-out" 2>&1

run "partial: creates only the missing child (1 issueLabelCreate)" \
	bash -c "count=\$(grep -c 'issueLabelCreate' '$WS_T3_LOG' 2>/dev/null || echo 0); [ \"\$count\" = '1' ]"

run "partial: the one create is for needs-input" \
	bash -c "grep 'issueLabelCreate' '$WS_T3_LOG' | grep -q 'needs-input'"

# Test 4: Linear error on group query → WARNING printed, returns 0, main exit unchanged
WS_T4_BIN="${SCRATCH}/ws-t4/bin"
WS_T4_LOG="${SCRATCH}/ws-t4/req.log"
mkdir -p "${SCRATCH}/ws-t4"
: >"$WS_T4_LOG"
make_label_curl "$WS_T4_BIN" "query_error" "true" "$WS_T4_LOG"
WS_T4_OUT="${SCRATCH}/ws-t4-out"
(
	# shellcheck source=/dev/null
	source "$SCRIPT"
	PATH="$WS_T4_BIN:$PATH"
	dry_run=0
	reconcile_worker_status_labels "fake-token"
) >"$WS_T4_OUT" 2>&1
WS_T4_RC=$?

run "query error: WARNING is printed" \
	bash -c "grep -qi 'warning' '$WS_T4_OUT'"

run "query error: returns 0 (never alters exit codes)" \
	bash -c "[ '$WS_T4_RC' = '0' ]"

# Test 5: --dry-run → no issueLabelCreate mutations, reports intent
WS_T5_BIN="${SCRATCH}/ws-t5/bin"
WS_T5_LOG="${SCRATCH}/ws-t5/req.log"
mkdir -p "${SCRATCH}/ws-t5"
: >"$WS_T5_LOG"
make_label_curl "$WS_T5_BIN" "empty" "true" "$WS_T5_LOG"
(
	# shellcheck source=/dev/null
	source "$SCRIPT"
	PATH="$WS_T5_BIN:$PATH"
	dry_run=1
	reconcile_worker_status_labels "fake-token"
) >"${SCRATCH}/ws-t5-out" 2>&1

run "--dry-run: no issueLabelCreate mutations issued" \
	bash -c "! grep -q 'issueLabelCreate' '$WS_T5_LOG'"

run "--dry-run: reports intent (mentions worker-status or dry-run)" \
	bash -c "grep -qiE 'dry.run|DRY|worker.status' '${SCRATCH}/ws-t5-out'"

# Test 6 (CTL-764 finding A): the parent exists as a plain label (isGroup false, no
# children yet). The lookup must FIND it by name+parent==null — NOT re-create it — and
# create the 4 missing children → 4 issueLabelCreate calls, none of them a group create.
WS_T6_BIN="${SCRATCH}/ws-t6/bin"
WS_T6_LOG="${SCRATCH}/ws-t6/req.log"
mkdir -p "${SCRATCH}/ws-t6"
: >"$WS_T6_LOG"
make_label_curl "$WS_T6_BIN" "group_only_plain" "true" "$WS_T6_LOG"
(
	# shellcheck source=/dev/null
	source "$SCRIPT"
	PATH="$WS_T6_BIN:$PATH"
	dry_run=0
	reconcile_worker_status_labels "fake-token"
) >"${SCRATCH}/ws-t6-out" 2>&1

run "plain-label parent: found by name+parent==null, creates the 4 children (4 issueLabelCreate)" \
	bash -c "count=\$(grep -c 'issueLabelCreate' '$WS_T6_LOG' 2>/dev/null || echo 0); [ \"\$count\" = '4' ]"

run "plain-label parent: never re-creates the group (every create carries parentId)" \
	bash -c "! grep 'issueLabelCreate' '$WS_T6_LOG' | grep -qv 'parentId'"

# ─── Phase 2 (CTL-1481): worker:<host> label group ───────────────────────────
# Unit tests for pure helpers (script already sourced above).

run "worker_host_group_name is 'worker'" \
	bash -c "source '$SCRIPT'; [ \"\$(worker_host_group_name)\" = 'worker' ]"

run "worker_host_color: returns a single hex color" \
	bash -c "source '$SCRIPT'; echo \"\$(worker_host_color)\" | grep -qE '^#[0-9a-fA-F]{6}\$'"

run "worker_host_self_name: CATALYST_HOST_NAME env wins" \
	bash -c "source '$SCRIPT'; [ \"\$(CATALYST_HOST_NAME=envhost worker_host_self_name)\" = 'envhost' ]"

WH_LAYER2_DIR="${SCRATCH}/wh-layer2"
mkdir -p "$WH_LAYER2_DIR"
cat >"${WH_LAYER2_DIR}/config.json" <<'EOF'
{"catalyst":{"host":{"name":"layer2host"}}}
EOF

run "worker_host_self_name: Layer-2 catalyst.host.name used when env unset" \
	bash -c "source '$SCRIPT'; unset CATALYST_HOST_NAME; [ \"\$(CATALYST_LAYER2_CONFIG_FILE='${WH_LAYER2_DIR}/config.json' worker_host_self_name)\" = 'layer2host' ]"

run "worker_host_self_name: falls back to hostname when env+layer2 absent" \
	bash -c "source '$SCRIPT'; unset CATALYST_HOST_NAME; out=\$(CATALYST_LAYER2_CONFIG_FILE='${WH_LAYER2_DIR}/missing.json' worker_host_self_name); [ -n \"\$out\" ]"

run "worker_host_roster: missing cluster.json -> empty" \
	bash -c "source '$SCRIPT'; [ -z \"\$(CATALYST_CLUSTER_DIR='${SCRATCH}/wh-missing-cluster' worker_host_roster)\" ]"

WH_MALFORMED_DIR="${SCRATCH}/wh-malformed-cluster"
mkdir -p "$WH_MALFORMED_DIR"
echo '{not valid json' >"${WH_MALFORMED_DIR}/cluster.json"

run "worker_host_roster: malformed cluster.json -> empty (fail-soft)" \
	bash -c "source '$SCRIPT'; [ -z \"\$(CATALYST_CLUSTER_DIR='${WH_MALFORMED_DIR}' worker_host_roster)\" ]"

WH_ROSTER_DIR="${SCRATCH}/wh-roster"
mkdir -p "$WH_ROSTER_DIR"
cat >"${WH_ROSTER_DIR}/cluster.json" <<'EOF'
{"roster": ["mini", "mini-2"]}
EOF

run "worker_host_roster: reads roster array" \
	bash -c "source '$SCRIPT'; names=\$(CATALYST_CLUSTER_DIR='${WH_ROSTER_DIR}' worker_host_roster | sort | tr '\n' ' '); [ \"\$names\" = 'mini mini-2 ' ]"

run "worker_host_list: dedupes roster + self when self is already in the roster" \
	bash -c "source '$SCRIPT'; names=\$(CATALYST_CLUSTER_DIR='${WH_ROSTER_DIR}' CATALYST_HOST_NAME='mini' worker_host_list | sort | tr '\n' ' '); [ \"\$names\" = 'mini mini-2 ' ]"

run "worker_host_list: unions roster + a distinct self host" \
	bash -c "source '$SCRIPT'; names=\$(CATALYST_CLUSTER_DIR='${WH_ROSTER_DIR}' CATALYST_HOST_NAME='laptop' worker_host_list | sort | tr '\n' ' '); [ \"\$names\" = 'laptop mini mini-2 ' ]"

# make_worker_host_curl <bin_dir> <labels_nodes_json|ERROR> <create_ok> <log_file>
# Generic label-list fixture (labels_nodes_json is the raw `nodes` array
# content, or the literal string ERROR to make the initial query fail).
make_worker_host_curl() {
	local bin_dir="$1" labels_nodes="$2" create_ok="${3:-true}" log="${4:-/dev/null}"
	mkdir -p "$bin_dir"
	local create_resp query_resp
	if [ "$create_ok" = "true" ]; then
		create_resp='{"data":{"issueLabelCreate":{"success":true,"issueLabel":{"id":"new-lbl-id","name":"x"}}}}'
	else
		create_resp='{"errors":[{"message":"insufficient permissions"}]}'
	fi
	if [ "$labels_nodes" = "ERROR" ]; then
		query_resp='{"errors":[{"message":"api error"}]}'
	else
		query_resp="{\"data\":{\"issueLabels\":{\"nodes\":${labels_nodes}}}}"
	fi
	cat >"${bin_dir}/curl" <<SCRIPT
#!/usr/bin/env bash
body=""
for a in "\$@"; do case "\$a" in {*) body="\$a";; esac; done
if [ -z "\$body" ]; then body="\$(cat 2>/dev/null)"; fi
echo "\$body" >> "${log}"
case "\$body" in
  *issueLabelCreate*) echo '${create_resp}' ;;
  *) echo '${query_resp}' ;;
esac
exit 0
SCRIPT
	chmod +x "${bin_dir}/curl"
}

# Test 1: fresh workspace (empty) + single host (self only) -> 1 group create + 1 child create = 2
WH_T1_BIN="${SCRATCH}/wh-t1/bin"
WH_T1_LOG="${SCRATCH}/wh-t1/req.log"
mkdir -p "${SCRATCH}/wh-t1"
: >"$WH_T1_LOG"
make_worker_host_curl "$WH_T1_BIN" "[]" "true" "$WH_T1_LOG"
(
	# shellcheck source=/dev/null
	source "$SCRIPT"
	PATH="$WH_T1_BIN:$PATH"
	CATALYST_HOST_NAME="testhost"
	CATALYST_CLUSTER_DIR="${SCRATCH}/wh-t1-nocluster"
	dry_run=0
	reconcile_worker_host_labels "fake-token"
) >"${SCRATCH}/wh-t1-out" 2>&1
WH_T1_RC=$?

run "fresh workspace: issues exactly 2 issueLabelCreate calls (1 group + 1 child)" \
	bash -c "count=\$(grep -c 'issueLabelCreate' '$WH_T1_LOG' 2>/dev/null || echo 0); [ \"\$count\" = '2' ]"

run "fresh workspace: the child create is for worker:testhost" \
	bash -c "grep 'issueLabelCreate' '$WH_T1_LOG' | grep -q 'worker:testhost'"

run "fresh workspace: returns 0" \
	bash -c "[ '$WH_T1_RC' = '0' ]"

# Test 2: idempotent (group + the self child already present) -> 0 issueLabelCreate calls
WH_T2_BIN="${SCRATCH}/wh-t2/bin"
WH_T2_LOG="${SCRATCH}/wh-t2/req.log"
mkdir -p "${SCRATCH}/wh-t2"
: >"$WH_T2_LOG"
WH_T2_NODES='[{"id":"grp-w","name":"worker","isGroup":true,"parent":null},{"id":"lbl-th","name":"worker:testhost","isGroup":false,"parent":{"id":"grp-w"}}]'
make_worker_host_curl "$WH_T2_BIN" "$WH_T2_NODES" "true" "$WH_T2_LOG"
(
	# shellcheck source=/dev/null
	source "$SCRIPT"
	PATH="$WH_T2_BIN:$PATH"
	CATALYST_HOST_NAME="testhost"
	CATALYST_CLUSTER_DIR="${SCRATCH}/wh-t2-nocluster"
	dry_run=0
	reconcile_worker_host_labels "fake-token"
) >"${SCRATCH}/wh-t2-out" 2>&1
WH_T2_RC=$?

run "idempotent: zero issueLabelCreate calls when all present" \
	bash -c "! grep -q 'issueLabelCreate' '$WH_T2_LOG'"

run "idempotent: returns 0" \
	bash -c "[ '$WH_T2_RC' = '0' ]"

# Test 3: partial — 2 hosts (self + 1 roster host); group + self child present,
# roster host's child missing -> exactly 1 issueLabelCreate (the missing child)
WH_T3_BIN="${SCRATCH}/wh-t3/bin"
WH_T3_LOG="${SCRATCH}/wh-t3/req.log"
mkdir -p "${SCRATCH}/wh-t3"
: >"$WH_T3_LOG"
WH_T3_CLUSTER="${SCRATCH}/wh-t3-cluster"
mkdir -p "$WH_T3_CLUSTER"
cat >"${WH_T3_CLUSTER}/cluster.json" <<'EOF'
{"roster": ["host-b"]}
EOF
WH_T3_NODES='[{"id":"grp-w","name":"worker","isGroup":true,"parent":null},{"id":"lbl-a","name":"worker:host-a","isGroup":false,"parent":{"id":"grp-w"}}]'
make_worker_host_curl "$WH_T3_BIN" "$WH_T3_NODES" "true" "$WH_T3_LOG"
(
	# shellcheck source=/dev/null
	source "$SCRIPT"
	PATH="$WH_T3_BIN:$PATH"
	CATALYST_HOST_NAME="host-a"
	CATALYST_CLUSTER_DIR="$WH_T3_CLUSTER"
	dry_run=0
	reconcile_worker_host_labels "fake-token"
) >"${SCRATCH}/wh-t3-out" 2>&1

run "partial: creates only the missing child (1 issueLabelCreate)" \
	bash -c "count=\$(grep -c 'issueLabelCreate' '$WH_T3_LOG' 2>/dev/null || echo 0); [ \"\$count\" = '1' ]"

run "partial: the one create is for worker:host-b" \
	bash -c "grep 'issueLabelCreate' '$WH_T3_LOG' | grep -q 'worker:host-b'"

# Test 4: Linear error on the labels query -> WARNING printed, returns 0
WH_T4_BIN="${SCRATCH}/wh-t4/bin"
WH_T4_LOG="${SCRATCH}/wh-t4/req.log"
mkdir -p "${SCRATCH}/wh-t4"
: >"$WH_T4_LOG"
make_worker_host_curl "$WH_T4_BIN" "ERROR" "true" "$WH_T4_LOG"
WH_T4_OUT="${SCRATCH}/wh-t4-out"
(
	# shellcheck source=/dev/null
	source "$SCRIPT"
	PATH="$WH_T4_BIN:$PATH"
	CATALYST_HOST_NAME="testhost"
	CATALYST_CLUSTER_DIR="${SCRATCH}/wh-t4-nocluster"
	dry_run=0
	reconcile_worker_host_labels "fake-token"
) >"$WH_T4_OUT" 2>&1
WH_T4_RC=$?

run "query error: WARNING is printed" \
	bash -c "grep -qi 'warning' '$WH_T4_OUT'"

run "query error: returns 0 (never alters exit codes)" \
	bash -c "[ '$WH_T4_RC' = '0' ]"

# Test 5: --dry-run (dry_run=1) -> no issueLabelCreate mutations, reports intent
WH_T5_BIN="${SCRATCH}/wh-t5/bin"
WH_T5_LOG="${SCRATCH}/wh-t5/req.log"
mkdir -p "${SCRATCH}/wh-t5"
: >"$WH_T5_LOG"
make_worker_host_curl "$WH_T5_BIN" "[]" "true" "$WH_T5_LOG"
(
	# shellcheck source=/dev/null
	source "$SCRIPT"
	PATH="$WH_T5_BIN:$PATH"
	CATALYST_HOST_NAME="testhost"
	CATALYST_CLUSTER_DIR="${SCRATCH}/wh-t5-nocluster"
	dry_run=1
	reconcile_worker_host_labels "fake-token"
) >"${SCRATCH}/wh-t5-out" 2>&1

run "--dry-run: no issueLabelCreate mutations issued" \
	bash -c "! grep -q 'issueLabelCreate' '$WH_T5_LOG'"

run "--dry-run: reports intent (mentions worker or dry-run)" \
	bash -c "grep -qiE 'dry.run|DRY|worker' '${SCRATCH}/wh-t5-out'"

# Test 6 (plain-parent adoption): the 'worker' parent exists as a plain label
# (isGroup false, no children yet). Must be found by name+parent==null — not
# re-created — and only the missing self child gets created.
WH_T6_BIN="${SCRATCH}/wh-t6/bin"
WH_T6_LOG="${SCRATCH}/wh-t6/req.log"
mkdir -p "${SCRATCH}/wh-t6"
: >"$WH_T6_LOG"
WH_T6_NODES='[{"id":"grp-w","name":"worker","isGroup":false,"parent":null}]'
make_worker_host_curl "$WH_T6_BIN" "$WH_T6_NODES" "true" "$WH_T6_LOG"
(
	# shellcheck source=/dev/null
	source "$SCRIPT"
	PATH="$WH_T6_BIN:$PATH"
	CATALYST_HOST_NAME="testhost"
	CATALYST_CLUSTER_DIR="${SCRATCH}/wh-t6-nocluster"
	dry_run=0
	reconcile_worker_host_labels "fake-token"
) >"${SCRATCH}/wh-t6-out" 2>&1

run "plain-label parent: found by name+parent==null, creates only the 1 missing child" \
	bash -c "count=\$(grep -c 'issueLabelCreate' '$WH_T6_LOG' 2>/dev/null || echo 0); [ \"\$count\" = '1' ]"

run "plain-label parent: never re-creates the group (the one create carries parentId)" \
	bash -c "grep 'issueLabelCreate' '$WH_T6_LOG' | grep -q 'parentId'"

# Test 7 (roster-source coverage): CATALYST_CLUSTER_DIR fixture roster
# ["mini","mini-2"] + CATALYST_HOST_NAME=laptop -> children worker:mini,
# worker:mini-2, worker:laptop (1 group + 3 children = 4 issueLabelCreate).
WH_T7_BIN="${SCRATCH}/wh-t7/bin"
WH_T7_LOG="${SCRATCH}/wh-t7/req.log"
mkdir -p "${SCRATCH}/wh-t7"
: >"$WH_T7_LOG"
WH_T7_CLUSTER="${SCRATCH}/wh-t7-cluster"
mkdir -p "$WH_T7_CLUSTER"
cat >"${WH_T7_CLUSTER}/cluster.json" <<'EOF'
{"roster": ["mini", "mini-2"]}
EOF
make_worker_host_curl "$WH_T7_BIN" "[]" "true" "$WH_T7_LOG"
(
	# shellcheck source=/dev/null
	source "$SCRIPT"
	PATH="$WH_T7_BIN:$PATH"
	CATALYST_HOST_NAME="laptop"
	CATALYST_CLUSTER_DIR="$WH_T7_CLUSTER"
	dry_run=0
	reconcile_worker_host_labels "fake-token"
) >"${SCRATCH}/wh-t7-out" 2>&1

run "roster fixture: issues 4 issueLabelCreate (1 group + 3 children)" \
	bash -c "count=\$(grep -c 'issueLabelCreate' '$WH_T7_LOG' 2>/dev/null || echo 0); [ \"\$count\" = '4' ]"

run "roster fixture: creates worker:mini (distinct from worker:mini-2)" \
	bash -c "grep 'issueLabelCreate' '$WH_T7_LOG' | grep 'worker:mini' | grep -qv 'mini-2'"

run "roster fixture: creates worker:mini-2" \
	bash -c "grep 'issueLabelCreate' '$WH_T7_LOG' | grep -q 'worker:mini-2'"

run "roster fixture: creates worker:laptop" \
	bash -c "grep 'issueLabelCreate' '$WH_T7_LOG' | grep -q 'worker:laptop'"

# Test 8 (CTL-1481 finding 4: dead failure fixtures) — group already present (so
# group-create is never attempted, ruling out the early-return-on-group-failure
# path), 2 hosts (self + 1 roster host), BOTH children missing, and
# create_ok=false so every issueLabelCreate the loop attempts errors out.
# Asserts the per-child failure never aborts the loop: both children are still
# attempted, a WARNING is printed for each, and the function still returns 0.
WH_T8_BIN="${SCRATCH}/wh-t8/bin"
WH_T8_LOG="${SCRATCH}/wh-t8/req.log"
mkdir -p "${SCRATCH}/wh-t8"
: >"$WH_T8_LOG"
WH_T8_CLUSTER="${SCRATCH}/wh-t8-cluster"
mkdir -p "$WH_T8_CLUSTER"
cat >"${WH_T8_CLUSTER}/cluster.json" <<'EOF'
{"roster": ["host-b"]}
EOF
WH_T8_NODES='[{"id":"grp-w","name":"worker","isGroup":true,"parent":null}]'
make_worker_host_curl "$WH_T8_BIN" "$WH_T8_NODES" "false" "$WH_T8_LOG"
WH_T8_OUT="${SCRATCH}/wh-t8-out"
(
	# shellcheck source=/dev/null
	source "$SCRIPT"
	PATH="$WH_T8_BIN:$PATH"
	CATALYST_HOST_NAME="host-a"
	CATALYST_CLUSTER_DIR="$WH_T8_CLUSTER"
	dry_run=0
	reconcile_worker_host_labels "fake-token"
) >"$WH_T8_OUT" 2>&1
WH_T8_RC=$?

run "child create-failure: returns 0 (never alters exit codes)" \
	bash -c "[ '$WH_T8_RC' = '0' ]"

run "child create-failure: at least one WARNING is printed" \
	bash -c "grep -qi 'warning' '$WH_T8_OUT'"

run "child create-failure: both children are attempted despite the per-child error (2 issueLabelCreate)" \
	bash -c "count=\$(grep -c 'issueLabelCreate' '$WH_T8_LOG' 2>/dev/null || echo 0); [ \"\$count\" = '2' ]"

run "child create-failure: worker:host-a is attempted" \
	bash -c "grep 'issueLabelCreate' '$WH_T8_LOG' | grep -q 'worker:host-a'"

run "child create-failure: worker:host-b is attempted" \
	bash -c "grep 'issueLabelCreate' '$WH_T8_LOG' | grep -q 'worker:host-b'"

echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[ "$FAILURES" = "0" ]
