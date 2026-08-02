#!/usr/bin/env bash
# CTL-1612: `_project_shared_github_token` — the shared GitHub credential projection
# that catalyst-execution-core's cmd_start runs BEFORE sourcing execution-core.env.
#
# The 2026-08-02 live breakage: a daemon started from a shell that carried a STALE
# GITHUB_TOKEN handed that dead credential to every child, and `gh` never fell through
# to hosts.yml. The fix is a precedence ladder —
#     ambient inherited  <  shared SOPS file  <  execution-core.env (operator override)
# — so the two load-bearing properties are (a) the FILE WINS over anything inherited
# (T2/T3, the regression), and (b) when there is nothing anywhere BOTH names are left
# genuinely unset rather than exported as "" (T5/T6), because bash `${X:-default}` and
# JS `process.env.X ?? fallback` both treat "" as SET and would defeat gh's fallback.
#
# Method: the helper is extracted out of catalyst-execution-core with sed and exercised
# in isolation, so nothing here boots a daemon, opens a socket, or mints an OAuth token.
# Every case runs under `env -i` (strictly stronger than `env -u GITHUB_TOKEN -u GH_TOKEN`)
# with HOME pointed at the sandbox, so a developer's real shell token or real
# ~/.config/catalyst/github-token can never leak in and make a "nothing inherited" case
# pass vacuously.
#
# SECRET HYGIENE: fixtures are obviously-fake literals, and the probe reports only
# booleans + short digests — never a token value. That invariant is itself asserted
# (test 10 greps the whole captured transcript for token-shaped strings AND for the
# fake fixture literals).
#
# Run: bash plugins/dev/scripts/__tests__/catalyst-execution-core-github-token.test.sh
#
# NOTE: deliberately standalone — do NOT fold these into
# __tests__/catalyst-execution-core.test.sh, which hangs (known, pre-existing, out of scope).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SCRIPT="${REPO_ROOT}/plugins/dev/scripts/catalyst-execution-core"

