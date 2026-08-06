#!/usr/bin/env bash
# A/B parity: lib/catalyst-secret-env.sh's catalyst_project_github_token /
# catalyst_project_webhook_secret (CTL-1623 fold — the FILE-READ tier now delegates to
# lib/catalyst-secret-contract.sh's catalyst_resolve_secret) vs a FROZEN, test-local,
# verbatim copy of the pre-fold implementation (catalyst_read_secret_file +
# _catalyst_secret_dirs, exactly as the two wrappers called them before this ticket).
#
# WHY A FROZEN COPY, NOT THE LIVE catalyst_read_secret_file: that primitive itself is
# UNCHANGED by CTL-1623 (other callers still use it directly), so referencing the live
# function would usually be equivalent — but it would also mean a future accidental edit to
# catalyst_read_secret_file silently moves BOTH the "legacy" and the "new" side of this
# comparison together, defeating the parity guard's whole purpose (catching drift). The copy
# below is pinned to what catalyst-secret-env.sh actually did before this PR.
#
# THIS SUITE MUST FAIL ON DIVERGENCE — every cell is an exact-string assertion, never a fuzzy
# comparison, on the real (unmodified) lib/catalyst-secret-env.sh sourced from its real
# on-disk location (so its BASH_SOURCE-relative `source .../catalyst-secret-contract.sh`
# resolves correctly — unlike __tests__/catalyst-execution-core-github-token.test.sh, this
# suite does not need to copy the lib into a scratch dir, since it never mutates or replaces
# the file under test).
#
# SECRET HYGIENE: every cell runs under `env -i` (real environment fully cleared) with HOME
# repointed at a scratch tmpdir. Fixtures are obviously-fake literals.
#
# Run: bash plugins/dev/scripts/__tests__/catalyst-secret-env-legacy-parity.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
LIB="${REPO_ROOT}/plugins/dev/scripts/lib/catalyst-secret-env.sh"

FAILURES=0
PASSES=0
ok() { PASSES=$((PASSES + 1)); }
fail() {
  local name="$1" detail="$2"
  FAILURES=$((FAILURES + 1))
  echo "  FAIL: $name"
  echo "    $detail"
}
expect_eq() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    ok
  else
    fail "$name" "expected='$expected' actual='$actual'"
  fi
}

if [[ ! -f "$LIB" ]]; then
  echo "  SKIP: catalyst-secret-env-legacy-parity (lib missing: $LIB)"
  echo ""
  echo "Total: 0, Passed: 0, Failed: 0, Skipped: 1"
  exit 0
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
SANDBOX_HOME="${TMP_DIR}/home"
mkdir -p "$SANDBOX_HOME"

# ─── FROZEN LEGACY REFERENCE (verbatim pre-CTL-1623 chain) ────────────────────────────────
LEGACY_LIB="${TMP_DIR}/legacy-secret-env.sh"
cat > "$LEGACY_LIB" <<'LEGACY'
#!/usr/bin/env bash
_legacy_strip_eol() {
  local s="$1"
  while [[ "$s" == *$'\n' || "$s" == *$'\r' ]]; do
    s="${s%$'\n'}"
    s="${s%$'\r'}"
  done
  printf '%s' "$s"
}
_legacy_is_blank() {
  [[ -z "${1//[[:space:]]/}" ]]
}
_legacy_secret_dirs() {
  local _l2="${CATALYST_LAYER2_CONFIG_FILE:-${HOME}/.config/catalyst/config.json}"
  printf '%s\n' "$(dirname "$_l2")"
  printf '%s\n' "${XDG_CONFIG_HOME:-${HOME}/.config}/catalyst"
}
legacy_read_secret_file() {
  local _base="${1:?basename required}"
  local _explicit_path="${2:-}" _explicit_dir="${3:-}"
  local _f _raw _val
  local -a _cands=()
  if [[ -n "$_explicit_path" ]]; then
    _cands=("$_explicit_path")
  elif [[ -n "$_explicit_dir" ]]; then
    _cands=("${_explicit_dir}/${_base}")
  else
    local _d
    while IFS= read -r _d; do
      [[ -n "$_d" ]] && _cands+=("${_d}/${_base}")
    done < <(_legacy_secret_dirs)
  fi
  for _f in "${_cands[@]}"; do
    [[ -r "$_f" ]] || continue
    _raw="$(cat "$_f" 2>/dev/null)" || continue
    _val="$(_legacy_strip_eol "$_raw")"
    if ! _legacy_is_blank "$_val"; then
      printf '%s' "$_val"
      return 0
    fi
  done
  return 1
}
legacy_project_github_token() {
  local _tok
  if _tok="$(legacy_read_secret_file "github-token" "${CATALYST_GITHUB_TOKEN_FILE:-}" "${CATALYST_CONFIG_DIR:-}")"; then
    export GITHUB_TOKEN="$_tok" GH_TOKEN="$_tok"
    export CATALYST_GITHUB_TOKEN_SOURCE="shared-file"
  elif [[ -n "${GH_TOKEN:-}" ]]; then
    export GH_TOKEN
    export CATALYST_GITHUB_TOKEN_SOURCE="inherited"
  elif [[ -n "${GITHUB_TOKEN:-}" ]]; then
    export GITHUB_TOKEN
    export GH_TOKEN="$GITHUB_TOKEN"
    export CATALYST_GITHUB_TOKEN_SOURCE="inherited"
  else
    export CATALYST_GITHUB_TOKEN_SOURCE="none"
  fi
}
legacy_project_webhook_secret() {
  local _val
  if _val="$(legacy_read_secret_file "webhook-secret" "${CATALYST_WEBHOOK_SECRET_FILE:-}" "${CATALYST_CONFIG_DIR:-}")"; then
    export CATALYST_WEBHOOK_SECRET="$_val"
  fi
}
LEGACY

