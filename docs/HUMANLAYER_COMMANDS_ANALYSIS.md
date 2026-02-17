# HumanLayer Commands Deep Dive

Analysis of HumanLayer-specific commands to determine what's reusable for your workflow.

## Summary Recommendations

| Command                 | Copy?        | Reason                               |
| ----------------------- | ------------ | ------------------------------------ |
| `create_handoff.md`     | ✅ **YES**   | Universal context handoff pattern    |
| `resume_handoff.md`     | ✅ **YES**   | Resume from handoffs in new sessions |
| `linear.md`             | ⚠️ **ADAPT** | Useful workflow, needs customization |
| `ralph_*.md`            | ❌ NO        | Automation workflow, not manual      |
| `research_codebase*.md` | ❌ NO        | Duplicate of create_plan research    |
| `ci_*.md`               | ❌ NO        | CI-specific, use regular versions    |

---

## 1. Handoff Commands (HIGHLY RECOMMENDED!)

### `create_handoff.md` - **Copy This!**

**What it does**: Creates a structured handoff document to pass context to a new agent/session.

**Why it's perfect for you**:

- Solves your exact use case: "write a handoff document" → "clear context" → "resume later"
- Not HumanLayer-specific at all
- Stores handoffs in `thoughts/shared/handoffs/`
- Uses timestamped filenames: `YYYY-MM-DD_HH-MM-SS_description.md`

**Key sections**:

```markdown
## Task(s)

What you were working on + status

## Recent changes

File:line references to what you changed

## Learnings

Important discoveries, patterns, gotchas

## Artifacts

Paths to plans, research docs you created

## Action Items & Next Steps

What the next agent should do

## Other Notes

Codebase locations, references, etc.
```

**Workflow**:

```bash
# After working for a while
/catalyst-dev:create_handoff

# Clears context, starts new session
/catalyst-dev:resume_handoff thoughts/shared/handoffs/2025-01-08_15-30-22_feature-auth.md
```

### `resume_handoff.md` - **Copy This!**

**What it does**: Reads handoff, validates current state, creates action plan.

**Smart features**:

1. Spawns parallel research agents to verify:
   - Changes from handoff still exist
   - No regressions since handoff
   - Artifacts are still valid
2. Creates TodoWrite list from action items
3. Adapts to current state vs handoff state

**Usage patterns**:

```bash
# By path
/catalyst-dev:resume_handoff thoughts/shared/handoffs/ENG-123/2025-01-08_15-30-22.md

# By ticket (finds latest)
/catalyst-dev:resume_handoff ENG-123

# Interactive
/catalyst-dev:resume_handoff  # Shows menu
```

**Why it's brilliant**:

- Handles "stale handoffs" (codebase changed since handoff)
- Validates assumptions before continuing
- Picks up exactly where you left off

---

## 2. Linear Command - **Adapt for Your Use**

### What `linear.md` Does

**Core functionality**:

1. Create tickets from thoughts documents
2. Add comments/updates to tickets
3. Search for tickets
4. Update ticket status

**The Workflow** (This is the gem!):

```
1. Triage → New tickets
2. Spec Needed → Need more detail
3. Research Needed → Investigation required
4. Research in Progress → Active research
5. Research in Review → Review findings
6. Ready for Plan → Research complete
7. Plan in Progress → Writing implementation plan
8. Plan in Review → Plan under discussion
9. Ready for Dev → Plan approved
10. In Dev → Coding
11. Code Review → PR submitted
12. Done → Complete
```

**Key principle**: "Review and alignment happen at the plan stage (not PR stage)"

### What's HumanLayer-Specific

Remove these:

- `projectId: "M U L T I C L A U D E"` - Their project ID
- Label auto-assignment (hld, wui, meta) - Their codebase structure
- URL mapping to `github.com/humanlayer/thoughts` - Use your org

### What to Keep

1. **The workflow statuses** - Adapt to your team's workflow
2. **Thoughts → Ticket pattern** - Create tickets from research docs
3. **Link attachment** - Attach GitHub URLs to tickets
4. **Interactive creation** - Draft → Review → Create

### Adaptation Template

