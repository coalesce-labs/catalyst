#!/usr/bin/env bash
# Tests for setup-catalyst.sh installer helpers (CTL-844).
# Covers: source guard, detect_os, detect_arch (+fallback), ensure_local_bin,
#         shell-aware PATH persistence (zsh/bash/unknown), offer_install_jq
#         (+corrupted download), offer_install_node (macOS + Linux x64 +
#         corrupted extract), offer_install_bun (+failure path),
#         offer_install_humanlayer (+stale shim), offer_install_gh_cli
#         (macOS zip + Linux tar.gz + unzip guard + brew-failure notice),
#         and the no-pip repo-wide regression guard.
#
# Run: bash plugins/dev/scripts/__tests__/setup-catalyst-installers.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SETUP="${REPO_ROOT}/setup-catalyst.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

assert_eq() {
  local label="$1" actual="$2" expected="$3"
  if [[ "$actual" == "$expected" ]]; then
    PASSES=$((PASSES + 1))
    echo "  PASS: $label"
  else
    FAILURES=$((FAILURES + 1))
    echo "  FAIL: $label"
    echo "    expected: $expected"
    echo "    actual:   $actual"
  fi
}

assert_grep() {
  local label="$1" output="$2" pattern="$3"
  if grep -qF -- "$pattern" <<<"$output"; then
    PASSES=$((PASSES + 1))
    echo "  PASS: $label"
  else
    FAILURES=$((FAILURES + 1))
    echo "  FAIL: $label"
    echo "    expected substring: $pattern"
    echo "    actual output:"
    echo "$output" | head -20 | sed 's/^/      /'
  fi
}

assert_not_grep() {
  local label="$1" output="$2" pattern="$3"
  if grep -qF -- "$pattern" <<<"$output"; then
    FAILURES=$((FAILURES + 1))
    echo "  FAIL: $label (unexpected pattern found)"
    echo "    unexpected substring: $pattern"
  else
    PASSES=$((PASSES + 1))
    echo "  PASS: $label"
  fi
}

assert_file_exists() {
  local label="$1" path="$2"
  if [[ -e "$path" ]]; then
    PASSES=$((PASSES + 1))
    echo "  PASS: $label"
  else
    FAILURES=$((FAILURES + 1))
    echo "  FAIL: $label (file not found: $path)"
  fi
}

assert_executable() {
  local label="$1" path="$2"
  if [[ -x "$path" ]]; then
    PASSES=$((PASSES + 1))
    echo "  PASS: $label"
  else
    FAILURES=$((FAILURES + 1))
    echo "  FAIL: $label (not executable: $path)"
  fi
}

# Helper: run a function from setup-catalyst.sh in a sandboxed subshell.
# SHELL is pinned (default zsh) because persist_path_line picks rc files from
# it; override per-test with TEST_SHELL=/bin/bash to exercise the bash branch.
run_sourced() {
  local cmd="$1"
  local stub_dir="${2:-$SCRATCH/stubs}"
  local home_dir="${3:-$SCRATCH/home}"
  mkdir -p "$stub_dir" "$home_dir"
  (
    HOME="$home_dir"
    PATH="$stub_dir:/usr/bin:/bin"
    SHELL="${TEST_SHELL:-/bin/zsh}"
    export HOME PATH SHELL
    # shellcheck source=/dev/null
    source "$SETUP"
    eval "$cmd"
  )
}

fresh_dirs() {
  rm -rf "$SCRATCH/home" "$SCRATCH/stubs"
  mkdir -p "$SCRATCH/home" "$SCRATCH/stubs"
}

# ─── Phase 1: Source guard ───────────────────────────────────────────────────

echo ""
echo "=== Phase 1: Source guard ==="

fresh_dirs
SOURCE_OUT=$(HOME="$SCRATCH/home" PATH="$SCRATCH/stubs:/usr/bin:/bin" bash -c "source '$SETUP'; true" 2>&1)
assert_not_grep "sourcing does not run main (no Checking Prerequisites)" "$SOURCE_OUT" "Checking Prerequisites"
assert_not_grep "sourcing does not prompt the user" "$SOURCE_OUT" "GitHub"

# Piped execution (curl ... | bash) MUST run main: BASH_SOURCE[0] is empty in
# that mode, so a plain `BASH_SOURCE[0] == $0` guard silently no-ops the
# documented one-line install. A DEBUG trap intercepts the guard's `main "$@"`
# call and exits before main's body runs, keeping the test side-effect free.
PIPE_OUT=$( { echo 'trap '"'"'case "$BASH_COMMAND" in main\ *|main) echo MAIN_INVOKED; exit 0;; esac'"'"' DEBUG'; cat "$SETUP"; } \
  | HOME="$SCRATCH/home" PATH="$SCRATCH/stubs:/usr/bin:/bin" bash 2>&1 )
assert_grep "piped execution (curl|bash) invokes main" "$PIPE_OUT" "MAIN_INVOKED"

# ─── Phase 1: detect_arch ────────────────────────────────────────────────────

echo ""
echo "=== Phase 1: detect_arch ==="

fresh_dirs
cat > "$SCRATCH/stubs/uname" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == "-m" ]]; then echo "arm64"; else /usr/bin/uname "$@"; fi
EOF
chmod +x "$SCRATCH/stubs/uname"
OUT=$(run_sourced "detect_arch")
assert_eq "arm64 maps to arm64" "$OUT" "arm64"

