#!/usr/bin/env bash
# CTL-1612: `catalyst_project_github_token` — the shared GitHub credential projection
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
# CTL-1612 (Codex P2) adds a SECOND helper to the same ladder,
# `catalyst_reconcile_github_token_aliases`, which runs AFTER execution-core.env is sourced.
# The override was honored only by ordering, and an execution-core.env that set just
# GITHUB_TOKEN left GH_TOKEN still holding the shared-file value — and `gh` resolves
# GH_TOKEN FIRST, so the operator override was silently ignored while the provenance
# breadcrumb still claimed "shared-file". T12 is that regression; T13-T15 pin the
# no-op cases the guard has to preserve.
#
# CTL-1612 (Codex P2) also makes the projection XDG-aware: the default path is
# ${XDG_CONFIG_HOME:-$HOME/.config}/catalyst/github-token, matching setup-webhooks.sh:23
# (which is what generates the sibling secret). T16 pins both arms of that `:-`.
#
# Method: the helpers are extracted out of catalyst-execution-core with sed and exercised
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
FAKE_OVERRIDE_TOKEN='FAKE-CTL1612-operator-override-token-DDDD'
FAKE_XDG_TOKEN='FAKE-CTL1612-xdg-config-home-token-EEEE'
FAKE_HOME_CONFIG_TOKEN='FAKE-CTL1612-home-dotconfig-token-FFFF'
# CTL-1612 round 3: fixtures that carry INTERNAL whitespace. A secret is an opaque byte
# string — nothing forbids a space or a tab inside one — so these are the values the old
# `tr -d '[:space:]'` reader silently mangled (see tests 21-23).
FAKE_INTERNAL_SPACE='FAKE-CTL1612 internal space token-GGGG'
FAKE_INTERNAL_TAB=$'FAKE-CTL1612\tinternal\ttab\ttoken-HHHH'
FAKE_HMAC_INTERNAL=$'FAKE-CTL1612-hmac key\twith spacing-IIII'

# ─── The helpers under test ───────────────────────────────────────────────────
# CTL-1612: the projection/reconcile pair now lives in ONE shared library sourced by both
# daemon launchers, instead of being hand-written inline in each. Point the probe straight
# at it — there is nothing to extract, and testing the real file is what makes these
# assertions meaningful for BOTH the execution-core and monitor launch paths.
LIB="$(dirname "$SCRIPT")/lib/catalyst-secret-env.sh"
if [[ ! -r "$LIB" ]] || ! grep -q 'catalyst_project_github_token' "$LIB"; then
  echo "FATAL: shared secret-env lib missing or unrecognized at $LIB" >&2
  exit 1
fi
cp "$LIB" "$T/helper.sh"
cp "$LIB" "$T/reconcile.sh"
# CTL-1623: catalyst-secret-env.sh now sources its sibling catalyst-secret-contract.sh via
# a BASH_SOURCE-relative path — since the lib is COPIED into $T above (for hermeticity, so
# a stray edit to the real file mid-run can't change results underfoot), the sibling must be
# copied alongside it too, or that source line resolves against $T and fails closed.
CONTRACT_LIB="$(dirname "$LIB")/catalyst-secret-contract.sh"
if [[ ! -r "$CONTRACT_LIB" ]]; then
  echo "FATAL: catalyst-secret-contract.sh missing at $CONTRACT_LIB" >&2
  exit 1
fi
cp "$CONTRACT_LIB" "$T/catalyst-secret-contract.sh"

# ─── Probe: run the helper, report booleans/digests only ──────────────────────
cat > "$T/probe.sh" <<'PROBE'
#!/usr/bin/env bash
# Runs the extracted helper in this shell (redirection, not a subshell, so the
# exports survive) and prints a key=value report. NEVER prints a token value.
set -uo pipefail

# shellcheck disable=SC1090
source "$HELPER"
catalyst_project_github_token >"$STDOUT_CAP" 2>"$STDERR_CAP"

# CTL-1612 (Codex P2) stage 2 — opt-in, inert unless the case supplies RECONCILE, so
# tests 1-9 run byte-identically. Replays cmd_start's post-projection sequence: source
# execution-core.env (the operator override), THEN reconcile the two names.
if [[ -n "${RECONCILE:-}" ]]; then
  # (already sourced above — the lib is idempotent-source guarded)
  # shellcheck disable=SC1090
  [[ -n "${ENV_FILE:-}" && -f "${ENV_FILE}" ]] && source "$ENV_FILE"
  catalyst_reconcile_github_token_aliases >>"$STDOUT_CAP" 2>>"$STDERR_CAP"
fi

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
CALL_LINES="$(grep -nE '^[[:space:]]*catalyst_project_github_token([[:space:]]|$)' "$SCRIPT" | cut -d: -f1)"
CALL_COUNT="$(printf '%s\n' "$CALL_LINES" | grep -c '[0-9]' || true)"
CMD_START_LINE="$(grep -n '^cmd_start() {' "$SCRIPT" | head -1 | cut -d: -f1)"
ENV_SOURCE_LINE="$(grep -n 'source "\$_daemon_env"' "$SCRIPT" | head -1 | cut -d: -f1)"
if [[ "$CALL_COUNT" == "1" ]]; then
  pass "T11 exactly one catalyst_project_github_token invocation site"
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

