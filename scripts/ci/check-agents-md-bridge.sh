#!/usr/bin/env bash
# check-agents-md-bridge.sh — CI lint for the context-framework invariant (CTL-1304).
#
# Catalyst keeps ONE portable, tool-agnostic source of truth (AGENTS.md) and a thin
# per-tool bridge (CLAUDE.md) that imports it. This guard stops that structure from
# silently regressing back into two divergent copies (the failure mode that motivated
# the refactor). It asserts:
#
#   1. CLAUDE.md's first line is exactly "@AGENTS.md" — the portable guidance is
#      IMPORTED, not duplicated. Everything below that line must be Claude-specific.
#   2. AGENTS.md exists (it is the source of truth and must be tracked) and stays
#      tool-agnostic:
#        a. no "@"-import directives (the "@path" import is a Claude Code feature;
#           other agents render it as dangling literal text), and
#        b. no vendor tool names (claude / codex) — so the file ports cleanly to any
#           coding agent.
#
# Run from anywhere: bash scripts/ci/check-agents-md-bridge.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

fail=0
err() { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; fail=1; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$1"; }

echo "context-framework bridge lint (CTL-1304):"

# 1. CLAUDE.md must exist and import AGENTS.md on line 1.
if [[ ! -f CLAUDE.md ]]; then
  err "CLAUDE.md is missing"
else
  first="$(head -n1 CLAUDE.md | tr -d '\r' | sed 's/[[:space:]]*$//')"
  if [[ "$first" == "@AGENTS.md" ]]; then
    ok "CLAUDE.md imports AGENTS.md on line 1"
  else
    err "CLAUDE.md line 1 must be '@AGENTS.md' (found: '${first}'). Portable guidance lives in AGENTS.md; CLAUDE.md must import it, not restate it."
  fi
fi

# 2. AGENTS.md must exist.
if [[ ! -f AGENTS.md ]]; then
  err "AGENTS.md is missing — it is the portable source of truth and must be tracked"
  echo
  [[ $fail -eq 0 ]] && echo "context-framework bridge lint PASSED" || echo "context-framework bridge lint FAILED"
  exit "$fail"
fi

# 2a. No Claude-only "@"-imports in AGENTS.md.
if grep -nE '^@|@import[[:space:]]' AGENTS.md >/dev/null 2>&1; then
  err "AGENTS.md must not contain '@'-import directives (Claude-only; dangling text for other agents):"
  grep -nE '^@|@import[[:space:]]' AGENTS.md | sed 's/^/      /' >&2
else
  ok "AGENTS.md has no Claude-only @-imports"
fi

# 2b. AGENTS.md stays vendor-neutral.
if grep -niE 'claude|codex' AGENTS.md >/dev/null 2>&1; then
  err "AGENTS.md must stay vendor-neutral — found tool name(s); move tool-specific notes to the bridge file:"
  grep -niE 'claude|codex' AGENTS.md | sed 's/^/      /' >&2
else
  ok "AGENTS.md is vendor-neutral (no claude/codex)"
fi

echo
if [[ $fail -eq 0 ]]; then
  echo "context-framework bridge lint PASSED"
else
  echo "context-framework bridge lint FAILED"
fi
exit "$fail"