fresh_dirs
cat > "$SCRATCH/stubs/uname" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == "-m" ]]; then echo "aarch64"; else /usr/bin/uname "$@"; fi
EOF
chmod +x "$SCRATCH/stubs/uname"
OUT=$(run_sourced "detect_arch")
assert_eq "aarch64 maps to arm64" "$OUT" "arm64"

fresh_dirs
cat > "$SCRATCH/stubs/uname" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == "-m" ]]; then echo "x86_64"; else /usr/bin/uname "$@"; fi
EOF
chmod +x "$SCRATCH/stubs/uname"
OUT=$(run_sourced "detect_arch")
assert_eq "x86_64 maps to amd64" "$OUT" "amd64"

# ─── Phase 1: ensure_local_bin ───────────────────────────────────────────────

echo ""
echo "=== Phase 1: ensure_local_bin ==="

fresh_dirs
run_sourced "ensure_local_bin"
assert_file_exists "ensure_local_bin creates ~/.local/bin" "$SCRATCH/home/.local/bin"
ZSHENV_CONTENT=$(cat "$SCRATCH/home/.zshenv" 2>/dev/null || true)
assert_grep "ensure_local_bin writes PATH export to ~/.zshenv" "$ZSHENV_CONTENT" '.local/bin'
assert_not_grep "ensure_local_bin does not touch ~/.zshrc" "$(cat "$SCRATCH/home/.zshrc" 2>/dev/null || echo '')" '.local/bin'

run_sourced "ensure_local_bin; ensure_local_bin"
ZSHENV_CONTENT=$(cat "$SCRATCH/home/.zshenv" 2>/dev/null || true)
LINE_COUNT=$(grep -c '.local/bin' <<<"$ZSHENV_CONTENT" || true)
assert_eq "ensure_local_bin is idempotent (PATH line written exactly once)" "$LINE_COUNT" "1"

# ─── Phase 1: offer_install_jq (no-sudo binary fallback) ─────────────────────

echo ""
echo "=== Phase 1: offer_install_jq (binary fallback) ==="

fresh_dirs
CURL_LOG="$SCRATCH/curl.log"
cat > "$SCRATCH/stubs/curl" <<EOF
#!/usr/bin/env bash
echo "\$@" >> "$CURL_LOG"
prev=""
for arg in "\$@"; do
  if [[ "\$prev" == "-o" ]]; then
    echo '#!/bin/sh' > "\$arg"
    echo 'echo "jq stub 1.7"' >> "\$arg"
    chmod +x "\$arg"
  fi
  prev="\$arg"
done
exit 0
EOF
chmod +x "$SCRATCH/stubs/curl"
cat > "$SCRATCH/stubs/uname" <<'EOF'
#!/usr/bin/env bash
case "$1" in -s) echo "Darwin";; -m) echo "arm64";; *) /usr/bin/uname "$@";; esac
EOF
chmod +x "$SCRATCH/stubs/uname"

RESULT=$(echo "y" | run_sourced "offer_install_jq; echo exit:\$?" "$SCRATCH/stubs" "$SCRATCH/home")
CURL_ARGS=$(cat "$CURL_LOG" 2>/dev/null || true)
assert_grep "offer_install_jq hits jqlang releases URL" "$CURL_ARGS" "jqlang/jq/releases"
assert_grep "offer_install_jq downloads macos-arm64 artifact" "$CURL_ARGS" "jq-macos-arm64"
assert_executable "offer_install_jq installs executable to ~/.local/bin/jq" "$SCRATCH/home/.local/bin/jq"
assert_grep "offer_install_jq returns 0" "$RESULT" "exit:0"

# brew-first: curl should NOT be called when brew is present
fresh_dirs
CURL_LOG2="$SCRATCH/curl2.log"
cat > "$SCRATCH/stubs/curl" <<EOF
#!/usr/bin/env bash
echo "\$@" >> "$CURL_LOG2"
exit 0
EOF
chmod +x "$SCRATCH/stubs/curl"
cat > "$SCRATCH/stubs/brew" <<'EOF'
#!/usr/bin/env bash
echo "brew $*"
exit 0
EOF
chmod +x "$SCRATCH/stubs/brew"
cat > "$SCRATCH/stubs/jq" <<'EOF'
#!/usr/bin/env bash
echo "jq-1.7-stub"
EOF
chmod +x "$SCRATCH/stubs/jq"

BREW_OUT=$(echo "y" | run_sourced "offer_install_jq" "$SCRATCH/stubs" "$SCRATCH/home" 2>&1 || true)
assert_grep "offer_install_jq prefers brew when available" "$BREW_OUT" "brew"
assert_eq "curl NOT called when brew is available" "$(cat "$CURL_LOG2" 2>/dev/null || echo '')" ""

# ─── Phase 2: offer_install_node ─────────────────────────────────────────────

echo ""
echo "=== Phase 2: offer_install_node ==="

