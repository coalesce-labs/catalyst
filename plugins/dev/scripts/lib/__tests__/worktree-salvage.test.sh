#!/usr/bin/env bash
# Tests for lib/worktree-salvage.sh + lib/worktree-salvage-telemetry.sh (CTL-1639).
# Run: bash plugins/dev/scripts/lib/__tests__/worktree-salvage.test.sh
#
# Auto-discovered by run-tests.sh via LIB_SHELL_TEST_DIR (lib/__tests__/*.test.sh);
# NO scripts/__tests__/*-lib.test.sh wrapper (that would double-run).

set -uo pipefail

# The suite asserts JSONL fields via jq and builds scratch git repos. A jq-less
# host cannot exercise it — emit the run-tests.sh clean-skip marker (column 0).
if ! command -v jq >/dev/null 2>&1; then
  echo "SKIP: worktree-salvage tests require jq (not on PATH)"
  exit 0
fi
if ! command -v git >/dev/null 2>&1; then
  echo "SKIP: worktree-salvage tests require git (not on PATH)"
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SALVAGE_LIB="${LIB_DIR}/worktree-salvage.sh"

FAILURES=0
PASSES=0
SCRATCH="$(mktemp -d -t worktree-salvage-test-XXXXXX)"
trap 'rm -rf "$SCRATCH"' EXIT

pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; }
assert_eq() {
  local expected="$1" actual="$2" label="$3"
  if [[ "$expected" == "$actual" ]]; then pass "$label"; else
    fail "$label — expected '$expected', got '$actual'"
  fi
}
assert_true()  { if eval "$1"; then pass "$2"; else fail "$2 — [$1] was false"; fi; }
assert_false() { if eval "$1"; then fail "$2 — [$1] was true"; else pass "$2"; fi; }

# Git needs an identity in scratch repos.
export GIT_AUTHOR_NAME="test" GIT_AUTHOR_EMAIL="test@example.com"
export GIT_COMMITTER_NAME="test" GIT_COMMITTER_EMAIL="test@example.com"

# Point salvage + events at scratch dirs before sourcing.
export CATALYST_SALVAGE_DIR="${SCRATCH}/salvage"
export CATALYST_EVENTS_DIR="${SCRATCH}/events"

# shellcheck source=../worktree-salvage.sh
source "$SALVAGE_LIB"

echo "worktree-salvage tests (CTL-1639)"

EVENT_LOG="${CATALYST_EVENTS_DIR}/$(date -u +%Y-%m).jsonl"
last_event_line() { tail -n1 "$EVENT_LOG" 2>/dev/null || echo ""; }
reset_events()    { rm -f "$EVENT_LOG" 2>/dev/null || true; }
clean_salvage()   { rm -rf "$CATALYST_SALVAGE_DIR" 2>/dev/null || true; mkdir -p "$CATALYST_SALVAGE_DIR"; }

# make_repo <dir> [flags...] — build an origin + cloned worktree with a pushed base.
#   --unpushed   add a committed-but-unpushed commit
#   --dirty      add an uncommitted tracked edit
#   --untracked  add an untracked file
make_repo() {
  local root="$1"; shift
  local origin="${root}/origin.git" wt="${root}/wt"
  rm -rf "$root"; mkdir -p "$root"
  git init --quiet --bare "$origin"
  # CTL-1639 (Codex #3026 P1): fail CLOSED. An unchecked clone plus a bare `cd`
  # meant that if either failed the subshell kept running in the CURRENT directory —
  # the real checkout — and executed `git add`/`git commit` there. Every cd is now
  # chained, matching AGENTS.md's rule against a bare `cd` on its own line.
  git clone --quiet "$origin" "$wt" 2>/dev/null || { echo "FAIL: fixture clone failed"; exit 1; }
  ( cd "$wt" || exit 1
    printf 'base\n' > base.txt
    git add base.txt
    git commit --quiet -m "base"
    git push --quiet origin HEAD:refs/heads/main 2>/dev/null
    git branch --quiet --set-upstream-to=origin/main 2>/dev/null || true
  )
  local f
  for f in "$@"; do case "$f" in
    --unpushed)  ( cd "$wt" || exit 1; printf 'more\n' > feature.txt; git add feature.txt; git commit --quiet -m "unpushed feature" ) ;;
    --dirty)     ( cd "$wt" || exit 1; printf 'edited\n' >> base.txt ) ;;
    --untracked) ( cd "$wt" || exit 1; printf 'scratch\n' > untracked.txt ) ;;
  esac; done
  printf '%s' "$wt"
}

