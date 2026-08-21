#!/usr/bin/env bash
# broker-pid-identity.test.sh — CTL-2028.
#
# On mini-2 on 2026-08-18 two brokers ran for 85 minutes — both alive, both
# heartbeating, both tailing the same event log — and `catalyst-broker status`
# reported ONE the entire time, because it reads the pid file and the newer
# process had overwritten it. A status derived from the pid file can only ever
# report 0 or 1; the number that matters is how many processes exist.
#
# ⚠️ EVERY CASE HERE STARTS A REAL PROCESS. A count assertion whose fixture never
# ran reads exactly like a working detector reporting a healthy host, so each
# "should NOT be counted" case is paired with a positive control in the same run.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BROKER_CLI="$SCRIPT_DIR/../catalyst-broker"
FAIL=0
pids=()

pass() { echo "  ok  — $1"; }
fail() { echo "  FAIL — $1" >&2; FAIL=1; }
cleanup() {
  for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done
  # Fail closed: assert the fixtures are gone rather than probing with something
  # that fails open (the house rule — `kill -0 && echo` prints nothing when the
  # probe itself errors, and self-certifies success either way).
  sleep 0.3
  for p in "${pids[@]:-}"; do
    if ps -p "$p" >/dev/null 2>&1; then echo "LEAKED: $p" >&2; FAIL=1; fi
  done
  rm -rf "$TMP" 2>/dev/null || true
}
TMP="$(mktemp -d)"
trap cleanup EXIT

# The function under test, extracted by sourcing the CLI with a guard that stops
# it before it dispatches on "$1". Sourcing is what keeps this a test OF THE
# SHIPPED CODE rather than of a copy.
load_fn() {
  # shellcheck disable=SC1090
  set -- status
  source "$BROKER_CLI" >/dev/null 2>&1 || true
}

# A broker-SHAPED process: a real runtime, whose script path ends in the marker.
spawn_fake_broker() {
  local dir="$TMP/$1"
  mkdir -p "$dir/broker"
  printf 'setTimeout(() => {}, 30000);\n' > "$dir/broker/index.mjs"
  node "$dir/broker/index.mjs" >/dev/null 2>&1 &
  local p=$!
  pids+=("$p")
  echo "$p"
}

count_now() {
  ( load_fn; broker_count_by_identity )
}
pids_now() {
  ( load_fn; broker_pids_by_identity )
}

echo "CTL-2028: count brokers by identity, not by the pid file"

# ── 1. POSITIVE CONTROL ─────────────────────────────────────────────────────
# Without this, every "not counted" assertion below could pass on a detector
# that counts nothing at all.
base="$(count_now)"
p1="$(spawn_fake_broker one)"
sleep 0.5
after_one="$(count_now)"
if [[ "$after_one" -eq $((base + 1)) ]]; then
  pass "POSITIVE CONTROL: a running broker-shaped process is counted ($base → $after_one)"
else
  fail "POSITIVE CONTROL: expected $((base + 1)), got $after_one — every other case in this file is now meaningless"
fi

if pids_now | grep -qx "$p1"; then
  pass "the counted pid is the one we started ($p1)"
else
  fail "pid $p1 was not in the identity list"
fi

# ── 2. TWO is reported as TWO — the case the pid file cannot see ────────────
p2="$(spawn_fake_broker two)"
sleep 0.5
after_two="$(count_now)"
if [[ "$after_two" -eq $((base + 2)) ]]; then
  pass "two running brokers are counted as two ($after_two)"
else
  fail "expected $((base + 2)) with two fixtures, got $after_two"
fi

kill "$p2" 2>/dev/null; sleep 0.4
back_to_one="$(count_now)"
if [[ "$back_to_one" -eq $((base + 1)) ]]; then
  pass "the count follows the processes back down ($back_to_one)"
else
  fail "expected $((base + 1)) after killing one, got $back_to_one"
fi

# ── 3. ⛔ THE MATCHER MUST NOT COUNT ITSELF ─────────────────────────────────
# The first cut passed the marker as `awk -v m=...`, which puts the literal
# string into AWK'S OWN command line — which `ps -eo command=` lists and the
# matcher then matches. Measured on a host with NO broker and NO pid file: it
# reported "1 broker process(es) are running (pids: 23661)", and 23661 was the
# awk. `grep -v grep` wearing a different hat.
#
# The control for this case is §1 above: the detector demonstrably CAN count.
kill "$p1" 2>/dev/null; sleep 0.4
zero="$(count_now)"
if [[ "$zero" -eq "$base" ]]; then
  pass "with no fixtures the count returns to baseline ($zero) — the matcher does not count itself"
else
  fail "expected baseline $base with no fixtures, got $zero (the matcher is counting its own pipeline)"
fi

# ── 4. ⛔ A MENTION IS NOT AN INVOCATION ────────────────────────────────────
# Excluding awk's argv is necessary but NOT sufficient. Measured right after
# that fix: the remaining match was the wrapping `/bin/zsh -c ...` whose argv
# merely QUOTED the marker. A shell, an editor or a log path that names the
# entrypoint must not be counted.
bash -c 'sleep 3 # broker/index.mjs' >/dev/null 2>&1 &
mention=$!
pids+=("$mention")
sleep 0.5
with_mention="$(count_now)"
if [[ "$with_mention" -eq "$base" ]]; then
  pass "a shell whose argv merely MENTIONS broker/index.mjs is not counted"
else
  fail "a mere mention was counted (got $with_mention, baseline $base) — the match is not requiring a runtime invocation"
fi
kill "$mention" 2>/dev/null

# ── 5. status reports the anomaly the pid file is blind to ──────────────────
p3="$(spawn_fake_broker three)"
sleep 0.5
out="$(BROKER_PID_FILE="$TMP/absent.pid" bash "$BROKER_CLI" status 2>&1)"
if grep -q "UNMANAGED" <<<"$out"; then
  pass "no usable pid file + a running broker is reported as an ERROR, not as a clean 'stopped'"
else
  fail "expected an UNMANAGED error; got: $out"
fi

# ⚠️ The exit code is DELIBERATELY unchanged (0). orchestrate-register-interests.sh
# treats any non-zero from `catalyst-broker status` as "no broker — skip", so
# widening the exit contract here would silently stop the legacy-wave path from
# registering interests on a host that merely has a duplicate.
BROKER_PID_FILE="$TMP/absent.pid" bash "$BROKER_CLI" status >/dev/null 2>&1
rc=$?
if [[ "$rc" -eq 0 ]]; then
  pass "the status exit code is unchanged (0) — orchestrate-register-interests.sh's guard is untouched"
else
  fail "status exited $rc; a caller reads non-zero as 'no broker' and would skip interest registration"
fi
kill "$p3" 2>/dev/null

echo
if [[ "$FAIL" -eq 0 ]]; then echo "PASS — broker-pid-identity"; else echo "FAIL — broker-pid-identity" >&2; fi
exit "$FAIL"
