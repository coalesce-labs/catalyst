---
title: Context Engineering
description: Token efficiency strategies, context budgeting, and compaction patterns.
---

Context engineering is the practice of treating the AI context window as a scarce resource and managing it deliberately. Catalyst implements these principles through its agent architecture and workflow design.

## Core Principles

### 1. Context is Precious

Treat context like CPU cache — load only what's needed, when it's needed. More context does not equal better performance; irrelevant information degrades accuracy.

### 2. Just-in-Time Loading

Load context dynamically as needed, not preemptively. You don't know what files are relevant until you explore.

```
1. Start with broad search → find relevant files
2. Read specific files → discover dependencies
3. Follow references → load related code
4. Repeat as needed
```

### 3. Sub-Agent Architecture

Use focused, parallel agents instead of monolithic ones. Each agent has its own context window — only summaries return to the main context.

```
Main context: 30K tokens
Spawn 3 agents (each in own context):
  Agent A: 25K tokens (isolated)
  Agent B: 20K tokens (isolated)
  Agent C: 15K tokens (isolated)

Agents return summaries: 6K tokens total

Main context after: 36K tokens
vs doing all in main context: 90K tokens
Savings: 54K tokens (60% reduction)
```

### 4. Structured Persistence

Save important context outside conversation windows into the thoughts system. This enables compaction — a 50K token research session becomes a 2K token summary that's instantly reloadable.

### 5. Progressive Refinement

Start broad, narrow progressively through iterations:

- **Level 1**: Broad search — what files exist?
- **Level 2**: Categorical — which are relevant?
- **Level 3**: Deep dive — how does X work?
- **Level 4**: Related context — what else is affected?

## The 40-60% Rule

Keep context utilization between 40-60% of the window. Check with `/context`.

**When to clear context**:

- Between workflow phases (research → plan → implement)
- When context reaches 60%
- When the AI starts repeating errors
- When creating a handoff

## Compaction Strategies

### Research to Document

Conduct extensive research (50K tokens) then persist a structured summary (2K tokens). Future sessions read the summary instead of re-researching.

**Compaction ratio**: 25x reduction.

### Plans as Checkpoints

Plans compress research decisions into actionable specifications. Each phase completion becomes a checkpoint — new sessions can resume from checkboxes.

### Progressive Loading

Don't front-load context. Load files incrementally as each phase of work requires them:

```
Initial: Read plan + entry points: 10K tokens
Phase 1: Load relevant files: 20K tokens
Phase 2: Load more files: 20K tokens
Verification: Load test files: 15K tokens

Total: 65K tokens across entire task
vs front-loading everything: 150K tokens
```

## Context Budget

**Typical allocations for a 200K token window**:

| Task Type | System | Research | Files | Work | Buffer |
|-----------|--------|----------|-------|------|--------|
| Research | 5K | 10K | 40K | 25K | 120K |
| Implementation | 5K | — | 50K | 40K | 105K |

**Warning signs of budget issues**:

- AI repeating information
- Forgetting earlier decisions
- Responses becoming less specific
- Missing file:line references

**Solutions**: Persist findings to thoughts, start a new conversation, or phase the work with plan checkboxes.

## Context as Cache Hierarchy

Think of context like CPU cache layers:

| Layer | Analogy | Access Speed | Size | Contents |
|-------|---------|-------------|------|----------|
| L1 | Current context | Instant | 200K tokens | Active files and conversation |
| L2 | Thoughts directory | Fast (Read tool) | Unlimited | Persisted research and plans |
| L3 | Codebase | Slower (search → read) | Unlimited | All code files |
| RAM | Sub-agents | Parallel | Isolated | Agent research contexts |

Optimization: Keep hot paths in L1, frequently accessed data in L2, load from L3 on-demand, and use sub-agents for parallel work.
