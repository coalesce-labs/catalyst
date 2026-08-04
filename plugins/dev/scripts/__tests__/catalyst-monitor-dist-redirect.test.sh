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

  # Stub vite: writes marker files into $MONITOR_UI_DIST_DIR.
  # Honor STUB_VITE_FAIL=1 to exit non-zero without writing (Phase 2, Test 10).
  cat > "$root/bin/vite" <<'VITE'
#!/usr/bin/env bash
# Stub vite build — writes markers into $MONITOR_UI_DIST_DIR
if [[ "${1:-}" == "build" ]]; then
  if [[ "${STUB_VITE_FAIL:-}" == "1" ]]; then
    echo "stub vite: forced failure" >&2
    exit 1
  fi
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

  # Stub git: for any `log` subcommand, print the contents of $STUB_GIT_SHA_FILE
  # (empty/absent → empty output). All other git subcommands succeed silently.
  # CTL-1118: lets tests control the "current UI source SHA" without a real repo.
  cat > "$root/bin/git" <<'GIT'
#!/usr/bin/env bash
for a in "$@"; do
  if [[ "$a" == "log" ]]; then
    cat "${STUB_GIT_SHA_FILE:-}" 2>/dev/null || true
    exit 0
  fi
done
exit 0
GIT
  chmod +x "$root/bin/git"

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

# CTL-1612: install a stub bun that dumps the child environment to
# $root/env-captured and exits, so cmd_start's env projection can be inspected
# without actually running the server.
install_bun_env_capture() {
  local root="$1"
  cat > "$root/bin/bun" <<STUB_BUN
#!/usr/bin/env bash
printenv > "$root/env-captured"
STUB_BUN
  chmod +x "$root/bin/bun"
}

# CTL-1612: run cmd_start() with bootstrap skipped and the env-capture stub bun.
# Ambient credential state is scrubbed with `env -u` FIRST so a developer's own
# shell export can never leak in and make a "nothing inherited" case pass for the
# wrong reason; extra NAME=VALUE args (after $root) are re-applied on top of the
# scrubbed env.
#
# BOTH secret-file overrides then default to absent sandbox paths, and every default
# sits BEFORE "$@" so a case can override the one it is testing (env applies
# assignments left-to-right, last wins). This is what keeps the suite hermetic now
# that cmd_start projects TWO credentials: without the github-token pin, the
# webhook-only cases would resolve the real ~/.config/catalyst/github-token and write
# a live token into the capture file.
#
# _CATALYST_SECRET_ENV_SH_LOADED is scrubbed too: it is the shared lib's
# idempotent-source guard, and an exported one would make cmd_start's `source` a no-op,
# leaving every projection silently unperformed.
#
# CTL-1612 (Codex P2 follow-up): cmd_start now ALSO mints the monitor's scoped
# app-actor token (linear_app_actor_auth "catalyst-monitor"
# CATALYST_MONITOR_APP_ACTOR_TOKEN), which resolves
# catalyst.linear.bot.orchestrator.{clientId,clientSecret} through the shared
# secret-contract chain and — if creds resolve — POSTs a REAL client_credentials
# request to https://api.linear.app/oauth/token. Tests 13/14 invoke cmd_start 11
# times; on a host with real orchestrator creds configured (any dev machine that
# runs the broker/execution-core) that is 11 live network calls per test run.
# CATALYST_LAYER2_CONFIG_FILE is checked FIRST in that chain (unconditionally,
# before CATALYST_MACHINE_CONFIG/XDG/~/.config — catalyst-secret-contract.sh
# catalyst_secret_resolve_layer2_path), so pinning it to an absent sandbox path
# seals the read: catalyst_resolve_secret finds no creds, and
# linear_app_actor_auth's mint block silently no-ops (documented fail-open) —
# no curl, no export, byte-identical to "orchestrator app not configured".
run_cmd_start() {
  local root="$1"
  shift
  env -u CATALYST_WEBHOOK_SECRET -u CATALYST_WEBHOOK_SECRET_FILE -u CATALYST_CONFIG_DIR \
    -u GITHUB_TOKEN -u GH_TOKEN -u CATALYST_GITHUB_TOKEN_FILE \
    -u CATALYST_GITHUB_TOKEN_SOURCE -u _CATALYST_SECRET_ENV_SH_LOADED \
    -u CATALYST_MACHINE_CONFIG -u CATALYST_MONITOR_APP_ACTOR_TOKEN \
    -u CATALYST_LIVENESS_READ_SOURCE -u CATALYST_LIVENESS_ANCHOR_ISSUE \
    PATH="$root/bin:$PATH" \
    CATALYST_DIR="$root/catalyst" \
    MONITOR_SERVER_SCRIPT="$root/srv/server.ts" \
    MONITOR_UI_DIST_DIR="$root/dist" \
    MONITOR_SKIP_BOOTSTRAP=1 \
    CATALYST_WEBHOOK_SECRET_FILE="$root/absent-webhook-secret" \
    CATALYST_GITHUB_TOKEN_FILE="$root/absent-github-token" \
    CATALYST_LAYER2_CONFIG_FILE="$root/absent-layer2-config.json" \
    "$@" \
    bash -c '
      source "'"$MONITOR_SH"'" url >/dev/null 2>&1
      cmd_start >/dev/null 2>&1 || true
    ' 2>/dev/null || true
  sleep 0.2
}

