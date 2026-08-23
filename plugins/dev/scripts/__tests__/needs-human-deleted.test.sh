#!/usr/bin/env bash
# CTL-2162 — the guard that stops the `needs-human` label coming back.
#
# Modelled on canonical-event-sentinel-guard.test.sh: explicit PASS/FAIL
# counters, a scratch HOME, one assertion per case.
#
# ─────────────────────────────────────────────────────────────────────────────
# WHY THIS SHAPE, AND NOT "SCAN THE TREE, ASSERT ZERO"
# ─────────────────────────────────────────────────────────────────────────────
# The epic plan specified Case 1 as "rg the tree, exclude a SHORT allow-list,
# assert ZERO hits". Measured on this branch AFTER CTL-2156…CTL-2161 landed:
#
#     170 files, 1,404 occurrences.
#
# The producers were removed; the ~1.4k mentions (comments recording WHY a
# producer was deleted, back-compat readers, ~100 test files, docs, fixtures)
# were not — that string sweep is not in any commit on this branch. A zero
# assertion today needs a 170-entry "allow-list", which is a rubber stamp, not
# a guard. So Case 1 is a RATCHET against a frozen, itemized survivor manifest:
#
#   • a file NOT on the manifest containing the token  → FAIL  (it cannot come back)
#   • a manifest file whose count GREW                 → FAIL  (survivors cannot spread)
#   • a manifest file whose count SHRANK               → reported; update the manifest
#
# That is the "cannot come back" property the ticket asks for, and — unlike a
# blanket zero — it is true today, so it fires on a real regression instead of
# being disabled on day one. The manifest doubles as the burn-down ledger for
# the unfinished string sweep.
#
# Cases 3, 4, 5a and 5b are HARD ZEROES: each is genuinely zero on this branch,
# each is a property a regression would break, and each has its own planted
# positive control proving the instrument fires.
#
# ⛔ METHOD RULE OBSERVED THROUGHOUT: every zero claim below is paired with a
# planted-occurrence control. A guard whose negative case never fires is a
# guard that is WRONG, not a guard that is passing.
#
# ⛔ `grep` on a Catalyst host is aliased to `ugrep --ignore-files` and silently
# skips ignored files. Every scan here uses `rg --no-ignore --hidden`.
#
# Usage:
#   bash plugins/dev/scripts/__tests__/needs-human-deleted.test.sh
#   bash plugins/dev/scripts/__tests__/needs-human-deleted.test.sh --write-baseline
#       └─ regenerate needs-human-survivors.txt after a legitimate sweep.
#          Review the diff: entries must only DISAPPEAR or SHRINK.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
MANIFEST="${SCRIPT_DIR}/needs-human-survivors.txt"

# The four spellings. Kept as ONE definition so a case can never drift from the
# scan (the plan's Case 1 and Case 4 used different spelling sets).
PATTERN='needs-human|needs_human|needsHuman|NEEDS_HUMAN'

# Files where the token is PERMANENTLY legitimate and therefore never appears in
# the manifest. Deliberately short — this is the real allow-list.
#   • CHANGELOG / adrs.md   historical prose: records that the label EXISTED
#   • this guard + manifest  they must contain the token to test for it
ALLOWLIST_RE='^(plugins/dev/CHANGELOG\.md|docs/adrs\.md|plugins/dev/scripts/__tests__/needs-human-deleted\.test\.sh|plugins/dev/scripts/__tests__/needs-human-survivors\.txt)$'

# Trees that are not this repo's source: vendored deps, git internals, the
# thoughts symlink farm, and nested worktrees. Without the last two the repo-wide
# count inflates from ~1.4k to ~3k (2,233 worktree copies + 572 thoughts
# hardlinks) and the manifest becomes host-dependent.
#
# ⚠️ `!.git` (no /**) is load-bearing: in a git WORKTREE, `.git` is a FILE whose
# contents are the gitdir path — and this epic's worktree is literally named
# `needs-human-epic`, so without it the scan reports a hit whose presence depends
# on the checkout's directory name. That is a host-dependent manifest entry.
SCAN_EXCLUDES=(
  # ⚠️ `**/` is load-bearing: a bare `node_modules/**` is ROOT-ANCHORED, so NESTED
  # dependency trees (e.g. plugins/dev/scripts/orch-monitor/node_modules/) were scanned
  # and their build caches enrolled in the manifest. One jiti cache file
  # (.cache/jiti/lib-board-data.*.mjs) was frozen at 86 and read 5 after a rebuild —
  # a manifest entry that moves when nobody edited source is a ratchet that cries wolf.
  -g '!**/node_modules/**'
  -g '!.git'
  -g '!.git/**'
  -g '!thoughts/**'
  -g '!.claude/worktrees/**'
  -g '!artifacts/**'
  -g '!.trunk/**'
)

