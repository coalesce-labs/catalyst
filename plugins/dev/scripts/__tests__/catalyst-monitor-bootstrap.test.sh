#!/usr/bin/env bash
# CTL-841: catalyst-monitor `start` must NOT hard-fail when ~/catalyst/wt is missing.
#
# A missing wt/ dir is a fresh-host normal, not a fatal error — a daemon start
# script should mkdir -p its own runtime dirs and start, rather than dead-end a
# headless-host operator at an interactive Claude skill. bootstrap() previously
# pushed "Worktree directory missing" onto its fatal-errors list and returned 1,
# which aborted cmd_start BEFORE its own `mkdir -p "$CATALYST_DIR/wt"` could run —
# proving the auto-create was always intended but unreachable.
#
# These tests source catalyst-monitor.sh and call bootstrap() directly against a
# throwaway CATALYST_DIR. MONITOR_SERVER_SCRIPT is pointed at a stub file whose
# sibling node_modules/ exists, so the orch-monitor install/build block is skipped
# (the test stays hermetic and fast).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
MONITOR_SH="${REPO_ROOT}/plugins/dev/scripts/catalyst-monitor.sh"

FAILURES=0
PASSES=0
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }

if [[ ! -f "$MONITOR_SH" ]]; then
  echo "FATAL: catalyst-monitor.sh missing: $MONITOR_SH" >&2
  exit 1
fi

# Build a hermetic sandbox: a CATALYST_DIR and a stub server-script dir whose
# node_modules/ already exists (so bootstrap skips the bun install/build block).
# Echoes the sandbox root on stdout.
make_sandbox() {
  local root
  root="$(mktemp -d)"
  mkdir -p "$root/srv/node_modules"
  : > "$root/srv/server.ts"
  echo "$root"
}

echo "Test: bootstrap self-heals a missing wt/ dir and succeeds"
ROOT="$(make_sandbox)"
mkdir -p "$ROOT/catalyst" # CATALYST_DIR exists, but wt/ does NOT
RESULT="$(
  CATALYST_DIR="$ROOT/catalyst" MONITOR_SERVER_SCRIPT="$ROOT/srv/server.ts" \
  bash -c '
    source "'"$MONITOR_SH"'" url >/dev/null 2>&1
    bootstrap >/dev/null 2>&1; rc=$?
    echo "rc=$rc wt=$([ -d "$CATALYST_DIR/wt" ] && echo yes || echo no)"
  '
)"
[[ "$RESULT" == *"rc=0"* ]] && pass "bootstrap returns 0 when wt/ is absent" \
  || fail "bootstrap should return 0 when wt/ is absent (got: $RESULT)"
[[ "$RESULT" == *"wt=yes"* ]] && pass "bootstrap creates \$CATALYST_DIR/wt when absent" \
  || fail "bootstrap should create \$CATALYST_DIR/wt (got: $RESULT)"
rm -rf "$ROOT"

echo ""
echo "Test: bootstrap stays idempotent when wt/ already exists"
ROOT="$(make_sandbox)"
mkdir -p "$ROOT/catalyst/wt" # both CATALYST_DIR and wt/ already present
RESULT="$(
  CATALYST_DIR="$ROOT/catalyst" MONITOR_SERVER_SCRIPT="$ROOT/srv/server.ts" \
  bash -c '
    source "'"$MONITOR_SH"'" url >/dev/null 2>&1
    bootstrap >/dev/null 2>&1; rc=$?
    echo "rc=$rc wt=$([ -d "$CATALYST_DIR/wt" ] && echo yes || echo no)"
  '
)"
[[ "$RESULT" == *"rc=0"* && "$RESULT" == *"wt=yes"* ]] \
  && pass "bootstrap returns 0 and leaves an existing wt/ in place" \
  || fail "bootstrap should be idempotent when wt/ exists (got: $RESULT)"
rm -rf "$ROOT"

