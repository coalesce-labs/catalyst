#!/bin/bash
set -e

# update-project.sh - Intelligently update a project's .claude/ directory from workspace
# Handles local customizations, merges configs, and backs up before changes

WORKSPACE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_DIR="${1:-.}"
PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"

# Source frontmatter utilities
SCRIPT_DIR="$(dirname "$0")"
source "$SCRIPT_DIR/frontmatter-utils.sh"

CLAUDE_DIR="$PROJECT_DIR/.claude"
METADATA_FILE="$CLAUDE_DIR/.workspace-metadata.json"
BACKUP_DIR="$PROJECT_DIR/.claude-backup-$(date +%Y%m%d-%H%M%S)"

# Check if we're updating the workspace itself
is_workspace_update() {
    [[ "$PROJECT_DIR" -ef "$WORKSPACE_DIR" ]]
}

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Counters
UPDATED=0
ADDED=0
SKIPPED=0
CONFLICTS=0

echo -e "${BLUE}🔄 Workspace Update System${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Workspace: $WORKSPACE_DIR"
echo "Project:   $PROJECT_DIR"
echo ""

# Function to calculate file checksum
calculate_checksum() {
    local file="$1"
    if [[ -f "$file" ]]; then
        shasum -a 256 "$file" | cut -d' ' -f1
    else
        echo ""
    fi
}

# Function to check if file is configured (no [NEEDS_SETUP] markers)
is_configured() {
    local file="$1"
    if [[ -f "$file" ]]; then
        ! grep -q "\[NEEDS_SETUP\]" "$file"
    else
        false
    fi
}

# Function to get workspace version (git commit hash)
get_workspace_version() {
    cd "$WORKSPACE_DIR"
    git rev-parse HEAD 2>/dev/null || echo "unknown"
}

# Function to read metadata
read_metadata() {
    if [[ -f "$METADATA_FILE" ]]; then
        cat "$METADATA_FILE"
    else
        echo '{}'
    fi
}

# Function to update metadata
update_metadata() {
    local file_path="$1"
    local checksum="$2"
    local modified="$3"
    local customized="$4"

    # Create metadata structure if doesn't exist
    if [[ ! -f "$METADATA_FILE" ]]; then
        mkdir -p "$(dirname "$METADATA_FILE")"
        echo '{"workspaceVersion":"","lastUpdated":"","installedFiles":{}}' > "$METADATA_FILE"
    fi

    # Update using jq (if available) or manual JSON manipulation
    if command -v jq &> /dev/null; then
        local temp_file=$(mktemp)
        jq --arg path "$file_path" \
           --arg checksum "$checksum" \
           --argjson modified "$modified" \
           --argjson customized "$customized" \
           '.installedFiles[$path] = {
               "checksum": $checksum,
               "modified": $modified,
               "customized": $customized
           }' "$METADATA_FILE" > "$temp_file"
        mv "$temp_file" "$METADATA_FILE"
    fi
}

# Function to finalize metadata (set version and timestamp)
finalize_metadata() {
    local version="$(get_workspace_version)"
    local timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

    if command -v jq &> /dev/null; then
        local temp_file=$(mktemp)
        jq --arg version "$version" \
           --arg timestamp "$timestamp" \
           '.workspaceVersion = $version | .lastUpdated = $timestamp' \
           "$METADATA_FILE" > "$temp_file"
        mv "$temp_file" "$METADATA_FILE"
    fi
}

# Function to smart merge config.json
merge_config_json() {
    local workspace_config="$1"
    local project_config="$2"

    echo -e "${YELLOW}🔀 Smart merging config.json...${NC}"

    if [[ ! -f "$project_config" ]]; then
        # No local config, copy workspace version
        cp "$workspace_config" "$project_config"
        echo -e "${GREEN}   ✓ Created new config.json from workspace${NC}"
        return 0
    fi

    # Use jq to merge if available
    if command -v jq &> /dev/null; then
        local temp_file=$(mktemp)
        # Merge: workspace structure + local values
        # Local values take precedence, new fields from workspace are added
        jq -s '.[0] * .[1]' "$workspace_config" "$project_config" > "$temp_file"

        # Show what changed
        if ! diff -q "$project_config" "$temp_file" > /dev/null 2>&1; then
            echo -e "${YELLOW}   Config changes:${NC}"
            diff -u "$project_config" "$temp_file" | tail -n +3 | sed 's/^/   /' || true

            mv "$temp_file" "$project_config"
            echo -e "${GREEN}   ✓ Merged config.json (preserved local values, added new fields)${NC}"
        else
            rm "$temp_file"
            echo -e "${GREEN}   ✓ Config.json already up to date${NC}"
        fi
    else
        echo -e "${YELLOW}   ⚠️  jq not installed, skipping smart merge${NC}"
        echo -e "${YELLOW}   Please manually merge: $workspace_config -> $project_config${NC}"
    fi
}