FAILURES=0
PASSES=0

ok()   { PASSES=$((PASSES+1));   echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES+1)); echo "  FAIL: $1"; echo "    $2"; }
info() { echo "        $1"; }

# Scratch HOME so nothing in this test can read or write a real orchestrator dir.
FAKE_HOME="$(mktemp -d)"
SCRATCH="$(mktemp -d)"
# The Case-2 control is planted INSIDE the scanned tree (that is the whole point
# of the control), so it must be removed even if the test aborts.
CONTROL_FILE="${REPO_ROOT}/plugins/dev/scripts/execution-core/.needs-human-guard-control.$$.mjs"
cleanup() { rm -rf "${FAKE_HOME}" "${SCRATCH}"; rm -f "${CONTROL_FILE}"; }
trap cleanup EXIT
export HOME="${FAKE_HOME}"

# ── The instrument ───────────────────────────────────────────────────────────
# scan_tree → "<count>\t<repo-relative path>" for every file carrying the token,
# allow-listed files removed, sorted by path. rg prints "path:count"; the path is
# split off at the LAST colon so a path containing ':' cannot corrupt a row.
scan_tree() {
  (
    cd "${REPO_ROOT}" || exit 1
    rg --no-ignore --hidden -c "${PATTERN}" "${SCAN_EXCLUDES[@]}" . 2>/dev/null
  ) | sed 's|^\./||' | awk -F: '
      { n = split($0, a, ":");
        cnt = a[n];
        path = substr($0, 1, length($0) - length(cnt) - 1);
        print cnt "\t" path }' \
    | awk -F'\t' -v re="${ALLOWLIST_RE}" '$2 !~ re' \
    | sort -t$'\t' -k2,2
}

# ── --write-baseline ─────────────────────────────────────────────────────────
if [[ "${1:-}" == "--write-baseline" ]]; then
  {
    echo "# needs-human survivor manifest — CTL-2162."
    echo "#"
    echo "# Frozen inventory of every file that still carries needs-human /"
    echo "# needs_human / needsHuman / NEEDS_HUMAN, as <count>\\t<path>."
    echo "#"
    echo "# This is a RATCHET, not an approval. A file may leave this list or"
    echo "# shrink; it may never grow, and a file NOT on this list may never"
    echo "# acquire the token. Regenerate with:"
    echo "#   bash plugins/dev/scripts/__tests__/needs-human-deleted.test.sh --write-baseline"
    echo "# and review the diff — entries must only DISAPPEAR or SHRINK."
    echo "#"
    echo "# Generated: $(date -u +%Y-%m-%d)"
    scan_tree
  } > "${MANIFEST}"
  echo "wrote ${MANIFEST} ($(grep -cv '^#' "${MANIFEST}") entries)"
  exit 0
fi

# ── Case 1 — the scan: nothing new, nothing grown ────────────────────────────
# Returns 0 when the tree conforms to the manifest, 1 otherwise. Case 2 re-runs
# this exact function against a planted occurrence, so the control exercises the
# same code path as the assertion.
evaluate_scan() {
  local out_new="$1" out_grown="$2"
  : > "${out_new}"
  : > "${out_grown}"

  local actual="${SCRATCH}/actual.$$.tsv"
  scan_tree > "${actual}"

  local baseline="${SCRATCH}/baseline.$$.tsv"
  grep -v '^#' "${MANIFEST}" | grep -v '^[[:space:]]*$' | sort -t$'\t' -k2,2 > "${baseline}"

  local count path base
  while IFS=$'\t' read -r count path; do
    [[ -n "${path}" ]] || continue
    base="$(awk -F'\t' -v p="${path}" '$2 == p { print $1; exit }' "${baseline}")"
    if [[ -z "${base}" ]]; then
      echo "${count}	${path}" >> "${out_new}"
    elif (( count > base )); then
      echo "${path}: ${base} → ${count}" >> "${out_grown}"
    fi
  done < "${actual}"

  if [[ -s "${out_new}" || -s "${out_grown}" ]]; then return 1; fi
  return 0
}