# ── T1  unpushed commits only ───────────────────────────────────────────────
echo "T1 unpushed commits only"
reset_events; clean_salvage
WT="$(make_repo "${SCRATCH}/t1" --unpushed)"
salvage_worktree "$WT" TEST-1 --site t1
BUNDLE="$(ls "${CATALYST_SALVAGE_DIR}"/TEST-1-*.bundle 2>/dev/null | head -1)"
assert_true  "[[ -f '$BUNDLE' ]]" "T1 bundle written"
assert_true  "git -C '$WT' bundle verify '$BUNDLE' >/dev/null 2>&1" "T1 bundle verify passes"
assert_false "ls '${CATALYST_SALVAGE_DIR}'/TEST-1-*.patch >/dev/null 2>&1" "T1 no patch (clean tree)"
LINE="$(last_event_line)"
assert_eq "worktree.salvage.created" "$(jq -r '.attributes["event.name"]' <<<"$LINE")" "T1 created event"
assert_true "[[ $(jq -r '.body.payload.commits_saved' <<<"$LINE") -gt 0 ]]" "T1 commits_saved>0"

# ── T2  dirty tracked tree only ─────────────────────────────────────────────
echo "T2 dirty tracked tree only"
reset_events; clean_salvage
WT="$(make_repo "${SCRATCH}/t2" --dirty)"
salvage_worktree "$WT" TEST-2 --site t2
PATCH="$(ls "${CATALYST_SALVAGE_DIR}"/TEST-2-*.patch 2>/dev/null | head -1)"
assert_true  "[[ -s '$PATCH' ]]" "T2 patch written & non-empty"
assert_true  "grep -q 'base.txt' '$PATCH'" "T2 patch contains the diff"
assert_false "ls '${CATALYST_SALVAGE_DIR}'/TEST-2-*.bundle >/dev/null 2>&1" "T2 no bundle (nothing unpushed)"
LINE="$(last_event_line)"
assert_eq "worktree.salvage.created" "$(jq -r '.attributes["event.name"]' <<<"$LINE")" "T2 created event"
assert_true "[[ $(jq -r '.body.payload.files_changed' <<<"$LINE") -gt 0 ]]" "T2 files_changed>0"

# ── T3  untracked files only ────────────────────────────────────────────────
echo "T3 untracked files only"
reset_events; clean_salvage
WT="$(make_repo "${SCRATCH}/t3" --untracked)"
salvage_worktree "$WT" TEST-3 --site t3
UNTAR="$(ls "${CATALYST_SALVAGE_DIR}"/TEST-3-*-untracked.tar 2>/dev/null | head -1)"
assert_true "[[ -f '$UNTAR' ]]" "T3 untracked tar written"
assert_true "tar -tf '$UNTAR' 2>/dev/null | grep -q 'untracked.txt'" "T3 tar lists the untracked file"
LINE="$(last_event_line)"
assert_eq "worktree.salvage.created" "$(jq -r '.attributes["event.name"]' <<<"$LINE")" "T3 created event"
assert_true "[[ $(jq -r '.body.payload.untracked_count' <<<"$LINE") -gt 0 ]]" "T3 untracked_count>0"

