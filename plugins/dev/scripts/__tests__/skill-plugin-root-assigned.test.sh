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

echo ""
echo "─────────────────────────────────────────"
echo "  Passed: $PASSES   Failed: $FAILURES"
[ "$FAILURES" -eq 0 ] || exit 1