NEW_F="${SCRATCH}/new.txt"
GROWN_F="${SCRATCH}/grown.txt"

if evaluate_scan "${NEW_F}" "${GROWN_F}"; then
  ok "the scan: no new needs-human surface, no survivor grew"
else
  fail "the scan: no new needs-human surface, no survivor grew" \
       "$( [[ -s ${NEW_F} ]] && echo "NEW file(s) carrying the token:"; sed 's/^/      /' "${NEW_F}"; \
           [[ -s ${GROWN_F} ]] && echo "      GREW past the frozen baseline:"; sed 's/^/      /' "${GROWN_F}" )"
fi

# Informational: survivors that shrank. Not a failure — it means someone did the
# work; the manifest should be regenerated so the ratchet tightens.
SHRUNK=0
while IFS=$'\t' read -r bcount bpath; do
  [[ -n "${bpath}" ]] || continue
  acount="$(rg --no-ignore --hidden -c "${PATTERN}" "${REPO_ROOT}/${bpath}" 2>/dev/null | awk -F: '{print $NF}')"
  acount="${acount:-0}"
  if (( acount < bcount )); then SHRUNK=$((SHRUNK+1)); fi
done < <(grep -v '^#' "${MANIFEST}" | grep -v '^[[:space:]]*$')
if (( SHRUNK > 0 )); then
  info "note: ${SHRUNK} survivor file(s) shrank or vanished — rerun with --write-baseline to tighten the ratchet"
fi

# ── Case 2 — ⭐ THE POSITIVE CONTROL (non-negotiable) ─────────────────────────
# Plant the token in a file inside the scanned tree; Case 1's evaluator MUST now
# fail. Without this, Case 1 is indistinguishable from a scan that looks at
# nothing.
cat > "${CONTROL_FILE}" <<'CONTROL'
// CTL-2162 guard control — planted, transient. If you are reading this in a
// committed file, the guard test aborted; delete it.
export const CONTROL = "needs-human";
CONTROL

CTRL_NEW="${SCRATCH}/ctrl-new.txt"
CTRL_GROWN="${SCRATCH}/ctrl-grown.txt"
if evaluate_scan "${CTRL_NEW}" "${CTRL_GROWN}"; then
  fail "positive control: a planted occurrence FAILS the scan" \
       "the scan passed with a planted needs-human file at ${CONTROL_FILE#"${REPO_ROOT}/"} — the scan is not looking at the tree"
else
  if grep -q 'needs-human-guard-control' "${CTRL_NEW}"; then
    ok "positive control: a planted occurrence FAILS the scan (and is named)"
  else
    fail "positive control: a planted occurrence FAILS the scan (and is named)" \
         "the scan failed, but not because of the planted file — it did not appear in the NEW list"
  fi
fi
rm -f "${CONTROL_FILE}"

# ── Case 3 — no enrolment/setup script creates the label ──────────────────────
# The label is recreated on every fresh host by the worker-status group
# reconcile; CTL-2159 removed it from the member list. This is the half of the
# deletion that makes it stick, so it gets its own case.
#
# Instrument: a LIVE (non-comment) line carrying the token in any setup / enrol /
# check script. Comment lines are excluded — those record why it was removed.
SETUP_SCRIPTS=(
  "${REPO_ROOT}/setup-catalyst.sh"
)
while IFS= read -r f; do SETUP_SCRIPTS+=("$f"); done < <(
  find "${REPO_ROOT}/plugins/dev/scripts" -maxdepth 1 -type f \
    \( -name 'setup-*.sh' -o -name 'check-setup*.sh' -o -name 'check-project-setup.sh' \
       -o -name 'catalyst-enrol*' \) 2>/dev/null | sort
)

