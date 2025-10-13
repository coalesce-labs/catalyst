# Artifacts Directory

This directory contains reusable artifacts that get injected into project files.

## CLAUDE.md.workspace

Canonical workspace section for project CLAUDE.md files.

**Usage**:
- Automatically appended during `./hack/install-project.sh`
- Automatically updated during `./hack/update-project.sh`
- Preserves project-specific content above/below markers

**Markers**:
```markdown
<!-- BEGIN: Ryan Claude Workspace -->
... workspace content ...
<!-- END: Ryan Claude Workspace -->
```

**Editing**:
1. Edit `artifacts/CLAUDE.md.workspace`
2. Test locally: `./hack/update-project.sh .`
3. Verify only workspace section changes
4. Commit and push
5. Projects get update on next `/project:update_project`