# CTL-1612 round 3: identical sandboxing to run_cmd_start, but preserves
# cmd_start's stderr into $root/stderr-captured instead of discarding it — the
# only way to assert on the loki-skip log line (and, via the curl-stub marker
# helpers below, on whether linear_app_actor_auth's mint code path ran at
# all). Every default still sits BEFORE "$@" so a case can override one.
#
# CTL-1612 round 4 (Codex P2 follow-up): CATALYST_LIVENESS_READ_SOURCE is
# ALSO unset here (not just the secret-related vars) — a dev/CI shell that
# happens to export =loki would otherwise leak into the "unset → AUTO"
# sub-case below and silently flip it onto the loki-skip path, making Test
# 16c/16d fail for a reason unrelated to what they're actually testing.
run_cmd_start_capture_stderr() {
  local root="$1"
  shift
  env -u CATALYST_WEBHOOK_SECRET -u CATALYST_WEBHOOK_SECRET_FILE -u CATALYST_CONFIG_DIR \
    -u GITHUB_TOKEN -u GH_TOKEN -u CATALYST_GITHUB_TOKEN_FILE \
    -u CATALYST_GITHUB_TOKEN_SOURCE -u _CATALYST_SECRET_ENV_SH_LOADED \
    -u CATALYST_MACHINE_CONFIG -u CATALYST_MONITOR_APP_ACTOR_TOKEN \
    -u CATALYST_LIVENESS_READ_SOURCE -u CATALYST_LIVENESS_ANCHOR_ISSUE \
    PATH="$root/bin:$PATH" \
    CATALYST_DIR="$root/catalyst" \
    MONITOR_SERVER_SCRIPT="$root/srv/server.ts" \
    MONITOR_UI_DIST_DIR="$root/dist" \
    MONITOR_SKIP_BOOTSTRAP=1 \
    CATALYST_WEBHOOK_SECRET_FILE="$root/absent-webhook-secret" \
    CATALYST_GITHUB_TOKEN_FILE="$root/absent-github-token" \
    CATALYST_LAYER2_CONFIG_FILE="$root/absent-layer2-config.json" \
    "$@" \
    bash -c '
      source "'"$MONITOR_SH"'" url >/dev/null 2>&1
      cmd_start >/dev/null 2>"'"$root"'/stderr-captured" || true
    ' || true
  sleep 0.2
}

# CTL-1612 round 3: installs a FAKE (obviously non-real) orchestrator
# clientId/clientSecret into a Layer-2-shaped config file, plus a stub `curl`
# that marks a file when invoked and returns a canned auth-failure body
# instead of ever reaching the network. This lets the loki-skip tests below
# distinguish "the mint code path never ran" (curl-invoked marker absent)
# from "it ran and failed for an unrelated sandbox reason" (creds absent) —
# without ever making a real request, fake creds or not.
#
# CTL-1612 round 5: optional 2nd arg — a fake catalyst.cluster.livenessAnchorIssue
# value to embed in the config (default: a fixed fake ticket id, so every EXISTING
# caller of this helper — round 3's Test 16 — continues to have an anchor
# configured and the mint proceeds exactly as those tests already expect, now
# that cmd_start ALSO gates on anchor presence). Pass an EMPTY STRING explicitly
# to build a config with NO anchor field at all (round 5's no-anchor-configured
# skip tests, Test 17).
install_fake_orchestrator_creds_and_curl_stub() {
  local root="$1"
  local anchor="${2-CTL-9999-fake-anchor}"
  if [[ -n "$anchor" ]]; then
    cat > "$root/fake-layer2-config.json" <<EOF
{"catalyst":{"linear":{"bot":{"orchestrator":{"clientId":"fake-ctl1612-r3-client-id","clientSecret":"fake-ctl1612-r3-client-secret"}}},"cluster":{"livenessAnchorIssue":"$anchor"}}}
EOF
  else
    cat > "$root/fake-layer2-config.json" <<'EOF'
{"catalyst":{"linear":{"bot":{"orchestrator":{"clientId":"fake-ctl1612-r3-client-id","clientSecret":"fake-ctl1612-r3-client-secret"}}}}}
EOF
  fi
  cat > "$root/bin/curl" <<CURLSTUB
#!/usr/bin/env bash
touch "$root/curl-invoked"
echo '{"error":"invalid_client"}'
CURLSTUB
  chmod +x "$root/bin/curl"
}

# CTL-1612 assertions over the captured child env. Secret VALUES are never echoed —
# a mismatch reports only that the value differs, so a leaked real secret can never
# reach the test log.
assert_captured_secret() {
  local root="$1" expected="$2" label="$3"
  local capture="$root/env-captured"
  if [[ ! -f "$capture" ]]; then
    fail "$label — stub bun did not capture env (cmd_start may not have launched the server)"
    return
  fi
  if grep -qxF "CATALYST_WEBHOOK_SECRET=$expected" "$capture" 2>/dev/null; then
    pass "$label"
  elif grep -q '^CATALYST_WEBHOOK_SECRET=' "$capture" 2>/dev/null; then
    fail "$label — CATALYST_WEBHOOK_SECRET set to a different value (redacted)"
  else
    fail "$label — CATALYST_WEBHOOK_SECRET not present in the server env"
  fi
}

assert_no_captured_secret() {
  local root="$1" label="$2"
  local capture="$root/env-captured"
  if [[ ! -f "$capture" ]]; then
    fail "$label — stub bun did not capture env (cmd_start may not have launched the server)"
    return
  fi
  if grep -q '^CATALYST_WEBHOOK_SECRET=' "$capture" 2>/dev/null; then
    fail "$label — CATALYST_WEBHOOK_SECRET was exported (value redacted); an empty secret makes webhook-config treat the GitHub route as unconfigured"
  else
    pass "$label"
  fi
}