```markdown
# Linear - Ticket Management

## Your Workflow

1. **Backlog** → New ideas
2. **To Do** → Ready to start
3. **In Progress** → Active work
4. **In Review** → PR submitted
5. **Done** → Complete

## Creating Tickets from Thoughts

/catalyst-dev:linear create thoughts/shared/research/api-redesign.md

This will:

1. Read the thoughts document
2. Draft a ticket summary
3. Ask you to review
4. Create in Linear
5. Attach thoughts doc URL
```

**Recommendation**: Start simple, add workflow statuses as you define your process.

---

## 3. Ralph Commands - What is "Ralph"?

### The Ralph Workflow (Automated)

**Ralph = Automated ticket → plan → implement pipeline**

It's named after their process for:

1. **ralph_plan**: Auto-fetch Linear ticket → create plan → move to "Plan in Review"
2. **ralph_impl**: Auto-fetch ticket with plan → create worktree → launch implementation

**Why it exists**: Full automation from ticket to PR without human intervention.

**Example ralph_plan flow**:

```
1. Fetch top 10 priority tickets in "Ready for Spec"
2. Select highest priority SMALL/XS ticket
3. Read ticket + comments
4. Run /catalyst-dev:create_plan
5. Sync to thoughts
6. Attach to Linear
7. Move to "Plan in Review"
```

**Example ralph_impl flow**:

```
1. Fetch ticket in "Ready for Dev"
2. Find linked implementation plan
3. Create worktree
4. Launch Claude session with: "/implement_plan → commit → PR → comment on ticket"
```

### Should You Copy Ralph Commands?

**NO** - Here's why:

1. **It's automation, not manual commands**
   - Ralph fetches tickets automatically
   - You manually select what to work on

2. **It uses humanlayer launch**
   - Spawns new Claude sessions programmatically
   - You work interactively in one session

3. **Better alternative**: Use the base commands manually

   ```bash
   # Instead of ralph_plan, you do:
   # 1. Pick a ticket manually
   # 2. Run: /catalyst-dev:create_plan

   # Instead of ralph_impl, you do:
   # 1. Pick a planned ticket
   # 2. Run: /catalyst-dev:implement_plan thoughts/shared/plans/plan.md
   ```

**The lesson from Ralph**: Good workflow progression (research → plan → implement)

---

## 4. Research Codebase Commands

### What They Are