fresh_dirs
NODE_CURL_LOG="$SCRATCH/node-curl.log"
cat > "$SCRATCH/stubs/uname" <<'EOF'
#!/usr/bin/env bash
case "$1" in -s) echo "Darwin";; -m) echo "arm64";; *) /usr/bin/uname "$@";; esac
EOF
chmod +x "$SCRATCH/stubs/uname"
cat > "$SCRATCH/stubs/jq" <<'EOF'
#!/usr/bin/env bash
echo "v22.13.0"
EOF
chmod +x "$SCRATCH/stubs/jq"
cat > "$SCRATCH/stubs/curl" <<EOF
#!/usr/bin/env bash
echo "\$@" >> "$NODE_CURL_LOG"
exit 0
EOF
chmod +x "$SCRATCH/stubs/curl"
cat > "$SCRATCH/stubs/tar" <<EOF
#!/usr/bin/env bash
prev=""
for arg in "\$@"; do
  if [[ "\$prev" == "-C" ]]; then
    mkdir -p "\$arg/node-v22.13.0-darwin-arm64/bin"
    echo '#!/bin/sh' > "\$arg/node-v22.13.0-darwin-arm64/bin/node"
    echo 'echo "v22.13.0"' >> "\$arg/node-v22.13.0-darwin-arm64/bin/node"
    chmod +x "\$arg/node-v22.13.0-darwin-arm64/bin/node"
    echo '#!/bin/sh' > "\$arg/node-v22.13.0-darwin-arm64/bin/npm"
    chmod +x "\$arg/node-v22.13.0-darwin-arm64/bin/npm"
    echo '#!/bin/sh' > "\$arg/node-v22.13.0-darwin-arm64/bin/npx"
    chmod +x "\$arg/node-v22.13.0-darwin-arm64/bin/npx"
    break
  fi
  prev="\$arg"
done
exit 0
EOF
chmod +x "$SCRATCH/stubs/tar"

NODE_OUT=$(echo "y" | run_sourced "offer_install_node; echo exit:\$?" "$SCRATCH/stubs" "$SCRATCH/home" 2>&1 || true)
NODE_CURL_ARGS=$(cat "$NODE_CURL_LOG" 2>/dev/null || true)
assert_grep "offer_install_node fetches nodejs.org index" "$NODE_CURL_ARGS" "nodejs.org"
assert_grep "offer_install_node downloads darwin-arm64 tarball" "$NODE_CURL_ARGS" "darwin-arm64"
assert_file_exists "offer_install_node creates ~/.local/node" "$SCRATCH/home/.local/node"
assert_executable "offer_install_node creates ~/.local/bin/node symlink" "$SCRATCH/home/.local/bin/node"
assert_executable "offer_install_node creates ~/.local/bin/npm symlink" "$SCRATCH/home/.local/bin/npm"
assert_executable "offer_install_node creates ~/.local/bin/npx symlink" "$SCRATCH/home/.local/bin/npx"
assert_grep "offer_install_node returns 0" "$NODE_OUT" "exit:0"

# CATALYST_NODE_VERSION override: index.json must NOT be fetched
fresh_dirs
PIN_CURL_LOG="$SCRATCH/pin-curl.log"
cat > "$SCRATCH/stubs/curl" <<EOF
#!/usr/bin/env bash
echo "\$@" >> "$PIN_CURL_LOG"
exit 0
EOF
chmod +x "$SCRATCH/stubs/curl"
cat > "$SCRATCH/stubs/uname" <<'EOF'
#!/usr/bin/env bash
case "$1" in -s) echo "Darwin";; -m) echo "arm64";; *) /usr/bin/uname "$@";; esac
EOF
chmod +x "$SCRATCH/stubs/uname"
cat > "$SCRATCH/stubs/tar" <<EOF
#!/usr/bin/env bash
prev=""
for arg in "\$@"; do
  if [[ "\$prev" == "-C" ]]; then
    mkdir -p "\$arg/node-v20.11.0-darwin-arm64/bin"
    touch "\$arg/node-v20.11.0-darwin-arm64/bin/node"
    touch "\$arg/node-v20.11.0-darwin-arm64/bin/npm"
    touch "\$arg/node-v20.11.0-darwin-arm64/bin/npx"
    chmod +x "\$arg/node-v20.11.0-darwin-arm64/bin/"*
    break
  fi
  prev="\$arg"
done
exit 0
EOF
chmod +x "$SCRATCH/stubs/tar"

echo "y" | CATALYST_NODE_VERSION="v20.11.0" run_sourced "offer_install_node" "$SCRATCH/stubs" "$SCRATCH/home" >/dev/null 2>&1 || true
PIN_CURL_ARGS=$(cat "$PIN_CURL_LOG" 2>/dev/null || true)
assert_not_grep "CATALYST_NODE_VERSION skips index.json fetch" "$PIN_CURL_ARGS" "index.json"
assert_grep "CATALYST_NODE_VERSION uses pinned version URL" "$PIN_CURL_ARGS" "v20.11.0"

# ─── Phase 3: offer_install_bun ──────────────────────────────────────────────

echo ""
echo "=== Phase 3: offer_install_bun ==="

fresh_dirs
BUN_CURL_LOG="$SCRATCH/bun-curl.log"

# NOTE: outer heredoc uses OUTEREOF so the inner installer script's $HOME
# stays as a literal variable reference (not expanded to the real home).
cat > "$SCRATCH/stubs/curl" <<OUTEREOF
#!/usr/bin/env bash
echo "\$@" >> "$BUN_CURL_LOG"
cat <<'EOF'
#!/bin/sh
mkdir -p "\$HOME/.bun/bin"
echo '#!/bin/sh' > "\$HOME/.bun/bin/bun"
echo 'echo 1.1.20' >> "\$HOME/.bun/bin/bun"
chmod +x "\$HOME/.bun/bin/bun"
EOF
OUTEREOF
chmod +x "$SCRATCH/stubs/curl"

