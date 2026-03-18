---
name: audit-references
description: Audit plugin health and find broken references in manifests, commands, agents, and skills
disable-model-invocation: true
allowed-tools: Bash, Read, Task, Glob, Grep, Edit
version: 1.0.0
---

# Audit References

You are tasked with auditing plugin health by finding broken references across all plugin manifests,
commands, agents, skills, and documentation.

## Initial Response

When invoked, immediately run the backing script to gather results:

```bash
SCRIPT_DIR="${CLAUDE_PLUGIN_ROOT}/scripts"
"${SCRIPT_DIR}/audit-references.sh" --json --all
```

Parse the JSON output to understand the full picture.

## Process

### Step 1: Run the Audit

Run the script with `--json` to get machine-readable output. The script checks three severity
levels:

1. **CRITICAL** — Manifest entries (`plugin.json`) pointing to files that don't exist on disk
2. **WARNING** — Path references in plugin source files (commands, agents, skills) that don't resolve
3. **INFO** — Stale path references in documentation (cosmetic)

### Step 2: Categorize and Present Results

Present findings grouped by severity:

```markdown
## Plugin Reference Audit

### CRITICAL ({count})
These manifest entries declare files that don't exist. Plugins will fail to load these.

| Plugin | Manifest | Reference | Detail |
|--------|----------|-----------|--------|
| {plugin} | {manifest} | {ref} | {detail} |

### WARNING ({count})
Path references in plugin source files that don't resolve.

| Source File | Line | Reference | Detail |
|-------------|------|-----------|--------|
| {file} | {line} | {ref} | {detail} |

### INFO ({count})
Stale documentation references (cosmetic only).

| Source File | Line | Reference |
|-------------|------|-----------|
| {file} | {line} | {ref} |
```

### Step 3: Attempt Auto-Resolution (CRITICAL and WARNING only)

For each broken reference at CRITICAL or WARNING level, try to find the actual file:

**For CRITICAL (manifest entries):**

1. Extract the filename from the broken path (e.g., `commands/deep_research.md`)
2. Search the plugin directory for that filename using Glob
3. If found elsewhere, report the correct path
4. If not found anywhere, mark as genuinely missing

**For WARNING (source references):**

1. Extract the filename from the broken path
2. Search the repo for files with that name using Glob
3. If found, suggest the reference update
4. If not found, it may be a removed file — suggest removing the reference

### Step 4: Present Resolution Plan

```markdown
## Resolution Plan

### Auto-fixable ({count})
These broken references have clear fixes:

| # | File | Line | Current Reference | Suggested Fix | Confidence |
|---|------|------|-------------------|---------------|------------|
| 1 | {file} | {line} | {old_ref} | {new_ref} | High |
| 2 | {file} | {line} | {old_ref} | {new_ref} | Medium |

### Needs Manual Review ({count})
These references couldn't be auto-resolved:

| File | Line | Reference | Reason |
|------|------|-----------|--------|
| {file} | {line} | {ref} | File not found anywhere in repo |

### Safe to Ignore ({count})
These are documentation examples, templates, or prose references:

| File | Line | Reference | Why Safe |
|------|------|-----------|----------|
| {file} | {line} | {ref} | Example path in documentation |

Would you like me to:
1. Apply all auto-fixes
2. Apply fixes selectively (I'll ask about each)
3. Just show the report (no changes)
```

Wait for user response.

### Step 5: Apply Fixes (if approved)

For each approved fix:

- **Manifest entries**: Use Edit to update the path in `plugin.json`
- **Source references**: Use Edit to update the path in the source file
- **Removed files**: Use Edit to remove or update the stale reference

After applying fixes, re-run the audit to verify:

```bash
"${SCRIPT_DIR}/audit-references.sh" --json
```

Present the before/after comparison:

```markdown
## Audit Results After Fix

| Severity | Before | After |
|----------|--------|-------|
| CRITICAL | {before} | {after} |
| WARNING | {before} | {after} |
| INFO | {before} | {after} |

{remaining issues if any}
```

## Important Notes

- **Non-destructive by default**: Only makes changes after user approval
- **Manifest fixes are highest priority**: CRITICAL issues mean plugins won't load correctly
- **`${CLAUDE_PLUGIN_ROOT}` paths are excluded**: These resolve at runtime and are always valid
- **Template/example paths are excluded**: Paths containing YYYY, XXXX, or example names are skipped
- **Re-run after fixes**: Always verify changes by re-running the audit
- The backing script can also be run standalone: `plugins/meta/scripts/audit-references.sh`
- For CI usage, run with `--json` and check the `critical` count in the output

## Error Handling

- If the audit script is not found, report the error and suggest checking the plugin installation
- If `jq` is not installed, the script will report this as a CRITICAL issue
- If not in a git repository, the script will exit with an error
