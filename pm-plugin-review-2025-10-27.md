# PM Plugin Review & Recommendations
**Date:** 2025-10-27
**Context:** Post-Phase 1 implementation review

---

## 1. New Linearis Capabilities Analysis

### ✨ NEW: Project Milestone Support

Linearis now supports full project milestone management:

**Commands Available:**
- `linearis projectMilestones create <name>` - Create milestones
  - Options: `--project`, `--description`, `--target-date`
- `linearis projectMilestones list` - List milestones in a project
  - Options: `--project`, `--limit`
- `linearis projectMilestones read <milestoneIdOrName>` - Get milestone details with issues
  - Options: `--project`, `--issues-first`
- `linearis projectMilestones update <milestoneIdOrName>` - Update milestone
  - Options: `--project`, `--name`, `--description`, `--target-date`, `--sort-order`

**Enhanced Issue Management:**
- `issues create` now supports `--project-milestone <milestone>`
- `issues update` now supports:
  - `--project-milestone <milestone>` - Assign to milestone
  - `--clear-project-milestone` - Remove milestone assignment

### 🎯 Opportunities for PM Plugin

**New Command Ideas:**
1. **`analyze_milestone`** - Milestone health report (similar to cycle health)
   - Track progress toward target date
   - Identify blocked/at-risk issues in milestone
   - Compare planned vs actual completion
   - Generate milestone status summary

2. **`compare_milestones`** - Cross-milestone analysis
   - Compare velocity across milestones
   - Identify bottlenecks affecting multiple milestones
   - Track dependencies between milestones

3. **`sync_roadmap`** - Roadmap-level planning
   - List all milestones across projects
   - Identify timeline conflicts
   - Generate executive roadmap view

**New Agent Ideas:**
1. **`milestone-analyzer`** - Deep milestone health analysis
   - Similar to cycle-analyzer but for milestones
   - Progress tracking, risk identification
   - Target date feasibility assessment

2. **`linear-research`** - General Linear data gathering
   - Fetch tickets, cycles, milestones, projects
   - Could be used by multiple commands
   - **Model: Haiku** (data gathering only)

---

## 2. Agent Naming Pattern Analysis

### Current Dev Plugin Patterns

**Pattern 1: Locator Agents** (Find WHERE)
- `codebase-locator` - Finds relevant files/directories
- `thoughts-locator` - Finds relevant thought documents
- **Tools:** Grep, Glob, Bash(ls)
- **Model:** `inherit`
- **Purpose:** Location discovery only

**Pattern 2: Analyzer Agents** (Explain HOW/WHY)
- `codebase-analyzer` - Deep code analysis and explanation
- `thoughts-analyzer` - Analyzes thought content
- **Tools:** Read, Grep, Glob, + MCP tools
- **Model:** `inherit`
- **Purpose:** Deep analysis and insights

**Pattern 3: Research Agents** (Gather WHAT)
- `linear-research` - Gathers Linear data via CLI
- `github-research` - Gathers GitHub data
- `railway-research` - Gathers Railway data
- `sentry-research` - Gathers Sentry data
- `external-research` - Gathers external documentation
- **Tools:** Bash(CLI tools), Read, Grep
- **Model:** `inherit`
- **Purpose:** Data collection from external systems

**Pattern 4: Specialist Agents**
- `codebase-pattern-finder` - Finds recurring patterns

### Current PM Plugin Agents - MISALIGNED

| Current Name | What It Does | Should Be | Reasoning |
|--------------|--------------|-----------|-----------|
| `cycle-analyzer` | ✅ Analyzes cycle health, generates insights | ✅ `cycle-analyzer` | Correct - deep analysis |
| `backlog-groomer` | ❌ Analyzes backlog, categorizes, detects issues | `backlog-analyzer` | Does analysis, not just grooming |
| `pr-correlator` | ❌ Analyzes PR-issue relationships | `pr-sync-analyzer` or `github-linear-analyzer` | Does analysis, not just correlation |

### Recommended Agent Naming Changes