# ─── probe helpers ──────────────────────────────────────────────────────────────────────
# Reports each var on its own line as NAME=set:<value> or NAME=unset — never pipe-joined
# (test cell (h) below deliberately puts a literal "|" INSIDE a token value, so a
# pipe-delimited report would itself be corrupted by the very hazard it exists to catch).
_report_github() {
  local n
  for n in GITHUB_TOKEN GH_TOKEN CATALYST_GITHUB_TOKEN_SOURCE; do
    if [[ -n "${!n+x}" ]]; then printf '%s=set:%s\n' "$n" "${!n}"; else printf '%s=unset\n' "$n"; fi
  done
}
_report_webhook() {
  if [[ -n "${CATALYST_WEBHOOK_SECRET+x}" ]]; then
    printf 'CATALYST_WEBHOOK_SECRET=set:%s\n' "$CATALYST_WEBHOOK_SECRET"
  else
    printf 'CATALYST_WEBHOOK_SECRET=unset\n'
  fi
}

# _cell_github NAME [ENV_VAR=VAL ...] -- runs BOTH the real (folded) and the frozen legacy
# catalyst_project_github_token under identical env -i fixtures, asserts byte-identical
# GITHUB_TOKEN/GH_TOKEN/CATALYST_GITHUB_TOKEN_SOURCE.
_cell_github() {
  local _name="$1"
  shift
  local NEW_OUT LEGACY_OUT
  NEW_OUT="$(env -i PATH="$PATH" HOME="$SANDBOX_HOME" "$@" bash -c "
    source '$LIB'
    catalyst_project_github_token
    $(declare -f _report_github)
    _report_github
  ")"
  LEGACY_OUT="$(env -i PATH="$PATH" HOME="$SANDBOX_HOME" "$@" bash -c "
    source '$LEGACY_LIB'
    legacy_project_github_token
    $(declare -f _report_github)
    _report_github
  ")"
  expect_eq "$_name" "$LEGACY_OUT" "$NEW_OUT"
}

# _cell_webhook NAME [ENV_VAR=VAL ...] -- same shape, for catalyst_project_webhook_secret.
_cell_webhook() {
  local _name="$1"
  shift
  local NEW_OUT LEGACY_OUT
  NEW_OUT="$(env -i PATH="$PATH" HOME="$SANDBOX_HOME" "$@" bash -c "
    source '$LIB'
    catalyst_project_webhook_secret
    $(declare -f _report_webhook)
    _report_webhook
  ")"
  LEGACY_OUT="$(env -i PATH="$PATH" HOME="$SANDBOX_HOME" "$@" bash -c "
    source '$LEGACY_LIB'
    legacy_project_webhook_secret
    $(declare -f _report_webhook)
    _report_webhook
  ")"
  expect_eq "$_name" "$LEGACY_OUT" "$NEW_OUT"
}

# ─── (a) explicit path override ─────────────────────────────────────────────────────────
OVERRIDE_DIR="${TMP_DIR}/override"
mkdir -p "$OVERRIDE_DIR"
printf 'override-tok' > "${OVERRIDE_DIR}/gh.token"
_cell_github "(a) CATALYST_GITHUB_TOKEN_FILE explicit override" \
  "CATALYST_GITHUB_TOKEN_FILE=${OVERRIDE_DIR}/gh.token"