- `research_codebase.md` - General research command
- `research_codebase_generic.md` - Simplified version
- `research_codebase_nt.md` - "No thoughts" version (doesn't save to thoughts/)

### Why They're Duplicates

You already have this functionality in:

1. **Research agents** - `codebase-locator`, `codebase-analyzer`, `thoughts-locator`
2. **`/catalyst-dev:create_plan`** - Spawns research agents as part of planning

The `research_codebase` command is essentially:

```markdown
1. User asks research question
2. Spawn parallel research agents
3. Synthesize findings
4. Save to thoughts/shared/research/
```

**You already have this** - Just use your agents directly or within `/catalyst-dev:create_plan`.

---

## 5. CI Commands

### What They Do

- `ci_commit.md` - Commit command for CI environment
- `ci_describe_pr.md` - PR description for CI environment

### Differences from Regular Versions

**ci_commit.md**:

- Runs in CI with no interactive prompts
- Auto-commits without confirmation
- Designed for automated workflows

**ci_describe_pr.md**:

- Assumes PR already exists (created by CI)
- Skips interactive template selection
- Automated verification only

### Should You Copy These?

**NO** - Use the regular versions you already have:

- `/catalyst-dev:commit` - Interactive, better for manual work
- `/catalyst-dev:describe_pr` - Works for manual PR creation

If you ever need CI automation, create project-specific versions then.

---

## Recommended Actions

### 1. Copy Handoff Commands (High Priority!)

```bash
cd ~/code-repos/ryan-claude-workspace

# Copy handoff commands
cp ~/code-repos/humanlayer/.claude/commands/create_handoff.md commands/
cp ~/code-repos/humanlayer/.claude/commands/resume_handoff.md commands/

# Minor edit: Remove HumanLayer-specific script reference
# In create_handoff.md, remove or adapt:
#   - Run the `scripts/spec_metadata.sh` script (if it exists)
# Replace with:
#   - Get current git info for metadata
```

### 2. Adapt Linear Command (If Using Linear)

Create `commands/linear/linear.md` based on HumanLayer's but:

**Remove**:

- HumanLayer project IDs
- Specific label assignments (project-specific labels)
- URL mappings to humanlayer/thoughts

**Keep**:

- Create ticket from thoughts pattern
- Interactive ticket creation
- Link attachment to GitHub

**Customize**:

- Your workflow statuses
- Your project IDs
- Your org/repo URLs

### 3. Document Ralph Lessons

The Ralph workflow teaches:

- **Workflow progression**: Research → Plan → Implement
- **Automation potential**: Tickets can flow through stages
- **Context preservation**: Plans and research attached to tickets

Apply these principles manually:

1. Create plan for ticket
2. Attach plan to ticket
3. Implement from plan
4. Update ticket with PR

### 4. Ignore the Rest

- ❌ ralph\_\*.md - Not for manual use
- ❌ research_codebase\*.md - You have agents
- ❌ ci\_\*.md - Use regular versions

---

## Handoff Workflow Example

Here's how handoffs work in practice:

### Scenario: Working on Auth Feature

**Session 1** (2 hours of work):

```bash
# You've researched auth patterns, updated 5 files
# Getting tired, want to hand off

/catalyst-dev:create_handoff

# Creates: thoughts/shared/handoffs/2025-01-08_15-30-22_auth-implementation.md
# Contains:
# - What you accomplished
# - Files you changed (with line numbers)
# - Key learnings about the auth system
# - Next steps: "Complete OAuth provider integration"
```

**Session 2** (Fresh start):

```bash
/catalyst-dev:resume_handoff thoughts/shared/handoffs/2025-01-08_15-30-22_auth-implementation.md

# Claude:
# 1. Reads handoff completely
# 2. Verifies your changes still exist
# 3. Reads relevant files
# 4. Creates TodoWrite list:
#    - [ ] Complete OAuth provider integration
#    - [ ] Add tests for auth flow
#    - [ ] Update documentation
# 5. Ready to continue exactly where you left off!
```

### Benefits

✅ **No context loss** - All learnings preserved ✅ **Validates state** - Checks nothing broke since
handoff ✅ **Actionable** - Clear next steps ✅ **Searchable** - All handoffs in
thoughts/shared/handoffs/ ✅ **Version controlled** - Part of thoughts repo

---

## Linear Workflow Example

If you adapt the Linear command:

### Creating Ticket from Research

```bash
# You did research, saved to thoughts
/catalyst-dev:linear create thoughts/shared/research/api-redesign.md

# Claude:
# 1. Reads research doc
# 2. Drafts ticket:
#    Title: Redesign API authentication
#    Description: Summary of research findings
#    Status: Backlog
# 3. Shows you draft
# 4. You approve
# 5. Creates in Linear
# 6. Attaches GitHub URL to research doc
```

### Workflow Progression

```markdown
# Natural flow:

Backlog → Research → Plan → Implement → Review → Done

# With commands:

1. Ticket created (Backlog)
2. /catalyst-dev:research_codebase "auth patterns" → Save to thoughts/shared/research/ → Attach to ticket → Move
   to "Plan"
3. /catalyst-dev:create_plan (reads research) → Save to thoughts/shared/plans/ → Attach to ticket → Move to
   "Ready"
4. /catalyst-dev:implement_plan thoughts/shared/plans/auth-plan.md → Move to "In Progress"
5. /catalyst-dev:commit + /catalyst-dev:describe_pr → Move to "Review"
```

---

## Summary

### ✅ Definitely Copy

1. **create_handoff.md** - Context preservation for session changes
2. **resume_handoff.md** - Smart handoff resumption

### ⚠️ Consider Adapting

3. **linear.md** - If you use Linear, customize it for your workflow

### ❌ Don't Copy

4. **ralph\_\*.md** - Automation workflow, not manual commands
5. **research_codebase\*.md** - Redundant with your agents
6. **ci\_\*.md** - Use regular versions

### 💡 Key Takeaways

**From Handoffs**: Context handoff is crucial for long tasks **From Ralph**: Good workflow
progression (research → plan → implement) **From Linear**: Attach artifacts (research, plans) to
tickets

Your setup with agents + commands + thoughts is already excellent. Adding handoffs makes it
complete!
