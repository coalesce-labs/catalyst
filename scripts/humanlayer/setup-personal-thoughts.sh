#!/bin/bash
# setup-personal-thoughts.sh - Set up personal thoughts repo alongside existing client config
# Usage: ./setup-personal-thoughts.sh

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${YELLOW}🧠 Setting up PERSONAL thoughts repository${NC}"
echo ""

CONFIG_DIR="$HOME/.config/humanlayer"
CLIENT_CONFIG="$CONFIG_DIR/humanlayer.json"
PERSONAL_CONFIG="$CONFIG_DIR/config.json"
CLIENT_BACKUP="$CONFIG_DIR/config-client.json"

# Check if humanlayer CLI is installed
if ! command -v humanlayer &> /dev/null; then
    echo -e "${RED}❌ Error: humanlayer CLI not found${NC}"
    exit 1
fi

echo -e "${GREEN}✓ HumanLayer CLI found${NC}"
echo ""

# Check if client config exists
if [ -f "$CLIENT_CONFIG" ]; then
    echo "Found existing client config at: $CLIENT_CONFIG"
    echo ""

    # Show current config
    if command -v jq &> /dev/null; then
        CURRENT_REPO=$(jq -r '.thoughts.thoughtsRepo' "$CLIENT_CONFIG")
        echo "Current thoughts repo: $CURRENT_REPO"
    else
        cat "$CLIENT_CONFIG"
    fi
    echo ""

    echo "We'll:"
    echo "  1. Rename humanlayer.json → config-client.json (for client work)"
    echo "  2. Create config.json → for your personal work"
    echo ""

    read -p "Proceed? (Y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Nn]$ ]]; then
        echo "Aborting."
        exit 0
    fi

    # Backup the client config
    echo "Backing up client config..."
    cp "$CLIENT_CONFIG" "$CLIENT_BACKUP"
    echo -e "${GREEN}✓ Client config saved to: $CLIENT_BACKUP${NC}"
    echo ""
fi

# Now set up personal config
echo "Setting up your PERSONAL thoughts repository..."
echo ""
echo "Default location: ~/thoughts (for personal/coalesce-labs work)"
echo ""

# Create personal config
cat > "$PERSONAL_CONFIG" <<'EOF'
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

echo -e "${GREEN}✓ Personal config created: $PERSONAL_CONFIG${NC}"
echo ""

# Initialize the personal thoughts repo
THOUGHTS_DIR="$HOME/thoughts"

if [ -d "$THOUGHTS_DIR" ]; then
    echo -e "${YELLOW}⚠️  $THOUGHTS_DIR already exists${NC}"
else
    echo "Creating personal thoughts repository..."
    mkdir -p "$THOUGHTS_DIR"
    cd "$THOUGHTS_DIR"

    # Create structure
    mkdir -p repos global/ryan global/shared

    # Create .gitignore
    cat > .gitignore <<'GITIGNORE'
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
    cat > README.md <<README
# Personal Thoughts Repository

This is your central thoughts repository for managing context across personal and coalesce-labs projects.

## Structure

\`\`\`
thoughts/
├── repos/              # Project-specific thoughts
│   └── {project}/
│       ├── ryan/      # Your personal notes
│       └── shared/    # Team-shared notes
└── global/            # Cross-project thoughts
    ├── ryan/          # Your personal notes
    └── shared/        # Team-shared notes
\`\`\`

## Usage

\`\`\`bash
# Initialize a personal project
cd /path/to/project
humanlayer thoughts init

# Initialize a client project (use client config)
cd /path/to/client-project
humanlayer thoughts init --config-file ~/.config/humanlayer/config-client.json
\`\`\`
README

    # Initialize git
    git init
    git add .
    git commit -m "Initial personal thoughts repository"

    echo -e "${GREEN}✓ Personal thoughts repository created at: $THOUGHTS_DIR${NC}"
fi

echo ""
echo -e "${GREEN}✅ Setup complete!${NC}"
echo ""
echo "You now have:"
echo ""
echo "1. Personal config (DEFAULT):"
echo "   File: $PERSONAL_CONFIG"
echo "   Repo: ~/thoughts"
echo "   Usage: humanlayer thoughts init"
echo ""
echo "2. Client config (EXPLICIT):"
echo "   File: $CLIENT_BACKUP"
if [ -f "$CLIENT_BACKUP" ] && command -v jq &> /dev/null; then
    CLIENT_REPO=$(jq -r '.thoughts.thoughtsRepo' "$CLIENT_BACKUP")
    echo "   Repo: $CLIENT_REPO"
fi
echo "   Usage: humanlayer thoughts init --config-file ~/.config/humanlayer/config-client.json"
echo ""
echo "Next steps:"
echo "1. Push personal thoughts to GitHub:"
echo "   cd ~/thoughts"
echo "   gh repo create coalesce-labs/thoughts --private --source=. --push"
echo ""
echo "2. Test it:"
echo "   cd ~/code-repos/ryan-claude-workspace"
echo "   humanlayer thoughts init"
echo ""
