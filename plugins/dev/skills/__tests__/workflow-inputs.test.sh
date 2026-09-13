#!/usr/bin/env bash
# workflow-inputs.test.sh — CTL-2306 Phase 1: skills find their input explicitly.
#
# WHY: the five skills that auto-discover a prior document (create-plan,
# iterate-plan, validate-plan, implement-plan, resume-handoff) used to read
# `.catalyst/.workflow-context.json`, a file written by a Claude-only hook and
# carried between runs. Ryan's rule (2026-09-13): a skill must never depend on
# state persisted between runs — a phase container is disposable and a
# Codex/OpenCode session never ran the hook. The replacement is explicit input:
# the ticket from the argument or the relay contract ($CATALYST_TICKET), and the
# newest document for THAT ticket found on disk within the run.
#
# Two halves:
#   1. Shape: no skill names workflow-context any more.
#   2. Behaviour: each skill's discovery block (between the CTL-2306 markers) is
#      EXTRACTED and RUN against a scratch thoughts tree, under bash and zsh
#      (the agent's Bash tool runs zsh on macOS).
#
# Run: bash plugins/dev/skills/__tests__/workflow-inputs.test.sh
# Bash-3.2 safe.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

PASS=0
FAIL=0
ok()   { PASS=$((PASS+1)); printf '  PASS: %s\n' "$1"; }
fail() { FAIL=$((FAIL+1)); printf '  FAIL: %s\n    %s\n' "$1" "${2:-}"; }

BEGIN_MARK='# CTL-2306 explicit-input discovery: begin'
END_MARK='# CTL-2306 explicit-input discovery: end'

# skill|variable|thoughts kind
READERS="create-plan|RECENT_RESEARCH|research
iterate-plan|RECENT_PLAN|plans
validate-plan|RECENT_PLAN|plans
implement-plan|RECENT_PLAN|plans
resume-handoff|RECENT_HANDOFF|handoffs"

for skill in create-plan iterate-plan validate-plan implement-plan resume-handoff create-handoff create-pr; do
  [ -f "${SKILLS_DIR}/${skill}/SKILL.md" ] || { echo "FATAL: subject not found: ${skill}/SKILL.md" >&2; exit 1; }
done

echo "explicit workflow inputs (CTL-2306)"

# ── 1. Shape ─────────────────────────────────────────────────────────────────
echo ""
echo "No skill reads or writes workflow context"
# Positive control: the same recursive grep finds a token known to be present.
if grep -rqF 'name: create-plan' "$SKILLS_DIR"; then
  ok "control: recursive grep over the skills tree finds a known-present token"
else
  fail "control: recursive grep over the skills tree finds a known-present token" "the instrument cannot see the tree"
fi
hits="$(grep -rlF 'workflow-context' "$SKILLS_DIR" --include='*.md' 2>/dev/null | sed "s|^${SKILLS_DIR}/||" | sort)"
if [ -z "$hits" ]; then
  ok "no SKILL.md or reference under plugins/dev/skills names workflow-context"
else
  fail "no SKILL.md or reference under plugins/dev/skills names workflow-context" "still named in: $(printf '%s' "$hits" | tr '\n' ' ')"
fi

# ── 2. Behaviour ─────────────────────────────────────────────────────────────
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

# extract_block <skill> → the discovery block's lines, or nothing.
extract_block() {
  awk -v b="$BEGIN_MARK" -v e="$END_MARK" '
    index($0, b) { on = 1; next }
    index($0, e) { on = 0; next }
    on { print }
  ' "${SKILLS_DIR}/$1/SKILL.md"
}

