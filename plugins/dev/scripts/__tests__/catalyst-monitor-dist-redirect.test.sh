#!/usr/bin/env bash
# CTL-1088: catalyst-monitor bootstrap() must redirect the vite build to an
# out-of-repo dist dir and leave the committed public/ byte-identical.
#
# Uses a stub vite that writes a marker index.html + assets/app.js into
# $MONITOR_UI_DIST_DIR instead of running the real heavy build. The stub bun
# captures its args to a file so cmd_start assertions can verify the env injection.
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

# Build a hermetic sandbox.
# - $root/srv/  — fake orch-monitor dir (server.ts, node_modules/, ui/, public/)
# - $root/dist/ — out-of-repo dist target (empty initially)
# - $root/catalyst/ — CATALYST_DIR
# - $root/bin/  — stub binaries (vite, bun) on PATH
make_sandbox() {
  local root
  root="$(mktemp -d)"

  # Fake committed public/ with non-vite static assets
  mkdir -p "$root/srv/public/vendor" "$root/srv/public/mockups" "$root/srv/public/assets"
  echo "history" > "$root/srv/public/history.html"
  echo "favicon-ico" > "$root/srv/public/favicon.ico"
  echo "favicon-svg" > "$root/srv/public/favicon.svg"
  echo "vendor-js" > "$root/srv/public/vendor/lib.js"
  echo "mockup-html" > "$root/srv/public/mockups/index.html"
  # Simulate a committed index.html that stub vite should NOT overwrite in public/
  echo "committed-index" > "$root/srv/public/index.html"

  # Fake orch-monitor dir with node_modules/ (skips bun install)
  mkdir -p "$root/srv/node_modules"
  : > "$root/srv/server.ts"

  # Fake ui/ with node_modules/ (skips UI bun install)
  mkdir -p "$root/srv/ui/node_modules"

  # CATALYST_DIR
  mkdir -p "$root/catalyst"

  # Stub binaries dir
  mkdir -p "$root/bin"

  # Stub vite: writes marker files into $MONITOR_UI_DIST_DIR
  cat > "$root/bin/vite" <<'VITE'
#!/usr/bin/env bash
# Stub vite build — writes markers into $MONITOR_UI_DIST_DIR
if [[ "${1:-}" == "build" ]]; then
  DIST="${MONITOR_UI_DIST_DIR:-/tmp/stub-dist-missing}"
  mkdir -p "$DIST/assets"
  echo "stub-index" > "$DIST/index.html"
  echo "stub-app" > "$DIST/assets/app.js"
fi
VITE
  chmod +x "$root/bin/vite"

  # Stub bunx: first arg is the package name (e.g. "vite"), skip it and pass the rest.
  cat > "$root/bin/bunx" <<BUNX
#!/usr/bin/env bash
shift  # drop package name
exec "$root/bin/vite" "\$@"
BUNX
  chmod +x "$root/bin/bunx"

  # Stub sqlite3 (bootstrap checks for it)
  cat > "$root/bin/sqlite3" <<'SQ'
#!/usr/bin/env bash
exit 0
SQ
  chmod +x "$root/bin/sqlite3"

  echo "$root"
}

# Helper: run bootstrap() in isolation with stub PATH.
# Extra NAME=VALUE args (after $root) are forwarded via env so they land as env vars.
run_bootstrap() {
  local root="$1"
  shift
  env \
    PATH="$root/bin:$PATH" \
    CATALYST_DIR="$root/catalyst" \
    MONITOR_SERVER_SCRIPT="$root/srv/server.ts" \
    MONITOR_UI_DIST_DIR="$root/dist" \
    "$@" \
    bash -c '
      source "'"$MONITOR_SH"'" url >/dev/null 2>&1
      bootstrap 2>&1; echo "rc=$?"
    '
}

# ─── Test 1: build is redirected to dist dir ────────────────────────────────
echo "Test 1: bootstrap redirects vite build to MONITOR_UI_DIST_DIR"
ROOT="$(make_sandbox)"
OUT="$(run_bootstrap "$ROOT")"
RC="${OUT##*rc=}"
if [[ "$RC" == "0" ]]; then
  pass "bootstrap returns 0"
else
  fail "bootstrap returned non-zero (rc=$RC); output: $OUT"
fi
if [[ -f "$ROOT/dist/index.html" ]]; then
  CONTENT="$(cat "$ROOT/dist/index.html")"
  if [[ "$CONTENT" == "stub-index" ]]; then
    pass "dist/index.html written by stub vite"
  else
    fail "dist/index.html has unexpected content: $CONTENT"
  fi
else
  fail "dist/index.html missing — build not redirected to MONITOR_UI_DIST_DIR"
fi
if [[ -f "$ROOT/dist/assets/app.js" ]]; then
  pass "dist/assets/app.js written by stub vite"
else
  fail "dist/assets/app.js missing"
fi
rm -rf "$ROOT"

# ─── Test 2: committed public/ is byte-identical after bootstrap ─────────────
echo ""
echo "Test 2: committed public/ unchanged after bootstrap"
ROOT="$(make_sandbox)"
# Snapshot committed public/ checksums
BEFORE="$(find "$ROOT/srv/public" -type f | sort | xargs md5 -q 2>/dev/null || find "$ROOT/srv/public" -type f | sort | xargs md5sum 2>/dev/null)"
run_bootstrap "$ROOT" >/dev/null 2>&1
AFTER="$(find "$ROOT/srv/public" -type f | sort | xargs md5 -q 2>/dev/null || find "$ROOT/srv/public" -type f | sort | xargs md5sum 2>/dev/null)"
if [[ "$BEFORE" == "$AFTER" ]]; then
  pass "committed public/ is byte-identical after bootstrap"