# ─── execution-core.env fixtures (what cmd_start sources AFTER the projection) ─
# The load-bearing one sets ONLY GITHUB_TOKEN — that is exactly the shape that used to
# leave GH_TOKEN pointed at the shared-file value while `gh` read GH_TOKEN first.
printf "export GITHUB_TOKEN='%s'\n" "$FAKE_OVERRIDE_TOKEN" > "$T/env-override-github-only.env"
printf 'export CATALYST_FIXTURE_UNRELATED=1\n' > "$T/env-no-token.env"
printf "export GITHUB_TOKEN=''\n" > "$T/env-override-empty.env"

# ─── 12: operator override sets only GITHUB_TOKEN → GH_TOKEN re-pointed ───────
echo ""
echo "test 12: execution-core.env sets ONLY GITHUB_TOKEN → GH_TOKEN re-pointed at the override (Codex P2 regression)"
OUT="$(probe T12 CATALYST_GITHUB_TOKEN_FILE="$T/file.token" \
  RECONCILE="$T/reconcile.sh" ENV_FILE="$T/env-override-github-only.env" \
  EXPECT_VALUE="$FAKE_OVERRIDE_TOKEN" FORBID_VALUE="$FAKE_FILE_TOKEN")"
assert_line "$OUT" "match_github=yes" "T12 GITHUB_TOKEN = the operator override"
assert_line "$OUT" "match_gh=yes" "T12 GH_TOKEN re-pointed at the override (gh reads GH_TOKEN first)"
assert_line "$OUT" "forbid_hit=no" "T12 the projected shared-file value survives under NEITHER name"
assert_line "$OUT" "source=operator-override" "T12 breadcrumb corrected to operator-override"
assert_line "$OUT" "agree=yes" "T12 the two names agree"
assert_line "$OUT" "exported=GH" "T12 both names still reach the nohup'd child"

# ─── 13: reconcile is a NO-OP when execution-core.env sets no token ───────────
echo ""
echo "test 13: execution-core.env sets no token → reconcile is a no-op (source stays shared-file)"
OUT="$(probe T13 CATALYST_GITHUB_TOKEN_FILE="$T/file.token" \
  RECONCILE="$T/reconcile.sh" ENV_FILE="$T/env-no-token.env" \
  EXPECT_VALUE="$FAKE_FILE_TOKEN" FORBID_VALUE="$FAKE_OVERRIDE_TOKEN")"
assert_line "$OUT" "source=shared-file" "T13 breadcrumb NOT falsely flipped to operator-override"
assert_line "$OUT" "match_github=yes" "T13 GITHUB_TOKEN still the shared-file value"
assert_line "$OUT" "match_gh=yes" "T13 GH_TOKEN still the shared-file value"
assert_line "$OUT" "forbid_hit=no" "T13 no override value materialized from nowhere"
assert_line "$OUT" "agree=yes" "T13 the two names agree"

# ─── 14: reconcile never installs an EMPTY override ───────────────────────────
echo ""
echo "test 14: execution-core.env sets GITHUB_TOKEN='' → reconcile installs nothing empty"
OUT="$(probe T14 CATALYST_GITHUB_TOKEN_FILE="$T/file.token" \
  RECONCILE="$T/reconcile.sh" ENV_FILE="$T/env-override-empty.env" \
  EXPECT_VALUE="$FAKE_FILE_TOKEN")"
assert_line "$OUT" "gh_token=set" "T14 GH_TOKEN not blanked by an empty primary"
assert_line "$OUT" "match_gh=yes" "T14 GH_TOKEN keeps the projected value (still authenticates)"
assert_line "$OUT" "source=shared-file" "T14 an empty primary is not an operator override"
# Deliberate asymmetry: the operator's own empty GITHUB_TOKEN must NOT drag the working
# GH_TOKEN down with it — a reconcile that mirrored "" would leave `gh` with no credential.
assert_line "$OUT" "agree=no" "T14 the empty primary is not mirrored onto GH_TOKEN"

# ─── 15: reconcile is a no-op in the "inherited" and "none" ladders ───────────
echo ""
echo "test 15: reconcile is a no-op when there is no shared file (inherited / none)"
OUT="$(probe T15a CATALYST_GITHUB_TOKEN_FILE="$MISSING_TOKEN_FILE" \
  GITHUB_TOKEN="$FAKE_AMBIENT_GITHUB" \
  RECONCILE="$T/reconcile.sh" ENV_FILE="$T/env-no-token.env" \
  EXPECT_VALUE="$FAKE_AMBIENT_GITHUB")"
assert_line "$OUT" "source=inherited" "T15a inherited breadcrumb survives the reconcile"
assert_line "$OUT" "match_github=yes" "T15a inherited GITHUB_TOKEN untouched"
assert_line "$OUT" "match_gh=yes" "T15a inherited GH_TOKEN untouched"
OUT="$(probe T15b CATALYST_GITHUB_TOKEN_FILE="$MISSING_TOKEN_FILE" \
  RECONCILE="$T/reconcile.sh" ENV_FILE="$T/env-no-token.env")"