# ── T4  all three at once ───────────────────────────────────────────────────
echo "T4 all three at once"
reset_events; clean_salvage
WT="$(make_repo "${SCRATCH}/t4" --unpushed --dirty --untracked)"
salvage_worktree "$WT" TEST-4 --site t4
assert_true "ls '${CATALYST_SALVAGE_DIR}'/TEST-4-*.bundle >/dev/null 2>&1" "T4 bundle present"
assert_true "ls '${CATALYST_SALVAGE_DIR}'/TEST-4-*.patch >/dev/null 2>&1" "T4 patch present"
assert_true "ls '${CATALYST_SALVAGE_DIR}'/TEST-4-*-untracked.tar >/dev/null 2>&1" "T4 untracked tar present"
LINE="$(last_event_line)"
assert_eq "1" "$(grep -c 'worktree.salvage' "$EVENT_LOG")" "T4 exactly one salvage event"
assert_eq "worktree.salvage.created" "$(jq -r '.attributes["event.name"]' <<<"$LINE")" "T4 single created event"
assert_true "[[ $(jq -r '.body.payload.commits_saved' <<<"$LINE") -gt 0 ]]" "T4 commits_saved counted"
assert_true "[[ $(jq -r '.body.payload.files_changed' <<<"$LINE") -gt 0 ]]" "T4 files_changed counted"
assert_true "[[ $(jq -r '.body.payload.untracked_count' <<<"$LINE") -gt 0 ]]" "T4 untracked_count counted"

# ── T5  clean & fully pushed → skipped ──────────────────────────────────────
echo "T5 clean & fully pushed"
reset_events; clean_salvage
WT="$(make_repo "${SCRATCH}/t5")"
salvage_worktree "$WT" TEST-5 --site t5
assert_false "ls '${CATALYST_SALVAGE_DIR}'/TEST-5-* >/dev/null 2>&1" "T5 no artifacts written"
LINE="$(last_event_line)"
assert_eq "worktree.salvage.skipped" "$(jq -r '.attributes["event.name"]' <<<"$LINE")" "T5 skipped event"
assert_eq "1" "$(grep -c 'worktree.salvage' "$EVENT_LOG")" "T5 exactly one event"

# ── T6  return code is ALWAYS 0 (unwritable dir → failed) ────────────────────
echo "T6 return code always 0 + failed event"
reset_events
WT="$(make_repo "${SCRATCH}/t6" --unpushed)"
UNWRITABLE="${SCRATCH}/t6-nowrite"
mkdir -p "$UNWRITABLE"; chmod 500 "$UNWRITABLE"
CATALYST_SALVAGE_DIR="${UNWRITABLE}/salvage" salvage_worktree "$WT" TEST-6 --site t6
assert_eq "0" "$?" "T6 salvage_worktree returned 0"
LINE="$(last_event_line)"
assert_eq "worktree.salvage.failed" "$(jq -r '.attributes["event.name"]' <<<"$LINE")" "T6 failed event"
assert_eq "WARN" "$(jq -r '.severityText' <<<"$LINE")" "T6 failed severity WARN"
chmod 700 "$UNWRITABLE" 2>/dev/null || true

# ── T7  atomicity — no leftover .tmp files ──────────────────────────────────
echo "T7 atomicity"
reset_events; clean_salvage
WT="$(make_repo "${SCRATCH}/t7" --unpushed --dirty --untracked)"
salvage_worktree "$WT" TEST-7 --site t7
assert_false "ls '${CATALYST_SALVAGE_DIR}'/*.tmp.* >/dev/null 2>&1" "T7 no leftover .tmp files"

# ── T8  no refs/stash mutation ──────────────────────────────────────────────
echo "T8 no refs/stash mutation"
reset_events; clean_salvage
WT="$(make_repo "${SCRATCH}/t8" --unpushed --dirty)"
salvage_worktree "$WT" TEST-8 --site t8
assert_false "git -C '$WT' rev-parse refs/stash >/dev/null 2>&1" "T8 refs/stash still absent"