**Keep:**
- ✅ `cycle-analyzer.md` - Already correct

**Rename:**
- ❌ `backlog-groomer.md` → ✅ `backlog-analyzer.md`
  - Justification: Performs analysis (categorization, staleness detection, duplicate detection)

- ❌ `pr-correlator.md` → ✅ `github-linear-analyzer.md`
  - Justification: Analyzes relationship between GitHub PRs and Linear issues
  - Alternative: `pr-sync-analyzer.md` (shorter, clearer purpose)

**Add New (for milestone support):**
- ✅ `milestone-analyzer.md` - Analyzes milestone health (similar to cycle-analyzer)
- ✅ `linear-research.md` - Generic Linear data gathering agent
  - **Model: haiku** (research task, save quota)
  - Could replace inline linearis calls in commands

---

## 3. Model Specification Strategy

### Current State
- All PM agents: `model: sonnet` (hardcoded)
- All dev agents: `model: inherit` (uses parent command's model)

### Recommended Strategy

**Research Agents → Haiku 4.5**
- Purpose: Data gathering only, no complex analysis
- Benefits: Faster, cheaper, saves quota
- Examples:
  - `linear-research` - Fetch Linear data via CLI
  - Future: `github-research`, `project-research`

**Locator Agents → Haiku 4.5**
- Purpose: Finding files/locations, simple pattern matching
- Benefits: Faster search operations
- Examples:
  - `codebase-locator`, `thoughts-locator` (in dev plugin)

**Analyzer Agents → Sonnet 4.5**
- Purpose: Deep analysis, insight generation, recommendations
- Benefits: Better reasoning for complex analysis
- Examples:
  - `cycle-analyzer`
  - `backlog-analyzer` (renamed from backlog-groomer)
  - `github-linear-analyzer` (renamed from pr-correlator)
  - `milestone-analyzer` (new)

### Specific Changes Needed

**PM Plugin Agents:**
```yaml
# cycle-analyzer.md
model: sonnet  # ✅ Keep - needs deep analysis

# backlog-analyzer.md (rename from backlog-groomer.md)
model: sonnet  # ✅ Keep - needs deep analysis

# github-linear-analyzer.md (rename from pr-correlator.md)
model: sonnet  # ✅ Keep - needs deep analysis

# linear-research.md (NEW)
model: haiku  # ✅ New - data gathering only
```

**Note:** Using `model: inherit` vs hardcoded
- **Pros of `inherit`:** Commands can choose model per invocation
- **Cons of `inherit`:** Less explicit, harder to understand agent capabilities
- **Recommendation:** For PM plugin, use explicit models (easier to understand intent)

---

## 4. Command Naming Convention Analysis

### Dev Plugin Command Patterns

**Verb-Noun Pattern (Preferred):**
- `create_plan` - Create a plan
- `create_pr` - Create pull request
- `create_worktree` - Create git worktree
- `create_handoff` - Create handoff document
- `research_codebase` - Research the codebase
- `implement_plan` - Implement a plan
- `validate_plan` - Validate a plan
- `describe_pr` - Describe pull request
- `merge_pr` - Merge pull request
- `resume_handoff` - Resume from handoff

**Other Patterns:**
- `commit` - Single verb (clear action)
- `debug` - Single verb (clear action)
- `linear` - Single noun (tool access)
- `workflow_help` - Compound noun
- `cycle_plan`, `cycle_review`, `roadmap_review` - Status/report commands

### Current PM Plugin Commands - MISALIGNED

| Current Name | Pattern | Should Be | Reasoning |
|--------------|---------|-----------|-----------|
| `cycle_status` | ❌ Noun-noun | `analyze_cycle` | Verb-noun: analyzes cycle health |
| `team_daily` | ❌ Noun-adjective | `report_daily` or `check_team` | Verb-noun: generates daily report |
| `backlog_groom` | ✅ Noun-verb | `groom_backlog` | ✅ Verb-noun (just reorder) |
| `pr_sync` | ❌ Noun-verb | `sync_prs` | Verb-noun: syncs PRs with Linear |

### Recommended Command Naming Changes

**Phase 1 Commands (Rename):**
1. ❌ `cycle_status.md` → ✅ `analyze_cycle.md`
   - Action: Analyzes cycle health, generates report
   - Aligns with: `analyze_milestone` (future)

2. ❌ `team_daily.md` → ✅ `report_daily.md`
   - Action: Generates daily status report
   - Alternative: `check_team.md` (shorter)
   - Aligns with: `report_weekly`, `report_milestone`

3. ❌ `backlog_groom.md` → ✅ `groom_backlog.md`
   - Action: Grooms/analyzes backlog
   - Just reorder to verb-noun

4. ❌ `pr_sync.md` → ✅ `sync_prs.md`
   - Action: Syncs GitHub PRs with Linear
   - Aligns with: `sync_roadmap` (future)

**Future Commands (New):**
- ✅ `analyze_milestone.md` - Analyze milestone health
- ✅ `sync_roadmap.md` - Sync roadmap across projects
- ✅ `report_weekly.md` - Weekly team report (if different from daily)
- ✅ `compare_milestones.md` - Cross-milestone comparison

**Phase 2 Command (Client Reporting):**
- From plan: `client_report.md` → ✅ `generate_client_report.md`
  - Verb-noun pattern
  - Clear that it's generating/creating a report

---

## 5. Agent vs Command Responsibility

### Pattern Analysis from Dev Plugin

**Commands:**
- Orchestrate workflows (spawn agents, format output)
- Handle user interaction (prompts, confirmations)
- Manage file I/O (save reports to thoughts/)
- Update workflow context
- **Do NOT** contain complex analysis logic

**Agents:**
- Focused, specialized tasks
- Pure input → output transformation
- No user interaction
- No file I/O (except reading for analysis)
- Return structured data to commands

### Current PM Plugin - Well Structured ✅

**Commands correctly orchestrate:**
- `cycle_status` - Fetches data, spawns `cycle-analyzer`, formats report
- `team_daily` - Fetches data, generates simple report (no agent needed)
- `backlog_groom` - Fetches data, spawns `backlog-groomer`, generates recommendations
- `pr_sync` - Fetches data, spawns `pr-correlator`, generates report

**Agents correctly specialize:**
- `cycle-analyzer` - Pure analysis: cycle data → health report
- `backlog-groomer` - Pure analysis: backlog issues → categorization + recommendations
- `pr-correlator` - Pure analysis: PR + issue data → correlation report

**No changes needed to structure** - already well separated!

---

## 6. Summary of Recommended Changes

### A. New Capabilities to Add

**Priority 1: Milestone Support**
1. Add `analyze_milestone.md` command
2. Add `milestone-analyzer.md` agent (model: sonnet)
3. Update existing commands to support `--milestone` flag (optional)

**Priority 2: Generic Linear Research Agent**
1. Create `linear-research.md` agent (model: haiku)
2. Use it in commands instead of inline `linearis` calls
3. Enables better testing and reuse

**Priority 3: Roadmap Features** (Future)
1. Add `sync_roadmap.md` command
2. Add `compare_milestones.md` command

### B. Renaming for Consistency

**Agents:**
| Current | New | Reason |
|---------|-----|--------|
| `backlog-groomer.md` | `backlog-analyzer.md` | Aligns with analyzer pattern |
| `pr-correlator.md` | `github-linear-analyzer.md` | Aligns with analyzer pattern |
| - | `milestone-analyzer.md` (NEW) | Milestone health analysis |
| - | `linear-research.md` (NEW) | Data gathering agent |

**Commands:**
| Current | New | Reason |
|---------|-----|--------|
| `cycle_status.md` | `analyze_cycle.md` | Verb-noun pattern |
| `team_daily.md` | `report_daily.md` | Verb-noun pattern |
| `backlog_groom.md` | `groom_backlog.md` | Verb-noun pattern (reorder) |
| `pr_sync.md` | `sync_prs.md` | Verb-noun pattern |

**Plugin Manifest (`plugin.json`):**
- Update all command and agent paths to match new names

### C. Model Specifications

**Update frontmatter:**
```yaml
# Analyzer agents (keep Sonnet)
---
model: sonnet
---

# Research agents (use Haiku)
---
model: haiku
---
```

**Specific agents:**
- `cycle-analyzer.md` → `model: sonnet` ✅ (no change)
- `backlog-analyzer.md` → `model: sonnet` ✅ (no change)
- `github-linear-analyzer.md` → `model: sonnet` ✅ (no change)
- `milestone-analyzer.md` (NEW) → `model: sonnet`
- `linear-research.md` (NEW) → `model: haiku`

### D. Documentation Updates

**Files to update:**
1. `plugins/pm/README.md` - Update command list with new names
2. `plugins/pm/.claude-plugin/plugin.json` - Update paths
3. `CLAUDE.md` - Update PM plugin command examples
4. `README.md` - Update PM plugin command examples

---

## 7. Implementation Checklist

### Phase 1: Renaming (No New Features)
- [ ] Rename `backlog-groomer.md` → `backlog-analyzer.md`
- [ ] Rename `pr-correlator.md` → `github-linear-analyzer.md`
- [ ] Rename `cycle_status.md` → `analyze_cycle.md`
- [ ] Rename `team_daily.md` → `report_daily.md`
- [ ] Rename `backlog_groom.md` → `groom_backlog.md`
- [ ] Rename `pr_sync.md` → `sync_prs.md`
- [ ] Update `plugin.json` with new paths
- [ ] Update internal references in commands
- [ ] Update documentation (README.md, CLAUDE.md)
- [ ] Test that renamed commands/agents work

### Phase 2: Milestone Support (New Features)
- [ ] Create `linear-research.md` agent (model: haiku)
- [ ] Create `milestone-analyzer.md` agent (model: sonnet)
- [ ] Create `analyze_milestone.md` command
- [ ] Update `plugin.json` to include new files
- [ ] Document milestone commands in README
- [ ] Test milestone analysis workflow

### Phase 3: Advanced Roadmap Features (Future)
- [ ] Create `sync_roadmap.md` command
- [ ] Create `compare_milestones.md` command
- [ ] Update documentation

---

## 8. Questions for Clarification

### Naming Decisions

**Q1: Command renaming - which verb for daily reports?**
- Option A: `report_daily.md` (clearer - generates a report)
- Option B: `check_team.md` (shorter - checks team status)
- **Recommendation:** `report_daily.md` (aligns with `report_weekly` if we add it)

**Q2: PR correlation agent name?**
- Option A: `github-linear-analyzer.md` (shows what it analyzes)
- Option B: `pr-sync-analyzer.md` (matches command purpose)
- **Recommendation:** `github-linear-analyzer.md` (broader, could analyze more than just PRs)

**Q3: Should we add a general `linear-research` agent now or later?**
- **Recommendation:** Add now - makes commands cleaner, easier to test

### Model Strategy

**Q4: Use `inherit` or explicit model names?**
- Dev plugin uses `inherit` (command controls model)
- Explicit models make intent clearer
- **Recommendation:** Explicit models for PM plugin (easier to understand)

**Q5: Are there any analyzer agents that could use Haiku?**
- All current analyzers need Sonnet for complex reasoning
- **Recommendation:** Keep all analyzers as Sonnet

### Priority

**Q6: Should we do renaming first or add milestone support first?**
- Option A: Rename everything, then add features (clean slate)
- Option B: Add milestone support with new names (both at once)
- **Recommendation:** Option A - rename first, then add features

---

## 9. Next Steps

### Immediate (Today)
1. Review this document with user
2. Get approval on naming decisions
3. Get approval on priorities

### This Week
1. Execute Phase 1 (renaming)
2. Execute Phase 2 (milestone support)
3. Test all commands end-to-end

### Future
1. Gather user feedback on milestone commands
2. Consider Phase 3 (roadmap features)
3. Consider Phase 2 from original plan (client reporting)

---

**End of Review Document**