# make_tree <root> <kind> — three docs with fixed, ordered mtimes:
#   ABC-1 old (oldest) < ABC-1 new < XYZ-9 (newest overall, a different ticket).
make_tree() {
  local root="$1" kind="$2" d="$1/thoughts/shared/$2"
  if [ "$kind" = handoffs ]; then
    mkdir -p "$d/ABC-1" "$d/XYZ-9"
    printf 'x\n' > "$d/ABC-1/2026-01-01_10-00-00_old.md"
    printf 'x\n' > "$d/ABC-1/2026-01-02_10-00-00_new.md"
    printf 'x\n' > "$d/XYZ-9/2026-01-03_10-00-00_other.md"
    touch -t 202601011000 "$d/ABC-1/2026-01-01_10-00-00_old.md"
    touch -t 202601021000 "$d/ABC-1/2026-01-02_10-00-00_new.md"
    touch -t 202601031000 "$d/XYZ-9/2026-01-03_10-00-00_other.md"
  else
    mkdir -p "$d"
    printf 'x\n' > "$d/2026-01-01-ABC-1-old.md"
    printf 'x\n' > "$d/2026-01-02-ABC-1-new.md"
    printf 'x\n' > "$d/2026-01-03-XYZ-9-other.md"
    touch -t 202601011000 "$d/2026-01-01-ABC-1-old.md"
    touch -t 202601021000 "$d/2026-01-02-ABC-1-new.md"
    touch -t 202601031000 "$d/2026-01-03-XYZ-9-other.md"
  fi
}

# run_block <shell> <dir> <block-file> <var> <env assignments...> → the variable's value
run_block() {
  local sh="$1" dir="$2" block="$3" var="$4"
  shift 4
  (cd "$dir" && env -u TICKET_ID -u CATALYST_TICKET -u CATALYST_PHASE "$@" "$sh" -c ". '$block' >/dev/null 2>&1; printf '%s' \"\$$var\"")
}

SHELLS="bash"
command -v zsh >/dev/null 2>&1 && SHELLS="bash zsh"

ITERATIONS=0
while IFS='|' read -r skill var kind; do
  ITERATIONS=$((ITERATIONS+1))
  echo ""
  echo "${skill}: discovers ${kind} for the ticket it was given"
  block_file="${SCRATCH}/${skill}.block.sh"
  extract_block "$skill" > "$block_file"
  if [ ! -s "$block_file" ]; then
    fail "${skill}: has a CTL-2306 explicit-input discovery block" "no lines between the markers in ${skill}/SKILL.md"
    continue
  fi
  ok "${skill}: has a CTL-2306 explicit-input discovery block"

  tree="${SCRATCH}/tree-${skill}"
  make_tree "$tree" "$kind"
  for sh in $SHELLS; do
    got="$(run_block "$sh" "$tree" "$block_file" "$var" CATALYST_PHASE=plan CATALYST_TICKET=ABC-1)"
    case "$got" in
      *ABC-1*new*) ok "${skill} [${sh}]: under a phase, \$CATALYST_TICKET selects that ticket's newest doc" ;;
      *) fail "${skill} [${sh}]: under a phase, \$CATALYST_TICKET selects that ticket's newest doc" "got '${got}'" ;;
    esac

    got="$(run_block "$sh" "$tree" "$block_file" "$var" TICKET_ID=ABC-1)"
    case "$got" in
      *ABC-1*new*) ok "${skill} [${sh}]: an explicit TICKET_ID selects that ticket's newest doc" ;;
      *) fail "${skill} [${sh}]: an explicit TICKET_ID selects that ticket's newest doc" "got '${got}'" ;;
    esac

    got="$(run_block "$sh" "$tree" "$block_file" "$var" CATALYST_PHASE=plan CATALYST_TICKET=NOPE-2)"
    if [ -z "$got" ]; then
      ok "${skill} [${sh}]: under a phase, no doc for the ticket means none — never another ticket's"
    else
      fail "${skill} [${sh}]: under a phase, no doc for the ticket means none — never another ticket's" "got '${got}'"
    fi

    got="$(run_block "$sh" "$tree" "$block_file" "$var")"
    case "$got" in
      *XYZ-9*other*) ok "${skill} [${sh}]: interactive with no ticket offers the newest doc on disk" ;;
      *) fail "${skill} [${sh}]: interactive with no ticket offers the newest doc on disk" "got '${got}'" ;;
    esac
  done
done <<READERS_EOF
$READERS
READERS_EOF
# `[].every()` is true: a loop that never ran must not print a green summary.
[ "$ITERATIONS" -eq 5 ] || fail "the reader loop covered all five skills" "ran ${ITERATIONS} iteration(s)"

echo ""
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