FAILURES=0
PASSES=0
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; [ $# -ge 2 ] && echo "    $2"; }

if [[ ! -f "$SCRIPT" ]]; then
  echo "FATAL: catalyst-execution-core missing: $SCRIPT" >&2
  exit 1
fi

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/home"

# Hermeticity belt-and-braces: cmd_start (not exercised here) sources
# lib/linear-app-actor.sh and would mint a REAL OAuth token against api.linear.app.
# Point Layer-2 config at an empty object and assert (test 10) that no probe ever
# printed the app-actor success line.
echo '{}' > "$T/layer2.json"

# Obviously-fake fixtures. None of these carry a real `gh` token prefix — test 10
# greps the transcript for those prefixes and must find nothing.
FAKE_FILE_TOKEN='FAKE-CTL1612-shared-file-token-AAAA'
FAKE_AMBIENT_GITHUB='FAKE-CTL1612-ambient-github-token-BBBB'
FAKE_AMBIENT_GH='FAKE-CTL1612-ambient-gh-token-CCCC'

# ─── Extract the helper under test ────────────────────────────────────────────
sed -n '/^_project_shared_github_token() {/,/^}/p' "$SCRIPT" > "$T/helper.sh"
if [[ ! -s "$T/helper.sh" ]] || ! grep -q 'CATALYST_GITHUB_TOKEN_SOURCE' "$T/helper.sh"; then
  echo "FATAL: could not extract _project_shared_github_token from $SCRIPT" >&2
  exit 1
fi

# ─── Probe: run the helper, report booleans/digests only ──────────────────────
cat > "$T/probe.sh" <<'PROBE'
#!/usr/bin/env bash
# Runs the extracted helper in this shell (redirection, not a subshell, so the
# exports survive) and prints a key=value report. NEVER prints a token value.
set -uo pipefail

# shellcheck disable=SC1090
source "$HELPER"
_project_shared_github_token >"$STDOUT_CAP" 2>"$STDERR_CAP"

gt=unset; [[ -n ${GITHUB_TOKEN+x} ]] && gt=set
gh=unset; [[ -n ${GH_TOKEN+x} ]] && gh=set

# Do the two names agree? (both unset counts as agreement)
agree=no
if [[ "$gt" == "$gh" ]]; then
  if [[ "$gt" == unset ]]; then
    agree=yes
  elif [[ "$GITHUB_TOKEN" == "$GH_TOKEN" ]]; then
    agree=yes
  fi
fi

# The "" trap: set-but-empty defeats every downstream ${X:-default} fallback.
empty_export=no
[[ "$gt" == set && -z "$GITHUB_TOKEN" ]] && empty_export=yes
[[ "$gh" == set && -z "$GH_TOKEN" ]] && empty_export=yes

match_github=na
match_gh=na
if [[ -n "${EXPECT_VALUE:-}" ]]; then
  match_github=no; [[ "${GITHUB_TOKEN-}" == "$EXPECT_VALUE" ]] && match_github=yes
  match_gh=no;     [[ "${GH_TOKEN-}"     == "$EXPECT_VALUE" ]] && match_gh=yes
fi

forbid_hit=na
if [[ -n "${FORBID_VALUE:-}" ]]; then
  forbid_hit=no
  [[ "${GITHUB_TOKEN-}" == "$FORBID_VALUE" || "${GH_TOKEN-}" == "$FORBID_VALUE" ]] && forbid_hit=yes
fi

digest_github=none
[[ "$gt" == set ]] && digest_github="$(printf '%s' "$GITHUB_TOKEN" | shasum | cut -c1-12)"
digest_gh=none
[[ "$gh" == set ]] && digest_gh="$(printf '%s' "$GH_TOKEN" | shasum | cut -c1-12)"

# Export-promotion check: a child process only sees EXPORTED names (the CTL-1404
# bare-vs-export trap — a bare assignment never reaches the nohup'd daemon).
exported="$(bash -c 'printf "%s%s" "${GITHUB_TOKEN+G}" "${GH_TOKEN+H}"')"
[[ -z "$exported" ]] && exported=none

echo "source=${CATALYST_GITHUB_TOKEN_SOURCE-<unset>}"
echo "github_token=$gt"
echo "gh_token=$gh"
echo "agree=$agree"
echo "empty_export=$empty_export"
echo "match_github=$match_github"
echo "match_gh=$match_gh"
echo "forbid_hit=$forbid_hit"
echo "exported=$exported"
echo "digest_github=$digest_github"
echo "digest_gh=$digest_gh"
echo "stdout_bytes=$(wc -c <"$STDOUT_CAP" | tr -d ' ')"
echo "stderr_bytes=$(wc -c <"$STDERR_CAP" | tr -d ' ')"
PROBE

ALL_OUT="$T/transcript.log"
: > "$ALL_OUT"

# probe <label> [VAR=VALUE ...] — `env -i` scrubs the ambient environment entirely
# (no inherited GITHUB_TOKEN/GH_TOKEN, no real HOME), then the case's own assignments
# supply exactly the inputs under test.
probe() {
  local label="$1"; shift
  : > "$T/stdout.cap"; : > "$T/stderr.cap"
  local rpt
  rpt="$(
    env -i -u GITHUB_TOKEN -u GH_TOKEN -u CATALYST_GITHUB_TOKEN_SOURCE \
      PATH="$PATH" HOME="$T/home" \
      HELPER="$T/helper.sh" STDOUT_CAP="$T/stdout.cap" STDERR_CAP="$T/stderr.cap" \
      CATALYST_LAYER2_CONFIG_FILE="$T/layer2.json" \
      EXPECT_VALUE="" FORBID_VALUE="" \
      "$@" bash "$T/probe.sh" 2>&1
  )"
  printf '### %s\n%s\n' "$label" "$rpt" >> "$ALL_OUT"
  printf '%s' "$rpt"
}

# assert_line <report> <expected key=value line> <label>
assert_line() {
  if grep -qxF "$2" <<<"$1"; then
    pass "$3"
  else
    fail "$3" "expected report line '$2'; got: $(tr '\n' ' ' <<<"$1")"
  fi
}

MISSING_TOKEN_FILE="$T/definitely-absent-token-file"

# ─── 1: shared file present → both names armed from the file ──────────────────
echo "test 1: file present → GITHUB_TOKEN and GH_TOKEN both = file value, source=shared-file"
printf '%s' "$FAKE_FILE_TOKEN" > "$T/file.token"
OUT="$(probe T1 CATALYST_GITHUB_TOKEN_FILE="$T/file.token" EXPECT_VALUE="$FAKE_FILE_TOKEN")"
assert_line "$OUT" "source=shared-file" "T1 source=shared-file"
assert_line "$OUT" "match_github=yes" "T1 GITHUB_TOKEN = file value"
assert_line "$OUT" "match_gh=yes" "T1 GH_TOKEN = file value"
assert_line "$OUT" "agree=yes" "T1 the two names agree"
assert_line "$OUT" "exported=GH" "T1 both names are exported (reach the nohup'd child)"

