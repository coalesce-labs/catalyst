---
date: 2025-10-26T03:55:01+0000
researcher: Claude
git_commit: 62ac1a3ee113ef12c3ce535428101b854e2e6fe7
branch: main
repository: catalyst
topic: "Complete Documentation Audit for Accuracy and Currency"
tags: [research, documentation, audit, configuration, installation]
status: complete
last_updated: 2025-10-26
last_updated_by: Claude
---

# Research: Complete Documentation Audit for Accuracy and Currency

**Date**: 2025-10-26T03:55:01+0000 **Researcher**: Claude **Git Commit**:
62ac1a3ee113ef12c3ce535428101b854e2e6fe7 **Branch**: main **Repository**: catalyst

## Research Question

"Make sure all documentation is correct and up to date"

## Summary

Conducted a comprehensive audit of all 129 markdown files across the Catalyst workspace. Found **8
critical areas needing updates** following the recent migration from directory-based to plugin-based
architecture. The workspace has modern, well-structured documentation (950 KB total), but key
user-facing files (QUICKSTART.md, CLAUDE.md, docs/CONFIGURATION.md, docs/USAGE.md) still reference
the old `hack/` directory structure and script-based installation, despite the system having moved
to plugin-based distribution via Claude Code marketplace.

**Key Finding**: Documentation is split between "current plugin-based reality" (README.md,
scripts/README.md) and "legacy script-based instructions" (QUICKSTART.md, CLAUDE.md, docs/USAGE.md).
This creates confusion for new users trying to get started.

## Detailed Findings

### 1. Installation Instructions: Plugin vs Scripts (CRITICAL)

**Issue**: Mixed messages about how to install Catalyst

#### Current (Correct) Documentation

**File**: `README.md:26-35`

```bash
/plugin marketplace add coalesce-labs/catalyst
/plugin install catalyst-dev
/plugin install catalyst-meta  # Optional
```

**File**: `scripts/README.md:23-34`

- Correctly documents plugin-based distribution
- Explains bundled scripts vs setup scripts
- No references to install-user.sh or install-project.sh

#### Outdated Documentation (Needs Update)

**File**: `QUICKSTART.md:6-7, 44-46, 61, 189`

- Still recommends: `./hack/install-user.sh`, `./hack/install-project.sh /path/to/project`
- References `hack/` directory that's now `scripts/`
- Doesn't mention plugin installation at all

**File**: `CLAUDE.md:80-101`

- Full section "Installing to Projects" documents old installation methods
- Shows `./hack/install-user.sh`, `./hack/install-project.sh`, `./hack/update-project.sh`
- These scripts were deleted in commit 62ac1a3

**File**: `docs/USAGE.md:20-86`

- Comprehensive section on script-based installation
- Walkthrough of `./hack/setup-thoughts.sh`, `./hack/install-user.sh`, `./hack/install-project.sh`
- No mention of plugin system

**Additional Files**:

- `docs/PATTERNS.md` - Multiple references to `./hack/install-project.sh`
- `agents/README.md` - "User Installation", "Project Installation" sections use old scripts
- `plugins/dev/agents/README.md` - Duplicates old installation documentation
- `commands/README.md` - References `./hack/update-project.sh`
- `artifacts/README.md` - Notes about `./hack/install-project.sh`

**Impact**: New users following QUICKSTART.md will encounter errors trying to run non-existent
scripts.

---

### 2. hack/ Directory References (CRITICAL)

**Issue**: 100+ references to `hack/` directory across documentation, but directory was renamed to
`scripts/` in commit 62ac1a3

#### Files with hack/ References

**High Priority** (user-facing):

- `CLAUDE.md` - 11 references
- `docs/USAGE.md` - 8 references
- `QUICKSTART.md` - Multiple references
- `docs/PATTERNS.md` - Multiple references

**Medium Priority** (supporting):

- `docs/AGENTIC_WORKFLOW_GUIDE.md`
- `docs/MULTI_CONFIG_GUIDE.md`
- `commands/project/create_worktree.md`
- `commands/README.md`
- `agents/README.md`

**Status**: Only `scripts/setup-thoughts.sh:130` and `scripts/init-project.sh:31,41` were updated.
All other documentation still references `hack/`.

**Example Issues**:

```bash
# QUICKSTART.md says:
./hack/setup-thoughts.sh    # File doesn't exist at this path

# Should be:
./scripts/setup-thoughts.sh  # Actual location
```

