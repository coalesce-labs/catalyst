#!/usr/bin/env bash
# Unit tests for plugins/dev/scripts/lib/handoff-durability.sh (CTL-2104).
#
# Subject: the mechanical write-then-cite seam that removes every from-memory
# step from create-handoff's write path. Six overnight occurrences
# (2026-08-19/20) cited a filename the next turn could not find. The three
# independently-sufficient causes each get direct coverage here:
#   1. cross-project thoughts/shared divergence -> the ABSOLUTE realpath case
#   2. async sync race / genuine non-arrival     -> the not-in-pushed-tree case
#   3. placeholder-timestamp mismatch            -> the mechanical-stamp case
#
# Hermetic: a temp thoughts repo (with a bare remote so "pushed" is a real,
# checkable fact) plus a temp worktree whose thoughts/shared is a symlink into
# it. `humanlayer` is stubbed on PATH — the real binary is never invoked.
#
# Run: bash plugins/dev/scripts/lib/__tests__/handoff-durability.test.sh
# Bash-3.2 safe (no mapfile / declare -A / ${VAR,,}).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="${SCRIPT_DIR}/../handoff-durability.sh"

PASS=0
FAIL=0
ok()   { PASS=$((PASS+1)); printf '  PASS: %s\n' "$1"; }
fail() { FAIL=$((FAIL+1)); printf '  FAIL: %s\n    %s\n' "$1" "${2:-}"; }

[ -f "$HELPER" ] || { echo "FATAL: helper not found: $HELPER" >&2; exit 1; }

SCRATCH="$(mktemp -d -t handoff-durability-XXXXXX)"
# Resolve through /private on macOS so `pwd -P` comparisons are apples-to-apples.
SCRATCH="$(cd "$SCRATCH" && pwd -P)"
ORIG_PWD="$(pwd)"
ORIG_PATH="$PATH"
trap 'cd "$ORIG_PWD"; PATH="$ORIG_PATH"; rm -rf "$SCRATCH"' EXIT

# ── Fixture: one thoughts repo with a bare remote, two project subtrees ──────
THOUGHTS_REMOTE="${SCRATCH}/thoughts-remote.git"
THOUGHTS_REPO="${SCRATCH}/thoughts"
git init --quiet --bare "$THOUGHTS_REMOTE"
git init --quiet "$THOUGHTS_REPO"
git -C "$THOUGHTS_REPO" config user.email test@example.com
git -C "$THOUGHTS_REPO" config user.name "Test"
mkdir -p "${THOUGHTS_REPO}/repos/catalyst-workspace/shared" \
         "${THOUGHTS_REPO}/repos/catalyst-cloud/shared"
printf 'seed\n' > "${THOUGHTS_REPO}/repos/catalyst-workspace/shared/.keep"
printf 'seed\n' > "${THOUGHTS_REPO}/repos/catalyst-cloud/shared/.keep"
git -C "$THOUGHTS_REPO" add -A >/dev/null 2>&1
git -C "$THOUGHTS_REPO" commit --quiet -m seed >/dev/null 2>&1
git -C "$THOUGHTS_REPO" remote add origin "$THOUGHTS_REMOTE"
git -C "$THOUGHTS_REPO" push --quiet -u origin HEAD >/dev/null 2>&1

# Two worktrees whose IDENTICAL relative thoughts/shared path resolves to
# DIFFERENT physical subtrees — the dominant real-world failure mode.
make_worktree() {
  local wt="$1" project="$2"
  mkdir -p "${wt}/thoughts"
  ln -s "${THOUGHTS_REPO}/repos/${project}/shared" "${wt}/thoughts/shared"
}
WT_A="${SCRATCH}/wt-workspace"; make_worktree "$WT_A" catalyst-workspace
WT_B="${SCRATCH}/wt-cloud";     make_worktree "$WT_B" catalyst-cloud

# ── Stubbed `humanlayer` — behavior switched by HL_STUB_MODE ────────────────
STUBBIN="${SCRATCH}/bin"
mkdir -p "$STUBBIN"
cat > "${STUBBIN}/humanlayer" <<'STUB'
#!/usr/bin/env bash
# Stub: `humanlayer thoughts sync`. HL_STUB_MODE=ok|fail|noop
case "${HL_STUB_MODE:-ok}" in
  fail) echo "stub: sync conflict" >&2; exit 1 ;;
  noop) exit 0 ;;   # exits clean but commits/pushes nothing (the silent-abort case)
  *)
    # Real-ish success: commit and push everything in the thoughts repo.
    git -C "$HL_STUB_REPO" add -A >/dev/null 2>&1
    git -C "$HL_STUB_REPO" commit --quiet -m "thoughts sync" >/dev/null 2>&1
    git -C "$HL_STUB_REPO" push --quiet origin HEAD >/dev/null 2>&1
    exit 0 ;;
esac
STUB
chmod +x "${STUBBIN}/humanlayer"
export HL_STUB_REPO="$THOUGHTS_REPO"
PATH="${STUBBIN}:${PATH}"