echo ""
echo "Test: a missing CATALYST_DIR itself stays genuinely fatal"
ROOT="$(make_sandbox)" # NOTE: $ROOT/catalyst intentionally NOT created
OUT="$(
  CATALYST_DIR="$ROOT/catalyst" MONITOR_SERVER_SCRIPT="$ROOT/srv/server.ts" \
  bash -c '
    source "'"$MONITOR_SH"'" url >/dev/null 2>&1
    out=$(bootstrap 2>&1); rc=$?
    echo "rc=$rc dir=$([ -d "$CATALYST_DIR" ] && echo yes || echo no) wt=$([ -d "$CATALYST_DIR/wt" ] && echo yes || echo no)"
    echo "$out"
  '
)"
[[ "$OUT" == *"rc=1"* ]] && pass "bootstrap still returns 1 when CATALYST_DIR is missing" \
  || fail "missing CATALYST_DIR must stay fatal (got: $OUT)"
[[ "$OUT" == *"Catalyst directory missing"* ]] \
  && pass "bootstrap still reports the missing-CATALYST_DIR error" \
  || fail "missing-CATALYST_DIR error message should persist (got: $OUT)"
# The wt self-heal must NOT manufacture a runtime dir under a missing parent.
[[ "$OUT" == *"dir=no"* && "$OUT" == *"wt=no"* ]] \
  && pass "wt self-heal does not run when CATALYST_DIR is absent" \
  || fail "wt self-heal must not create dirs under a missing CATALYST_DIR (got: $OUT)"
rm -rf "$ROOT"

echo ""
echo "Test: the self-heal mkdir replaced the hard-fail (source-level guard)"
if grep -q 'Worktree directory missing' "$MONITOR_SH"; then
  fail "catalyst-monitor.sh still hard-fails on missing wt/ ('Worktree directory missing' present)"
else
  pass "catalyst-monitor.sh no longer hard-fails on missing wt/"
fi
if grep -q 'mkdir -p "$CATALYST_DIR/wt"' "$MONITOR_SH"; then
  pass "catalyst-monitor.sh mkdir -p's its wt/ runtime dir"
else
  fail "catalyst-monitor.sh should mkdir -p \$CATALYST_DIR/wt"
fi

# ─── Phase 2 (CTL-1223): ui/bun.lock staleness check ────────────────────────
#
# bootstrap() must run `bun install` in ui/ when ui/bun.lock is NEWER than
# ui/node_modules (lockfile-staleness check), not only when node_modules is
# absent. This mirrors the server-package check directly above it.

echo ""
echo "Test (CTL-1223): ui/bun.lock newer than ui/node_modules → ui install runs"
ROOT="$(mktemp -d)"
mkdir -p "$ROOT/catalyst/wt" "$ROOT/srv/node_modules"
: > "$ROOT/srv/server.ts"
mkdir -p "$ROOT/srv/ui/node_modules"
: > "$ROOT/srv/ui/package.json"
# Create bun.lock then touch node_modules first so lockfile is older (control)
touch "$ROOT/srv/ui/node_modules"
sleep 1
touch "$ROOT/srv/ui/bun.lock"   # lockfile is NEWER than node_modules
BUN_LOG="$ROOT/bun-calls.log"
FAKE_BUN_DIR="$ROOT/fake-bin"
mkdir -p "$FAKE_BUN_DIR"
cat > "$FAKE_BUN_DIR/bun" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$(pwd)" >> "$BUN_LOG"
exit 0
EOF
chmod +x "$FAKE_BUN_DIR/bun"
cat > "$FAKE_BUN_DIR/bunx" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$FAKE_BUN_DIR/bunx"
RESULT="$(
  BUN_LOG="$BUN_LOG" CATALYST_DIR="$ROOT/catalyst" MONITOR_SERVER_SCRIPT="$ROOT/srv/server.ts" \
  MONITOR_UI_DIST_DIR="$ROOT/dist" MONITOR_SKIP_BOOTSTRAP="" \
  PATH="$FAKE_BUN_DIR:$PATH" \
  bash -c '
    source "'"$MONITOR_SH"'" url >/dev/null 2>&1
    bootstrap >/dev/null 2>&1; echo "rc=$?"
  '
)"
UI_DIR="$ROOT/srv/ui"
if grep -qF "$UI_DIR" "$BUN_LOG" 2>/dev/null; then
  pass "CTL-1223 Phase 2: ui install ran when bun.lock newer than node_modules"
else
  fail "CTL-1223 Phase 2: ui install should run when bun.lock newer than node_modules (bun-calls: $(cat "$BUN_LOG" 2>/dev/null || echo none))"
fi
rm -rf "$ROOT"