# ── T9  filename shape (ts + collision-proof unique suffix) ─────────────────
echo "T9 filename shape"
reset_events; clean_salvage
WT="$(make_repo "${SCRATCH}/t9" --unpushed --dirty)"
salvage_worktree "$WT" TEST-9 --site t9
BUNDLE="$(ls "${CATALYST_SALVAGE_DIR}"/*.bundle 2>/dev/null | head -1)"
PATCH="$(ls "${CATALYST_SALVAGE_DIR}"/*.patch 2>/dev/null | head -1)"
assert_true "[[ '$(basename "$BUNDLE")' =~ ^TEST-9-[0-9]{8}T[0-9]{6}Z-[0-9]+-[0-9]+\.bundle$ ]]" "T9 bundle name shape (ts+pid+rand)"
assert_true "[[ '$(basename "$PATCH")' =~ ^TEST-9-[0-9]{8}T[0-9]{6}Z-[0-9]+-[0-9]+\.patch$ ]]" "T9 patch name shape (ts+pid+rand)"

# ── T10 non-git / missing path → returns 0, emits failed ────────────────────
echo "T10 non-git / missing path"
reset_events; clean_salvage
salvage_worktree "${SCRATCH}/does-not-exist" TEST-10 --site t10
assert_eq "0" "$?" "T10 returned 0 on missing path"
LINE="$(last_event_line)"
assert_eq "worktree.salvage.failed" "$(jq -r '.attributes["event.name"]' <<<"$LINE")" "T10 failed event"
assert_false "ls '${CATALYST_SALVAGE_DIR}'/TEST-10-* >/dev/null 2>&1" "T10 wrote nothing"

# ── T11 created event envelope ──────────────────────────────────────────────
echo "T11 created event envelope"
reset_events; clean_salvage
WT="$(make_repo "${SCRATCH}/t11" --unpushed --dirty --untracked)"
salvage_worktree "$WT" TEST-11 --orch ORCH-X --reason my-reason --site my-site
LINE="$(last_event_line)"
assert_eq "catalyst.worktree-salvage" "$(jq -r '.resource["service.name"]' <<<"$LINE")" "T11 service name"
assert_eq "worktree.salvage.created" "$(jq -r '.attributes["event.name"]' <<<"$LINE")" "T11 event name"
assert_eq "INFO" "$(jq -r '.severityText' <<<"$LINE")" "T11 severity INFO"
assert_eq "ORCH-X" "$(jq -r '.attributes["catalyst.orchestrator.id"]' <<<"$LINE")" "T11 orch attribute"
assert_eq "my-reason" "$(jq -r '.body.payload.reason' <<<"$LINE")" "T11 payload.reason"
assert_eq "my-site" "$(jq -r '.body.payload.site' <<<"$LINE")" "T11 payload.site"
assert_eq "TEST-11" "$(jq -r '.body.payload.ticket' <<<"$LINE")" "T11 payload.ticket"
for k in bundle patch index_patch untracked_tar commits_saved files_changed untracked_count; do
  assert_true "jq -e '.body.payload | has(\"$k\")' <<<'$LINE' >/dev/null" "T11 payload has $k"
done

# ── T12 skipped severity INFO, failed severity WARN ─────────────────────────
echo "T12 severities"
reset_events; clean_salvage
WT="$(make_repo "${SCRATCH}/t12")"
salvage_worktree "$WT" TEST-12 --site t12
assert_eq "INFO" "$(jq -r '.severityText' <<<"$(last_event_line)")" "T12 skipped severity INFO"

# ── T13 events land in monthly file ─────────────────────────────────────────
echo "T13 monthly event file"
assert_true "[[ -f '$EVENT_LOG' ]]" "T13 events in ${CATALYST_EVENTS_DIR}/YYYY-MM.jsonl"