---

### 3. Command Naming: Underscores vs Hyphens (HIGH)

**Issue**: User-facing documentation shows underscores in command names, but Claude Code converts
them to hyphens

#### Correct Behavior

**File**: `commands/README.md:9-10`

- Documents mapping: "Filename: `research_codebase.md` (underscores)" → "Slash command:
  `/research-codebase` (hyphens)"
- Lines 41-56 correctly show: `/research-codebase`, `/create-plan`, `/implement-plan`,
  `/validate-plan`

#### Incorrect Documentation

**File**: `README.md:42`

- Shows:
  `/research_codebase → /create_plan → /implement_plan → /validate_plan → /create_pr → /merge_pr`
- Should show:
  `/research-codebase → /create-plan → /implement-plan → /validate-plan → /create-pr → /merge-pr`

**File**: `QUICKSTART.md:89, 101, 198, 199, 258`

- Line 89: `/create_plan` → should be `/create-plan`
- Line 101: `/implement_plan path...` → should be `/implement-plan path...`
- Lines 198-199: Command table shows underscores

**Impact**: Users trying `/create_plan` will get "command not found" errors.

---

### 4. Dual Directory Structure Not Explained (MEDIUM)

**Issue**: Both old and new command structures coexist without explanation

#### Current Reality

Commands exist in TWO locations:

- `/commands/` - Source directory (24 command files)
- `/plugins/dev/` - Plugin structure (18 commands)
- `/plugins/meta/` - Plugin structure (5 commands)

**Duplicated files**:

- `commands/workflow/create_plan.md` AND `plugins/dev/commands/create_plan.md`
- `commands/linear/linear.md` AND `plugins/dev/commands/linear.md`
- `commands/handoff/create_handoff.md` AND `plugins/dev/commands/create_handoff.md`

#### Documentation Gap

**File**: `CLAUDE.md:131-160`

- Describes directory structure with `agents/` and `commands/`
- Doesn't mention `plugins/` structure at all
- No explanation of why both exist

**File**: `commands/README.md`

- References new plugin system but points to old directory structure

**Missing Information**:

- Which is the source of truth?
- Are these being synced automatically?
- What happens if you edit both?
- When should users look in `commands/` vs `plugins/`?

---

### 5. workflow-context.json Feature Undocumented (HIGH)

**Issue**: Critical feature is fully implemented but completely undocumented in user-facing
documentation

#### Current Implementation

**Location**: `.claude/.workflow-context.json` (gitignored)

**Purpose**: Tracks workflow progress across research → plan → implement → PR lifecycle

**Script**: `scripts/workflow-context.sh` and `plugins/dev/scripts/workflow-context.sh` (identical)

**Operations**:

- `init` - Initialize context file
- `add` - Add document to workflow
- `recent` - Get recent document of type
- `most-recent` - Get most recent document overall
- `get-by-ticket` - Get documents for specific ticket

#### Usage in Commands

**File**: `commands/handoff/create_handoff.md:126-127`

- Adds handoff to context

**File**: `commands/workflow/create_plan.md:332-333`

- Adds plan to context

**File**: `commands/linear/create_pr.md:178-179`

- Adds PR to context

**File**: `commands/workflow/implement_plan.md:40-41`

- **Auto-retrieves recent plan from context** if no plan file specified

**File**: `commands/workflow/research_codebase.md:676-677`

- Adds research document to context

**File**: `commands/handoff/resume_handoff.md:75-76`

- **Auto-retrieves recent handoff from context**

#### Documentation Gap

**Not mentioned in**:

- `README.md` - No mention of workflow-context.json or context tracking
- `QUICKSTART.md` - No mention of automatic context management
- `CLAUDE.md` - No mention of workflow context feature
- `docs/USAGE.md` - No explanation of auto-discovery

**User Experience Gap**:

- Users see commands like `/implement-plan` but don't know it auto-retrieves from context
- Users follow `/research-codebase` → `/create-plan` → `/implement-plan` without understanding
  context auto-discovery
- No documentation explains why these commands "just work" without explicit file paths

**Evidence of Implementation**: **File**: `IMPLEMENTATION_STATUS.md:32`

- Shows Phase 7 completed: "Enhanced workflow-context.json integration"

**File**: `IMPLEMENTATION_STATUS.md:59-72`

