# Best Practices Guide

A guide to effective patterns based on Anthropic's context engineering principles and battle-tested
workflows.

## Table of Contents

- [Core Principles](#core-principles)
- [Agent Usage Patterns](#agent-usage-patterns)
- [Planning Best Practices](#planning-best-practices)
- [Implementation Strategies](#implementation-strategies)
- [Thoughts Organization](#thoughts-organization)
- [Team Collaboration](#team-collaboration)
- [Worktree Workflow](#worktree-workflow)
- [Anti-Patterns to Avoid](#anti-patterns-to-avoid)

---

## Core Principles

These principles are derived from Anthropic's context engineering article and proven through
real-world usage.

### 1. Context is Precious

**Principle**: Treat context window as a scarce resource. Load only what's needed, when it's needed.

**Why it matters:**

- LLMs have limited context windows
- Irrelevant information degrades performance
- Focused context produces better results

**How to apply:**

**Good - Focused Loading:**

```
# Load only the specific file needed
Read the authentication handler at src/auth/handler.js
```

**Bad - Over-Loading:**

```
# Reads entire directory tree unnecessarily
Read all files in src/
```

**Good - Just-in-Time:**

```
@catalyst-dev:codebase-locator find authentication files
# Then read only the relevant ones
```

**Bad - Preemptive Loading:**

```
Read all these files in case we need them later:
[long list of files]
```

### 2. Just-in-Time Loading

**Principle**: Load context dynamically as needed, not upfront.

**Why it matters:**

- You don't know what you need until you explore
- Upfront loading often misses the right files
- Dynamic loading follows actual code paths

**Pattern:**

1. Start with broad search (codebase-locator)
2. Identify relevant files
3. Read specific files
4. Follow references to related code
5. Load additional context as needed

**Example:**

```
# Step 1: Locate
@catalyst-dev:codebase-locator find rate limiting code

# Step 2: Analyze what was found
@catalyst-dev:codebase-analyzer explain how rate limiting works in src/middleware/rate-limit.js

# Step 3: Load related code as discovered
# Agent identifies dependency on Redis
Read src/cache/redis-client.js

# Step 4: Continue following the path
```

### 3. Sub-Agent Architecture

**Principle**: Use parallel, focused agents instead of monolithic analysis.

**Why it matters:**

- Focused agents are more accurate
- Parallel execution is faster
- Specialized tools restrict scope (preventing over-exploration)
- Each agent has clear, limited responsibility

**Good - Parallel Specialists:**

```
# Spawn multiple focused agents
@catalyst-dev:codebase-locator find payment files
@catalyst-dev:thoughts-locator search payment research
@catalyst-dev:codebase-pattern-finder show payment patterns
```

**Bad - Monolithic:**

```
# Single agent with too much responsibility
@catalyst-dev:research everything about payments including files, history, patterns, and implementation
```

**Benefits of Sub-Agents:**

- **Tool Restrictions**: Each agent has specific tools (read-only, no edits)
- **Clear Scope**: Bounded responsibility prevents scope creep
- **Parallel Execution**: Faster than sequential
- **Composable**: Mix and match agents as needed

### 4. Structured Persistence

**Principle**: Save context outside the conversation window for reuse.

**Why it matters:**

- Conversations are ephemeral
- Context is expensive to rebuild
- Persistent context enables compaction

**Implementation:**

- **Thoughts Directory**: Persistent, searchable, version-controlled
- **Plans**: Detailed specifications that survive conversation resets
- **Research Documents**: Reusable findings
- **Ticket Analysis**: Deep context that persists

**Pattern:**

```
# Research phase (expensive)
@catalyst-dev:codebase-analyzer deeply analyze authentication system
@catalyst-dev:thoughts-locator find past auth decisions

# Save findings (persistence)
Write comprehensive analysis to thoughts/shared/research/auth_system.md

# Later conversation (cheap)
Read thoughts/shared/research/auth_system.md
# Instant context recovery without re-research
```

### 5. Progressive Context Discovery

**Principle**: Start broad, narrow down progressively.

**Why it matters:**

- You don't know what you don't know
- Premature specificity misses important context
- Progressive refinement follows natural investigation

**Pattern:**

```
# Level 1: Broad search
@catalyst-dev:codebase-locator find all webhook code

# Level 2: Categorical understanding
# Based on results, focus on specific areas
@catalyst-dev:codebase-analyzer explain webhook validation in src/webhooks/validator.js

# Level 3: Deep dive
# Follow specific code path discovered
Read src/utils/crypto.js  # Discovered during analysis

# Level 4: Related context
@catalyst-dev:thoughts-locator find any webhook issues
```

---

## Agent Usage Patterns

### When to Use Which Agent

**codebase-locator** - "Where is X?"

- Finding files by topic
- Discovering test locations
- Mapping directory structure
- Initial exploration

**codebase-analyzer** - "How does X work?"

- Understanding implementation
- Tracing data flow
- Identifying integration points
- Learning code patterns

**codebase-pattern-finder** - "Show me examples of X"

- Finding similar implementations
- Discovering coding conventions
- Locating test patterns
- Understanding common approaches

**thoughts-locator** - "What do we know about X?"

- Finding past research
- Locating related tickets
- Discovering existing plans
- Searching historical context

**thoughts-analyzer** - "What were the key decisions about X?"

- Extracting decisions from research
- Understanding trade-offs
- Finding technical specifications
- Validating current relevance

### Parallel vs Sequential Agent Usage

**Use Parallel When:**

- Researching independent aspects
- Gathering comprehensive context
- Exploring multiple options
- Initial discovery phase

**Example:**

```
# All independent, spawn together
@catalyst-dev:codebase-locator find database migration files
@catalyst-dev:thoughts-locator search for database decisions
@catalyst-dev:codebase-pattern-finder show migration patterns
```

**Use Sequential When:**

- Second agent depends on first's results
- Following a specific code path
- Drilling into findings
- Refining from broad to specific

**Example:**

```
# Step 1
@catalyst-dev:codebase-locator find rate limiting code

# Wait for results, then step 2
@catalyst-dev:codebase-analyzer analyze the rate limiting middleware at [path from step 1]

# Wait for results, then step 3
Read the Redis client used by the middleware
```

### Writing Effective Agent Requests

**Be Specific:**

Good:

```
@catalyst-dev:codebase-analyzer trace how a webhook request flows from receipt to database storage
```

Bad:

```
@catalyst-dev:codebase-analyzer look at webhooks
```

**Include Context:**

Good:

```
@catalyst-dev:codebase-locator find all files related to user authentication in the API service, focusing on JWT token handling
```

Bad:

```
@catalyst-dev:codebase-locator find auth stuff
```

**Specify What You Need:**

Good:

```
@catalyst-dev:codebase-pattern-finder show me examples of pagination with cursor-based approaches, including test patterns
```

Bad:

```
@catalyst-dev:codebase-pattern-finder pagination
```

---

## Planning Best Practices

### Plan Structure

**Always Include:**

1. **Overview** - What and why
2. **Current State Analysis** - What exists now
3. **Desired End State** - Clear success definition
4. **What We're NOT Doing** - Explicit scope control
5. **Phases** - Logical, incremental steps
6. **Success Criteria** - Separated: automated vs manual
7. **References** - Links to tickets, research, similar code

**Phase Guidelines:**

**Good Phase:**

```markdown
## Phase 1: Database Schema

### Overview

Add rate_limits table to track user quotas

### Changes Required

- Migration adds table with user_id, limit, window_seconds
- Add index on (user_id, created_at)
- Add foreign key to users table

### Success Criteria

#### Automated Verification

- [ ] Migration runs: `make migrate`
- [ ] Schema matches spec: `make db-verify-schema`
- [ ] Tests pass: `make test-db`

#### Manual Verification

- [ ] Can insert rate limit records
- [ ] Foreign key constraint works
- [ ] Index improves query performance
```

**Bad Phase:**

```markdown
## Phase 1: Setup

Do database stuff and API stuff

### Success Criteria

- [ ] It works
```

### Separating Automated vs Manual Verification

**Automated Verification:**

- Can be run by execution agents
- Deterministic pass/fail
- No human judgment required
- Examples: tests, linting, compilation, specific curl commands

**Manual Verification:**

- Requires human testing
- Subjective assessment (UX, performance)
- Visual or behavioral checks
- Edge cases hard to automate

**Good Separation:**

```markdown
### Success Criteria

#### Automated Verification

- [ ] Unit tests pass: `make test-unit`
- [ ] Integration tests pass: `make test-integration`
- [ ] Type checking passes: `npm run typecheck`
- [ ] API returns 429 on exceeded limit:
      `curl -X POST http://localhost:8080/api/test -H "X-Test: rate-limit-exceeded"`

#### Manual Verification

- [ ] Error message is user-friendly when rate limit hit
- [ ] UI shows helpful retry-after timer
- [ ] Performance is acceptable with 10,000 requests
- [ ] Mobile app handles 429 gracefully
```

**Bad Mixing:**

```markdown
### Success Criteria

- [ ] Tests pass
- [ ] Looks good
- [ ] No bugs
- [ ] Works in production
```

### Scope Control

**Always Explicitly State What's NOT Being Done:**

```markdown
## What We're NOT Doing

- Not implementing per-endpoint rate limits (global only)
- Not adding rate limit dashboard/UI (tracking only)
- Not handling distributed rate limiting across regions
- Not implementing IP-based rate limiting (user-based only)
- Not adding rate limit configuration UI (code config only)
```

**Why this matters:**

- Prevents scope creep
- Clarifies boundaries
- Enables faster delivery
- Makes follow-up tickets clear

### No Open Questions in Final Plans

**Bad Plan (with open questions):**

```markdown
## Phase 2: API Implementation

### Changes Required

- Add rate limiting middleware
- Use Redis or maybe in-memory? Need to decide.
- Return 429 status code
- Not sure if we should include retry-after header?
```

**Good Plan (all decisions made):**

```markdown
## Phase 2: API Implementation

### Changes Required

- Add rate limiting middleware using Redis
  - Rationale: Need to work across multiple instances
  - Alternative in-memory rejected due to multi-instance deployment
- Return 429 status code with retry-after header
  - Standard practice, helps clients implement backoff
```

**Process:** If you have open questions during planning:

1. STOP writing the plan
2. Research the question (spawn agents, ask user)
3. Make the decision
4. Document decision and rationale
5. Continue planning

---

## Implementation Strategies

### Follow the Plan's Intent, Not Letter

Plans are guides, not rigid scripts. Reality may differ:

**When to Adapt:**

- File has been moved since plan was written
- Better pattern discovered in codebase
- Configuration has changed
- Dependencies updated

**When to Stop and Ask:**

- Core approach no longer makes sense
- Significant architectural mismatch
- Security or correctness concern
- Scope impact

**How to Handle:**

```
Issue in Phase 2:
Expected: Configuration in config/auth.json
Found: Configuration now uses environment variables (ENV_AUTH_SECRET)
Why this matters: Plan assumes JSON editing, but env vars are standard here

Adaptation: Will use env vars following codebase convention
Updating plan approach while maintaining same outcome.
```

### Incremental Verification

**Don't wait until the end to verify:**

**Good - Incremental:**

```
Phase 1: Database schema
[implement]
[run: make migrate && make test-db]
[fix any issues]
[mark phase complete]

Phase 2: API endpoints
[implement]
[run: make test-api]
[fix any issues]
[mark phase complete]
```

**Bad - Deferred:**

```
Phase 1: Database schema
[implement]

Phase 2: API endpoints
[implement]

Phase 3: Tests
[implement]

[run all tests]
[discover phase 1 was broken]
[waste time debugging]
```

### Update Progress as You Go

**Use Checkboxes:**

```markdown
## Phase 1: Database Schema

### Changes Required

- [x] Add migration file
- [x] Add table definition
- [ ] Add indexes
- [ ] Add foreign keys

### Success Criteria

- [x] Migration runs: `make migrate`
- [ ] Schema verified: `make db-verify-schema`
```

**Benefits:**

- Clear progress tracking
- Easy to resume if interrupted
- Documents what's complete
- Helps validation later

---

## Thoughts Organization

### Naming Conventions

**Plans:**

```
Format: YYYY-MM-DD-ENG-XXXX-description.md
Examples:
  thoughts/shared/plans/2025-01-08-ENG-1234-rate-limiting.md
  thoughts/shared/plans/2025-01-09-improve-error-handling.md (no ticket)
```

**Research Documents:**

```
Format: YYYY-MM-DD_topic.md or topic.md
Examples:
  thoughts/shared/research/2025-01-08_authentication_approaches.md
  thoughts/shared/research/database_patterns.md
  thoughts/shared/research/performance_optimization.md
```

**Tickets:**

```
Format: eng_XXXX.md or ticket_description.md
Examples:
  thoughts/shared/tickets/eng_1234.md
  thoughts/ryan/tickets/eng_1234_my_research.md
```

**PR Descriptions:**

```
Format: pr_XXXX_description.md
Examples:
  thoughts/shared/prs/pr_456_rate_limiting.md
  thoughts/shared/prs/pr_457_fix_auth_bug.md
```

### Personal vs Shared Guidelines

**Use Personal (`thoughts/{your_name}/`) For:**

- Rough exploration and learning
- Private TODOs
- Incomplete research
- Personal notes on tickets
- Experimental ideas
- Learning notes

**Use Shared (`thoughts/shared/`) For:**

- Finalized implementation plans
- Completed research
- Architectural decisions
- Team-relevant ticket analysis
- PR descriptions
- Patterns and conventions

**Example Workflow:**

```bash
# Start in personal
echo "Exploring auth options..." > thoughts/ryan/notes/auth_exploration.md

# Research and refine in personal
[investigate, experiment, learn]

# Move polished insights to shared
cat > thoughts/shared/research/2025-01-08_auth_decision.md << 'EOF'
# Authentication Approach Decision

## Options Evaluated
[Clean, actionable summary]

## Decision: JWT with RS256
[Rationale, trade-offs, implementation notes]
EOF
```

### When to Create New Documents

**Create a New Plan When:**

- Starting a new feature
- Major refactoring effort
- Complex bug fix requiring multiple phases
- Migration or upgrade task

**Create a New Research Doc When:**

- Evaluating multiple options
- Investigating architectural patterns
- Analyzing performance issues
- Documenting critical decisions

**Add to Existing Doc When:**

- Updating based on new findings
- Adding implementation notes to existing plan
- Documenting progress on ongoing research
- Appending related decisions

### Thoughts Syncing Cadence

**Sync After:**

- Creating or updating plans
- Completing research
- Finishing implementation (before PR)
- Making architectural decisions

**Command:**

```bash
humanlayer thoughts sync

# Or manually
cd ~/thoughts
git add .
git commit -m "Update research and plans for ENG-1234"
git push
```

**Automate with Git Hooks:**

```bash
# .git/hooks/post-commit
#!/bin/bash
cd ~/thoughts && git add . && git commit -m "Auto-sync $(date)" || true
```

---

## Team Collaboration

### Shared Thoughts Repository

**Setup:**

```bash
# Initialize central thoughts repo
cd ~/thoughts
git remote add origin <team-thoughts-repo-url>
git push -u origin main

# Team members clone
git clone <team-thoughts-repo-url> ~/thoughts
```

**Benefits:**

- Shared context across team
- No duplicated research
- Consistent patterns
- Historical knowledge preserved

### Pull Before Planning

**Pattern:**

```bash
# Before starting new work
cd ~/thoughts
git pull

# Now your planning includes latest team knowledge
/catalyst-dev:create_plan thoughts/shared/tickets/eng_1234.md
```

### Collaborative Research

**Developer A:**

```bash
# Research authentication options
cat > thoughts/shared/research/2025-01-08_auth_options.md << 'EOF'
# Authentication Options

## JWT vs Sessions

[Detailed analysis]

## Recommendation: JWT
[Rationale]

## Open Questions
- Token rotation strategy?
- Refresh token storage?
EOF

humanlayer thoughts sync
```

**Developer B:**

```bash
# Pull latest
humanlayer thoughts sync

# Add findings to same doc
cat >> thoughts/shared/research/2025-01-08_auth_options.md << 'EOF'

## Token Rotation Strategy

[Research on rotation approaches]

## Recommendation: Sliding expiration
[Details]
EOF

humanlayer thoughts sync
```

**Result**: Collaborative, incremental knowledge building.

### Ticket Ownership Patterns

**Personal Tickets:**

```
thoughts/ryan/tickets/eng_1234.md
- Personal research and notes
- Not shared with team
- Your workspace for exploration
```

**Shared Tickets:**

```
thoughts/shared/tickets/eng_1234.md
- Team-visible analysis
- Detailed requirements breakdown
- Shared context for implementation
```

**Pattern:**

```bash
# Start in personal
echo "Initial research..." > thoughts/ryan/tickets/eng_1234.md

# Refine and understand deeply
[research, explore]

# Create shared version with polished analysis
cat > thoughts/shared/tickets/eng_1234.md << 'EOF'
# ENG-1234: Rate Limiting

## Requirements Analysis
[Clean, comprehensive breakdown]

## Implementation Considerations
[Key findings from research]

## Technical Approach
[Recommended approach]
EOF
```

### PR Description Sharing

**Pattern:**

```bash
# After implementation
cat > thoughts/shared/prs/pr_456_rate_limiting.md << 'EOF'
# PR #456: Implement Rate Limiting

## Summary
- Adds Redis-based rate limiting
- 100 req/min anonymous, 1000 req/min authenticated
- Returns 429 with retry-after header

## Implementation
- Phase 1: Database schema (migration 012)
- Phase 2: Middleware (src/middleware/rate-limit.js)
- Phase 3: Tests (tests/middleware/rate-limit.test.js)

## Testing
- Unit tests: 15 new tests
- Integration tests: E2E rate limit scenarios
- Manual testing: Verified with curl scripts

## References
- Plan: thoughts/shared/plans/2025-01-08-ENG-1234-rate-limiting.md
- Ticket: thoughts/shared/tickets/eng_1234.md
EOF

humanlayer thoughts sync
```

Team members can reference this in future work.

---

## Worktree Workflow

### When to Use Worktrees

**Use Worktrees When:**

- Working on large, long-running features
- Need to switch context frequently
- Want to keep main branch clean
- Developing multiple features in parallel
- Want isolated testing environments

**Don't Use Worktrees When:**

- Small, quick fixes
- Single feature at a time
- Short-lived branches
- Frequent merging to main

### Worktree Organization

**Recommended Structure:**

```
~/wt/{repo-name}/{feature-name}/

Examples:
~/wt/my-api/rate-limiting/
~/wt/my-api/authentication/
~/wt/my-api/user-settings/
```

**Benefits:**

- Clear organization
- Easy to find worktrees
- Matches feature naming
- Consistent paths

### Sharing Context Across Worktrees

**Thoughts Directory:** All worktrees share the same thoughts directory via symlink.

**Automatic Sharing:**

```
Main Repo: ~/projects/my-api/thoughts/
Worktree 1: ~/wt/my-api/rate-limiting/thoughts/
Worktree 2: ~/wt/my-api/auth/thoughts/

# All three point to:
~/thoughts/repos/my-api/
```

**Result:**

- Plans created in one worktree visible in all others
- Research shared automatically
- No duplicate context
- Seamless collaboration

### Agents in Worktrees

**.claude/ Directory:**

Option 1: Copy (default behavior of create-worktree.sh)

```
Main Repo: ~/projects/my-api/.claude/
Worktree:   ~/wt/my-api/feature/.claude/ (copied)
```

Option 2: Symlink (for shared agent updates)

```bash
# In worktree
rm -rf .claude
ln -s ~/projects/my-api/.claude .claude
```

**Trade-offs:**

- Copy: Worktree independence, no accidental changes
- Symlink: Agent updates apply everywhere, shared customization

### Worktree Cleanup

**After Feature Merges:**

```bash
cd ~/projects/my-api

# Remove worktree
git worktree remove ~/wt/my-api/rate-limiting

# Or if directory already deleted
git worktree prune

# Delete branch (if desired)
git branch -d ENG-1234-rate-limiting
```

**Automated Cleanup Script:**

```bash
#!/bin/bash
# cleanup-merged-worktrees.sh

cd ~/projects/my-api

# List merged branches
merged=$(git branch --merged main | grep -v "main")

for branch in $merged; do
  # Find worktree for branch
  wt=$(git worktree list | grep "$branch" | awk '{print $1}')

  if [ -n "$wt" ]; then
    echo "Removing worktree: $wt"
    git worktree remove "$wt"
  fi

  echo "Deleting branch: $branch"
  git branch -d "$branch"
done
```

---

## Anti-Patterns to Avoid

### 1. Context Over-Loading

**Anti-Pattern:**

```
# Reading entire codebase upfront
Read all files in src/
Read all files in tests/
Read all files in config/
```

**Why it's bad:**

- Wastes context window
- Includes irrelevant information
- Degrades AI performance

**Better Approach:**

```
# Progressive, targeted loading
@catalyst-dev:codebase-locator find authentication files
[analyze results]
Read src/auth/handler.js
[follow specific code paths]
```

### 2. Monolithic Research

**Anti-Pattern:**

```
@catalyst-dev:research everything about payments including all files, all history, all patterns, and create a complete analysis
```

**Why it's bad:**

- Unclear scope
- Mixed responsibilities
- No parallelization
- Hard to verify completeness

**Better Approach:**

```
# Parallel, focused research
@catalyst-dev:codebase-locator find payment files
@catalyst-dev:thoughts-locator search payment research
@catalyst-dev:codebase-pattern-finder show payment patterns
```

### 3. Vague Plans

**Anti-Pattern:**

```markdown
## Phase 1: Setup

Do database stuff

### Success Criteria

- [ ] It works
```

**Why it's bad:**

- No clear completion criteria
- Can't verify success
- Unclear scope
- No actionable steps

**Better Approach:**

```markdown
## Phase 1: Database Schema

### Overview

Add rate_limits table with user quotas and time windows

### Changes Required

- Add migration: 012_add_rate_limits_table.sql
  - Columns: id, user_id, endpoint, limit_per_minute, created_at
  - Index on (user_id, endpoint)
  - Foreign key to users(id)

### Success Criteria

#### Automated Verification

- [ ] Migration runs: `make migrate`
- [ ] Schema validation passes: `make db-verify-schema`
- [ ] Can insert test records: `make test-db-rate-limits`

#### Manual Verification

- [ ] Table visible in database client
- [ ] Foreign key constraint prevents invalid user_ids
```

### 4. Implementation Without Planning

**Anti-Pattern:**

```
# Jumping straight to implementation
Let's add rate limiting. I'll start coding...
[implements without research or planning]
```

**Why it's bad:**

- Misses existing patterns
- Duplicates code
- Ignores constraints
- No thought-out approach

**Better Approach:**

```
# Research, plan, then implement
/catalyst-dev:create_plan thoughts/shared/tickets/eng_1234.md
[collaborative planning with research]
/catalyst-dev:implement_plan thoughts/shared/plans/2025-01-08-ENG-1234-rate-limiting.md
```

### 5. No Context Persistence

**Anti-Pattern:**

```
# All work in conversation window
[extensive research]
[detailed planning]
[conversation ends]
# All context lost
```

**Why it's bad:**

- Research must be redone
- No reusable knowledge
- Team can't benefit
- Wastes time

**Better Approach:**

```
# Persist everything important
[research]
Write findings to thoughts/shared/research/rate_limiting.md

[planning]
Plan saved to thoughts/shared/plans/2025-01-08-ENG-1234-rate-limiting.md

[implementation notes]
Add to plan as "Implementation Notes" section

humanlayer thoughts sync
```

### 6. Mixed Automated and Manual Criteria

**Anti-Pattern:**

```markdown
### Success Criteria

- [ ] Tests pass and UI looks good
- [ ] No errors and performance is acceptable
- [ ] Everything works correctly
```

**Why it's bad:**

- Can't distinguish what's automatable
- Unclear what needs human testing
- Validation agents can't help
- Ambiguous completion

**Better Approach:**

```markdown
### Success Criteria

#### Automated Verification

- [ ] Unit tests pass: `make test-unit`
- [ ] Integration tests pass: `make test-integration`
- [ ] No TypeScript errors: `npm run typecheck`

#### Manual Verification

- [ ] UI displays rate limit errors clearly
- [ ] Performance acceptable with 1000+ requests
- [ ] Error messages are user-friendly
```

### 7. Ignoring Existing Patterns

**Anti-Pattern:**

```
# Implementing without checking existing code
I'll create a new pagination approach...
[implements custom solution]
# Codebase already has 3 pagination patterns
```

**Why it's bad:**

- Creates inconsistency
- Duplicates code
- Misses proven patterns
- Harder maintenance

**Better Approach:**

```
# Check existing patterns first
@catalyst-dev:codebase-pattern-finder show pagination implementations
[review existing patterns]
# Use the same pattern as similar endpoints
```

### 8. Scope Creep

**Anti-Pattern:**

```markdown
# Plan for "Add rate limiting"

## Phase 1: Basic rate limiting

## Phase 2: Dashboard for viewing limits

## Phase 3: Admin UI for configuring limits

## Phase 4: Per-endpoint limits

## Phase 5: Geographic rate limiting

## Phase 6: Machine learning for dynamic limits
```

**Why it's bad:**

- Original goal lost
- Never finishes
- Delays value delivery
- Increases complexity

**Better Approach:**

```markdown
# Plan for "Add rate limiting"

## What We're NOT Doing

- Not building admin UI (configuration via code only)
- Not implementing per-endpoint limits (global only)
- Not adding geographic rules (user-based only)
- Not implementing ML/dynamic limits

## Phase 1: Basic Global Rate Limiting

[Focused on original goal]
```

---

## Key Takeaways

1. **Context is precious** - Load only what's needed, when needed
2. **Just-in-time loading** - Discover dynamically, don't preload
3. **Use specialized agents** - Parallel, focused research beats monolithic
4. **Persist important context** - Use thoughts/ for reusable knowledge
5. **Separate automated vs manual** - Clear success criteria enable better validation
6. **Follow existing patterns** - Check codebase before creating new approaches
7. **Control scope** - Explicitly state what's NOT being done
8. **Progressive discovery** - Start broad, narrow progressively
9. **Sync thoughts regularly** - Share context with team
10. **Verify incrementally** - Don't wait until end to test

---

## Next Steps

- See [USAGE.md](USAGE.md) for detailed usage instructions
- See [PATTERNS.md](PATTERNS.md) for creating custom agents
- See [CONTEXT_ENGINEERING.md](CONTEXT_ENGINEERING.md) for deeper principles