# ── T14 index-only staged delta captured separately (Codex P1) ──────────────
# Stage a change, then restore the WORKING file back to HEAD content. `git diff
# HEAD` (working-vs-HEAD) is then empty, but the staged delta must still be saved.
echo "T14 index-only staged delta"
reset_events; clean_salvage
WT="$(make_repo "${SCRATCH}/t14")"
( cd "$WT"
  printf 'staged-change\n' >> base.txt
  git add base.txt
  git checkout-index -f base.txt   # restore working file to HEAD; index keeps the staged delta
  printf 'base\n' > base.txt        # belt: working tree == HEAD content
)
salvage_worktree "$WT" TEST-14 --site t14
IDXPATCH="$(ls "${CATALYST_SALVAGE_DIR}"/TEST-14-*.index.patch 2>/dev/null | head -1)"
assert_true  "[[ -s '$IDXPATCH' ]]" "T14 index patch written for staged-only delta"
assert_true  "grep -q 'staged-change' '$IDXPATCH'" "T14 index patch carries the staged content"
assert_eq "worktree.salvage.created" "$(jq -r '.attributes["event.name"]' <<<"$(last_event_line)")" "T14 created (not skipped)"

# ── T15 binary tracked change → bytes captured via --binary (Codex P1) ──────
echo "T15 binary tracked change"
reset_events; clean_salvage
WT="$(make_repo "${SCRATCH}/t15")"
( cd "$WT"
  printf '\x00\x01\x02BIN' > blob.bin; git add blob.bin; git commit --quiet -m "add binary"
  git push --quiet origin HEAD:refs/heads/main 2>/dev/null || true
  printf '\x00\x01\x02\x03\x04CHANGED' > blob.bin   # tracked binary edit
)
salvage_worktree "$WT" TEST-15 --site t15
PATCH="$(ls "${CATALYST_SALVAGE_DIR}"/TEST-15-*.patch 2>/dev/null | head -1)"
assert_true "[[ -s '$PATCH' ]]" "T15 patch written for binary edit"
assert_true "grep -q 'GIT binary patch' '$PATCH'" "T15 patch is a restorable git binary patch (not a 'differ' marker)"

# ── T16 collision-proof names — two salvages, same ticket, same second ───────
echo "T16 collision-proof artifact names"
reset_events; clean_salvage
WT="$(make_repo "${SCRATCH}/t16" --unpushed)"
salvage_worktree "$WT" TEST-16 --site t16a
salvage_worktree "$WT" TEST-16 --site t16b
NBUNDLES="$(ls "${CATALYST_SALVAGE_DIR}"/TEST-16-*.bundle 2>/dev/null | wc -l | tr -d ' ')"
assert_true "[[ '$NBUNDLES' -eq 2 ]]" "T16 two rapid salvages keep two distinct bundles (no silent overwrite)"

# ── T17 bundle I/O failure with commits present → failed, not skipped ────────
# A read-only salvage dir with unpushed commits present must report failed (the
# work was NOT saved), never skipped (which would imply an otherwise-clean tree).
echo "T17 bundle I/O failure is not an empty-bundle skip"
reset_events
WT="$(make_repo "${SCRATCH}/t17" --unpushed)"
RO_DIR="${SCRATCH}/t17-ro"; mkdir -p "$RO_DIR"; chmod 500 "$RO_DIR"
CATALYST_SALVAGE_DIR="${RO_DIR}/salvage" salvage_worktree "$WT" TEST-17 --site t17
assert_eq "worktree.salvage.failed" "$(jq -r '.attributes["event.name"]' <<<"$(last_event_line)")" "T17 unpushed + unwritable dir → failed (not skipped)"
chmod 700 "$RO_DIR" 2>/dev/null || true

# ── T18 diff.external + color.ui=always neutralized (Codex P1) ──────────────
echo "T18 diff.external + forced color neutralized"
reset_events; clean_salvage
WT="$(make_repo "${SCRATCH}/t18" --dirty)"
( cd "$WT"
  git config diff.external "sh -c 'exit 7'"   # would abort `git diff` if honored
  git config color.ui always                  # would inject ANSI escapes if honored
)
salvage_worktree "$WT" TEST-18 --site t18
PATCH="$(ls "${CATALYST_SALVAGE_DIR}"/TEST-18-*.patch 2>/dev/null | head -1)"
assert_true  "[[ -s '$PATCH' ]]" "T18 patch written despite diff.external + forced color"
assert_false "grep -q \"$(printf '\\033')\\[\" '$PATCH'" "T18 patch carries no ANSI color escapes"
assert_eq "worktree.salvage.created" "$(jq -r '.attributes["event.name"]' <<<"$(last_event_line)")" "T18 created (external-diff didn't abort the diff)"