# ─── 2: FILE WINS over a stale inherited GITHUB_TOKEN (the 2026-08-02 bug) ────
echo ""
echo "test 2: file WINS over a stale inherited GITHUB_TOKEN (live-breakage regression)"
OUT="$(probe T2 CATALYST_GITHUB_TOKEN_FILE="$T/file.token" \
  GITHUB_TOKEN="$FAKE_AMBIENT_GITHUB" \
  EXPECT_VALUE="$FAKE_FILE_TOKEN" FORBID_VALUE="$FAKE_AMBIENT_GITHUB")"
assert_line "$OUT" "source=shared-file" "T2 source=shared-file (file outranks ambient)"
assert_line "$OUT" "forbid_hit=no" "T2 the stale inherited GITHUB_TOKEN was displaced"
assert_line "$OUT" "match_github=yes" "T2 GITHUB_TOKEN = file value"
assert_line "$OUT" "match_gh=yes" "T2 GH_TOKEN = file value"

# ─── 3: FILE WINS over a stale inherited GH_TOKEN ─────────────────────────────
echo ""
echo "test 3: file WINS over a stale inherited GH_TOKEN"
OUT="$(probe T3 CATALYST_GITHUB_TOKEN_FILE="$T/file.token" \
  GH_TOKEN="$FAKE_AMBIENT_GH" \
  EXPECT_VALUE="$FAKE_FILE_TOKEN" FORBID_VALUE="$FAKE_AMBIENT_GH")"
assert_line "$OUT" "source=shared-file" "T3 source=shared-file (file outranks ambient)"
assert_line "$OUT" "forbid_hit=no" "T3 the stale inherited GH_TOKEN was displaced"
assert_line "$OUT" "match_gh=yes" "T3 GH_TOKEN = file value"
assert_line "$OUT" "agree=yes" "T3 the two names agree"

# ─── 4: whitespace-only file + inherited value → inherited kept, no clobber ───
echo ""
echo "test 4: whitespace-only file + inherited value → inherited kept, source=inherited"
printf ' \t\n  \n' > "$T/whitespace.token"
OUT="$(probe T4 CATALYST_GITHUB_TOKEN_FILE="$T/whitespace.token" \
  GITHUB_TOKEN="$FAKE_AMBIENT_GITHUB" EXPECT_VALUE="$FAKE_AMBIENT_GITHUB")"
assert_line "$OUT" "source=inherited" "T4 source=inherited"
assert_line "$OUT" "match_github=yes" "T4 whitespace-only file does not clobber the inherited value"
assert_line "$OUT" "empty_export=no" "T4 never exports an empty/whitespace value"
assert_line "$OUT" "agree=yes" "T4 GH_TOKEN reconciled to the kept GITHUB_TOKEN"

# ─── 4b: unreadable file + inherited value → inherited kept ───────────────────
echo ""
echo "test 4b: unreadable file + inherited value → inherited kept (the [[ -r ]] guard)"
printf '%s' "$FAKE_FILE_TOKEN" > "$T/unreadable.token"
chmod 000 "$T/unreadable.token" 2>/dev/null || true
if [[ "$(id -u)" == "0" ]] || [[ -r "$T/unreadable.token" ]]; then
  echo "  SKIP test 4b: cannot make a file unreadable as this user"
  PASSES=$((PASSES + 1))
else
  OUT="$(probe T4b CATALYST_GITHUB_TOKEN_FILE="$T/unreadable.token" \
    GITHUB_TOKEN="$FAKE_AMBIENT_GITHUB" EXPECT_VALUE="$FAKE_AMBIENT_GITHUB")"
  assert_line "$OUT" "source=inherited" "T4b unreadable file falls back to inherited"
  assert_line "$OUT" "match_github=yes" "T4b inherited value preserved through an unreadable file"
fi
chmod 600 "$T/unreadable.token" 2>/dev/null || true

# ─── 5: empty file, nothing inherited → BOTH unset ────────────────────────────
echo ""
echo "test 5: empty file + nothing inherited → BOTH unset, source=none (gh falls through to hosts.yml)"
: > "$T/empty.token"
OUT="$(probe T5 CATALYST_GITHUB_TOKEN_FILE="$T/empty.token")"
assert_line "$OUT" "source=none" "T5 source=none"
assert_line "$OUT" "github_token=unset" "T5 GITHUB_TOKEN left unset"
assert_line "$OUT" "gh_token=unset" "T5 GH_TOKEN left unset"
assert_line "$OUT" "empty_export=no" "T5 never exports \"\" (would defeat gh's hosts.yml fallback)"
assert_line "$OUT" "exported=none" "T5 neither name reaches a child process"

