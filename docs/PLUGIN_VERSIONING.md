# Plugin Versioning & Update Automation

## How Plugin Updates Work

When users have Catalyst plugins installed, they update via:

```bash
/plugin update catalyst-dev
/plugin update catalyst-pm
```

Or update all plugins:
```bash
/plugin update
```

Claude Code checks the `version` field in each plugin's `.claude-plugin/plugin.json` and downloads the latest if it differs from the installed version.

## Version Bumping

We use **semantic versioning** (MAJOR.MINOR.PATCH):

- **MAJOR** (x.0.0): Breaking changes (e.g., required new dependencies, removed features)
- **MINOR** (1.x.0): New features (backward compatible)
- **PATCH** (1.0.x): Bug fixes

### When to Bump Versions

**Always bump versions when:**
- ✅ Changing any files in `plugins/dev/` or `plugins/pm/`
- ✅ Adding new commands or agents
- ✅ Modifying command behavior
- ✅ Updating dependencies or prerequisites
- ✅ Fixing bugs

**Version bump magnitude:**
- **MAJOR**: Thoughts system now required, config format changed
- **MINOR**: New `/pm:analyze-milestone` command added
- **PATCH**: Fixed bug in workflow-context.sh

## Automation Tools

### 1. Bump Version Script

Quick version bumping for one or all plugins:

```bash
# Bump catalyst-dev by type
./scripts/bump-version.sh dev major    # 1.0.0 → 2.0.0
./scripts/bump-version.sh dev minor    # 1.0.0 → 1.1.0
./scripts/bump-version.sh dev patch    # 1.0.0 → 1.0.1

# Set specific version
./scripts/bump-version.sh dev 2.1.0

# Bump all plugins at once
./scripts/bump-version.sh all minor
```

**Output:**
```
📦 Plugin: catalyst-dev
   Current version: 1.0.0
   New version: 2.0.0
   ✅ Updated!

✨ Version bump complete!

📝 Next steps:
  1. Review changes: git diff plugins/*/.claude-plugin/plugin.json
  2. Update CHANGELOG.md with changes
  3. Commit: git add -A && git commit -m 'chore: bump version to 2.0.0'
  4. Tag release: git tag v2.0.0 && git push --tags
```

### 2. Version Check Script

Detects when plugin files changed without version bump:

```bash
./scripts/check-plugin-version.sh
```

**Output when version bump needed:**
```
⚠️  Plugin files changed but version not bumped!

The following plugins have modified files:
  📦 catalyst-dev
     - plugins/dev/commands/research_codebase.md
     - plugins/dev/commands/create_plan.md

💡 Recommended action:

   Determine the type of change:
   - Breaking changes (required updates): major version bump
   - New features (backward compatible): minor version bump
   - Bug fixes: patch version bump

   Then run:
   ./scripts/bump-version.sh dev <major|minor|patch>
```

### 3. Pre-Commit Hook

Automatically runs version check before each commit:

**Installed at:** `.git/hooks/pre-commit`

**Behavior:**
- ⚠️ **Warning mode** (default): Shows warning but allows commit
- ❌ **Strict mode**: Blocks commit until version bumped

**Enable strict mode:**
```bash
# Edit .git/hooks/pre-commit and uncomment:
export STRICT_VERSION_CHECK=true
```

## Workflow Example

### Scenario: Adding a New Feature

```bash
# 1. Make your changes
vim plugins/dev/commands/new_feature.md

# 2. Pre-commit hook will warn you
git add plugins/dev/commands/new_feature.md
git commit -m "feat: add new feature"
# Output:
# ⚠️  Plugin files changed but version not bumped!
# ...

# 3. Bump version (new feature = minor)
./scripts/bump-version.sh dev minor

# 4. Commit version bump
git add plugins/dev/.claude-plugin/plugin.json
git commit -m "chore: bump catalyst-dev to v1.1.0"

# 5. Tag and push
git tag catalyst-dev-v1.1.0
git push origin main --tags
```

### Scenario: Bug Fix Across All Plugins

```bash
# 1. Fix the bug in shared code
vim plugins/*/scripts/workflow-context.sh

# 2. Bump all plugins at once (bug fix = patch)
./scripts/bump-version.sh all patch

# 3. Review changes
git diff plugins/*/.claude-plugin/plugin.json

# 4. Commit
git add -A
git commit -m "fix: correct workflow context timestamp format

- Bump all plugins to x.y.1 for bug fix"

# 5. Push
git push origin main --tags
```

## Best Practices

1. **Version before push**: Always bump versions before pushing to main
2. **Descriptive commits**: Include version change in commit message
3. **Tag releases**: Create git tags for major/minor releases
4. **Update CHANGELOG**: Document changes for each version
5. **Test locally**: Use `/plugin update` in a test project before releasing

## GitHub Releases

After version bump and push:

```bash
# Create GitHub release for major/minor versions
gh release create catalyst-dev-v2.0.0 \
  --title "catalyst-dev v2.0.0 - Thoughts System Enforcement" \
  --notes "
## Breaking Changes
- Thoughts system now required for all commands
- Config security with two-layer system

## New Features
- Automatic thoughts validation
- Clear setup error messages

## Migration
Users must run:
\`\`\`bash
./scripts/humanlayer/init-project.sh . {project-name}
./scripts/setup-catalyst-config.sh
\`\`\`
"
```

## User Notification

Users find out about updates via:

1. **GitHub releases** (if they watch the repo)
2. **Running `/plugin update`** (checks for new versions)
3. **Announcements** in README or discussions
4. **Command output** (consider adding version warnings to commands)

## Version Check in Commands (Future)

Consider adding version checks to commands:

```markdown
## Version Check (Optional)

Check if plugin is outdated:

\`\`\`bash
CURRENT_VERSION="2.0.0"
LATEST=$(curl -s https://api.github.com/repos/coalesce-labs/catalyst/releases/latest | jq -r .tag_name)

if [[ "$LATEST" > "catalyst-dev-v$CURRENT_VERSION" ]]; then
  echo "⚠️  Update available: $LATEST"
  echo "   Run: /plugin update catalyst-dev"
fi
\`\`\`
```

## Troubleshooting

**Q: I forgot to bump the version before pushing**

A: Run the bump script and push again:
```bash
./scripts/bump-version.sh dev patch
git add plugins/dev/.claude-plugin/plugin.json
git commit -m "chore: bump version (missed in previous commit)"
git push
```

**Q: Users not getting updates**

A: Verify:
1. Version in `plugin.json` was bumped
2. Changes were pushed to main branch
3. Users ran `/plugin update catalyst-dev`

**Q: How do I test updates locally?**

A: Install from local path during development:
```bash
/plugin uninstall catalyst-dev
/plugin install /path/to/catalyst/plugins/dev
```