assert_line "$OUT" "source=none" "T15b none breadcrumb survives the reconcile"
assert_line "$OUT" "github_token=unset" "T15b GITHUB_TOKEN still unset"
assert_line "$OUT" "gh_token=unset" "T15b GH_TOKEN still unset"
assert_line "$OUT" "exported=none" "T15b reconcile manufactures nothing for a child to see"

# ─── 16: XDG_CONFIG_HOME resolution of the default token path ─────────────────
echo ""
echo "test 16: default path is \${XDG_CONFIG_HOME:-\$HOME/.config}/catalyst/github-token (matches setup-webhooks.sh:23)"
mkdir -p "$T/xdg-home/.config/catalyst" "$T/xdg-config/catalyst" "$T/xdg-empty/catalyst"
printf '%s\n' "$FAKE_HOME_CONFIG_TOKEN" > "$T/xdg-home/.config/catalyst/github-token"
printf '%s\n' "$FAKE_XDG_TOKEN" > "$T/xdg-config/catalyst/github-token"
# XDG set → read from there, NOT from ~/.config (the pre-fix hardcoded path).
OUT="$(probe T16a HOME="$T/xdg-home" XDG_CONFIG_HOME="$T/xdg-config" \
  EXPECT_VALUE="$FAKE_XDG_TOKEN" FORBID_VALUE="$FAKE_HOME_CONFIG_TOKEN")"
assert_line "$OUT" "source=shared-file" "T16a XDG_CONFIG_HOME token file is found"
assert_line "$OUT" "match_github=yes" "T16a GITHUB_TOKEN = the XDG_CONFIG_HOME file"
assert_line "$OUT" "match_gh=yes" "T16a GH_TOKEN = the XDG_CONFIG_HOME file"
assert_line "$OUT" "forbid_hit=no" "T16a ~/.config is NOT consulted when XDG_CONFIG_HOME is set"
# XDG unset → the ~/.config fallback arm of the `:-` still works.
OUT="$(probe T16b HOME="$T/xdg-home" \
  EXPECT_VALUE="$FAKE_HOME_CONFIG_TOKEN" FORBID_VALUE="$FAKE_XDG_TOKEN")"
assert_line "$OUT" "source=shared-file" "T16b ~/.config fallback still resolves when XDG_CONFIG_HOME is unset"
assert_line "$OUT" "match_github=yes" "T16b GITHUB_TOKEN = the ~/.config file"
assert_line "$OUT" "match_gh=yes" "T16b GH_TOKEN = the ~/.config file"
assert_line "$OUT" "forbid_hit=no" "T16b no cross-talk from the XDG dir"
# XDG set but empty → REPLACES ~/.config (XDG semantics), so nothing is found.
OUT="$(probe T16c HOME="$T/xdg-home" XDG_CONFIG_HOME="$T/xdg-empty" \
  FORBID_VALUE="$FAKE_HOME_CONFIG_TOKEN")"
assert_line "$OUT" "source=none" "T16c XDG_CONFIG_HOME REPLACES ~/.config (no silent second lookup)"
assert_line "$OUT" "forbid_hit=no" "T16c the ~/.config token is not smuggled in behind XDG"
assert_line "$OUT" "exported=none" "T16c nothing exported when the XDG path holds no file"

# ─── 17: wiring — reconcile runs AFTER the execution-core.env source ──────────
echo ""
echo "test 17: catalyst_reconcile_github_token_aliases is WIRED into cmd_start AFTER the execution-core.env source"
RECONCILE_CALL_LINES="$(grep -nE '^[[:space:]]*catalyst_reconcile_github_token_aliases([[:space:]]|$)' "$SCRIPT" | cut -d: -f1)"
RECONCILE_CALL_COUNT="$(printf '%s\n' "$RECONCILE_CALL_LINES" | grep -c '[0-9]' || true)"
RECONCILE_CALL_LINE="$(printf '%s\n' "$RECONCILE_CALL_LINES" | head -1)"
if [[ "$RECONCILE_CALL_COUNT" == "1" ]]; then
  pass "T17 exactly one catalyst_reconcile_github_token_aliases invocation site"
else
  fail "T17 expected exactly one invocation site" \
    "found $RECONCILE_CALL_COUNT (lines: $(tr '\n' ' ' <<<"$RECONCILE_CALL_LINES"))"
fi
if [[ -n "$RECONCILE_CALL_LINE" && -n "$ENV_SOURCE_LINE" ]] \
  && [[ "$RECONCILE_CALL_LINE" -gt "$ENV_SOURCE_LINE" ]]; then
  pass "T17 invoked AFTER execution-core.env is sourced (line $RECONCILE_CALL_LINE > $ENV_SOURCE_LINE)"
