#!/usr/bin/env bash
# zsh-safe-locals.test.sh (CTL-1777) — static lint rejecting `local`/`typeset`
# of zsh special parameter names in lib/*.sh.
#
# Scope: plugins/dev/scripts/lib/*.sh ONLY (not lib/__tests__/, not non-lib
# scripts). Widening to non-lib scripts is a deferred follow-up ticket (see
# research Open Q2 in thoughts/shared/research/2026-08-11-ctl-1777.md).
#
# Under zsh, the following names are SPECIAL — they are bound to zsh internals
# (e.g. `path` ↔ $PATH, `status` ↔ $?, `argv` ↔ positional params). A
# `local <name>` declaration scopes the special locally and resets it to its
# default (often empty), wiping the binding for the rest of the function.
# External commands called from within the function become unresolvable when
# `path` is reset to empty — the production failure mode CTL-1777 fixes.
# Bash treats these as ordinary variables, so the bug is zsh-only and bash
# test suites miss it.
#
# Run: bash plugins/dev/scripts/__tests__/zsh-safe-locals.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Resolve LIB_DIR: two possible layouts (run from repo root vs from __tests__).
if [[ -d "${SCRIPT_DIR}/../../../../plugins/dev/scripts/lib" ]]; then
  LIB_DIR="$(cd "${SCRIPT_DIR}/../../../../plugins/dev/scripts/lib" && pwd)"
elif [[ -d "${SCRIPT_DIR}/../lib" ]]; then
  LIB_DIR="$(cd "${SCRIPT_DIR}/../lib" && pwd)"
else
  LIB_DIR="${SCRIPT_DIR}/../lib"
fi

