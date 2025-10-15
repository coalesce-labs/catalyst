# Contributing to Ryan Claude Workspace

Thank you for your interest in contributing! This document provides guidelines for contributing to the workspace.

## Development Setup

### Prerequisites

- **Trunk** - Code quality tooling (linters, formatters)
- **Make** - Build automation
- **Git** - Version control
- **jq** - JSON processor (for config handling)
- **HumanLayer CLI** (optional) - For thoughts system

### Installation

```bash
# Clone the repository
git clone https://github.com/your-org/ryan-claude-workspace.git
cd ryan-claude-workspace

# Install dependencies (if using Trunk)
trunk install
```

## Code Quality

This project uses **Trunk** for automated code quality checks. All code must pass linting before being merged.

### Running Quality Checks

```bash
# Run all quality checks (recommended before committing)
make check

# Run only linters
make lint

# Run only frontmatter validation
make check-frontmatter

# Auto-fix formatting issues
make format
```

### What Gets Checked

**Enabled linters:**

- **shellcheck** - Shell script linting
- **shfmt** - Shell script formatting
- **markdownlint** - Markdown linting
- **prettier** - Code formatting
- **yamllint** - YAML linting (frontmatter)
- **frontmatter-validator** - Custom validator for command/agent frontmatter

### Pre-commit Workflow

Before committing changes:

1. **Run quality checks:**

   ```bash
   make check
   ```

2. **Fix any issues:**

   ```bash
   make format  # Auto-fix what can be fixed
   # Manually fix remaining issues
   ```

3. **Commit your changes:**
   ```bash
   git add .
   git commit -m "feat: your change description"
   ```

## Command and Agent Development

### Adding a New Command

1. Create markdown file in `commands/{namespace}/{command-name}.md`
2. **Add frontmatter** (required):

   ```yaml
   ---
   description: Brief description of what command does
   category: workflow|dev|linear|meta|project|handoff
   tools: Read, Write, Bash, Task, etc.
   model: inherit
   version: 1.0.0
   ---
   ```

3. Write command logic following existing patterns
4. Test with `/your-command-name` in Claude Code
5. Run `make check` to validate frontmatter and formatting

### Adding a New Agent

1. Create markdown file in `agents/{agent-name}.md`
2. **Add frontmatter** (required):

   ```yaml
   ---
   name: agent-name
   description: What this agent does
   tools: Grep, Glob, Read, etc.
   model: inherit
   ---
   ```

3. Write agent logic as documentarian (not critic)
4. Test by invoking agent in a command
5. Run `make check` to validate

### Frontmatter Validation

The custom frontmatter validator checks:

**For commands:**

- ✅ Has `description` field
- ✅ Has `category` field

**For agents:**

- ✅ Has `name` field
- ✅ Has `description` field
- ✅ Has `tools` field

**Skipped files:**

- README.md files (documentation, not commands/agents)

## Shell Script Development

### Best Practices

1. **Use shellcheck** - All scripts are linted except those with ANSI colors
2. **Add disable comments** for intentional violations:

   ```bash
   # shellcheck disable=SC2310 # Reason for disabling
   ```

3. **Follow conventions:**
   - Use `set -euo pipefail` for strict mode
   - Quote variables: `"${var}"`
   - Use `[[` for conditionals
   - Prefer functions over inline code

### Scripts Not Linted

These scripts have ANSI color codes that confuse shellcheck:

- `hack/create-worktree.sh`
- `hack/install-user.sh`
- `hack/setup-personal-thoughts.sh`
- `hack/update-project.sh`

## CI/CD

### GitHub Actions

Pull requests automatically run:

- ✅ All Trunk linters
- ✅ Frontmatter validation
- ✅ Shellcheck on most scripts
- ✅ Markdown linting

**Checks must pass before merge.**

### Local Testing

Simulate CI checks locally:

```bash
make check
```

This runs the same checks as GitHub Actions.

## Documentation

### Updating Documentation

When making changes:

1. **Update relevant docs** in `docs/` directory
2. **Update command README** if adding to namespace
3. **Update CLAUDE.md** if changing workspace behavior
4. **Run markdownlint:**
   ```bash
   trunk check docs/
   ```

### Documentation Files

- `README.md` - Project overview and quick start
- `CLAUDE.md` - Instructions for Claude Code
- `docs/` - Comprehensive guides
- `commands/{namespace}/README.md` - Namespace documentation

## Git Workflow

### Branch Naming

Use ticket-based naming:

```
{PREFIX}-{NUMBER}-{description}
```

Examples:

- `COA-19-add-code-quality-tooling`
- `COA-20-improve-documentation`

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): description

Examples:
- feat(commands): add new debug command
- fix(ci): correct trunk configuration
- docs: update contributing guide
- chore: update dependencies
```

### Pull Requests

1. Create PR from your branch to `main`
2. Ensure CI checks pass
3. Request review if needed
4. Squash and merge when approved

## Testing

### Manual Testing

1. Install workspace locally:

   ```bash
   ./hack/install-user.sh
   ```

2. Test commands in Claude Code:

   ```
   /your-command-name
   ```

3. Verify behavior matches expectations

### Automated Testing

Currently no automated tests. Future additions:

- Command frontmatter validation (✅ done)
- Installation script behavior
- Configuration file handling

## Getting Help

- **Documentation**: See `docs/` directory
- **Issues**: Create issue on GitHub
- **Questions**: Open discussion on GitHub

## License

By contributing, you agree that your contributions will be licensed under the same license as this project.