else
  fail "T17 invocation must FOLLOW the execution-core.env source" \
    "reconcile=$RECONCILE_CALL_LINE env_source=$ENV_SOURCE_LINE"
fi
if [[ -n "$RECONCILE_CALL_LINE" && -n "$CALL_LINE" ]] && [[ "$RECONCILE_CALL_LINE" -gt "$CALL_LINE" ]]; then
  pass "T17 full ladder order holds: project ($CALL_LINE) < env source ($ENV_SOURCE_LINE) < reconcile ($RECONCILE_CALL_LINE)"
else
  fail "T17 reconcile must follow the projection" \
    "project=$CALL_LINE reconcile=$RECONCILE_CALL_LINE"
fi
# The guard is only meaningful if the projection records what IT exported — without this
# breadcrumb every projection would look like an operator override.
if grep -q '_CATALYST_PROJECTED_GITHUB_TOKEN=' "$T/helper.sh"; then
  pass "T17 the projection records _CATALYST_PROJECTED_GITHUB_TOKEN (the no-op guard's input)"
else
  fail "T17 projection must record _CATALYST_PROJECTED_GITHUB_TOKEN for the reconcile guard"
fi

# ─── 18: secret hygiene re-scan, now covering the reconcile + XDG cases ───────
echo ""
echo "test 18: secret hygiene re-scan across the full transcript (incl. tests 12-16)"
TOTAL_STDOUT_LINES="$(grep -c '^stdout_bytes=' "$ALL_OUT" 2>/dev/null || echo 0)"
ZERO_STDOUT_LINES="$(grep -c '^stdout_bytes=0$' "$ALL_OUT" 2>/dev/null || echo 0)"
TOTAL_STDERR_LINES="$(grep -c '^stderr_bytes=' "$ALL_OUT" 2>/dev/null || echo 0)"
ZERO_STDERR_LINES="$(grep -c '^stderr_bytes=0$' "$ALL_OUT" 2>/dev/null || echo 0)"
if [[ "$TOTAL_STDOUT_LINES" -gt 0 && "$TOTAL_STDOUT_LINES" == "$ZERO_STDOUT_LINES" \
  && "$TOTAL_STDERR_LINES" == "$ZERO_STDERR_LINES" ]]; then
  pass "T18 both helpers stayed silent in all $TOTAL_STDOUT_LINES cases (stdout + stderr)"
else
  fail "T18 the helpers must never write to stdout/stderr" \
    "cases=$TOTAL_STDOUT_LINES silent_out=$ZERO_STDOUT_LINES silent_err=$ZERO_STDERR_LINES"
fi
LEAKED=""
for fixture in "$FAKE_FILE_TOKEN" "$FAKE_AMBIENT_GITHUB" "$FAKE_AMBIENT_GH" \
  "$FAKE_OVERRIDE_TOKEN" "$FAKE_XDG_TOKEN" "$FAKE_HOME_CONFIG_TOKEN"; do
  grep -qF "$fixture" "$ALL_OUT" && LEAKED="yes"
done
if [[ -z "$LEAKED" ]]; then
  pass "T18 no fixture token VALUE appears in the transcript (booleans/digests only)"
else
  fail "T18 a token value leaked into the transcript"
fi
if grep -qE 'ghp_|gho_|ghu_|ghs_|ghr_|github_pat_' "$ALL_OUT"; then
  fail "T18 transcript contains a token-shaped string"
else
  pass "T18 transcript contains no token-shaped string (no gh* prefix)"
fi

# ─── 19: Codex round-2 P1 #6 — the cluster-sync destination outranks XDG ───────
# cluster-sync WRITES bare secrets into dirname(getLayer2ConfigPath()), whose default is
# a HARDCODED ~/.config/catalyst — it is NOT XDG-aware. Reading only the XDG path (the
# round-1 fix) would miss every rotation on an XDG host: strictly worse than the
# hardcoded read it replaced. The reader is now a CHAIN: writer's dir first, XDG second.
echo "test 19: resolution chain — cluster-sync destination outranks XDG_CONFIG_HOME"
# The probe harness pins CATALYST_LAYER2_CONFIG_FILE="$T/layer2.json", so the
# cluster-sync destination this reader must prefer is dirname(that) = "$T" — the same
# resolution the WRITER uses. Placing the fixture there proves the reader follows the
# Layer-2 override exactly as cluster-sync does, not merely a hardcoded ~/.config.
mkdir -p "$T/xdghome/catalyst"
printf '%s' "$FAKE_FILE_TOKEN" > "$T/github-token"
printf 'ghp_XDG-FAKE-DECOY-0000000000000000000' > "$T/xdghome/catalyst/github-token"
OUT="$(probe T19a XDG_CONFIG_HOME="$T/xdghome" EXPECT_VALUE="$FAKE_FILE_TOKEN" \
  FORBID_VALUE='ghp_XDG-FAKE-DECOY-0000000000000000000')"
assert_line "$OUT" "source=shared-file" "T19a armed from a file"
assert_line "$OUT" "match_github=yes" "T19a took the cluster-sync destination, not the XDG decoy"
assert_line "$OUT" "forbid_hit=no" "T19a the XDG copy did NOT win"

