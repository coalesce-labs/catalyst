#!/usr/bin/env bash
# shellcheck disable=SC2016  # the single-quoted bodies handed to run_fn throughout this
# file are shell source for a CHILD shell; their `$` deliberately does not expand here.
# Tests for setup-catalyst.sh's Catalyst-source resolver and deferred-step ledger
# (CTL-1914 + CTL-1918).
#
# The defect these cover: FOUR separate lookups in setup-catalyst.sh resolved helper
# scripts relative to the script's own directory (`dirname "${BASH_SOURCE[0]}"`), which
# in the DOCUMENTED curl-download layout contains nothing but setup-catalyst.sh. Each
# one degraded to a silent skip, so the documented install and a repo-clone install
# produced materially different machines — and the more-broken one was the documented one.
#
# ⛔ Every "it now runs" assertion here is paired with a control that FIRES, because a
# stub that is never invoked and a stub whose invocation is not recorded are the same
# empty log. See CTL-1914's own evidence section for why that pairing is the point.
#
# Run: bash plugins/dev/scripts/__tests__/setup-catalyst-source-resolver.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SETUP="${REPO_ROOT}/setup-catalyst.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

pass() {
	PASSES=$((PASSES + 1))
	echo "  PASS: $1"
}
fail() {
	FAILURES=$((FAILURES + 1))
	echo "  FAIL: $1"
	shift
	for line in "$@"; do echo "      $line"; done
}

# if/else rather than `A && pass || fail`: in the latter a non-zero exit from `pass`
# itself runs the failure branch, so an assertion could report a failure it never had.
assert_eq() {
	local label="$1" actual="$2" expected="$3"
	if [[ $actual == "$expected" ]]; then
		pass "$label"
	else
		fail "$label" "expected: $expected" "actual:   $actual"
	fi
}
assert_grep() {
	local label="$1" output="$2" pattern="$3"
	if grep -qF -- "$pattern" <<<"$output"; then
		pass "$label"
	else
		fail "$label" "expected substring: $pattern" "actual output:" "$(echo "$output" | head -25)"
	fi
}
assert_not_grep() {
	local label="$1" output="$2" pattern="$3"
	if grep -qF -- "$pattern" <<<"$output"; then
		fail "$label" "unexpected substring: $pattern" "$(echo "$output" | head -25)"
	else
		pass "$label"
	fi
}

# A sealed prefix: HOME, a documented-curl-layout download dir (setup script ONLY),
# and a stub PATH. Nothing here can reach the real repo unless a test plants it.
fresh_prefix() {
	rm -rf "${SCRATCH:?}/home" "${SCRATCH:?}/dl" "${SCRATCH:?}/stubs" "${SCRATCH:?}/tree" "${SCRATCH:?}/bin"
	mkdir -p "$SCRATCH/home" "$SCRATCH/dl" "$SCRATCH/stubs"
	cp "$SETUP" "$SCRATCH/dl/setup-catalyst.sh"
	chmod +x "$SCRATCH/dl/setup-catalyst.sh"
}

# Materialise a *plausible* Catalyst source tree: the four helpers the installer needs,
# each an executable stub that records that it ran.
plant_tree() {
	local root="$1" log="$2"
	mkdir -p "$root/plugins/dev/scripts"
	local s
	for s in install-orphan-sweep.sh setup-execution-core-states.sh setup-plugin-source.sh install-cli.sh; do
		cat >"$root/plugins/dev/scripts/$s" <<EOF
#!/usr/bin/env bash
echo "INVOKED $s args=\$*" >> "$log"
exit 0
EOF
		chmod +x "$root/plugins/dev/scripts/$s"
	done
}

# The single-quoted bodies passed to run_fn below are source text for a CHILD shell;
# their `$` deliberately does not expand in this one.
# shellcheck disable=SC2016
#
# Run a function from the sourced library inside the sealed prefix. CWD is the
# download dir, which is what the documented curl install actually gives you.
run_fn() {
	local body="$1"
	shift
	env -i \
		HOME="$SCRATCH/home" \
		PATH="$SCRATCH/stubs:/usr/bin:/bin" \
		CATALYST_SETUP_LIB_ONLY=1 \
		"$@" \
		/bin/bash -c "cd '$SCRATCH/dl' && source './setup-catalyst.sh' >/dev/null 2>&1; $body" 2>&1
}

echo ""
echo "=== resolve_catalyst_source: the function exists and is callable ==="
fresh_prefix
OUT=$(run_fn 'declare -F resolve_catalyst_source >/dev/null && echo DEFINED || echo MISSING')
assert_grep "resolve_catalyst_source is defined" "$OUT" "DEFINED"

