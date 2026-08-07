#!/usr/bin/env bash
# Shell tests for lib/catalyst-agent-path.sh — CAT-29's single agent PATH derivation.

set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(cd "$TEST_DIR/.." && pwd)"
SCRIPTS_DIR="$(cd "$LIB_DIR/.." && pwd)"
SCRATCH="$(mktemp -d)"
ORIGINAL_HOME="${HOME}"
ORIGINAL_PATH="${PATH}"
trap 'HOME="$ORIGINAL_HOME"; PATH="$ORIGINAL_PATH"; rm -rf "$SCRATCH"' EXIT

FAILURES=0
PASSES=0
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1${2:+ — $2}"; }
contains_segment() { case ":$1:" in *":$2:"*) return 0 ;; *) return 1 ;; esac; }

export HOME="$SCRATCH/home"
mkdir -p "$HOME/.catalyst/bin" "$HOME/.local/bin" "$HOME/.bun/bin" "$SCRATCH/extra"
# shellcheck source=/dev/null
source "$LIB_DIR/catalyst-agent-path.sh"

echo "catalyst-agent-path tests (CAT-29)"
RESULT="$(catalyst_agent_path "$SCRATCH/extra:$SCRATCH/missing")"

if ! contains_segment "$RESULT" "$HOME/.local/node/bin"; then pass "drops nonexistent user directories"; else fail "drops nonexistent user directories" "$RESULT"; fi
EXPECTED_PREFIX="$HOME/.catalyst/bin:$HOME/.local/bin:$HOME/.bun/bin"
if [[ "$RESULT" == "$EXPECTED_PREFIX:"* ]]; then pass "keeps existing candidates in canonical order"; else fail "keeps existing candidates in canonical order" "$RESULT"; fi
if [[ -d /opt/homebrew/bin ]]; then
	contains_segment "$RESULT" /opt/homebrew/bin && pass "finds absolute Homebrew prefix without brew" || fail "finds absolute Homebrew prefix without brew" "$RESULT"
elif [[ -d /usr/local/bin ]]; then
	contains_segment "$RESULT" /usr/local/bin && pass "finds absolute Homebrew-compatible prefix without brew" || fail "finds absolute Homebrew-compatible prefix without brew" "$RESULT"
else
	! contains_segment "$RESULT" /opt/homebrew/bin && ! contains_segment "$RESULT" /usr/local/bin && pass "omits absent Homebrew candidates" || fail "omits absent Homebrew candidates" "$RESULT"
fi
for dir in /usr/bin /bin /usr/sbin /sbin; do
	contains_segment "$RESULT" "$dir" || fail "keeps system fallback $dir" "$RESULT"
done
pass "keeps system fallbacks"

TWICE="$(catalyst_agent_path "$RESULT")"
[[ "$TWICE" == "$RESULT" ]] && pass "is idempotent" || fail "is idempotent" "$TWICE"
case "$RESULT" in :* | *: | *::* ) fail "emits no empty segments" "$RESULT" ;; *) pass "emits no empty segments" ;; esac

# Both source-safe launchers must expose the exact same derivation.
STACK_PATH="$(HOME="$HOME" PATH="$ORIGINAL_PATH" bash -c 'source "$1"; _stack_agent_path' _ "$SCRIPTS_DIR/catalyst-stack")"
CORE_PATH="$(HOME="$HOME" PATH="$ORIGINAL_PATH" bash -c 'source "$1"; catalyst_agent_path "$PATH"' _ "$SCRIPTS_DIR/catalyst-execution-core")"
[[ "$STACK_PATH" == "$CORE_PATH" ]] && pass "launcher and plist PATH derivations have parity" || fail "launcher and plist PATH derivations have parity" "stack=$STACK_PATH core=$CORE_PATH"

echo "$PASSES passed, $FAILURES failed"
[[ "$FAILURES" -eq 0 ]]
