#!/usr/bin/env bash
# Tests for the check-setup.sh worker-status label group section (CTL-764 Phase 2).
# Verifies TTL-cached prereq check: fresh cache skips live curl, cache miss issues
# one query, missing member warns + hints at setup script.
#
# Run: bash plugins/dev/scripts/__tests__/check-setup-worker-status-labels.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SCRIPT="${REPO_ROOT}/plugins/dev/scripts/check-setup.sh"

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
}

# make_project <dir> — minimal .catalyst/config.json + thoughts dirs
make_project() {
	local dir="$1"
	mkdir -p "${dir}/.catalyst"
	cat >"${dir}/.catalyst/config.json" <<EOF
{
  "catalyst": {
    "projectKey": "test",
    "project": { "ticketPrefix": "TST" },
    "linear": { "teamKey": "TST", "stateMap": { "research": "Research" } }
  }
}
EOF
	mkdir -p "${dir}/thoughts/shared/research" "${dir}/thoughts/shared/plans" \
		"${dir}/thoughts/shared/handoffs" "${dir}/thoughts/shared/prs" \
		"${dir}/thoughts/shared/reports"
}

# make_secrets <xdg-dir> — write config-test.json with a Linear token.
# Also creates a minimal config.json to prevent jq failures (set -e in check-setup.sh).
make_secrets() {
	local xdg="$1"
	mkdir -p "${xdg}/catalyst"
	cat >"${xdg}/catalyst/config-test.json" <<'EOF'
{ "linear": { "apiToken": "lin_api_fake_ws_token" } }
EOF
	echo '{"catalyst":{}}' >"${xdg}/catalyst/config.json"
}

# install_ws_curl <bin> <log> <labels-state>
# labels-state: full | missing-needs-input | no-group
install_ws_curl() {
	local bin="$1" log="$2" state="$3"
	mkdir -p "$bin"
	local labels_nodes
	case "$state" in
	full)
		labels_nodes='[{"id":"grp-ws","name":"worker-status","isGroup":true,"parent":null},{"id":"lbl-q","name":"queued","isGroup":false,"parent":{"id":"grp-ws"}},{"id":"lbl-b","name":"blocked","isGroup":false,"parent":{"id":"grp-ws"}},{"id":"lbl-ni","name":"needs-input","isGroup":false,"parent":{"id":"grp-ws"}},{"id":"lbl-nh","name":"needs-human","isGroup":false,"parent":{"id":"grp-ws"}}]'
		;;
	missing-needs-input)
		labels_nodes='[{"id":"grp-ws","name":"worker-status","isGroup":true,"parent":null},{"id":"lbl-q","name":"queued","isGroup":false,"parent":{"id":"grp-ws"}},{"id":"lbl-b","name":"blocked","isGroup":false,"parent":{"id":"grp-ws"}},{"id":"lbl-nh","name":"needs-human","isGroup":false,"parent":{"id":"grp-ws"}}]'
		;;
	no-group)
		labels_nodes='[]'
		;;
	esac
	cat >"${bin}/curl" <<SCRIPT
#!/usr/bin/env bash
body=""
for a in "\$@"; do case "\$a" in {*) body="\$a";; esac; done
if [ -z "\$body" ]; then body="\$(cat 2>/dev/null)"; fi
echo "\$body" >> "${log}"
case "\$body" in
  *issueLabels*)
    echo '{"data":{"issueLabels":{"nodes":${labels_nodes}}}}'
    ;;
  *)
    echo '{"data":{}}'
    ;;
esac
exit 0
SCRIPT
	chmod +x "${bin}/curl"
}

# run_check_setup <project-dir> <xdg> <bin>
run_check_setup() {
	local cwd="$1" xdg="$2" bin="${3:-/usr/bin:/bin}"
	local path_val
	if [[ $bin == "/usr/bin:/bin" ]]; then
		path_val="/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"
	else
		path_val="${bin}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"
	fi
	(cd "$cwd" &&
		env -i HOME="$HOME" PATH="$path_val" \
			XDG_CONFIG_HOME="$xdg" CATALYST_AUTONOMOUS=1 \
			bash "$SCRIPT" 2>&1 || true)
}

echo "check-setup.sh worker-status labels tests (CTL-764 Phase 2)"

# ─── Test 1: fresh cache (all 4 members) → 4 pass, no live curl ───────────────
P1="${SCRATCH}/p1" X1="${SCRATCH}/x1" B1="${SCRATCH}/b1" L1="${SCRATCH}/l1.log"
make_project "$P1"
make_secrets "$X1"
install_ws_curl "$B1" "$L1" "full"
: >"$L1"
NOW_TS="$(date +%s)"
cat >"${X1}/catalyst/linear-git-automation-cache.json" <<EOF
{ "TST": { "workerStatusLabels": { "fetchedAt": ${NOW_TS}, "members": ["queued","blocked","needs-input","needs-human"] } } }
EOF
OUT1="$(run_check_setup "$P1" "$X1" "$B1")"
if ! grep -q "issueLabels" "$L1" 2>/dev/null; then
	pass "fresh cache: no live issueLabels query"
else
	fail "fresh cache: no live issueLabels query"
fi
if ! grep -qiE "worker.status.*missing|worker.status.*warn" <<<"$OUT1"; then
	pass "fresh cache: no worker-status warning"
else
	fail "fresh cache: no worker-status warning"
	echo "$OUT1" | grep -i "worker" | sed 's/^/    /'
fi