printf 'override-whs' > "${OVERRIDE_DIR}/whs.token"
_cell_webhook "(a) CATALYST_WEBHOOK_SECRET_FILE explicit override" \
  "CATALYST_WEBHOOK_SECRET_FILE=${OVERRIDE_DIR}/whs.token"

# ─── (b) CATALYST_CONFIG_DIR explicit dir ───────────────────────────────────────────────
CFG_DIR="${TMP_DIR}/cfgdir"
mkdir -p "$CFG_DIR"
printf 'cfgdir-tok' > "${CFG_DIR}/github-token"
printf 'cfgdir-whs' > "${CFG_DIR}/webhook-secret"
_cell_github "(b) CATALYST_CONFIG_DIR explicit dir (github-token)" "CATALYST_CONFIG_DIR=${CFG_DIR}"
_cell_webhook "(b) CATALYST_CONFIG_DIR explicit dir (webhook-secret)" "CATALYST_CONFIG_DIR=${CFG_DIR}"

# ─── (c) CATALYST_LAYER2_CONFIG_FILE-derived dir ────────────────────────────────────────
L2_DIR="${TMP_DIR}/l2dir"
mkdir -p "$L2_DIR"
printf 'l2dir-tok' > "${L2_DIR}/github-token"
_cell_github "(c) CATALYST_LAYER2_CONFIG_FILE-derived dir" \
  "CATALYST_LAYER2_CONFIG_FILE=${L2_DIR}/config.json"

# ─── (d) default layer2 dir + XDG_CONFIG_HOME dedupe ────────────────────────────────────
# (d1) same-dir dedupe: no XDG_CONFIG_HOME set, so the default layer2 dir and the XDG dir
# are literally the same path — one candidate, not two.
DEDUPE_HOME="${TMP_DIR}/dedupe-home"
mkdir -p "${DEDUPE_HOME}/.config/catalyst"
printf 'dedupe-tok' > "${DEDUPE_HOME}/.config/catalyst/github-token"
_cell_github "(d1) default dir + XDG dedupe (same dir, one candidate)" \
  "HOME=${DEDUPE_HOME}"

# (d2) distinct XDG dir: the default layer2-dir candidate is absent; only the SEPARATE XDG
# candidate holds the file — both implementations must fall through to it identically.
XDG_HOME="${TMP_DIR}/xdg-home"
XDG_DIR="${TMP_DIR}/xdg-only"
mkdir -p "$XDG_HOME" "${XDG_DIR}/catalyst"
printf 'xdg-only-tok' > "${XDG_DIR}/catalyst/github-token"
_cell_github "(d2) distinct XDG_CONFIG_HOME (two-candidate case, second wins)" \
  "HOME=${XDG_HOME}" "XDG_CONFIG_HOME=${XDG_DIR}"

# ─── (e) file absent everywhere ─────────────────────────────────────────────────────────
ABSENT_HOME="${TMP_DIR}/absent-home"
mkdir -p "$ABSENT_HOME"
_cell_github "(e) file absent everywhere, nothing inherited (github-token)" "HOME=${ABSENT_HOME}"
_cell_webhook "(e) file absent everywhere (webhook-secret)" "HOME=${ABSENT_HOME}"
_cell_github "(e) file absent everywhere, GH_TOKEN inherited" "HOME=${ABSENT_HOME}" "GH_TOKEN=inherited-fallback"

# ─── (f) whitespace-only file — falls through, never exports "" ────────────────────────
BLANK_DIR="${TMP_DIR}/blank"
mkdir -p "$BLANK_DIR"
printf '   \t \n  ' > "${BLANK_DIR}/github-token"
_cell_github "(f) whitespace-only file, nothing inherited — falls through to none" \
  "CATALYST_CONFIG_DIR=${BLANK_DIR}"
_cell_github "(f) whitespace-only file, GH_TOKEN inherited — falls through to inherited" \
  "CATALYST_CONFIG_DIR=${BLANK_DIR}" "GH_TOKEN=fallback-after-blank"
printf '  \n\t\n' > "${BLANK_DIR}/webhook-secret"
_cell_webhook "(f) whitespace-only webhook file — never exports \"\"" \
  "CATALYST_CONFIG_DIR=${BLANK_DIR}"