# ── T19 textconv neutralized — real bytes, not the converted text (Codex P1) ─
echo "T19 textconv neutralized"
reset_events; clean_salvage
WT="$(make_repo "${SCRATCH}/t19")"
( cd "$WT"
  printf '\x00\x01ORIG' > conv.bin; git add conv.bin; git commit --quiet -m "add conv.bin"
  git push --quiet origin HEAD:refs/heads/main 2>/dev/null || true
  printf '[diff "hexdump"]\n\ttextconv = "od -An -tx1"\n' >> .git/config
  echo "conv.bin diff=hexdump" > .gitattributes
  printf '\x00\x01\x02CHANGED' > conv.bin
)
salvage_worktree "$WT" TEST-19 --site t19
PATCH="$(ls "${CATALYST_SALVAGE_DIR}"/TEST-19-*.patch 2>/dev/null | head -1)"
assert_true "[[ -s '$PATCH' ]]" "T19 patch written"
assert_true "grep -q 'GIT binary patch\\|Binary files' '$PATCH'" "T19 patch reflects real (binary) bytes, not od-hexdump text"

# ── T20 dirty submodule content archived recursively (Codex P1) ─────────────
echo "T20 dirty submodule content archived"
reset_events; clean_salvage
SUBORIGIN="${SCRATCH}/t20-sub/sub-origin.git"
git init --quiet --bare "$SUBORIGIN"
SUBSCRATCH="${SCRATCH}/t20-sub/sub-seed"
git clone --quiet "$SUBORIGIN" "$SUBSCRATCH" 2>/dev/null
( cd "$SUBSCRATCH"; printf 'sub-base\n' > sub.txt; git add sub.txt; git commit --quiet -m sub-base; git push --quiet origin HEAD:refs/heads/main )
WT="$(make_repo "${SCRATCH}/t20")"
( cd "$WT"
  # Register the submodule WITHOUT `git submodule add` — its internal fetch is
  # subject to `protocol.file.allow` submodule-recursive-clone restrictions
  # (CVE-2022-39253 hardening; default varies by git build/CI image, e.g. a
  # `-c protocol.file.allow=always` on the add command doesn't reliably reach
  # git's own internal clone step everywhere). A plain top-level `git clone`
  # is always a "user" action and unaffected, so clone it ourselves and wire
  # up .gitmodules + the 160000 gitlink by hand — a completely portable,
  # protocol-restriction-proof way to end up with the exact same on-disk
  # shape (.gitmodules + gitlink + a real nested checkout) that
  # `git submodule status --recursive` inspects.
  # -b main (NOT a bare `git clone`): the bare $SUBORIGIN's own HEAD symref
  # still points at whatever `init.defaultBranch` defaulted to (varies by git
  # config — "master" on some CI images, "main" locally) and that branch was
  # NEVER created (only "main" was ever pushed to), so an unqualified clone
  # prints "remote HEAD refers to nonexistent ref" and checks out NOTHING —
  # `subdir` ends up a bare, file-less .git dir and every assertion below
  # fails on an empty SUB_SHA. Ask for the branch we know exists, explicitly.
  git clone --quiet -b main "$SUBORIGIN" subdir
  git config -f .gitmodules submodule.subdir.path subdir
  git config -f .gitmodules submodule.subdir.url "$SUBORIGIN"
  git add .gitmodules
  # The 160000 gitlink MUST be staged BEFORE `git submodule init` — init reads
  # the INDEX (not just .gitmodules) to know which paths are submodules, so
  # calling it before the gitlink exists is a silent no-op (exit 0, nothing
  # written to .git/config). `git submodule init` itself is a config-only
  # copy (no network I/O) — without it the submodule shows as
  # NOT-INITIALIZED ('-' status prefix) even though a real checkout is
  # sitting right there, and `submodule status --recursive` (what
  # salvage_worktree walks) skips it.
  SUB_SHA="$(git -C subdir rev-parse HEAD)"
  git update-index --add --cacheinfo 160000,"$SUB_SHA",subdir
  git submodule init >/dev/null
  git commit --quiet -m "add submodule"
  printf 'sub-dirty-edit\n' >> subdir/sub.txt   # uncommitted edit INSIDE the submodule
  printf 'sub-untracked\n' > subdir/scratch.txt  # untracked file INSIDE the submodule
)
salvage_worktree "$WT" TEST-20 --site t20
# Artifact names carry a trailing `-<hash>` collision-proofing suffix on the
# submodule path component (Codex round-4 P1: two distinct submodule paths
# that normalize the same way, e.g. `vendor/foo` and `vendor_foo`, must not
# derive the same artifact name) — glob past it rather than pin the exact hash.
SM_PATCH="$(ls "${CATALYST_SALVAGE_DIR}"/TEST-20-*.submodule-subdir-*.patch 2>/dev/null | head -1)"
SM_TAR="$(ls "${CATALYST_SALVAGE_DIR}"/TEST-20-*.submodule-subdir-*-untracked.tar 2>/dev/null | head -1)"
assert_true "[[ -s '$SM_PATCH' ]]" "T20 submodule's own uncommitted diff archived"
assert_true "grep -q 'sub-dirty-edit' '$SM_PATCH'" "T20 submodule patch carries the actual edit bytes"
assert_true "[[ -f '$SM_TAR' ]]" "T20 submodule's own untracked file archived"
assert_true "tar -tf '$SM_TAR' 2>/dev/null | grep -q 'scratch.txt'" "T20 submodule tar lists the untracked file"
LINE="$(last_event_line)"
assert_eq "worktree.salvage.created" "$(jq -r '.attributes["event.name"]' <<<"$LINE")" "T20 created event"
assert_true "[[ $(jq -r '.body.payload.submodules_saved' <<<"$LINE") -gt 0 ]]" "T20 submodules_saved>0"

