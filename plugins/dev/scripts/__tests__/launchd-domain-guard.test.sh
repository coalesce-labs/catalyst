#!/usr/bin/env bash
# CTL-1968 — the launchd domain guard.
#
# `launchctl bootstrap gui/$(id -u) <plist>` targets a PER-USER domain. Every
# install path here derives its plist from "$HOME/Library/LaunchAgents/…", so a
# caller under a scratch HOME does not get a sandbox — it re-binds the REAL label
# to a temporary path. On 2026-08-18 two full shell-suite runs on the primary
# laptop did exactly that, and BOTH reported all tests passing.
#
# ⚠️ The load-bearing cases here are the MUTATION CONTROLS (G8/G9b). A test that
# merely asserts "no launchctl call was made" is satisfied just as well by a
# command that never ran at all, which is the failure mode this whole ticket is
# about. Each "zero" is therefore paired with a run of the SAME command that must
# produce a NON-zero count.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
GUARD="${SCRIPTS_DIR}/lib/launchd-domain-guard.sh"

PASSES=0; FAILURES=0
ok()  { PASSES=$((PASSES+1));   echo "  ok   — $1"; }
bad() { FAILURES=$((FAILURES+1)); echo "  FAIL — $1"; }
chk() { if [[ $1 == "$2" ]]; then ok "$3"; else bad "$3 (expected '$2', got '$1')"; fi; }

echo "CTL-1968 — launchd domain guard"

[[ -f $GUARD ]] || { echo "FAIL: guard missing at $GUARD"; exit 1; }
# shellcheck source=../lib/launchd-domain-guard.sh
. "$GUARD"

# ─── G1: the real HOME is accepted ───────────────────────────────────────────
( launchd_guard_ok "unit" ) >/dev/null 2>&1
chk "$?" "0" "G1: the invoking user's real HOME is accepted"

# ─── G2: a scratch HOME is REFUSED, and the reason names both paths ──────────
G2_OUT=$(
  scratch="$(mktemp -d)"
  export HOME="$scratch"
  unset CATALYST_ALLOW_FOREIGN_HOME_LAUNCHD
  . "$GUARD"
  launchd_guard_ok "unit"; rc=$?
  printf '%s\n%s\n' "$rc" "$CATALYST_LAUNCHD_GUARD_REASON"
)
chk "$(printf '%s' "$G2_OUT" | sed -n 1p)" "1" "G2a: a scratch HOME is refused"
G2_REASON="$(printf '%s' "$G2_OUT" | sed -n 2p)"
if [[ $G2_REASON == *"is not this user's real home"* ]]; then
  ok "G2b: the refusal names the mismatch"
else bad "G2b: reason did not name the mismatch (got: $G2_REASON)"; fi

# ─── G3: an explicit seal declaration opts back in ───────────────────────────
G3=$( scratch="$(mktemp -d)"; export HOME="$scratch" CATALYST_ALLOW_FOREIGN_HOME_LAUNCHD=1
      . "$GUARD"; launchd_guard_ok "unit"; echo $? )
chk "$G3" "0" "G3: CATALYST_ALLOW_FOREIGN_HOME_LAUNCHD=1 opts back in"

# ─── G4: an unset HOME is refused (never assume the real one) ────────────────
G4=$( unset HOME; unset CATALYST_ALLOW_FOREIGN_HOME_LAUNCHD; . "$GUARD"
      launchd_guard_ok "unit"; echo $? )
chk "$G4" "1" "G4: an unset HOME is refused"

# ─── G5: /var vs /private/var must NOT read as a mismatch ────────────────────
# macOS symlinks /var -> /private/var. A literal string compare would refuse a
# legitimate install (or accept a scratch one) purely on which spelling it got.
launchd_guard_resolve_real_home
REAL="$CATALYST_LAUNCHD_GUARD_REAL_HOME"
if [[ -n $REAL ]]; then
  ok "G5a: a resolver produced a real home ($REAL)"
  G5=$( export HOME="$REAL"; unset CATALYST_ALLOW_FOREIGN_HOME_LAUNCHD
        . "$GUARD"; launchd_guard_ok "unit"; echo $? )
  chk "$G5" "0" "G5b: the resolved real home is accepted verbatim"
  # A path that resolves to the same physical dir via a symlinked prefix.
  if [[ -d /private/var ]]; then
    G5c=$( link="$(mktemp -d)/homelink"; ln -s "$REAL" "$link" 2>/dev/null
           export HOME="$link"; unset CATALYST_ALLOW_FOREIGN_HOME_LAUNCHD
           . "$GUARD"; launchd_guard_ok "unit"; echo $? )
    chk "$G5c" "0" "G5c: a symlink to the real home is accepted (physical compare)"
  fi