# scan_live <pattern> <file…> — matching lines whose first non-space characters
# are NOT a comment marker (#, //, *, /*).
#
# ⚠️ `-H` (--with-filename) is load-bearing and was caught by this case's own
# control: rg OMITS the filename when handed exactly ONE file, so the output
# shape silently changes from `path:NN:text` to `NN:text` between the real scan
# (many files) and the single-file planted control. The strip below then failed
# to strip, every control line looked like code, and the control reported the
# comment line as a hit. Forcing -H makes both shapes identical.
scan_live() {
  local pat="$1"; shift
  [[ $# -gt 0 ]] || return 0
  rg --no-ignore -H -n "${pat}" "$@" 2>/dev/null \
    | awk -F':' '{ rest = $0; sub(/^[^:]*:[0-9]+:/, "", rest);
                   gsub(/^[[:space:]]+/, "", rest);
                   if (rest !~ /^(#|\/\/|\*|\/\*)/) print }'
}

CASE3_HITS="$(scan_live "${PATTERN}" "${SETUP_SCRIPTS[@]}")"
if [[ -z "${CASE3_HITS}" ]]; then
  ok "no enrolment/setup script creates a needs-human label (${#SETUP_SCRIPTS[@]} scripts scanned)"
else
  fail "no enrolment/setup script creates a needs-human label" \
       "$(echo "${CASE3_HITS}" | sed 's/^/      /')"
fi

# Case 3 control: the same instrument against a planted setup script must fire.
PLANTED_SETUP="${SCRATCH}/setup-planted.sh"
cat > "${PLANTED_SETUP}" <<'PLANT'
#!/usr/bin/env bash
# needs-human — this comment line MUST NOT be counted.
issueLabelCreate '{"name":"needs-human","color":"#f2994a"}'
PLANT
CTRL3="$(scan_live "${PATTERN}" "${PLANTED_SETUP}")"
if [[ "$(echo "${CTRL3}" | grep -c 'issueLabelCreate')" -eq 1 && "$(echo "${CTRL3}" | wc -l | tr -d ' ')" -eq 1 ]]; then
  ok "positive control: the setup scan finds a planted label creation (and ignores the comment)"
else
  fail "positive control: the setup scan finds a planted label creation (and ignores the comment)" \
       "expected exactly the issueLabelCreate line, got: ${CTRL3:-<nothing>}"
fi

# ── Case 4 — ⛔ RUNTIME WRITERS, not the schema enums ─────────────────────────
# The plan said "scan the schema enums and assert the value is absent". An
# independent audit found `needs-human` was NEVER in those enums
# (phase-signal.schema.json:58-67 is dispatched/running/done/failed/stalled/
# skipped/turn-cap-exhausted/awaiting-work) — the plan's Case 4 passes VACUOUSLY,
# before any work, which is exactly what Case 2 exists to prevent. So this case
# scans the three RUNTIME WRITERS that actually stamped the value onto a
# phase-signal, and gets its own planted control.
WRITERS=(
  "${REPO_ROOT}/plugins/dev/scripts/execution-core/label-guard.mjs"
  "${REPO_ROOT}/plugins/dev/scripts/execution-core/recovery-emit.mjs"
  "${REPO_ROOT}/plugins/dev/scripts/execution-core/recovery-reasoning.mjs"
)
# `\bstatus` and not `status` so `writeStatus` / `LIVE_..._STATUSES` cannot match.
STATUS_WRITE_RE='\bstatus[[:space:]]*[:=][[:space:]]*["'"'"'](needs-human|needs_human)'

MISSING_WRITER=0
for w in "${WRITERS[@]}"; do
  [[ -f "${w}" ]] || { MISSING_WRITER=1; info "writer not found: ${w#"${REPO_ROOT}/"}"; }
done
if (( MISSING_WRITER )); then
  fail "runtime writers: all three escalation writers exist" \
       "a renamed/deleted writer would make this case scan nothing and pass vacuously"
else
  ok "runtime writers: all three escalation writers exist (scan target is real)"
fi

CASE4_HITS="$(scan_live "${STATUS_WRITE_RE}" "${WRITERS[@]}")"
if [[ -z "${CASE4_HITS}" ]]; then
  ok "no runtime writer stamps a needs-human phase-signal status"
else
  fail "no runtime writer stamps a needs-human phase-signal status" \
       "$(echo "${CASE4_HITS}" | sed 's/^/      /')"
fi

# Case 4 control: ⭐ its own planted occurrence, exactly like Case 2.
PLANTED_WRITER="${SCRATCH}/planted-writer.mjs"
cat > "${PLANTED_WRITER}" <<'PLANT'
// status:"needs-human" — a comment; MUST NOT be counted.
const writeStatus = {};                 // must not match \bstatus
const LIVE_STATUSES = new Set(["x"]);   // must not match \bstatus
const sig = { ticket, status: "needs-human" };
PLANT
CTRL4="$(scan_live "${STATUS_WRITE_RE}" "${PLANTED_WRITER}")"
if [[ "$(echo "${CTRL4}" | grep -c 'const sig')" -eq 1 && "$(echo "${CTRL4}" | wc -l | tr -d ' ')" -eq 1 ]]; then
  ok "positive control: the writer scan finds a planted status write (and ignores comment/writeStatus)"
else
  fail "positive control: the writer scan finds a planted status write (and ignores comment/writeStatus)" \
       "expected exactly the 'const sig' line, got: ${CTRL4:-<nothing>}"
fi

# NOTE — DELIBERATE EXCLUSION, do not "fix" by widening the regex.
# recovery-emit.mjs and recovery-reasoning.mjs still write
# `stalledReason: "needs_human"`. That is CTL-1552's normalized representation,
# kept ADDITIVELY by CTL-2158 (the durable S/A/M/HELD stallClass is the new
# output; status/stalledReason are unchanged so existing consumers are not
# broken) and depended on by unstuck-sweep.mjs's skip-gate — deleting it without
# re-keying that gate resurrects the CTL-638 comment-spam loop. Their counts are
# pinned by the Case 1 ratchet, so they cannot spread.

# ── Case 5a — the unpinned taxonomy copy (orch-monitor) ──────────────────────
# linear-cache-reader.mjs:157 held an independent, unguarded NEEDS_HUMAN_LABELS
# copy of the attention taxonomy, used at :194 and NOT covered by the broker's
# parity test. CTL-2161 emptied it of the label; assert it stays empty.
CACHE_READER="${REPO_ROOT}/plugins/dev/scripts/orch-monitor/lib/linear-cache-reader.mjs"
extract_attention_labels() {
  rg --no-ignore -N -o 'export const ATTENTION_LABELS = \[[^]]*\]' "$1" 2>/dev/null
}
ATT="$(extract_attention_labels "${CACHE_READER}")"
if [[ -z "${ATT}" ]]; then
  fail "orch-monitor attention taxonomy excludes needs-human" \
       "could not find ATTENTION_LABELS in ${CACHE_READER#"${REPO_ROOT}/"} — renamed? the check would pass vacuously"
elif echo "${ATT}" | rg -q "${PATTERN}"; then
  fail "orch-monitor attention taxonomy excludes needs-human" "found: ${ATT}"
else
  # Positive control: the SAME extractor must see a member that IS there.
  if echo "${ATT}" | rg -q 'needs-input'; then
    ok "orch-monitor attention taxonomy excludes needs-human (control: it does see needs-input)"
  else
    fail "orch-monitor attention taxonomy excludes needs-human" \
         "the extractor returned a list with neither needs-human nor needs-input — it is not reading the taxonomy"
  fi
fi

# ── Case 5b — the retired off-machine event name ─────────────────────────────
# `broker.terminal-needs-human.reconciled` (107 records in the live event log)
# has no producer left. Any Loki/OTel rule keyed on it is now dead — assert the
# name does not come back.
TERMINAL_HITS="$(rg --no-ignore --hidden -n 'terminal-needs-human' "${SCAN_EXCLUDES[@]}" "${REPO_ROOT}" 2>/dev/null | rg -v 'needs-human-deleted\.test\.sh|needs-human-survivors\.txt')"
CONTROL_5B="$(rg --no-ignore -c 'broker\.' "${REPO_ROOT}/plugins/dev/scripts/broker/namespace-contract.mjs" 2>/dev/null | awk -F: '{print $NF}')"
if [[ -z "${CONTROL_5B}" || "${CONTROL_5B}" -eq 0 ]]; then
  fail "the broker.terminal-needs-human event name has no producer" \
       "positive control failed: the same rg found no 'broker.' event names in namespace-contract.mjs — the instrument is not reading the broker tree"
elif [[ -z "${TERMINAL_HITS}" ]]; then
  ok "the broker.terminal-needs-human event name has no producer (control: ${CONTROL_5B} 'broker.' names found by the same rg)"
else
  fail "the broker.terminal-needs-human event name has no producer" \
       "$(echo "${TERMINAL_HITS}" | sed 's/^/      /')"
fi

# ── Case 5c — the surfaces the plan's allow-list missed, named explicitly ─────
# Each is covered by the Case 1 ratchet, but named here so the remaining
# behavioural surface is visible in the test output rather than buried in a
# 170-line manifest. These are LIVE and NOT yet cleaned:
#   • references/event-schema.md   — the OFF-MACHINE event contract; documents
#     catalyst.worker.to_disposition as "… | needs-human | cleared" for consumers
#     that are not in this repo.
#   • board-health.mjs             — emits move "review-needs-human" (28,904
#     records this month).
#   • recovery-reasoning.mjs       — emits metric "cohort_frozen_needs_human"
#     (11,044 records this month).
# A Loki/OTel rule keyed on any of these breaks silently if the string changes,
# so the ratchet pins them: they may shrink, never grow.
declare -a WATCHED=(
  "plugins/dev/references/event-schema.md|off-machine event contract"
  "plugins/dev/scripts/execution-core/board-health.mjs|emits review-needs-human"
  "plugins/dev/scripts/execution-core/recovery-reasoning.mjs|emits cohort_frozen_needs_human"
)
WATCH_OK=1
for row in "${WATCHED[@]}"; do
  wpath="${row%%|*}"; wwhy="${row##*|}"
  if ! grep -q "	${wpath}$" "${MANIFEST}"; then
    WATCH_OK=0
    info "NOT pinned by the manifest: ${wpath} (${wwhy})"
  fi
done
if (( WATCH_OK )); then
  ok "the three live event-string surfaces are pinned by the ratchet"
else
  fail "the three live event-string surfaces are pinned by the ratchet" \
       "a watched surface is absent from the manifest — either it was cleaned (regenerate the baseline) or the path moved"
fi

# ── Case 6 — the THIRD repo (informational; not a CI gate) ────────────────────
# catalyst-desktop-tryit lives outside BOTH repos and is invisible to a two-repo
# sweep: src-tauri/src/lib.rs:107 `let label = if att == "needs-human" {`. It
# cannot be edited from here and is not checked out in CI, so this reports
# rather than fails — a red CI check for a repo this one cannot fix is worse
# than a loud note.
THIRD_REPO="${THIRD_REPO_PATH:-/Users/ryan/catalyst/catalyst-desktop-tryit}"
if [[ -d "${THIRD_REPO}" ]]; then
  THIRD_HITS="$(rg --no-ignore --hidden -c "${PATTERN}" -g '!node_modules/**' -g '!.git/**' -g '!target/**' "${THIRD_REPO}" 2>/dev/null | awk -F: '{s+=$NF} END{print s+0}')"
  if [[ "${THIRD_HITS}" -eq 0 ]]; then
    ok "third repo (catalyst-desktop-tryit) carries no needs-human"
  else
    info "⚠️  third repo NOT clean: ${THIRD_HITS} occurrence(s) under ${THIRD_REPO}"
    info "    e.g. src-tauri/src/lib.rs — 'let label = if att == \"needs-human\"'."
    info "    Out of scope for this repo; tracked separately. Not a failure here."
  fi
else
  info "third repo not reachable at ${THIRD_REPO} — SKIPPED (this is not a zero)"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "Results: ${PASSES} passed, ${FAILURES} failed"
[[ "${FAILURES}" -eq 0 ]] || exit 1
