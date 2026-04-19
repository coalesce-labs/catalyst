#!/usr/bin/env bash
# Test suite for catalyst-thoughts.sh (init-or-repair + check subcommands).
#
# Validates:
# - init-or-repair re-uses humanlayer when configured
# - init-or-repair leaves an existing valid symlink alone (only mkdirs subdirs)
# - init-or-repair treats "regular directory where symlink should be" as fatal
# - init-or-repair falls back with a loud warning when humanlayer is absent
# - check detects regular-dir-not-symlink, profile drift, and directory drift

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SUT="$SCRIPT_DIR/catalyst-thoughts.sh"

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

# Create a humanlayer shim that records every invocation to $SHIM_LOG and produces
# scripted output for status/config/init. The shim simulates humanlayer creating
# symlinks on init by targeting $FAKE_THOUGHTS_REPO inside the test project.
make_humanlayer_shim() {
	local bindir="$1"
	local shim_log="$2"
	local fake_repo="$3"
	local json_config="$4"
	mkdir -p "$bindir"
	cat >"$bindir/humanlayer" <<EOF
#!/usr/bin/env bash
echo "\$@" >> "$shim_log"
if [[ "\$1" == "thoughts" && "\$2" == "config" && "\$3" == "--json" ]]; then
    cat <<JSON
$json_config
JSON
    exit 0
fi
if [[ "\$1" == "thoughts" && "\$2" == "init" ]]; then
    # Parse --directory and --profile from the remaining args
    shift 2
    DIR=""
    PROFILE=""
    while (( "\$#" )); do
        case "\$1" in
            --directory) DIR="\$2"; shift 2 ;;
            --profile)   PROFILE="\$2"; shift 2 ;;
            --force)     shift ;;
            *)           shift ;;
        esac
    done
    # Simulate humanlayer creating symlinks into \$fake_repo/repos/\$DIR/...
    mkdir -p "$fake_repo/repos/\$DIR/shared" "$fake_repo/repos/\$DIR/ryan" "$fake_repo/global"
    mkdir -p thoughts
    ln -sfn "$fake_repo/repos/\$DIR/shared" thoughts/shared
    ln -sfn "$fake_repo/global"            thoughts/global
    ln -sfn "$fake_repo/repos/\$DIR/ryan"  thoughts/ryan
    exit 0
fi
if [[ "\$1" == "thoughts" && "\$2" == "uninit" ]]; then
    # Simulate humanlayer removing the symlinks it owns.
    rm -f thoughts/shared thoughts/global thoughts/ryan 2>/dev/null || true
    exit 0
fi
if [[ "\$1" == "thoughts" && "\$2" == "status" ]]; then
    echo "✓ Initialized"
    exit 0
fi
exit 0
EOF
	chmod +x "$bindir/humanlayer"
}

# Create the Catalyst config with thoughts.profile / thoughts.directory.
write_catalyst_config() {
	local path="$1"
	local profile="$2"
	local directory="$3"
	mkdir -p "$(dirname "$path")"
	cat >"$path" <<EOF
{
  "catalyst": {
    "projectKey": "test",
    "project": {"ticketPrefix": "TST"},
    "linear": {"teamKey": "TST", "stateMap": {"done": "Done"}},
    "thoughts": {"profile": "$profile", "directory": "$directory"}
  }
}
EOF
}

# Produce a humanlayer config --json payload that maps the CWD to a given repo/profile.
humanlayer_config_json() {
	local cwd="$1"
	local repo="$2"
	local profile="$3"
	if [[ -n "$profile" ]]; then
		cat <<EOF
{
  "thoughtsRepo": "/fake/repo",
  "reposDir": "repos",
  "globalDir": "global",
  "user": "ryan",
  "profiles": {},
  "repoMappings": {
    "$cwd": {"repo": "$repo", "profile": "$profile"}
  }
}
EOF
	else
		cat <<EOF
{
  "thoughtsRepo": "/fake/repo",
  "reposDir": "repos",
  "globalDir": "global",
  "user": "ryan",
  "profiles": {},
  "repoMappings": {
    "$cwd": {"repo": "$repo"}
  }
}
EOF
	fi
}

TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

# ── Test 1: init-or-repair on fresh project, humanlayer configured ────────

run_test "init-or-repair invokes humanlayer when configured"

TEST_DIR="$TMPDIR/test1"
FAKE_REPO="$TMPDIR/test1-thoughts"
mkdir -p "$TEST_DIR"
(
	cd "$TEST_DIR"
	write_catalyst_config ".catalyst/config.json" "test-profile" "test-dir"
	SHIM_LOG="$TEST_DIR/humanlayer.log"
	HL_JSON=$(humanlayer_config_json "$TEST_DIR" "test-dir" "test-profile")
	make_humanlayer_shim "$TEST_DIR/bin" "$SHIM_LOG" "$FAKE_REPO" "$HL_JSON"
	export PATH="$TEST_DIR/bin:$PATH"

	if bash "$SUT" init-or-repair >/dev/null 2>&1; then
		pass "init-or-repair exited 0"
	else
		fail "init-or-repair exit non-zero"
	fi

	if grep -q "thoughts init --force --directory test-dir --profile test-profile" "$SHIM_LOG"; then
		pass "humanlayer invoked with correct --directory and --profile"
	else
		fail "humanlayer was not invoked with expected args. Log contents:"
		cat "$SHIM_LOG" | sed 's/^/    /'
	fi

	if [[ -L "thoughts/shared" ]]; then
		pass "thoughts/shared is a symlink after repair"
	else
		fail "thoughts/shared is not a symlink"
	fi

	for d in research plans handoffs prs reports; do
		if [[ -d "thoughts/shared/$d" ]]; then
			pass "thoughts/shared/$d/ exists"
		else
			fail "thoughts/shared/$d/ missing"
		fi
	done
)

# ── Test 2: init-or-repair leaves valid symlink alone ────────────────────

run_test "init-or-repair does not re-init a valid symlink"

TEST_DIR="$TMPDIR/test2"
FAKE_REPO="$TMPDIR/test2-thoughts"
mkdir -p "$TEST_DIR"
(
	cd "$TEST_DIR"
	write_catalyst_config ".catalyst/config.json" "test-profile" "test-dir"
	SHIM_LOG="$TEST_DIR/humanlayer.log"
	HL_JSON=$(humanlayer_config_json "$TEST_DIR" "test-dir" "test-profile")
	make_humanlayer_shim "$TEST_DIR/bin" "$SHIM_LOG" "$FAKE_REPO" "$HL_JSON"
	export PATH="$TEST_DIR/bin:$PATH"

	# Pre-create a valid symlink target
	mkdir -p "$FAKE_REPO/repos/test-dir/shared"
	mkdir -p thoughts
	ln -sfn "$FAKE_REPO/repos/test-dir/shared" thoughts/shared
	ORIG_TARGET=$(readlink thoughts/shared)

	if bash "$SUT" init-or-repair >/dev/null 2>&1; then
		pass "init-or-repair exited 0"
	else
		fail "init-or-repair exit non-zero"
	fi

	if [[ ! -s "$SHIM_LOG" ]] || ! grep -q "thoughts init" "$SHIM_LOG"; then
		pass "humanlayer init was NOT invoked"
	else
		fail "humanlayer init was invoked unnecessarily"
	fi

	NEW_TARGET=$(readlink thoughts/shared)
	if [[ "$ORIG_TARGET" == "$NEW_TARGET" ]]; then
		pass "thoughts/shared symlink target unchanged"
	else
		fail "thoughts/shared symlink target changed: $ORIG_TARGET → $NEW_TARGET"
	fi

	for d in research plans handoffs prs reports; do
		if [[ -d "thoughts/shared/$d" ]]; then
			pass "subdir $d exists"
		else
			fail "subdir $d missing"
		fi
	done
)

# ── Test 3: init-or-repair treats regular-dir-as-shared as fatal ─────────

run_test "init-or-repair fails loudly when thoughts/shared is a regular directory"