echo ""
echo "Test (CTL-1223): ui/node_modules newer than ui/bun.lock → ui install does NOT run"
ROOT="$(mktemp -d)"
mkdir -p "$ROOT/catalyst/wt" "$ROOT/srv/node_modules"
: > "$ROOT/srv/server.ts"
mkdir -p "$ROOT/srv/ui"
: > "$ROOT/srv/ui/package.json"
touch "$ROOT/srv/ui/bun.lock"    # lockfile is OLDER
sleep 1
mkdir -p "$ROOT/srv/ui/node_modules"  # node_modules is NEWER
BUN_LOG="$ROOT/bun-calls.log"
FAKE_BUN_DIR="$ROOT/fake-bin"
mkdir -p "$FAKE_BUN_DIR"
cat > "$FAKE_BUN_DIR/bun" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$(pwd)" >> "$BUN_LOG"
exit 0
EOF
chmod +x "$FAKE_BUN_DIR/bun"
cat > "$FAKE_BUN_DIR/bunx" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$FAKE_BUN_DIR/bunx"
RESULT="$(
  BUN_LOG="$BUN_LOG" CATALYST_DIR="$ROOT/catalyst" MONITOR_SERVER_SCRIPT="$ROOT/srv/server.ts" \
  MONITOR_UI_DIST_DIR="$ROOT/dist" MONITOR_SKIP_BOOTSTRAP="" \
  PATH="$FAKE_BUN_DIR:$PATH" \
  bash -c '
    source "'"$MONITOR_SH"'" url >/dev/null 2>&1
    bootstrap >/dev/null 2>&1; echo "rc=$?"
  '
)"
UI_DIR="$ROOT/srv/ui"
if grep -qF "$UI_DIR" "$BUN_LOG" 2>/dev/null; then
  fail "CTL-1223 Phase 2: ui install should NOT run when node_modules is newer than bun.lock"
else
  pass "CTL-1223 Phase 2: ui install skipped when node_modules is up to date"
fi
rm -rf "$ROOT"

echo ""
echo "Test (CTL-1223): ui/node_modules absent → ui install still runs (existing behavior)"
ROOT="$(mktemp -d)"
mkdir -p "$ROOT/catalyst/wt" "$ROOT/srv/node_modules"
: > "$ROOT/srv/server.ts"
mkdir -p "$ROOT/srv/ui"
: > "$ROOT/srv/ui/package.json"
: > "$ROOT/srv/ui/bun.lock"
# Do NOT create ui/node_modules — should trigger install regardless
BUN_LOG="$ROOT/bun-calls.log"
FAKE_BUN_DIR="$ROOT/fake-bin"
mkdir -p "$FAKE_BUN_DIR"
cat > "$FAKE_BUN_DIR/bun" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$(pwd)" >> "$BUN_LOG"
exit 0
EOF
chmod +x "$FAKE_BUN_DIR/bun"
cat > "$FAKE_BUN_DIR/bunx" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$FAKE_BUN_DIR/bunx"
RESULT="$(
  BUN_LOG="$BUN_LOG" CATALYST_DIR="$ROOT/catalyst" MONITOR_SERVER_SCRIPT="$ROOT/srv/server.ts" \
  MONITOR_UI_DIST_DIR="$ROOT/dist" MONITOR_SKIP_BOOTSTRAP="" \
  PATH="$FAKE_BUN_DIR:$PATH" \
  bash -c '
    source "'"$MONITOR_SH"'" url >/dev/null 2>&1
    bootstrap >/dev/null 2>&1; echo "rc=$?"
  '
)"
UI_DIR="$ROOT/srv/ui"
if grep -qF "$UI_DIR" "$BUN_LOG" 2>/dev/null; then
  pass "CTL-1223 Phase 2: ui install runs when node_modules absent (existing behavior preserved)"
else
  fail "CTL-1223 Phase 2: ui install should run when node_modules is absent (bun-calls: $(cat "$BUN_LOG" 2>/dev/null || echo none))"
fi
rm -rf "$ROOT"

echo ""
echo "Test (CTL-1223): source guard — ui/ block references bun.lock staleness"
if grep -q 'ui/bun\.lock.*-nt.*ui/node_modules\|ui/node_modules.*-nt.*ui/bun\.lock' "$MONITOR_SH"; then
  pass "CTL-1223 Phase 2: catalyst-monitor.sh ui/ block references bun.lock staleness"