echo ""
echo "=== resolve_catalyst_source: finds a tree next to the script (repo-clone layout) ==="
fresh_prefix
plant_tree "$SCRATCH/dl" "$SCRATCH/planted.log"
OUT=$(run_fn 'resolve_catalyst_source && echo "ORIGIN=$CATALYST_SOURCE_ORIGIN"')
assert_grep "resolves the script-adjacent tree" "$OUT" "$SCRATCH/dl"
assert_grep "names the origin as script-dir" "$OUT" "ORIGIN=script-dir"

echo ""
echo "=== resolve_catalyst_source: an explicit override wins ==="
fresh_prefix
plant_tree "$SCRATCH/dl" "$SCRATCH/planted.log"
plant_tree "$SCRATCH/tree" "$SCRATCH/override.log"
OUT=$(run_fn 'resolve_catalyst_source && echo "ORIGIN=$CATALYST_SOURCE_ORIGIN"' CATALYST_SOURCE_DIR="$SCRATCH/tree")
assert_grep "override tree wins over script-adjacent" "$OUT" "$SCRATCH/tree"
assert_grep "names the origin as env" "$OUT" "ORIGIN=env"

echo ""
echo "=== ⛔ documented curl layout + cloning disabled: NAMED failure, never a silent skip ==="
fresh_prefix
OUT=$(run_fn 'if resolve_catalyst_source; then rc=0; else rc=$?; fi; echo "RC=$rc"; echo "REASON=$CATALYST_SOURCE_REASON"' CATALYST_NO_CLONE_SOURCE=1)
assert_grep "resolver fails rather than returning an empty success" "$OUT" "RC=1"
assert_grep "the failure carries a named reason" "$OUT" "REASON=no-source-tree"

echo ""
echo "=== resolve_catalyst_source: bootstrap clone materialises the tree ==="
fresh_prefix
# A git stub that "clones" by planting a tree at the destination — so the resolver's
# post-clone validation is exercised for real rather than trusted.
cat >"$SCRATCH/stubs/git" <<EOF
#!/usr/bin/env bash
if [[ "\$1" == "clone" ]]; then
  dest="\${@: -1}"
  mkdir -p "\$dest/plugins/dev/scripts"
  for s in install-orphan-sweep.sh setup-execution-core-states.sh setup-plugin-source.sh install-cli.sh; do
    printf '#!/usr/bin/env bash\necho "INVOKED %s args=\$*" >> "$SCRATCH/cloned.log"\n' "\$s" > "\$dest/plugins/dev/scripts/\$s"
    chmod +x "\$dest/plugins/dev/scripts/\$s"
  done
  echo "GIT-CLONE-STUB dest=\$dest" >> "$SCRATCH/cloned.log"
  exit 0
fi
exit 0
EOF
chmod +x "$SCRATCH/stubs/git"
OUT=$(run_fn 'resolve_catalyst_source && echo "ORIGIN=$CATALYST_SOURCE_ORIGIN"')
assert_grep "clone origin is named" "$OUT" "ORIGIN=cloned"
assert_grep "clone actually ran (control)" "$(cat "$SCRATCH/cloned.log" 2>/dev/null)" "GIT-CLONE-STUB"
assert_grep "resolved path is the plugin-source default" "$OUT" "$SCRATCH/home/catalyst/plugin-source"

echo ""
echo "=== ⛔ a clone that produces no usable tree is a NAMED failure, not a pass ==="
fresh_prefix
cat >"$SCRATCH/stubs/git" <<'EOF'
#!/usr/bin/env bash
# exits 0 having created nothing — the "success that installed nothing" shape
exit 0
EOF
chmod +x "$SCRATCH/stubs/git"
OUT=$(run_fn 'if resolve_catalyst_source; then rc=0; else rc=$?; fi; echo "RC=$rc"; echo "REASON=$CATALYST_SOURCE_REASON"')
assert_grep "an empty clone does not read as success" "$OUT" "RC=1"
assert_grep "an empty clone is named" "$OUT" "REASON=clone-produced-no-tree"

echo ""
echo "=== setup_sweep_config: the documented layout now INVOKES the sweep installer ==="
fresh_prefix
LOG="$SCRATCH/sweep.log"
plant_tree "$SCRATCH/tree" "$LOG"
mkdir -p "$SCRATCH/proj/.catalyst"
echo '{"catalyst":{}}' >"$SCRATCH/proj/.catalyst/config.json"
OUT=$(run_fn 'PROJECT_DIR='"$SCRATCH/proj"'; setup_sweep_config' \
	CATALYST_SOURCE_DIR="$SCRATCH/tree" CATALYST_FORCE_OS=Darwin)