TEST_DIR="$TMPDIR/test3"
mkdir -p "$TEST_DIR"
(
	cd "$TEST_DIR"
	write_catalyst_config ".catalyst/config.json" "test-profile" "test-dir"

	# Create the bug state: regular directory where a symlink should be
	mkdir -p thoughts/shared/research
	touch thoughts/shared/research/existing.md

	SHIM_LOG="$TEST_DIR/humanlayer.log"
	HL_JSON=$(humanlayer_config_json "$TEST_DIR" "test-dir" "test-profile")
	make_humanlayer_shim "$TEST_DIR/bin" "$SHIM_LOG" "$TMPDIR/test3-thoughts" "$HL_JSON"
	export PATH="$TEST_DIR/bin:$PATH"

	if bash "$SUT" init-or-repair 2>/tmp/ctl-90-test3-stderr; then
		fail "init-or-repair unexpectedly exited 0 on broken state"
	else
		pass "init-or-repair exited non-zero on broken state"
	fi

	if grep -qi "regular directory" /tmp/ctl-90-test3-stderr; then
		pass "error message identifies regular-directory state"
	else
		fail "error message missing 'regular directory' phrase. stderr:"
		cat /tmp/ctl-90-test3-stderr | sed 's/^/    /'
	fi

	if [[ ! -L "thoughts/shared" && -d "thoughts/shared" ]]; then
		pass "broken directory was NOT clobbered"
	else
		fail "broken directory was modified"
	fi

	if [[ -f thoughts/shared/research/existing.md ]]; then
		pass "existing file preserved (not clobbered)"
	else
		fail "existing file was clobbered"
	fi
)

# ── Test 4: init-or-repair fallback when no humanlayer, no config ────────

run_test "init-or-repair falls back to mkdir with warning when humanlayer absent"

TEST_DIR="$TMPDIR/test4"
mkdir -p "$TEST_DIR"
(
	cd "$TEST_DIR"
	# No .catalyst/config.json, no humanlayer on PATH
	export PATH="$TEST_DIR/emptybin:/usr/bin:/bin"
	mkdir -p "$TEST_DIR/emptybin"

	if bash "$SUT" init-or-repair 2>/tmp/ctl-90-test4-stderr; then
		pass "init-or-repair exited 0 in fallback mode"
	else
		fail "init-or-repair exited non-zero in fallback mode"
	fi

	if grep -qi "WARNING" /tmp/ctl-90-test4-stderr && grep -qi "will NOT sync" /tmp/ctl-90-test4-stderr; then
		pass "loud warning printed to stderr"
	else
		fail "fallback warning missing or too quiet. stderr:"
		cat /tmp/ctl-90-test4-stderr | sed 's/^/    /'
	fi

	for d in research plans handoffs prs reports; do
		if [[ -d "thoughts/shared/$d" ]]; then
			pass "fallback subdir $d created"
		else
			fail "fallback subdir $d missing"
		fi
	done
)

# ── Test 5a: check detects regular-dir-not-symlink ───────────────────────

run_test "check detects thoughts/shared being a regular directory"

TEST_DIR="$TMPDIR/test5a"
mkdir -p "$TEST_DIR"
(
	cd "$TEST_DIR"
	mkdir -p thoughts/shared

	if bash "$SUT" check 2>/tmp/ctl-90-test5a-stderr; then
		fail "check unexpectedly exited 0 on broken state"
	else
		pass "check exited non-zero on broken state"
	fi

	if grep -qi "regular directory" /tmp/ctl-90-test5a-stderr; then
		pass "check stderr contains 'regular directory'"
	else
		fail "check stderr missing 'regular directory'. stderr:"
		cat /tmp/ctl-90-test5a-stderr | sed 's/^/    /'
	fi
)

# ── Test 5b: check detects profile drift ─────────────────────────────────

run_test "check detects profile drift"