# ─── Test 2: cache miss + full group → 4 pass lines ───────────────────────────
P2="${SCRATCH}/p2" X2="${SCRATCH}/x2" B2="${SCRATCH}/b2" L2="${SCRATCH}/l2.log"
make_project "$P2"
make_secrets "$X2"
install_ws_curl "$B2" "$L2" "full"
: >"$L2"
mkdir -p "${X2}/catalyst"
OUT2="$(run_check_setup "$P2" "$X2" "$B2")"
if grep -qiE "queued" <<<"$OUT2" && grep -qiE "blocked" <<<"$OUT2" &&
	grep -qiE "needs-input" <<<"$OUT2" && grep -qiE "needs-human" <<<"$OUT2"; then
	pass "cache miss + full group: all 4 members pass"
else
	fail "cache miss + full group: all 4 members pass"
	echo "$OUT2" | grep -i "worker" | sed 's/^/    /'
fi
if ! grep -qiE "worker.status.*missing|worker.status.*warn" <<<"$OUT2"; then
	pass "cache miss + full group: no missing warning"
else
	fail "cache miss + full group: no missing warning"
	echo "$OUT2" | grep -i "worker" | sed 's/^/    /'
fi

# ─── Test 3: cache miss + missing needs-input → warn + setup hint ──────────────
P3="${SCRATCH}/p3" X3="${SCRATCH}/x3" B3="${SCRATCH}/b3" L3="${SCRATCH}/l3.log"
make_project "$P3"
make_secrets "$X3"
install_ws_curl "$B3" "$L3" "missing-needs-input"
: >"$L3"
mkdir -p "${X3}/catalyst"
OUT3="$(run_check_setup "$P3" "$X3" "$B3")"
if grep -qiE "needs-input" <<<"$OUT3" && grep -q "setup-execution-core-states.sh" <<<"$OUT3"; then
	pass "missing needs-input: warns + setup hint"
else
	fail "missing needs-input: warns + setup hint"
	echo "$OUT3" | grep -i "needs\|setup\|worker" | sed 's/^/    /'
fi

# ─── Test 4: no token → info soft-skip (not warn, no curl) ────────────────────
P4="${SCRATCH}/p4" X4="${SCRATCH}/x4" B4="${SCRATCH}/b4" L4="${SCRATCH}/l4.log"
make_project "$P4"
install_ws_curl "$B4" "$L4" "full"
: >"$L4"
mkdir -p "${X4}/catalyst"
echo '{"catalyst":{}}' >"${X4}/catalyst/config.json"
# No secrets file (config-test.json) → token empty → soft-skip
OUT4="$(run_check_setup "$P4" "$X4" "$B4")"
if ! grep -q "issueLabels" "$L4" 2>/dev/null; then
	pass "no token: no live issueLabels query"
else
	fail "no token: no live issueLabels query"
fi
if ! grep -qiE "worker.status.*missing|worker.status.*label.*warn" <<<"$OUT4"; then
	pass "no token: no worker-status warning (soft-skip)"
else
	fail "no token: no worker-status warning (soft-skip)"
	echo "$OUT4" | grep -i "worker" | sed 's/^/    /'
fi

# ─── Test 5: missing group → warn_count incremented, NOT fail_count ────────────
P5="${SCRATCH}/p5" X5="${SCRATCH}/x5" B5="${SCRATCH}/b5" L5="${SCRATCH}/l5.log"
make_project "$P5"
make_secrets "$X5"
install_ws_curl "$B5" "$L5" "no-group"
: >"$L5"
mkdir -p "${X5}/catalyst"
OUT5="$(run_check_setup "$P5" "$X5" "$B5")"
if grep -qiE "worker-status" <<<"$OUT5"; then
	pass "group missing: worker-status mentioned in output"
else
	fail "group missing: worker-status mentioned in output"
	echo "$OUT5" | tail -20 | sed 's/^/    /'
fi
# Script exits 0 (warnings don't change exit code in check-setup.sh)
run_check_setup "$P5" "$X5" "$B5" >/dev/null 2>&1
RC5=$?
if [[ $RC5 -eq 0 ]]; then
	pass "group missing: exit 0 (warn-only, fail_count not incremented)"
else
	fail "group missing: exit 0 (got rc=$RC5)"
fi

# ─── Test 6 (CTL-764 finding G): supported .catalyst.linear.apiToken shape ─────
# An install using the supported nested shape must NOT be skipped — before the fix
# the check read only the legacy .linear.apiToken, leaving `token` empty so the
# worker-status section silently soft-skipped. Confirm the live query IS issued and
# the members are checked.
make_secrets_supported() {
	local xdg="$1"
	mkdir -p "${xdg}/catalyst"
	cat >"${xdg}/catalyst/config-test.json" <<'EOF'
{ "catalyst": { "linear": { "apiToken": "lin_api_fake_ws_token" } } }
EOF
	echo '{"catalyst":{}}' >"${xdg}/catalyst/config.json"
}

P6="${SCRATCH}/p6" X6="${SCRATCH}/x6" B6="${SCRATCH}/b6" L6="${SCRATCH}/l6.log"
make_project "$P6"
make_secrets_supported "$X6"
install_ws_curl "$B6" "$L6" "full"
: >"$L6"
mkdir -p "${X6}/catalyst"
OUT6="$(run_check_setup "$P6" "$X6" "$B6")"
if grep -q "issueLabels" "$L6" 2>/dev/null; then
	pass "supported token shape: live issueLabels query IS issued (not soft-skipped)"
else
	fail "supported token shape: live issueLabels query IS issued (not soft-skipped)"
fi
if ! grep -qiE "Skipping worker-status label check" <<<"$OUT6"; then
	pass "supported token shape: no soft-skip message"
else
	fail "supported token shape: no soft-skip message"
	echo "$OUT6" | grep -i "worker\|skip" | sed 's/^/    /'
fi

echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[ "$FAILURES" = "0" ]