# ─── (g) trailing \n, \r\n, \n\n stripping — byte-identical token ──────────────────────
EOL_DIR="${TMP_DIR}/eol"
mkdir -p "$EOL_DIR"
printf 'eol-tok-lf\n' > "${EOL_DIR}/github-token"
_cell_github "(g) single trailing LF stripped" "CATALYST_CONFIG_DIR=${EOL_DIR}"
printf 'eol-tok-crlf\r\n' > "${EOL_DIR}/github-token"
_cell_github "(g) trailing CRLF stripped" "CATALYST_CONFIG_DIR=${EOL_DIR}"
printf 'eol-tok-lflf\n\n' > "${EOL_DIR}/github-token"
_cell_github "(g) double trailing LF stripped" "CATALYST_CONFIG_DIR=${EOL_DIR}"
printf 'eol-tok-crlfcrlf\r\n\r\n' > "${EOL_DIR}/github-token"
_cell_github "(g) double trailing CRLF stripped" "CATALYST_CONFIG_DIR=${EOL_DIR}"

# ─── (h) value with internal whitespace AND a literal "|" (pipe-in-value hazard) ────────
PIPE_DIR="${TMP_DIR}/pipe"
mkdir -p "$PIPE_DIR"
printf 'tok|with|pipes and spaces\ttab-too\n' > "${PIPE_DIR}/github-token"
_cell_github "(h) internal whitespace + literal pipe survives byte-for-byte" \
  "CATALYST_CONFIG_DIR=${PIPE_DIR}"
printf 'whs|with|pipes\n' > "${PIPE_DIR}/webhook-secret"
_cell_webhook "(h) webhook secret with literal pipe survives byte-for-byte" \
  "CATALYST_CONFIG_DIR=${PIPE_DIR}"

# ─── (i) github-token projection precedence combos ──────────────────────────────────────
FILE_DIR="${TMP_DIR}/precedence"
mkdir -p "$FILE_DIR"
printf 'file-wins-tok' > "${FILE_DIR}/github-token"
_cell_github "(i) file present AND GH_TOKEN/GITHUB_TOKEN inherited — file wins" \
  "CATALYST_CONFIG_DIR=${FILE_DIR}" "GH_TOKEN=stale-gh" "GITHUB_TOKEN=stale-github"
_cell_github "(i) no file, GH_TOKEN inherited — GH_TOKEN wins, no mirror needed" \
  "HOME=${ABSENT_HOME}" "GH_TOKEN=inherited-gh-only"
_cell_github "(i) no file, GITHUB_TOKEN-only inherited — mirrored onto GH_TOKEN" \
  "HOME=${ABSENT_HOME}" "GITHUB_TOKEN=inherited-github-only"
_cell_github "(i) nothing anywhere — both stay unset, SOURCE=none" "HOME=${ABSENT_HOME}"
_cell_github "(i) no file, BOTH inherited — GH_TOKEN outranks GITHUB_TOKEN" \
  "HOME=${ABSENT_HOME}" "GH_TOKEN=gh-wins" "GITHUB_TOKEN=github-loses"