- Lists commands that use workflow-context.json
- But this is internal status tracking, not user documentation

---

### 6. Configuration Schema Mismatch (CRITICAL)

**Issue**: Documentation shows wrong field names for Linear configuration

#### Documented Schema

**File**: `CLAUDE.md:108-124`

```json
{
  "project": {
    "ticketPrefix": "TICKET",
    "defaultTicketPrefix": "TICKET"
  },
  "linear": {
    "teamId": null,
    "projectId": null,
    "thoughtsRepoUrl": null
  },
  "thoughts": {
    "user": null
  }
}
```

**File**: `docs/CONFIGURATION.md` (similar issues)

```json
{
  "linear": {
    "teamId": null,
    "projectId": null,
    "thoughtsRepoUrl": null
  }
}
```

#### Actual Schema

**File**: `.claude/config.json:8-11`

```json
{
  "linear": {
    "teamKey": "[NEEDS_SETUP]",
    "defaultTeam": "[NEEDS_SETUP]",
    "apiToken": "[NEEDS_SETUP]"
  }
}
```

**File**: `plugins/dev/commands/linear.md:34-46`

```json
{
  "linear": {
    "teamKey": "ENG",
    "defaultTeam": "Backend",
    "thoughtsRepoUrl": "https://github.com/org/thoughts"
  }
}
```

#### What Commands Read

**File**: Multiple command files

```bash
TEAM_KEY=$(jq -r '.linear.teamKey // "PROJ"' "$CONFIG_FILE")
THOUGHTS_URL=$(jq -r '.linear.thoughtsRepoUrl // "https://..."' "$CONFIG_FILE")
```

**Impact**: Users following CLAUDE.md will create configs with wrong field names, causing commands
to fail.

---

### 7. Missing Service Configuration Documentation (MEDIUM)

**Issue**: New services added to config but not documented

#### Services in config.template.json

**File**: `.claude/config.template.json`

```json
{
  "railway": {
    "projectId": "[NEEDS_SETUP]",
    "defaultService": "[NEEDS_SETUP]"
  },
  "sentry": {
    "org": "[NEEDS_SETUP]",
    "project": "[NEEDS_SETUP]",
    "authToken": "[NEEDS_SETUP]"
  },
  "posthog": {
    "apiKey": "[NEEDS_SETUP]",
    "projectId": "[NEEDS_SETUP]"
  },
  "exa": {
    "apiKey": "[NEEDS_SETUP]"
  }
}
```

#### Missing Documentation

**File**: `docs/CONFIGURATION.md`

- No documentation for Railway configuration
- No documentation for Sentry configuration
- No documentation for PostHog configuration
- No documentation for Exa configuration

**Research Files Exist**:

- `agents/railway-research.md` - Documents Railway CLI usage
- `agents/sentry-research.md` - Documents Sentry CLI usage
- Research files from 2025-10-25 mention these integrations

**Status**: Implementation exists, research exists, but user-facing configuration documentation
missing.

---

### 8. Linear Integration Documentation Inconsistency (MEDIUM)

**Issue**: Multiple documents have conflicting Linear integration instructions

#### Inconsistencies

**File**: `docs/CONFIGURATION.md`

- Uses `teamId`, `projectId`, `thoughtsRepoUrl`

**File**: `plugins/dev/commands/linear.md`

- Reads from `teamKey`, `defaultTeam`, `apiToken`, `thoughtsRepoUrl`

**File**: `docs/LINEAR_WORKFLOW_AUTOMATION.md`

- References MCP tools but doesn't document self-configuration pattern
- Doesn't explain `[NEEDS_SETUP]` markers

**File**: `scripts/setup-linear-workflow`

- Shows GraphQL mutations
- Uses outdated `TEAM_ID` placeholder (commands use `teamKey`)

**Status**: Multiple sources don't align on configuration field names or setup approach.

---

## Code References

Quick reference of key documentation files and their status:

**Needs Major Updates**:

- `QUICKSTART.md` - Installation, hack/ refs, command names (lines 6-7, 44-46, 61, 89, 101, 189,
  198-199, 258)
- `CLAUDE.md` - Installation section, config schema, hack/ refs (lines 80-101, 108-124, multiple
  hack/ refs)
- `docs/USAGE.md` - Installation section, hack/ refs (lines 20-86, 8+ hack/ refs)
- `docs/CONFIGURATION.md` - Linear schema, missing service docs

