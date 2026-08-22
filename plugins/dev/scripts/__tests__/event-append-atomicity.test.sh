#!/usr/bin/env bash
# CTL-1809 (Defect B): a bash append to the event log must be exactly ONE write(2).
#
# `printf '%s\n' "$line" >> "$file"` looks atomic and is not. O_APPEND makes the file OFFSET
# atomic; it does NOT make a multi-write(2) sequence atomic. bash's builtin printf flushes
# through stdio in BUFSIZ-sized chunks (1024 on macOS, 8192 on glibc), so a line longer than
# BUFSIZ is ⌈n/BUFSIZ⌉ separate write() calls and a concurrent producer's append lands
# BETWEEN them. The result is a spliced line: one event's head followed by another's tail.
#
# The nastiest product of that splice is NOT an unparseable line. The RCA reproduced a line
# that PARSES as valid JSON, whose declared length matches, and whose contents are three
# different events — so a parse-only assertion is not sufficient. Every case below therefore
# asserts BOTH halves of the acceptance criterion: every line parses, AND every line's
# contents belong to exactly one event. The second half is enforced by giving each producer
# its own single fill character; a spliced line contains two.
#
# Sizes are not arbitrary. 1,025 B is one byte past macOS BUFSIZ; 19,086 B is the real
# largest `catalyst.worktree-rebase` line measured on mini. Both demonstrably tear today —
# case 3 is the committed proof of that, and it is what keeps cases 1 and 2 honest.
#
# Driven against the REAL shipped function (lib/canonical-event.sh), never a model of it.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(dirname "$SCRIPT_DIR")"
LIB="${SCRIPTS_DIR}/lib/canonical-event.sh"
[[ -f "$LIB" ]] || { echo "FAIL: canonical-event.sh not found at $LIB"; exit 1; }
# shellcheck disable=SC1090
source "$LIB"

command -v jq >/dev/null 2>&1 || { echo "SKIP: jq unavailable"; exit 0; }

# The primitive hard-codes /bin/dd — an ABSOLUTE path, deliberately, because a phase-agent
# worker or launchd job runs with a restricted PATH and a PATH-resolved helper that fails to
# resolve is the silent no-op this whole guard exists to prevent. Asserted here rather than
# skipped: if /bin/dd is ever absent on a supported host, every bash append on that host is
# broken and this suite must say so in one line instead of leaving the reader to infer it
# from "expected 1200 lines, found 0". (Present on stock macOS and on Ubuntu, where /bin is
# a usrmerge symlink to /usr/bin.)
[[ -x /bin/dd ]] || { echo "FAIL: /bin/dd is missing — the atomic append primitive cannot work on this host"; exit 1; }

TMPS=()
# NOTE the trailing `true`: without it the loop's last conditional decides this script's EXIT
# STATUS, so a passing test could report failure. Cleanup must never change the verdict.
cleanup() { local d; for d in "${TMPS[@]:-}"; do [[ -n "$d" ]] && rm -rf "$d"; done; true; }
trap cleanup EXIT
newdir() { mktemp -d; }
fail() { echo "FAIL: $*"; exit 1; }
pass() { echo "  ok — $*"; }

PRODUCERS=8
LINES_PER=150

# The naive append this ticket replaces — byte-for-byte the pre-CTL-1809 shape of
# canonical-event.sh's last line. Case 3 runs the identical harness through it; if it ever
# stops tearing, cases 1 and 2 have stopped proving anything and this suite says so.
naive_append() { printf '%s\n' "$2" >> "$1"; }

