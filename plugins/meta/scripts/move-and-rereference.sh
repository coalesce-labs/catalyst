#!/usr/bin/env bash
# move-and-rereference.sh — Move files and update all references
#
# Usage:
#   move-and-rereference.sh [OPTIONS] MAPPING_FILE
#
# Options:
#   --dry-run      Show what would change without modifying anything (default)
#   --execute      Actually perform the moves and reference updates
#   --root DIR     Repository root (default: git rev-parse --show-toplevel)
#   --exclude PAT  Glob pattern to exclude from reference scanning (repeatable)
#   --verbose      Show each reference match as it's found
#   --help         Show this help message
#
# Mapping file format (TSV):
#   old/path/to/file.md	new/path/to/file.md
#   old/directory/	new/directory/
#
# Lines starting with # are comments. Empty lines are skipped.

set -euo pipefail

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

# Defaults
MODE="dry-run"
ROOT=""
VERBOSE=false
MAPPING_FILE=""
declare -a EXCLUDE_PATTERNS=()

# File extensions to scan for references
SCAN_EXTENSIONS="md,json,sh,yml,yaml,txt,toml,ts,js,tsx,jsx,css,html"

usage() {
	cat <<'EOF'
move-and-rereference.sh — Move files and update all references

Usage:
  move-and-rereference.sh [OPTIONS] MAPPING_FILE

Options:
  --dry-run      Show what would change without modifying anything (default)
  --execute      Actually perform the moves and reference updates
  --root DIR     Repository root (default: git rev-parse --show-toplevel)
  --exclude PAT  Glob pattern to exclude from reference scanning (repeatable)
  --verbose      Show each reference match as it's found
  --help         Show this help message

Mapping file format (TSV — tab-separated):
  old/path/to/file.md	new/path/to/file.md
  old/directory/	new/directory/

Lines starting with # are comments. Empty lines are skipped.

Examples:
  # Dry run (default) — see what would change
  move-and-rereference.sh mapping.tsv

  # Execute the moves and reference updates
  move-and-rereference.sh --execute mapping.tsv

  # Custom root and exclude patterns
  move-and-rereference.sh --root /path/to/repo --exclude '*.log' mapping.tsv
EOF
}

# Parse arguments
while [[ $# -gt 0 ]]; do
	case "$1" in
	--dry-run)
		MODE="dry-run"
		shift
		;;
	--execute)
		MODE="execute"
		shift
		;;
	--root)
		ROOT="$2"
		shift 2
		;;
	--exclude)
		EXCLUDE_PATTERNS+=("$2")
		shift 2
		;;
	--verbose)
		VERBOSE=true
		shift
		;;
	--help | -h)
		usage
		exit 0
		;;
	-*)
		echo -e "${RED}Unknown option: $1${NC}" >&2
		usage >&2
		exit 1
		;;
	*)
		if [[ -z "$MAPPING_FILE" ]]; then
			MAPPING_FILE="$1"
		else
			echo -e "${RED}Unexpected argument: $1${NC}" >&2
			usage >&2
			exit 1
		fi
		shift
		;;
	esac
done

# Validate mapping file
if [[ -z "$MAPPING_FILE" ]]; then
	echo -e "${RED}Error: No mapping file specified${NC}" >&2
	usage >&2
	exit 1
fi

if [[ ! -f "$MAPPING_FILE" ]]; then
	echo -e "${RED}Error: Mapping file not found: $MAPPING_FILE${NC}" >&2
	exit 1
fi

# Resolve mapping file to absolute path before cd
MAPPING_FILE="$(cd "$(dirname "$MAPPING_FILE")" && pwd)/$(basename "$MAPPING_FILE")"

# Determine repo root
if [[ -z "$ROOT" ]]; then
	ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
	if [[ -z "$ROOT" ]]; then
		echo -e "${RED}Error: Not in a git repository and no --root specified${NC}" >&2
		exit 1
	fi
fi

cd "$ROOT"

# ── Parse mapping file ──────────────────────────────────────────────────────

declare -a OLD_PATHS=()
declare -a NEW_PATHS=()