TEST_DIR="$TMPDIR/test5b"
FAKE_REPO="$TMPDIR/test5b-thoughts"
mkdir -p "$TEST_DIR"
(
	cd "$TEST_DIR"
	write_catalyst_config ".catalyst/config.json" "profile-A" "dir-A"
	SHIM_LOG="$TEST_DIR/humanlayer.log"
	# humanlayer claims the repo is mapped under profile-B (drift)
	HL_JSON=$(humanlayer_config_json "$TEST_DIR" "dir-A" "profile-B")
	make_humanlayer_shim "$TEST_DIR/bin" "$SHIM_LOG" "$FAKE_REPO" "$HL_JSON"
	export PATH="$TEST_DIR/bin:$PATH"

	# Pre-create a valid symlink so the symlink check doesn't trigger first
	mkdir -p "$FAKE_REPO/repos/dir-A/shared"
	mkdir -p thoughts
	ln -sfn "$FAKE_REPO/repos/dir-A/shared" thoughts/shared

	if bash "$SUT" check 2>/tmp/ctl-90-test5b-stderr; then
		fail "check unexpectedly exited 0 on profile drift"
	else
		pass "check exited non-zero on profile drift"
	fi

	if grep -qi "Profile drift" /tmp/ctl-90-test5b-stderr; then
		pass "check stderr reports profile drift"
	else
		fail "check stderr missing 'Profile drift'. stderr:"
		cat /tmp/ctl-90-test5b-stderr | sed 's/^/    /'
	fi
)

# ── Test 5c: check detects directory drift ───────────────────────────────

run_test "check detects directory drift"

TEST_DIR="$TMPDIR/test5c"
FAKE_REPO="$TMPDIR/test5c-thoughts"
mkdir -p "$TEST_DIR"
(
	cd "$TEST_DIR"
	write_catalyst_config ".catalyst/config.json" "profile-A" "dir-A"
	SHIM_LOG="$TEST_DIR/humanlayer.log"
	# Same profile, different repo/directory
	HL_JSON=$(humanlayer_config_json "$TEST_DIR" "dir-OTHER" "profile-A")
	make_humanlayer_shim "$TEST_DIR/bin" "$SHIM_LOG" "$FAKE_REPO" "$HL_JSON"
	export PATH="$TEST_DIR/bin:$PATH"

	mkdir -p "$FAKE_REPO/repos/dir-A/shared"
	mkdir -p thoughts
	ln -sfn "$FAKE_REPO/repos/dir-A/shared" thoughts/shared

	if bash "$SUT" check 2>/tmp/ctl-90-test5c-stderr; then
		fail "check unexpectedly exited 0 on directory drift"
	else
		pass "check exited non-zero on directory drift"
	fi

	if grep -qi "Directory drift" /tmp/ctl-90-test5c-stderr; then
		pass "check stderr reports directory drift"
	else
		fail "check stderr missing 'Directory drift'. stderr:"
		cat /tmp/ctl-90-test5c-stderr | sed 's/^/    /'
	fi
)

# ── Test 5d: check passes on healthy state ───────────────────────────────

run_test "check passes on a properly-configured project"

TEST_DIR="$TMPDIR/test5d"
FAKE_REPO="$TMPDIR/test5d-thoughts"
mkdir -p "$TEST_DIR"
(
	cd "$TEST_DIR"
	write_catalyst_config ".catalyst/config.json" "profile-A" "dir-A"
	SHIM_LOG="$TEST_DIR/humanlayer.log"
	HL_JSON=$(humanlayer_config_json "$TEST_DIR" "dir-A" "profile-A")
	make_humanlayer_shim "$TEST_DIR/bin" "$SHIM_LOG" "$FAKE_REPO" "$HL_JSON"
	export PATH="$TEST_DIR/bin:$PATH"

	mkdir -p "$FAKE_REPO/repos/dir-A/shared" "$FAKE_REPO/global"
	mkdir -p thoughts
	ln -sfn "$FAKE_REPO/repos/dir-A/shared" thoughts/shared
	ln -sfn "$FAKE_REPO/global"              thoughts/global

	if bash "$SUT" check 2>/tmp/ctl-90-test5d-stderr; then
		pass "check exited 0 on healthy project"
	else
		fail "check exited non-zero on healthy project. stderr:"
		cat /tmp/ctl-90-test5d-stderr | sed 's/^/    /'
	fi
)

# ── Test 6: init-or-repair auto-fixes profile drift ──────────────────────

