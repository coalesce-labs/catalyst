#!/usr/bin/env bash
# CTL-1000: catalyst-stack and its siblings resolve from one source. Static +
# behavioral guards that the generated wrapper template has the force-cache
# override, sources NEITHER copy of plugin-dirs.sh (no chicken-and-egg), and
# that stack + a sibling agree on the resolved source so there is never a
# mixed-source stack. Plus: ONE warning per top-level invocation across a
# parent→sibling exec chain.
# Run: bash plugins/dev/scripts/__tests__/install-cli-stack-consistency.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
INSTALL_CLI="${REPO_ROOT}/plugins/dev/scripts/install-cli.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

GITC="git -c user.email=t@t -c user.name=t -c commit.gpgsign=false -c init.defaultBranch=main"

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

# seed_cache HOME — cache version dir with stubs for catalyst-stack +
# catalyst-broker that print FROM-CACHE-<name>; --version handled by wrapper.
seed_cache() {
  local home="$1" ver="$2"
  local cache="${home}/.claude/plugins/cache/catalyst/catalyst-dev/${ver}/scripts"
  mkdir -p "$cache"
  local f
  for f in catalyst-stack catalyst-broker; do
    cat > "${cache}/${f}" <<CLI
#!/usr/bin/env bash
echo "FROM-CACHE-${f}"
CLI
    chmod +x "${cache}/${f}"
  done
  printf '%s' "$cache"
}

# make_checkout BASE — standalone clean main checkout with stack + broker stubs
# printing FROM-CHECKOUT-<name>. Sets FIX_CHECKOUT, FIX_PD.
make_checkout() {
  local base="$1"
  mkdir -p "${base}"
  $GITC -C "${base}" init -q
  mkdir -p "${base}/plugins/dev/.claude-plugin" "${base}/plugins/dev/scripts"
  echo '{"name":"catalyst-dev","version":"1.0.0"}' \
    > "${base}/plugins/dev/.claude-plugin/plugin.json"
  echo "1.0.0" > "${base}/plugins/dev/version.txt"
  local f
  for f in catalyst-stack catalyst-broker; do
    cat > "${base}/plugins/dev/scripts/${f}" <<CLI
#!/usr/bin/env bash
echo "FROM-CHECKOUT-${f}"
CLI
    chmod +x "${base}/plugins/dev/scripts/${f}"
  done
  $GITC -C "${base}" add -A
  $GITC -C "${base}" commit -qm "initial"
  FIX_CHECKOUT="${base}"
  FIX_PD="${base}/plugins/dev"
}

install_wrappers() {
  local home="$1" cache="$2"
  HOME="$home" CATALYST_CLI_SOURCE="$cache" \
    CATALYST_BIN_DIR="${home}/.catalyst/bin" \
    bash "$INSTALL_CLI" >/dev/null 2>&1
}

echo "install-cli stack-consistency (CTL-1000) tests"

# ── C1: static — template carries the force-cache override token ────────────
run "C1 template references CATALYST_FORCE_CACHE" bash -c "
  grep -qF 'CATALYST_FORCE_CACHE' '$INSTALL_CLI'
"

# ── C2: static — generated wrapper sources NEITHER copy of plugin-dirs.sh ────
HC2="$SCRATCH/hc2"; mkdir -p "$HC2"
CC2="$(seed_cache "$HC2" 9.0.0)"
# add a catalyst-events stub to the cache so the events wrapper installs
cat > "${CC2}/catalyst-events" <<'CLI'
#!/usr/bin/env bash
echo "FROM-CACHE-events"
CLI
chmod +x "${CC2}/catalyst-events"
install_wrappers "$HC2" "$CC2"
run "C2 generated wrapper does NOT source plugin-dirs.sh" bash -c "
  ! grep -qF 'plugin-dirs.sh' '$HC2/.catalyst/bin/catalyst-events'
"

# ── C3: stack + sibling agree on source (both resolve checkout, same root) ──
HC3="$SCRATCH/hc3"; mkdir -p "$HC3"
CC3="$(seed_cache "$HC3" 9.0.0)"
make_checkout "$SCRATCH/co3"
PD3="$FIX_PD"; ROOT3="$FIX_CHECKOUT"
install_wrappers "$HC3" "$CC3"
run "C3 stack + broker both report source: checkout w/ same root" bash -c "
  vs=\$(HOME='$HC3' CATALYST_PLUGIN_DIRS='$PD3' '$HC3/.catalyst/bin/catalyst-stack' --version 2>&1)
  vb=\$(HOME='$HC3' CATALYST_PLUGIN_DIRS='$PD3' '$HC3/.catalyst/bin/catalyst-broker' --version 2>&1)
  echo \"\$vs\" | grep -qF 'source: checkout' || { echo \"stack: \$vs\"; exit 1; }
  echo \"\$vb\" | grep -qF 'source: checkout' || { echo \"broker: \$vb\"; exit 1; }
  echo \"\$vs\" | grep -qF '$ROOT3' || { echo \"stack root: \$vs\"; exit 1; }
  echo \"\$vb\" | grep -qF '$ROOT3' || { echo \"broker root: \$vb\"; exit 1; }
"

# ── C4: ONE warning per top-level invocation across parent→sibling exec ─────
# Unhealthy (off-main) checkout. A tiny harness models catalyst-stack invoking
# a sibling by bare name through PATH: the parent wrapper warns once and exports
# CATALYST_WRAPPER_WARNED; the child (catalyst-broker) must NOT warn again.
HC4="$SCRATCH/hc4"; mkdir -p "$HC4"
CC4="$(seed_cache "$HC4" 9.0.0)"
make_checkout "$SCRATCH/co4"
$GITC -C "$FIX_CHECKOUT" checkout -q -b feature
PD4="$FIX_PD"
install_wrappers "$HC4" "$CC4"
# Replace the cache catalyst-stack stub with one that itself calls the sibling
# broker wrapper by bare name (PATH dispatch), mirroring real catalyst-stack.
cat > "${CC4}/catalyst-stack" <<CLI
#!/usr/bin/env bash
echo "FROM-CACHE-catalyst-stack"
catalyst-broker start
CLI
chmod +x "${CC4}/catalyst-stack"
# And a cache broker stub that prints a recognizable line on 'start'.
cat > "${CC4}/catalyst-broker" <<'CLI'
#!/usr/bin/env bash
echo "BROKER-START"
CLI
chmod +x "${CC4}/catalyst-broker"
run "C4 one WARN per top-level invocation across sibling exec" bash -c "
  export PATH='$HC4/.catalyst/bin:'\"\$PATH\"
  out=\$(HOME='$HC4' CATALYST_PLUGIN_DIRS='$PD4' \
        '$HC4/.catalyst/bin/catalyst-stack' 2>'$SCRATCH/c4.err')
  echo \"\$out\" | grep -qF 'BROKER-START' || { echo \"stdout=\$out\"; cat '$SCRATCH/c4.err'; exit 1; }
  c=\$(grep -c 'WARN' '$SCRATCH/c4.err' || true)
  [[ \"\$c\" == '1' ]] || { echo \"WARN count=\$c\"; cat '$SCRATCH/c4.err'; exit 1; }
"

# ── Summary ─────────────────────────────────────────────────────────────────
echo ""
TOTAL=$((PASSES + FAILURES))
echo "install-cli-stack-consistency: $PASSES/$TOTAL passed, $FAILURES failed"
exit "$FAILURES"
