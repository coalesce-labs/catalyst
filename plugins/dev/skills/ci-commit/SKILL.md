---
name: ci-commit
description: "Create git commits autonomously for CI/automation (no user interaction). Non-interactive variant of /commit for use in CI pipelines, automated workflows, and background tasks. Never prompts the user."
user-invocable: false
allowed-tools: Bash, Read
version: 1.0.0
---

# CI Commit

Create git commits autonomously without user interaction. Designed for CI pipelines,
automated workflows, and non-interactive contexts.

## Key Differences from `/commit`

- **No user confirmation** — commits immediately
- **No interactive prompts** — fully autonomous
- **Conventional commit format** — maintained for consistency
- **Safety checks** — never commits sensitive files or thoughts/

## Process

### 1. Analyze Changes

```bash
# Check for changes
git status --porcelain
git diff --cached --name-only
git diff --name-only
```

If no changes exist, exit silently:
```
No changes to commit.
```

### 2. Safety Filters

**NEVER commit these files:**
- `thoughts/` directory (persistent context, managed separately)
- `.env`, `.env.*` files (secrets)
- `*.secret`, `*.key`, `*.pem` files
- `.claude/` configuration files
- Files matching patterns in `.gitignore`

**NEVER commit dummy or test artifacts:**
- Files named `test_*`, `dummy_*`, `temp_*` in non-test directories
- Empty placeholder files

### 3. Auto-detect Commit Components

**Type detection:**
- Only `*.md` files in `docs/` → `docs`
- Only test files → `test`
- Only `package.json`, `*.lock` → `build`
- Only `.github/workflows/` → `ci`
- Bug fix context → `fix`
- Otherwise → `feat` or `chore` based on context

**Scope detection:**
- Parse changed file paths to determine scope
- Use directory-based scoping (e.g., `agents`, `commands`, `scripts`)
- Cross-cutting changes → empty scope

**Ticket extraction:**
- Extract from branch name: `{PREFIX}-{NUMBER}`
- Add as `Refs: TICKET-123` in footer

### 4. Generate and Execute Commit

```bash
# Stage only safe files
git add [specific files, never -A or .]

# Create commit with conventional format
git commit -m "$(cat <<'EOF'
<type>(<scope>): <summary>

<body explaining what changed and why>

Refs: TICKET-123
EOF
)"
```

### 5. Report Result

```bash
git log --oneline -n 1
git show --stat HEAD
```

## Important

- **NEVER add co-author information or Claude attribution**
- **NEVER commit thoughts/ directory**
- **NEVER use git add -A or git add .**
- **NEVER prompt the user** — this is fully autonomous
- Keep commits atomic and focused
- Use conventional commit format for changelog generation
