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
# CTL-1612 (Codex P2) adds a SECOND helper to the same ladder,
# `_reconcile_github_token_aliases`, which runs AFTER execution-core.env is sourced.
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

# ─── Extract the helpers under test ───────────────────────────────────────────
sed -n '/^_project_shared_github_token() {/,/^}/p' "$SCRIPT" > "$T/helper.sh"
if [[ ! -s "$T/helper.sh" ]] || ! grep -q 'CATALYST_GITHUB_TOKEN_SOURCE' "$T/helper.sh"; then
  echo "FATAL: could not extract _project_shared_github_token from $SCRIPT" >&2
  exit 1
fi
sed -n '/^_reconcile_github_token_aliases() {/,/^}/p' "$SCRIPT" > "$T/reconcile.sh"
if [[ ! -s "$T/reconcile.sh" ]] || ! grep -q 'operator-override' "$T/reconcile.sh"; then
  echo "FATAL: could not extract _reconcile_github_token_aliases from $SCRIPT" >&2
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

# CTL-1612 (Codex P2) stage 2 — opt-in, inert unless the case supplies RECONCILE, so
# tests 1-9 run byte-identically. Replays cmd_start's post-projection sequence: source
# execution-core.env (the operator override), THEN reconcile the two names.
if [[ -n "${RECONCILE:-}" ]]; then
  # shellcheck disable=SC1090
  source "$RECONCILE"
  # shellcheck disable=SC1090
  [[ -n "${ENV_FILE:-}" && -f "${ENV_FILE}" ]] && source "$ENV_FILE"
  _reconcile_github_token_aliases >>"$STDOUT_CAP" 2>>"$STDERR_CAP"
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
echo "test 17: _reconcile_github_token_aliases is WIRED into cmd_start AFTER the execution-core.env source"
RECONCILE_CALL_LINES="$(grep -nE '^[[:space:]]*_reconcile_github_token_aliases[[:space:]]*$' "$SCRIPT" | cut -d: -f1)"
RECONCILE_CALL_COUNT="$(printf '%s\n' "$RECONCILE_CALL_LINES" | grep -c '[0-9]' || true)"
RECONCILE_CALL_LINE="$(printf '%s\n' "$RECONCILE_CALL_LINES" | head -1)"
if [[ "$RECONCILE_CALL_COUNT" == "1" ]]; then
  pass "T17 exactly one _reconcile_github_token_aliases invocation site"
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
      _project_shared_github_token
      GH_TOKEN=ghp_GHONLY-FAKE-OVERRIDE-000000000   # execution-core.env sets ONLY GH_TOKEN
      _reconcile_github_token_aliases
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
      _project_shared_github_token
      GH_TOKEN=""
      _reconcile_github_token_aliases
      echo "source=$CATALYST_GITHUB_TOKEN_SOURCE"
      [ -n "$GITHUB_TOKEN" ] && echo "primary_still_set=yes" || echo "primary_still_set=no"
    '
)"
printf '### T20b\n%s\n' "$OUT" >> "$ALL_OUT"
assert_line "$OUT" "source=shared-file" "T20b a blanked alias does not claim operator-override"
assert_line "$OUT" "primary_still_set=yes" "T20b the working projected credential is preserved"


echo ""
echo "─────────────────────────────────────────────"
echo "catalyst-execution-core-github-token: ${PASSES} passed, ${FAILURES} failed"
if [[ $FAILURES -gt 0 ]]; then
  exit 1
fi
exit 0