BUN_OUT=$(echo "y" | run_sourced "offer_install_bun; echo exit:\$?" "$SCRATCH/stubs" "$SCRATCH/home" 2>&1 || true)
BUN_CURL_ARGS=$(cat "$BUN_CURL_LOG" 2>/dev/null || true)
assert_grep "offer_install_bun calls bun.sh install URL" "$BUN_CURL_ARGS" "bun.sh/install"
ZSHENV_BUN=$(cat "$SCRATCH/home/.zshenv" 2>/dev/null || true)
assert_grep "offer_install_bun persists .bun/bin to ~/.zshenv" "$ZSHENV_BUN" ".bun/bin"
assert_grep "offer_install_bun returns 0" "$BUN_OUT" "exit:0"

# Idempotency for ~/.bun/bin PATH line
echo "y" | run_sourced "offer_install_bun; offer_install_bun" "$SCRATCH/stubs" "$SCRATCH/home" >/dev/null 2>&1 || true
BUN_ZSHENV=$(cat "$SCRATCH/home/.zshenv" 2>/dev/null || true)
BUN_LINE_COUNT=$(grep -c '.bun/bin' <<<"$BUN_ZSHENV" || true)
assert_eq "offer_install_bun PATH line idempotent" "$BUN_LINE_COUNT" "1"

# ─── Phase 4: offer_install_humanlayer (npm, not pip) ────────────────────────

echo ""
echo "=== Phase 4: offer_install_humanlayer (npm) ==="

fresh_dirs
NPM_LOG="$SCRATCH/npm.log"
PIP_LOG="$SCRATCH/pip.log"

cat > "$SCRATCH/stubs/npm" <<EOF
#!/usr/bin/env bash
echo "\$@" >> "$NPM_LOG"
mkdir -p "$SCRATCH/stubs"
echo '#!/bin/sh' > "$SCRATCH/stubs/humanlayer"
echo 'echo "humanlayer 0.17.2"' >> "$SCRATCH/stubs/humanlayer"
chmod +x "$SCRATCH/stubs/humanlayer"
exit 0
EOF
chmod +x "$SCRATCH/stubs/npm"

cat > "$SCRATCH/stubs/pip" <<EOF
#!/usr/bin/env bash
echo "\$@" >> "$PIP_LOG"
exit 0
EOF
chmod +x "$SCRATCH/stubs/pip"

HL_OUT=$(echo "y" | run_sourced "offer_install_humanlayer; echo exit:\$?" "$SCRATCH/stubs" "$SCRATCH/home" 2>&1 || true)
NPM_ARGS=$(cat "$NPM_LOG" 2>/dev/null || true)
PIP_ARGS=$(cat "$PIP_LOG" 2>/dev/null || true)
assert_grep "offer_install_humanlayer uses npm install" "$NPM_ARGS" "humanlayer"
assert_eq "offer_install_humanlayer never calls pip" "$PIP_ARGS" ""
assert_grep "offer_install_humanlayer returns 0" "$HL_OUT" "exit:0"

# Without npm: must return 1, must not call pip
fresh_dirs
NO_NPM_PIP_LOG="$SCRATCH/no-npm-pip.log"
cat > "$SCRATCH/stubs/pip" <<EOF
#!/usr/bin/env bash
echo "\$@" >> "$NO_NPM_PIP_LOG"
exit 0
EOF
chmod +x "$SCRATCH/stubs/pip"
HL_NO_NPM=$(echo "y" | run_sourced "offer_install_humanlayer; echo exit:\$?" "$SCRATCH/stubs" "$SCRATCH/home" 2>&1 || true)
assert_grep "offer_install_humanlayer without npm returns non-0" "$HL_NO_NPM" "exit:1"
assert_eq "offer_install_humanlayer without npm never calls pip" "$(cat "$NO_NPM_PIP_LOG" 2>/dev/null || echo '')" ""

# ─── Phase 4: repo-wide no-pip regression guard ──────────────────────────────

echo ""
echo "=== Phase 4: no-pip regression guard ==="

BAD_GREP=$(grep -rn "pip.*humanlayer\|pip install humanlayer\|pipx install humanlayer" \
  "${REPO_ROOT}/plugins/" "${REPO_ROOT}/scripts/" "${REPO_ROOT}/setup-catalyst.sh" \
  2>/dev/null | grep -v ".test.sh" || true)
assert_eq "no pip/pipx humanlayer references in repo" "$BAD_GREP" ""

# ─── Phase 5: offer_install_gh_cli ───────────────────────────────────────────

echo ""
echo "=== Phase 5: offer_install_gh_cli ==="

# With brew: brew invoked, curl NOT used for download
fresh_dirs
BREW_GH_LOG="$SCRATCH/brew-gh.log"
GH_CURL_LOG="$SCRATCH/gh-curl.log"

cat > "$SCRATCH/stubs/brew" <<EOF
#!/usr/bin/env bash
echo "\$@" >> "$BREW_GH_LOG"
echo '#!/bin/sh' > "$SCRATCH/stubs/gh"
echo 'echo "gh version 2.62.0"' >> "$SCRATCH/stubs/gh"
chmod +x "$SCRATCH/stubs/gh"
exit 0
EOF
chmod +x "$SCRATCH/stubs/brew"
cat > "$SCRATCH/stubs/curl" <<EOF
#!/usr/bin/env bash
echo "\$@" >> "$GH_CURL_LOG"
exit 0
EOF
chmod +x "$SCRATCH/stubs/curl"

