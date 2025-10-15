# DeepWiki MCP Integration Guide

## Overview

DeepWiki MCP provides AI-powered knowledge extraction from GitHub repositories, enabling your agents
to understand external codebases, frameworks, and libraries during research and planning.

## Available DeepWiki Tools

### 1. `mcp__deepwiki__read_wiki_structure`

**What it does**: Returns the table of contents / documentation structure for a repository.

**Use when**: You want to see what topics are covered in a repo's documentation.

**Example**:

```javascript
mcp__deepwiki__read_wiki_structure({
  repoName: "facebook/react",
});

// Returns:
// - 1 Overview
// - 2 Installation
// - 3 Core Concepts
//   - 3.1 Components
//   - 3.2 Hooks
// ...
```

### 2. `mcp__deepwiki__read_wiki_contents`

**What it does**: Returns full documentation/wiki content for a repository.

**Use when**: You need comprehensive documentation about a repo.

**⚠️ Warning**: Can return very large responses (80k+ tokens). Use sparingly or with specific
questions instead.

**Example**:

```javascript
mcp__deepwiki__read_wiki_contents({
  repoName: "vercel/next.js",
});
// Returns full documentation
```

### 3. `mcp__deepwiki__ask_question` ⭐ **Most Useful**

**What it does**: Ask specific questions about a repository and get AI-generated answers based on
the codebase.

**Use when**: You need to understand:

- Architectural patterns
- How specific features work
- Best practices for a framework
- Implementation details
- Integration approaches

**Example**:

```javascript
mcp__deepwiki__ask_question({
  repoName: "facebook/react",
  question: "How does the reconciliation algorithm work?",
});

// Returns detailed explanation with code references
```

---

## Which Agents Should Use DeepWiki?

### ✅ High Value Integrations

#### 1. **codebase-analyzer**

**Why**: When analyzing your codebase, often need to understand external dependencies.

**Use cases**:

- "How does this library recommend we use their API?"
- "What's the standard pattern for X in framework Y?"
- "Are we using this dependency correctly?"

**Tools to add**: `mcp__deepwiki__ask_question`

#### 2. **codebase-pattern-finder**

**Why**: Finding patterns often involves checking how popular libraries do it.

**Use cases**:

- "How does React handle this pattern?"
- "What's the standard approach in Express?"
- "Show me examples from popular repos"

**Tools to add**: `mcp__deepwiki__ask_question`, `mcp__deepwiki__read_wiki_structure`

#### 3. **NEW: external-research agent** (Recommended to create)

**Why**: Dedicated agent for researching external repos, frameworks, and libraries.

**Use cases**:

- Understanding a new framework before using it
- Finding best practices from popular repos
- Comparing implementation approaches across projects

**Tools to add**: All DeepWiki tools

### ⚠️ Moderate Value

#### 4. **codebase-locator**

**Why**: Primarily focused on YOUR codebase, but could check external repos for examples.

**Use cases**:

- "Find examples of X pattern in popular repos"
- Limited value - usually focused on local code

**Tools to add**: Maybe `mcp__deepwiki__ask_question` (optional)

### ❌ Low Value / Not Recommended

- **thoughts-locator**: Only searches local thoughts/
- **thoughts-analyzer**: Only analyzes local docs

---

## Which Commands Should Use DeepWiki?

### ✅ High Value Integrations

#### 1. **/create_plan**

**Why**: During planning, often need to research how to integrate with external libraries.

**Integration point**: In Step 2 (Research & Discovery), add guidance:

```markdown
**For external library research:**

- Use **mcp**deepwiki**ask_question** to understand framework patterns
- Research dependencies: "How does [library] recommend implementing [feature]?"
- Check architectural patterns: "What's the standard approach for [X] in [framework]?"
```

**Example workflow**:

```
Planning authentication feature:
1. Research local auth code (codebase-analyzer)
2. Research Passport.js patterns (DeepWiki)
3. Compare approaches
4. Create plan using best practices from both
```

#### 2. **/research_codebase** (if you had it - similar to create_plan)

**Why**: Explicit research command benefits from external knowledge.

### ⚠️ Lower Priority

- **/implement_plan**: Focused on execution, not research
- **/validate_plan**: Focused on verification, not research
- **/create_handoff**: Documentation, not research
- **/linear**: Ticket management, not research

---

## Recommended Agent Updates

### Update 1: codebase-analyzer.md

**Add to frontmatter**:

```markdown
---
name: codebase-analyzer
description: Analyzes codebase implementation details...
tools: Read, Grep, Glob, Bash(ls *), mcp__deepwiki__ask_question
model: inherit
---
```

**Add to system prompt** (in "Analysis Strategy" section):

```markdown
### Step 2.5: Research External Dependencies (if applicable)

If the code uses external libraries or frameworks:

- Use **mcp**deepwiki**ask_question** to understand recommended patterns
- Example: "How does [library] recommend implementing [feature]?"
- Compare local implementation against framework best practices
- Note any deviations or custom approaches
```

### Update 2: codebase-pattern-finder.md