else
  fail "committed public/ was modified by bootstrap"
  echo "    BEFORE: $BEFORE"
  echo "    AFTER:  $AFTER"
fi
rm -rf "$ROOT"

# ─── Test 3: non-vite static assets are copied into dist ─────────────────────
echo ""
echo "Test 3: non-vite static assets copied into dist"
ROOT="$(make_sandbox)"
run_bootstrap "$ROOT" >/dev/null 2>&1
for asset in history.html favicon.ico favicon.svg; do
  if [[ -f "$ROOT/dist/$asset" ]]; then
    pass "dist/$asset copied from public/"
  else
    fail "dist/$asset missing — non-vite static assets not copied"
  fi
done
if [[ -d "$ROOT/dist/vendor" ]]; then
  pass "dist/vendor/ copied from public/"
else
  fail "dist/vendor/ missing"
fi
if [[ -d "$ROOT/dist/mockups" ]]; then
  pass "dist/mockups/ copied from public/"
else
  fail "dist/mockups/ missing"
fi
rm -rf "$ROOT"

# ─── Test 4: second bootstrap skips rebuild (guard fixed) ────────────────────
echo ""
echo "Test 4: second bootstrap skips rebuild when dist/index.html exists"
ROOT="$(make_sandbox)"
mkdir -p "$ROOT/dist"
echo "already-built" > "$ROOT/dist/index.html"
VITE_RAN_FILE="$ROOT/vite-ran"
# Override stub to record whether it ran
cat > "$ROOT/bin/vite" <<VITE2
#!/usr/bin/env bash
touch "$VITE_RAN_FILE"
VITE2
chmod +x "$ROOT/bin/vite"
cat > "$ROOT/bin/bunx" <<BUNX2
#!/usr/bin/env bash
shift
exec "$ROOT/bin/vite" "\$@"
BUNX2
chmod +x "$ROOT/bin/bunx"
run_bootstrap "$ROOT" >/dev/null 2>&1
if [[ ! -f "$VITE_RAN_FILE" ]]; then
  pass "stub vite NOT re-run when dist/index.html already exists"
else
  fail "stub vite was re-run on second bootstrap (always-true guard not fixed)"
fi
rm -rf "$ROOT"

# ─── Test 5: MONITOR_FORCE_BUILD=1 forces rebuild ────────────────────────────
echo ""
echo "Test 5: MONITOR_FORCE_BUILD=1 forces rebuild even when dist/index.html exists"
ROOT="$(make_sandbox)"
mkdir -p "$ROOT/dist"
echo "already-built" > "$ROOT/dist/index.html"
VITE_RAN_FILE="$ROOT/vite-ran"
cat > "$ROOT/bin/vite" <<VITE3
#!/usr/bin/env bash
if [[ "\${1:-}" == "build" ]]; then
  touch "$VITE_RAN_FILE"
  DIST="\${MONITOR_UI_DIST_DIR:-/tmp/stub-dist-missing}"
  mkdir -p "\$DIST"
  echo "forced-rebuild" > "\$DIST/index.html"
fi
VITE3
chmod +x "$ROOT/bin/vite"
cat > "$ROOT/bin/bunx" <<BUNX3
#!/usr/bin/env bash
shift
exec "$ROOT/bin/vite" "\$@"
BUNX3
chmod +x "$ROOT/bin/bunx"
run_bootstrap "$ROOT" MONITOR_FORCE_BUILD=1 >/dev/null 2>&1
if [[ -f "$VITE_RAN_FILE" ]]; then
  pass "stub vite re-run when MONITOR_FORCE_BUILD=1"
else
  fail "stub vite NOT re-run despite MONITOR_FORCE_BUILD=1"
fi
rm -rf "$ROOT"

# ─── Test 6: cmd_start injects MONITOR_PUBLIC_DIR ────────────────────────────
echo ""
echo "Test 6: cmd_start injects MONITOR_PUBLIC_DIR into server env"
ROOT="$(make_sandbox)"
mkdir -p "$ROOT/dist" && echo "built" > "$ROOT/dist/index.html"
ENV_CAPTURE="$ROOT/env-captured"

# Stub bun that captures its env and immediately exits (so we can inspect without
# actually running the server).
cat > "$ROOT/bin/bun" <<STUB_BUN
#!/usr/bin/env bash
printenv > "$ENV_CAPTURE"
STUB_BUN
chmod +x "$ROOT/bin/bun"

# Run cmd_start in a subshell; it will background the stub bun. Give it a moment.
PATH="$ROOT/bin:$PATH" \
CATALYST_DIR="$ROOT/catalyst" \
MONITOR_SERVER_SCRIPT="$ROOT/srv/server.ts" \
MONITOR_UI_DIST_DIR="$ROOT/dist" \
MONITOR_SKIP_BOOTSTRAP=1 \
bash -c '
  source "'"$MONITOR_SH"'" url >/dev/null 2>&1
  cmd_start >/dev/null 2>&1 || true
' 2>/dev/null || true
sleep 0.2

if [[ -f "$ENV_CAPTURE" ]]; then
  if grep -q "MONITOR_PUBLIC_DIR=$ROOT/dist" "$ENV_CAPTURE" 2>/dev/null; then
    pass "cmd_start injects MONITOR_PUBLIC_DIR=\$MONITOR_UI_DIST_DIR"
  else
    ACTUAL="$(grep MONITOR_PUBLIC_DIR "$ENV_CAPTURE" 2>/dev/null || echo '(not found)')"
    fail "MONITOR_PUBLIC_DIR not set correctly in server env; got: $ACTUAL"
  fi
else
  fail "stub bun did not capture env (cmd_start may not have launched the server)"
fi
rm -rf "$ROOT"

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "Results: $PASSES passed, $FAILURES failed"
[[ $FAILURES -eq 0 ]]
