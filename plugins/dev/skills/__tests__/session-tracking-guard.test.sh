#!/usr/bin/env bash
# session-tracking-guard.test.sh — CTL-2306: session tracking is optional host tooling,
# and a host without it must not break the session a workflow handed down.
#
# Skills call the installed `catalyst-session` CLI when it is on PATH (D8). Codex review on
# #4137 caught a fallback of `true` in the briefings: `CATALYST_SESSION_ID=$("$SESSION_SCRIPT"
# start …)` then assigned `true`'s empty stdout, silently dropping the parent session id the
# invoking workflow supplied — and every event the vendored helpers emitted lost its
# correlation. The contract: SESSION_SCRIPT is empty when the CLI is absent, and every call
# through it is guarded.
#
# Two halves, over every skill that tracks a session:
#   1. Behaviour: the session-start block (from `SESSION_SCRIPT=` to its closing `fi`) is
#      EXTRACTED and RUN with no catalyst-session on PATH and a parent CATALYST_SESSION_ID;
#      the parent id must survive.
#   2. Shape: every `"$SESSION_SCRIPT"` call sits inside a guard, and no fallback substitutes
#      another command for the CLI.
#
# Run: bash plugins/dev/skills/__tests__/session-tracking-guard.test.sh
# Bash-3.2 safe.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

PASS=0
FAIL=0
ok()   { PASS=$((PASS+1)); printf '  PASS: %s\n' "$1"; }
fail() { FAIL=$((FAIL+1)); printf '  FAIL: %s\n    %s\n' "$1" "${2:-}"; }

SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

FILES="$(grep -rlF 'SESSION_SCRIPT=' "$SKILLS_DIR" --include='*.md' 2>/dev/null | sort)"
if [ -z "$FILES" ]; then
  echo "FATAL: no skill file assigns SESSION_SCRIPT — the instrument sees nothing" >&2
  exit 1
fi

echo "session tracking is optional and never drops a parent session (CTL-2306)"
checked=0
while IFS= read -r file; do
  rel="${file#"$SKILLS_DIR"/}"
  checked=$((checked+1))

  # ── 1. Behaviour ──
  block="${SCRATCH}/block.$checked.sh"
  awk '
    /SESSION_SCRIPT=/ && !on { on = 1 }
    on && /^[[:space:]]*```/ { exit }
    on { print }
    on && /^[[:space:]]*fi[[:space:]]*$/ { exit }
  ' "$file" > "$block"
  got="$(cd "$SCRATCH" && env -i HOME="$SCRATCH" PATH="/usr/bin:/bin" CATALYST_SESSION_ID="parent-session-1" \
    bash -c ". '$block' >/dev/null 2>&1; printf '%s' \"\${CATALYST_SESSION_ID:-}\"")"
  if [ "$got" = "parent-session-1" ]; then
    ok "${rel}: without catalyst-session, the parent CATALYST_SESSION_ID survives the start block"
  else
    fail "${rel}: without catalyst-session, the parent CATALYST_SESSION_ID survives the start block" "got '${got}'"
  fi

  # ── 2. Shape ──
  if grep -qE 'SESSION_SCRIPT=.*\|\|[[:space:]]*echo' "$file"; then
    fail "${rel}: no fallback substitutes another command for the CLI" "$(grep -nE 'SESSION_SCRIPT=.*\|\|[[:space:]]*echo' "$file")"
  else
    ok "${rel}: no fallback substitutes another command for the CLI"
  fi
  # A call is guarded when it sits inside an `if` that tests SESSION_SCRIPT (or a session id)
  # and before that if's `fi`, or when the guard is on the same line.
  unguarded="$(awk '
    /^[[:space:]]*if .*(-[nx] "\$SESSION_SCRIPT"|-n "\$\{CATALYST_SESSION_ID)/ { depth++; next }
    /^[[:space:]]*if / && depth > 0 { depth++; next }
    /^[[:space:]]*fi[[:space:]]*$/ && depth > 0 { depth--; next }
    /"\$SESSION_SCRIPT"/ && !/SESSION_SCRIPT=/ {
      if (depth == 0 && $0 !~ /-[nx] "\$SESSION_SCRIPT"/) print FILENAME ":" NR ": " $0
    }
  ' "$file")"
  if [ -z "$unguarded" ]; then
    ok "${rel}: every \"\$SESSION_SCRIPT\" call is guarded"
  else
    fail "${rel}: every \"\$SESSION_SCRIPT\" call is guarded" "$unguarded"
  fi
done <<FILES_EOF
$FILES
FILES_EOF

echo ""
echo "PASS: $PASS  FAIL: $FAIL  (files: $checked)"
[ "$FAIL" -eq 0 ] || exit 1