# Function to handle file update
update_file() {
    local rel_path="$1"  # Relative path like "agents/codebase-locator.md"
    local workspace_file="$WORKSPACE_DIR/.claude/$rel_path"
    local project_file="$CLAUDE_DIR/$rel_path"

    # Skip workspace-only and install-once commands unless updating workspace itself
    if [[ "$rel_path" == commands/* ]] && ! is_workspace_update; then
        # Check frontmatter from source file, not .claude/ copy
        local source_file="$WORKSPACE_DIR/$rel_path"
        if should_skip_on_update "$source_file"; then
            local reason=""
            if [[ $(get_frontmatter_bool "$source_file" "workspace_only") == "true" ]]; then
                reason="workspace-only"
            elif [[ $(get_frontmatter_bool "$source_file" "install_once") == "true" ]]; then
                reason="install-once"
            fi
            echo -e "   ○ Skipped: $rel_path ($reason)"
            ((SKIPPED++))
            return 0
        fi
    fi

    # Get checksums
    local workspace_checksum=$(calculate_checksum "$workspace_file")
    local project_checksum=$(calculate_checksum "$project_file")

    # File doesn't exist in project - new file
    if [[ ! -f "$project_file" ]]; then
        mkdir -p "$(dirname "$project_file")"
        cp "$workspace_file" "$project_file"
        echo -e "${GREEN}   ✓ Added: $rel_path${NC}"
        update_metadata "$rel_path" "$workspace_checksum" false false
        ((ADDED++))
        return 0
    fi

    # File identical - skip
    if [[ "$workspace_checksum" == "$project_checksum" ]]; then
        echo -e "   ○ Unchanged: $rel_path"
        update_metadata "$rel_path" "$workspace_checksum" false false
        ((SKIPPED++))
        return 0
    fi

    # Special handling for config.json
    if [[ "$rel_path" == "config.json" ]]; then
        merge_config_json "$workspace_file" "$project_file"
        local new_checksum=$(calculate_checksum "$project_file")
        update_metadata "$rel_path" "$new_checksum" false false
        ((UPDATED++))
        return 0
    fi

    # Special handling for linear.md
    if [[ "$rel_path" == "commands/linear.md" ]]; then
        if is_configured "$project_file"; then
            echo -e "${YELLOW}   ⚠️  Skipped: $rel_path (configured, has local values)${NC}"
            echo -e "${BLUE}      Workspace has updates. Review manually if needed.${NC}"
            update_metadata "$rel_path" "$project_checksum" false true
            ((SKIPPED++))
            return 0
        fi
    fi

    # Check if it's an agent (pure logic - safe to overwrite)
    if [[ "$rel_path" == agents/* ]]; then
        cp "$workspace_file" "$project_file"
        echo -e "${GREEN}   ✓ Updated: $rel_path (agent - auto-update)${NC}"
        update_metadata "$rel_path" "$workspace_checksum" false false
        ((UPDATED++))
        return 0
    fi

    # Check metadata for known customization
    local metadata=$(read_metadata)
    local is_customized=false
    if command -v jq &> /dev/null; then
        is_customized=$(echo "$metadata" | jq -r ".installedFiles[\"$rel_path\"].customized // false")
    fi

    if [[ "$is_customized" == "true" ]]; then
        echo -e "${YELLOW}   ⚠️  Conflict: $rel_path (has local customizations)${NC}"
        echo -e "${BLUE}      Options:${NC}"
        echo -e "${BLUE}      1. Keep local version (skip update)${NC}"
        echo -e "${BLUE}      2. Take workspace version (lose local changes)${NC}"
        echo -e "${BLUE}      3. View diff and decide${NC}"
        read -p "      Choice [1/2/3]: " choice

        case $choice in
            2)
                cp "$workspace_file" "$project_file"
                echo -e "${GREEN}      ✓ Took workspace version${NC}"
                update_metadata "$rel_path" "$workspace_checksum" false false
                ((UPDATED++))
                ;;
            3)
                echo ""
                diff -u "$project_file" "$workspace_file" | sed 's/^/      /' || true
                echo ""
                read -p "      Apply workspace version? [y/N]: " apply
                if [[ "$apply" == "y" || "$apply" == "Y" ]]; then
                    cp "$workspace_file" "$project_file"
                    echo -e "${GREEN}      ✓ Applied workspace version${NC}"
                    update_metadata "$rel_path" "$workspace_checksum" false false
                    ((UPDATED++))
                else
                    echo -e "${YELLOW}      Kept local version${NC}"
                    update_metadata "$rel_path" "$project_checksum" false true
                    ((SKIPPED++))
                fi
                ;;
            *)
                echo -e "${YELLOW}      Kept local version${NC}"
                update_metadata "$rel_path" "$project_checksum" false true
                ((SKIPPED++))
                ;;
        esac
        ((CONFLICTS++))
        return 0
    fi

    # Regular command file - likely safe but check
    echo -e "${YELLOW}   ⚠️  Modified: $rel_path${NC}"
    echo -e "${BLUE}      Local version differs from workspace.${NC}"
    read -p "      Update to workspace version? [Y/n]: " update_choice

    if [[ "$update_choice" == "n" || "$update_choice" == "N" ]]; then
        echo -e "${YELLOW}      Kept local version${NC}"
        update_metadata "$rel_path" "$project_checksum" true false
        ((SKIPPED++))
    else
        cp "$workspace_file" "$project_file"
        echo -e "${GREEN}      ✓ Updated to workspace version${NC}"
        update_metadata "$rel_path" "$workspace_checksum" false false
        ((UPDATED++))
    fi
}

# Main execution
main() {
    # Validation
    if [[ ! -d "$WORKSPACE_DIR/.claude" ]]; then
        echo -e "${RED}Error: Workspace .claude/ directory not found${NC}"
        exit 1
    fi

    if [[ ! -d "$CLAUDE_DIR" ]]; then
        echo -e "${RED}Error: Project .claude/ directory not found${NC}"
        echo "Run ./hack/install-project.sh first to install workspace"
        exit 1
    fi

    # Check git status (warn if dirty)
    cd "$PROJECT_DIR"
    if git status --porcelain 2>/dev/null | grep -q "^ M\|^M\|^A"; then
        echo -e "${YELLOW}⚠️  Warning: Project has uncommitted changes${NC}"
        read -p "Continue anyway? [y/N]: " continue_choice
        if [[ "$continue_choice" != "y" && "$continue_choice" != "Y" ]]; then
            echo "Aborted. Commit your changes first."
            exit 1
        fi
    fi

    # Create backup
    echo -e "${BLUE}📦 Creating backup...${NC}"
    cp -r "$CLAUDE_DIR" "$BACKUP_DIR"
    echo -e "${GREEN}✓ Backup created: $BACKUP_DIR${NC}"
    echo ""

    # Show current metadata if exists
    if [[ -f "$METADATA_FILE" ]]; then
        echo -e "${BLUE}📋 Current workspace version:${NC}"
        if command -v jq &> /dev/null; then
            local current_version=$(jq -r '.workspaceVersion // "unknown"' "$METADATA_FILE")
            local last_updated=$(jq -r '.lastUpdated // "never"' "$METADATA_FILE")
            echo "   Version: $current_version"
            echo "   Updated: $last_updated"
        fi
        echo ""
    fi

    echo -e "${BLUE}🔍 Scanning for updates...${NC}"
    echo ""

    # Process config.json first
    if [[ -f "$WORKSPACE_DIR/.claude/config.json" ]]; then
        update_file "config.json"
        echo ""
    fi

    # Process all agents
    echo -e "${BLUE}📦 Agents:${NC}"
    for agent_file in "$WORKSPACE_DIR/.claude/agents"/*.md; do
        if [[ -f "$agent_file" ]]; then
            local filename=$(basename "$agent_file")
            # Skip README.md - it's documentation, not an agent
            if [[ "$filename" = "README.md" ]]; then
                continue
            fi
            update_file "agents/$filename"
        fi
    done
    echo ""

    # Process all commands
    echo -e "${BLUE}⚙️  Commands:${NC}"
    for command_file in "$WORKSPACE_DIR/.claude/commands"/*.md; do
        if [[ -f "$command_file" ]]; then
            local filename=$(basename "$command_file")
            # Skip README.md - it's documentation, not a command
            if [[ "$filename" = "README.md" ]]; then
                continue
            fi
            update_file "commands/$filename"
        fi
    done
    echo ""

    # Finalize metadata
    finalize_metadata

    # Summary
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "${BLUE}📊 Update Summary:${NC}"
    echo "   Added:     $ADDED files"
    echo "   Updated:   $UPDATED files"
    echo "   Skipped:   $SKIPPED files"
    echo "   Conflicts: $CONFLICTS files"
    echo ""
    echo -e "${GREEN}✓ Update complete!${NC}"
    echo ""
    echo "Workspace version: $(get_workspace_version | cut -c1-8)"
    echo "Backup location:   $BACKUP_DIR"
    echo ""

    if [[ $CONFLICTS -gt 0 ]]; then
        echo -e "${YELLOW}⚠️  Some files had conflicts that required manual decisions.${NC}"
        echo "Review the changes and test before committing."
    fi

    echo ""
    echo -e "${BLUE}Next steps:${NC}"
    echo "1. Test your project to ensure everything works"
    echo "2. Review changes: git diff .claude/"
    echo "3. Commit if satisfied: git add .claude/ && git commit -m 'Update workspace'"
    echo "4. Remove backup if all is well: rm -rf $BACKUP_DIR"
}

# Run main
main