**Needs Minor Updates**:

- `README.md` - Command naming (line 42)
- `docs/PATTERNS.md` - hack/ references
- `agents/README.md` - Installation sections
- `commands/README.md` - hack/ references

**Correct (No Changes Needed)**:

- `scripts/README.md` - Up to date with plugin distribution
- `plugins/dev/commands/linear.md` - Correct Linearis CLI integration
- Most command documentation (correct implementation references)

---

## Architecture Documentation

### Documentation Structure (Current State)

The workspace follows a three-layer documentation architecture:

1. **User-Facing Documentation** (6 root files + 15 docs/ files)
   - Entry points: README.md, QUICKSTART.md
   - Deep dives: docs/USAGE.md, docs/CONFIGURATION.md, etc.
   - Total: ~400 KB of user documentation

2. **Component Documentation** (agents/ + commands/)
   - 10 agent files describing specialized research agents
   - 24 command files with implementation specs
   - Each has YAML frontmatter following FRONTMATTER_STANDARD.md

3. **Plugin Documentation** (plugins/dev/ + plugins/meta/)
   - Mirrors source structure
   - Includes plugin manifests (.claude-plugin/plugin.json)
   - Distribution-ready format

### Current Patterns

**Pattern 1: Dual Documentation Locations**

- Commands documented in both `commands/` and `plugins/dev/commands/`
- Agents documented in both `agents/` and `plugins/dev/agents/`
- README files in both locations with slight variations

**Pattern 2: Research-Driven Documentation**

- Research files in `research/` directory (11 files, 2025-10-25 dates)
- Document major architecture decisions
- Not referenced from main user documentation

**Pattern 3: Frontmatter Consistency**

- All agents and commands use YAML frontmatter
- Standard fields: name, description, tools, model, version
- Validated by `/validate-frontmatter` command

### Data Flow

Documentation update flow (as intended):

```
Source files (agents/, commands/)
  ↓ (bundled into)
Plugin structure (plugins/dev/, plugins/meta/)
  ↓ (installed via)
Claude Code plugin system
  ↓ (used by)
End users
```

Documentation update flow (current reality):

```
Some docs reference plugin system (README.md)
Some docs reference script system (QUICKSTART.md, CLAUDE.md)
Some docs reference both without explaining relationship
End users: CONFUSED
```

### Key Integrations

**Integration 1: Installation System**

- Old: `hack/install-user.sh` → `~/.claude/`
- New: `/plugin install catalyst-dev` → Claude Code manages
- **Issue**: Documentation shows both without migration guide

**Integration 2: Command Discovery**

- Old: Files in `commands/` → `.claude/commands/` (via install scripts)
- New: Files in `plugins/dev/commands/` → Plugin loader
- **Issue**: No documentation explaining when to use which

**Integration 3: Configuration Management**

- Config files: `.claude/config.json`, `.claude/config.template.json`
- Management script: `scripts/workflow-context.sh`
- Commands read config fields
- **Issue**: Field names in docs don't match actual config structure

---

## Summary Table of Issues

| #   | Category       | Issue                                        | Severity | Files Affected                                            |
| --- | -------------- | -------------------------------------------- | -------- | --------------------------------------------------------- |
| 1   | Installation   | Plugin vs script-based instructions          | CRITICAL | QUICKSTART.md, CLAUDE.md, docs/USAGE.md, agents/README.md |
| 2   | Directory Refs | hack/ renamed to scripts/                    | CRITICAL | 100+ references across documentation                      |
| 3   | Command Names  | Underscores shown instead of hyphens         | HIGH     | README.md, QUICKSTART.md                                  |
| 4   | Architecture   | Dual directory structure not explained       | MEDIUM   | CLAUDE.md, commands/README.md                             |
| 5   | Features       | workflow-context.json undocumented           | HIGH     | All main docs                                             |
| 6   | Configuration  | Linear field names mismatch                  | CRITICAL | CLAUDE.md, docs/CONFIGURATION.md                          |
| 7   | Configuration  | Missing service docs (Railway, Sentry, etc.) | MEDIUM   | docs/CONFIGURATION.md                                     |
| 8   | Linear         | Inconsistent integration docs                | MEDIUM   | Multiple files                                            |

---

## Recommendations (Priority Order)