# ─── (j) CATALYST_SECRET_LAST_VALUE breadcrumb is UNSET after the wrapper returns ───────
# Real lib only — the frozen legacy reference never touches this var at all, so there is
# nothing to compare against; this is a standalone regression assertion (SECRET HYGIENE:
# the wrapper runs in launcher shells whose env is inherited by every long-lived daemon and
# child, so a lingering plain shell variable holding the raw credential is a leak surface).
BREADCRUMB_DIR="${TMP_DIR}/breadcrumb"
mkdir -p "$BREADCRUMB_DIR"
printf 'breadcrumb-tok' > "${BREADCRUMB_DIR}/github-token"
BREADCRUMB_OUT="$(env -i PATH="$PATH" HOME="$SANDBOX_HOME" "CATALYST_CONFIG_DIR=${BREADCRUMB_DIR}" bash -c "
  source '$LIB'
  catalyst_project_github_token
  if [[ -n \"\${CATALYST_SECRET_LAST_VALUE+x}\" ]]; then echo 'LEAKED'; else echo 'CLEAN'; fi
")"
expect_eq "(j) CATALYST_SECRET_LAST_VALUE unset after catalyst_project_github_token" "CLEAN" "$BREADCRUMB_OUT"

printf 'breadcrumb-whs' > "${BREADCRUMB_DIR}/webhook-secret"
BREADCRUMB_WHS_OUT="$(env -i PATH="$PATH" HOME="$SANDBOX_HOME" "CATALYST_CONFIG_DIR=${BREADCRUMB_DIR}" bash -c "
  source '$LIB'
  catalyst_project_webhook_secret
  if [[ -n \"\${CATALYST_SECRET_LAST_VALUE+x}\" ]]; then echo 'LEAKED'; else echo 'CLEAN'; fi
")"
expect_eq "(j) CATALYST_SECRET_LAST_VALUE unset after catalyst_project_webhook_secret" "CLEAN" "$BREADCRUMB_WHS_OUT"

# Also: the breadcrumb must be unset even on the "no file, nothing inherited" path (the
# engine still calls _csc_set_result internally for the "none" result).
BREADCRUMB_NONE_OUT="$(env -i PATH="$PATH" HOME="$ABSENT_HOME" bash -c "
  source '$LIB'
  catalyst_project_github_token
  if [[ -n \"\${CATALYST_SECRET_LAST_VALUE+x}\" ]]; then echo 'LEAKED'; else echo 'CLEAN'; fi
")"
expect_eq "(j) CATALYST_SECRET_LAST_VALUE unset even on the none/absent path" "CLEAN" "$BREADCRUMB_NONE_OUT"

# ─── FLAGGED DIVERGENCES (fail-closed, outside the byte-parity fixture space) ───────────
#
# Four known divergences between the legacy chain (permissive: reads whatever bytes are on
# disk) and the folded engine chain (defensive: rejects a candidate it cannot represent
# identically on both the bash and JS sides of the CTL-1616 registry, per the PARITY GUARD
# rationale in lib/catalyst-secret-contract.sh's _csc_contains_nul/_csc_is_valid_utf8 and
# _csc_is_blank). In every case the engine FAILS CLOSED (falls through / resolves to none)
# where the legacy reader would have silently served a mutated or locale-dependent value —
# fail-closed is the deliberate, safer choice: a credential-shaped string that cannot be
# represented byte-for-byte on both engines is not a value either engine should hand a
# caller with confidence.
#
#   (a) NUL-containing file — PINNED BELOW. Legacy: bash's `$(cat ...)` command
#       substitution silently DROPS the NUL byte (not a truncation — the surrounding bytes
#       survive concatenated, e.g. "c\0loud" reads back as "cloud", 5 bytes not 6) and
#       exports that mutated value. Folded: _csc_contains_nul rejects the candidate outright
#       (falls through / none) — a mutated credential is worse than no credential.
#   (b) invalid-UTF-8-byte file — PINNED BELOW. Legacy: `cat` preserves the raw bytes
#       exactly (bash strings are untyped byte arrays) and exports them verbatim, even
#       though the JS engine's readFileSync(...,"utf8") would silently replace the same
#       bytes with U+FFFD — a cross-engine representation mismatch. Folded:
#       _csc_is_valid_utf8 (iconv round-trip) rejects the candidate — neither engine can
#       represent the value identically, so neither serves it.
#   (c) NBSP-only file, locale-dependent (KNOWN, no cell — not portably pinnable in CI):
#       legacy's _catalyst_is_blank uses the POSIX [[:space:]] class, which macOS classifies
#       NBSP (U+00A0) as space under a UTF-8 locale (but a C-locale Linux runner does not) —
#       so a NBSP-only file's blank/non-blank verdict depends on the RUNNER's locale under
#       legacy. The folded engine's _csc_is_blank uses an explicit ASCII whitespace set (the
#       CTL-1617 locale lesson), so its verdict is locale-INDEPENDENT — deliberately more
#       predictable, not something a single CI runner's locale could prove either way.
#   (d) HOME unset/empty (KNOWN, no cell — already covered from the JS-candidates angle in
#       github-token-candidates-legacy-parity.test.mjs's HOME="" tests): legacy's
#       _catalyst_secret_dirs interpolates "${HOME}/.config/catalyst/config.json" directly —
#       an empty/unset HOME degenerates to the ABSOLUTE path "/.config/catalyst/config.json"
#       (rooted at the filesystem root). The folded engine's catalyst_secret_candidates /
#       catalyst_secret_resolve_layer2_path explicitly fall back to `~` (real HOME) when
#       "${HOME-}" is empty — the same "??-vs-length-check" root cause as the JS suite's
#       HOME="" divergence, just expressed as a bash `${HOME-}` emptiness check instead.
#
# (a) and (b) are pinned here because they are simple, deterministic, single-fixture
# repros; (c) and (d) are locale/environment-dependent and are documented, not cell-pinned,
# for the same reason the JS suite documents rather than blanket-asserts its HOME="" case
# across every possible libc/locale.

# ─── (a) NUL-containing file — FAILS CLOSED on the folded side (asserts NEW behavior, NOT
# legacy parity — the two implementations deliberately diverge here) ────────────────────
NUL_DIR="${TMP_DIR}/nul"
mkdir -p "$NUL_DIR"
printf 'c\x00loud' > "${NUL_DIR}/github-token"

LEGACY_NUL_OUT="$(env -i PATH="$PATH" HOME="$SANDBOX_HOME" "CATALYST_CONFIG_DIR=${NUL_DIR}" bash -c "
  source '$LEGACY_LIB'
  legacy_project_github_token 2>/dev/null
  $(declare -f _report_github)
  _report_github
")"
NEW_NUL_OUT="$(env -i PATH="$PATH" HOME="$SANDBOX_HOME" "CATALYST_CONFIG_DIR=${NUL_DIR}" bash -c "
  source '$LIB'
  catalyst_project_github_token
  $(declare -f _report_github)
  _report_github
")"
# Pin the legacy (permissive) shape exactly, so a future accidental change to the frozen
# reference itself doesn't silently make this "divergence" comparison meaningless.
expect_eq "(a) DOCUMENTED: legacy exports the NUL-stripped mutated value" \
  $'GITHUB_TOKEN=set:cloud\nGH_TOKEN=set:cloud\nCATALYST_GITHUB_TOKEN_SOURCE=set:shared-file' \
  "$LEGACY_NUL_OUT"
# Pin the NEW (folded, fail-closed) behavior — this is the assertion that matters: the
# folded wrapper must NEVER export a NUL-mutated credential.
expect_eq "(a) FLAGGED DIVERGENCE: folded wrapper fails closed on a NUL-containing file (source=none)" \
  $'GITHUB_TOKEN=unset\nGH_TOKEN=unset\nCATALYST_GITHUB_TOKEN_SOURCE=set:none' \
  "$NEW_NUL_OUT"
if [[ "$LEGACY_NUL_OUT" == "$NEW_NUL_OUT" ]]; then
  fail "(a) sanity: legacy and folded must NOT agree here" "they matched — the divergence fixture is broken"
else
  ok
fi

# ─── (b) invalid-UTF-8-byte file — FAILS CLOSED on the folded side ──────────────────────
BADUTF8_DIR="${TMP_DIR}/badutf8"
mkdir -p "$BADUTF8_DIR"
printf '\xff\xfehi' > "${BADUTF8_DIR}/github-token"

LEGACY_BADUTF8_OUT="$(env -i PATH="$PATH" HOME="$SANDBOX_HOME" "CATALYST_CONFIG_DIR=${BADUTF8_DIR}" bash -c "
  source '$LEGACY_LIB'
  legacy_project_github_token 2>/dev/null
  echo \"SOURCE=\${CATALYST_GITHUB_TOKEN_SOURCE-<unset>}\"
  printf '%s' \"\${GITHUB_TOKEN-}\" | od -An -tx1 | tr -d ' \n'
")"
NEW_BADUTF8_OUT="$(env -i PATH="$PATH" HOME="$SANDBOX_HOME" "CATALYST_CONFIG_DIR=${BADUTF8_DIR}" bash -c "
  source '$LIB'
  catalyst_project_github_token
  echo \"SOURCE=\${CATALYST_GITHUB_TOKEN_SOURCE-<unset>}\"
  printf '%s' \"\${GITHUB_TOKEN-}\" | od -An -tx1 | tr -d ' \n'
")"
expect_eq "(b) DOCUMENTED: legacy exports the raw invalid-UTF-8 bytes verbatim" \
  $'SOURCE=shared-file\nfffe6869' \
  "$LEGACY_BADUTF8_OUT"
expect_eq "(b) FLAGGED DIVERGENCE: folded wrapper fails closed on an invalid-UTF-8 file (source=none, nothing exported)" \
  "SOURCE=none" \
  "$NEW_BADUTF8_OUT"
if [[ "$LEGACY_BADUTF8_OUT" == "$NEW_BADUTF8_OUT" ]]; then
  fail "(b) sanity: legacy and folded must NOT agree here" "they matched — the divergence fixture is broken"
else
  ok
fi

echo ""
echo "Total: $((PASSES + FAILURES)), Passed: $PASSES, Failed: $FAILURES, Skipped: 0"
[[ $FAILURES -eq 0 ]]
