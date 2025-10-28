---
description: Create conventional commits for session changes
category: version-control-git
tools: Bash, Read
model: inherit
version: 2.0.0
---

# Commit Changes

You are tasked with creating git commits using conventional commit format for the changes made
during this session.

## Process:

1. **Analyze what changed:**
   - Review the conversation history and understand what was accomplished
   - Run `git status` to see current changes
   - Run `git diff --cached` to see staged changes (if any)
   - Run `git diff` to see unstaged changes
   - Get changed file list: `git diff --name-only` and `git diff --cached --name-only`

2. **Auto-detect conventional commit components:**

   **Type detection (suggest to user):**
   - If only `*.md` files in `docs/`: suggest `docs`
   - If only test files (`*test*`, `*spec*`): suggest `test`
   - If `package.json`, `*.lock` files: suggest `build`
   - If `.github/workflows/`: suggest `ci`
   - If mix of changes: suggest `feat` or `fix` based on context
   - Otherwise: ask user to choose from: `feat`, `fix`, `refactor`, `chore`, `docs`, `style`,
     `perf`, `test`, `build`, `ci`

   **Scope detection (suggest to user):**
   - Parse changed file paths
   - Map to scopes:
     - `agents/*.md` → `agents`
     - `commands/*.md` → `commands`
     - `hack/*` → `hack`
     - `docs/*.md` → `docs`
     - `.claude/` → `claude`
     - Multiple dirs or root files → empty scope (cross-cutting)

   **Extract ticket reference:**
   - Get current branch: `git branch --show-current`
   - Extract ticket pattern: `{PREFIX}-{NUMBER}` (e.g., RCW-13, ENG-123)
   - Will be added to commit footer

3. **Generate conventional commit message:**

   **Format:**

   ```
   <type>(<scope>): <short summary>

   <body - optional but recommended>

   <footer - ticket reference>
   ```

   **Rules:**
   - Header max 100 characters
   - Type: lowercase
   - Subject: imperative mood, no period, no capital first letter
   - Body: explain WHY, not what (optional for simple changes)
   - Footer: `Refs: TICKET-123` if ticket in branch name

   **Example:**

   ```
   feat(commands): add conventional commit support to /catalyst-dev:commit

   Updates the commit command to automatically detect commit type
   and scope from changed files, following conventional commits spec.
   Extracts ticket references from branch names for traceability.

   Refs: RCW-13
   ```

4. **Present plan to user:**
   - Show detected type and scope with confidence
   - Show generated commit message
   - Explain: "Detected changes suggest: `<type>(<scope>): <summary>`"
   - List files to be committed
   - Ask: "Proceed with this commit? [Y/n/e(dit)]"
     - Y: execute as-is
     - n: abort
     - e: allow user to edit message

5. **Execute commit:**
   - Stage files: `git add <specific-files>` (NEVER use `-A` or `.`)
   - Create commit with message
   - Show result: `git log --oneline -n 1`
   - Show summary: `git show --stat HEAD`

## Configuration

Reads from `.claude/config.json`:

```json
{
  "catalyst": {
    "commit": {
      "useConventional": true,
      "scopes": ["agents", "commands", "hack", "docs", "claude", "config"],
      "autoDetectType": true,
      "autoDetectScope": true,
      "requireBody": false
    },
    "project": {
      "ticketPrefix": "RCW"
    }
  }
}
```

## Type Reference

**Types that appear in CHANGELOG:**

- `feat` - New feature
- `fix` - Bug fix
- `perf` - Performance improvement
- `revert` - Revert previous commit

**Internal types:**

- `docs` - Documentation only
- `style` - Formatting, no code change
- `refactor` - Code restructuring, no behavior change
- `test` - Adding/updating tests
- `build` - Build system or dependencies
- `ci` - CI/CD configuration
- `chore` - Maintenance tasks

## Examples

**Feature:**

```
feat(agents): add codebase-pattern-finder agent

Implements new agent for finding similar code patterns across
the codebase with concrete examples and file references.

Refs: RCW-45
```

**Fix:**

```
fix(commands): handle missing PR template gracefully

Previously crashed when thoughts/shared/pr_description.md was
missing. Now provides clear error with setup instructions.

Refs: RCW-78
```

**Documentation:**

```
docs(hack): add README for installation scripts

Documents all scripts in hack/ directory with usage examples
and explains when to use each installation method.

Refs: RCW-12
```

**Chore (no ticket):**

```
chore(config): update conventional commit scopes

Adds new scopes for agents and commands directories.
```

## Important:

- **NEVER add co-author information or Claude attribution**
- Commits should be authored solely by the user
- Do not include any "Generated with Claude" messages
- Do not add "Co-Authored-By" lines
- Write commit messages as if the user wrote them
- Use conventional format for consistency and changelog generation
- Keep header under 100 characters
- Use imperative mood: "add feature" not "added feature"

## Remember:

- You have the full context of what was done in this session
- Group related changes together logically
- Keep commits focused and atomic when possible
- The user trusts your judgment - they asked you to commit
- Suggest type and scope based on file analysis
- Extract ticket from branch name automatically
- Allow user to override suggestions
