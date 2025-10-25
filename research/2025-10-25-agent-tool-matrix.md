# Agent Tool Matrix

## Tool Categories

### Context Tools (for local codebase/thoughts)
- Read, Grep, Glob, Bash(ls *)

### External Library/Framework Research
- `mcp__context7__resolve_library_id`
- `mcp__context7__get_library_docs`
- `mcp__deepwiki__ask_question`
- `mcp__deepwiki__read_wiki_structure`

### Web Search (when docs insufficient)
- `mcp__exa__search`
- `mcp__exa__search_code`

### CLI Tools (infrastructure research)
- Bash(linearis *), Bash(railway *), Bash(gh *), Bash(sentry-cli *)

## Agent Tool Assignments

### Core Research Agents (Local Codebase)

**codebase-locator**
- Tools: `Grep, Glob, Bash(ls *)`
- Why: File finding only, no external research needed

**codebase-analyzer**
- Tools: `Read, Grep, Glob, Bash(ls *), mcp__deepwiki__*, mcp__context7__*`
- Why: May need to understand frameworks/libraries used in code

**codebase-pattern-finder**
- Tools: `Grep, Glob, Read, Bash(ls *), mcp__deepwiki__*, mcp__context7__*`
- Why: Comparing local patterns with framework best practices

**thoughts-locator**
- Tools: `Grep, Glob, Bash(ls *)`
- Why: Document finding only

**thoughts-analyzer**
- Tools: `Read, Grep, Glob, Bash(ls *)`
- Why: Analyzing existing documents only

**external-research**
- Tools: `mcp__deepwiki__*, mcp__context7__*, mcp__exa__*`
- Why: Pure external research - frameworks, libraries, web content

### Infrastructure Research Agents (CLI-based)

**linear-research**
- Tools: `Bash(linearis *), Read, Grep`
- Why: Linear CLI provides all data, no external docs needed

**railway-research**
- Tools: `Bash(railway *), Read, Grep`
- Why: Railway CLI provides all data, no external docs needed

**github-research**
- Tools: `Bash(gh *), Read, Grep`
- Why: GitHub CLI provides all data, no external docs needed

**sentry-research**
- Tools: `Bash(sentry-cli *), Read, Grep, mcp__context7__*`
- Why: Sentry CLI + docs for error investigation patterns

## Rationale

### When to Include External Research Tools:

✅ **Include Context7/DeepWiki when**:
- Agent analyzes code that uses frameworks/libraries
- Agent compares patterns with framework conventions
- Agent researches error messages that reference external systems (Sentry)

❌ **Exclude Context7/DeepWiki when**:
- Agent only searches/reads local files
- CLI tool provides comprehensive output (linearis, railway, gh)
- Agent is purely organizational (locator, thoughts)

✅ **Include Exa when**:
- Agent needs general web research
- Documentation is insufficient or outdated
- Need to find blog posts, discussions, solutions

❌ **Exclude Exa when**:
- CLI tool output is sufficient
- Local files contain all information
- Structured docs (Context7/DeepWiki) are better

## Updated Agent Definitions

### codebase-locator.md
```yaml
tools: Grep, Glob, Bash(ls *)
```

### codebase-analyzer.md
```yaml
tools: Read, Grep, Glob, Bash(ls *), mcp__deepwiki__ask_question, mcp__context7__get_library_docs, mcp__context7__resolve_library_id
```

### codebase-pattern-finder.md
```yaml
tools: Grep, Glob, Read, Bash(ls *), mcp__deepwiki__ask_question, mcp__deepwiki__read_wiki_structure, mcp__context7__get_library_docs, mcp__context7__resolve_library_id
```

### thoughts-locator.md
```yaml
tools: Grep, Glob, Bash(ls *)
```

### thoughts-analyzer.md
```yaml
tools: Read, Grep, Glob, Bash(ls *)
```

### external-research.md
```yaml
tools: mcp__deepwiki__ask_question, mcp__deepwiki__read_wiki_structure, mcp__context7__get_library_docs, mcp__context7__resolve_library_id, mcp__exa__search, mcp__exa__search_code
```

### linear-research.md (NEW)
```yaml
tools: Bash(linearis *), Read, Grep
```

### railway-research.md (NEW)
```yaml
tools: Bash(railway *), Read, Grep
```

### github-research.md (NEW)
```yaml
tools: Bash(gh *), Read, Grep
```

### sentry-research.md (NEW)
```yaml
tools: Bash(sentry-cli *), Read, Grep, mcp__context7__get_library_docs, mcp__context7__resolve_library_id
```