# ...but the XDG copy is still a FALLBACK: on a host where only it exists, it must be found.
echo "test 19b: XDG copy is still found when the cluster-sync destination is absent"
rm -f "$T/github-token"
printf '%s' "$FAKE_FILE_TOKEN" > "$T/xdghome/catalyst/github-token"
OUT="$(probe T19b XDG_CONFIG_HOME="$T/xdghome" EXPECT_VALUE="$FAKE_FILE_TOKEN")"
assert_line "$OUT" "source=shared-file" "T19b armed from the XDG fallback"
assert_line "$OUT" "match_github=yes" "T19b XDG fallback value used"
rm -f "$T/xdghome/catalyst/github-token"

# ─── 20: Codex round-2 P2 #8 — a GH_TOKEN-only operator override must survive ──
# execution-core.env may override EITHER alias. Round-1 only handled the
# GITHUB_TOKEN-only case: a GH_TOKEN-only override left GITHUB_TOKEN equal to the
# projected value, so the reconcile early-returned, provenance stayed "shared-file", and
# the post-sync re-arm then overwrote BOTH names with the shared-file value — silently
# defeating an explicit operator override. GH_TOKEN wins when it is the one that moved,
# because that is the name `gh` resolves first.
echo "test 20: a GH_TOKEN-only operator override wins and is mirrored onto GITHUB_TOKEN"
printf '%s' "$FAKE_FILE_TOKEN" > "$T/file.token"
OUT="$(
  env -i PATH="$PATH" HOME="$T/home" HELPER="$T/helper.sh" \
    CATALYST_GITHUB_TOKEN_FILE="$T/file.token" RECONCILE="$T/reconcile.sh" \
    CATALYST_LAYER2_CONFIG_FILE="$T/layer2.json" \
    bash -c '
      # shellcheck disable=SC1090
      source "$HELPER"
      # shellcheck disable=SC1090
      source "$RECONCILE"
      catalyst_project_github_token
      GH_TOKEN=ghp_GHONLY-FAKE-OVERRIDE-000000000   # execution-core.env sets ONLY GH_TOKEN
      catalyst_reconcile_github_token_aliases
      echo "source=$CATALYST_GITHUB_TOKEN_SOURCE"
      [ "$GH_TOKEN" = ghp_GHONLY-FAKE-OVERRIDE-000000000 ] && echo "gh_is_override=yes" || echo "gh_is_override=no"
      [ "$GITHUB_TOKEN" = "$GH_TOKEN" ] && echo "agree=yes" || echo "agree=no"
    '
)"
printf '### T20\n%s\n' "$OUT" >> "$ALL_OUT"
assert_line "$OUT" "source=operator-override" "T20 provenance corrected to operator-override"
assert_line "$OUT" "gh_is_override=yes" "T20 the GH_TOKEN-only override survived"
assert_line "$OUT" "agree=yes" "T20 GITHUB_TOKEN mirrored onto the winning override"

echo "test 20b: an override that BLANKS a name is not treated as a credential"
OUT="$(
  env -i PATH="$PATH" HOME="$T/home" HELPER="$T/helper.sh" \
    CATALYST_GITHUB_TOKEN_FILE="$T/file.token" RECONCILE="$T/reconcile.sh" \
    CATALYST_LAYER2_CONFIG_FILE="$T/layer2.json" \
    bash -c '
      # shellcheck disable=SC1090
      source "$HELPER"
      # shellcheck disable=SC1090
      source "$RECONCILE"
      catalyst_project_github_token
      GH_TOKEN=""
      catalyst_reconcile_github_token_aliases
      echo "source=$CATALYST_GITHUB_TOKEN_SOURCE"
      [ -n "$GITHUB_TOKEN" ] && echo "primary_still_set=yes" || echo "primary_still_set=no"
    '
)"
printf '### T20b\n%s\n' "$OUT" >> "$ALL_OUT"
assert_line "$OUT" "source=shared-file" "T20b a blanked alias does not claim operator-override"
assert_line "$OUT" "primary_still_set=yes" "T20b the working projected credential is preserved"

# ─── 21: Codex round-3 — INTERNAL whitespace is PRESERVED, only the edges trimmed ─
# The reader used to be `tr -d '[:space:]'`, which deletes EVERY space/tab/newline in the
# file, not just the trailing one the writer appends. A secret is an opaque byte string,
# so any value containing a space or a tab was silently truncated into a different, wrong
# credential — and the failure mode is invisible: the variable looks present, `gh` simply
# 401s and the launcher reports source=shared-file either way. T9 pinned the trailing
# newline; these pin the bytes in the MIDDLE, which is the half `tr -d` got wrong.
#
# The assertion is a digest comparison against the exact expected string (plus the probe's
# own in-process EXPECT_VALUE equality). Under the old reader both the digest and the
# equality flip, so this is a real discriminator — and neither ever prints the value.
echo ""
echo "test 21: internal whitespace survives the read (the tr -d '[:space:]' corruption)"
# CTL-1612 (round 4): the contract is EOL-ONLY stripping. A credential may legitimately
# begin or end with a space/tab, and trimming those bytes yields a different key — for an
# HMAC secret that silently rejects every correctly-signed delivery. So the fixture carries
# significant boundary whitespace AND one trailing newline, and the expectation keeps the
# edges while losing only the newline.
SPACE_WITH_EDGES="  ${FAKE_INTERNAL_SPACE}  "
printf '%s\n' "$SPACE_WITH_EDGES" > "$T/internal-space.token"
EXPECT_DIGEST="$(printf '%s' "$SPACE_WITH_EDGES" | shasum | cut -c1-12)"
OUT="$(probe T21a CATALYST_GITHUB_TOKEN_FILE="$T/internal-space.token" \
  EXPECT_VALUE="$SPACE_WITH_EDGES")"