assert_grep "install-orphan-sweep.sh ran" "$(cat "$LOG" 2>/dev/null)" "INVOKED install-orphan-sweep.sh"

echo "--- control: with NO tree and cloning disabled, it defers rather than silently skipping ---"
fresh_prefix
mkdir -p "$SCRATCH/proj2/.catalyst"
echo '{"catalyst":{}}' >"$SCRATCH/proj2/.catalyst/config.json"
OUT=$(run_fn 'PROJECT_DIR='"$SCRATCH/proj2"'; setup_sweep_config; print_deferred_steps' \
	CATALYST_NO_CLONE_SOURCE=1 CATALYST_FORCE_OS=Darwin)
assert_grep "the skip is announced, not silent" "$OUT" "orphan-sweep"
assert_grep "the deferral carries a verify command" "$OUT" "verify:"

echo ""
echo "=== setup_execution_core_states: the documented layout now finds the states script ==="
fresh_prefix
LOG="$SCRATCH/states.log"
plant_tree "$SCRATCH/tree" "$LOG"
mkdir -p "$SCRATCH/proj3/.catalyst"
echo '{"catalyst":{}}' >"$SCRATCH/proj3/.catalyst/config.json"
OUT=$(run_fn 'PROJECT_DIR='"$SCRATCH/proj3"'; setup_execution_core_states' CATALYST_SOURCE_DIR="$SCRATCH/tree")
assert_grep "setup-execution-core-states.sh ran" "$(cat "$LOG" 2>/dev/null)" "INVOKED setup-execution-core-states.sh"
assert_not_grep "no longer prints the old silent-skip warning" "$OUT" "not found — skipping state contract"

echo ""
echo "=== the deferred ledger ==="
fresh_prefix
OUT=$(run_fn 'catalyst_defer_step "Do the thing" "run-this --now" "verify-this --json"; print_deferred_steps')
assert_grep "ledger prints the step title" "$OUT" "Do the thing"
assert_grep "ledger prints the completing command" "$OUT" "run-this --now"
assert_grep "ledger prints the verifying command" "$OUT" "verify-this --json"

fresh_prefix
OUT=$(run_fn 'print_deferred_steps')
assert_grep "an empty ledger says so positively" "$OUT" "No steps were deferred"

echo ""
echo "=== finalize_install: performs the steps setup used to PRINT (CTL-1918) ==="
fresh_prefix
LOG="$SCRATCH/fin.log"
plant_tree "$SCRATCH/tree" "$LOG"
# The CLIs finalize_install is meant to install, pre-planted in the bin dir so the
# later steps have something to call — exactly the state install-cli.sh leaves behind.
mkdir -p "$SCRATCH/bin"
for b in catalyst-stack catalyst-execution-core; do
	cat >"$SCRATCH/bin/$b" <<EOF
#!/usr/bin/env bash
echo "INVOKED $b args=\$*" >> "$LOG"
exit 0
EOF
	chmod +x "$SCRATCH/bin/$b"
done
# CLOUD_REPLICA_PROVISIONED=1 is what setup_cloud_replica sets at its success exit.
# Activation keys on that OUTCOME, not on "a token was supplied" — see the case below.
OUT=$(run_fn 'TICKET_PREFIX=WIDGET; CLOUD_TOKEN=tok; CLOUD_REPLICA_PROVISIONED=1; NON_INTERACTIVE=1; finalize_install; print_deferred_steps' \
	CATALYST_SOURCE_DIR="$SCRATCH/tree" CATALYST_BIN_DIR="$SCRATCH/bin")
FIN="$(cat "$LOG" 2>/dev/null)"
assert_grep "install-cli.sh ran" "$FIN" "INVOKED install-cli.sh"
assert_grep "setup-plugin-source.sh ran" "$FIN" "INVOKED setup-plugin-source.sh"
assert_grep "replica reads were activated" "$FIN" "INVOKED catalyst-stack args=activate-replica"
assert_grep "the project was enrolled" "$FIN" "INVOKED catalyst-execution-core args=register --team WIDGET"
assert_grep "nothing was left deferred" "$OUT" "No steps were deferred"