PASS=0
FAIL=0
pass() { PASS=$((PASS+1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; [[ $# -ge 2 ]] && echo "    $2"; }

# ─── Canonical set of zsh special parameter names (Finding 8, CTL-1777 research)
# Adding a future zsh special is a one-line addition to this list.
ZSH_SPECIALS="path cdpath fpath manpath module_path status argv options signals pipestatus"

# ─── Tokenizer ───────────────────────────────────────────────────────────────
# check_line_for_specials <line>
# Prints the special name(s) found if the line declares a zsh special via
# local/typeset. Prints nothing if clean or if it is a comment.
# Uses only POSIX shell + awk (no gawk extensions).
check_line_for_specials() {
  local line="$1"
  # Strip leading whitespace for comment detection.
  local stripped="${line#"${line%%[![:space:]]*}"}"
  # Skip pure comment lines.
  [[ "${stripped:0:1}" == "#" ]] && return 0
  # Normalize tabs to spaces so a tab-separated declaration (`local\tpath`) is
  # detected the same as a space-separated one, then strip any trailing inline
  # comment (from the first ` #`). Stripping the comment BEFORE keyword
  # detection closes two holes at once (CTL-1777 phase-review remediation):
  #  - false-negative: `local path="$1"  # note` previously slipped through
  #    because a `#` anywhere on the line short-circuited the scan.
  #  - false-positive: a `#`-comment that merely mentions a special name (or
  #    the keyword) can no longer be mistaken for a declaration.
  local norm="${line//$'\t'/ }"
  local nocomment="${norm%% #*}"

  # Extract rest after 'local '/'typeset ' (comment-free, tab-normalized).
  local rest=""
  case "$nocomment" in
    *"local "*)   rest="${nocomment#*local }"  ;;
    *"typeset "*) rest="${nocomment#*typeset }" ;;
    *) return 0 ;;
  esac

  # Tokenize rest on whitespace and check each declared name.
  # Use awk for splitting; keep only POSIX awk features.
  printf '%s\n' "$rest" | awk -v specials="$ZSH_SPECIALS" '
    BEGIN {
      n = split(specials, sp_arr, " ")
      for (i = 1; i <= n; i++) special[sp_arr[i]] = 1
    }
    {
      ntok = split($0, tokens, /[[:space:]]+/)
      for (i = 1; i <= ntok; i++) {
        tok = tokens[i]
        if (tok == "") continue
        # Strip everything from the first = onward to get the declared name.
        eq = index(tok, "=")
        if (eq > 0) { name = substr(tok, 1, eq - 1) } else { name = tok }
        # Strip non-identifier characters (safety).
        gsub(/[^A-Za-z0-9_]/, "", name)
        if (name != "" && (name in special)) print name
      }
    }
  '
}

# scan_for_zsh_special_locals <file>
# Prints "file:linenum: name" for each offending declaration.
scan_for_zsh_special_locals() {
  local file="$1"
  local lineno=0
  while IFS= read -r line; do
    lineno=$((lineno + 1))
    local hit
    hit="$(check_line_for_specials "$line")"
    if [[ -n "$hit" ]]; then
      # May be multiple names; print one entry per name.
      while IFS= read -r name; do
        [[ -n "$name" ]] && printf '%s:%d: %s\n' "$file" "$lineno" "$name"
      done <<< "$hit"
    fi
  done < "$file"
}

# ─── Fixture precision tests ─────────────────────────────────────────────────
echo "=== Fixture precision tests ==="

# Positive fixtures — MUST flag a special name.
POSITIVE_FIXTURES=(
  'local path="$1"'
  '  local ticket_lc date_prefix path'
  '	local content="$1" path="$2" tmp'
  '	local path="$1" ticket="$2" top="" branch=""'
  'typeset path'
  '  local status="ok"'
  '  local argv'
  # CTL-1777 phase-review remediation: trailing inline comment must not hide
  # the declaration (false-negative fix).
  'local path="$1"  # sets the resolved path'
  '	local content="$1" path="$2" tmp  # atomic writer'
  # Tab (not space) between keyword and name must still flag (false-negative fix).
  'local	path="$1"'
  'typeset	fpath'
)
for fixture_line in "${POSITIVE_FIXTURES[@]}"; do
  result="$(check_line_for_specials "$fixture_line")"
  if [[ -n "$result" ]]; then
    pass "POSITIVE flagged: $(printf '%q' "$fixture_line") → $result"
  else
    fail "POSITIVE not flagged (should be): $(printf '%q' "$fixture_line")"
  fi
done

# Negative fixtures — MUST NOT flag any special name.
NEGATIVE_FIXTURES=(
  '  local p="$path" dir'
  '  # NB: named cache_path NOT path; local path; path=<file> would wipe PATH'
  '  local mypath="$1"'
  '  local path_to_x=something'
  '  local cache_path'
  '  local doc_path="x"'
  '  local real_path_arg="$1"'
  '  local dest_path="$2"'
  '  local wt_path="$1"'
  '  local p="$path"'
  # CTL-1777 phase-review remediation: a trailing comment that merely mentions a
  # special name (or the keyword) must not be mistaken for a declaration.
  '  local doc_path="x"  # not path, doc_path'
  '  count=1  # local path would wipe PATH'
)
for fixture_line in "${NEGATIVE_FIXTURES[@]}"; do
  result="$(check_line_for_specials "$fixture_line")"
  if [[ -z "$result" ]]; then
    pass "NEGATIVE not flagged (correct): $(printf '%q' "$fixture_line")"
  else
    fail "NEGATIVE false-positive: $(printf '%q' "$fixture_line") → flagged as: $result"
  fi
done

# ─── Live scan of lib/*.sh ───────────────────────────────────────────────────
echo ""
echo "=== Live scan: lib/*.sh for zsh-special local/typeset declarations ==="

if [[ ! -d "$LIB_DIR" ]]; then
  fail "lib dir not found at $LIB_DIR — cannot scan"
else
  OFFENDER_COUNT=0
  while IFS= read -r f; do
    while IFS= read -r hit; do
      echo "    OFFENDER: $hit"
      OFFENDER_COUNT=$((OFFENDER_COUNT + 1))
    done < <(scan_for_zsh_special_locals "$f")
  done < <(find "$LIB_DIR" -maxdepth 1 -name '*.sh' | sort)

  if [[ $OFFENDER_COUNT -eq 0 ]]; then
    pass "0 offenders in lib/*.sh — all local/typeset declarations are zsh-safe"
  else
    fail "$OFFENDER_COUNT offender(s) in lib/*.sh (listed above)"
  fi
fi

# ─── Summary ────────────────────────────────────────────────────────────────
echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[[ $FAIL -eq 0 ]] || exit 1
