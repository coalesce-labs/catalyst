#!/bin/bash
# setup-multi-config.sh - Set up multiple HumanLayer configurations with easy switching
# Usage: ./setup-multi-config.sh

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

CONFIG_DIR="$HOME/.config/humanlayer"
mkdir -p "$CONFIG_DIR"

echo -e "${BLUE}🔄 Setting up multi-config HumanLayer system${NC}"
echo ""

# Step 1: Handle existing config
if [ -f "$CONFIG_DIR/humanlayer.json" ]; then
	echo "Found existing config: humanlayer.json"

	# Show what it points to
	if command -v jq >/dev/null 2>&1; then
		REPO=$(jq -r '.thoughts.thoughtsRepo' "$CONFIG_DIR/humanlayer.json" 2>/dev/null)
		echo "  Current thoughts repo: $REPO"
	fi
	echo ""

	echo "This appears to be your BRKTHRU client configuration."
	echo ""
	read -p "Rename humanlayer.json to config-brkthru.json? (Y/n) " -n 1 -r
	echo

	if [[ ! $REPLY =~ ^[Nn]$ ]]; then
		mv "$CONFIG_DIR/humanlayer.json" "$CONFIG_DIR/config-brkthru.json"
		echo -e "${GREEN}✓ Renamed to config-brkthru.json${NC}"
	fi
	echo ""
fi

# Step 2: Create coalesce-labs config
echo "Creating coalesce-labs configuration..."
echo ""

cat >"$CONFIG_DIR/config-coalesce-labs.json" <<'EOF'
{
  "thoughts": {
    "thoughtsRepo": "/Users/ryan/thoughts",
    "reposDir": "repos",
    "globalDir": "global",
    "user": "ryan",
    "repoMappings": {}
  }
}
EOF

echo -e "${GREEN}✓ Created config-coalesce-labs.json${NC}"
echo "  Thoughts repo: ~/thoughts"
echo ""

# Step 3: Initialize coalesce-labs thoughts repo
THOUGHTS_DIR="$HOME/thoughts"

if [ ! -d "$THOUGHTS_DIR" ]; then
	echo "Creating personal thoughts repository..."
	mkdir -p "$THOUGHTS_DIR"
	cd "$THOUGHTS_DIR"

	# Create structure
	mkdir -p repos global/ryan global/shared

	# Create .gitignore
	cat >.gitignore <<'GITIGNORE'
# OS files
.DS_Store
Thumbs.db

# Editor files
.vscode/
.idea/
*.swp
*.swo
*~

# Temporary files
*.tmp
*.bak

# Searchable directory (generated)
**/searchable/
GITIGNORE

	# Create README
	cat >README.md <<'README'
# Coalesce Labs Thoughts Repository

Central thoughts repository for managing context across all coalesce-labs projects.

## Structure

```
thoughts/
├── repos/              # Project-specific thoughts
│   └── {project}/
│       ├── ryan/      # Your personal notes
│       └── shared/    # Team-shared notes
└── global/            # Cross-project thoughts
    ├── ryan/          # Your personal notes
    └── shared/        # Team-shared notes
```

## Usage

```bash
# Switch to coalesce-labs config
hl-switch coalesce-labs

# Initialize a project
cd /path/to/project
humanlayer thoughts init
```
README

	# Initialize git
	git init
	git add .
	git commit -m "Initial coalesce-labs thoughts repository"

	echo -e "${GREEN}✓ Created ~/thoughts${NC}"
else
	echo -e "${YELLOW}~/thoughts already exists${NC}"
fi

echo ""

# Step 4: Set default to coalesce-labs
echo "Setting default configuration to coalesce-labs..."

if [ -e "$CONFIG_DIR/config.json" ] || [ -L "$CONFIG_DIR/config.json" ]; then
	rm "$CONFIG_DIR/config.json"
fi

ln -s "$CONFIG_DIR/config-coalesce-labs.json" "$CONFIG_DIR/config.json"
echo -e "${GREEN}✓ Default set to: coalesce-labs${NC}"
echo ""

# Step 5: Install hl-switch to PATH
echo "Installing hl-switch command..."

# Check if ~/bin exists
if [ ! -d "$HOME/bin" ]; then
	mkdir -p "$HOME/bin"
	echo -e "${YELLOW}Created ~/bin directory${NC}"
