---
name: reorganize
description: Analyze and reorganize a directory structure with safe reference updates
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash, Task, Write
version: 1.0.0
---

# Reorganize Directory

You are tasked with analyzing a directory structure, identifying clutter and organizational issues,
proposing a reorganization plan, and safely executing it with reference updates.

## Initial Response

When invoked, check the argument:

- **If a directory path was provided**: validate it exists and is inside a git repo
- **If no argument**: ask the user which directory to reorganize

```
I'll analyze and reorganize a directory structure.

This command will:
1. Analyze the directory for empty, sparse, and overlapping categories
2. Map cross-references to assess move risk
3. Propose a reorganization plan
4. Execute safely via move-and-rereference.sh after your approval

Which directory should I analyze?
```

## Process

### Step 1: Validate Input

```bash
# Check directory exists
if [[ ! -d "<directory>" ]]; then
  echo "Error: Directory does not exist: <directory>"
  exit 1
fi

# Check git repo
REPO_ROOT=$(cd "<directory>" && git rev-parse --show-toplevel 2>/dev/null)
if [[ -z "$REPO_ROOT" ]]; then
  echo "Error: Directory is not inside a git repository"
  exit 1
fi
```

Determine the relative path of the directory within the repo root. All paths in the analysis and
mapping should be relative to the repo root.

### Step 2: Parallel Analysis

Spawn 3 Task agents simultaneously to analyze the directory.

**Task 1 — Structure Analysis** (subagent_type: Explore):

```
Analyze the directory structure of <directory>. For each subdirectory:
1. Count the number of real files (exclude .gitkeep, .DS_Store)
2. Identify empty directories (0 files)
3. Identify sparse directories (1-2 files)
4. Identify large directories (>20 files)
5. Detect naming overlaps (e.g., notes/ vs meeting-notes/, research/ vs other_research/)

Return a structured report with:
- Directory name, file count, and category (empty/sparse/active/large)
- Any detected naming overlaps with specific directory pairs
- Total file count
```

**Task 2 — Cross-Reference Analysis** (subagent_type: Explore):

```
Analyze cross-references within <directory>. Search all .md files for path references to files and
directories within this directory tree:

1. Grep for path patterns that reference sibling files/directories
2. Count inbound references per directory (how many times paths under that dir are referenced)
3. Identify the highest-risk directories to move (most references)

Return:
- Per-directory reference count (sorted by count, descending)
- Total reference count
- Top 5 most-referenced individual files
```

**Task 3 — Content Analysis** (subagent_type: Explore):

```
Sample files from each subdirectory of <directory> (read first 20 lines of up to 3 files per
subdirectory). For each subdirectory:

1. Categorize the content type (research, plans, notes, meetings, analyses, handoffs, etc.)
2. Flag any files that seem miscategorized (e.g., a meeting note in research/)
3. Note if the subdirectory name accurately describes its content

Return:
- Per-directory content summary (directory name, content type, sample file names)
- List of potentially miscategorized files with suggested locations
```

**WAIT for all 3 tasks to complete.**

### Step 3: Present Findings

Combine the results into a structured report:

```markdown
## Directory Analysis: <directory>

### Summary
- {N} subdirectories, {M} files
- {X} empty directories (can remove)
- {Y} overlapping categories (can merge)
- {Z} sparse directories (can consolidate)

### Empty (can remove)
- decisions/ (0 files)
- journey-maps/ (0 files)
...

### Overlapping (can merge)
- notes/ ({N} files) + meeting-notes/ ({M} files) → notes/
- other_research/ ({N} files) + research/ ({M} files) → research/
...

### Sparse (can consolidate)
- business/ (1 file) → could merge into notes/ or keep
- learnings/ (1 file) → could merge into notes/ or keep
...

### Large (might benefit from subdirectories)
- research/ ({N} files) — consider subfolders by topic
...

### Cross-Reference Impact
- research/ has {N} inbound references (highest risk — most refs to update)
- plans/ has {N} inbound references
- analyses/ has {N} inbound references
...

### Content Issues
- {file} in {dir}/ appears to be a {type}, consider moving to {suggested_dir}/
...
```

