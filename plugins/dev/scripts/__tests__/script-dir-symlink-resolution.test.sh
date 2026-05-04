#!/usr/bin/env bash
# Shell tests for SCRIPT_DIR symlink resolution across catalyst-* CLIs (CTL-239).
#
# Every catalyst-* CLI that uses SCRIPT_DIR to load sibling resources must compute
# SCRIPT_DIR via a symlink-resolving loop, not the naive single-line idiom. This
# test enforces both:
#
#   1. The canonical symlink-resolution loop works on direct invocation, single-hop
#      symlinks, multi-hop symlink chains, and relative symlink targets.
#   2. Each affected production CLI, when invoked through a symlink, computes the
#      same SCRIPT_DIR it would compute on direct invocation (i.e. the bug is fixed).
#
# Affected CLIs: catalyst-monitor.sh, catalyst-state.sh, catalyst-session.sh,
# catalyst-db.sh, catalyst-claude.sh, catalyst-comms.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
CLIS_DIR="${REPO_ROOT}/plugins/dev/scripts"

FAILURES=0
PASSES=0
# Resolve symlinks in the scratch path so comparisons against `cd -P` output match
# (on macOS, `mktemp -d` returns paths under /var/folders/... but /var is a symlink
# to /private/var, which `cd -P` resolves through).
SCRATCH="$(cd -P "$(mktemp -d -t script-dir-symlink-test-XXXXXX)" && pwd)"
trap 'rm -rf "$SCRATCH"' EXIT

fail() {
	FAILURES=$((FAILURES + 1))
	echo "  FAIL: $1"
}
pass() {
	PASSES=$((PASSES + 1))
	echo "  PASS: $1"
}

assert_eq() {
	local expected="$1" actual="$2" label="$3"
	if [[ $expected == "$actual" ]]; then
		pass "$label"
	else
		fail "$label — expected '$expected', got '$actual'"
	fi
}

# ─── Test 1: canonical snippet works ─────────────────────────────────────────
# Build a fake script that prints SCRIPT_DIR using the canonical snippet, then
# invoke it through several symlink configurations.

echo "→ Test 1: canonical symlink-resolution snippet"

REAL_DIR="$SCRATCH/real"
mkdir -p "$REAL_DIR"
FAKE_SCRIPT="$REAL_DIR/print-script-dir.sh"
cat >"$FAKE_SCRIPT" <<'EOF'
#!/usr/bin/env bash
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
echo "$SCRIPT_DIR"
EOF
chmod +x "$FAKE_SCRIPT"

# Direct invocation
got=$(bash "$FAKE_SCRIPT")
assert_eq "$REAL_DIR" "$got" "direct invocation resolves to real dir"

# Single-hop symlink
mkdir -p "$SCRATCH/bin1"
ln -s "$FAKE_SCRIPT" "$SCRATCH/bin1/link"
got=$(bash "$SCRATCH/bin1/link")
assert_eq "$REAL_DIR" "$got" "single-hop symlink resolves to real dir"

# Multi-hop symlink chain (a → b → c → real)
mkdir -p "$SCRATCH/bin2"
ln -s "$FAKE_SCRIPT" "$SCRATCH/bin2/c"
ln -s "$SCRATCH/bin2/c" "$SCRATCH/bin2/b"
ln -s "$SCRATCH/bin2/b" "$SCRATCH/bin2/a"
got=$(bash "$SCRATCH/bin2/a")
assert_eq "$REAL_DIR" "$got" "multi-hop symlink chain resolves to real dir"

# Relative symlink target — link target is relative, must be resolved against link's dir
mkdir -p "$SCRATCH/bin3" "$SCRATCH/realrel"
cp "$FAKE_SCRIPT" "$SCRATCH/realrel/script.sh"
chmod +x "$SCRATCH/realrel/script.sh"
(cd "$SCRATCH/bin3" && ln -s "../realrel/script.sh" "rel-link")
got=$(bash "$SCRATCH/bin3/rel-link")
assert_eq "$SCRATCH/realrel" "$got" "relative symlink target resolves correctly"

# ─── Test 2: each production CLI exposes the canonical pattern ──────────────
# After the fix, every affected CLI must use the symlink-resolving loop. This
# proves the pattern was applied uniformly — guards against partial fixes.

echo ""
echo "→ Test 2: every affected CLI uses the canonical loop"

AFFECTED_CLIS=(
	"catalyst-monitor.sh"
	"catalyst-state.sh"
	"catalyst-session.sh"
	"catalyst-db.sh"
	"catalyst-claude.sh"
	"catalyst-comms"
)

for cli in "${AFFECTED_CLIS[@]}"; do
	path="$CLIS_DIR/$cli"
	if [[ ! -f $path ]]; then
		fail "$cli is missing"
		continue
	fi
	# shellcheck disable=SC2016  # literal $ in regex, not a shell expansion
	if grep -Eq 'while \[ -L "\$SOURCE" \]; do' "$path"; then
		pass "$cli uses symlink-resolving loop"
	else
		fail "$cli does NOT use symlink-resolving loop (still has the broken naive idiom)"
	fi
done

# ─── Test 3: end-to-end smoke check via symlink ─────────────────────────────
# catalyst-monitor.sh is the user-visible failure case from the ticket: line 23
# computes MONITOR_DIR from SCRIPT_DIR unconditionally at script load. With the
# bug, ANY invocation through a symlink emits "cd: ... No such file or directory"
# from line 23 before doing anything else. With the fix, no such error.

echo ""
echo "→ Test 3: catalyst-monitor invoked through symlink (end-to-end)"

mkdir -p "$SCRATCH/symlinkbin"
ln -sf "$CLIS_DIR/catalyst-monitor.sh" "$SCRATCH/symlinkbin/catalyst-monitor"

# `status` doesn't need bootstrap and exercises MONITOR_DIR. With bootstrap
# disabled we won't try to start anything, but line 23 still runs at script load.
out=$(MONITOR_SKIP_BOOTSTRAP=1 "$SCRATCH/symlinkbin/catalyst-monitor" status 2>&1 || true)

# The exact failure mode from the ticket: "cd: <symlink-dir>/orch-monitor: No such
# file or directory". The fix is verified by the absence of that error.
if echo "$out" | grep -q "cd:.*orch-monitor.*No such file or directory"; then
	fail "catalyst-monitor via symlink still emits the line-23 cd error: $out"
else
	pass "catalyst-monitor via symlink does not emit the SCRIPT_DIR-derived cd error"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────

echo ""
echo "──────────────────────────────────────"
echo "  ${PASSES} passed, ${FAILURES} failed"
echo "──────────────────────────────────────"

[[ $FAILURES -eq 0 ]]