# ─── 6: absent file, nothing inherited → BOTH unset ───────────────────────────
echo ""
echo "test 6: absent file + nothing inherited → BOTH unset, source=none"
OUT="$(probe T6 CATALYST_GITHUB_TOKEN_FILE="$MISSING_TOKEN_FILE")"
assert_line "$OUT" "source=none" "T6 source=none"
assert_line "$OUT" "github_token=unset" "T6 GITHUB_TOKEN left unset"
assert_line "$OUT" "gh_token=unset" "T6 GH_TOKEN left unset"
assert_line "$OUT" "exported=none" "T6 neither name reaches a child process"

# ─── 7: absent file, only GH_TOKEN inherited → preserved ──────────────────────
echo ""
echo "test 7: absent file + only GH_TOKEN inherited → preserved and export-promoted"
OUT="$(probe T7 CATALYST_GITHUB_TOKEN_FILE="$MISSING_TOKEN_FILE" \
  GH_TOKEN="$FAKE_AMBIENT_GH" EXPECT_VALUE="$FAKE_AMBIENT_GH")"
assert_line "$OUT" "source=inherited" "T7 source=inherited"
assert_line "$OUT" "match_gh=yes" "T7 inherited GH_TOKEN preserved"
assert_line "$OUT" "github_token=unset" "T7 GITHUB_TOKEN is not manufactured"
assert_line "$OUT" "exported=H" "T7 GH_TOKEN export-promoted (reaches the nohup'd child)"

# ─── 8: absent file, only GITHUB_TOKEN inherited → GH_TOKEN reconciled ────────
echo ""
echo "test 8: absent file + only GITHUB_TOKEN inherited → GH_TOKEN reconciled to match"
OUT="$(probe T8 CATALYST_GITHUB_TOKEN_FILE="$MISSING_TOKEN_FILE" \
  GITHUB_TOKEN="$FAKE_AMBIENT_GITHUB" EXPECT_VALUE="$FAKE_AMBIENT_GITHUB")"
assert_line "$OUT" "source=inherited" "T8 source=inherited"
assert_line "$OUT" "match_github=yes" "T8 inherited GITHUB_TOKEN preserved"
assert_line "$OUT" "match_gh=yes" "T8 GH_TOKEN reconciled to GITHUB_TOKEN"
assert_line "$OUT" "agree=yes" "T8 the two names agree"
assert_line "$OUT" "exported=GH" "T8 both names export-promoted"

# ─── 9: trailing newline in the file is stripped ──────────────────────────────
echo ""
echo "test 9: trailing-newline file → whitespace stripped before export"
printf '%s\n\n' "$FAKE_FILE_TOKEN" > "$T/newline.token"
OUT="$(probe T9 CATALYST_GITHUB_TOKEN_FILE="$T/newline.token" EXPECT_VALUE="$FAKE_FILE_TOKEN")"
assert_line "$OUT" "source=shared-file" "T9 source=shared-file"
assert_line "$OUT" "match_github=yes" "T9 trailing newline stripped from GITHUB_TOKEN"
assert_line "$OUT" "match_gh=yes" "T9 trailing newline stripped from GH_TOKEN"
# Same digest as the no-newline fixture in T1 → byte-identical after stripping.
T1_DIGEST="$(grep -m1 '^digest_github=' <<<"$(probe T9digest CATALYST_GITHUB_TOKEN_FILE="$T/file.token")")"
T9_DIGEST="$(grep -m1 '^digest_github=' <<<"$OUT")"
if [[ "$T1_DIGEST" == "$T9_DIGEST" && "$T9_DIGEST" != "digest_github=none" ]]; then
  pass "T9 newline-terminated file yields the identical value digest as the bare file"
else
  fail "T9 stripped value should digest-match the bare file" "bare=$T1_DIGEST newline=$T9_DIGEST"
fi

# ─── 10: secret hygiene + silence ─────────────────────────────────────────────
echo ""
echo "test 10: nothing token-shaped is ever printed, and the helper writes nothing to stdout"
TOTAL_STDOUT_LINES="$(grep -c '^stdout_bytes=' "$ALL_OUT" 2>/dev/null || echo 0)"
ZERO_STDOUT_LINES="$(grep -c '^stdout_bytes=0$' "$ALL_OUT" 2>/dev/null || echo 0)"
if [[ "$TOTAL_STDOUT_LINES" -gt 0 && "$TOTAL_STDOUT_LINES" == "$ZERO_STDOUT_LINES" ]]; then
  pass "T10 the helper wrote 0 bytes to stdout in all $TOTAL_STDOUT_LINES cases"