echo ""
echo "--- ⛔ Codex #3500 P1: a token supplied but NOT provisioned must DEFER, not go quiet ---"
# The token can arrive through the documented env var, where the global CLOUD_TOKEN stays
# empty — so gating activation on that global skipped activate-replica AND recorded
# nothing, letting setup report a fully provisioned node with replica reads off.
fresh_prefix
LOG="$SCRATCH/unprov.log"
plant_tree "$SCRATCH/tree" "$LOG"
mkdir -p "$SCRATCH/bin"
for b in catalyst-stack catalyst-execution-core; do
	printf '#!/usr/bin/env bash\necho "INVOKED %s args=$*" >> "%s"\nexit 0\n' "$b" "$LOG" >"$SCRATCH/bin/$b"
	chmod +x "$SCRATCH/bin/$b"
done
# CLOUD_TOKEN empty, but the documented env var carries the token — the exact gap.
OUT=$(run_fn 'TICKET_PREFIX=WIDGET; NON_INTERACTIVE=1; finalize_install; print_deferred_steps' \
	CATALYST_SOURCE_DIR="$SCRATCH/tree" CATALYST_BIN_DIR="$SCRATCH/bin" CATALYST_CLOUD_TOKEN=tok-from-env)
assert_grep "an env-supplied token is SEEN" "$OUT" "replica READS"
assert_not_grep "and the run does not claim completeness" "$OUT" "No steps were deferred"
assert_not_grep "activate-replica is NOT run against a replica that was never provisioned" \
	"$(cat "$LOG" 2>/dev/null)" "activate-replica"

echo ""
echo "--- control: the same call with NO source tree defers every step, loudly ---"
fresh_prefix
mkdir -p "$SCRATCH/bin"
OUT=$(run_fn 'TICKET_PREFIX=WIDGET; CLOUD_TOKEN=tok; NON_INTERACTIVE=1; finalize_install; print_deferred_steps' \
	CATALYST_NO_CLONE_SOURCE=1 CATALYST_BIN_DIR="$SCRATCH/bin")
assert_not_grep "does NOT falsely claim a complete install" "$OUT" "No steps were deferred"
assert_grep "CLI install deferred" "$OUT" "Put the Catalyst CLIs on PATH"
assert_grep "plugin-source deferred" "$OUT" "Provision plugin-source"
assert_grep "replica reads deferred" "$OUT" "replica READS"
assert_grep "enrolment deferred" "$OUT" "Enrol this project"
assert_grep "every deferral is verifiable" "$OUT" "verify:"

echo ""
echo "--- ⛔ regression: the deferral must carry the NAMED reason, not an empty () ---"
# The first cut of catalyst_helper_path called the resolver as `$(resolve_catalyst_source)`.
# Command substitution is a subshell, so CATALYST_SOURCE_REASON — the entire point of
# failing with a named reason — was discarded and the operator got "NOT installed ()".
# The failure still *reported*; it just reported nothing usable.
fresh_prefix
mkdir -p "$SCRATCH/bin"
OUT=$(run_fn 'TICKET_PREFIX=WIDGET; NON_INTERACTIVE=1; finalize_install; print_deferred_steps' \
	CATALYST_NO_CLONE_SOURCE=1 CATALYST_BIN_DIR="$SCRATCH/bin")
assert_grep "the reason reaches the operator" "$OUT" "no-source-tree"
assert_not_grep "no empty-parenthesis diagnosis" "$OUT" "PATH ()"

echo ""
echo "--- a run with no team key names THAT, rather than emitting a placeholder to decode ---"
fresh_prefix
plant_tree "$SCRATCH/tree" "$SCRATCH/noteam.log"
OUT=$(run_fn 'CLOUD_TOKEN=""; NON_INTERACTIVE=1; finalize_install; print_deferred_steps' \
	CATALYST_SOURCE_DIR="$SCRATCH/tree" CATALYST_BIN_DIR="$SCRATCH/bin")
assert_grep "missing team key is stated as the reason" "$OUT" "no Linear team key was discovered"

echo ""
echo "=== --help documents the headless contract (CTL-1917) ==="
OUT=$(bash "$SETUP" --help 2>&1)
assert_grep "--non-interactive documented" "$OUT" "--non-interactive"
assert_grep "--cloud-token documented" "$OUT" "--cloud-token"
assert_grep "--source-dir documented" "$OUT" "--source-dir"
assert_grep "piped form documents -s --" "$OUT" "bash -s -- --non-interactive"

echo ""
echo "════════════════════════════════════════════"
echo "  PASSED: $PASSES   FAILED: $FAILURES"
echo "════════════════════════════════════════════"
[[ $FAILURES -eq 0 ]]