# CTL-1612: the same two assertions for the GitHub credential, over BOTH names at once.
# `gh` resolves GH_TOKEN before GITHUB_TOKEN, so "the token reached the child" is only
# true when both names carry it — a single-name projection leaves a stale GH_TOKEN
# shadowing the fix. Values are never echoed; a mismatch names the variable only.
assert_captured_token() {
  local root="$1" expected="$2" label="$3"
  local capture="$root/env-captured"
  local name missing="" wrong=""
  if [[ ! -f "$capture" ]]; then
    fail "$label — stub bun did not capture env (cmd_start may not have launched the server)"
    return
  fi
  for name in GITHUB_TOKEN GH_TOKEN; do
    if grep -qxF "$name=$expected" "$capture" 2>/dev/null; then
      continue
    elif grep -q "^$name=" "$capture" 2>/dev/null; then
      wrong="$wrong $name"
    else
      missing="$missing $name"
    fi
  done
  if [[ -z "$missing" && -z "$wrong" ]]; then
    pass "$label"
  else
    fail "$label — wrong value (redacted) for:${wrong:-none}; absent from server env:${missing:-none}"
  fi
}

assert_no_captured_token() {
  local root="$1" label="$2"
  local capture="$root/env-captured"
  local name present=""
  if [[ ! -f "$capture" ]]; then
    fail "$label — stub bun did not capture env (cmd_start may not have launched the server)"
    return
  fi
  for name in GITHUB_TOKEN GH_TOKEN; do
    grep -q "^$name=" "$capture" 2>/dev/null && present="$present $name"
  done
  if [[ -z "$present" ]]; then
    pass "$label"
  else
    fail "$label — exported (value redacted):$present; an empty-string token is SET as far as \${X:-default} is concerned and defeats gh's hosts.yml/keyring fallback"
  fi
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

# CTL-1612 round 13 (Codex P2 follow-up): this used to invoke cmd_start via a
# standalone bash -c block instead of the shared run_cmd_start sandbox helper
# (see that helper's header comment) — on a host with real orchestrator
# creds configured (any dev machine running the broker/execution-core),
# cmd_start's app-actor mint resolves them and POSTs a REAL client_credentials
# request to https://api.linear.app/oauth/token before the stub bun below
# ever runs. run_cmd_start pins CATALYST_LAYER2_CONFIG_FILE (and the other
# secret-file/liveness vars) to absent sandbox paths, sealing that read —
# same defaults this test already relied on (PATH/CATALYST_DIR/
# MONITOR_SERVER_SCRIPT/MONITOR_UI_DIST_DIR/MONITOR_SKIP_BOOTSTRAP), so no
# extra override args are needed.
run_cmd_start "$ROOT"

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

# ─── Test 7: UI source SHA advanced → rebuild triggered ──────────────────────
echo ""
echo "Test 7: UI source SHA advanced → rebuild triggered even though index.html exists"
ROOT="$(make_sandbox)"
mkdir -p "$ROOT/dist"
echo "already-built" > "$ROOT/dist/index.html"
echo "sha-A" > "$ROOT/dist/.source-sha"
STUB_GIT_SHA_FILE="$ROOT/.stub-ui-sha"
echo "sha-B" > "$STUB_GIT_SHA_FILE"
VITE_RAN_FILE="$ROOT/vite-ran-7"
cat > "$ROOT/bin/vite" <<VITE7
#!/usr/bin/env bash
if [[ "\${1:-}" == "build" ]]; then
  touch "$VITE_RAN_FILE"
  DIST="\${MONITOR_UI_DIST_DIR:-/tmp/stub-dist-missing}"
  mkdir -p "\$DIST/assets"
  echo "rebuilt" > "\$DIST/index.html"
fi
VITE7
chmod +x "$ROOT/bin/vite"
cat > "$ROOT/bin/bunx" <<BUNX7
#!/usr/bin/env bash
shift
exec "$ROOT/bin/vite" "\$@"
BUNX7
chmod +x "$ROOT/bin/bunx"
STUB_GIT_SHA_FILE="$STUB_GIT_SHA_FILE" run_bootstrap "$ROOT" >/dev/null 2>&1
if [[ -f "$VITE_RAN_FILE" ]]; then
  pass "stub vite re-run when UI source SHA advanced (sha-A → sha-B)"
else
  fail "stub vite NOT re-run on SHA mismatch — SHA-aware guard not implemented"
fi
if [[ -f "$ROOT/dist/.source-sha" ]]; then
  WRITTEN_SHA="$(cat "$ROOT/dist/.source-sha")"
  if [[ "$WRITTEN_SHA" == "sha-B" ]]; then
    pass "dist/.source-sha updated to new SHA (sha-B) after rebuild"
  else
    fail "dist/.source-sha has wrong value: $WRITTEN_SHA (expected sha-B)"
  fi
else
  fail "dist/.source-sha not written after rebuild"
fi
rm -rf "$ROOT"

# ─── Test 8: UI source SHA unchanged → rebuild skipped ───────────────────────
echo ""
echo "Test 8: UI source SHA unchanged → rebuild skipped"
ROOT="$(make_sandbox)"
mkdir -p "$ROOT/dist"
echo "already-built" > "$ROOT/dist/index.html"
echo "sha-A" > "$ROOT/dist/.source-sha"
STUB_GIT_SHA_FILE="$ROOT/.stub-ui-sha"
echo "sha-A" > "$STUB_GIT_SHA_FILE"
VITE_RAN_FILE="$ROOT/vite-ran-8"
cat > "$ROOT/bin/vite" <<VITE8
#!/usr/bin/env bash
if [[ "\${1:-}" == "build" ]]; then
  touch "$VITE_RAN_FILE"
fi
VITE8
chmod +x "$ROOT/bin/vite"
cat > "$ROOT/bin/bunx" <<BUNX8
#!/usr/bin/env bash
shift
exec "$ROOT/bin/vite" "\$@"
BUNX8
chmod +x "$ROOT/bin/bunx"
STUB_GIT_SHA_FILE="$STUB_GIT_SHA_FILE" run_bootstrap "$ROOT" >/dev/null 2>&1
if [[ ! -f "$VITE_RAN_FILE" ]]; then
  pass "stub vite NOT re-run when SHA unchanged (sha-A == sha-A)"
else
  fail "stub vite was re-run despite SHA unchanged"
fi
rm -rf "$ROOT"

# ─── Test 9: first start records .source-sha ─────────────────────────────────
echo ""
echo "Test 9: first start records .source-sha when dist is empty"
ROOT="$(make_sandbox)"
STUB_GIT_SHA_FILE="$ROOT/.stub-ui-sha"
echo "sha-A" > "$STUB_GIT_SHA_FILE"
STUB_GIT_SHA_FILE="$STUB_GIT_SHA_FILE" run_bootstrap "$ROOT" >/dev/null 2>&1
if [[ -f "$ROOT/dist/.source-sha" ]]; then
  WRITTEN_SHA="$(cat "$ROOT/dist/.source-sha")"
  if [[ "$WRITTEN_SHA" == "sha-A" ]]; then
    pass "dist/.source-sha written with correct SHA (sha-A) on first build"
  else
    fail "dist/.source-sha has wrong value: $WRITTEN_SHA (expected sha-A)"
  fi
else
  fail "dist/.source-sha not written after first build"
fi
rm -rf "$ROOT"

# ─── Test 10: build failure does NOT advance .source-sha ─────────────────────
echo ""
echo "Test 10: build failure does NOT advance .source-sha (retry preserved)"
ROOT="$(make_sandbox)"
mkdir -p "$ROOT/dist"
echo "already-built" > "$ROOT/dist/index.html"
echo "sha-A" > "$ROOT/dist/.source-sha"
STUB_GIT_SHA_FILE="$ROOT/.stub-ui-sha"
echo "sha-B" > "$STUB_GIT_SHA_FILE"
cat > "$ROOT/bin/vite" <<'VITE10'
#!/usr/bin/env bash
if [[ "${1:-}" == "build" ]]; then
  if [[ "${STUB_VITE_FAIL:-}" == "1" ]]; then
    echo "stub vite: forced failure" >&2
    exit 1
  fi
  DIST="${MONITOR_UI_DIST_DIR:-/tmp/stub-dist-missing}"
  mkdir -p "$DIST"
  echo "rebuilt" > "$DIST/index.html"
fi
VITE10
chmod +x "$ROOT/bin/vite"
cat > "$ROOT/bin/bunx" <<BUNX10
#!/usr/bin/env bash
shift
exec "$ROOT/bin/vite" "\$@"
BUNX10
chmod +x "$ROOT/bin/bunx"
OUT10="$(STUB_GIT_SHA_FILE="$STUB_GIT_SHA_FILE" STUB_VITE_FAIL=1 run_bootstrap "$ROOT")"
RC10="${OUT10##*rc=}"
if [[ "$RC10" == "0" ]]; then
  pass "bootstrap exits 0 even when vite build fails (serve stale)"
else
  fail "bootstrap returned non-zero on build failure (rc=$RC10) — should serve stale"
fi
if [[ -f "$ROOT/dist/.source-sha" ]]; then
  REMAINING_SHA="$(cat "$ROOT/dist/.source-sha")"
  if [[ "$REMAINING_SHA" == "sha-A" ]]; then
    pass "dist/.source-sha still sha-A after failed build (retry preserved)"
  else
    fail "dist/.source-sha advanced to $REMAINING_SHA despite build failure (expected sha-A)"
  fi
else
  fail "dist/.source-sha disappeared after failed build"
fi
rm -rf "$ROOT"

# ─── Test 11: git unavailable / empty SHA → falls back to index.html-only guard
echo ""
echo "Test 11: git returns empty SHA → no spurious rebuild (index.html exists)"
ROOT="$(make_sandbox)"
mkdir -p "$ROOT/dist"
echo "already-built" > "$ROOT/dist/index.html"
STUB_GIT_SHA_FILE="$ROOT/.stub-ui-sha"
# Empty control file → git stub prints nothing → ui_source_sha=""
: > "$STUB_GIT_SHA_FILE"
VITE_RAN_FILE="$ROOT/vite-ran-11"
cat > "$ROOT/bin/vite" <<VITE11
#!/usr/bin/env bash
if [[ "\${1:-}" == "build" ]]; then
  touch "$VITE_RAN_FILE"
fi
VITE11
chmod +x "$ROOT/bin/vite"
cat > "$ROOT/bin/bunx" <<BUNX11
#!/usr/bin/env bash
shift
exec "$ROOT/bin/vite" "\$@"
BUNX11
chmod +x "$ROOT/bin/bunx"
STUB_GIT_SHA_FILE="$STUB_GIT_SHA_FILE" run_bootstrap "$ROOT" >/dev/null 2>&1
if [[ ! -f "$VITE_RAN_FILE" ]]; then
  pass "no spurious rebuild when git SHA is empty and index.html exists"
else
  fail "spurious rebuild triggered with empty git SHA (guard should fall back to index.html check)"
fi
rm -rf "$ROOT"

# ─── Test 12: git unavailable on first start → still builds ──────────────────
echo ""
echo "Test 12: git returns empty SHA on first start → build still triggered (index.html missing)"
ROOT="$(make_sandbox)"
STUB_GIT_SHA_FILE="$ROOT/.stub-ui-sha"
# Empty control file → empty git SHA; dist is empty (first start)
: > "$STUB_GIT_SHA_FILE"
STUB_GIT_SHA_FILE="$STUB_GIT_SHA_FILE" run_bootstrap "$ROOT" >/dev/null 2>&1
if [[ -f "$ROOT/dist/index.html" ]]; then
  pass "first-start build still fires with empty git SHA (index.html missing path)"
else
  fail "first-start build did not fire with empty git SHA"
fi
if [[ ! -f "$ROOT/dist/.source-sha" ]]; then
  pass "dist/.source-sha NOT written when git SHA is empty (guarded write)"
else
  fail "dist/.source-sha written despite empty git SHA (should be skipped)"
fi
rm -rf "$ROOT"

# ─── Test 13: cmd_start projects CATALYST_WEBHOOK_SECRET from the secret file ─
# CTL-1612. webhook-config.ts resolves the GitHub HMAC key from process.env ONLY,
# so cmd_start must project it from the SOPS-managed file the same way the launchd
# wrapper does — file-wins, whitespace-stripped, and NEVER exported as "".
# Every value below is an obviously-fake literal; no real secret is ever read
# (CATALYST_WEBHOOK_SECRET_FILE is pinned into the sandbox in all five sub-cases).
echo ""
echo "Test 13: cmd_start projects CATALYST_WEBHOOK_SECRET from the secret file (CTL-1612)"

# (a) file has a secret, nothing inherited → projected verbatim
ROOT="$(make_sandbox)"
install_bun_env_capture "$ROOT"
echo "whsec_fake_1" > "$ROOT/webhook-secret"
run_cmd_start "$ROOT" CATALYST_WEBHOOK_SECRET_FILE="$ROOT/webhook-secret"
assert_captured_secret "$ROOT" "whsec_fake_1" "13a: file value projected into the server env"
rm -rf "$ROOT"

# (b) FILE WINS over a stale value already exported by the invoking shell
ROOT="$(make_sandbox)"
install_bun_env_capture "$ROOT"
echo "whsec_fake_2" > "$ROOT/webhook-secret"
run_cmd_start "$ROOT" \
  CATALYST_WEBHOOK_SECRET_FILE="$ROOT/webhook-secret" \
  CATALYST_WEBHOOK_SECRET=whsec_stale
assert_captured_secret "$ROOT" "whsec_fake_2" "13b: file wins over a stale inherited export"
rm -rf "$ROOT"

# (c) whitespace-only file → no-op; the inherited value must survive, not be clobbered
ROOT="$(make_sandbox)"
install_bun_env_capture "$ROOT"
printf '   \n\t\n' > "$ROOT/webhook-secret"
run_cmd_start "$ROOT" \
  CATALYST_WEBHOOK_SECRET_FILE="$ROOT/webhook-secret" \
  CATALYST_WEBHOOK_SECRET=whsec_stale
assert_captured_secret "$ROOT" "whsec_stale" "13c: whitespace-only file leaves the inherited value intact"
rm -rf "$ROOT"

# (d) EMPTY file, nothing inherited → variable absent entirely (never exported as "")
ROOT="$(make_sandbox)"
install_bun_env_capture "$ROOT"
: > "$ROOT/webhook-secret"
run_cmd_start "$ROOT" CATALYST_WEBHOOK_SECRET_FILE="$ROOT/webhook-secret"
assert_no_captured_secret "$ROOT" "13d: empty file exports nothing (no empty-string secret)"
rm -rf "$ROOT"

# (e) absent file, nothing inherited → likewise absent
ROOT="$(make_sandbox)"
install_bun_env_capture "$ROOT"
run_cmd_start "$ROOT" CATALYST_WEBHOOK_SECRET_FILE="$ROOT/no-such-webhook-secret"
assert_no_captured_secret "$ROOT" "13e: absent file exports nothing (no empty-string secret)"
rm -rf "$ROOT"

# ─── Test 14: cmd_start projects the GitHub credential into the server env ───
# CTL-1612 round 3. orch-monitor makes 13 `gh` calls across 5 files (pr-status,
# preview-status, webhook-subscriber, webhook-replay, repo-icon-fetcher) and contains
# ZERO references to GITHUB_TOKEN/GH_TOKEN — its GitHub auth was purely ambient
# inheritance, i.e. exactly the defect this ticket exists to fix, still unfixed on the
# monitor side until now. All 13 sites inherit this launcher's env, so projecting once
# in cmd_start fixes them all and none of them change; the property worth pinning is
# therefore "the credential reaches the child", not anything per-call-site.
#
# BOTH names are asserted because `gh` resolves GH_TOKEN BEFORE GITHUB_TOKEN: projecting
# only GITHUB_TOKEN would leave a stale GH_TOKEN in the launcher's ancestry shadowing
# the fix, which is the same trap the daemon launcher already hit.
# Every value below is an obviously-fake literal, and run_cmd_start pins
# CATALYST_GITHUB_TOKEN_FILE into the sandbox, so the real
# ~/.config/catalyst/github-token is never read.
echo ""
echo "Test 14: cmd_start projects GITHUB_TOKEN + GH_TOKEN from the shared file (CTL-1612)"

# (a) file has a token, nothing inherited → both names reach the server
ROOT="$(make_sandbox)"
install_bun_env_capture "$ROOT"
echo "FAKE-CTL1612-monitor-file-token-AAAA" > "$ROOT/github-token"
run_cmd_start "$ROOT" CATALYST_GITHUB_TOKEN_FILE="$ROOT/github-token"
assert_captured_token "$ROOT" "FAKE-CTL1612-monitor-file-token-AAAA" \
  "14a: file value reaches the server env under BOTH names"
rm -rf "$ROOT"

# (b) FILE WINS over a stale GITHUB_TOKEN exported by the invoking shell — the stale
#     inherited value IS the live breakage; a fill-if-unset projection would fix nothing.
ROOT="$(make_sandbox)"
install_bun_env_capture "$ROOT"
echo "FAKE-CTL1612-monitor-file-token-BBBB" > "$ROOT/github-token"
run_cmd_start "$ROOT" \
  CATALYST_GITHUB_TOKEN_FILE="$ROOT/github-token" \
  GITHUB_TOKEN=FAKE-CTL1612-monitor-stale-github-XXXX
assert_captured_token "$ROOT" "FAKE-CTL1612-monitor-file-token-BBBB" \
  "14b: file wins over a stale inherited GITHUB_TOKEN (both names re-pointed)"
rm -rf "$ROOT"

# (c) FILE WINS over a stale GH_TOKEN too — the name gh reads first.
ROOT="$(make_sandbox)"
install_bun_env_capture "$ROOT"
echo "FAKE-CTL1612-monitor-file-token-CCCC" > "$ROOT/github-token"
run_cmd_start "$ROOT" \
  CATALYST_GITHUB_TOKEN_FILE="$ROOT/github-token" \
  GH_TOKEN=FAKE-CTL1612-monitor-stale-gh-YYYY
assert_captured_token "$ROOT" "FAKE-CTL1612-monitor-file-token-CCCC" \
  "14c: file wins over a stale inherited GH_TOKEN (gh resolves this name first)"
rm -rf "$ROOT"

# (d) absent file, nothing inherited → NEITHER name exported (not even as "")
ROOT="$(make_sandbox)"
install_bun_env_capture "$ROOT"
run_cmd_start "$ROOT" CATALYST_GITHUB_TOKEN_FILE="$ROOT/no-such-github-token"
assert_no_captured_token "$ROOT" "14d: absent file exports neither name (gh falls through to hosts.yml)"
rm -rf "$ROOT"

# (e) EMPTY file, nothing inherited → likewise neither name
ROOT="$(make_sandbox)"
install_bun_env_capture "$ROOT"
: > "$ROOT/github-token"
run_cmd_start "$ROOT" CATALYST_GITHUB_TOKEN_FILE="$ROOT/github-token"
assert_no_captured_token "$ROOT" "14e: empty file exports neither name (no empty-string token)"
rm -rf "$ROOT"

# (f) the webhook secret is still projected alongside it — the two projections must not
#     shadow each other, since cmd_start now performs both from the same shared lib.
ROOT="$(make_sandbox)"
install_bun_env_capture "$ROOT"
echo "whsec_fake_3" > "$ROOT/webhook-secret"
echo "FAKE-CTL1612-monitor-file-token-DDDD" > "$ROOT/github-token"
run_cmd_start "$ROOT" \
  CATALYST_WEBHOOK_SECRET_FILE="$ROOT/webhook-secret" \
  CATALYST_GITHUB_TOKEN_FILE="$ROOT/github-token"
assert_captured_secret "$ROOT" "whsec_fake_3" "14f: webhook secret still projected beside the token"
assert_captured_token "$ROOT" "FAKE-CTL1612-monitor-file-token-DDDD" \
  "14f: token still projected beside the webhook secret"
rm -rf "$ROOT"

# ─── Test 15: the launchd wrapper no longer projects anything itself ─────────
# CTL-1612 round 3, fix D. The wrapper used to hand-roll its own resolution chain, and
# it ignored CATALYST_WEBHOOK_SECRET_FILE / CATALYST_CONFIG_DIR / CATALYST_LAYER2_CONFIG_FILE
# that cmd_start honors — so a LaunchAgent pointing at a custom path silently got the
# HOME/XDG default instead, and its `$(cat)` exported "" for an empty file, which makes
# webhook-config treat the GitHub route as unconfigured. Two launch paths, ONE projection:
# these are structural greps precisely because "the second copy is gone" is the fix.
# Comments are stripped first — the wrapper documents the removed code in prose, and a
# comment mentioning the old variable must not read as a live assignment (or vice versa).
echo ""
echo "Test 15: launchd wrapper delegates the projection to catalyst-monitor.sh (CTL-1612)"
LAUNCHD_SH="${REPO_ROOT}/plugins/dev/scripts/orch-monitor/dist/catalyst-monitor-launchd.sh"
if [[ ! -f "$LAUNCHD_SH" ]]; then
  fail "15: launchd wrapper missing at $LAUNCHD_SH"
else
  LAUNCHD_CODE="$(grep -vE '^[[:space:]]*(#|$)' "$LAUNCHD_SH")"

  if grep -qE '(^|[[:space:];])(export[[:space:]]+)?CATALYST_WEBHOOK_SECRET=' <<<"$LAUNCHD_CODE"; then
    fail "15a: wrapper still assigns CATALYST_WEBHOOK_SECRET — the duplicate projection is back"
  else
    pass "15a: wrapper contains no CATALYST_WEBHOOK_SECRET assignment"
  fi

  if grep -qE 'webhook-secret|github-token' <<<"$LAUNCHD_CODE"; then
    fail "15b: wrapper still reads a secret file directly (it must defer to the shared chain)"
  else
    pass "15b: wrapper reads no secret file of its own"
  fi

  # The whitespace-corrupting reader must not survive here either (fix B).
  if grep -qE "tr[[:space:]]+-d" <<<"$LAUNCHD_CODE"; then
    fail "15c: wrapper still strips characters with \`tr -d\` (internal whitespace corrupter)"
  else
    pass "15c: wrapper no longer runs the \`tr -d\` secret reader"
  fi

  if grep -qE '^[[:space:]]*exec[[:space:]].*catalyst-monitor\.sh"?[[:space:]]+start' <<<"$LAUNCHD_CODE"; then
    pass "15d: wrapper still execs catalyst-monitor.sh start"
  else
    fail "15d: wrapper no longer execs catalyst-monitor.sh start" \
      && echo "    code lines: $(tr '\n' ' ' <<<"$LAUNCHD_CODE")"
  fi

  # ...and the one surviving projection is cmd_start's, via the shared library.
  MON_CODE="$(grep -vE '^[[:space:]]*(#|$)' "$MONITOR_SH")"
  SRC_COUNT="$(grep -cE '^[[:space:]]*(\.|source)[[:space:]].*lib/catalyst-secret-env\.sh' <<<"$MON_CODE")"
  WH_COUNT="$(grep -cE '^[[:space:]]*catalyst_project_webhook_secret([[:space:]]|$)' <<<"$MON_CODE")"
  GT_COUNT="$(grep -cE '^[[:space:]]*catalyst_project_github_token([[:space:]]|$)' <<<"$MON_CODE")"
  if [[ "$SRC_COUNT" == "1" && "$WH_COUNT" == "1" && "$GT_COUNT" == "1" ]]; then
    pass "15e: catalyst-monitor.sh sources the shared lib once and projects each credential once"
  else
    fail "15e: expected exactly one source + one call per credential" \
      && echo "    source=$SRC_COUNT webhook=$WH_COUNT github=$GT_COUNT"
  fi
fi

# ─── Test 16: CATALYST_LIVENESS_READ_SOURCE=loki skips the app-actor mint ────
# CTL-1612 round 3 (Codex P2 follow-up): the scoped token's ONLY consumer
# (server.ts pollAnchorHeartbeats → readAnchor → readPeerHeartbeatsSync) is
# structurally unreachable when CATALYST_LIVENESS_READ_SOURCE=loki
# (orch-monitor/lib/peer-liveness.mjs readPeerRecords early-returns before
# ever calling readAnchor — see orch-monitor/__tests__/peer-liveness.test.ts
# "explicit loki: trusts an empty result — never reads the retired anchor").
# cmd_start should skip the real mint entirely in that mode (no curl, no
# network), and must NOT skip it for any other value — unset/AUTO or the
# explicit anchor-only "linear" mode — where the anchor can still be read.
#
# Each sub-case installs FAKE (obviously non-real) orchestrator creds plus a
# stub curl that marks a file instead of ever reaching the network, so "was
# the mint code path reached" is asserted via the marker file's presence —
# never via a real request, fake creds or not.
echo ""
echo "Test 16: cmd_start skips the app-actor mint under CATALYST_LIVENESS_READ_SOURCE=loki (CTL-1612 round 3)"

ROOT="$(make_sandbox)"
install_fake_orchestrator_creds_and_curl_stub "$ROOT"
run_cmd_start_capture_stderr "$ROOT" \
  CATALYST_LAYER2_CONFIG_FILE="$ROOT/fake-layer2-config.json" \
  CATALYST_LIVENESS_READ_SOURCE=loki
STDERR_LOKI="$(cat "$ROOT/stderr-captured" 2>/dev/null || echo '(missing)')"
if echo "$STDERR_LOKI" | grep -q "skipping app-actor mint"; then
  pass "16a: loki-only mode logs the skip"
else
  fail "16a: loki-only mode did not log the skip; stderr: $STDERR_LOKI"
fi
if [[ -f "$ROOT/curl-invoked" ]]; then
  fail "16b: loki-only mode still invoked curl (mint attempted despite the skip)"
else
  pass "16b: loki-only mode never invoked curl — mint code path never ran"
fi
rm -rf "$ROOT"

ROOT="$(make_sandbox)"
install_fake_orchestrator_creds_and_curl_stub "$ROOT"
run_cmd_start_capture_stderr "$ROOT" \
  CATALYST_LAYER2_CONFIG_FILE="$ROOT/fake-layer2-config.json"
  # CATALYST_LIVENESS_READ_SOURCE left unset → AUTO
STDERR_AUTO="$(cat "$ROOT/stderr-captured" 2>/dev/null || echo '(missing)')"
if echo "$STDERR_AUTO" | grep -q "skipping app-actor mint"; then
  fail "16c: unset (AUTO) mode incorrectly skipped the mint; stderr: $STDERR_AUTO"
else
  pass "16c: unset (AUTO) mode does not skip the mint"
fi
if [[ -f "$ROOT/curl-invoked" ]]; then
  pass "16d: unset (AUTO) mode invoked curl — mint code path ran"
else
  fail "16d: unset (AUTO) mode never invoked curl; stderr: $STDERR_AUTO"
fi
rm -rf "$ROOT"

ROOT="$(make_sandbox)"
install_fake_orchestrator_creds_and_curl_stub "$ROOT"
run_cmd_start_capture_stderr "$ROOT" \
  CATALYST_LAYER2_CONFIG_FILE="$ROOT/fake-layer2-config.json" \
  CATALYST_LIVENESS_READ_SOURCE=linear
STDERR_LINEAR="$(cat "$ROOT/stderr-captured" 2>/dev/null || echo '(missing)')"
if echo "$STDERR_LINEAR" | grep -q "skipping app-actor mint"; then
  fail "16e: linear (anchor-only) mode incorrectly skipped the mint; stderr: $STDERR_LINEAR"
else
  pass "16e: linear (anchor-only) mode does not skip the mint"
fi
if [[ -f "$ROOT/curl-invoked" ]]; then
  pass "16f: linear (anchor-only) mode invoked curl — mint code path ran"
else
  fail "16f: linear (anchor-only) mode never invoked curl; stderr: $STDERR_LINEAR"
fi
rm -rf "$ROOT"

ROOT="$(make_sandbox)"
install_fake_orchestrator_creds_and_curl_stub "$ROOT"
run_cmd_start_capture_stderr "$ROOT" \
  CATALYST_LAYER2_CONFIG_FILE="$ROOT/fake-layer2-config.json" \
  CATALYST_LIVENESS_READ_SOURCE=" LOKI "
STDERR_UPPER="$(cat "$ROOT/stderr-captured" 2>/dev/null || echo '(missing)')"
if echo "$STDERR_UPPER" | grep -q "skipping app-actor mint"; then
  pass "16g: whitespace + uppercase LOKI is matched case-insensitively (trimmed)"
else
  fail "16g: whitespace/uppercase LOKI was not recognized as loki-only; stderr: $STDERR_UPPER"
fi
if [[ -f "$ROOT/curl-invoked" ]]; then
  fail "16h: whitespace/uppercase LOKI still invoked curl"
else
  pass "16h: whitespace/uppercase LOKI never invoked curl"
fi
rm -rf "$ROOT"

# ─── Test 17: no liveness anchor configured skips the app-actor mint ────────
# CTL-1612 round 5 (Codex P2 follow-up): readAnchor's other precondition —
# alongside "not loki-only" (Test 16) — is a resolvable liveness anchor issue
# (execution-core/config.mjs getLivenessAnchorIssue: CATALYST_LIVENESS_ANCHOR_ISSUE
# env, else catalyst.cluster.livenessAnchorIssue in Layer-2, else null; when
# null, orch-monitor/lib/peer-liveness.mjs readPeerRecords's `!anchorIssue`
# branch means readAnchor is NEVER called, regardless of source). cmd_start
# should skip the mint when NO anchor resolves at all (AUTO or explicit
# "linear"), and must NOT skip when an anchor resolves via EITHER the env
# override or the Layer-2 config key.
echo ""
echo "Test 17: cmd_start skips the app-actor mint when no liveness anchor is configured (CTL-1612 round 5)"

# 17a: orchestrator creds present, but NO anchor anywhere (env unset, Layer-2
# has no cluster.livenessAnchorIssue field at all — the empty-string 2nd arg).
ROOT="$(make_sandbox)"
install_fake_orchestrator_creds_and_curl_stub "$ROOT" ""
run_cmd_start_capture_stderr "$ROOT" \
  CATALYST_LAYER2_CONFIG_FILE="$ROOT/fake-layer2-config.json"
STDERR_NOANCHOR="$(cat "$ROOT/stderr-captured" 2>/dev/null || echo '(missing)')"
if echo "$STDERR_NOANCHOR" | grep -q "no liveness anchor configured"; then
  pass "17a: no-anchor-configured mode logs the skip"
else
  fail "17a: no-anchor-configured mode did not log the skip; stderr: $STDERR_NOANCHOR"
fi
if [[ -f "$ROOT/curl-invoked" ]]; then
  fail "17b: no-anchor-configured mode still invoked curl (mint attempted despite the skip)"
else
  pass "17b: no-anchor-configured mode never invoked curl — mint code path never ran"
fi
rm -rf "$ROOT"

# 17c: anchor resolved via CATALYST_LIVENESS_ANCHOR_ISSUE env (Layer-2 has no
# anchor field — proves the env leg alone is sufficient to unblock the mint).
ROOT="$(make_sandbox)"
install_fake_orchestrator_creds_and_curl_stub "$ROOT" ""
run_cmd_start_capture_stderr "$ROOT" \
  CATALYST_LAYER2_CONFIG_FILE="$ROOT/fake-layer2-config.json" \
  CATALYST_LIVENESS_ANCHOR_ISSUE="CTL-1234-env-anchor"
STDERR_ENVANCHOR="$(cat "$ROOT/stderr-captured" 2>/dev/null || echo '(missing)')"
if echo "$STDERR_ENVANCHOR" | grep -q "no liveness anchor configured"; then
  fail "17d: env-provided anchor incorrectly skipped the mint; stderr: $STDERR_ENVANCHOR"
else
  pass "17d: env-provided anchor (CATALYST_LIVENESS_ANCHOR_ISSUE) does not skip the mint"
fi
if [[ -f "$ROOT/curl-invoked" ]]; then
  pass "17e: env-provided anchor invoked curl — mint code path ran"
else
  fail "17e: env-provided anchor never invoked curl; stderr: $STDERR_ENVANCHOR"
fi
rm -rf "$ROOT"

# 17f: anchor resolved via Layer-2 catalyst.cluster.livenessAnchorIssue (env
# unset — proves the Layer-2 leg alone is sufficient to unblock the mint).
# install_fake_orchestrator_creds_and_curl_stub's default 2nd-arg behavior
# already embeds a fake Layer-2 anchor, so this is the plain default call.
ROOT="$(make_sandbox)"
install_fake_orchestrator_creds_and_curl_stub "$ROOT"
run_cmd_start_capture_stderr "$ROOT" \
  CATALYST_LAYER2_CONFIG_FILE="$ROOT/fake-layer2-config.json"
STDERR_L2ANCHOR="$(cat "$ROOT/stderr-captured" 2>/dev/null || echo '(missing)')"
if echo "$STDERR_L2ANCHOR" | grep -q "no liveness anchor configured"; then
  fail "17g: Layer-2-provided anchor incorrectly skipped the mint; stderr: $STDERR_L2ANCHOR"
else
  pass "17g: Layer-2-provided anchor (catalyst.cluster.livenessAnchorIssue) does not skip the mint"
fi
if [[ -f "$ROOT/curl-invoked" ]]; then
  pass "17h: Layer-2-provided anchor invoked curl — mint code path ran"
else
  fail "17h: Layer-2-provided anchor never invoked curl; stderr: $STDERR_L2ANCHOR"
fi
rm -rf "$ROOT"

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "Results: $PASSES passed, $FAILURES failed"
[[ $FAILURES -eq 0 ]]