GH_BREW_OUT=$(echo "y" | run_sourced "offer_install_gh_cli; echo exit:\$?" "$SCRATCH/stubs" "$SCRATCH/home" 2>&1 || true)
assert_grep "offer_install_gh_cli uses brew when available" "$(cat "$BREW_GH_LOG" 2>/dev/null || true)" "gh"
assert_eq "curl not called for gh when brew available" "$(cat "$GH_CURL_LOG" 2>/dev/null || echo '')" ""
assert_grep "offer_install_gh_cli returns 0 with brew" "$GH_BREW_OUT" "exit:0"

# Without brew: resolves from GitHub API, downloads archive
fresh_dirs
GH_API_CURL_LOG="$SCRATCH/gh-api-curl.log"

cat > "$SCRATCH/stubs/uname" <<'EOF'
#!/usr/bin/env bash
case "$1" in -s) echo "Darwin";; -m) echo "arm64";; *) /usr/bin/uname "$@";; esac
EOF
chmod +x "$SCRATCH/stubs/uname"
cat > "$SCRATCH/stubs/jq" <<'EOF'
#!/usr/bin/env bash
echo "2.62.0"
EOF
chmod +x "$SCRATCH/stubs/jq"
cat > "$SCRATCH/stubs/curl" <<EOF
#!/usr/bin/env bash
echo "\$@" >> "$GH_API_CURL_LOG"
prev=""
for arg in "\$@"; do
  if [[ "\$prev" == "-o" ]]; then
    echo "fake zip" > "\$arg"
  fi
  prev="\$arg"
done
exit 0
EOF
chmod +x "$SCRATCH/stubs/curl"
cat > "$SCRATCH/stubs/unzip" <<EOF
#!/usr/bin/env bash
prev=""
for arg in "\$@"; do
  if [[ "\$prev" == "-d" ]]; then
    mkdir -p "\$arg/gh_2.62.0_macOS_arm64/bin"
    echo '#!/bin/sh' > "\$arg/gh_2.62.0_macOS_arm64/bin/gh"
    chmod +x "\$arg/gh_2.62.0_macOS_arm64/bin/gh"
    break
  fi
  prev="\$arg"
done
exit 0
EOF
chmod +x "$SCRATCH/stubs/unzip"
cat > "$SCRATCH/stubs/install" <<'EOF'
#!/usr/bin/env bash
src="${*: -2:1}"; dst="${*: -1}"
cp "$src" "$dst" 2>/dev/null || true
exit 0
EOF
chmod +x "$SCRATCH/stubs/install"

GH_NO_BREW_OUT=$(echo "y" | run_sourced "offer_install_gh_cli; echo exit:\$?" "$SCRATCH/stubs" "$SCRATCH/home" 2>&1 || true)
GH_API_CURL_ARGS=$(cat "$GH_API_CURL_LOG" 2>/dev/null || true)
assert_grep "offer_install_gh_cli hits GitHub API for version" "$GH_API_CURL_ARGS" "api.github.com"
assert_grep "offer_install_gh_cli hits GitHub releases download" "$GH_API_CURL_ARGS" "cli/cli/releases"
assert_grep "offer_install_gh_cli returns 0 without brew" "$GH_NO_BREW_OUT" "exit:0"

# Failed download: prints URL hint, returns 1
fresh_dirs
cat > "$SCRATCH/stubs/curl" <<'EOF'
#!/usr/bin/env bash
exit 22
EOF
chmod +x "$SCRATCH/stubs/curl"
cat > "$SCRATCH/stubs/jq" <<'EOF'
#!/usr/bin/env bash
echo "2.62.0"
EOF
chmod +x "$SCRATCH/stubs/jq"
cat > "$SCRATCH/stubs/uname" <<'EOF'
#!/usr/bin/env bash
case "$1" in -s) echo "Darwin";; -m) echo "arm64";; *) /usr/bin/uname "$@";; esac
EOF
chmod +x "$SCRATCH/stubs/uname"

GH_FAIL_OUT=$(echo "y" | run_sourced "offer_install_gh_cli; echo exit:\$?" "$SCRATCH/stubs" "$SCRATCH/home" 2>&1 || true)
assert_grep "offer_install_gh_cli prints URL on failure" "$GH_FAIL_OUT" "cli.github.com"
assert_grep "offer_install_gh_cli returns 1 on failure" "$GH_FAIL_OUT" "exit:1"

# ─── Phase 6: detect_os + detect_arch fallback ───────────────────────────────

echo ""
echo "=== Phase 6: detect_os + detect_arch fallback ==="

fresh_dirs
cat > "$SCRATCH/stubs/uname" <<'EOF'
#!/usr/bin/env bash
case "$1" in -s) echo "Darwin";; -m) echo "arm64";; *) /usr/bin/uname "$@";; esac
EOF
chmod +x "$SCRATCH/stubs/uname"
assert_eq "detect_os Darwin maps to macos" "$(run_sourced "detect_os")" "macos"

fresh_dirs
cat > "$SCRATCH/stubs/uname" <<'EOF'
#!/usr/bin/env bash
case "$1" in -s) echo "Linux";; -m) echo "x86_64";; *) /usr/bin/uname "$@";; esac
EOF
chmod +x "$SCRATCH/stubs/uname"
assert_eq "detect_os Linux maps to linux" "$(run_sourced "detect_os")" "linux"

fresh_dirs
cat > "$SCRATCH/stubs/uname" <<'EOF'
#!/usr/bin/env bash
case "$1" in -s) echo "FreeBSD";; -m) echo "riscv64";; *) /usr/bin/uname "$@";; esac
EOF
chmod +x "$SCRATCH/stubs/uname"
assert_eq "detect_os other maps to unknown" "$(run_sourced "detect_os")" "unknown"
assert_eq "detect_arch unknown arch passes through" "$(run_sourced "detect_arch")" "riscv64"

