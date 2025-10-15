# Prompts Directory

This directory contains **unstructured, project-specific customization logic** that doesn't fit in `config.json`.

## Purpose

**config.json** = Structured data (IDs, URLs, booleans, arrays)
**prompts/** = Unstructured logic (classification rules, custom prompts, decision trees)

## Use Cases

### 1. Label Classification Rules

Create `classify-issue.md` with project-specific classification logic:

```markdown
# Project-Specific Issue Classification

## Custom Keywords

- "hotfix" → type: bug, priority: urgent
- "spike" → type: research
- "tech-debt" → type: refactor

## Area Detection

- Files in `packages/api/` → area: api
- Files in `packages/web/` → area: frontend
- Files in `packages/db/` → area: database

## Special Rules

- Issues mentioning "breaking" → add breaking-change label
- Issues with <50 char description → add needs-grooming label
```

Reference in config.json:

```json
{
  "linear": {
    "labels": {
      "classificationPrompt": ".claude/prompts/classify-issue.md"
    }
  }
}
```

### 2. Custom Validation Logic

Create `custom-validation.md` with project-specific rules:

```markdown
# Validation Rules

## PR Requirements

- All PRs must reference a Linear ticket
- Breaking changes require ADR
- Database migrations must have rollback plan

## Commit Requirements

- Scope must match directory changed
- Type must be one of: feat, fix, refactor, docs, test
```

### 3. Team-Specific Templates

Create templates for your team's workflow:

```markdown
# RFC Template

## Problem Statement

[What problem are we solving?]

## Proposed Solution

[How will we solve it?]

## Alternatives Considered

[What other approaches did we consider?]
```

## How Commands Use Prompts

Commands read prompt files and inject content into their execution:

```bash
# In a command that supports custom prompts
CLASSIFICATION_PROMPT=$(jq -r '.linear.labels.classificationPrompt' .claude/config.json)

if [[ -f "$CLASSIFICATION_PROMPT" ]]; then
  # Read custom classification logic
  custom_rules=$(cat "$CLASSIFICATION_PROMPT")

  # Inject into AI prompt
  echo "Use these project-specific classification rules:"
  echo "$custom_rules"
fi
```

## Best Practices

### 1. Version with Project

Commit prompts to your project repository:

```bash
git add .claude/prompts/
git commit -m "Add custom classification rules"
```

**Why**: Your team shares the same logic.

### 2. Use Examples as Templates

Copy `.example` files and customize:

```bash
cp classify-issue.md.example classify-issue.md
# Edit classify-issue.md with your project's keywords
```

### 3. Keep Prompts Focused

Each prompt file should have a single, clear purpose. Don't create monolithic files.

### 4. Document Context

Add comments explaining why rules exist:

```markdown
## Area Detection

# We use area labels to route issues to the right team

# Frontend team monitors "area: frontend"

# Backend team monitors "area: api"
```

## Advanced: Personal Prompts

See `.personal/prompts/` for individual developer customization (not shared with team).

## Summary

**Prompts enable**:

- ✅ Project-specific without editing command files
- ✅ Markdown for readability (not JSON)
- ✅ Optional (commands work without prompts)
- ✅ Versionable (commit with project)
- ✅ Shareable (team uses same rules)

**When to use**:

- Classification logic too complex for config
- Team-specific workflows or templates
- Custom validation rules
- Decision trees or scoring algorithms
