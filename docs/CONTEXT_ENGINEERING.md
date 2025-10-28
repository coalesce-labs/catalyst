# Context Engineering Guide

A deep dive into context engineering principles and how they're implemented in the Ryan Claude
Workspace.

## Table of Contents

- [Anthropic's Context Engineering Principles](#anthropics-context-engineering-principles)
- [Agent Architecture Implementation](#agent-architecture-implementation)
- [Managing Context in Long Tasks](#managing-context-in-long-tasks)
- [Compaction Strategies](#compaction-strategies)
- [Progressive Context Discovery](#progressive-context-discovery)
- [Parallel vs Sequential Research](#parallel-vs-sequential-research)
- [Balancing Specificity vs Generality](#balancing-specificity-vs-generality)
- [Context Budget Management](#context-budget-management)
- [Real-World Patterns](#real-world-patterns)

---

## Anthropic's Context Engineering Principles

### Summary of Core Principles

Based on Anthropic's article "Effective Context Engineering for AI Agents", the key principles are:

#### 1. Context is Precious

**Principle**: Treat the context window as a limited, valuable resource.

**Why it matters:**

- LLMs have finite context windows (e.g., 200K tokens)
- More context ≠ better performance
- Irrelevant information degrades accuracy
- Focus increases quality

**Implementation:**

```
Bad: Load entire codebase upfront
Good: Load only relevant files just-in-time
```

#### 2. Just-in-Time Context Loading

**Principle**: Load context dynamically as needed, not preemptively.

**Why it matters:**

- You don't know what you need until you explore
- Upfront loading often loads wrong files
- Dynamic loading follows actual code paths
- Reduces wasted context

**Implementation:**

```
1. Start with broad search → find relevant files
2. Read specific files → discover dependencies
3. Follow references → load related code
4. Repeat as needed
```

#### 3. Sub-Agent Architecture

**Principle**: Use focused, parallel agents instead of monolithic ones.

**Why it matters:**

- Specialized agents are more accurate
- Parallel execution is faster
- Tool restrictions prevent over-exploration
- Clear boundaries improve focus

**Implementation:**

```
Instead of: One agent that does everything
Use: Multiple focused agents in parallel
  - codebase-locator (find files)
  - codebase-analyzer (understand logic)
  - thoughts-locator (find history)
```

#### 4. Structured Persistence

**Principle**: Save important context outside conversation windows.

**Why it matters:**

- Conversations are ephemeral
- Context is expensive to rebuild
- Persistent artifacts enable compaction
- Enables context reuse across sessions

**Implementation:**

```
Ephemeral: All research in conversation
Persistent: Save to thoughts/ directory
  - Research documents
  - Implementation plans
  - Architectural decisions
```

#### 5. Progressive Refinement

**Principle**: Start broad, narrow progressively through iterations.

**Why it matters:**

- Unknown unknowns require exploration
- Premature specificity misses important context
- Iterative refinement is natural investigation pattern
- Allows course correction

**Implementation:**

```
Level 1: Broad search (what files exist?)
Level 2: Categorical (which are relevant?)
Level 3: Deep dive (how does X work?)
Level 4: Related context (what else is affected?)
```

---

## Agent Architecture Implementation

### How Agents Implement Context Engineering

#### Focused Responsibility = Limited Context

Each agent has a single, clear responsibility:

**codebase-locator**

- Responsibility: Find file locations
- Tools: Grep, Glob, Bash(ls)
- Does NOT: Read file contents
- Context used: File paths, directory structure
- Context saved: Minimal (paths only)

**codebase-analyzer**

- Responsibility: Understand implementation
- Tools: Read, Grep, Glob
- Does NOT: Modify code or suggest changes
- Context used: Specific files, function definitions
- Context saved: Moderate (implementation details)

**Result**: Each agent uses only the context needed for its task.

#### Tool Restrictions Enforce Boundaries

Tools constrain what agents can access:

**Locator Pattern** (`tools: Grep, Glob, Bash(ls only)`)

- Can search for patterns
- Can list directories
- CANNOT read file contents
- Result: Finds locations without loading full files

**Analyzer Pattern** (`tools: Read, Grep, Glob`)

- Can read specific files
- Can search for patterns
- CANNOT edit files
- Result: Understands without modifying

**Implementation Pattern** (`tools: all`)

- Full access for modifications
- Used only for implementation commands
- Not used for research

**Why this matters:**

```
Without restrictions:
  Locator agent might read all files it finds
  → Wastes context on unnecessary content

With restrictions:
  Locator agent can only return paths
  → Minimal context usage
  → Analyzer reads only relevant files
```

#### Parallel Execution Optimizes Context

Multiple agents can run simultaneously:

```
Sequential (slow, shared context):
1. Find files (context: paths)
2. Wait...
3. Analyze files (context: paths + file contents)
4. Wait...
5. Find patterns (context: paths + contents + patterns)

Total time: Sum of all steps
Total context: Cumulative across all steps

Parallel (fast, isolated context):
1. Find files (context: paths)
2. Analyze files (context: file contents)
3. Find patterns (context: patterns)

[All running simultaneously]

Total time: Max of any step
Total context: Each agent's context is isolated
Result aggregation: Bring together findings
```

**Benefits:**

- Faster (parallel execution)
- More efficient context usage (isolated contexts)
- Better results (specialized focus)

### Sub-Agent Spawning Pattern

Commands orchestrate multiple agents:

```markdown
## /catalyst-dev:create_plan Command Flow

Step 1: Read ticket file Context loaded: Ticket content (1-2K tokens)

Step 2: Spawn parallel research agents Agent A (codebase-locator): Context: Ticket keywords + file
paths Returns: List of relevant files Context used: ~5K tokens Context persisted: File paths only

Agent B (thoughts-locator): Context: Ticket keywords + thoughts structure Returns: Relevant
documents Context used: ~3K tokens Context persisted: Document paths only

Agent C (codebase-analyzer): Context: Specific files from exploration Returns: Implementation
analysis Context used: ~10K tokens Context persisted: Analysis summary

All run in parallel → same time as slowest

Step 3: Main context receives results File paths from A: 1K tokens Document paths from B: 500 tokens
Analysis from C: 2K tokens Total added: 3.5K tokens (not 18K!)

Step 4: Synthesize and plan Main context:

- Ticket: 2K
- Research summaries: 3.5K
- Planning logic: 5K Total: ~10.5K tokens

vs. doing all research in main context: ~50K+ tokens
```

**Key Insight**: Sub-agents use their own context windows. Only summaries return to main context.

---

## Managing Context in Long Tasks

### Problem: Long Tasks Exhaust Context

Implementing a large feature might involve:

- Reading 50+ files (100K+ tokens)
- Multiple iterations and edits
- Verification and debugging
- Context fills up, performance degrades

### Solution: Structured Checkpointing

Use plans as checkpoints:

```markdown
## Phase 1: Database Schema

- [x] Add migration file
- [x] Run migration
- [x] Verify schema

## Phase 2: API Endpoints

- [x] Add rate limit middleware
- [ ] Add endpoint handlers
- [ ] Add error handling
```

**How this helps:**

**Without checkpoints:**

```
Context accumulates:
- All research (20K tokens)
- All file reads (50K tokens)
- All implementation discussion (30K tokens)
- All verification (10K tokens)
Total: 110K tokens → context exhaustion
```

**With checkpoints:**

```
Phase 1:
- Research phase 1 (10K)
- Implement phase 1 (15K)
- Checkpoint: Update plan checkboxes
- Total: 25K tokens

[New conversation]

Phase 2:
- Read plan (5K) ← compressed context
- Read completed work (10K)
- Implement phase 2 (15K)
- Total: 30K tokens

Each phase stays under 50K tokens
Plan provides continuity
```

### Compaction Through Persistence

**Anti-Pattern: Everything in Conversation**

```
[Extensive research on authentication approaches]
[Detailed exploration of OAuth flows]
[Analysis of 20 different files]
[Decision making process]

← All lives in conversation context
← Gets buried under new content
← Must be re-done if conversation ends
```

**Pattern: Persist Important Findings**

```
[Research authentication approaches]
↓
Write summary to thoughts/shared/research/auth_approaches.md:
  - Key finding: Use JWT with RS256
  - Rationale: Mobile app compatibility
  - Implementation: Short-lived tokens + refresh pattern
  - Security considerations: Token rotation every 1 hour
↓
[Later conversation]
Read thoughts/shared/research/auth_approaches.md
← Instant context recovery (2K tokens vs 20K original research)
```

**Compaction Ratio:**

```
Original research:
  - 5 agents spawned
  - 30 files read
  - 2 hours of investigation
  - ~50K tokens of context

Persisted summary:
  - Key decisions
  - Rationale
  - Implementation approach
  - ~2K tokens

Compaction: 25x reduction
Reusability: Infinite
```

---

## Compaction Strategies

### Strategy 1: Research → Document

**Before (in conversation):**

```
@agent-codebase-analyzer how does rate limiting work?

[Agent reads 5 files, traces logic, explains implementation]
← 10K tokens in conversation

Later: Need to reference this again
Must re-run analysis or scroll through history
```

**After (persisted):**

```
@agent-codebase-analyzer how does rate limiting work?

[Agent analysis: 10K tokens]

Take those findings and write to:
thoughts/shared/research/rate_limiting_implementation.md

Content:
  - Current implementation: Redis-based sliding window
  - Entry point: src/middleware/rate-limit.js:23
  - Key logic: Sliding window algorithm at line 45
  - Configuration: config/rate-limits.json
  - Limits: 100/min anonymous, 1000/min authenticated

[Later]
Read thoughts/shared/research/rate_limiting_implementation.md
← 2K tokens, instant context
```

**Compaction:**

- Original: 10K tokens, ephemeral
- Persisted: 2K tokens, reusable
- Benefit: 5x reduction + persistence

### Strategy 2: Plan as Context Checkpoint

**Anti-Pattern: Implement Without Plan**

```
[Conversation 1]
"Add rate limiting"
[Research: 20K tokens]
[Start implementing]
[Context fills up]
[Conversation ends]

[Conversation 2]
"Continue rate limiting"
← No context of what was decided
← Must re-research
```

**Pattern: Plan First**

```
[Conversation 1]
/catalyst-dev:create_plan for rate limiting

[Research: 20K tokens]
[Create plan]
Plan saved to thoughts/shared/plans/2025-01-08-rate-limiting.md
← 5K tokens, comprehensive

[Conversation 2]
/catalyst-dev:implement_plan thoughts/shared/plans/2025-01-08-rate-limiting.md

Read plan: 5K tokens
← Full context recovered
← All decisions preserved
← Ready to implement
```

**Benefits:**

- Research compacted into plan (20K → 5K)
- Plan persists across conversations
- Implementation can start fresh
- Multiple people can implement same plan

### Strategy 3: Incremental Checkboxes

Plans use checkboxes to track progress:

```markdown
## Phase 1: Database

- [x] Add migration ← Marked complete
- [x] Run migration ← Don't need to verify again
- [ ] Add indexes ← Next task

## Phase 2: API

- [ ] Add middleware
- [ ] Add handlers
```

**How this enables compaction:**

**Without checkboxes:**

```
[Resume conversation]
What did we complete?
Let me check:
  - Read migration file
  - Check database schema
  - Read all related code
  - Verify tests

← Re-verifying everything (15K tokens)
```

**With checkboxes:**

```
[Resume conversation]
Read plan, see checkboxes
Phase 1 complete ✓
Start Phase 2

← Trust checkboxes (2K tokens)
← Skip re-verification
← Continue from checkpoint
```

### Strategy 4: Thought Documents as Cache

**Pattern: Personal → Refined → Shared**

```
Step 1: Explore (personal thoughts)
thoughts/ryan/notes/exploring_rate_limiting.md
- Random observations
- Questions
- Rough ideas
← Scratchpad, can be messy

Step 2: Refine (personal research)
thoughts/ryan/tickets/eng_1234_research.md
- Organized findings
- Key insights
- Decision points
← Structured, personal

Step 3: Distill (shared knowledge)
thoughts/shared/research/rate_limiting_decision.md
- Final decision: Redis-based
- Rationale: Multi-instance compatibility
- Implementation approach: Sliding window
- Configuration: 100/min anon, 1000/min auth
← Minimal, high-value, shareable

Step 4: Reference (efficient reuse)
Later work:
Read thoughts/shared/research/rate_limiting_decision.md
← 1K tokens
← Instant context
← No re-research needed
```

**Compaction flow:**

```
Exploration: 50K tokens (conversation)
    ↓
Personal notes: 10K tokens (document)
    ↓
Refined research: 5K tokens (document)
    ↓
Shared decision: 1K tokens (document)
    ↓
Future reuse: 1K tokens (read)

Total investment: 50K once
Future cost: 1K always
```

---

## Progressive Context Discovery

### The Anti-Pattern: Load Everything Upfront

```
"I need to add authentication"

Bad approach:
1. Read all auth-related files (30 files, 60K tokens)
2. Read all auth tests (20 files, 40K tokens)
3. Read all auth config (10 files, 20K tokens)
4. Read related middleware (15 files, 30K tokens)

Total: 75 files, 150K tokens loaded
Problem: Don't know which are relevant yet!
Result: Context full of noise
```

### The Pattern: Progressive Discovery

**Level 1: Broad Orientation**

```
@agent-codebase-locator find authentication files

Returns:
- src/auth/ (12 files)
- src/middleware/auth.js
- config/auth.json
- tests/auth/ (8 files)

Context used: 2K tokens (paths only)
Learning: Auth logic in src/auth/, entry via middleware
```

**Level 2: Categorical Understanding**

```
Based on Level 1, focus on entry point:

Read src/middleware/auth.js

Context used: 3K tokens (one file)
Learning:
  - Uses JWT verification
  - Imports from src/auth/jwt-handler.js
  - Config from config/auth.json
```

**Level 3: Deep Dive on Relevant Files**

```
Based on Level 2, follow the path:

Read src/auth/jwt-handler.js
Read config/auth.json

Context used: 5K tokens (two files)
Learning:
  - JWT handler uses RS256
  - Secret loaded from environment
  - Token expiry: 1 hour
```

**Level 4: Related Context**

```
Based on Level 3, check tests and usage:

@agent-codebase-pattern-finder show JWT usage examples

Context used: 4K tokens (patterns)
Learning:
  - Consistent usage pattern across codebase
  - Test fixtures available
  - Error handling standard
```

**Total Context Used: ~14K tokens**

**Compare to loading all upfront: 150K tokens**

**Efficiency gain: ~10x**

### Progressive Discovery in Practice

**Example: Understanding Webhook Processing**

```
Level 1: Find the files
@agent-codebase-locator find webhook files

Result:
- src/webhooks/handler.js
- src/webhooks/validator.js
- src/webhooks/processor.js
- tests/webhooks/

Context: 2K tokens

Level 2: Understand entry point
Read src/webhooks/handler.js

Discovers:
- Entry: POST /webhooks endpoint
- Calls validator.validateSignature()
- Queues to processor

Context: 3K tokens

Level 3: Follow critical path
Read src/webhooks/validator.js

Discovers:
- HMAC-SHA256 signature check
- Uses crypto library
- Secret from environment

Context: 4K tokens

Level 4: Understand processing
Read src/webhooks/processor.js

Discovers:
- Async processing via queue
- Stores in database
- Retry logic on failure

Context: 5K tokens

Total: ~14K tokens for complete understanding

If we had read all webhook files upfront:
- All handlers (5 files)
- All validators (3 files)
- All processors (4 files)
- All tests (10 files)
- All queue code (5 files)
Total: 27 files, ~60K tokens
Efficiency: 4x better with progressive discovery
```

---

## Parallel vs Sequential Research

### When to Use Parallel

**Independent Questions:**

```
Task: Understand payment system

Independent questions:
1. Where are payment files? (codebase-locator)
2. What's our past payment research? (thoughts-locator)
3. What payment patterns exist? (codebase-pattern-finder)

Spawn all three in parallel:
  - No dependencies between them
  - Each answers different question
  - Results aggregate at end

Time: Max(agent1, agent2, agent3)
Instead of: Sum(agent1, agent2, agent3)
```

**Comprehensive Research:**

```
/catalyst-dev:create_plan for new feature

Need to understand:
- Codebase state (codebase-analyzer)
- Historical context (thoughts-locator)
- Similar implementations (pattern-finder)
- Current tickets (ticket-reader)

All independent → spawn in parallel

Benefit:
  - 4x faster (parallel vs sequential)
  - More comprehensive (no question skipped for time)
  - Better decisions (all context available)
```

### When to Use Sequential

**Dependent Questions:**

```
Task: Debug authentication issue

Question 1: Where is auth code?
@agent-codebase-locator find auth files

Result: src/auth/handler.js is entry point

↓ (Depends on Answer 1)

Question 2: How does auth handler work?
@agent-codebase-analyzer explain src/auth/handler.js

Result: Uses JWT, calls verify() at line 45

↓ (Depends on Answer 2)

Question 3: How does verify() work?
Read src/auth/jwt-verifier.js:45

Must be sequential - each depends on previous
```

**Following Code Path:**

```
Trace webhook processing:

Step 1: Find entry point
@agent-codebase-locator find webhook handler

Result: src/webhooks/handler.js

Step 2: Analyze entry (depends on step 1)
@agent-codebase-analyzer analyze src/webhooks/handler.js

Result: Calls validateSignature() from validator.js

Step 3: Analyze validator (depends on step 2)
Read src/webhooks/validator.js

Sequential because each step informs the next
```

### Hybrid Approach

**Most Effective Pattern:**

```
Phase 1: Parallel broad research
  @agent-codebase-locator find payment files
  @agent-thoughts-locator search payment docs
  @agent-codebase-pattern-finder show payment patterns

[All run in parallel]

Phase 2: Sequential deep dive
  Based on Phase 1 results:
  1. Read main payment processor
  2. Read dependencies it imports
  3. Read config it uses

[Sequential - following discovered path]

Phase 3: Parallel validation
  @agent-test-validator verify payment tests
  @agent-integration-checker check payment integrations

[Parallel - independent validations]

Result: Fast initial discovery, thorough investigation, comprehensive validation
```

---

## Balancing Specificity vs Generality

### The Spectrum

```
Too General ←――――――――――――――――→ Too Specific
  "Do coding"        "Find files"        "Find .jsx files in src/components/auth/ modified in last week"
     ↑                    ↑                                    ↑
   Useless           Optimal                              Overfit
```

### Agent Generality Guidelines

**Good Generality:**

```
Agent: codebase-locator
Description: Locates files and directories relevant to a feature

Good because:
- Applicable to any feature
- Works in any codebase
- Clear, focused purpose
- Flexible execution

Usage:
  @agent-codebase-locator find authentication files
  @agent-codebase-locator find payment processing code
  @agent-codebase-locator find test files for webhooks
```

**Too General:**

```
Agent: code-helper
Description: Helps with code

Bad because:
- What kind of help?
- Any code? Any language?
- No clear boundaries
- Overlaps with everything

Unclear usage:
  @agent-code-helper do something with auth?
```

**Too Specific:**

```
Agent: jsx-file-finder-in-auth-components
Description: Finds .jsx files in src/components/auth/

Bad because:
- Only works in specific directory
- Only works for .jsx (not .tsx, .js)
- Not reusable across projects
- Too narrow to be useful

Overly specific:
  Only useful in exact scenario
  Could be done with simple glob
```

### Command Specificity Guidelines

**Good Specificity:**

```
Command: /catalyst-dev:create_plan
Description: Creates implementation plans through research and collaboration

Good because:
- Clear, specific workflow
- Applicable to any feature
- Well-defined process
- Consistent output

Works for:
  /catalyst-dev:create_plan for authentication
  /catalyst-dev:create_plan for payment processing
  /catalyst-dev:create_plan for any feature
```

**Domain-Specific Commands:**

Sometimes specificity is appropriate:

```
Command: /deploy_to_staging
Description: Deploys current branch to staging environment

Appropriately specific because:
- Project-specific workflow
- Well-defined process
- Repeated operation
- Team standard

Lives in: .claude/commands/ (project-specific)
Not in: ~/.claude/commands/ (user-wide)
```

### Finding the Right Level

**Questions to Ask:**

1. **Reusability**
   - Can this agent/command be used in multiple contexts?
   - Does it work across different codebases?
   - Is it project-specific or universal?

2. **Clarity**
   - Is the purpose immediately clear?
   - Can someone decide when to use it?
   - Are boundaries well-defined?

3. **Flexibility**
   - Can it adapt to different scenarios?
   - Does it require exact conditions?
   - Is it parameterizable?

**Examples:**

```
codebase-locator ✓
  Reusable: Yes (any codebase)
  Clear: Yes (finds files)
  Flexible: Yes (any search criteria)

payment-stripe-webhook-validator ✗
  Reusable: No (only Stripe webhooks)
  Clear: Yes (very specific)
  Flexible: No (only one scenario)

Better: webhook-validator
  Reusable: Yes (any webhook)
  Clear: Yes (validates webhooks)
  Flexible: Yes (any webhook provider)
```

---

## Context Budget Management

### Understanding the Budget

**Typical Context Window: 200K tokens**

**Token Usage Examples:**

- Average code file: 2-5K tokens
- Implementation plan: 3-7K tokens
- Research document: 2-4K tokens
- Agent conversation: 10-20K tokens
- Full conversation: 50-100K tokens

### Budget Allocation Strategy

**For Research Tasks:**

```
Budget: 200K tokens

Allocation:
- System prompt & instructions: 5K (2.5%)
- Research coordination: 10K (5%)
- Agent results aggregation: 20K (10%)
- File contents (targeted): 40K (20%)
- Planning & synthesis: 25K (12.5%)
- Buffer for iteration: 100K (50%)

Total: 200K
```

**For Implementation Tasks:**

```
Budget: 200K tokens

Allocation:
- Plan document: 5K (2.5%)
- Current code (focused): 50K (25%)
- Implementation discussion: 40K (20%)
- Verification & debugging: 30K (15%)
- Buffer: 75K (37.5%)

Total: 200K
```

### Avoiding Budget Exhaustion

**Anti-Pattern: Front-Loading**

```
Read entire feature directory: 100K tokens
Read all tests: 50K tokens
Read all config: 20K tokens

Total: 170K tokens BEFORE any work
Buffer: 30K tokens (insufficient for actual work)

Result: Context exhausted, poor performance
```

**Pattern: Progressive Loading**

```
Initial: Read plan + entry points: 10K tokens
Implementation Phase 1: Load relevant files: 20K tokens
Implementation Phase 2: Load more files: 20K tokens
Verification: Load test files: 15K tokens

Total: 65K tokens across entire task
Buffer: 135K tokens (ample for exploration)

Result: Efficient usage, room to explore
```

### Budget Monitoring Signals

**Warning Signs of Budget Issues:**

1. **Repeating Information**
   - AI restates same things
   - Circular logic
   - Verbose explanations

2. **Loss of Context**
   - Forgets earlier decisions
   - Re-asks answered questions
   - Inconsistent with prior statements

3. **Generic Responses**
   - Less specific than earlier
   - Missing file:line references
   - Vague recommendations

**Solutions:**

1. **Compact Context**

   ```
   Write current understanding to thoughts/shared/research/
   Start fresh conversation
   Read compacted summary
   → Context reset with preserved knowledge
   ```

2. **Phase Work**

   ```
   Complete Phase 1
   Update plan checkboxes
   Start new conversation for Phase 2
   → Each phase stays under budget
   ```

3. **Use Sub-Agents**
   ```
   Instead of: Main agent does all research (context accumulates)
   Use: Spawn sub-agents (isolated contexts)
   → Only summaries return to main context
   ```

### Context Budget Best Practices

**1. Read Files Fully, Read Fewer Files**

```
Bad: Read 50 files partially
  - Incomplete understanding
  - Must re-read later
  - Fragments waste context

Good: Read 10 files completely
  - Full understanding
  - One-time read
  - Efficient context use
```

**2. Persist Before Context Fills**

```
Research phase (30K tokens accumulated)
↓
Write to thoughts/shared/research/finding.md
↓
Context compacted to 3K tokens (summary)
↓
Continue with 27K tokens freed
```

**3. Checkpoint with Plans**

```
Every 50K tokens of work:
  - Update plan checkboxes
  - Document decisions in plan
  - Consider if new conversation needed

Checkpoints enable:
  - Context reset without losing progress
  - Continuation from known state
  - Distributed work across conversations
```

**4. Leverage Agent Isolation**

```
Main context: 30K tokens
Spawn 3 agents (each in own context):
  - Agent A: 25K tokens (isolated)
  - Agent B: 20K tokens (isolated)
  - Agent C: 15K tokens (isolated)

Agents return summaries: 6K tokens total

Main context after: 36K tokens
vs. doing all in main context: 90K tokens

Savings: 54K tokens (60% reduction)
```

---

## Real-World Patterns

### Pattern 1: Large Feature Implementation

**Scenario**: Implement comprehensive rate limiting across 20+ endpoints

**Approach:**

```
Phase 1: Research (Conversation 1)
  Budget: 200K tokens

  Steps:
  1. Spawn parallel research agents (15K)
  2. Read key files based on findings (30K)
  3. Create comprehensive plan (10K)
  4. Write plan to thoughts/ (5K)
  5. Sync thoughts (0K)

  Total used: 60K
  Plan persisted: 5K tokens reusable

Phase 2: Database Implementation (Conversation 2)
  Budget: 200K tokens (fresh)

  Steps:
  1. Read plan (5K)
  2. Implement database schema (20K)
  3. Run migrations (5K)
  4. Verify (10K)
  5. Update plan checkboxes (2K)

  Total used: 42K
  Checkboxes track progress

Phase 3: Middleware Implementation (Conversation 3)
  Budget: 200K tokens (fresh)

  Steps:
  1. Read plan (5K)
  2. Implement middleware (30K)
  3. Add error handling (15K)
  4. Test integration (20K)
  5. Update plan (2K)

  Total used: 72K

Phase 4: Validation (Conversation 4)
  Budget: 200K tokens (fresh)

  Steps:
  1. Read plan (5K)
  2. Run /catalyst-dev:validate_plan (30K)
  3. Fix issues (25K)
  4. Final verification (15K)

  Total used: 75K

Total work: 4 conversations, never exceeded 75K
Each conversation fresh context
Plan provides continuity
All progress tracked
```

### Pattern 2: Debugging Complex Issue

**Scenario**: Webhooks failing intermittently

**Approach:**

```
Step 1: Parallel Investigation (15K tokens)
  @agent-codebase-locator find webhook files
  @agent-thoughts-locator search webhook issues
  @agent-codebase-analyzer trace webhook flow

  Results:
  - File locations (2K)
  - Historical issues (3K)
  - Flow analysis (10K)

Step 2: Targeted Deep Dive (25K tokens)
  Read src/webhooks/processor.js (5K)
  Read src/queue/worker.js (6K)
  Read logs/webhook-errors.log (4K)
  Analyze error patterns (10K)

Step 3: Document Findings (5K tokens)
  Write to thoughts/shared/research/webhook_timeout_analysis.md
  - Root cause: Missing timeout on queue processing
  - Affected endpoints: All async webhooks
  - Solution: Add 30s timeout with graceful degradation

Step 4: Implementation (Separate Conversation)
  Read analysis (3K)
  Implement fix (20K)
  Verify (15K)

Total: ~85K across two conversations
Analysis persisted for future reference
```

### Pattern 3: Knowledge Transfer

**Scenario**: New team member learning authentication system

**Without Context Engineering:**

```
New dev asks: "How does auth work?"

Response requires:
- Reading 20+ auth files (50K tokens)
- Explaining architecture (20K tokens)
- Showing examples (15K tokens)
- Answering questions (20K tokens)

Total: 105K tokens
Time: 2-3 hours
Result: Knowledge lost when conversation ends
```

**With Context Engineering:**

```
Previous work:
  thoughts/shared/research/auth_architecture.md
  - Overview
  - Key components
  - Flow diagrams
  - Integration points
  - Security considerations

New dev asks: "How does auth work?"

Response:
  Read thoughts/shared/research/auth_architecture.md (3K)
  [Instant, comprehensive context]
  Answer specific questions (10K)

Total: 13K tokens
Time: 15 minutes
Result: Knowledge persisted, reusable for next person
```

**Efficiency: 8x reduction in tokens, 10x reduction in time**

### Pattern 4: Cross-Repository Work

**Scenario**: Pattern used in repo A, need to implement in repo B

**Without Thoughts System:**

```
Repo A:
  [Research pattern]
  [Implement]
  [Knowledge stays in repo A]

Repo B:
  [Research same pattern again]
  [Duplicate work]
  [Possibly different implementation]
```

**With Thoughts System:**

```
Repo A:
  [Research pattern]
  [Implement]
  Write to ~/thoughts/global/patterns/pagination_approach.md
  - Cursor-based pattern
  - Why chosen
  - Implementation template
  - Gotchas

Repo B:
  Read ~/thoughts/global/patterns/pagination_approach.md
  [Implement same pattern]
  [Consistent approach]
  [No duplicated research]

Benefit:
  - 10K token research → 2K token read
  - Consistent patterns across repos
  - Team knowledge captured
```

---

## Key Takeaways

1. **Context is precious** - Budget it like RAM, not disk
2. **Just-in-time loading** - Discover dynamically, don't preload
3. **Sub-agent architecture** - Isolated contexts, aggregate results
4. **Structured persistence** - Compact ephemeral context into reusable artifacts
5. **Progressive discovery** - Broad → specific, iterate to refine
6. **Parallel when independent** - Maximize efficiency
7. **Sequential when dependent** - Follow code paths
8. **Specificity sweet spot** - General enough to reuse, specific enough to be clear
9. **Budget monitoring** - Watch for warning signs, reset when needed
10. **Compaction ratio** - 10-25x reduction through persistence

---

## Advanced Topics

### Context Window as Cache

Think of context window like CPU cache:

**L1 Cache (Current Context)**

- Fastest access
- Limited size (200K tokens)
- Currently loaded files and conversation

**L2 Cache (Thoughts Directory)**

- Fast access (Read tool)
- Larger size (unlimited)
- Persisted research and plans

**L3 Cache (Codebase)**

- Slower access (search → read)
- Unlimited size
- All code files

**RAM (Sub-Agents)**

- Parallel access
- Isolated contexts
- Aggregate to main

**Optimization Strategy:**

1. Keep hot path in L1 (current context)
2. Store frequently accessed in L2 (thoughts)
3. Load from L3 on-demand (codebase files)
4. Use RAM for parallel work (sub-agents)

### Context Entropy

Context quality degrades over time:

```
Conversation Start:
  - High signal-to-noise
  - Clear focus
  - Efficient usage

After 50K tokens:
  - Mixed signal-to-noise
  - Some tangents
  - Less efficient

After 100K tokens:
  - Lower signal-to-noise
  - Multiple tangents
  - Degraded performance

After 150K tokens:
  - Significant noise
  - Context thrashing
  - Poor results

Solution: Reset before entropy too high
  - Checkpoint at 50-75K tokens
  - Persist important context
  - Start fresh conversation
  - Read persisted summary
```

### Meta-Context Management

The thoughts system itself reduces meta-context:

```
Without thoughts:
  "Where did we save that research?"
  "What did we decide about authentication?"
  "Did we already investigate this?"
  ← Meta-questions waste context

With thoughts:
  "Check thoughts/shared/research/"
  "Read thoughts/shared/decisions/"
  "Search thoughts/searchable/"
  ← Clear, systematic, efficient
```

---

## Next Steps

- See [USAGE.md](USAGE.md) for practical usage
- See [BEST_PRACTICES.md](BEST_PRACTICES.md) for proven patterns
- See [PATTERNS.md](PATTERNS.md) for creating agents