# ─── Phase 6: PATH persistence by login shell (bash branch) ──────────────────

echo ""
echo "=== Phase 6: PATH persistence for bash login shells ==="

fresh_dirs
TEST_SHELL=/bin/bash run_sourced "ensure_local_bin"
BASHRC_CONTENT=$(cat "$SCRATCH/home/.bashrc" 2>/dev/null || true)
PROFILE_CONTENT=$(cat "$SCRATCH/home/.profile" 2>/dev/null || true)
assert_grep "bash shell: PATH export written to ~/.bashrc" "$BASHRC_CONTENT" '.local/bin'
assert_grep "bash shell: PATH export written to ~/.profile" "$PROFILE_CONTENT" '.local/bin'
assert_not_grep "bash shell: ~/.zshenv untouched" "$(cat "$SCRATCH/home/.zshenv" 2>/dev/null || echo '')" '.local/bin'

TEST_SHELL=/bin/bash run_sourced "ensure_local_bin; ensure_local_bin"
BASH_LINE_COUNT=$(grep -c '.local/bin' "$SCRATCH/home/.bashrc" 2>/dev/null || true)
assert_eq "bash shell: ~/.bashrc PATH line idempotent" "$BASH_LINE_COUNT" "1"

# Unknown shell: write everywhere so the line is never silently lost
fresh_dirs
TEST_SHELL=/bin/fish run_sourced "ensure_local_bin"
assert_grep "unknown shell: writes ~/.zshenv" "$(cat "$SCRATCH/home/.zshenv" 2>/dev/null || true)" '.local/bin'
assert_grep "unknown shell: writes ~/.bashrc" "$(cat "$SCRATCH/home/.bashrc" 2>/dev/null || true)" '.local/bin'
assert_grep "unknown shell: writes ~/.profile" "$(cat "$SCRATCH/home/.profile" 2>/dev/null || true)" '.local/bin'

# bun PATH persistence follows the same shell-aware path (CTL-844 high finding)
fresh_dirs
BUN_BASH_CURL_LOG="$SCRATCH/bun-bash-curl.log"
cat > "$SCRATCH/stubs/curl" <<OUTEREOF
#!/usr/bin/env bash
echo "\$@" >> "$BUN_BASH_CURL_LOG"
cat <<'EOF'
#!/bin/sh
mkdir -p "\$HOME/.bun/bin"
echo '#!/bin/sh' > "\$HOME/.bun/bin/bun"
echo 'echo 1.1.20' >> "\$HOME/.bun/bin/bun"
chmod +x "\$HOME/.bun/bin/bun"
EOF
OUTEREOF
chmod +x "$SCRATCH/stubs/curl"
echo "y" | TEST_SHELL=/bin/bash run_sourced "offer_install_bun" "$SCRATCH/stubs" "$SCRATCH/home" >/dev/null 2>&1 || true
assert_grep "bash shell: bun PATH persisted to ~/.bashrc" "$(cat "$SCRATCH/home/.bashrc" 2>/dev/null || true)" ".bun/bin"
assert_not_grep "bash shell: bun PATH not written to ~/.zshenv" "$(cat "$SCRATCH/home/.zshenv" 2>/dev/null || echo '')" ".bun/bin"

# ─── Phase 6: offer_install_node Linux path + corrupted-extract guard ────────

echo ""
echo "=== Phase 6: offer_install_node (Linux x64 + corrupted extract) ==="

fresh_dirs
LINUX_NODE_CURL_LOG="$SCRATCH/linux-node-curl.log"
cat > "$SCRATCH/stubs/uname" <<'EOF'
#!/usr/bin/env bash
case "$1" in -s) echo "Linux";; -m) echo "x86_64";; *) /usr/bin/uname "$@";; esac
EOF
chmod +x "$SCRATCH/stubs/uname"
cat > "$SCRATCH/stubs/jq" <<'EOF'
#!/usr/bin/env bash
echo "v22.13.0"
EOF
chmod +x "$SCRATCH/stubs/jq"
cat > "$SCRATCH/stubs/curl" <<EOF
#!/usr/bin/env bash
echo "\$@" >> "$LINUX_NODE_CURL_LOG"
exit 0
EOF
chmod +x "$SCRATCH/stubs/curl"
cat > "$SCRATCH/stubs/tar" <<EOF
#!/usr/bin/env bash
prev=""
for arg in "\$@"; do
  if [[ "\$prev" == "-C" ]]; then
    mkdir -p "\$arg/node-v22.13.0-linux-x64/bin"
    echo '#!/bin/sh' > "\$arg/node-v22.13.0-linux-x64/bin/node"
    echo 'echo "v22.13.0"' >> "\$arg/node-v22.13.0-linux-x64/bin/node"
    chmod +x "\$arg/node-v22.13.0-linux-x64/bin/node"
    echo '#!/bin/sh' > "\$arg/node-v22.13.0-linux-x64/bin/npm"
    chmod +x "\$arg/node-v22.13.0-linux-x64/bin/npm"
    echo '#!/bin/sh' > "\$arg/node-v22.13.0-linux-x64/bin/npx"
    chmod +x "\$arg/node-v22.13.0-linux-x64/bin/npx"
    break
  fi
  prev="\$arg"
done
exit 0
EOF
chmod +x "$SCRATCH/stubs/tar"