# ── T21 assume-unchanged edit still detected (Codex P1) ─────────────────────
echo "T21 assume-unchanged edit detected"
reset_events; clean_salvage
WT="$(make_repo "${SCRATCH}/t21")"
( cd "$WT"
  git update-index --assume-unchanged base.txt
  printf 'assume-unchanged-edit\n' >> base.txt
)
assert_true "git -C '$WT' diff --quiet HEAD" "T21 sanity: plain git diff is blind to the assume-unchanged edit"
salvage_worktree "$WT" TEST-21 --site t21
PATCH="$(ls "${CATALYST_SALVAGE_DIR}"/TEST-21-*.patch 2>/dev/null | head -1)"
assert_true "[[ -s '$PATCH' ]]" "T21 patch written for the assume-unchanged edit"
assert_true "grep -q 'assume-unchanged-edit' '$PATCH'" "T21 patch carries the actual edit bytes"
assert_eq "worktree.salvage.created" "$(jq -r '.attributes["event.name"]' <<<"$(last_event_line)")" "T21 created (not skipped)"

# ── T22 salvage_raw_directory — non-git directory archived before rm -rf ────
# (orphan-sweep's ORPHAN_GITFILE case: a stale/missing .git pointer, not a
# usable git worktree, so salvage_worktree (git-based) can't inspect it at all.)
echo "T22 salvage_raw_directory"
reset_events; clean_salvage
RAWDIR="${SCRATCH}/t22-raw"; mkdir -p "$RAWDIR/nested"
printf 'orphan-content\n' > "${RAWDIR}/file.txt"
printf 'nested-content\n' > "${RAWDIR}/nested/inner.txt"
salvage_raw_directory "$RAWDIR" TEST-22 --site t22
RAWTAR="$(ls "${CATALYST_SALVAGE_DIR}"/TEST-22-*-raw.tar 2>/dev/null | head -1)"
assert_true "[[ -f '$RAWTAR' ]]" "T22 raw tar written"
assert_true "tar -tf '$RAWTAR' 2>/dev/null | grep -q 'file.txt'" "T22 tar lists top-level file"
assert_true "tar -tf '$RAWTAR' 2>/dev/null | grep -q 'nested/inner.txt'" "T22 tar lists nested file"
LINE="$(last_event_line)"
assert_eq "worktree.salvage.created" "$(jq -r '.attributes["event.name"]' <<<"$LINE")" "T22 created event"
assert_eq "TEST-22" "$(jq -r '.body.payload.ticket' <<<"$LINE")" "T22 payload.ticket"