# shellcheck source=../handoff-durability.sh
source "$HELPER"

echo "handoff-durability unit tests (CTL-2104)"
echo ""

# ─────────────────────────────────────────────────────────────────────────────
echo "Case 1: resolve echoes a mechanical stamp + an ABSOLUTE realpath"
cd "$WT_A"
OUT1="$(handoff_resolve_path CTL-2104 smoke-test 2>/dev/null)"
REL1="$(printf '%s\n' "$OUT1" | sed -n '1p')"
ABS1="$(printf '%s\n' "$OUT1" | sed -n '2p')"

case "$REL1" in
  thoughts/shared/handoffs/CTL-2104/*_smoke-test.md)
    ok "Case 1a: relative path uses the canonical layout ($REL1)" ;;
  *) fail "Case 1a: relative path uses the canonical layout" "got: $REL1" ;;
esac

# The stamp must be machine-generated YYYY-MM-DD_HH-MM-SS, never a model
# placeholder — failure mode #3.
STAMP1="$(basename "$REL1" | sed 's/_smoke-test\.md$//')"
if printf '%s' "$STAMP1" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}$'; then
  ok "Case 1b: timestamp is a mechanical YYYY-MM-DD_HH-MM-SS stamp ($STAMP1)"
else
  fail "Case 1b: timestamp is a mechanical YYYY-MM-DD_HH-MM-SS stamp" "got: $STAMP1"
fi

case "$ABS1" in
  /*) ok "Case 1c: second line is an absolute path ($ABS1)" ;;
  *)  fail "Case 1c: second line is an absolute path" "got: $ABS1" ;;
esac
# It must resolve THROUGH the symlink into the physical thoughts subtree —
# a citation that merely re-states $PWD/thoughts/shared/... is still ambiguous.
case "$ABS1" in
  "${THOUGHTS_REPO}/repos/catalyst-workspace/shared/handoffs/CTL-2104/"*)
    ok "Case 1d: absolute path resolves through the symlink into the physical subtree" ;;
  *) fail "Case 1d: absolute path resolves through the symlink into the physical subtree" "got: $ABS1" ;;
esac

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "Case 2: the SAME relative path from two cwds -> two DIFFERENT absolute paths"
cd "$WT_B"
OUT2="$(handoff_resolve_path CTL-2104 smoke-test 2>/dev/null)"
REL2="$(printf '%s\n' "$OUT2" | sed -n '1p')"
ABS2="$(printf '%s\n' "$OUT2" | sed -n '2p')"

# Positive control: the relative paths agree on directory+description, which is
# exactly why a relative citation cannot disambiguate the two subtrees.
if [ "$(dirname "$REL1")" = "$(dirname "$REL2")" ]; then
  ok "Case 2a (positive control): relative dirs are IDENTICAL across projects"
else
  fail "Case 2a (positive control): relative dirs are IDENTICAL across projects" \
       "A=$(dirname "$REL1") B=$(dirname "$REL2")"
fi
if [ "$ABS1" != "$ABS2" ]; then
  ok "Case 2b: absolute paths DIFFER, disambiguating the divergence"
else
  fail "Case 2b: absolute paths DIFFER, disambiguating the divergence" "both: $ABS1"
fi
case "$ABS2" in
  "${THOUGHTS_REPO}/repos/catalyst-cloud/shared/"*)
    ok "Case 2c: cloud worktree resolves into the cloud subtree" ;;
  *) fail "Case 2c: cloud worktree resolves into the cloud subtree" "got: $ABS2" ;;
esac

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "Case 3: write_verified creates missing parents and lands the exact bytes"
cd "$WT_A"
SRC="${SCRATCH}/content.md"
printf -- '---\ntype: handoff\n---\n\n# Handoff\n\nbody line\n' > "$SRC"
if [ -d "$(dirname "$ABS1")" ]; then
  fail "Case 3a (precondition): parent dir must NOT exist yet" "$(dirname "$ABS1")"
else
  ok "Case 3a (precondition): parent dir does not exist yet"
fi
WROTE="$(handoff_write_verified "$ABS1" "$SRC" 2>/dev/null)"
RC3=$?
if [ "$RC3" -eq 0 ]; then ok "Case 3b: write_verified exits 0"
else fail "Case 3b: write_verified exits 0" "rc=$RC3"; fi
if [ -f "$ABS1" ]; then ok "Case 3c: the file exists at the echoed absolute path"
else fail "Case 3c: the file exists at the echoed absolute path" "missing: $ABS1"; fi
if [ "$WROTE" = "$ABS1" ]; then ok "Case 3d: it echoes back the same absolute path"
else fail "Case 3d: it echoes back the same absolute path" "echoed=$WROTE want=$ABS1"; fi
if cmp -s "$SRC" "$ABS1"; then ok "Case 3e: on-disk bytes are identical to the source"
else fail "Case 3e: on-disk bytes are identical to the source" "cmp differs"; fi
# The citation must be reachable via the RELATIVE path too, from this cwd.
if [ -f "$REL1" ]; then ok "Case 3f: the relative citation also resolves from this cwd"
else fail "Case 3f: the relative citation also resolves from this cwd" "missing: $REL1"; fi

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "Case 4: write_verified FAILS LOUD when the on-disk bytes do not match"
BAD_DEST="${SCRATCH}/readonly-dir/nested/x.md"
mkdir -p "${SCRATCH}/readonly-dir"
chmod 500 "${SCRATCH}/readonly-dir"
ERR4="$(handoff_write_verified "$BAD_DEST" "$SRC" 2>&1 >/dev/null)"
RC4=$?
chmod 700 "${SCRATCH}/readonly-dir"
if [ "$RC4" -ne 0 ]; then ok "Case 4a: unwritable destination exits non-zero (rc=$RC4)"
else fail "Case 4a: unwritable destination exits non-zero" "rc=0 — a silent false success"; fi
if [ -n "$ERR4" ]; then ok "Case 4b: it is LOUD on stderr"
else fail "Case 4b: it is LOUD on stderr" "stderr was empty"; fi
# Missing source is also refused, never a zero-byte "successful" handoff.
handoff_write_verified "${SCRATCH}/dest-nosrc.md" "${SCRATCH}/does-not-exist" >/dev/null 2>&1
RC4C=$?
if [ "$RC4C" -ne 0 ]; then ok "Case 4c: a missing content source is refused (rc=$RC4C)"
else fail "Case 4c: a missing content source is refused" "rc=0"; fi

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "Case 5: sync_and_classify => 'synced' when sync succeeds AND the file is pushed"
HL_STUB_MODE=ok
export HL_STUB_MODE
V5="$(handoff_sync_and_classify "$ABS1" 2>/dev/null)"
if [ "$V5" = "synced" ]; then
  ok "Case 5 (POSITIVE CONTROL): verdict is 'synced' — proves a non-local-only answer is reachable"
else
  fail "Case 5 (POSITIVE CONTROL): verdict is 'synced'" "got: '$V5'"
fi

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "Case 6: sync_and_classify => 'local-only:sync-failed' when sync exits non-zero"
cd "$WT_A"
OUT6="$(handoff_resolve_path CTL-2104 sync-fails 2>/dev/null)"
ABS6="$(printf '%s\n' "$OUT6" | sed -n '2p')"
handoff_write_verified "$ABS6" "$SRC" >/dev/null 2>&1
HL_STUB_MODE=fail
V6="$(handoff_sync_and_classify "$ABS6" 2>/dev/null)"
if [ "$V6" = "local-only:sync-failed" ]; then
  ok "Case 6: verdict is 'local-only:sync-failed'"
else
  fail "Case 6: verdict is 'local-only:sync-failed'" "got: '$V6'"
fi

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "Case 7: sync_and_classify => 'local-only:not-in-pushed-tree' when sync exits 0"
echo "        but the file never reached the pushed tree (the silent-abort case)"
cd "$WT_A"
OUT7="$(handoff_resolve_path CTL-2104 never-arrived 2>/dev/null)"
ABS7="$(printf '%s\n' "$OUT7" | sed -n '2p')"
handoff_write_verified "$ABS7" "$SRC" >/dev/null 2>&1
HL_STUB_MODE=noop
V7="$(handoff_sync_and_classify "$ABS7" 2>/dev/null)"
if [ "$V7" = "local-only:not-in-pushed-tree" ]; then
  ok "Case 7: verdict is 'local-only:not-in-pushed-tree'"
else
  fail "Case 7: verdict is 'local-only:not-in-pushed-tree'" "got: '$V7'"
fi
# The file is still on disk and still citeable — no work lost.
if [ -f "$ABS7" ]; then ok "Case 7b: the file survives a local-only verdict (no work lost)"
else fail "Case 7b: the file survives a local-only verdict" "missing: $ABS7"; fi

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "Case 8: a missing external command degrades to a NAMED local-only reason"
HL_STUB_MODE=ok
mkdir -p "${SCRATCH}/empty-bin"   # created BEFORE PATH is emptied — mkdir is on PATH too
PATH_SAVED="$PATH"
PATH="${SCRATCH}/empty-bin"       # neither humanlayer nor git
V8="$(handoff_sync_and_classify "$ABS1" 2>/dev/null)"
PATH="$PATH_SAVED"
case "$V8" in
  local-only:*) ok "Case 8: degrades to a named local-only verdict ('$V8'), never a crash or a false 'synced'" ;;
  *)            fail "Case 8: degrades to a named local-only verdict" "got: '$V8'" ;;
esac

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "Case 9: a verdict is NEVER the empty string (an unset verdict reads as 'no problem')"
for v in "$V5" "$V6" "$V7" "$V8"; do
  if [ -z "$v" ]; then
    fail "Case 9: every verdict is non-empty" "one verdict was empty"
    break
  fi
done
[ -n "$V5" ] && [ -n "$V6" ] && [ -n "$V7" ] && [ -n "$V8" ] && \
  ok "Case 9: every verdict is a non-empty string"

echo ""
echo "──────────────────────────────────────────"
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
