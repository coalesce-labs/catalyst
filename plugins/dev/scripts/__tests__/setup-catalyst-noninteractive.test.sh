#!/usr/bin/env bash
# Tests for setup-catalyst.sh headless operation (CTL-842).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
SETUP="${REPO_ROOT}/setup-catalyst.sh"
FAILURES=0; PASSES=0
pass() { PASSES=$((PASSES+1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1${2:+ ($2)}"; }

echo "=== Phase 1: Source guard + tty probe ==="

# T1: sourcing the script must NOT run main (no banner, exit 0)
out=$(cd "$REPO_ROOT" && bash -c 'source ./setup-catalyst.sh' </dev/null 2>&1)
rc=$?
if [[ $rc -eq 0 && "$out" != *"Catalyst Complete Setup"* ]]; then
  pass "sourcing does not execute main"
else
  fail "sourcing does not execute main" "rc=$rc"
fi

# T2: can_open_tty helper exists and uses the subshell-probe pattern
grep -qE 'can_open_tty\(\)' "$SETUP" \
  && grep -qF '(: </dev/tty)' "$SETUP" \
  && pass "can_open_tty subshell probe present" \
  || fail "can_open_tty subshell probe present"

# T3: main no longer gates the exec on existence-only [ -e /dev/tty ]
grep -qF '[ -e /dev/tty ]' "$SETUP" \
  && fail "existence-only /dev/tty check removed" \
  || pass "existence-only /dev/tty check removed"

# T4: executed (not sourced) entry still calls main — curl|bash safe idiom
grep -qF 'return 0 2>/dev/null' "$SETUP" \
  && pass "sourced-vs-executed guard uses return-probe idiom" \
  || fail "sourced-vs-executed guard uses return-probe idiom"

echo ""
echo "=== Phase 2: ask_yes_no piped-input desync ==="

# Helper: run a snippet in a bash that sources the script first.
run_sourced() { bash -c "source '$SETUP'; $1" 2>/dev/null; }

# T5: three piped answers hit three consecutive prompts in order (y, n, y)
out=$(printf 'y\nn\ny\n' | run_sourced '
  ask_yes_no "q1?" y && echo A1=yes || echo A1=no
  ask_yes_no "q2?" y && echo A2=yes || echo A2=no
  ask_yes_no "q3?" y && echo A3=yes || echo A3=no' 2>/dev/null | grep "^A")
if [[ "$out" == $'A1=yes\nA2=no\nA3=yes' ]]; then
  pass "piped answers stay aligned"
else
  fail "piped answers stay aligned" "$out"
fi

# T6: empty line means default (default=n)
printf '\n' | run_sourced 'ask_yes_no "q?" n' 2>/dev/null \
  && fail "empty line respects default n" || pass "empty line respects default n"

# T7: EOF (no input at all) falls back to the default instead of failing
run_sourced 'ask_yes_no "q?" y' </dev/null 2>/dev/null \
  && pass "EOF falls back to default y" || fail "EOF falls back to default y"
run_sourced 'ask_yes_no "q?" n' </dev/null 2>/dev/null \
  && fail "EOF falls back to default n" || pass "EOF falls back to default n"

echo ""
echo "=== Phase 3: Non-interactive mode ==="

# T8: parse_args sets NON_INTERACTIVE for --non-interactive and --defaults
for flag in --non-interactive --defaults; do
  out=$(run_sourced "parse_args $flag; echo NI=\$NON_INTERACTIVE" 2>/dev/null)
  [[ "$out" == *"NI=1"* ]] && pass "parse_args $flag" || fail "parse_args $flag" "$out"
done

# T9: CATALYST_AUTONOMOUS=1 implies non-interactive
out=$(CATALYST_AUTONOMOUS=1 run_sourced 'parse_args; echo NI=$NON_INTERACTIVE' 2>/dev/null)
[[ "$out" == *"NI=1"* ]] && pass "CATALYST_AUTONOMOUS implies NI" || fail "CATALYST_AUTONOMOUS implies NI" "$out"

# T10: unknown flag fails loudly
run_sourced 'parse_args --bogus' </dev/null >/dev/null 2>&1 \
  && fail "unknown flag rejected" || pass "unknown flag rejected"

# T11: in NI mode ask_yes_no consumes NOTHING from stdin and returns default
out=$(printf 'n\n' | run_sourced '
  NON_INTERACTIVE=1
  ask_yes_no "q1?" y && echo A1=yes || echo A1=no
  read -r leftover; echo "LEFT=$leftover"' 2>/dev/null | grep -E "^(A|LEFT)")
[[ "$out" == $'A1=yes\nLEFT=n' ]] && pass "NI reads nothing from stdin" || fail "NI reads nothing from stdin" "$out"

# T12: ask_yes_no third arg overrides the NI answer (install offers decline)
printf '' | run_sourced 'NON_INTERACTIVE=1; ask_yes_no "install?" y n' 2>/dev/null \
  && fail "NI override answer n" || pass "NI override answer n"

# T13: prompt_value returns default in NI mode without reading stdin
out=$(printf 'TYPED\n' | run_sourced '
  NON_INTERACTIVE=1
  v=$(prompt_value "Enter ticket prefix" "PROJ"); echo "V=$v"
  read -r leftover; echo "LEFT=$leftover"' 2>/dev/null | grep -E "^(V|LEFT)")
[[ "$out" == $'V=PROJ\nLEFT=TYPED' ]] && pass "prompt_value NI default" || fail "prompt_value NI default" "$out"

# T14: prompt_value EOF → default (interactive path, exhausted pipe)
out=$(run_sourced 'v=$(prompt_value "Name" "dflt"); echo "V=$v"' </dev/null 2>/dev/null)
[[ "$out" == *"V=dflt"* ]] && pass "prompt_value EOF default" || fail "prompt_value EOF default" "$out"

# T15: integration gates — NI skips Linear when no token is discoverable
scratch_home=$(mktemp -d)
out=$(env -u LINEAR_API_TOKEN HOME="$scratch_home" bash -c "source '$SETUP'
  NON_INTERACTIVE=1
  prompt_linear_config '{}' >/dev/null" 2>&1 </dev/null)
rm -rf "$scratch_home"
[[ "$out" == *"Skipping Linear"* ]] && pass "NI skips Linear without token" || fail "NI skips Linear without token" "$out"

# T16: install offers are declined in NI mode (no pip/brew run)
grep -qE 'ask_yes_no "Attempt to install via npm now\?" "?y"? "?n"?' "$SETUP" \
  && pass "humanlayer install offer declines in NI" || fail "humanlayer install offer declines in NI"
grep -qE 'ask_yes_no "Attempt to install jq now\?" "?y"? "?n"?' "$SETUP" \
  && pass "jq install offer declines in NI" || fail "jq install offer declines in NI"

# T17: main parses args before the tty redirect
awk '/^main\(\)/,/^}/' "$SETUP" | head -5 | grep -q 'parse_args' \
  && pass "main calls parse_args first" || fail "main calls parse_args first"

# T19: NI skips Sentry when no token is discoverable
scratch_home=$(mktemp -d)
out=$(env -u SENTRY_AUTH_TOKEN HOME="$scratch_home" bash -c "source '$SETUP'
  NON_INTERACTIVE=1
  prompt_sentry_config '{}' >/dev/null" 2>&1 </dev/null)
rm -rf "$scratch_home"
[[ "$out" == *"Skipping Sentry"* ]] && pass "NI skips Sentry without token" || fail "NI skips Sentry without token" "$out"

# T20: NI skips PostHog and Exa unconditionally (skip notices print to stderr,
# which run_sourced suppresses — use a raw sourced bash here)
out=$(bash -c "source '$SETUP'; NON_INTERACTIVE=1; prompt_posthog_config '{}' >/dev/null" </dev/null 2>&1)
[[ "$out" == *"Skipping PostHog"* ]] && pass "NI skips PostHog" || fail "NI skips PostHog" "$out"
out=$(bash -c "source '$SETUP'; NON_INTERACTIVE=1; prompt_exa_config '{}' >/dev/null" </dev/null 2>&1)
[[ "$out" == *"Skipping Exa"* ]] && pass "NI skips Exa" || fail "NI skips Exa" "$out"

# T21: determine_project_location fails loudly (exit 1) in NI mode
bash -c "source '$SETUP'; NON_INTERACTIVE=1; determine_project_location" </dev/null >/dev/null 2>&1 \
  && fail "determine_project_location exits 1 in NI" || pass "determine_project_location exits 1 in NI"

# T22: --help prints usage and exits 0
out=$(run_sourced 'parse_args --help' </dev/null 2>&1)
rc=$?
[[ $rc -eq 0 && "$out" == *"Usage:"* ]] && pass "--help prints usage, exit 0" || fail "--help prints usage, exit 0" "rc=$rc"

echo ""
echo "=== Phase 5: CATALYST_NI_AUTOINSTALL guard (CTL-1214 PATH-B #5) ==="

# T23: with NON_INTERACTIVE=1 CATALYST_NI_AUTOINSTALL=1, the override forces a
# "y" answer even when the explicit ni_answer arg is "n" → returns 0. This is the
# path check_prerequisites uses to auto-accept a CRITICAL prereq install headlessly.
run_sourced 'NON_INTERACTIVE=1; CATALYST_NI_AUTOINSTALL=1; ask_yes_no "x?" "y" "n"' </dev/null 2>/dev/null \
  && pass "NI autoinstall override forces accept (returns 0)" \
  || fail "NI autoinstall override forces accept (returns 0)"

# T24: WITHOUT the override, plain NON_INTERACTIVE=1 still honors the ni_answer
# "n" and DECLINES (returns non-0) — the install offers must not silently flip on.
# This keeps the existing T16 (line 113) decline guard valid.
run_sourced 'NON_INTERACTIVE=1; ask_yes_no "x?" "y" "n"' </dev/null 2>/dev/null \
  && fail "plain NI still declines without override" \
  || pass "plain NI still declines without override"

# T25: the override only affects NI mode — it must NOT short-circuit the source
# guard / change the default ni_answer for unrelated prompts (default y stays y).
run_sourced 'NON_INTERACTIVE=1; CATALYST_NI_AUTOINSTALL=1; ask_yes_no "x?" "n"' </dev/null 2>/dev/null \
  && pass "NI autoinstall override beats default ni_answer n" \
  || fail "NI autoinstall override beats default ni_answer n"

# T26: check_prerequisites wraps the humanlayer install with the autoinstall env
# so an autonomous catalyst-join auto-accepts the critical HumanLayer prereq.
grep -qF 'CATALYST_NI_AUTOINSTALL=1 offer_install_humanlayer' "$SETUP" \
  && pass "check_prerequisites wraps humanlayer install with CATALYST_NI_AUTOINSTALL=1" \
  || fail "check_prerequisites wraps humanlayer install with CATALYST_NI_AUTOINSTALL=1"

# T27: gh install offer is likewise wrapped with the autoinstall env in NI mode
# (node HTTPS git auth / thoughts sync precondition).
grep -qF 'CATALYST_NI_AUTOINSTALL=1 offer_install_gh_cli' "$SETUP" \
  && pass "check_prerequisites wraps gh install with CATALYST_NI_AUTOINSTALL=1" \
  || fail "check_prerequisites wraps gh install with CATALYST_NI_AUTOINSTALL=1"

echo ""
echo "=== Phase 6: setup_project_config thoughts block (CTL-1214) ==="

# T28: after setup_project_config runs in a scratch repo (ORG_NAME/REPO_NAME set),
# .catalyst/config.json carries non-empty .catalyst.thoughts.{directory,profile}
# == {REPO_NAME, ORG_NAME} (drift-gate input). Hermetic: env -i + scratch HOME/dir,
# NON_INTERACTIVE so prompt_value returns defaults without touching stdin.
spc_scratch=$(mktemp -d)
spc_out=$(env -i HOME="$spc_scratch/home" PATH="/usr/bin:/bin" bash -c "
  source '$SETUP'
  NON_INTERACTIVE=1
  ORG_NAME=acme-org
  REPO_NAME=acme-repo
  PROJECT_KEY=acme-org
  PROJECT_DIR='$spc_scratch/proj'
  mkdir -p \"\$PROJECT_DIR\"
  setup_project_config >/dev/null 2>&1
  jq -r '.catalyst.thoughts.directory + \"|\" + .catalyst.thoughts.profile' \"\$PROJECT_DIR/.catalyst/config.json\"
" 2>/dev/null)
rm -rf "$spc_scratch"
[[ "$spc_out" == "acme-repo|acme-org" ]] \
  && pass "setup_project_config writes thoughts.{directory=REPO_NAME,profile=ORG_NAME}" \
  || fail "setup_project_config writes thoughts.{directory,profile}" "$spc_out"

# T29: both thoughts fields are non-empty / non-null (a null-valued required key
# would fail the validate_bundle existence assertion downstream).
spc_scratch=$(mktemp -d)
spc_nonempty=$(env -i HOME="$spc_scratch/home" PATH="/usr/bin:/bin" bash -c "
  source '$SETUP'
  NON_INTERACTIVE=1
  ORG_NAME=acme-org
  REPO_NAME=acme-repo
  PROJECT_KEY=acme-org
  PROJECT_DIR='$spc_scratch/proj'
  mkdir -p \"\$PROJECT_DIR\"
  setup_project_config >/dev/null 2>&1
  jq -r '(.catalyst.thoughts.directory != null and .catalyst.thoughts.directory != \"\" and .catalyst.thoughts.profile != null and .catalyst.thoughts.profile != \"\")' \"\$PROJECT_DIR/.catalyst/config.json\"
" 2>/dev/null)
rm -rf "$spc_scratch"
[[ "$spc_nonempty" == "true" ]] \
  && pass "setup_project_config thoughts.directory/profile non-empty" \
  || fail "setup_project_config thoughts.directory/profile non-empty" "$spc_nonempty"

echo ""
echo "=== Phase 7: setup_project_config deployment-mode block (CTL-1622) ==="

# T30: NI writes the default deployment mode (Scenario 2).
# In a scratch repo with NON_INTERACTIVE=1 and no existing config, assert
# .catalyst.deployment.mode == "single-host".
spc_scratch=$(mktemp -d)
spc_t30=$(env -i HOME="$spc_scratch/home" PATH="/usr/bin:/bin" bash -c "
  source '$SETUP'
  NON_INTERACTIVE=1
  ORG_NAME=acme-org
  REPO_NAME=acme-repo
  PROJECT_KEY=acme-org
  PROJECT_DIR='$spc_scratch/proj'
  mkdir -p \"\$PROJECT_DIR\"
  setup_project_config >/dev/null 2>&1
  jq -r '.catalyst.deployment.mode' \"\$PROJECT_DIR/.catalyst/config.json\"
" 2>/dev/null)
rm -rf "$spc_scratch"
[[ "$spc_t30" == "single-host" ]] \
  && pass "setup_project_config NI writes deployment.mode=single-host" \
  || fail "setup_project_config NI writes deployment.mode=single-host" "$spc_t30"

# T31: written value is a recognized enum member (single-host|cluster|cloud).
# Guards against a malformed heredoc substitution producing a null or garbage value.
spc_scratch=$(mktemp -d)
spc_t31=$(env -i HOME="$spc_scratch/home" PATH="/usr/bin:/bin" bash -c "
  source '$SETUP'
  NON_INTERACTIVE=1
  ORG_NAME=acme-org
  REPO_NAME=acme-repo
  PROJECT_KEY=acme-org
  PROJECT_DIR='$spc_scratch/proj'
  mkdir -p \"\$PROJECT_DIR\"
  setup_project_config >/dev/null 2>&1
  jq -r 'if .catalyst.deployment.mode == \"single-host\" or .catalyst.deployment.mode == \"cluster\" or .catalyst.deployment.mode == \"cloud\" then \"recognized\" else \"unrecognized:\" + (.catalyst.deployment.mode // \"null\") end' \"\$PROJECT_DIR/.catalyst/config.json\"
" 2>/dev/null)
rm -rf "$spc_scratch"
[[ "$spc_t31" == "recognized" ]] \
  && pass "setup_project_config writes a recognized deployment.mode enum value" \
  || fail "setup_project_config writes a recognized deployment.mode enum value" "$spc_t31"

# T32: preservation on re-write. Pre-write a config whose projectKey differs from PROJECT_KEY
# and whose .catalyst.deployment.mode is "cluster". In NI mode ask_yes_no defaults to y,
# so setup_project_config takes the update path and re-writes — but must NOT clobber "cluster".
spc_scratch=$(mktemp -d)
mkdir -p "$spc_scratch/proj/.catalyst"
printf '{"catalyst":{"projectKey":"old-org","deployment":{"mode":"cluster"}}}\n' \
  > "$spc_scratch/proj/.catalyst/config.json"
spc_t32=$(env -i HOME="$spc_scratch/home" PATH="/usr/bin:/bin" bash -c "
  source '$SETUP'
  NON_INTERACTIVE=1
  ORG_NAME=acme-org
  REPO_NAME=acme-repo
  PROJECT_KEY=new-org
  PROJECT_DIR='$spc_scratch/proj'
  setup_project_config >/dev/null 2>&1
  jq -r '.catalyst.deployment.mode' \"\$PROJECT_DIR/.catalyst/config.json\"
" 2>/dev/null)
rm -rf "$spc_scratch"
[[ "$spc_t32" == "cluster" ]] \
  && pass "setup_project_config preserves existing deployment.mode on re-write" \
  || fail "setup_project_config preserves existing deployment.mode on re-write" "$spc_t32"

# T33: interactive path captures typed deployment mode + resolveDeploymentMode round-trip.
# Pipe three ordered answers (ticket_prefix→empty/default, project_name→empty/default,
# deployment_mode→"cluster") into setup_project_config with NON_INTERACTIVE=0.
# Asserts .catalyst.deployment.mode == "cluster" and that resolveDeploymentMode returns
# inferred:false, recognized:true — proving the written key is the path the resolver reads.
# Skipped with a PASS notice when node is absent.
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
  spc_scratch=$(mktemp -d)
  printf '\n\ncluster\n' | env -i HOME="$spc_scratch/home" PATH="/usr/bin:/bin" bash -c "
    source '$SETUP'
    NON_INTERACTIVE=0
    ORG_NAME=acme-org
    REPO_NAME=acme-repo
    PROJECT_KEY=acme-org
    PROJECT_DIR='$spc_scratch/proj'
    mkdir -p \"\$PROJECT_DIR\"
    setup_project_config >/dev/null 2>&1
  " 2>/dev/null
  spc_t33_mode=$(jq -r '.catalyst.deployment.mode' "$spc_scratch/proj/.catalyst/config.json" 2>/dev/null)
  if [[ "$spc_t33_mode" != "cluster" ]]; then
    fail "setup_project_config interactive captures typed deployment.mode=cluster" "$spc_t33_mode"
    rm -rf "$spc_scratch"
  else
    cfg="$spc_scratch/proj/.catalyst/config.json"
    if "$NODE_BIN" --input-type=module -e "
import { resolveDeploymentMode } from '${REPO_ROOT}/plugins/dev/scripts/lib/deployment-mode.mjs';
const r = resolveDeploymentMode({ env: {}, layer1ConfigPath: '${cfg}', layer2ConfigPath: '/nonexistent/layer2.json' });
process.exit(r.inferred === false && r.recognized === true && r.mode === 'cluster' ? 0 : 1);
" 2>/dev/null; then
      pass "setup_project_config interactive + resolveDeploymentMode resolves inferred:false, recognized:true, mode:cluster"
    else
      fail "setup_project_config interactive + resolveDeploymentMode resolves inferred:false, recognized:true, mode:cluster"
    fi
    rm -rf "$spc_scratch"
  fi
else
  pass "setup_project_config interactive + resolver (SKIP — node not available)"
fi

# T34 (Codex P2): a present-but-`false` deployment.mode is PRESERVED as an explicit
# error on re-write, not silently reset to single-host. Pre-write a config whose
# projectKey differs (forces the update/re-write path) with deployment.mode:false;
# assert the regenerated config still carries the error value so the resolver keeps
# reporting recognized:false instead of masking it.
spc_scratch=$(mktemp -d)
mkdir -p "$spc_scratch/proj/.catalyst"
printf '{"catalyst":{"projectKey":"old-org","deployment":{"mode":false}}}\n' \
  > "$spc_scratch/proj/.catalyst/config.json"
spc_t34=$(env -i HOME="$spc_scratch/home" PATH="/usr/bin:/bin" bash -c "
  source '$SETUP'
  NON_INTERACTIVE=1
  ORG_NAME=acme-org
  REPO_NAME=acme-repo
  PROJECT_KEY=new-org
  PROJECT_DIR='$spc_scratch/proj'
  setup_project_config >/dev/null 2>&1
  jq -r '.catalyst.deployment.mode' \"\$PROJECT_DIR/.catalyst/config.json\"
" 2>/dev/null)
rm -rf "$spc_scratch"
[[ "$spc_t34" == "false" ]] \
  && pass "setup_project_config preserves an explicit invalid deployment.mode (false) on re-write" \
  || fail "setup_project_config preserves an explicit invalid deployment.mode (false) on re-write" "$spc_t34"

# T35 (Codex P2): an interactively-typed deployment value containing a double quote
# is JSON-encoded, so the written .catalyst/config.json stays valid JSON and the
# value round-trips verbatim (rather than corrupting the file the next jq consumer
# reads). Pipe ticket_prefix→default, project_name→default, deployment_mode→clu"ster.
spc_scratch=$(mktemp -d)
printf '\n\nclu"ster\n' | env -i HOME="$spc_scratch/home" PATH="/usr/bin:/bin" bash -c "
  source '$SETUP'
  NON_INTERACTIVE=0
  ORG_NAME=acme-org
  REPO_NAME=acme-repo
  PROJECT_KEY=acme-org
  PROJECT_DIR='$spc_scratch/proj'
  mkdir -p \"\$PROJECT_DIR\"
  setup_project_config >/dev/null 2>&1
" 2>/dev/null
spc_cfg="$spc_scratch/proj/.catalyst/config.json"
if jq empty "$spc_cfg" >/dev/null 2>&1 \
   && [[ "$(jq -r '.catalyst.deployment.mode' "$spc_cfg" 2>/dev/null)" == 'clu"ster' ]]; then
  pass "setup_project_config JSON-encodes a deployment value containing a quote"
else
  fail "setup_project_config JSON-encodes a deployment value containing a quote" "$(cat "$spc_cfg" 2>/dev/null)"
fi
rm -rf "$spc_scratch"

# T36 (Codex P2): JSON `null` deployment.mode is the resolver's "unset" sentinel
# (fallthrough → recognized:true, doctor passes) and must be treated like an ABSENT
# key on re-write, NOT preserved as the string "null" (an unrecognized value that
# flips doctor to FAIL). Pre-write null with a mismatched projectKey (forces the
# re-write path); assert the regenerated mode is the plain default "single-host"
# (i.e. null fell through to the default, it was not coerced to "null").
spc_scratch=$(mktemp -d)
mkdir -p "$spc_scratch/proj/.catalyst"
printf '{"catalyst":{"projectKey":"old-org","deployment":{"mode":null}}}\n' \
  > "$spc_scratch/proj/.catalyst/config.json"
spc_t36=$(env -i HOME="$spc_scratch/home" PATH="/usr/bin:/bin" bash -c "
  source '$SETUP'
  NON_INTERACTIVE=1
  ORG_NAME=acme-org
  REPO_NAME=acme-repo
  PROJECT_KEY=new-org
  PROJECT_DIR='$spc_scratch/proj'
  setup_project_config >/dev/null 2>&1
  jq -r '.catalyst.deployment.mode' \"\$PROJECT_DIR/.catalyst/config.json\"
" 2>/dev/null)
rm -rf "$spc_scratch"
[[ "$spc_t36" == "single-host" ]] \
  && pass "setup_project_config treats a null deployment.mode as unset (not the string \"null\")" \
  || fail "setup_project_config treats a null deployment.mode as unset (not the string \"null\")" "$spc_t36"

# T37 (Codex P2): prompt_value emits values via printf, not echo, so an explicit
# invalid deployment.mode of exactly "-n" (an echo option) is NOT silently blanked
# to "" (which the resolver would read as unset/inferred, masking the error). Pre-write
# "-n" with a mismatched projectKey (forces re-write); assert it survives verbatim so
# the resolver still reports recognized:false.
spc_scratch=$(mktemp -d)
mkdir -p "$spc_scratch/proj/.catalyst"
printf '{"catalyst":{"projectKey":"old-org","deployment":{"mode":"-n"}}}\n' \
  > "$spc_scratch/proj/.catalyst/config.json"
spc_t37=$(env -i HOME="$spc_scratch/home" PATH="/usr/bin:/bin" bash -c "
  source '$SETUP'
  NON_INTERACTIVE=1
  ORG_NAME=acme-org
  REPO_NAME=acme-repo
  PROJECT_KEY=new-org
  PROJECT_DIR='$spc_scratch/proj'
  setup_project_config >/dev/null 2>&1
  jq -r '.catalyst.deployment.mode' \"\$PROJECT_DIR/.catalyst/config.json\"
" 2>/dev/null)
rm -rf "$spc_scratch"
[[ "$spc_t37" == "-n" ]] \
  && pass "setup_project_config preserves an option-like deployment.mode (-n), not blanked by echo" \
  || fail "setup_project_config preserves an option-like deployment.mode (-n), not blanked by echo" "$spc_t37"

echo ""
echo "=== Phase 4: Documentation shape ==="

# T18: usage header documents the new flags
head -10 "$SETUP" | grep -q -- '--non-interactive' \
  && pass "header documents --non-interactive" || fail "header documents --non-interactive"

echo ""
echo "Results: $PASSES passed, $FAILURES failed"
exit "$FAILURES"