echo "T23 salvage_raw_directory — empty dir is a clean skip, not a failure"
reset_events; clean_salvage
EMPTYDIR="${SCRATCH}/t23-empty"; mkdir -p "$EMPTYDIR"
salvage_raw_directory "$EMPTYDIR" TEST-23 --site t23
assert_false "ls '${CATALYST_SALVAGE_DIR}'/TEST-23-* >/dev/null 2>&1" "T23 no artifact for an empty dir"
assert_eq "worktree.salvage.skipped" "$(jq -r '.attributes["event.name"]' <<<"$(last_event_line)")" "T23 skipped event"

echo "T24 salvage_raw_directory — missing path returns 0, emits failed"
reset_events; clean_salvage
salvage_raw_directory "${SCRATCH}/does-not-exist-raw" TEST-24 --site t24
assert_eq "0" "$?" "T24 returned 0 on missing path"
assert_eq "worktree.salvage.failed" "$(jq -r '.attributes["event.name"]' <<<"$(last_event_line)")" "T24 failed event"

# ── Sentinel-guard: sourcing twice is a no-op ───────────────────────────────
echo "Extra: idempotent source"
source "$SALVAGE_LIB"
assert_true "declare -F salvage_worktree >/dev/null" "re-source is a no-op (fn still defined)"

echo
echo "results: $PASSES passed, $FAILURES failed"
[ $FAILURES -eq 0 ]

# ─── CTL-1639 (Codex #3026 P1): hidden index flags inside SUBMODULES ──────────
# salvage_worktree cleared assume-unchanged/skip-worktree on the top-level worktree
# before diffing, but _wsv_salvage_submodule did not — so a submodule file carrying
# `assume-unchanged` had its edit invisible to the submodule's own `git diff` (exactly
# as it is to plain `git status`), the salvage recorded an EMPTY patch, and the
# destructive removal discarded the real edit.
echo ""
echo "Test: _wsv_clear_hidden_index_flags surfaces an assume-unchanged edit"
{
  d="${SCRATCH}/hidden-flags"
  rm -rf "$d"; mkdir -p "$d"
  git init --quiet "$d"
  ( cd "$d" || exit 1
    printf 'v1\n' > f.txt
    git add f.txt
    git -c user.email=t@t -c user.name=t commit --quiet -m base
    git update-index --assume-unchanged f.txt
    printf 'v2-EDITED\n' > f.txt
  )
  # Precondition: the edit is hidden while the flag is set.
  before="$(git -C "$d" diff HEAD -- f.txt | wc -l | tr -d ' ')"
  assert_eq "0" "$before" "assume-unchanged hides the edit from git diff (precondition)"
  _wsv_clear_hidden_index_flags "$d"
  after="$(git -C "$d" diff HEAD -- f.txt | wc -l | tr -d ' ')"
  [[ "$after" -gt 0 ]] \
    && echo "  PASS: clearing the flag makes the edit visible to git diff" \
    || { echo "  FAIL: edit still hidden after clearing (diff lines=$after)"; FAILED=$((FAILED+1)); }
}