else
  fail "CTL-1223 Phase 2: catalyst-monitor.sh ui/ block should reference bun.lock staleness check"
fi

# ─── Phase 3 (CTL-1223): monitor.ui.build_failed structured event ─────────────
#
# When the production vite build fails, bootstrap() must emit a structured
# monitor.ui.build_failed event into the unified event log (in addition to
# the existing stderr warning), so the failure is no longer invisible.

echo ""
echo "Test (CTL-1223): build failure still prints stderr warning (regression guard)"
ROOT="$(mktemp -d)"
mkdir -p "$ROOT/catalyst/wt" "$ROOT/srv/node_modules"
: > "$ROOT/srv/server.ts"
mkdir -p "$ROOT/srv/ui/node_modules" "$ROOT/srv/public" "$ROOT/dist" "$ROOT/events"
: > "$ROOT/srv/ui/package.json"
: > "$ROOT/srv/ui/bun.lock"
FAKE_BUN_DIR="$ROOT/fake-bin"
mkdir -p "$FAKE_BUN_DIR"
cat > "$FAKE_BUN_DIR/bun" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$FAKE_BUN_DIR/bun"
# bunx fails (vite build failure)
cat > "$FAKE_BUN_DIR/bunx" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$FAKE_BUN_DIR/bunx"
STDERR_OUT="$(
  CATALYST_DIR="$ROOT/catalyst" MONITOR_SERVER_SCRIPT="$ROOT/srv/server.ts" \
  MONITOR_UI_DIST_DIR="$ROOT/dist" CATALYST_EVENTS_DIR="$ROOT/events" \
  MONITOR_SKIP_BOOTSTRAP="" \
  PATH="$FAKE_BUN_DIR:$PATH" \
  bash -c '
    source "'"$MONITOR_SH"'" url >/dev/null 2>&1
    bootstrap 2>&1 >/dev/null
  '
)"
if echo "$STDERR_OUT" | grep -q 'serving previous dist'; then
  pass "CTL-1223 Phase 3: stderr warning still printed on build failure"
else
  fail "CTL-1223 Phase 3: stderr warning missing on build failure (got: $STDERR_OUT)"
fi
rm -rf "$ROOT"