assert_line "$OUT" "source=shared-file" "T21a source=shared-file"
assert_line "$OUT" "match_github=yes" "T21a GITHUB_TOKEN keeps internal AND boundary spaces"
assert_line "$OUT" "match_gh=yes" "T21a GH_TOKEN keeps internal AND boundary spaces"
assert_line "$OUT" "digest_github=$EXPECT_DIGEST" "T21a GITHUB_TOKEN digests to the exact expected string"
assert_line "$OUT" "digest_gh=$EXPECT_DIGEST" "T21a GH_TOKEN digests to the exact expected string"

TAB_WITH_EDGES="\t${FAKE_INTERNAL_TAB}\t"
printf '%b\n' "$TAB_WITH_EDGES" > "$T/internal-tab.token"
EXPECT_DIGEST="$(printf '%b' "$TAB_WITH_EDGES" | shasum | cut -c1-12)"
OUT="$(probe T21b CATALYST_GITHUB_TOKEN_FILE="$T/internal-tab.token" \
  EXPECT_VALUE="$(printf %b "$TAB_WITH_EDGES")")"
assert_line "$OUT" "match_github=yes" "T21b GITHUB_TOKEN keeps internal AND boundary tabs"
assert_line "$OUT" "match_gh=yes" "T21b GH_TOKEN keeps internal AND boundary tabs"
assert_line "$OUT" "digest_github=$EXPECT_DIGEST" "T21b only the EOL is stripped — boundary tabs survive (exact digest)"
assert_line "$OUT" "digest_gh=$EXPECT_DIGEST" "T21b same exact digest under the GH_TOKEN alias"

# The trim must not be reintroduced as a delete. The lib documents the old call in prose,
# so strip comments before grepping — otherwise the explanation trips its own guard.
LIB_CODE="$(grep -vE '^[[:space:]]*(#|$)' "$T/helper.sh")"
if grep -qE "tr[[:space:]]+-d" <<<"$LIB_CODE"; then
  fail "T21c the shared lib deletes characters with \`tr -d\` again (internal-whitespace corrupter)"
else
  pass "T21c the shared lib trims edges only — no \`tr -d\` character deletion"
fi

# ─── 22: whitespace-only is still EMPTY — with nothing inherited to fall back to ──
# The trim must not soften the emptiness test: a file holding only spaces/tabs is a
# non-credential, and exporting its trimmed "" would be worse than not reading it at all
# (bash ${X:-default} and JS ?? both treat "" as SET). T4 pins the `inherited` arm of the
# same ladder; this pins the `none` arm, where there is nothing to fall back to.
echo ""
echo "test 22: whitespace-only file + nothing inherited → still empty, source=none"
printf ' \t \n\t\n  ' > "$T/ws-only.token"
OUT="$(probe T22 CATALYST_GITHUB_TOKEN_FILE="$T/ws-only.token")"
assert_line "$OUT" "source=none" "T22 whitespace-only file is not a credential (source=none)"
assert_line "$OUT" "github_token=unset" "T22 GITHUB_TOKEN left unset"
assert_line "$OUT" "gh_token=unset" "T22 GH_TOKEN left unset"
assert_line "$OUT" "empty_export=no" "T22 the trimmed-to-empty value is never exported as \"\""
assert_line "$OUT" "exported=none" "T22 neither name reaches a child process"

