#!/bin/bash
# install-project.sh - Install agents and commands to specific project
# Usage: ./install-project.sh [project_path]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_DIR="$(dirname "${SCRIPT_DIR}")"
PROJECT_DIR="${1:-.}"

# Source frontmatter utilities
source "${SCRIPT_DIR}/frontmatter-utils.sh"

# Resolve to absolute path
PROJECT_DIR="$(cd "${PROJECT_DIR}" && pwd)"

# Check if we're installing into the workspace itself
is_workspace_install() {
	[[ ${PROJECT_DIR} -ef ${WORKSPACE_DIR} ]]
}

echo "🚀 Installing Ryan's Claude Workspace to project"
echo ""
echo "Source: ${WORKSPACE_DIR}"
echo "Target: ${PROJECT_DIR}/.claude"
echo ""

# Create project .claude directories
mkdir -p "${PROJECT_DIR}/.claude/agents"
mkdir -p "${PROJECT_DIR}/.claude/commands"

# Install agents
echo "📋 Installing agents..."
AGENT_COUNT=0
for agent in "${WORKSPACE_DIR}/agents"/*.md; do
	if [[ -f ${agent} ]]; then
		filename=$(basename "${agent}")
		# Skip README.md - it's documentation, not an agent
		if [[ ${filename} == "README.md" ]]; then
			continue
		fi
		cp "${agent}" "${PROJECT_DIR}/.claude/agents/"
		AGENT_COUNT=$((AGENT_COUNT + 1))
		echo "  ✓ ${filename}"
	fi
done

# Install commands (from namespace directories)
echo ""
echo "📋 Installing commands..."
COMMAND_COUNT=0
SKIPPED_COUNT=0

# First, clean up any duplicate commands in the root
if [[ -d "${PROJECT_DIR}/.claude/commands" ]]; then
	find "${PROJECT_DIR}/.claude/commands" -maxdepth 1 -name "*.md" ! -name "README.md" -type f -delete
fi

# Create namespace directories
for namespace_dir in "${WORKSPACE_DIR}/commands"/*/; do
	if [[ -d ${namespace_dir} ]]; then
		namespace=$(basename "${namespace_dir}")
		mkdir -p "${PROJECT_DIR}/.claude/commands/${namespace}"

		# Copy commands from this namespace
		for command in "${namespace_dir}"*.md; do
			if [[ -f ${command} ]]; then
				filename=$(basename "${command}")

				# Skip README.md - it's documentation
				if [[ ${filename} == "README.md" ]]; then
					continue
				fi

				# Skip workspace-only commands unless installing to workspace itself
				# shellcheck disable=SC2310 # Intentionally using functions in conditions
				if ! is_workspace_install && should_skip_on_install "${command}"; then
					echo "  ○ Skipped ${namespace}/${filename} (workspace-only)"
					SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
					continue
				fi

				cp "${command}" "${PROJECT_DIR}/.claude/commands/${namespace}/"
				COMMAND_COUNT=$((COMMAND_COUNT + 1))
				echo "  ✓ ${namespace}/${filename}"
			fi
		done
	fi
done

if [[ ${SKIPPED_COUNT} -gt 0 ]]; then
	echo "  (Skipped ${SKIPPED_COUNT} workspace-only commands)"
fi

# Install config.json if it exists
echo ""
if [[ -f "${WORKSPACE_DIR}/.claude/config.json" ]]; then
	echo "📋 Installing config.json..."
	cp "${WORKSPACE_DIR}/.claude/config.json" "${PROJECT_DIR}/.claude/"
	echo "  ✓ config.json (customize for your project)"
fi

# Create initial metadata file
echo ""
echo "📋 Creating workspace metadata..."
WORKSPACE_VERSION=$(cd "${WORKSPACE_DIR}" && git rev-parse HEAD 2>/dev/null || echo "unknown")
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

cat >"${PROJECT_DIR}/.claude/.workspace-metadata.json" <<EOF
{
  "workspaceVersion": "${WORKSPACE_VERSION}",
  "lastUpdated": "${TIMESTAMP}",
  "installedFiles": {}
}
EOF
echo "  ✓ .workspace-metadata.json"

# Append workspace artifact to CLAUDE.md
append_claude_artifact() {
	local project_dir="$1"
	local artifact_file="${WORKSPACE_DIR}/artifacts/CLAUDE.md.workspace"
	local target_file="${project_dir}/CLAUDE.md"

	# Check if artifact exists
	if [[ ! -f $artifact_file ]]; then
		echo "⚠️  Artifact not found: $artifact_file"
		return 1
	fi

	# If CLAUDE.md doesn't exist, create it
	if [[ ! -f $target_file ]]; then
		echo "📋 Creating CLAUDE.md..."
		cat >"$target_file" <<'EOF'
# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

<!-- Your project-specific instructions here -->

EOF
	fi

	# Check if artifact already appended
	if grep -q "<!-- BEGIN: Ryan Claude Workspace -->" "$target_file"; then
		echo "  ✓ Workspace artifact already in CLAUDE.md"
		return 0
	fi

	# Append artifact
	echo ""
	cat "$artifact_file" >>"$target_file"
	echo "  ✓ Appended workspace artifact to CLAUDE.md"
}

echo ""
echo "📋 Updating CLAUDE.md..."
append_claude_artifact "$PROJECT_DIR"

echo ""
echo "✅ Installation complete!"
echo ""
echo "Installed to: ${PROJECT_DIR}/.claude/"
echo "  - ${AGENT_COUNT} agents"
echo "  - ${COMMAND_COUNT} commands"
echo "  - config.json (template)"
echo "  - .workspace-metadata.json (tracking)"
echo ""
echo "These will ONLY be available in this project."
echo ""
echo "📝 Next steps:"
echo "1. Customize .claude/config.json with your project settings"
echo "2. Run /linear in Claude Code to configure Linear integration (if needed)"
echo "3. Restart Claude Code if working in this project"
echo ""
echo "📦 To update from workspace later:"
echo "   From workspace: ./hack/update-project.sh ${PROJECT_DIR}"
echo "   Or in Claude: /update-project ${PROJECT_DIR}"
echo ""
echo "Note: Project .claude/ takes precedence over user ~/.claude/"
echo "Workspace version: $(echo "$WORKSPACE_VERSION" | cut -c1-8)"
echo ""