echo ""
echo "Test (CTL-1223): build failure emits monitor.ui.build_failed event"
ROOT="$(mktemp -d)"
mkdir -p "$ROOT/catalyst/wt" "$ROOT/srv/node_modules"
: > "$ROOT/srv/server.ts"
mkdir -p "$ROOT/srv/ui/node_modules" "$ROOT/srv/public" "$ROOT/dist" "$ROOT/events"
: > "$ROOT/srv/ui/package.json"
: > "$ROOT/srv/ui/bun.lock"
FAKE_BUN_DIR="$ROOT/fake-bin"
mkdir -p "$FAKE_BUN_DIR"
cat > "$FAKE_BUN_DIR/bun" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$FAKE_BUN_DIR/bun"
cat > "$FAKE_BUN_DIR/bunx" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$FAKE_BUN_DIR/bunx"
cat > "$FAKE_BUN_DIR/jq" <<'EOF'
#!/usr/bin/env bash
exec /usr/bin/jq "$@"
EOF
chmod +x "$FAKE_BUN_DIR/jq"
(
  CATALYST_DIR="$ROOT/catalyst" MONITOR_SERVER_SCRIPT="$ROOT/srv/server.ts" \
  MONITOR_UI_DIST_DIR="$ROOT/dist" CATALYST_EVENTS_DIR="$ROOT/events" \
  MONITOR_SKIP_BOOTSTRAP="" \
  PATH="$FAKE_BUN_DIR:$PATH" \
  bash -c '
    source "'"$MONITOR_SH"'" url >/dev/null 2>&1
    bootstrap >/dev/null 2>&1
  '
) || true
EVENT_FOUND=""
for f in "$ROOT/events"/*.jsonl; do
  [[ -f "$f" ]] || continue
  if grep -q '"monitor.ui.build_failed"' "$f" 2>/dev/null; then
    EVENT_FOUND="yes"
    break
  fi
done
if [[ -n "$EVENT_FOUND" ]]; then
  pass "CTL-1223 Phase 3: monitor.ui.build_failed event emitted on build failure"
else
  fail "CTL-1223 Phase 3: monitor.ui.build_failed event missing (events dir: $(ls "$ROOT/events/" 2>/dev/null || echo empty))"
fi
rm -rf "$ROOT"

echo ""
echo "Test (CTL-1223): build failure does NOT write .source-sha (retry preserved)"
ROOT="$(mktemp -d)"
mkdir -p "$ROOT/catalyst/wt" "$ROOT/srv/node_modules"
: > "$ROOT/srv/server.ts"
mkdir -p "$ROOT/srv/ui/node_modules" "$ROOT/srv/public" "$ROOT/dist" "$ROOT/events"
: > "$ROOT/srv/ui/package.json"
: > "$ROOT/srv/ui/bun.lock"
FAKE_BUN_DIR="$ROOT/fake-bin"
mkdir -p "$FAKE_BUN_DIR"
cat > "$FAKE_BUN_DIR/bun" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$FAKE_BUN_DIR/bun"
cat > "$FAKE_BUN_DIR/bunx" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$FAKE_BUN_DIR/bunx"
(
  CATALYST_DIR="$ROOT/catalyst" MONITOR_SERVER_SCRIPT="$ROOT/srv/server.ts" \
  MONITOR_UI_DIST_DIR="$ROOT/dist" CATALYST_EVENTS_DIR="$ROOT/events" \
  MONITOR_SKIP_BOOTSTRAP="" \
  PATH="$FAKE_BUN_DIR:$PATH" \
  bash -c '
    source "'"$MONITOR_SH"'" url >/dev/null 2>&1
    bootstrap >/dev/null 2>&1
  '
) || true
if [[ ! -f "$ROOT/dist/.source-sha" ]]; then
  pass "CTL-1223 Phase 3: .source-sha not written on build failure (retry next restart)"
else
  fail "CTL-1223 Phase 3: .source-sha must not be written on build failure"
fi
rm -rf "$ROOT"

echo ""
echo "Test (CTL-1223): build success → NO monitor.ui.build_failed event emitted"
ROOT="$(mktemp -d)"
mkdir -p "$ROOT/catalyst/wt" "$ROOT/srv/node_modules"
: > "$ROOT/srv/server.ts"
mkdir -p "$ROOT/srv/ui/node_modules" "$ROOT/srv/public" "$ROOT/dist" "$ROOT/events"
: > "$ROOT/srv/ui/package.json"
: > "$ROOT/srv/ui/bun.lock"
FAKE_BUN_DIR="$ROOT/fake-bin"
mkdir -p "$FAKE_BUN_DIR"
cat > "$FAKE_BUN_DIR/bun" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$FAKE_BUN_DIR/bun"
# bunx succeeds, creates index.html
cat > "$FAKE_BUN_DIR/bunx" <<'SCRIPT'
#!/usr/bin/env bash
DIST="${MONITOR_UI_DIST_DIR:-/tmp/dist}"
touch "$DIST/index.html"
exit 0
SCRIPT
chmod +x "$FAKE_BUN_DIR/bunx"
(
  CATALYST_DIR="$ROOT/catalyst" MONITOR_SERVER_SCRIPT="$ROOT/srv/server.ts" \
  MONITOR_UI_DIST_DIR="$ROOT/dist" CATALYST_EVENTS_DIR="$ROOT/events" \
  MONITOR_SKIP_BOOTSTRAP="" \
  PATH="$FAKE_BUN_DIR:$PATH" \
  bash -c '
    source "'"$MONITOR_SH"'" url >/dev/null 2>&1
    bootstrap >/dev/null 2>&1
  '
) || true
BAD_EVENT=""
for f in "$ROOT/events"/*.jsonl; do
  [[ -f "$f" ]] || continue
  if grep -q '"monitor.ui.build_failed"' "$f" 2>/dev/null; then
    BAD_EVENT="yes"
    break
  fi
done
if [[ -z "$BAD_EVENT" ]]; then
  pass "CTL-1223 Phase 3: no monitor.ui.build_failed event on build success"
else
  fail "CTL-1223 Phase 3: monitor.ui.build_failed must NOT be emitted on build success"
fi
rm -rf "$ROOT"

echo ""
echo "─────────────────────────────────────────────"
echo "catalyst-monitor-bootstrap: ${PASSES} passed, ${FAILURES} failed"
if [[ $FAILURES -gt 0 ]]; then
  exit 1
fi
exit 0