# ─── 23: the same reader under the HMAC signing key, via catalyst_read_secret_file ─
# This is where the corruption actually bites hardest. The webhook secret is an HMAC
# signing key: a single mangled byte makes every inbound GitHub delivery fail signature
# verification, with no error logged anywhere — the monitor just goes quiet. Both the
# low-level reader and the webhook projection are exercised by name here, since
# catalyst_project_webhook_secret is the other consumer of the shared chain.
echo ""
echo "test 23: catalyst_read_secret_file preserves internal whitespace for the HMAC key"
# CTL-1612 (round 4): EOL-ONLY. An HMAC key may legitimately begin or end with a space —
# trimming it produces a different key and silently rejects every correctly-signed
# delivery, which is the same failure class as the `tr -d` corruption this replaced.
HMAC_WITH_EDGES=" ${FAKE_HMAC_INTERNAL} "
printf '%s\n' "$HMAC_WITH_EDGES" > "$T/webhook-secret-internal"
EXPECT_DIGEST="$(printf '%s' "$HMAC_WITH_EDGES" | shasum | cut -c1-12)"
OUT="$(
  env -i PATH="$PATH" HOME="$T/home" HELPER="$T/helper.sh" \
    CATALYST_LAYER2_CONFIG_FILE="$T/layer2.json" \
    SECRET_FILE="$T/webhook-secret-internal" \
    bash -c '
      # shellcheck disable=SC1090
      source "$HELPER"
      raw=""
      rc=1
      raw="$(catalyst_read_secret_file "webhook-secret" "$SECRET_FILE")" && rc=0
      echo "read_rc=$rc"
      echo "digest_read=$(printf "%s" "$raw" | shasum | cut -c1-12)"
      CATALYST_WEBHOOK_SECRET_FILE="$SECRET_FILE" catalyst_project_webhook_secret
      s=unset; [ -n "${CATALYST_WEBHOOK_SECRET+x}" ] && s=set
      echo "webhook_secret=$s"
      d=none; [ "$s" = set ] && d="$(printf "%s" "$CATALYST_WEBHOOK_SECRET" | shasum | cut -c1-12)"
      echo "digest_webhook=$d"
    '
)"
printf '### T23\n%s\n' "$OUT" >> "$ALL_OUT"
assert_line "$OUT" "read_rc=0" "T23 catalyst_read_secret_file found the file"
assert_line "$OUT" "digest_read=$EXPECT_DIGEST" "T23 the reader returns the exact bytes (only the EOL removed)"
assert_line "$OUT" "webhook_secret=set" "T23 catalyst_project_webhook_secret exported the key"
assert_line "$OUT" "digest_webhook=$EXPECT_DIGEST" "T23 the exported HMAC key is byte-identical to the file value"

echo "test 23b: a whitespace-only HMAC file exports nothing (an empty secret DISABLES the route)"
printf '  \n\t\n' > "$T/webhook-secret-ws"
OUT="$(
  env -i PATH="$PATH" HOME="$T/home" HELPER="$T/helper.sh" \
    CATALYST_LAYER2_CONFIG_FILE="$T/layer2.json" \
    CATALYST_WEBHOOK_SECRET_FILE="$T/webhook-secret-ws" \
    bash -c '
      # shellcheck disable=SC1090
      source "$HELPER"
      catalyst_project_webhook_secret
      s=unset; [ -n "${CATALYST_WEBHOOK_SECRET+x}" ] && s=set
      echo "webhook_secret=$s"
      echo "exported=$(bash -c "printf %s \"\${CATALYST_WEBHOOK_SECRET+W}\"")"
    '
)"
printf '### T23b\n%s\n' "$OUT" >> "$ALL_OUT"
assert_line "$OUT" "webhook_secret=unset" "T23b whitespace-only HMAC file leaves the name unset, never \"\""
assert_line "$OUT" "exported=" "T23b nothing reaches the monitor child (webhook-config would read \"\" as unconfigured)"

# ─── 23c: Codex round-5 — ALL trailing line terminators strip, not just the last ─
# The bash read path (`$(cat …)`) eats every trailing \n, but a CRLF file ending in
# `\r\n\r\n` left `token\r\n` behind under the old single-pass strip — and the JS re-arm
# (github-auth-preflight.mjs) had the same single-terminator bug against `\n\n`, so a
# rotation re-armed to `token\n` and 401'd. Both sides now strip /[\r\n]+$/; this pins
# the bash half (the .mjs suite pins the JS half).
echo ""
echo "test 23c: a CRLF-CRLF file yields the bare token — every trailing terminator removed"
printf '%s\r\n\r\n' "$FAKE_FILE_TOKEN" > "$T/crlf-multi.token"
EXPECT_DIGEST="$(printf '%s' "$FAKE_FILE_TOKEN" | shasum | cut -c1-12)"
OUT="$(probe T23c CATALYST_GITHUB_TOKEN_FILE="$T/crlf-multi.token" EXPECT_VALUE="$FAKE_FILE_TOKEN")"
assert_line "$OUT" "source=shared-file" "T23c source=shared-file"
assert_line "$OUT" "match_github=yes" "T23c GITHUB_TOKEN is the bare token"
assert_line "$OUT" "match_gh=yes" "T23c GH_TOKEN is the bare token"
assert_line "$OUT" "digest_github=$EXPECT_DIGEST" "T23c exact digest — no residual CR or LF byte"
assert_line "$OUT" "digest_gh=$EXPECT_DIGEST" "T23c same digest under the GH_TOKEN alias"