LINUX_NODE_OUT=$(echo "y" | run_sourced "offer_install_node; echo exit:\$?" "$SCRATCH/stubs" "$SCRATCH/home" 2>&1 || true)
assert_grep "offer_install_node downloads linux-x64 tarball" "$(cat "$LINUX_NODE_CURL_LOG" 2>/dev/null || true)" "linux-x64"
assert_file_exists "offer_install_node Linux creates ~/.local/node" "$SCRATCH/home/.local/node"
assert_grep "offer_install_node Linux returns 0" "$LINUX_NODE_OUT" "exit:0"

# Corrupted extract: tar exits 0 but the extracted node binary does not run.
# A working ~/.local/node must NOT be deleted (CTL-844 medium finding).
fresh_dirs
mkdir -p "$SCRATCH/home/.local/node/bin"
echo "existing-good-install" > "$SCRATCH/home/.local/node/MARKER"
cat > "$SCRATCH/stubs/uname" <<'EOF'
#!/usr/bin/env bash
case "$1" in -s) echo "Linux";; -m) echo "x86_64";; *) /usr/bin/uname "$@";; esac
EOF
chmod +x "$SCRATCH/stubs/uname"
cat > "$SCRATCH/stubs/jq" <<'EOF'
#!/usr/bin/env bash
echo "v22.13.0"
EOF
chmod +x "$SCRATCH/stubs/jq"
cat > "$SCRATCH/stubs/curl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$SCRATCH/stubs/curl"
cat > "$SCRATCH/stubs/tar" <<EOF
#!/usr/bin/env bash
prev=""
for arg in "\$@"; do
  if [[ "\$prev" == "-C" ]]; then
    mkdir -p "\$arg/node-v22.13.0-linux-x64/bin"
    echo '#!/bin/sh' > "\$arg/node-v22.13.0-linux-x64/bin/node"
    echo 'exit 1' >> "\$arg/node-v22.13.0-linux-x64/bin/node"
    chmod +x "\$arg/node-v22.13.0-linux-x64/bin/node"
    break
  fi
  prev="\$arg"
done
exit 0
EOF
chmod +x "$SCRATCH/stubs/tar"

CORRUPT_NODE_OUT=$(echo "y" | run_sourced "offer_install_node; echo exit:\$?" "$SCRATCH/stubs" "$SCRATCH/home" 2>&1 || true)
assert_grep "corrupted extract: offer_install_node returns 1" "$CORRUPT_NODE_OUT" "exit:1"
assert_file_exists "corrupted extract: existing ~/.local/node preserved" "$SCRATCH/home/.local/node/MARKER"

# ─── Phase 6: offer_install_gh_cli Linux tar.gz branch + unzip guard ─────────

echo ""
echo "=== Phase 6: offer_install_gh_cli (Linux tar.gz + unzip guard) ==="

fresh_dirs
GH_LINUX_CURL_LOG="$SCRATCH/gh-linux-curl.log"
cat > "$SCRATCH/stubs/uname" <<'EOF'
#!/usr/bin/env bash
case "$1" in -s) echo "Linux";; -m) echo "x86_64";; *) /usr/bin/uname "$@";; esac
EOF
chmod +x "$SCRATCH/stubs/uname"
cat > "$SCRATCH/stubs/jq" <<'EOF'
#!/usr/bin/env bash
echo "2.62.0"
EOF
chmod +x "$SCRATCH/stubs/jq"
cat > "$SCRATCH/stubs/curl" <<EOF
#!/usr/bin/env bash
echo "\$@" >> "$GH_LINUX_CURL_LOG"
prev=""
for arg in "\$@"; do
  if [[ "\$prev" == "-o" ]]; then
    echo "fake tarball" > "\$arg"
  fi
  prev="\$arg"
done
exit 0
EOF
chmod +x "$SCRATCH/stubs/curl"
cat > "$SCRATCH/stubs/tar" <<EOF
#!/usr/bin/env bash
prev=""
for arg in "\$@"; do
  if [[ "\$prev" == "-C" ]]; then
    mkdir -p "\$arg/gh_2.62.0_linux_amd64/bin"
    echo '#!/bin/sh' > "\$arg/gh_2.62.0_linux_amd64/bin/gh"
    chmod +x "\$arg/gh_2.62.0_linux_amd64/bin/gh"
    break
  fi
  prev="\$arg"
done
exit 0
EOF
chmod +x "$SCRATCH/stubs/tar"
cat > "$SCRATCH/stubs/install" <<'EOF'
#!/usr/bin/env bash
src="${*: -2:1}"; dst="${*: -1}"
cp "$src" "$dst" 2>/dev/null || true
exit 0
EOF
chmod +x "$SCRATCH/stubs/install"

GH_LINUX_OUT=$(echo "y" | run_sourced "offer_install_gh_cli; echo exit:\$?" "$SCRATCH/stubs" "$SCRATCH/home" 2>&1 || true)
GH_LINUX_CURL_ARGS=$(cat "$GH_LINUX_CURL_LOG" 2>/dev/null || true)
assert_grep "offer_install_gh_cli Linux downloads linux_amd64 tar.gz" "$GH_LINUX_CURL_ARGS" "linux_amd64.tar.gz"
assert_grep "offer_install_gh_cli Linux returns 0" "$GH_LINUX_OUT" "exit:0"

