#!/usr/bin/env bash
# CTL-1832: skill-invariant test. A SKILL.md that EXPANDS ${PLUGIN_ROOT} in live
# shell must also ASSIGN it, or the expansion is empty and every command built
# from it silently addresses the wrong path.
#
# This has now happened twice, in opposite directions:
#   - phase-monitor-deploy (CTL-1410, pre-existing since CTL-550): fatal, because
#     that body runs under `set -u` — the unbound expansion killed the success
#     path outright.
#   - phase-triage (CTL-1832): SILENT, because the call was wrapped in
#     `2>/dev/null || echo '{}'` — so a broken escalation shim produced an empty
#     explanation and exited 0, and the operator inbox rendered a bare
#     `needs-human` label instead of a specific answerable question.
#
# The silent direction is the one worth a permanent guard: it cannot be noticed
# by running the pipeline, only by reading the file.
#
# NOTE ON THE INSTRUMENT: mentions of ${PLUGIN_ROOT} inside a COMMENT are not
# uses. phase-monitor-deploy still names the variable in its explanatory comment
# describing the CTL-1410 fix; counting that would report a defect that is
# already fixed. Comment lines are therefore stripped before matching.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

FAILURES=0
PASSES=0
pass() { PASSES=$((PASSES + 1)); echo "  PASS: $1"; }
fail() { FAILURES=$((FAILURES + 1)); echo "  FAIL: $1"; [ $# -ge 2 ] && echo "    $2"; }

# live_plugin_root_uses <file> — count ${PLUGIN_ROOT} expansions that are NOT on
# a comment line. Deliberately does not try to parse fenced blocks: a bare
# mention outside a code fence is still prose that an agent may copy verbatim.
live_plugin_root_uses() {
	grep -v '^[[:space:]]*#' "$1" 2>/dev/null | grep -c '\${PLUGIN_ROOT}' || true
}

assigns_plugin_root() {
	grep -cE '^[[:space:]]*(export[[:space:]]+)?PLUGIN_ROOT=' "$1" 2>/dev/null || true
}

echo "Test: every SKILL.md that expands \${PLUGIN_ROOT} also assigns it"
OFFENDERS=""
CHECKED=0
while IFS= read -r f; do
	CHECKED=$((CHECKED + 1))
	uses=$(live_plugin_root_uses "$f")
	[ "$uses" -gt 0 ] || continue
	assigns=$(assigns_plugin_root "$f")
	if [ "$assigns" -eq 0 ]; then
		OFFENDERS="${OFFENDERS}
    ${f#"$REPO_ROOT"/} (${uses} live use(s), 0 assignments)"
	fi
done < <(find "$REPO_ROOT/plugins" -name 'SKILL.md' -type f 2>/dev/null)

if [ -z "$OFFENDERS" ]; then
	pass "no SKILL.md expands an unassigned \${PLUGIN_ROOT} (${CHECKED} files scanned)"
else
	fail "SKILL.md files expand \${PLUGIN_ROOT} without assigning it" "$OFFENDERS"
fi

# ── CTL-1832 / CTL-1998: THE SAME QUESTION, ASKED OF THE WHOLE SKILL ─────────
# The scan above reads SKILL.md ALONE, and that is correct for what it asks: a
# reader of SKILL.md may never open references/, so an expansion THERE whose
# assignment lives elsewhere is a live hazard. But it means every ${PLUGIN_ROOT}
# use that progressive disclosure moved INTO references/ is invisible to this
# file — today _phase-agent-template/references/end-block.md has 1 and
# escalation-explanation.md has 3, all correct only because prelude.md assigns it
# in the same shell. Nothing checks that.
#
# So a second, independent question: taking a skill as SKILL.md PLUS its
# references/, if it expands ${PLUGIN_ROOT} anywhere, does it assign it anywhere?
# Delete prelude.md's assignment (or move the end block to a skill without one)
# and every phase agent silently addresses /scripts/... — with the scan above
# reporting clean, because no SKILL.md was involved.
#
# ⚠️ This does NOT replace the check above, and collapsing the two would
# reintroduce the exact bug #3656 fixed: a use in SKILL.md with its assignment in
# references/ satisfies THIS rule and must still fail THAT one. Both run.
#
# Raised by FLEET on #3656 (peer read, §4): ten more phase skills are queued for
# the same conversion, so the guard built for this class was aimed at the wrong
# files for all ten.
echo "Test: every SKILL (SKILL.md + references/) that expands \${PLUGIN_ROOT} assigns it somewhere"
SKILL_OFFENDERS=""
SKILLS_CHECKED=0
SKILLS_WITH_USES=0
while IFS= read -r skillmd; do
	skill_dir="$(dirname "$skillmd")"
	SKILLS_CHECKED=$((SKILLS_CHECKED + 1))
	uses=0
	assigns=0
	# SKILL.md plus every reference, counted with the SAME two helpers the scan
	# above uses — so the two questions can never drift on what a "use" is.
	for f in "$skillmd" "$skill_dir"/references/*.md; do
		[ -f "$f" ] || continue
		uses=$((uses + $(live_plugin_root_uses "$f")))
		assigns=$((assigns + $(assigns_plugin_root "$f")))
	done
	[ "$uses" -gt 0 ] || continue
	SKILLS_WITH_USES=$((SKILLS_WITH_USES + 1))
	if [ "$assigns" -eq 0 ]; then
		SKILL_OFFENDERS="${SKILL_OFFENDERS}
    ${skill_dir#"$REPO_ROOT"/} (${uses} live use(s) across the skill, 0 assignments)"
	fi
done < <(find "$REPO_ROOT/plugins" -name 'SKILL.md' -type f 2>/dev/null)

# A clean result here is only evidence if the scan actually looked at skills that
# USE the variable. Zero such skills would make the pass vacuous, so assert the
# denominator rather than just the verdict.
if [ "$SKILLS_WITH_USES" -eq 0 ]; then
	fail "whole-skill scan found NO skill using \${PLUGIN_ROOT} — the scan is vacuous" \
		"checked ${SKILLS_CHECKED} skills; expected at least the phase skills"
elif [ -z "$SKILL_OFFENDERS" ]; then
	pass "no skill expands \${PLUGIN_ROOT} without assigning it somewhere (${SKILLS_WITH_USES} of ${SKILLS_CHECKED} skills use it)"
else
	fail "skills expand \${PLUGIN_ROOT} (in SKILL.md or references/) without assigning it anywhere" "$SKILL_OFFENDERS"
fi

# ── POSITIVE CONTROL ─────────────────────────────────────────────────────────
# The check above reports a clean result. A clean result is only evidence if the
# same instrument returns a DIRTY result on a case known to be defective. Build
# that case and assert the detector fires on it. If this control ever passes
# silently, the scan above is vacuous and its "no offenders" means nothing.
echo "Test: the detector actually fires on a known-defective file (positive control)"
CTRL_DIR="$(mktemp -d)"
trap 'rm -rf "$CTRL_DIR"' EXIT

cat >"$CTRL_DIR/SKILL.md" <<'FIXTURE'
# A skill that never assigns PLUGIN_ROOT
```bash
EXPL_JSON="$(node "${PLUGIN_ROOT}/scripts/execution-core/escalation-explain.mjs" --ticket "$T")"
```
FIXTURE

ctrl_uses=$(live_plugin_root_uses "$CTRL_DIR/SKILL.md")
ctrl_assigns=$(assigns_plugin_root "$CTRL_DIR/SKILL.md")
if [ "$ctrl_uses" -gt 0 ] && [ "$ctrl_assigns" -eq 0 ]; then
	pass "detector reports the defective fixture as an offender (uses=${ctrl_uses}, assigns=${ctrl_assigns})"
else
	fail "detector did NOT flag the defective fixture — the scan above is vacuous" \
		"uses=${ctrl_uses} assigns=${ctrl_assigns} (expected uses>0, assigns=0)"
fi

# Second control, the other direction: a file that DOES assign must not be
# flagged, so the check is not simply reporting every file as an offender.
cat >"$CTRL_DIR/OK.md" <<'FIXTURE'
```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/../../.." && pwd)}"
echo "${PLUGIN_ROOT}/scripts/thing"
```
FIXTURE

ok_uses=$(live_plugin_root_uses "$CTRL_DIR/OK.md")
ok_assigns=$(assigns_plugin_root "$CTRL_DIR/OK.md")
if [ "$ok_uses" -gt 0 ] && [ "$ok_assigns" -gt 0 ]; then
	pass "detector does not flag a file that assigns \${PLUGIN_ROOT} (uses=${ok_uses}, assigns=${ok_assigns})"
else
	fail "detector mis-reads a correct file" "uses=${ok_uses} assigns=${ok_assigns}"
fi

# ── The specific regression this ticket fixed ────────────────────────────────
echo "Test: phase-triage's escalation shim resolves from CLAUDE_PLUGIN_ROOT"
TRIAGE="$REPO_ROOT/plugins/dev/skills/phase-triage/SKILL.md"
if grep -q 'CLAUDE_PLUGIN_ROOT}/scripts/execution-core/escalation-explain.mjs' "$TRIAGE"; then
	pass "phase-triage escalation-explain uses CLAUDE_PLUGIN_ROOT"
else
	fail "phase-triage escalation-explain does not resolve from CLAUDE_PLUGIN_ROOT"
fi

echo "Test: a failed escalation shim leaves a breadcrumb instead of silently emitting {}"
if grep -q 'escalation-explain unavailable' "$TRIAGE"; then
	pass "phase-triage warns on shim failure"
else
	fail "phase-triage still degrades to {} with no operator-visible signal"
fi

echo ""
echo "─────────────────────────────────────────"
echo "  Passed: $PASSES   Failed: $FAILURES"
[ "$FAILURES" -eq 0 ] || exit 1