# run_harness FILE SIZE APPEND_FN
# PRODUCERS concurrent subshells x LINES_PER lines, each line EXACTLY $SIZE bytes (the
# trailing newline the appender adds is on top of that). Producer N fills its padding with
# the single character N, which is what makes a splice detectable even when it parses.
run_harness() {
  local file="$1" size="$2" fn="$3"
  : > "$file"
  local pids=() p
  for p in $(seq 1 "$PRODUCERS"); do
    (
      local prefix suffix npad padchar pad line i
      padchar="$p"
      for i in $(seq 1 "$LINES_PER"); do
        prefix="{\"producer\":${p},\"seq\":${i},\"fill\":\""
        suffix="\",\"producer_echo\":${p}}"
        npad=$(( size - ${#prefix} - ${#suffix} ))
        pad="$(printf '%*s' "$npad" '' | tr ' ' "$padchar")"
        line="${prefix}${pad}${suffix}"
        [[ ${#line} -eq $size ]] || { echo "harness bug: built ${#line} bytes, wanted $size" >&2; exit 1; }
        "$fn" "$file" "$line"
      done
    ) &
    pids+=($!)
  done
  # Bounded by construction: each child runs a fixed LINES_PER-iteration loop and exits. No
  # `while :` anywhere, so there is nothing here that can outlive the test.
  for p in "${pids[@]}"; do wait "$p"; done
}

# count_damage FILE — echoes "<unparseable> <spliced>".
#   unparseable = lines that fail JSON.parse
#   spliced     = lines that PARSE but whose contents come from more than one producer
#                 (fill character not homogeneous, or not matching the declared producer,
#                 or producer != producer_echo). This is the detector the RCA's
#                 valid-JSON splice defeats a plain parse check with.
count_damage() {
  local file="$1"
  local unparseable spliced
  unparseable="$(jq -R 'try (fromjson | empty) catch 1' < "$file" | wc -l | tr -d ' ')"
  spliced="$(jq -R '
      (try fromjson catch null) as $o
      | select($o != null)
      | select(
          ($o.producer != $o.producer_echo)
          or (($o.fill | explode | unique | length) != 1)
          or (($o.fill | explode | .[0]) != (48 + $o.producer))
        )
      | 1' < "$file" | wc -l | tr -d ' ')"
  printf '%s %s' "$unparseable" "$spliced"
}

expected_lines=$(( PRODUCERS * LINES_PER ))

# --- 1. 1,025 B x 8 producers through the primitive: clean --------------------
D="$(newdir)"; TMPS+=("$D"); F1="$D/e.jsonl"
run_harness "$F1" 1025 canonical_atomic_append_line
read -r U1 S1 <<<"$(count_damage "$F1")"
N1="$(wc -l < "$F1" | tr -d ' ')"
[[ "$N1" == "$expected_lines" ]] || fail "1025B: expected $expected_lines lines, found $N1 (a line was dropped or split)"
[[ "$U1" == "0" ]] || fail "1025B: $U1 unparseable lines through the atomic primitive"
[[ "$S1" == "0" ]] || fail "1025B: $S1 lines carry contents from more than one event"
pass "1025 B x ${PRODUCERS} producers: ${N1} lines, 0 unparseable, 0 spliced"

# --- 2. 19,086 B x 8 producers through the primitive: clean -------------------
D="$(newdir)"; TMPS+=("$D"); F2="$D/e.jsonl"
run_harness "$F2" 19086 canonical_atomic_append_line
read -r U2 S2 <<<"$(count_damage "$F2")"
N2="$(wc -l < "$F2" | tr -d ' ')"
[[ "$N2" == "$expected_lines" ]] || fail "19086B: expected $expected_lines lines, found $N2"
[[ "$U2" == "0" ]] || fail "19086B: $U2 unparseable lines through the atomic primitive"
[[ "$S2" == "0" ]] || fail "19086B: $S2 lines carry contents from more than one event"
pass "19086 B x ${PRODUCERS} producers: ${N2} lines, 0 unparseable, 0 spliced"

# --- 3. POSITIVE CONTROL: the same harness on a naive `printf >>` must TEAR ----
# This is the AC's third clause made permanent ("replace the append primitive with a naive
# printf >> and the concurrency test goes red"). Without it, cases 1 and 2 would still pass
# on a machine or a bash build where nothing tears — a green that proves nothing. Asserted
# at BOTH sizes so a platform whose BUFSIZ is 8192 (glibc) still exercises the control at
# 19,086 B rather than reporting a false clean.
D="$(newdir)"; TMPS+=("$D"); FN1="$D/naive1025.jsonl"; FN2="$D/naive19086.jsonl"
run_harness "$FN1" 1025 naive_append
run_harness "$FN2" 19086 naive_append
read -r UN1 SN1 <<<"$(count_damage "$FN1")"
read -r UN2 SN2 <<<"$(count_damage "$FN2")"
DAMAGE_1025=$(( UN1 + SN1 ))
DAMAGE_19086=$(( UN2 + SN2 ))
[[ "$DAMAGE_19086" -gt 0 ]] \
  || fail "positive control DID NOT TEAR at 19086 B — cases 1 and 2 are therefore not evidence of anything"
pass "positive control: naive printf >> damaged ${DAMAGE_1025} lines at 1025 B and ${DAMAGE_19086} at 19086 B"

# --- 4. Over the cap: fails loudly, drops nothing silently, leaves a tombstone -
D="$(newdir)"; TMPS+=("$D"); F4="$D/e.jsonl"; : > "$F4"
BIG_PAD="$(printf '%*s' 300000 '' | tr ' ' 'z')"
BIG_LINE="{\"attributes\":{\"event.name\":\"phase.implement.complete.CTL-9999\"},\"pad\":\"${BIG_PAD}\"}"
WARN="$D/warn.txt"
set +e
canonical_atomic_append_line "$F4" "$BIG_LINE" 2>"$WARN"
RC=$?
set -e
[[ "$RC" -ne 0 ]] || fail "an oversized append returned 0 — a caller cannot tell the event was dropped"
grep -q "300" "$WARN" || fail "the oversized warning does not report the size; stderr: $(cat "$WARN")"
grep -q 'phase.implement.complete.CTL-9999' "$WARN" \
  || fail "the oversized warning does not name the event; stderr: $(cat "$WARN")"
# Never silently truncated or split: the file must not contain any fragment of the payload.
grep -q 'zzzz' "$F4" && fail "an oversized event was written (truncated or split) instead of refused"
pass "oversized append: rc=$RC, size and event name on stderr, nothing written from the payload"

# The tombstone: the drop must be durable and in-band, not only a stderr line that no
# event-log consumer can see.
TOMB_NAME="$(jq -r '.attributes["event.name"]' < "$F4")"
[[ "$TOMB_NAME" == "catalyst.event.oversized" ]] \
  || fail "expected a catalyst.event.oversized tombstone in the log, found event.name=$TOMB_NAME"
# The tombstone must carry its OWN name. Re-emitting the dropped event's name with a gutted
# payload would fire `catalyst-events wait-for` subscribers and the broker's phase-lifecycle
# router on fabricated content — strictly worse than the absence it is reporting.
jq -e '.attributes["event.name"] != "phase.implement.complete.CTL-9999"' < "$F4" >/dev/null \
  || fail "the tombstone re-used the dropped event's name — it would fire that event's subscribers"
jq -e '.attributes["catalyst.event.oversized.name"] == "phase.implement.complete.CTL-9999"' < "$F4" >/dev/null \
  || fail "the tombstone does not record which event was dropped"
jq -e '.attributes["catalyst.event.oversized.bytes"] > 262144' < "$F4" >/dev/null \
  || fail "the tombstone does not record the dropped size"
[[ "$(wc -l < "$F4" | tr -d ' ')" == "1" ]] || fail "expected exactly one tombstone line"
pass "tombstone: catalyst.event.oversized, own name, records the dropped name and size"

# --- 4b. The tombstone survives a hostile host name --------------------------
# The tombstone is hand-built with printf because the cap must hold on the jq-less path, so
# there is no escaper — every interpolated string has to be scrubbed by hand. TWO of them are
# externally supplied, and the host name was the one that was not: `catalyst_host_name`
# returns CATALYST_HOST_NAME (or Layer-2 `catalyst.host.name`) VERBATIM, and nothing upstream
# validates it. A host named `bad"host` produced `"host.name":"bad"host"` — invalid JSON, so
# `jq -e` fails and every reader discards the line. The one record whose entire job is to
# preserve the dropped event would silently lose it.
#
# Asserted on the SHIPPED function with a hostile value covering all three ways to break the
# template: a bare quote, a backslash (which would escape the following quote), and a newline
# (which would split one line into two).
D="$(newdir)"; TMPS+=("$D"); F4B="$D/e.jsonl"; : > "$F4B"
HOSTILE_HOST='bad"host\evil
second-line'
CATALYST_HOST_NAME="$HOSTILE_HOST" canonical_atomic_append_line "$F4B" "$BIG_LINE" 2>/dev/null || true
[[ "$(wc -l < "$F4B" | tr -d ' ')" == "1" ]] \
  || fail "a hostile host name split the tombstone across $(wc -l < "$F4B" | tr -d ' ') lines"
jq -e '.attributes["event.name"] == "catalyst.event.oversized"' < "$F4B" >/dev/null \
  || fail "the tombstone did not parse under CATALYST_HOST_NAME='$HOSTILE_HOST' — readers discard it, so the drop is unrecorded. got: $(cat "$F4B")"
jq -e '.attributes["catalyst.event.oversized.name"] == "phase.implement.complete.CTL-9999"' < "$F4B" >/dev/null \
  || fail "the hostile-host tombstone parsed but lost the dropped event's name"
# The scrub must not silently blank the field either — an empty host.name is a different way
# to lose the evidence.
jq -e '.resource["host.name"] | length > 0' < "$F4B" >/dev/null \
  || fail "the tombstone's host.name was scrubbed to empty"
# POSITIVE CONTROL: the same instrument on the UNSCRUBBED interpolation must FAIL, or the
# three assertions above pass on any implementation, including one that never escapes.
CTRL="$D/ctrl.jsonl"
printf '{"resource":{"host.name":"%s"}}\n' "$HOSTILE_HOST" > "$CTRL"
jq -e '.resource["host.name"]' < "$CTRL" >/dev/null 2>&1 \
  && fail "the control (raw interpolation of the hostile host name) PARSED — this check cannot detect the defect it exists for"
pass "tombstone: hostile CATALYST_HOST_NAME is scrubbed, one line, still parses (control: raw interpolation does not)"

# --- 5. Cap boundary: exactly at the cap is ACCEPTED --------------------------
# Off-by-one guard in the direction that matters. 262,144 B is 4.2x the all-time observed
# fleet maximum (62,597 B) and is inside the range dd is proven atomic over, so a line at
# the cap is a line the primitive must still write.
D="$(newdir)"; TMPS+=("$D"); F5="$D/e.jsonl"; : > "$F5"
EXACT_PREFIX='{"attributes":{"event.name":"cap.boundary"},"pad":"'
EXACT_SUFFIX='"}'
EXACT_PAD="$(printf '%*s' $(( 262144 - ${#EXACT_PREFIX} - ${#EXACT_SUFFIX} )) '' | tr ' ' 'y')"
EXACT_LINE="${EXACT_PREFIX}${EXACT_PAD}${EXACT_SUFFIX}"
[[ ${#EXACT_LINE} -eq 262144 ]] || fail "harness bug: boundary line is ${#EXACT_LINE} bytes"
canonical_atomic_append_line "$F5" "$EXACT_LINE" || fail "a line exactly at the cap was refused"
jq -e '.attributes["event.name"] == "cap.boundary"' < "$F5" >/dev/null \
  || fail "the at-cap line did not land intact"
pass "cap boundary: 262144 B accepted and intact"

# --- 6. Every bash producer converges on the one primitive --------------------
# The primitive only helps the sites that call it, so a raw `>>` append to the event log
# added later would silently keep the old torn path. This scan enumerates append redirects
# to an event-log destination across the shipped bash producers.
#
# Three sites legitimately keep a raw append: dependency-free leaves that source
# canonical-event.sh lazily and must still emit when it is absent. Those are recognized ONLY
# by the loud warning that must immediately precede them — so the exemption cannot be
# claimed by a silent append, and adding a genuinely new raw append still fails this test.
UNGUARDED_SENTINEL='WITHOUT the atomic primitive'
scan_unguarded_appends() {
  # FNR, not NR: awk's NR is CUMULATIVE across the whole argument list, so using it would
  # both misreport line numbers and — far worse — let a loud-fallback warning at the end of
  # one file exempt a silent append near the start of the NEXT one. `guard` is reset at each
  # file boundary for the same reason.
  awk -v sentinel="$UNGUARDED_SENTINEL" '
    FNR == 1 { guard = 0 }
    index($0, sentinel) { guard = FNR }
    />>/ && /(month_file|events_file|CATALYST_EVENTS_FILE|[$]dest|\.jsonl)/ {
      if (guard == 0 || FNR - guard > 3) printf "%s:%d:%s\n", FILENAME, FNR, $0
    }
  ' "$@" 2>/dev/null || true
}
RAW="$(scan_unguarded_appends \
  "${SCRIPTS_DIR}/lib/canonical-event.sh" \
  "${SCRIPTS_DIR}/lib/emit-reap-intent.sh" \
  "${SCRIPTS_DIR}/lib/phase-emit-complete.sh" \
  "${SCRIPTS_DIR}/catalyst-state.sh" \
  "${SCRIPTS_DIR}/catalyst-events" \
  "${SCRIPTS_DIR}/catalyst-stack" \
  "${SCRIPTS_DIR}/emit-worker-status-change.sh")"
[[ -z "$RAW" ]] || fail "a bash producer appends to the event log without the atomic primitive and without a loud fallback warning:
$RAW"
# POSITIVE CONTROL for the scan above. A scan that matches nothing because its pattern is
# wrong is indistinguishable from a clean tree — the exact shape of check that has shipped
# as a false clean in this repo. Two decoys, because the scan has two halves that can each
# fail silently: (a) an UNGUARDED raw append must be reported, or the scan is blind;
# (b) a GUARDED one must not be, or the exemption is really "match nothing" and half (a)
# would be reported for the wrong reason.
D="$(newdir)"; TMPS+=("$D")
printf 'printf "%%s" "$line" >> "$month_file"\n' > "$D/decoy-bare.sh"
[[ -n "$(scan_unguarded_appends "$D/decoy-bare.sh")" ]] \
  || fail "the raw-append scan cannot detect an unguarded raw append — the clean result above is meaningless"
{ printf 'echo "WARNING: %s here"\n' "$UNGUARDED_SENTINEL"
  printf 'printf "%%s" "$line" >> "$month_file"\n'; } > "$D/decoy-guarded.sh"
[[ -z "$(scan_unguarded_appends "$D/decoy-guarded.sh")" ]] \
  || fail "the scan does not honour the loud-fallback exemption it claims to"
pass "no bash producer bypasses the primitive silently (scan positive-controlled both ways)"

# --- 6b. The loud fallback actually fires ------------------------------------
# The exemption above is only defensible if the warning is real. A fallback branch that
# ships un-exercised is the second code path this ticket's design notes ban everywhere else,
# so it gets exercised here against the REAL shipped file: copy lib/emit-reap-intent.sh
# somewhere with no canonical-event.sh sibling — which is exactly how it resolves the helper
# (`_rei_lib_dir` from BASH_SOURCE) — and require both the warning AND the event.
D="$(newdir)"; TMPS+=("$D")
mkdir -p "$D/lonely" "$D/ev"
cp "${SCRIPTS_DIR}/lib/emit-reap-intent.sh" "$D/lonely/"
FBERR="$D/fb.err"
CATALYST_EVENTS_DIR="$D/ev" bash "$D/lonely/emit-reap-intent.sh" \
  orphans.reap-requested --orch-id test-orch 2>"$FBERR" || true
grep -q "$UNGUARDED_SENTINEL" "$FBERR" \
  || fail "the helper-absent fallback did not warn — the scan's exemption covers a silent path. stderr: $(cat "$FBERR")"
[[ -s "$D/ev/$(date -u +%Y-%m).jsonl" ]] \
  || fail "the helper-absent fallback warned but dropped the event — it must still emit"
pass "loud fallback: warns on stderr and still emits when canonical-event.sh is absent"

# --- 7. catalyst-events must not lose a whole batch to one torn line ----------
# `jq -c "select(...)"` ABORTS at the first line that does not parse (exit 5), so every
# valid event AFTER a torn line in the same wake batch was silently lost and a `wait-for`
# whose awaited event shared that batch timed out. The loop cursor is a line COUNT, so the
# abort is batch-scoped rather than a permanent wedge — which is exactly why it was never
# noticed.
D="$(newdir)"; TMPS+=("$D")
# CTL-1216: the fixture name comes from the SAME mirror catalyst-events resolves
# through, so this case keeps testing torn-line handling rather than accidentally
# testing whether the two halves agree on a filename (they are covered by
# __tests__/canonical-event-rotation.test.sh T4).
EV="$D/events/$( . "${SCRIPTS_DIR}/lib/catalyst-event-log-paths.sh"; catalyst_event_log_basename )"
mkdir -p "$(dirname "$EV")"
{
  printf '{"attributes":{"event.name":"before.torn"}}\n'
  printf 'TORN{"attributes":{"event.na\n'
  printf '{"attributes":{"event.name":"after.torn"}}\n'
} > "$EV"
ERRF="$D/tail.err"; OUTF="$D/tail.out"
# `tail` is a live tail — `cmd_tail`'s poll branch is a literal `while :; do sleep 1; …`, so
# it NEVER returns on its own. This is a REQUIRED CI job, so the deadline may not live in the
# parent: a foreground `sleep 2` is a pause, not a bound, and if the kill below is never
# delivered the job blocks forever and the child outlives the harness (AGENTS.md "Spawning a
# background process"). Two structural guards, both of which hold with every cleanup line
# below deleted:
#
#   · `set -m` puts the tail in its OWN process group, so `kill -<pgid>` reaches the helpers
#     it forks as well as the tail itself. This is not belt-and-braces: `cmd_tail`'s fswatch
#     branch runs `fswatch -o "$file" | while read …`, whose two members are children of the
#     tail — a pid-only kill orphans an `fswatch` watching a deleted temp dir forever.
#     Measured with the same three-process fixture: pid-only kill leaks the grandchild
#     (1 leaked), group kill leaks none (0).
#   · The watchdog carries the deadline IN A CHILD that only sleeps and signals, and it
#     ESCALATES: `cmd_tail` installs `trap 'exit 0' TERM …`, and a trapped signal is a signal
#     that can be missed, so TERM at 20 s is followed by an untrappable KILL at 25 s. That
#     bounds the `wait` below at ~25 s no matter what. The watchdog is itself bounded by its
#     own two sleeps, so it cannot outlive this test even if its own cleanup never runs.
set -m
CATALYST_EVENTS_DIR="$D/events" "${SCRIPTS_DIR}/catalyst-events" tail \
  --since-line 0 --filter '.attributes["event.name"] | test("torn")' \
  >"$OUTF" 2>"$ERRF" &
TAILPID=$!
set +m
( sleep 20; kill -TERM -"$TAILPID" 2>/dev/null; sleep 5; kill -KILL -"$TAILPID" 2>/dev/null ) &
TAILWDPID=$!
sleep 2
kill -TERM -"$TAILPID" 2>/dev/null || true
wait "$TAILPID" 2>/dev/null || true
kill "$TAILWDPID" 2>/dev/null || true
wait "$TAILWDPID" 2>/dev/null || true
# Fail CLOSED, positively: `kill -0 … && echo` prints nothing when the PROBE errors, which is
# how a script self-certifies a cleanup that never happened.
ps -p "$TAILPID" >/dev/null 2>&1 && fail "LEAKED catalyst-events tail pid $TAILPID"
ps -p "$TAILWDPID" >/dev/null 2>&1 && fail "LEAKED tail watchdog pid $TAILWDPID"
grep -q 'after.torn' "$OUTF" \
  || fail "a torn line swallowed the rest of the batch — 'after.torn' never reached the consumer. got: $(cat "$OUTF")"
grep -q 'before.torn' "$OUTF" \
  || fail "the batch did not emit at all — the harness, not the fix, is what this case measured. got: $(cat "$OUTF")"
grep -q 'torn_lines_total' "$ERRF" \
  || fail "the skipped line was silent — no counted operator-visible warning. stderr: $(cat "$ERRF")"
pass "catalyst-events: torn line counted and skipped, the rest of the batch survives"

# --- 8. No caller may re-silence the primitive's stderr ----------------------
# The primitive reports a refused (over-cap) line and a failed dd on stderr and NOTHING else
# — that WARNING is the whole loud-failure contract, and canonical-event.sh's own former
# `2>/dev/null || true` is the silence this ticket removed. A caller that re-adds `2>/dev/null`
# around the append undoes it locally: the event is still dropped, and the drop is silent
# again. `|| true` is fine and expected (the emit is best-effort at most call sites); it is
# only the stderr mute that is banned.
#
# Two shapes to catch, and the second is why this scan is not a plain grep:
#   (a) `canonical_jsonl_append "$d" "$l" 2>/dev/null || true`     — on the call line;
#   (b) a six-line call whose TRAILING `2>/dev/null` sits after the closing paren of an
#       inner `$(jq …)` that has its OWN legitimate redirect. A line-oriented grep either
#       misses (b) entirely or flags every builder's jq noise as a violation.
# So: join backslash-continuations into one logical line, strip balanced `$(…)` spans (where
# the legitimate inner redirects live), and only then look for a surviving `2>/dev/null`.
scan_silenced_appends() {
  awk '
    # Depth-aware removal of $( … ) spans, so an inner jq redirect is not mistaken for the
    # append being muted. Errs toward stripping MORE on an unbalanced span, i.e. toward a
    # false NEGATIVE — which is exactly what decoy (c) below is positive control for.
    function strip_cmdsub(s,   out, i, c, depth, n) {
      out = ""; depth = 0; n = length(s)
      for (i = 1; i <= n; i++) {
        c = substr(s, i, 1)
        if (depth == 0 && c == "$" && substr(s, i + 1, 1) == "(") { depth = 1; i++; continue }
        if (depth > 0) {
          if (c == "(") depth++
          else if (c == ")") depth--
          continue
        }
        out = out c
      }
      return out
    }
    FNR == 1 { acc = ""; startline = 0 }
    {
      line = $0
      if (acc == "") startline = FNR
      # Join a backslash-continuation onto the accumulator and wait for the real end.
      if (line ~ /\\[[:space:]]*$/) { sub(/\\[[:space:]]*$/, "", line); acc = acc line; next }
      acc = acc line
      if (acc ~ /canonical_(atomic_append_line|jsonl_append)[[:space:]]/) {
        bare = strip_cmdsub(acc)
        if (bare ~ /2>[[:space:]]*\/dev\/null/)
          printf "%s:%d:%s\n", FILENAME, startline, acc
      }
      acc = ""
    }
  ' "$@" 2>/dev/null || true
}
# Discover callers rather than hard-code them: a new file that calls the primitive must be
# covered the day it lands, not the day someone remembers to add it to a list. plugins/dev,
# not just scripts/, because the Stop hook (hooks/emit-lifecycle-event.sh) is a caller and
# was one of the five.
PLUGIN_DIR="$(dirname "$SCRIPTS_DIR")"
CALLER_FILES=()
while IFS= read -r f; do
  case "$f" in */__tests__/*) continue ;; esac
  CALLER_FILES+=("$f")
done < <(grep -rlE 'canonical_(atomic_append_line|jsonl_append)[[:space:]]' "$PLUGIN_DIR" 2>/dev/null || true)
[[ ${#CALLER_FILES[@]} -gt 0 ]] \
  || fail "found NO callers of the append primitive — the discovery glob is broken, so a clean result here would be meaningless"
SILENCED="$(scan_silenced_appends "${CALLER_FILES[@]}")"
[[ -z "$SILENCED" ]] || fail "a caller re-silences the atomic append primitive's stderr — a loud fallback a caller mutes is a silent fallback (CTL-1809):
$SILENCED"

# POSITIVE CONTROLS, one per way this scan can fail silently.
D="$(newdir)"; TMPS+=("$D")
# (a) the plain single-line mute must be reported, or the scan is blind.
printf 'canonical_jsonl_append "$d" "$l" 2>/dev/null || true\n' > "$D/silenced-simple.sh"
[[ -n "$(scan_silenced_appends "$D/silenced-simple.sh")" ]] \
  || fail "the silenced-append scan cannot detect a plain 2>/dev/null — the clean result above is meaningless"
# (b) a builder's inner jq redirect must NOT be reported, or the scan is really "match
#     everything" and (a) passed for the wrong reason.
{ printf 'canonical_jsonl_append "$d" \\\n'
  printf '  "$(jq -nc --arg t "$ts" %s 2>/dev/null)" || true\n' "'{ts:\$t}'"; } > "$D/ok-inner-jq.sh"
[[ -z "$(scan_silenced_appends "$D/ok-inner-jq.sh")" ]] \
  || fail "the scan flags a legitimate inner jq redirect — it would force callers to un-mute jq noise"
# (c) the multi-line TRAILING mute — the emit-lifecycle-event.sh shape, the one of the five
#     that a line-oriented grep misses. If this decoy is not reported, the scan is only
#     covering shape (a) and shape (b)'s file could hide a real mute.
{ printf 'canonical_jsonl_append "$d" \\\n'
  printf '  "$(jq -nc --arg t "$ts" %s 2>/dev/null)" 2>/dev/null || true\n' "'{ts:\$t}'"; } > "$D/silenced-trailing.sh"
[[ -n "$(scan_silenced_appends "$D/silenced-trailing.sh")" ]] \
  || fail "the scan misses a TRAILING 2>/dev/null on a continued call — the exact shape of the fifth re-silenced call site"
pass "no caller re-silences the primitive (${#CALLER_FILES[@]} callers scanned, controlled 3 ways)"

echo "PASS: event-append-atomicity (CTL-1809)"
