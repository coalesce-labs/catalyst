---
date: 2025-10-26T04:30:00+0000
author: Claude
repository: catalyst
topic: "Remaining Documentation Work - Implementation Plan"
tags: [planning, documentation, maintenance]
status: ready-for-implementation
---

# Remaining Documentation Work - Implementation Plan

**Date**: 2025-10-26 **Purpose**: Prioritized plan for fixing remaining documentation issues
**Related**: research/2025-10-26-documentation-audit.md

## Status

✅ **CRITICAL ISSUES FIXED** (Committed: a3c5dab)

- QUICKSTART.md - Plugin install, command names, hack/ refs
- CLAUDE.md - Config schema, installation, hack/ refs
- README.md - Command naming
- docs/CONFIGURATION.md - Linear schema, new services
- docs/USAGE.md - Installation section

## Remaining Work

### HIGH Priority (Estimated: 2-3 hours)

#### 1. Add workflow-context.json Documentation

**Where**: QUICKSTART.md, CLAUDE.md, docs/USAGE.md

**What to add**:

```markdown
## Workflow Context Auto-Discovery

Catalyst tracks your workflow automatically via `.claude/.workflow-context.json`:

- `/research-codebase` saves research
- `/create-plan` saves plan AND auto-finds recent research
- `/implement-plan` auto-finds recent plan (no path needed!)
- `/create-handoff` saves handoff
- `/resume-handoff` auto-finds recent handoff

**You don't need to specify file paths** - commands remember your most recent work!

**Location**: `.claude/.workflow-context.json` (gitignored, per-project) **Management**: Automatic -
you never touch this file directly
```

**Files to update**:

- QUICKSTART.md: Add "Tips" section about auto-discovery (DONE in commit a3c5dab)
- CLAUDE.md: Add to "Key Architecture Concepts" section
- docs/USAGE.md: Add dedicated section after "Working with Thoughts"

**Estimated effort**: 30 minutes

---

#### 2. Update docs/PATTERNS.md

**Issues**:

- Multiple `hack/` references (need →`scripts/`)
- Examples use `./hack/install-project.sh`
- Script-based patterns need plugin updates

**Changes**:

```bash
# Find all references
grep -n "hack/" docs/PATTERNS.md

# Replace with scripts/
# Update installation examples to use plugins
# Keep development patterns (edit source files directly)
```

**Estimated effort**: 45 minutes

---

#### 3. Update agents/README.md and plugins/dev/agents/README.md

**Issues**:

- Both have "User Installation" and "Project Installation" sections
- Reference old install scripts
- Create confusion about which is source of truth

**Proposed solution**:

- **agents/README.md**: Keep as source documentation
  - Remove installation sections (handled by plugin)
  - Focus on agent purpose and tools
  - Add "Distribution: Bundled in catalyst-dev plugin"

- **plugins/dev/agents/README.md**: Consider removing or making it reference-only
  - Or: Make it a symlink to agents/README.md
  - Or: Keep it but remove installation sections

**Estimated effort**: 30 minutes

---

#### 4. Update commands/README.md

**Issues**:

- References `./hack/update-project.sh`
- References `./hack/install-project.sh`
- Namespace documentation is good but needs plugin context

**Changes**:

- Remove installation references
- Add "Distribution: Bundled in catalyst-dev plugin"
- Update examples to use `/command-name` format consistently

**Estimated effort**: 20 minutes

---

### MEDIUM Priority (Estimated: 2-3 hours)

#### 5. Consolidate or Document Dual Directory Structure

**Decision needed**: Keep both `commands/` and `plugins/dev/commands/` or consolidate?

**Option A: Keep Both (Recommended)**

- `commands/` = Source for development
- `plugins/dev/commands/` = Bundled distribution
- Document sync strategy in CLAUDE.md
- Add note about editing source files, not plugin files

**Option B: Consolidate**

- Move everything to `plugins/` only
- Update all references
- Remove `commands/` and `agents/` directories

**If Option A**:

```markdown
## Source vs Distribution

**Source Files** (`commands/`, `agents/`):

- Edit these when developing Catalyst
- Changes are manually synced to plugin structure
- This is where PRs should update

**Plugin Files** (`plugins/dev/`, `plugins/meta/`):

- Distribution copies for plugin system
- Auto-generated from source (or manually synced for now)
- Don't edit these directly

**For Catalyst development**: Always edit source files in `commands/` and `agents/` **For Catalyst
users**: Install via plugin, never see these directories
```