# ─── 23d: Codex round-5 — the assignment probe sources the env file ONCE, not per alias ─
# An env file may carry executed commands (a command substitution fetching a token, a
# rate-limited credential-helper call). cmd_start sources it once for real; the round-4
# per-alias sentinel probe then re-sourced it once per name, tripling every side effect
# on each daemon start. The batch probe keeps detection semantics but adds exactly ONE
# extra execution, so the file runs twice total here: the real source + one probe.
echo ""
echo "test 23d: executed-override detection costs ONE extra env-file execution, not one per alias"
FAKE_ENVFILE_TOKEN='FAKE-CTL1612-envfile-side-effect-token-JJJJ'
printf '%s\n' "$FAKE_FILE_TOKEN" > "$T/file.token"
: > "$T/side-effects.log"
cat > "$T/side-effect.env" <<'ENVF'
echo ran >> "$CATALYST_TEST_SIDE_EFFECT_LOG"
GITHUB_TOKEN="$FAKE_ENVFILE_TOKEN_VALUE"
ENVF
OUT="$(
  env -i PATH="$PATH" HOME="$T/home" HELPER="$T/helper.sh" \
    CATALYST_GITHUB_TOKEN_FILE="$T/file.token" \
    CATALYST_LAYER2_CONFIG_FILE="$T/layer2.json" \
    CATALYST_TEST_SIDE_EFFECT_LOG="$T/side-effects.log" \
    FAKE_ENVFILE_TOKEN_VALUE="$FAKE_ENVFILE_TOKEN" \
    ENV_FILE="$T/side-effect.env" \
    bash -c '
      # shellcheck disable=SC1090
      source "$HELPER"
      catalyst_project_github_token
      # cmd_start sources the operator env file for real…
      # shellcheck disable=SC1090
      source "$ENV_FILE"
      # …then reconcile probes it — which must add exactly ONE more execution.
      catalyst_reconcile_github_token_aliases "$ENV_FILE"
      echo "source=$CATALYST_GITHUB_TOKEN_SOURCE"
      echo "executions=$(wc -l < "$CATALYST_TEST_SIDE_EFFECT_LOG" | tr -d " ")"
      m=no; [ "$GITHUB_TOKEN" = "$FAKE_ENVFILE_TOKEN_VALUE" ] && [ "$GH_TOKEN" = "$FAKE_ENVFILE_TOKEN_VALUE" ] && m=yes
      echo "override_won=$m"
    '
)"
printf '### T23d\n%s\n' "$OUT" >> "$ALL_OUT"
assert_line "$OUT" "source=operator-override" "T23d the executed assignment is still detected by the batch probe"
assert_line "$OUT" "override_won=yes" "T23d both aliases re-pointed at the operator's value"
assert_line "$OUT" "executions=2" "T23d env file ran twice (real source + ONE batch probe), not once per alias"

# ─── 24: hygiene re-scan covering the round-3 whitespace fixtures ──────────────
echo ""
echo "test 24: secret hygiene re-scan across the full transcript (incl. tests 21-23)"
TOTAL_STDOUT_LINES="$(grep -c '^stdout_bytes=' "$ALL_OUT" 2>/dev/null || echo 0)"
ZERO_STDOUT_LINES="$(grep -c '^stdout_bytes=0$' "$ALL_OUT" 2>/dev/null || echo 0)"
TOTAL_STDERR_LINES="$(grep -c '^stderr_bytes=' "$ALL_OUT" 2>/dev/null || echo 0)"
ZERO_STDERR_LINES="$(grep -c '^stderr_bytes=0$' "$ALL_OUT" 2>/dev/null || echo 0)"
if [[ "$TOTAL_STDOUT_LINES" -gt 0 && "$TOTAL_STDOUT_LINES" == "$ZERO_STDOUT_LINES" \
  && "$TOTAL_STDERR_LINES" == "$ZERO_STDERR_LINES" ]]; then
  pass "T24 the helpers stayed silent in all $TOTAL_STDOUT_LINES probe cases"
else
  fail "T24 the helpers must never write to stdout/stderr" \
    "cases=$TOTAL_STDOUT_LINES silent_out=$ZERO_STDOUT_LINES silent_err=$ZERO_STDERR_LINES"
fi
LEAKED=""
for fixture in "$FAKE_FILE_TOKEN" "$FAKE_AMBIENT_GITHUB" "$FAKE_AMBIENT_GH" \
  "$FAKE_OVERRIDE_TOKEN" "$FAKE_XDG_TOKEN" "$FAKE_HOME_CONFIG_TOKEN" \
  "$FAKE_INTERNAL_SPACE" "$FAKE_INTERNAL_TAB" "$FAKE_HMAC_INTERNAL"; do
  grep -qF "$fixture" "$ALL_OUT" && LEAKED="yes"
done
if [[ -z "$LEAKED" ]]; then
  pass "T24 no fixture VALUE appears in the transcript, including the whitespace-bearing ones"
else
  fail "T24 a secret value leaked into the transcript"
fi
if grep -qE 'ghp_|gho_|ghu_|ghs_|ghr_|github_pat_' "$ALL_OUT"; then
  fail "T24 transcript contains a token-shaped string"
else
  pass "T24 transcript contains no token-shaped string (no gh* prefix)"
fi

echo ""
echo "─────────────────────────────────────────────"
echo "catalyst-execution-core-github-token: ${PASSES} passed, ${FAILURES} failed"
if [[ $FAILURES -gt 0 ]]; then
  exit 1
fi
exit 0
