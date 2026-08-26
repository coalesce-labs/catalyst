# Step 13 — Final State, Errors, and Examples

## Report the actual merge state — not just "PR created"

**CLEAN (ready to merge):**

```
✅ PR #{number} ready to merge

PR: #{number} - {title}
URL: {url}
Base: {base_branch}
Ticket: {ticket} (moved to "In Review")

Status:
  ✅ CI checks passed
  ✅ Review comments addressed ({N} resolved)
  ✅ No merge blockers

Merge with: /catalyst-dev:merge-pr
```

**Blockers remain:**

```
PR #{number} created — {N} blocker(s) remain

PR: #{number} - {title}
URL: {url}

Resolved:
  ✅ {what was fixed}

Still blocking:
  ❌ {specific blocker and exactly what's needed to resolve it}
```

## Error handling

**On main/master:** `❌ Cannot create PR from main branch.` — suggest `git checkout -b TICKET-123-feature-name`.

**Rebase conflicts:** list conflicting files; instruct `git add <resolved-files>`, `git rebase --continue`, then re-run `/catalyst-dev:create-pr`.

**GitHub CLI not configured:** `gh auth login`, then `gh repo set-default`.

**Linearis CLI not found:** warn, PR still created successfully; `npm install -g linearis` + `export LINEAR_API_TOKEN=...` to fix.

**Linear ticket not found:** warn, PR still created successfully; update manually or check the ticket ID.

## Examples

**Branch `ENG-123-implement-pr-lifecycle`:**

```
Extracting ticket: ENG-123
Generated title: "ENG-123: Implement pr lifecycle"
Creating PR... ✅ PR #2 created
Calling /catalyst-dev:describe-pr...
Updating Linear ticket ENG-123 → In Review
✅ Complete!
```

**Branch `feature-add-validation` (no ticket):**

```
No ticket found in branch name
Generated title: "Feature add validation"
Creating PR... ✅ PR #3 created
Calling /describe-pr... ⚠️  No Linear ticket to update
✅ Complete!
```

## Integration with other commands

- Calls `/commit` if there are uncommitted changes (optional).
- Always calls `/describe-pr` to generate the comprehensive description.
- Sets up for `/merge-pr` once the PR reaches a clean state.

## Remember

- **Never stop at "PR created"** — poll (event-driven, 3-min minimum wait) checking CI, reviews, and PR state; address comments, fix CI failures, confirm clean merge state.
- **"PR created with auto-merge" is NOT done** — poll until MERGED or genuinely human-blocked.
- Automated reviewer comments are yours to address, not the human's.
- Minimize prompts — only ask when a PR already exists. Auto-rebase, auto-link Linear, auto-describe.
- Fail fast on conflicts/errors; degrade gracefully if Linearis isn't installed.
- For Linearis CLI syntax, see the `linearis` skill reference.