**Estimated effort**: 1 hour (documentation + decision making)

---

#### 6. Update Remaining docs/ Files

**Files needing hack/ → scripts/ updates**:

- docs/BEST_PRACTICES.md
- docs/AGENTIC_WORKFLOW_GUIDE.md
- docs/MULTI_CONFIG_GUIDE.md
- docs/LINEAR_WORKFLOW_AUTOMATION.md
- docs/PATTERNS.md (see #2 above)

**Process**:

```bash
# For each file
grep -n "hack/" docs/<file>.md
# Replace with scripts/ or plugin commands as appropriate
```

**Estimated effort**: 1.5 hours (5-6 files × 15 min each)

---

#### 7. Update commands/project/create_worktree.md

**Current**: References `hack/create-worktree.sh`

**Should be**: `/create-worktree` command

**Also document**: .claude/ symlinking approach for worktrees

**Estimated effort**: 20 minutes

---

#### 8. Consolidate Linear Documentation

**Files with Linear inconsistencies**:

- docs/LINEAR_WORKFLOW_AUTOMATION.md
- scripts/setup-linear-workflow
- commands/linear/linear.md
- plugins/dev/commands/linear.md

**Issues**:

- Some reference MCP, some reference Linearis CLI
- Different field names (teamId vs teamKey)
- setup-linear-workflow uses GraphQL but commands use CLI

**Solution**:

- Update LINEAR_WORKFLOW_AUTOMATION.md to Linearis CLI only
- Update setup-linear-workflow to use teamKey not TEAM_ID
- Standardize on Linearis CLI throughout
- Add note about 13x token efficiency

**Estimated effort**: 45 minutes

---

### LOW Priority (Estimated: 1-2 hours)

#### 9. Add Architecture Decision Records

**Purpose**: Link research documents from main docs

**Where**: CLAUDE.md - Add new section

```markdown
## Architecture Decisions

Major architectural changes are documented in research/:

- [Plugin Packaging Strategy](research/2025-10-25-claude-code-plugin-packaging-strategy.md) - Why
  plugins over scripts
- [2-Plugin Structure](research/2025-10-25-catalyst-2-plugin-structure.md) - dev vs meta split
- [Tooling Integration](research/2025-10-25-catalyst-tooling-integration-plan.md) - External
  services
- [Configuration Strategy](research/2025-10-25-config-file-strategy.md) - Template pattern
```

**Estimated effort**: 30 minutes

---

#### 10. Update CONTRIBUTING.md

**Current issues**:

- Line 20: References git clone
- Likely has installation instructions

**Changes**:

- Update for plugin development workflow
- Add section on editing source vs plugin files
- Document local testing process

**Estimated effort**: 30 minutes

---

#### 11. Update commands/dev/commit.md and describe_pr.md

**Issue**: Example commit messages reference old installation

- "docs(hack): add README for installation scripts"

**Solution**: Update examples to current reality

- Plugin-based examples
- scripts/ not hack/

**Estimated effort**: 15 minutes per file = 30 minutes

---

### OPTIONAL Enhancements

#### 12. Create Migration Guide

**For**: Users upgrading from script-based to plugin-based

**Content**:

````markdown
# Migrating to Plugin-Based Catalyst

## From Script Installation

**Old way**:

```bash
./hack/install-user.sh
```
````

**New way**:

```bash
/plugin marketplace add coalesce-labs/catalyst
/plugin install catalyst-dev
```

## Cleaning Up

**Remove old installation**:

```bash
rm -rf ~/.claude/agents/codebase-*
rm -rf ~/.claude/commands/
```

**Keep**:

- `.claude/config.json` (your configuration)
- `.claude/.workflow-context.json` (your workflow state)

## What Changed

- Installation: Script-based → Plugin marketplace
- Updates: `./hack/update-project.sh` → `/plugin update catalyst-dev`
- Directory: `hack/` → `scripts/` (setup scripts only)

````

**Estimated effort**: 45 minutes

---

## Summary Tables

### By Priority

| Priority | Tasks | Total Effort |
|----------|-------|--------------|
| HIGH     | 4 tasks | 2-3 hours |
| MEDIUM   | 5 tasks | 2-3 hours |
| LOW      | 3 tasks | 1-2 hours |
| OPTIONAL | 1 task  | 45 min |
| **TOTAL** | **13 tasks** | **6-8 hours** |

### By Type

| Type | Tasks | Effort |
|------|-------|--------|
| Add new documentation | 2 (workflow-context, ADRs) | 1 hour |
| Fix hack/ references | 6 (multiple docs/) | 2.5 hours |
| Update installation docs | 3 (agents, commands READMEs) | 1.5 hours |
| Consolidate inconsistencies | 2 (Linear, dual structure) | 1.5 hours |

### By File

| File | Changes Needed | Effort | Priority |
|------|---------------|--------|----------|
| CLAUDE.md | Add workflow-context, dual structure docs | 45 min | HIGH |
| docs/USAGE.md | Add workflow-context section | 20 min | HIGH |
| docs/PATTERNS.md | Fix hack/ refs, update examples | 45 min | HIGH |
| agents/README.md | Remove install sections, clarify purpose | 15 min | HIGH |
| plugins/dev/agents/README.md | Remove/consolidate | 15 min | HIGH |
| commands/README.md | Remove install refs, add plugin note | 20 min | HIGH |
| docs/BEST_PRACTICES.md | Fix hack/ refs | 15 min | MEDIUM |
| docs/AGENTIC_WORKFLOW_GUIDE.md | Fix hack/ refs | 15 min | MEDIUM |
| docs/MULTI_CONFIG_GUIDE.md | Fix hack/ refs | 15 min | MEDIUM |
| docs/LINEAR_WORKFLOW_AUTOMATION.md | Linearis CLI consistency | 30 min | MEDIUM |
| scripts/setup-linear-workflow | Update field names | 15 min | MEDIUM |
| commands/project/create_worktree.md | Update to command format | 20 min | MEDIUM |
| CONTRIBUTING.md | Update for plugin dev | 30 min | LOW |
| commands/dev/*.md | Update commit examples | 30 min | LOW |

## Recommended Execution Order

### Session 1: HIGH Priority (2-3 hours)
1. Add workflow-context.json docs (CLAUDE.md, docs/USAGE.md)
2. Fix docs/PATTERNS.md
3. Update agents/README.md and plugins/dev/agents/README.md
4. Update commands/README.md

### Session 2: MEDIUM Priority (2-3 hours)
5. Document dual directory structure (or consolidate)
6. Update remaining docs/ files (batch hack/ → scripts/)
7. Update create_worktree.md
8. Consolidate Linear documentation

### Session 3: LOW Priority (1-2 hours)
9. Add Architecture Decision Records
10. Update CONTRIBUTING.md
11. Update command example messages

### Session 4: OPTIONAL
12. Create migration guide

## Decision Points

Before starting MEDIUM priority work, decide:

**Q1: Keep dual directory structure (commands/ + plugins/) or consolidate?**
- **Recommendation**: Keep both, document clearly
- **Reason**: Maintains clear source/distribution separation
- **Impact if changed**: Would need to update all development workflows

**Q2: What to do with plugins/dev/agents/README.md duplication?**
- **Option A**: Delete it, reference agents/README.md instead
- **Option B**: Symlink to agents/README.md
- **Option C**: Keep but make minimal (just distribution info)
- **Recommendation**: Option A (delete, add one-line reference)

**Q3: Create migration guide or not?**
- **Recommendation**: Yes, helpful for users
- **When**: After all other updates complete
- **Where**: Create as docs/MIGRATION.md

## Testing Plan

After each session:

1. **Grep for remaining issues**:
   ```bash
   grep -r "hack/" *.md docs/ commands/ agents/
   grep -r "install-user" *.md docs/
   grep -r "teamId" *.md docs/
````

2. **Check command examples**:

   ```bash
   grep -r "/create_plan" *.md docs/  # Should be /create-plan
   ```

3. **Verify links work**:
   ```bash
   # Check all internal links resolve
   ```

## Completion Criteria

Documentation is "done" when:

- ✅ Zero references to `hack/` (except in git history)
- ✅ Zero references to deleted scripts (install-user.sh, install-project.sh, update-project.sh)
- ✅ Zero command names with underscores in user docs
- ✅ Zero Linear config with teamId/projectId (only teamKey/defaultTeam)
- ✅ workflow-context.json documented in 3+ places
- ✅ All examples use plugin installation
- ✅ Source/distribution structure explained
- ✅ Grep test suite passes

## Notes

- **CRITICAL fixes**: Already completed in commit a3c5dab
- **User impact**: Reduced from HIGH to MEDIUM with critical fixes
- **Remaining work**: Mostly consistency and completeness
- **No breaking changes**: All remaining updates are documentation-only

## Next Action

Start with Session 1 (HIGH Priority) when ready. All issues are documented, prioritized, and
estimated.