run_test "init-or-repair auto-fixes profile drift (uninit + init)"

TEST_DIR="$TMPDIR/test6"
FAKE_REPO="$TMPDIR/test6-thoughts"
mkdir -p "$TEST_DIR"
(
	cd "$TEST_DIR"
	write_catalyst_config ".catalyst/config.json" "profile-A" "dir-A"
	SHIM_LOG="$TEST_DIR/humanlayer.log"
	# humanlayer claims the repo is mapped under profile-B (drift)
	HL_JSON=$(humanlayer_config_json "$TEST_DIR" "dir-A" "profile-B")
	make_humanlayer_shim "$TEST_DIR/bin" "$SHIM_LOG" "$FAKE_REPO" "$HL_JSON"
	export PATH="$TEST_DIR/bin:$PATH"

	# Pre-create a valid symlink so we're past the symlink-clobbered case.
	mkdir -p "$FAKE_REPO/repos/dir-A/shared"
	mkdir -p thoughts
	ln -sfn "$FAKE_REPO/repos/dir-A/shared" thoughts/shared

	if bash "$SUT" init-or-repair >/tmp/ctl-91-test6-stdout 2>&1; then
		pass "init-or-repair exited 0"
	else
		fail "init-or-repair exit non-zero on drift. output:"
		cat /tmp/ctl-91-test6-stdout | sed 's/^/    /'
	fi

	if grep -q "thoughts uninit --force" "$SHIM_LOG"; then
		pass "humanlayer uninit --force was invoked"
	else
		fail "humanlayer uninit was not invoked. log:"
		cat "$SHIM_LOG" | sed 's/^/    /'
	fi

	if grep -q "thoughts init --directory dir-A --profile profile-A" "$SHIM_LOG"; then
		pass "humanlayer init invoked with config profile"
	else
		fail "humanlayer init was not invoked with expected args. log:"
		cat "$SHIM_LOG" | sed 's/^/    /'
	fi

	if [[ -L "thoughts/shared" ]]; then
		pass "thoughts/shared is a symlink after drift repair"
	else
		fail "thoughts/shared is not a symlink after drift repair"
	fi
)

# ── Test 7: init-or-repair auto-fixes directory drift ────────────────────

run_test "init-or-repair auto-fixes directory drift"

TEST_DIR="$TMPDIR/test7"
FAKE_REPO="$TMPDIR/test7-thoughts"
mkdir -p "$TEST_DIR"
(
	cd "$TEST_DIR"
	write_catalyst_config ".catalyst/config.json" "profile-A" "dir-A"
	SHIM_LOG="$TEST_DIR/humanlayer.log"
	# Same profile, wrong directory in humanlayer mapping
	HL_JSON=$(humanlayer_config_json "$TEST_DIR" "dir-OTHER" "profile-A")
	make_humanlayer_shim "$TEST_DIR/bin" "$SHIM_LOG" "$FAKE_REPO" "$HL_JSON"
	export PATH="$TEST_DIR/bin:$PATH"

	mkdir -p "$FAKE_REPO/repos/dir-A/shared"
	mkdir -p thoughts
	ln -sfn "$FAKE_REPO/repos/dir-A/shared" thoughts/shared

	if bash "$SUT" init-or-repair >/tmp/ctl-91-test7-stdout 2>&1; then
		pass "init-or-repair exited 0"
	else
		fail "init-or-repair exit non-zero on directory drift. output:"
		cat /tmp/ctl-91-test7-stdout | sed 's/^/    /'
	fi

	if grep -q "thoughts uninit --force" "$SHIM_LOG" && \
	   grep -q "thoughts init --directory dir-A --profile profile-A" "$SHIM_LOG"; then
		pass "humanlayer uninit + init invoked for directory drift"
	else
		fail "humanlayer uninit + init not invoked for directory drift. log:"
		cat "$SHIM_LOG" | sed 's/^/    /'
	fi
)

# ── Summary ──

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if $PASS; then
	echo "✅ All $TESTS test groups passed"
	exit 0
else
	echo "❌ $FAILURES failure(s) across $TESTS test groups"
	exit 1
fi