else
  fail "T10 the helper must never write to stdout" "cases=$TOTAL_STDOUT_LINES silent=$ZERO_STDOUT_LINES"
fi
TOTAL_STDERR_LINES="$(grep -c '^stderr_bytes=' "$ALL_OUT" 2>/dev/null || echo 0)"
ZERO_STDERR_LINES="$(grep -c '^stderr_bytes=0$' "$ALL_OUT" 2>/dev/null || echo 0)"
if [[ "$TOTAL_STDERR_LINES" -gt 0 && "$TOTAL_STDERR_LINES" == "$ZERO_STDERR_LINES" ]]; then
  pass "T10 the helper wrote 0 bytes to stderr in all $TOTAL_STDERR_LINES cases"
else
  fail "T10 the helper must never write to stderr" "cases=$TOTAL_STDERR_LINES silent=$ZERO_STDERR_LINES"
fi
if grep -qE 'ghp_|gho_|ghu_|ghs_|ghr_|github_pat_' "$ALL_OUT"; then
  fail "T10 transcript contains a token-shaped string"
else
  pass "T10 transcript contains no token-shaped string (no gh* prefix)"
fi
LEAKED=""
for fixture in "$FAKE_FILE_TOKEN" "$FAKE_AMBIENT_GITHUB" "$FAKE_AMBIENT_GH"; do
  grep -qF "$fixture" "$ALL_OUT" && LEAKED="yes"
done
if [[ -z "$LEAKED" ]]; then
  pass "T10 no fixture token VALUE appears in the transcript (booleans/digests only)"
else
  fail "T10 a token value leaked into the transcript"
fi
# Hermeticity: nothing here may mint a real Linear app-actor OAuth token.
if grep -qF "authenticated as Catalyst Orchestrator" "$ALL_OUT"; then
  fail "T10 suite performed a real app-actor OAuth mint (not hermetic)"
else
  pass "T10 no app-actor OAuth mint occurred (suite stayed offline)"
fi

# ─── 11: wiring — invoked inside cmd_start BEFORE execution-core.env ──────────
echo ""
echo "test 11: helper is WIRED into cmd_start before the execution-core.env source"
CALL_LINES="$(grep -nE '^[[:space:]]*_project_shared_github_token[[:space:]]*$' "$SCRIPT" | cut -d: -f1)"
CALL_COUNT="$(printf '%s\n' "$CALL_LINES" | grep -c '[0-9]' || true)"
CMD_START_LINE="$(grep -n '^cmd_start() {' "$SCRIPT" | head -1 | cut -d: -f1)"
ENV_SOURCE_LINE="$(grep -n 'source "\$_daemon_env"' "$SCRIPT" | head -1 | cut -d: -f1)"
if [[ "$CALL_COUNT" == "1" ]]; then
  pass "T11 exactly one _project_shared_github_token invocation site"
else
  fail "T11 expected exactly one invocation site" "found $CALL_COUNT (lines: $(tr '\n' ' ' <<<"$CALL_LINES"))"
fi
CALL_LINE="$(printf '%s\n' "$CALL_LINES" | head -1)"
if [[ -n "$CMD_START_LINE" && -n "$ENV_SOURCE_LINE" && -n "$CALL_LINE" ]] \
  && [[ "$CALL_LINE" -gt "$CMD_START_LINE" ]]; then
  pass "T11 invoked inside cmd_start (line $CALL_LINE > cmd_start line $CMD_START_LINE)"
else
  fail "T11 invocation should live inside cmd_start" \
    "call=$CALL_LINE cmd_start=$CMD_START_LINE env_source=$ENV_SOURCE_LINE"
fi
if [[ -n "$CALL_LINE" && -n "$ENV_SOURCE_LINE" ]] && [[ "$CALL_LINE" -lt "$ENV_SOURCE_LINE" ]]; then
  pass "T11 invoked BEFORE execution-core.env is sourced (operator override still wins)"
else
  fail "T11 invocation must precede the execution-core.env source" \
    "call=$CALL_LINE env_source=$ENV_SOURCE_LINE"
fi

echo ""
echo "─────────────────────────────────────────────"
echo "catalyst-execution-core-github-token: ${PASSES} passed, ${FAILURES} failed"
if [[ $FAILURES -gt 0 ]]; then
  exit 1
fi
exit 0