**Add to frontmatter**:

```markdown
---
name: codebase-pattern-finder
description: Finds similar implementations and usage examples...
tools: Grep, Glob, Read, Bash(ls *), mcp__deepwiki__ask_question, mcp__deepwiki__read_wiki_structure
model: inherit
---
```

**Add to system prompt** (new section):

```markdown
### External Pattern Research

When the user requests patterns from popular repos or frameworks:

1. **Use DeepWiki to research external repos**:
```

mcp**deepwiki**ask_question({ repoName: "facebook/react", question: "How is [pattern] typically
implemented?" })

```

2. **Compare with local patterns**:
- Show external example
- Show your codebase's approach
- Note similarities and differences

3. **Present both options**:
- External framework pattern
- Your current implementation
- Pros/cons of each approach
```

### Update 3: NEW - external-research.md (Create this!)

**Full agent**:

````markdown
---
name: external-research
description:
  Research external GitHub repositories, frameworks, and libraries using DeepWiki. Call when you
  need to understand how popular repos implement features, learn framework patterns, or research
  best practices from open-source projects.
tools:
  mcp__deepwiki__ask_question, mcp__deepwiki__read_wiki_structure, mcp__deepwiki__read_wiki_contents
model: inherit
---

You are a specialist at researching external GitHub repositories to understand frameworks,
libraries, and implementation patterns.

## Your Only Job: Research External Codebases

- DO research popular open-source repositories
- DO explain how frameworks recommend implementing features
- DO find best practices from established projects
- DO compare different approaches across repos
- DO NOT analyze the user's local codebase (that's codebase-analyzer's job)

## Research Strategy

### Step 1: Determine Which Repos to Research

Based on the user's question, identify relevant repos:

- **Frameworks**: react, vue, angular, express, next.js, django, rails
- **Libraries**: axios, lodash, moment, prisma, sequelize
- **Tools**: webpack, vite, rollup, jest, vitest

### Step 2: Start with Focused Questions

Use `mcp__deepwiki__ask_question` for specific queries:

**Good questions**:

- "How does React implement the reconciliation algorithm?"
- "What's the recommended pattern for middleware in Express?"
- "How does Next.js handle server-side rendering?"

**Bad questions** (too broad):

- "Tell me everything about React"
- "How does this work?" (be specific!)

### Step 3: Get Structure First (for broad topics)

If exploring a new framework, use `mcp__deepwiki__read_wiki_structure` first:

```javascript
mcp__deepwiki__read_wiki_structure({
  repoName: "vercel/next.js",
});
// See available topics, then ask specific questions
```
````

### Step 4: Synthesize and Present

Present findings in this format:

```markdown
## Research: [Topic] in [Repo]

### Summary

[1-2 sentence overview of what you found]

### Key Patterns

1. [Pattern with explanation]
2. [Pattern with explanation]

### Implementation Approach

[How they recommend doing it]

### Code Examples

[Specific examples if provided by DeepWiki]

### Recommendations

[How this applies to the user's situation]

### References

- DeepWiki search: [link provided in response]
- Explore more: [relevant wiki pages]
```

## Common Research Scenarios

### Scenario 1: "How should I implement X with framework Y?"

1. Ask DeepWiki: "How does [framework] recommend implementing [feature]?"
2. Ask follow-up: "What are common patterns for [specific aspect]?"
3. Present structured findings
4. Suggest how to apply to user's codebase

### Scenario 2: "Compare approaches across repos"

1. Research repo A: `mcp__deepwiki__ask_question`
2. Research repo B: `mcp__deepwiki__ask_question`
3. Compare findings
4. Present pros/cons matrix

### Scenario 3: "Learn about a new framework"

1. Get structure: `mcp__deepwiki__read_wiki_structure`
2. Ask about core concepts
3. Ask about integration patterns
4. Present learning path

## Important Guidelines

- **Be specific**: Ask focused questions, not "explain everything"
- **One repo at a time**: Don't try to research 5 repos simultaneously
- **Synthesize**: Don't just paste DeepWiki output - add analysis
- **Include links**: Always include the DeepWiki search link provided
- **Stay external**: This agent is for EXTERNAL repos, not local code

## What NOT to Do

- Don't research the user's local codebase
- Don't ask overly broad questions
- Don't ignore the DeepWiki search links in responses
- Don't research when user just needs to check their own code
- Don't use `read_wiki_contents` (too large - use `ask_question` instead)

You're a research specialist. Help users understand how popular projects solve problems!

````

---

## Command Integration: create_plan.md

### Add to Step 2: Research & Discovery

Find this section and add DeepWiki guidance:

```markdown
3. **Spawn parallel sub-tasks for comprehensive research**:
   - Create multiple Task agents to research different aspects concurrently
   - Use the right agent for each type of research:

   **For local codebase:**
   - **codebase-locator** - Find files related to the feature
   - **codebase-analyzer** - Understand current implementation
   - **codebase-pattern-finder** - Find similar local patterns

   **For external research:** ← ADD THIS
   - **external-research** - Research framework patterns and best practices
   - Ask: "How does [framework] recommend implementing [feature]?"
   - Ask: "What's the standard approach for [pattern] in [library]?"

   **For historical context:**
   - **thoughts-locator** - Find previous research or decisions
   - **thoughts-analyzer** - Extract insights from past work
````

### Add Example to Planning Template

In the template section, add:

```markdown
## External Research

[If using external frameworks/libraries]

### Framework: [Library Name]

- Repository researched: [org/repo]
- Recommended approach: [What DeepWiki found]
- Why it's relevant: [How it applies to our plan]

### Integration Considerations

- [How to integrate with our codebase]
- [Any deviations from standard patterns]
```

---

## Usage Examples

### Example 1: Planning Auth Feature

**User**: Create a plan for authentication using Passport.js

**Agent workflow**:

```
1. Spawn codebase-locator: Find existing auth code
2. Spawn external-research:
   - "How does Passport.js recommend implementing local strategy?"
   - "What's the session management pattern in Passport?"
3. Compare findings
4. Create plan using both local patterns and Passport best practices
```

### Example 2: Understanding Dependency

**User**: Our React app has performance issues, how should we optimize?

**Agent workflow**:

```
1. Analyze local code (codebase-analyzer)
2. Research React patterns (external-research):
   - "What are React's recommended performance optimization patterns?"
   - "How does React handle memo and useMemo?"
3. Compare local usage vs recommended patterns
4. Create optimization plan
```

### Example 3: Framework Migration

**User**: Plan migration from Express to Fastify

**Agent workflow**:

```
1. Analyze current Express app (codebase-analyzer)
2. Research Fastify (external-research):
   - Get structure: wiki_structure for fastify/fastify
   - "How does Fastify's plugin system work?"
   - "What's the middleware pattern in Fastify?"
3. Map Express patterns to Fastify equivalents
4. Create migration plan
```

---

## Best Practices

### 1. Ask Specific Questions

**Good**:

- "How does Next.js implement server components?"
- "What's the recommended caching pattern in React Query?"

**Bad**:

- "Tell me about Next.js"
- "How does caching work?"

### 2. Research First, Then Code

Don't jump straight to implementation:

1. Research external best practices
2. Understand your local code
3. Create plan that combines both
4. Then implement

### 3. Combine Local + External Research

Always use both:

- **Local** (codebase-analyzer): "How do WE do auth?"
- **External** (DeepWiki): "How does Passport recommend auth?"
- **Synthesis**: "Our approach vs best practices"

### 4. Don't Overuse read_wiki_contents

It returns 80k+ tokens! Use instead:

- `read_wiki_structure` to see topics
- `ask_question` for specific info

### 5. Include DeepWiki Links

Always include the search link from responses:

```markdown
View this research: https://deepwiki.com/search/...
```

---

## Popular Repos to Research

### Frontend Frameworks

- `facebook/react`
- `vuejs/core`
- `angular/angular`
- `sveltejs/svelte`

### Backend Frameworks

- `expressjs/express`
- `fastify/fastify`
- `nestjs/nest`
- `django/django`
- `rails/rails`

### Full-Stack

- `vercel/next.js`
- `remix-run/remix`
- `nuxt/nuxt`

### Libraries

- `axios/axios`
- `prisma/prisma`
- `TanStack/query` (React Query)
- `reduxjs/redux`

### Build Tools

- `vitejs/vite`
- `webpack/webpack`
- `esbuild/esbuild`

---

## Troubleshooting

### "Response too large" error

**Problem**: `read_wiki_contents` returned 80k+ tokens

**Solution**: Use `ask_question` instead:

```javascript
// Don't do this:
mcp__deepwiki__read_wiki_contents({ repoName: "facebook/react" });

// Do this:
mcp__deepwiki__ask_question({
  repoName: "facebook/react",
  question: "How does the Virtual DOM work?",
});
```

### "Can't find information" response

**Problem**: Question too vague or repo not indexed

**Solutions**:

1. Be more specific in your question
2. Check if repo exists and is public
3. Try a related, more popular repo

### Research taking too long

**Problem**: Too many external research tasks

**Solutions**:

1. Limit to 2-3 most important repos
2. Ask focused questions, not broad explorations
3. Use `read_wiki_structure` to scope before deep diving

---

## Summary

**DeepWiki MCP enables**:

- ✅ Understanding external frameworks during planning
- ✅ Comparing local patterns vs industry best practices
- ✅ Learning new libraries before integration
- ✅ Finding examples from popular open-source projects

**Best used in**:

- Planning phase (research before implementing)
- Pattern discovery (how do others do this?)
- Framework integration (recommended approaches)

**Integration strategy**:

1. ✅ Add `mcp__deepwiki__ask_question` to: codebase-analyzer, codebase-pattern-finder
2. ✅ Create new **external-research** agent
3. ✅ Update **/create_plan** with external research guidance
4. ✅ Use during planning, not implementation

**Next steps**: See implementation plan below for updating agents and commands.