### Step 4: Propose Reorganization

Based on the analysis, generate a reorganization proposal. Present it as a table:

```markdown
## Proposed Reorganization

| # | Current Path | Proposed Path | Reason | Risk |
|---|---|---|---|---|
| 1 | decisions/ | (remove) | Empty directory | None |
| 2 | other_research/file.md | research/file.md | Merge into research/ | Low (1 ref) |
| 3 | meeting-notes/file.md | notes/meetings/file.md | Consolidate under notes/ | Medium (3 refs) |
| 4 | research-synthesis/file.md | research/synthesis/file.md | Subdir of research/ | Low (1 ref) |
...

### Not Moving (keeping as-is)
- research/ — active, well-organized (73 files)
- plans/ — active, well-organized (36 files)
- handoffs/ — active, well-organized
...
```

**Ask for user feedback:**

```
Does this reorganization look right?

Options:
1. Approve as-is — proceed to dry run
2. Edit — tell me which rows to change
3. Add more — suggest additional moves
4. Cancel — abort without changes
```

Wait for user response. Iterate on the proposal until approved.

### Step 5: Generate Mapping File

Write the approved mappings to a temporary TSV file:

```bash
MAPPING_FILE="/tmp/reorganize-$(date +%Y%m%d-%H%M%S).tsv"
```

Format: `old_path<TAB>new_path` per line, relative to repo root.

For empty directory removals, note them separately — the script handles file moves, not directory
removal.

### Step 6: Dry Run

Run the backing script in dry-run mode:

```bash
SCRIPT_DIR="${CLAUDE_PLUGIN_ROOT}/scripts"
"${SCRIPT_DIR}/move-and-rereference.sh" --dry-run --verbose --root "$REPO_ROOT" "$MAPPING_FILE"
```

Present the dry-run output to the user. Highlight:
- Number of files that will move
- Number of references that will be updated
- Any files with high reference counts (potential risk)

**Ask for final confirmation:**

```
The dry run shows:
- {N} files will be moved
- {M} references will be updated across {K} files

Proceed with execution? (y/N)
```

### Step 7: Execute

After user confirmation:

```bash
"${SCRIPT_DIR}/move-and-rereference.sh" --execute --verbose --root "$REPO_ROOT" "$MAPPING_FILE"
```

Present the execution report.

### Step 8: Cleanup

After successful execution:

1. **Remove empty directories** left behind:

```bash
# Find and remove empty directories (excluding .git)
find "<directory>" -type d -empty -not -path '*/.git/*' -delete 2>/dev/null
```

2. **Show git status summary**:

```bash
cd "$REPO_ROOT" && git status --short
```

3. **Suggest commit message**:

```
Suggested commit:

  refactor: reorganize <directory> structure

  - Removed {N} empty directories
  - Merged {overlapping dirs} into {target dirs}
  - Consolidated {sparse dirs}
  - Updated {M} cross-references across {K} files
```

4. **Clean up mapping file**:

```bash
rm -f "$MAPPING_FILE"
```

## Important Notes

- **Safety first**: Always dry-run before execute. Always ask for user confirmation.
- **Non-destructive**: Uses `git mv` for tracked files, preserving history.
- **Reference integrity**: Updates all references across the repository, not just within the target
  directory.
- **Iterative**: User can modify the proposal before execution. Multiple rounds of feedback are
  expected.
- **Idempotent backing script**: Running the script again after execution finds nothing to do.

## Error Handling

- If the backing script is not found at `${CLAUDE_PLUGIN_ROOT}/scripts/move-and-rereference.sh`,
  report the error and suggest the user check their plugin installation.
- If `git mv` fails for any file, the script stops and reports the error. The user can fix the
  issue and re-run.
- If the directory has uncommitted changes, warn the user and suggest committing first.
