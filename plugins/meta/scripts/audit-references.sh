#!/usr/bin/env bash
# audit-references.sh — Audit plugin health: find broken references in manifests,
# commands, agents, and documentation.
#
# Usage:
#   audit-references.sh [--root DIR] [--json] [--all] [--ci]
#
# Options:
#   --root DIR   Repository root (default: git rev-parse --show-toplevel)
#   --json       Output as JSON (for piping into AI commands)
#   --all        Include informational items (templates, examples)
#   --ci         CI mode: JSON output, exit 1 if any CRITICAL issues found
#   --help       Show this help message
#
# What it checks (in priority order):
#   1. CRITICAL — Plugin manifests: do all declared commands/agents/skills/scripts exist?
#   2. WARNING  — Plugin source files: do path references in commands/agents resolve?
#   3. INFO     — Documentation: stale path references in docs/READMEs (with --all)

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

ROOT=""
JSON_OUTPUT=false
SHOW_ALL=false
CI_MODE=false

usage() {
	cat <<'EOF'
audit-references.sh — Audit plugin health and find broken references

Usage:
  audit-references.sh [--root DIR] [--json] [--all]

Options:
  --root DIR   Repository root (default: git rev-parse --show-toplevel)
  --json       Output as JSON (for piping into AI commands)
  --all        Include informational items (templates, doc examples)
  --ci         CI mode: JSON output, exit 1 if any CRITICAL issues found
  --help       Show this help message

Checks:
  1. CRITICAL — Plugin manifests (.claude-plugin/plugin.json, plugin.json)
     Verifies all declared commands, agents, skills, and scripts exist on disk.

  2. WARNING — Plugin source files (commands/*.md, agents/*.md)
     Finds path references that don't resolve (excluding ${CLAUDE_PLUGIN_ROOT}).

  3. INFO — Documentation (docs/, READMEs, CLAUDE.md)
     Stale references in prose. Only shown with --all.

Template paths (YYYY, XXXX, PROJ) are always excluded.
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
	--root) ROOT="$2"; shift 2 ;;
	--json) JSON_OUTPUT=true; shift ;;
	--all) SHOW_ALL=true; shift ;;
	--ci) CI_MODE=true; JSON_OUTPUT=true; shift ;;
	--help | -h) usage; exit 0 ;;
	*) echo -e "${RED}Unknown option: $1${NC}" >&2; usage >&2; exit 1 ;;
	esac
done

if [[ -z "$ROOT" ]]; then
	ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
	if [[ -z "$ROOT" ]]; then
		echo -e "${RED}Error: Not in a git repository and no --root specified${NC}" >&2
		exit 1
	fi
fi

cd "$ROOT"

# Results go into temp files (one line per issue) to avoid subshell array problems
CRITICAL_FILE=$(mktemp)
WARNING_FILE=$(mktemp)
INFO_FILE=$(mktemp)
trap 'rm -f "$CRITICAL_FILE" "$WARNING_FILE" "$INFO_FILE"' EXIT

# ── 1. Audit plugin manifests ───────────────────────────────────────────────

audit_manifest() {
	local manifest="$1"
	local plugin_dir
	plugin_dir="$(dirname "$manifest")"

	# Handle .claude-plugin/plugin.json — plugin_dir should be parent
	if [[ "$(basename "$plugin_dir")" == ".claude-plugin" ]]; then
		plugin_dir="$(dirname "$plugin_dir")"
	fi

	if ! command -v jq &>/dev/null; then
		echo "${manifest}|0|jq not installed|Cannot parse JSON manifests without jq" >> "$CRITICAL_FILE"
		return
	fi

	if ! jq empty "$manifest" 2>/dev/null; then
		echo "${manifest}|0|invalid JSON|Manifest is not valid JSON" >> "$CRITICAL_FILE"
		return
	fi

	# Check for explicit "skills" array — this breaks Claude Code auto-discovery
	if jq -e '.skills' "$manifest" &>/dev/null; then
		local line
		line=$(grep -nF '"skills"' "$manifest" 2>/dev/null | head -1 | cut -d: -f1)
		echo "${manifest}|${line:-0}|skills|Explicit skills array breaks autocomplete — remove it and let Claude Code auto-discover skills/**/SKILL.md" >> "$CRITICAL_FILE"
	fi

	# Helper: extract file paths from a JSON array that may contain strings or objects with .file
	local extract_files='if type == "string" then . elif type == "object" then .file // empty else empty end'

	# Check all entry types: commands, agents, skills, scripts, sub-agents, templates
	local entry_type
	for entry_type in commands agents skills scripts sub-agents templates; do
		local label="${entry_type%s} file missing"  # e.g., "command file missing"
		while IFS= read -r ref; do
			[[ -z "$ref" || "$ref" == "null" ]] && continue
			local resolved="${plugin_dir}/${ref#./}"
			# Allow directories (e.g., templates/context-library-scaffold/)
			if [[ ! -e "$resolved" ]]; then
				local line
				line=$(grep -nF "$ref" "$manifest" 2>/dev/null | head -1 | cut -d: -f1)
				echo "${manifest}|${line:-0}|${ref}|${label}" >> "$CRITICAL_FILE"
			fi
		done < <(jq -r "(.\"${entry_type}\"[]? | ${extract_files}) // empty" "$manifest" 2>/dev/null)
	done
}

while IFS= read -r manifest; do
	audit_manifest "$manifest"
done < <(find plugins/ -name 'plugin.json' -type f 2>/dev/null | sort)

# ── 2. Audit plugin source files ───────────────────────────────────────────

PATTERN='(plugins|scripts|docs|agents|commands)/[A-Za-z0-9_./-]+\.[a-zA-Z]{1,5}'

audit_source_files() {
	local search_path="$1"
	local output_file="$2"

	[[ -e "$search_path" ]] || return 0

	local tmp_matches
	tmp_matches=$(mktemp)

	grep -rnoE --include='*.md' --include='*.sh' \
		"$PATTERN" "$search_path" 2>/dev/null > "$tmp_matches" || true

	declare -A seen=()

	while IFS= read -r match; do
		[[ -z "$match" ]] && continue

		local src_file="${match%%:*}"
		local rest="${match#*:}"
		local line_num="${rest%%:*}"
		local ref_path="${rest#*:}"

		# Clean trailing punctuation
		ref_path="${ref_path%%[)\"\'\`,;:\`]*}"
		[[ ${#ref_path} -lt 5 ]] && continue
		# Skip globs
		[[ "$ref_path" == *'*'* ]] && continue
		# Skip template/example paths
		[[ "$ref_path" == *"YYYY"* || "$ref_path" == *"XXXX"* || "$ref_path" == *"XXX"* ]] && continue
		# Skip example names
		[[ "$ref_path" == *"my-new-agent"* || "$ref_path" == *"test-agent"* || "$ref_path" == *"test_command"* || "$ref_path" == *"custom-agent"* || "$ref_path" == *"myproject"* ]] && continue

		# Skip paths referencing ${CLAUDE_PLUGIN_ROOT} — these resolve at runtime
		local src_line
		src_line=$(sed -n "${line_num}p" "$src_file" 2>/dev/null || true)
		[[ "$src_line" == *'CLAUDE_PLUGIN_ROOT'* ]] && continue
		# Also skip lines referencing claude plugin cache paths (already resolved)
		[[ "$src_line" == *'.claude/plugins/cache'* ]] && continue

		# Dedup
		local dedup_key="${src_file}|${ref_path}"
		[[ -n "${seen[$dedup_key]+x}" ]] && continue
		seen[$dedup_key]=1

		# Strip :line_number suffixes
		local clean_path="${ref_path%%:*}"

		if [[ ! -e "$clean_path" ]]; then
			echo "${src_file}|${line_num}|${ref_path}|Path does not exist" >> "$output_file"
		fi
	done < "$tmp_matches"

	rm -f "$tmp_matches"
}

# Plugin source files — WARNING level
for plugin_dir in plugins/*/; do
	[[ -d "$plugin_dir" ]] || continue
	for subdir in commands agents scripts hooks skills sub-agents; do
		[[ -d "${plugin_dir}${subdir}" ]] && audit_source_files "${plugin_dir}${subdir}" "$WARNING_FILE"
	done
done

# Documentation — INFO level (only with --all)
if [[ "$SHOW_ALL" == true ]]; then
	for doc_source in docs/ scripts/ CLAUDE.md README.md; do
		[[ -e "$doc_source" ]] && audit_source_files "$doc_source" "$INFO_FILE"
	done
	for readme in plugins/*/README.md plugins/*/HOOKS.md plugins/*/WORKFLOW_CONTEXT.md plugins/*/templates/README.md; do
		[[ -f "$readme" ]] && audit_source_files "$readme" "$INFO_FILE"
	done
fi

# ── Count results ───────────────────────────────────────────────────────────

critical_count=$(wc -l < "$CRITICAL_FILE" | tr -d ' ')
warning_count=$(wc -l < "$WARNING_FILE" | tr -d ' ')
info_count=$(wc -l < "$INFO_FILE" | tr -d ' ')

# ── JSON Output ─────────────────────────────────────────────────────────────

if [[ "$JSON_OUTPUT" == true ]]; then
	echo "{"
	echo "  \"critical\": $critical_count,"
	echo "  \"warnings\": $warning_count,"
	echo "  \"info\": $info_count,"
	echo "  \"issues\": ["

	first=true
	for sev_pair in "critical:$CRITICAL_FILE" "warning:$WARNING_FILE" "info:$INFO_FILE"; do
		sev="${sev_pair%%:*}"
		file="${sev_pair#*:}"
		while IFS='|' read -r src line ref detail; do
			[[ -z "$src" ]] && continue
			[[ "$first" == true ]] && first=false || echo ","
			printf '    {"severity": "%s", "source": "%s", "line": %s, "reference": "%s", "detail": "%s"}' \
				"$sev" "$src" "$line" "$ref" "$detail"
		done < "$file"
	done

	echo ""
	echo "  ]"
	echo "}"

	# CI mode: exit 1 if any CRITICAL issues found
	if [[ "$CI_MODE" == true && "$critical_count" -gt 0 ]]; then
		exit 1
	fi
	exit 0
fi

# ── Human-readable output ──────────────────────────────────────────────────

echo -e "${BOLD}Plugin Reference Audit${NC}"
echo -e "Root: ${ROOT}"
echo ""

print_section() {
	local color="$1"
	local label="$2"
	local file="$3"
	local count
	count=$(wc -l < "$file" | tr -d ' ')

	[[ "$count" -eq 0 ]] && return

	echo -e "${color}${BOLD}── ${label} (${count}) ──${NC}"
	echo ""

	# Group by source file
	local current_src=""
	sort -t'|' -k1,1 "$file" | while IFS='|' read -r src line ref detail; do
		[[ -z "$src" ]] && continue
		if [[ "$src" != "$current_src" ]]; then
			[[ -n "$current_src" ]] && echo ""
			echo -e "${BLUE}${src}${NC}"
			current_src="$src"
		fi
		echo -e "  ${DIM}line ${line}${NC}: ${color}${ref}${NC} ${DIM}— ${detail}${NC}"
	done
	echo ""
}

print_section "$RED" "CRITICAL — Manifest entries missing on disk" "$CRITICAL_FILE"
print_section "$YELLOW" "WARNING — Broken path references in plugin source" "$WARNING_FILE"

if [[ "$SHOW_ALL" == true ]]; then
	print_section "$DIM" "INFO — Documentation references (cosmetic)" "$INFO_FILE"
fi

# Summary
echo -e "${BOLD}── Summary ──${NC}"
echo ""

if [[ "$critical_count" -gt 0 ]]; then
	echo -e "  ${RED}CRITICAL${NC}: ${critical_count} manifest entries point to missing files"
fi
if [[ "$warning_count" -gt 0 ]]; then
	echo -e "  ${YELLOW}WARNING${NC}:  ${warning_count} broken path references in plugin source"
fi
if [[ "$info_count" -gt 0 ]]; then
	echo -e "  ${DIM}INFO${NC}:     ${info_count} stale documentation references"
	if [[ "$SHOW_ALL" != true ]]; then
		echo -e "           ${DIM}(use --all to see these)${NC}"
	fi
fi

total=$((critical_count + warning_count))
if [[ $total -eq 0 ]]; then
	echo -e "  ${GREEN}✅ No critical or warning issues found.${NC}"
else
	echo ""
	echo -e "  ${BOLD}Total actionable issues: $total${NC}"
	echo -e "  Run with ${BOLD}--json${NC} for machine-readable output."
fi
echo ""
