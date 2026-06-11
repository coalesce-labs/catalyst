#!/usr/bin/env bash
# Tests for the check-setup.sh interactive-shell proxy-leak detection (CTL-869,
# CTL-846 regression class).
#
# The mitmproxy HTTP(S)_PROXY in execution-core.env is meant to be DAEMON-launch-
# scoped only (catalyst-execution-core sources it right before nohup'ing the
# daemon). If a shell profile sources that env file — or exports HTTP(S)_PROXY
# directly — the proxy leaks into every interactive shell and fresh terminals get
# "connection refused" when mitmproxy is down. check-setup.sh must DETECT that
# leak and print the exact one-line removal.
#
# Strategy: point HOME at a scratch dir so we fully control the shell profiles the
# check reads, and point XDG_CONFIG_HOME at a scratch dir holding a fixture
# execution-core.env. env -i gives a clean (no live proxy) base environment.
#
# Run: bash plugins/dev/scripts/__tests__/check-setup-proxy-leak.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SCRIPT="${REPO_ROOT}/plugins/dev/scripts/check-setup.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

assert_grep() {
  local label="$1" output="$2" pattern="$3"
  if grep -qF -- "$pattern" <<<"$output"; then
    PASSES=$((PASSES + 1)); echo "  PASS: $label"
  else
    FAILURES=$((FAILURES + 1)); echo "  FAIL: $label"
    echo "    expected substring: $pattern"
    echo "    actual output (proxy-leak section):"
    echo "$output" | grep -iA2 -E 'proxy leak|interactive shell' | head -20 | sed 's/^/      /'
  fi
}

assert_not_grep() {
  local label="$1" output="$2" pattern="$3"
  if grep -qF -- "$pattern" <<<"$output"; then
    FAILURES=$((FAILURES + 1)); echo "  FAIL: $label (unexpected pattern found)"
    echo "    unexpected substring: $pattern"
  else
    PASSES=$((PASSES + 1)); echo "  PASS: $label"
  fi
}

# make_home <home-dir> — minimal HOME with a daemon env file that configures the
# proxy (so de_proxy is populated for the "leaks ... into all terminals" message)
# and a global config.json so check-setup.sh's earlier jq reads don't trip set -e.
make_home() {
  local home="$1"
  mkdir -p "${home}/.config/catalyst"
  cat > "${home}/.config/catalyst/execution-core.env" <<'EOF'
export NODE_USE_ENV_PROXY=1
export HTTPS_PROXY=http://127.0.0.1:8080
export HTTP_PROXY=http://127.0.0.1:8080
export NODE_EXTRA_CA_CERTS=/nonexistent/ca.pem
EOF
  # check-setup.sh runs `jq ... "$CATALYST_CONFIG/config.json"` under set -e in
  # its Linear-Git-Automation section; an absent file makes jq exit non-zero and
  # aborts the script BEFORE the proxy-leak section. A minimal valid JSON keeps it
  # going to section 7d (the section under test).
  echo '{"catalyst":{}}' > "${home}/.config/catalyst/config.json"
}