# unzip guard: macOS zip branch with unzip unavailable must bail before download.
# `command` is shadowed in the sourced shell to simulate a missing unzip.
fresh_dirs
cat > "$SCRATCH/stubs/uname" <<'EOF'
#!/usr/bin/env bash
case "$1" in -s) echo "Darwin";; -m) echo "arm64";; *) /usr/bin/uname "$@";; esac
EOF
chmod +x "$SCRATCH/stubs/uname"
cat > "$SCRATCH/stubs/jq" <<'EOF'
#!/usr/bin/env bash
echo "2.62.0"
EOF
chmod +x "$SCRATCH/stubs/jq"
cat > "$SCRATCH/stubs/curl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$SCRATCH/stubs/curl"

GH_NO_UNZIP_OUT=$(echo "y" | run_sourced "command() { [[ \"\$2\" == unzip ]] && return 1; builtin command \"\$@\"; }; offer_install_gh_cli; echo exit:\$?" "$SCRATCH/stubs" "$SCRATCH/home" 2>&1 || true)
assert_grep "gh unzip guard: mentions unzip" "$GH_NO_UNZIP_OUT" "unzip not found"
assert_grep "gh unzip guard: returns 1" "$GH_NO_UNZIP_OUT" "exit:1"

# brew failure falls back to no-sudo with an explicit notice (CTL-844 low finding)
fresh_dirs
cat > "$SCRATCH/stubs/brew" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$SCRATCH/stubs/brew"
cat > "$SCRATCH/stubs/uname" <<'EOF'
#!/usr/bin/env bash
case "$1" in -s) echo "Darwin";; -m) echo "arm64";; *) /usr/bin/uname "$@";; esac
EOF
chmod +x "$SCRATCH/stubs/uname"
cat > "$SCRATCH/stubs/jq" <<'EOF'
#!/usr/bin/env bash
echo "2.62.0"
EOF
chmod +x "$SCRATCH/stubs/jq"
cat > "$SCRATCH/stubs/curl" <<'EOF'
#!/usr/bin/env bash
exit 22
EOF
chmod +x "$SCRATCH/stubs/curl"

GH_BREW_FAIL_OUT=$(echo "y" | run_sourced "offer_install_gh_cli; echo exit:\$?" "$SCRATCH/stubs" "$SCRATCH/home" 2>&1 || true)
assert_grep "gh brew failure prints fallback notice" "$GH_BREW_FAIL_OUT" "falling back to no-sudo install"

# ─── Phase 6: offer_install_jq corrupted download ────────────────────────────

echo ""
echo "=== Phase 6: offer_install_jq (corrupted download) ==="

fresh_dirs
cat > "$SCRATCH/stubs/uname" <<'EOF'
#!/usr/bin/env bash
case "$1" in -s) echo "Linux";; -m) echo "x86_64";; *) /usr/bin/uname "$@";; esac
EOF
chmod +x "$SCRATCH/stubs/uname"
cat > "$SCRATCH/stubs/curl" <<'EOF'
#!/usr/bin/env bash
prev=""
for arg in "$@"; do
  if [[ "$prev" == "-o" ]]; then
    echo '#!/bin/sh' > "$arg"
    echo 'exit 1' >> "$arg"
    chmod +x "$arg"
  fi
  prev="$arg"
done
exit 0
EOF
chmod +x "$SCRATCH/stubs/curl"

JQ_CORRUPT_OUT=$(echo "y" | run_sourced "offer_install_jq; echo exit:\$?" "$SCRATCH/stubs" "$SCRATCH/home" 2>&1 || true)
assert_grep "corrupted jq download returns 1" "$JQ_CORRUPT_OUT" "exit:1"
assert_not_grep "corrupted jq download does not print success" "$JQ_CORRUPT_OUT" "jq installed to"

# ─── Phase 6: offer_install_bun failure path ─────────────────────────────────

echo ""
echo "=== Phase 6: offer_install_bun (installer failure) ==="

fresh_dirs
cat > "$SCRATCH/stubs/curl" <<'EOF'
#!/usr/bin/env bash
exit 22
EOF
chmod +x "$SCRATCH/stubs/curl"

BUN_FAIL_OUT=$(echo "y" | run_sourced "offer_install_bun; echo exit:\$?" "$SCRATCH/stubs" "$SCRATCH/home" 2>&1 || true)
assert_grep "offer_install_bun failure returns 1" "$BUN_FAIL_OUT" "exit:1"
assert_grep "offer_install_bun failure prints manual URL" "$BUN_FAIL_OUT" "bun.sh"

# ─── Phase 6: offer_install_humanlayer stale-shim guard ──────────────────────

echo ""
echo "=== Phase 6: offer_install_humanlayer (stale shim) ==="

fresh_dirs
cat > "$SCRATCH/stubs/npm" <<EOF
#!/usr/bin/env bash
echo '#!/bin/sh' > "$SCRATCH/stubs/humanlayer"
echo 'exit 1' >> "$SCRATCH/stubs/humanlayer"
chmod +x "$SCRATCH/stubs/humanlayer"
exit 0
EOF
chmod +x "$SCRATCH/stubs/npm"

HL_SHIM_OUT=$(echo "y" | run_sourced "offer_install_humanlayer; echo exit:\$?" "$SCRATCH/stubs" "$SCRATCH/home" 2>&1 || true)
assert_grep "humanlayer stale shim (on PATH but broken) returns 1" "$HL_SHIM_OUT" "exit:1"

# ─── Summary ─────────────────────────────────────────────────────────────────

echo ""
echo "=== Results ==="
echo "PASS: $PASSES"
echo "FAIL: $FAILURES"
echo ""

if [[ $FAILURES -gt 0 ]]; then
  exit 1
fi
exit 0