while IFS= read -r line || [[ -n "$line" ]]; do
	# Strip carriage returns (Windows line endings)
	line="${line//$'\r'/}"
	# Skip empty lines and comments
	[[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
	# Split on tab
	old_path="$(echo "$line" | cut -f1)"
	new_path="$(echo "$line" | cut -f2)"
	# Trim whitespace
	old_path="$(echo "$old_path" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
	new_path="$(echo "$new_path" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"

	if [[ -z "$old_path" || -z "$new_path" ]]; then
		echo -e "${YELLOW}Warning: Skipping malformed line: $line${NC}" >&2
		continue
	fi

	OLD_PATHS+=("$old_path")
	NEW_PATHS+=("$new_path")
done <"$MAPPING_FILE"

if [[ ${#OLD_PATHS[@]} -eq 0 ]]; then
	echo -e "${YELLOW}No mappings found in $MAPPING_FILE. Nothing to do.${NC}"
	exit 0
fi

echo -e "${BOLD}move-and-rereference.sh${NC}"
echo -e "Mode: ${BOLD}${MODE}${NC}"
echo -e "Root: ${ROOT}"
echo -e "Mappings: ${#OLD_PATHS[@]}"
echo ""

# ── Expand directory mappings into individual file mappings ──────────────────

declare -a EXPANDED_OLD=()
declare -a EXPANDED_NEW=()

for i in "${!OLD_PATHS[@]}"; do
	old="${OLD_PATHS[$i]}"
	new="${NEW_PATHS[$i]}"

	if [[ -d "$old" ]]; then
		# Directory mapping — enumerate all files within
		while IFS= read -r -d '' file; do
			rel="${file#"$old"}"
			# Strip leading slash if old didn't end with /
			rel="${rel#/}"
			new_file="${new%/}/${rel}"
			EXPANDED_OLD+=("$file")
			EXPANDED_NEW+=("$new_file")
		done < <(find "$old" -type f -not -path '*/.git/*' -print0)
	elif [[ -f "$old" ]]; then
		EXPANDED_OLD+=("$old")
		EXPANDED_NEW+=("$new")
	else
		echo -e "${RED}Error: Source path does not exist: $old${NC}" >&2
		exit 1
	fi
done

if [[ ${#EXPANDED_OLD[@]} -eq 0 ]]; then
	echo -e "${YELLOW}No files to move after expansion. Nothing to do.${NC}"
	exit 0
fi

# ── Check for conflicts ─────────────────────────────────────────────────────

errors=0
for i in "${!EXPANDED_NEW[@]}"; do
	new="${EXPANDED_NEW[$i]}"
	old="${EXPANDED_OLD[$i]}"
	if [[ -e "$new" && "$new" != "$old" ]]; then
		echo -e "${RED}Error: Target already exists: $new${NC}" >&2
		errors=$((errors + 1))
	fi
done

if [[ $errors -gt 0 ]]; then
	echo -e "${RED}$errors conflict(s) found. Aborting.${NC}" >&2
	exit 1
fi

# ── Sort mappings by path length (longest first) ────────────────────────────
# This prevents partial matches (e.g., matching "a/b" before "a/b/c/d")

declare -a SORT_INDICES=()
for i in "${!EXPANDED_OLD[@]}"; do
	echo "${#EXPANDED_OLD[$i]} $i"
done | sort -rn | while read -r _ idx; do
	echo "$idx"
done > /tmp/mar-sort-indices-$$

mapfile -t SORT_INDICES </tmp/mar-sort-indices-$$
rm -f /tmp/mar-sort-indices-$$

declare -a SORTED_OLD=()
declare -a SORTED_NEW=()
for idx in "${SORT_INDICES[@]}"; do
	SORTED_OLD+=("${EXPANDED_OLD[$idx]}")
	SORTED_NEW+=("${EXPANDED_NEW[$idx]}")
done

# ── Report planned moves ────────────────────────────────────────────────────

echo -e "${BOLD}── File Moves ──${NC}"
echo ""

for i in "${!SORTED_OLD[@]}"; do
	echo -e "  ${SORTED_OLD[$i]}"
	echo -e "    → ${GREEN}${SORTED_NEW[$i]}${NC}"
done
echo ""

# ── Execute moves (if --execute) ────────────────────────────────────────────

files_moved=0

if [[ "$MODE" == "execute" ]]; then
	echo -e "${BOLD}Moving files...${NC}"
	for i in "${!SORTED_OLD[@]}"; do
		old="${SORTED_OLD[$i]}"
		new="${SORTED_NEW[$i]}"

		# Create target directory
		mkdir -p "$(dirname "$new")"

		# Use git mv for tracked files, plain mv for untracked
		if git ls-files --error-unmatch "$old" &>/dev/null; then
			git mv "$old" "$new"
		else
			mv "$old" "$new"
		fi
		files_moved=$((files_moved + 1))
	done
	echo -e "${GREEN}  Moved $files_moved file(s)${NC}"
	echo ""
fi

# ── Build include pattern for grep ──────────────────────────────────────────

build_include_args() {
	local IFS=','
	local exts
	read -ra exts <<<"$SCAN_EXTENSIONS"
	for ext in "${exts[@]}"; do
		echo "--include=*.${ext}"
	done
}

build_exclude_args() {
	echo "--exclude-dir=.git"
	for pat in "${EXCLUDE_PATTERNS[@]}"; do
		echo "--exclude=$pat"
	done
}

# ── Scan and replace references ─────────────────────────────────────────────

echo -e "${BOLD}── Reference Updates ──${NC}"
echo ""

total_refs=0
total_files_updated=0
declare -A FILES_WITH_REFS=()

for i in "${!SORTED_OLD[@]}"; do
	old="${SORTED_OLD[$i]}"
	new="${SORTED_NEW[$i]}"

	# Escape old path for use in grep/sed (escape regex special chars)
	escaped_old=$(printf '%s' "$old" | sed 's/[.[\*^$()+?{}|\\]/\\&/g')
	# Escape for sed replacement (only & and \ and delimiter)
	escaped_new=$(printf '%s' "$new" | sed 's/[&\\/]/\\&/g')
	escaped_old_sed=$(printf '%s' "$old" | sed 's/[&\\/.*^$[\]]/\\&/g')

	# Find all files containing the old path
	mapfile -t matching_files < <(
		grep -rl $(build_include_args) $(build_exclude_args) \
			--fixed-strings "$old" . 2>/dev/null || true
	)

	for file in "${matching_files[@]}"; do
		# Skip the mapping file itself
		[[ "$(cd "$(dirname "$file")" && pwd)/$(basename "$file")" == "$MAPPING_FILE" ]] && continue

		# Count occurrences in this file
		count=$(grep -c --fixed-strings "$old" "$file" 2>/dev/null || echo 0)
		if [[ "$count" -gt 0 ]]; then
			# Get line numbers for report
			if [[ "$VERBOSE" == true ]]; then
				while IFS=: read -r lineno content; do
					echo -e "  ${BLUE}${file}:${lineno}${NC}  $old → $new"
				done < <(grep -n --fixed-strings "$old" "$file" 2>/dev/null || true)
			fi

			# Track file for summary
			if [[ -z "${FILES_WITH_REFS[$file]+x}" ]]; then
				FILES_WITH_REFS[$file]=0
				total_files_updated=$((total_files_updated + 1))
			fi
			FILES_WITH_REFS[$file]=$(( ${FILES_WITH_REFS[$file]} + count ))
			total_refs=$((total_refs + count))

			# Perform replacement if executing
			if [[ "$MODE" == "execute" ]]; then
				# Use temp file pattern for safe in-place edit
				sed "s|${escaped_old_sed}|${escaped_new}|g" "$file" >"${file}.mar-tmp"
				mv "${file}.mar-tmp" "$file"
			fi
		fi
	done
done

# ── Summary ─────────────────────────────────────────────────────────────────

if [[ $total_refs -eq 0 ]]; then
	echo -e "  ${YELLOW}No references found to update${NC}"
else
	if [[ "$VERBOSE" != true ]]; then
		# Show per-file summary
		for file in "${!FILES_WITH_REFS[@]}"; do
			count="${FILES_WITH_REFS[$file]}"
			echo -e "  ${BLUE}${file}${NC}: ${count} reference(s)"
		done
	fi
fi

echo ""
echo -e "${BOLD}── Summary ──${NC}"
echo ""

if [[ "$MODE" == "execute" ]]; then
	echo -e "  ${GREEN}Files moved${NC}: $files_moved"
	echo -e "  ${GREEN}References updated${NC}: $total_refs across $total_files_updated file(s)"
	echo ""
	echo -e "${GREEN}✅ Done!${NC}"
else
	echo -e "  Files to move: ${#SORTED_OLD[@]}"
	echo -e "  References to update: $total_refs across $total_files_updated file(s)"
	echo ""
	echo -e "${YELLOW}This was a dry run. Re-run with --execute to apply changes.${NC}"
fi