### Immediate (CRITICAL)

1. **Update QUICKSTART.md** (Estimated effort: 30 min)
   - Replace all `hack/` with `scripts/`
   - Replace script-based installation with plugin installation
   - Fix command names (underscores → hyphens)
   - Add workflow-context.json explanation

2. **Update CLAUDE.md** (Estimated effort: 45 min)
   - Fix configuration schema (teamId → teamKey, etc.)
   - Update "Installing to Projects" section for plugin system
   - Replace all `hack/` with `scripts/`
   - Add section on dual directory structure

3. **Update docs/CONFIGURATION.md** (Estimated effort: 1 hour)
   - Fix Linear schema to match actual config
   - Add Railway, Sentry, PostHog, Exa sections
   - Document [NEEDS_SETUP] pattern
   - Add prerequisites section

### High Priority

4. **Update docs/USAGE.md** (Estimated effort: 45 min)
   - Rewrite installation section for plugin system
   - Replace all `hack/` with `scripts/`
   - Add workflow-context.json documentation

5. **Update README.md** (Estimated effort: 10 min)
   - Fix command names in workflow diagram (line 42)

6. **Add workflow-context.json documentation** (Estimated effort: 30 min)
   - Create new section in QUICKSTART.md explaining auto-discovery
   - Update command documentation to mention context usage
   - Add to CLAUDE.md architecture section

### Medium Priority

7. **Update supporting docs** (Estimated effort: 1 hour)
   - docs/PATTERNS.md - Replace hack/ refs
   - agents/README.md - Update installation sections
   - plugins/dev/agents/README.md - Remove duplication
   - commands/README.md - Update installation refs

8. **Create migration guide** (Estimated effort: 1 hour)
   - Document transition from directory-based to plugin-based
   - Explain dual structure (if keeping both)
   - OR consolidate to single structure

9. **Consolidate Linear documentation** (Estimated effort: 45 min)
   - Align docs/LINEAR_WORKFLOW_AUTOMATION.md with current Linearis CLI approach
   - Update scripts/setup-linear-workflow to use teamKey
   - Standardize field names across all docs

### Low Priority

10. **Update research references** (Estimated effort: 30 min)
    - Link research/2025-10-25-\* files from main docs
    - Add "Architecture Decisions" section to CLAUDE.md
    - Reference decision documents

---

## Open Questions

1. **Directory Structure**: Should we keep both `commands/` and `plugins/dev/commands/`, or
   consolidate to one?
   - If keeping both: Need clear documentation of sync strategy
   - If consolidating: Need migration plan for existing references

2. **Installation Scripts**: Were `install-user.sh`, `install-project.sh`, `update-project.sh`
   deliberately removed or accidentally?
   - If deliberate: Document why and provide migration path
   - If accidental: Restore scripts or document deprecation

3. **Plugin Distribution**: Is the plugin marketplace integration complete and tested?
   - If yes: Documentation should reflect this as primary method
   - If no: Should keep script-based as fallback in docs

4. **Configuration Template**: Should `config.template.json` be the source of truth for
   documentation?
   - If yes: Auto-generate CONFIGURATION.md from template
   - If no: Manually sync template with docs

5. **Command Name Mapping**: Is the underscore→hyphen conversion documented for developers?
   - If yes: Where? (Couldn't find in audit)
   - If no: Add to CONTRIBUTING.md or CLAUDE.md

---

## Next Steps

**Recommended approach**:

1. Start with CRITICAL updates (QUICKSTART.md, CLAUDE.md, CONFIGURATION.md)
2. Get user confirmation on architecture questions (dual directories, plugin vs scripts)
3. Proceed with HIGH priority updates based on confirmed architecture
4. Create comprehensive migration guide
5. Update MEDIUM priority files
6. Validate all changes with `/validate-frontmatter` command

**Estimated total effort**: 6-8 hours of focused documentation work

**Files to update**: 15 high-priority files + 10+ supporting files

---

## Metadata

**Audit Scope**: All 129 markdown files in repository **Total Documentation Size**: ~950 KB **Search
Thoroughness**: Very thorough (4 parallel agents) **Agent Types Used**: Explore (documentation
discovery, installation audit, workflow verification, configuration audit) **Completion Date**:
2025-10-26T03:55:01+0000 **Branch**: main **Commit**: 62ac1a3 (refactor: rename hack/ to scripts/)