else
  bad "G5a: no resolver produced a real home — the guard would refuse every install"
fi

# ─── recording launchctl, shared by the integration cases ────────────────────
SEAL="$(mktemp -d)"; mkdir -p "$SEAL/bin"; LCLOG="$SEAL/launchctl.log"
cat >"$SEAL/bin/launchctl" <<EOF
#!/bin/bash
echo "launchctl \$*" >> "$LCLOG"
exit 0
EOF
chmod +x "$SEAL/bin/launchctl"
# The seal must itself be proven reachable, or every "zero" below is vacuous.
: > "$LCLOG"; ( PATH="$SEAL/bin:$PATH" launchctl list >/dev/null 2>&1 )
if grep -q '^launchctl list' "$LCLOG"; then ok "G6: the recording launchctl is reached (seal verified)"
else bad "G6: seal NOT reached — every mutation count below would be a false zero"; fi

# mutations_for HOME_DIR ALLOW -> prints the bootout+bootstrap count
mutations_for() {
  local home="$1" allow="$2"
  : > "$LCLOG"
  mkdir -p "$home"
  (
    export HOME="$home" PATH="$SEAL/bin:$PATH"
    if [[ $allow == "1" ]]; then export CATALYST_ALLOW_FOREIGN_HOME_LAUNCHD=1
    else unset CATALYST_ALLOW_FOREIGN_HOME_LAUNCHD; fi
    bash "${SCRIPTS_DIR}/install-health-responder.sh" >/dev/null 2>&1
  ) || true
  grep -cE '^launchctl (bootout|bootstrap)' "$LCLOG" 2>/dev/null || true
}

if [[ "$(uname -s)" == "Darwin" ]]; then
  # ─── G7: the DEFAULT shape refuses — no env var set by anyone ─────────────
  N_GUARDED=$(mutations_for "$(mktemp -d)/home" 0)
  chk "${N_GUARDED:-x}" "0" "G7: install-health-responder under a scratch HOME issues ZERO launchd mutations"

  # ─── G8: MUTATION CONTROL — the same command, guard disabled, DOES mutate ──
  # Without this, G7 passes just as well if the script simply never ran.
  N_UNGUARDED=$(mutations_for "$(mktemp -d)/home" 1)
  if [[ ${N_UNGUARDED:-0} -gt 0 ]]; then
    ok "G8: mutation control — with the guard opted out the SAME command issues ${N_UNGUARDED} mutation(s), so G7's zero is caused by the guard"
  else
    bad "G8: mutation control FAILED — the command issues no mutations even unguarded, so G7 proves nothing"
  fi
else
  ok "G7/G8: skipped — not Darwin (install paths never reach launchctl here)"
fi

# ─── G9: the incident's own vector stays sealed ───────────────────────────────
# setup-cloud-replica.test.sh seals HOME but keeps the real PATH; before CTL-1968
# its cases resolved the REAL installed catalyst-stack and ran adopt-cloud-sync.
SCR="${SCRIPT_DIR}/setup-cloud-replica.test.sh"
if [[ -f $SCR ]]; then
  if grep -q 'seal_stack' "$SCR"; then ok "G9a: setup-cloud-replica.test.sh plants a catalyst-stack seal"
  else bad "G9a: setup-cloud-replica.test.sh no longer seals catalyst-stack — the 2026-08-18 vector is reopened"; fi
  # every case that sets a scratch HOME must be preceded by a seal
  if grep -q 'seal_stack "\$H7/.stub-bin"' "$SCR"; then
    ok "G9b: the case-7 bypass (its own HOME/PATH, not run_case) is sealed too"
  else
    bad "G9b: case 7 rolls its own HOME/PATH and is NOT sealed — it escaped the first fix"
  fi
else
  bad "G9: setup-cloud-replica.test.sh not found"
fi

echo
if ((FAILURES)); then echo "Results: $PASSES passed, $FAILURES failed"; exit 1; fi
echo "Results: $PASSES passed, 0 failed"