# make_project <dir> — minimal .catalyst/config.json so check-setup.sh runs.
make_project() {
  local dir="$1"
  mkdir -p "${dir}/.catalyst"
  cat > "${dir}/.catalyst/config.json" <<EOF
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

# run_script <project-dir> <home-dir> — run check-setup.sh with a controlled HOME
# (its shell profiles + daemon env) and a clean env (env -i → no live proxy
# inherited). The PATH is inherited from the caller so docker/curl/jq resolve as
# they do on a real machine; only HOME + XDG point at the scratch fixture.
run_script() {
  local cwd="$1" home="$2"
  ( cd "$cwd" \
    && env -i HOME="$home" PATH="$PATH" \
       XDG_CONFIG_HOME="${home}/.config" CATALYST_AUTONOMOUS=1 \
       bash "$SCRIPT" 2>&1 || true )
}

echo "check-setup.sh interactive-shell proxy-leak tests (CTL-869)"

# ─── Test 1: clean profiles → pass, no leak reported ─────────────────────────
P1="${SCRATCH}/p1"; H1="${SCRATCH}/h1"
make_project "$P1"; make_home "$H1"
cat > "${H1}/.zshrc" <<'EOF'
# clean profile, no proxy, no daemon-env source
export EDITOR=vim
EOF
OUT1="$(run_script "$P1" "$H1")"
assert_grep "clean profile passes leak check" "$OUT1" "No proxy leak into interactive shells"
assert_not_grep "clean profile has no fail" "$OUT1" "sources the DAEMON-only env file"

# ─── Test 2: .zshrc sources execution-core.env → leak detected + removal shown ─
P2="${SCRATCH}/p2"; H2="${SCRATCH}/h2"
make_project "$P2"; make_home "$H2"
cat > "${H2}/.zshrc" <<EOF
export EDITOR=vim
source "\$HOME/.config/catalyst/execution-core.env"
EOF
OUT2="$(run_script "$P2" "$H2")"
assert_grep "source-of-daemon-env detected" "$OUT2" "sources the DAEMON-only env file into every interactive shell"
assert_grep "removal instruction shown" "$OUT2" "REMOVE this line from"
assert_grep "regression-class named" "$OUT2" "CTL-846 regression class"
assert_not_grep "not reported clean" "$OUT2" "No proxy leak into interactive shells"

# ─── Test 3: commented-out source line → NOT flagged ─────────────────────────
P3="${SCRATCH}/p3"; H3="${SCRATCH}/h3"
make_project "$P3"; make_home "$H3"
cat > "${H3}/.zshrc" <<EOF
# source "\$HOME/.config/catalyst/execution-core.env"   # disabled, daemon does it
export EDITOR=vim
EOF
OUT3="$(run_script "$P3" "$H3")"
assert_grep "commented source passes" "$OUT3" "No proxy leak into interactive shells"
assert_not_grep "commented source not flagged" "$OUT3" "sources the DAEMON-only env file"

# ─── Test 4: profile exports HTTPS_PROXY directly → leak detected ─────────────
P4="${SCRATCH}/p4"; H4="${SCRATCH}/h4"
make_project "$P4"; make_home "$H4"
cat > "${H4}/.zshenv" <<'EOF'
export HTTPS_PROXY=http://127.0.0.1:8080
EOF
echo 'export EDITOR=vim' > "${H4}/.zshrc"
OUT4="$(run_script "$P4" "$H4")"
assert_grep "direct proxy export detected" "$OUT4" "exports a proxy var into every interactive shell"
assert_grep "direct export removal shown" "$OUT4" "REMOVE:"

# ─── Test 5: live shell already has the proxy set → flagged ───────────────────
P5="${SCRATCH}/p5"; H5="${SCRATCH}/h5"
make_project "$P5"; make_home "$H5"
echo 'export EDITOR=vim' > "${H5}/.zshrc"
OUT5="$(
  cd "$P5" \
  && env -i HOME="$H5" PATH="$PATH" \
     XDG_CONFIG_HOME="${H5}/.config" CATALYST_AUTONOMOUS=1 \
     HTTPS_PROXY="http://127.0.0.1:8080" \
     bash "$SCRIPT" 2>&1 || true
)"
assert_grep "live proxy in shell flagged" "$OUT5" "HTTP(S)_PROXY is set in THIS shell"

# ─── Test 7: live shell has a NON-catalyst (e.g. corporate) proxy → no hard fail
# A developer behind a legitimate corporate proxy must NOT get a false-positive
# hard failure (which would flip the whole health check non-zero) nor an untrue
# "routes through mitmproxy" claim. check (c) must only hard-fail when the live
# proxy matches the catalyst mitmproxy (de_proxy / the conventional :8080
# host:port); an unrelated proxy gets an informational note only. (CTL-869)
P7="${SCRATCH}/p7"; H7="${SCRATCH}/h7"
make_project "$P7"; make_home "$H7"
echo 'export EDITOR=vim' > "${H7}/.zshrc"
OUT7="$(
  cd "$P7" \
  && env -i HOME="$H7" PATH="$PATH" \
     XDG_CONFIG_HOME="${H7}/.config" CATALYST_AUTONOMOUS=1 \
     HTTPS_PROXY="http://corp-proxy.example.com:3128" \
     bash "$SCRIPT" 2>&1 || true
)"
# It MUST NOT hard-fail check (c) on the non-catalyst proxy...
assert_not_grep "non-catalyst proxy not hard-failed" "$OUT7" "HTTP(S)_PROXY is set in THIS shell"
# ...and MUST NOT make the untrue "routes through mitmproxy" claim about it.
assert_not_grep "no false mitmproxy claim for corp proxy" "$OUT7" "route through the catalyst mitmproxy"
# It still surfaces the proxy as an informational note (so a down catalyst proxy
# under a non-default address is not silently ignored).
assert_grep "non-catalyst proxy noted informationally" "$OUT7" "A proxy is set in this shell"

# ─── Test 6: profile sources env file but daemon env file absent → no set -u crash
# de_proxy is only populated in check-setup.sh's section 7c when the daemon env
# file exists; the leak section must still run (and detect the source line)
# without tripping `set -u` when it is absent.
P6="${SCRATCH}/p6"; H6="${SCRATCH}/h6"
make_project "$P6"
mkdir -p "${H6}/.config/catalyst"
# Global config.json present (so the earlier jq read doesn't abort), but NO
# execution-core.env file.
echo '{"catalyst":{}}' > "${H6}/.config/catalyst/config.json"
cat > "${H6}/.zshrc" <<EOF
source "\$HOME/.config/catalyst/execution-core.env"
EOF
OUT6="$(run_script "$P6" "$H6")"
assert_grep "absent-env source still detected" "$OUT6" "sources the DAEMON-only env file"
assert_not_grep "no set -u unbound-var crash" "$OUT6" "unbound variable"

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "Results: $PASSES passed, $FAILURES failed"
[[ $FAILURES -eq 0 ]] || exit 1