fi

# Copy hl-switch to ~/bin
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp "$SCRIPT_DIR/hl-switch" "$HOME/bin/hl-switch"
chmod +x "$HOME/bin/hl-switch"

echo -e "${GREEN}✓ Installed hl-switch to ~/bin${NC}"

# Add ~/bin to PATH in shell configs if needed
PATH_EXPORT='export PATH="$HOME/bin:$PATH"'
ADDED_TO=()

# Check and update .zshrc
if [ -f "$HOME/.zshrc" ]; then
	if ! grep -q 'export PATH.*\$HOME/bin' "$HOME/.zshrc"; then
		echo "" >>"$HOME/.zshrc"
		echo "# Added by ryan-claude-workspace setup" >>"$HOME/.zshrc"
		echo "$PATH_EXPORT" >>"$HOME/.zshrc"
		ADDED_TO+=(".zshrc")
	fi
fi

# Check and update .bashrc
if [ -f "$HOME/.bashrc" ]; then
	if ! grep -q 'export PATH.*\$HOME/bin' "$HOME/.bashrc"; then
		echo "" >>"$HOME/.bashrc"
		echo "# Added by ryan-claude-workspace setup" >>"$HOME/.bashrc"
		echo "$PATH_EXPORT" >>"$HOME/.bashrc"
		ADDED_TO+=(".bashrc")
	fi
fi

# Check and update .bash_profile if it exists
if [ -f "$HOME/.bash_profile" ]; then
	if ! grep -q 'export PATH.*\$HOME/bin' "$HOME/.bash_profile"; then
		echo "" >>"$HOME/.bash_profile"
		echo "# Added by ryan-claude-workspace setup" >>"$HOME/.bash_profile"
		echo "$PATH_EXPORT" >>"$HOME/.bash_profile"
		ADDED_TO+=(".bash_profile")
	fi
fi

if [ ${#ADDED_TO[@]} -gt 0 ]; then
	echo -e "${GREEN}✓ Added ~/bin to PATH in: ${ADDED_TO[*]}${NC}"
	echo ""
	echo -e "${YELLOW}⚠️  Reload your shell to use hl-switch:${NC}"
	echo "  source ~/.zshrc"
else
	echo -e "${GREEN}✓ ~/bin already in PATH${NC}"
fi

echo ""

# Summary
echo -e "${GREEN}✅ Setup complete!${NC}"
echo ""
echo "You now have:"
echo ""
echo -e "${BLUE}1. BRKTHRU configuration:${NC}"
echo "   File: $CONFIG_DIR/config-brkthru.json"
if [ -f "$CONFIG_DIR/config-brkthru.json" ] && command -v jq >/dev/null 2>&1; then
	BRKTHRU_REPO=$(jq -r '.thoughts.thoughtsRepo' "$CONFIG_DIR/config-brkthru.json" 2>/dev/null)
	echo "   Repo: $BRKTHRU_REPO"
fi
echo ""
echo -e "${BLUE}2. COALESCE-LABS configuration (ACTIVE):${NC}"
echo "   File: $CONFIG_DIR/config-coalesce-labs.json"
echo "   Repo: ~/thoughts"
echo ""
echo -e "${BLUE}Switching between configurations:${NC}"
echo ""
echo "  hl-switch                 # Interactive menu"
echo "  hl-switch brkthru        # Switch to BRKTHRU"
echo "  hl-switch coalesce-labs  # Switch to coalesce-labs"
echo "  hl-switch status         # Show current config"
echo ""
echo -e "${BLUE}Next steps:${NC}"
echo ""
echo "1. Push coalesce-labs thoughts to GitHub:"
echo "   cd ~/thoughts"
echo "   gh repo create coalesce-labs/thoughts --private --source=. --push"
echo ""
echo "2. Test switching:"
echo "   hl-switch status         # See current config"
echo "   hl-switch brkthru       # Switch to BRKTHRU"
echo "   hl-switch coalesce-labs # Switch back"
echo ""
echo "3. Use with projects:"
echo "   cd ~/code-repos/my-project"
echo "   hl-switch coalesce-labs  # Make sure you're on the right config"
echo "   humanlayer thoughts init # Initialize thoughts for this project"
echo ""
