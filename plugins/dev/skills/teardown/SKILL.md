---
name: teardown
description:
  "Safely delete orchestrator runtime state — worktrees and ~/catalyst/runs/{orchId} — after
  archiving artifacts to ~/catalyst/archives/{orchId}. **ALWAYS use when** the user says
  'teardown', 'delete orchestrator', 'cleanup orchestrator', or 'remove worktree' for a finished
  orchestrator. Refuses to delete unless the archive sweep succeeded; use --force to bypass."
disable-model-invocation: false
allowed-tools: Read, Bash, Glob
---

# Teardown

Safely delete orchestrator runtime artifacts (runs directory + worktrees) **after** archiving
them to `~/catalyst/archives/{orchId}/` and recording them in the SQLite index. The goal: once
an orchestrator is finished, its artifacts survive even when worktrees and runtime directories
are reaped.

## When to run

- After a completed orchestrator, once `orchestrate` Phase 7 has run the archive sweep. The
  sweep is automatic; teardown is explicit — the user invokes it when they no longer need
  the live worktree and runs directory.
- Manually: `claude /catalyst-dev:teardown <orchId>` to clean up a finished orchestrator.
- During disk cleanup: teardown refuses to delete unless the archive exists, so running it
  against an un-archived orchestrator is safe (it will archive first, then delete).

## Preconditions

An orchestrator is **teardown-safe** when ALL of these are true:

- `~/catalyst/runs/{orchId}/state.json` exists and reports `status` in `{done, complete, failed}`.
- The archive sweep has succeeded: `~/catalyst/archives/{orchId}/metadata.json` exists and the
  SQLite row for `{orchId}` is present in `orchestrators`.
- No worker signal file has `status: "in_progress"` or an `alive` PID.

Use `--force` to bypass the preconditions (you own the consequences).

## Procedure

1. **Arguments**

   ```
   /catalyst-dev:teardown <orchId> [--force] [--dry-run]
   ```

   - `<orchId>` — required. Must match `/^[A-Za-z0-9._-]+$/`.
   - `--force` — skip safety checks.
   - `--dry-run` — print what would be deleted without deleting.

2. **Archive sweep (prerequisite)**

   Before deleting anything, run the sweep to make sure artifacts are persisted:

   ```bash
   bun plugins/dev/scripts/orch-monitor/catalyst-archive.ts sweep "<orchId>"
   ```

   If the sweep exits non-zero AND `--force` is not set, abort with a message that explains
   what's missing. The sweep is idempotent, so re-running it is safe.

3. **Enumerate deletion candidates**

   - Runtime directory: `~/catalyst/runs/<orchId>/`
   - Worktrees: anything listed in `git worktree list --porcelain` whose branch name
     contains `<orchId>`.

   Print the candidates.

4. **Safety gate**

   For each candidate, verify:

   - The directory exists.
   - For worktrees: `git -C <worktree> status --porcelain` is clean (or `--force`).
   - For the runs dir: no `workers/*.json` has `status: "in_progress"` or `alive: true`
     (or `--force`).

5. **Delete**

   - `git worktree remove <path>` for each worktree (add `--force` if step 4 flagged dirty
     state AND user passed `--force`).
   - `rm -rf ~/catalyst/runs/<orchId>/` for the runs directory.

6. **Verify**

   - Re-run the archive listing to confirm the orchestrator is still discoverable:

     ```bash
     bun plugins/dev/scripts/orch-monitor/catalyst-archive.ts list --orch "<orchId>" --json
     ```

   - The SQLite row must still exist and `archive_path` must still point to a real directory.

## Output

On success, print a summary:

```
Teardown complete for <orchId>
  archived to: ~/catalyst/archives/<orchId>/
  deleted:
    runs: ~/catalyst/runs/<orchId>/
    worktrees: <paths...>
```

On refusal (preconditions failed and no `--force`), print what's blocking and exit non-zero.

## Related

- `/catalyst-dev:orchestrate` Phase 7 — runs the sweep automatically when orchestration ends.
- `bun plugins/dev/scripts/orch-monitor/catalyst-archive.ts` — the archive CLI with
  `sweep|sync|prune|list|show` subcommands.
- See `docs/architecture.md` § "Artifact Persistence" for the end-to-end lifecycle.
