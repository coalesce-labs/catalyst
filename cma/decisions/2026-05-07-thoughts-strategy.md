# ADR: Thoughts context strategy for CMA cloud sessions

- **Status:** Accepted (tentative — supersedable by [CTL-295](https://linear.app/catalyst/issue/CTL-295))
- **Date:** 2026-05-07
- **Ticket:** [CTL-286](https://linear.app/catalyst/issue/CTL-286)
- **Source research:** `thoughts/shared/research/2026-05-07-CTL-286-cma-cloud-environment.md`

## Context

`thoughts/shared/` is a 5.6 MB / 329-file collection of research, plans, decisions, PR descriptions, and PM artifacts. In the local Catalyst workflow it is a symlink to `~/code-repos/github/coalesce-labs/thoughts/repos/catalyst-workspace/shared` (a separate git repository, `coalesce-labs/thoughts`), provisioned by the `humanlayer` CLI on worktree creation. Skills read the directory by direct file path; PostToolUse hooks register every Write into the workflow context.

Inside a Claude Managed Agents (CMA) cloud session, none of that local infrastructure exists. The container has `git`, `curl`, `jq`, and a freshly-built rootfs based on Ubuntu 22.04. There is no `humanlayer` binary and no symlink target to point at. Phase 1 Routines (CTL-287..CTL-291) need to read the same context the local Catalyst workflow does — historical research, project state, prior plans — but the container has none of it on disk at boot.

The CMA session container does have outbound network access (subject to environment allowlist), a `git` binary on PATH, and the ability to mount Memory Stores at `/mnt/memory/<name>/`. The base CMA agent definition can include a startup ritual that runs before the agent's first turn.

## Decision

**Adopt Option C (git clone) for Phase 1.** The base agent's startup ritual shallow-clones the `coalesce-labs/thoughts` repo into the session container and surfaces it under the same `thoughts/{shared,global}` paths that local skills expect.

```bash
# Runs once per session, before the agent's first turn.
git clone --depth=1 \
  "https://x-access-token:${GITHUB_PAT}@github.com/coalesce-labs/thoughts.git" \
  /workspace/thoughts-repo

mkdir -p /workspace/thoughts
ln -s /workspace/thoughts-repo/repos/catalyst-workspace/shared /workspace/thoughts/shared
ln -s /workspace/thoughts-repo/global                          /workspace/thoughts/global
```

Phase 1 routines treat the resulting tree as **read-only**. Write-back, conflict handling, and the question of whether Memory Store should hold a curated mutable subset are all out of scope here and tracked in CTL-295.

## Considered options

| Dimension | A: Memory Store seed | B: rclone / S3 sync | C: git clone (chosen) |
|-----------|----------------------|---------------------|-----------------------|
| Captures full corpus | No — 100 KB/file × 8 stores = ~800 KB max; current shared is 5.6 MB / 329 files | Yes (mirror) | Yes (full repo + history) |
| Setup complexity | High — needs curation logic + sync-to-store pipeline | High — S3 bucket + IAM + rclone in env + sync script | Low — `git clone` against existing repo |
| Session start overhead | None (pre-mounted) | 30–120 s for 5.6 MB / 329 files | 5–15 s (`--depth=1`) |
| Persistence model | Full read-write, immediate cross-session visibility | Read-write only after re-sync; conflicts hard | Read-write into local clone; push-back deferred |
| Multi-session concurrency | First-class — Memory Store has SHA-256 optimistic concurrency | Brittle — last-writer-wins on S3 unless wrapped | Brittle — concurrent pushes need merge logic |
| New credential surface | None | AWS access key in vault | None — reuses GitHub PAT (already needed for GitHub MCP) |
| AI-optimized read pattern | Yes — short paths, mounted natively | No | No |
| Best fit for | Cross-session learned state (preferences, "do not retriage these tickets") | Snapshot read of fixed corpus | Project-state read with full repo context |
| Worst fit for | Bulk historical context | Real-time concurrent writes | Cross-session learned state without merge discipline |

## Rationale

1. **Simplicity unblocks Phase 1.** Git is pre-installed in the CMA environment. The GitHub PAT is already required for the GitHub MCP server. Cloning the thoughts repo at session start is one shell command in the system prompt. No separate infrastructure to provision.
2. **Phase 1 routines are read-heavy.** `groom-backlog`, `report-daily`, `research-codebase`-style routines all read prior context. None of CTL-287..CTL-291 strictly require write-back during the session itself. Read-only access is sufficient.
3. **Memory Store is for a different problem.** Memory Store fits a small, evolving, structured set of facts — agent preferences, ticket-triage exclusions, cross-session learned state. Forcing a 5.6 MB / 329-file repo into 100 KB-per-file × 8-store envelope means heavy curation work that this ticket should not attempt. Memory Store is better reserved for Phase 2+ shared-state needs.
4. **Option B adds infrastructure without payoff.** S3 sync gives nothing git clone doesn't, plus introduces an S3 bucket and IAM credentials.
5. **CTL-295 is the long-term answer.** This decision is explicitly tentative. CTL-295 is the dedicated ticket for the deeper exploration: write-back model, conflict handling, hybrid (git for read + Memory Store for cross-session mutable state).

## Consequences

### Positive
- Simplest possible implementation — one shell command in the startup ritual.
- Full thoughts content available, not a curated subset.
- No new credentials beyond the GitHub PAT already needed for the GitHub MCP connector.
- `git log` available inside the container for any routine that wants history.

### Negative
- Read-only by default; routines that want to record findings must defer write-back to a separate post-session step (handled by orchestrator, not by routines).
- Cloning at session start adds 5–15 s to first-turn latency. Acceptable for routines that run on a schedule, not interactive UX.
- Reuses the GitHub MCP PAT for thoughts access — a leak compromises both. Documented as a known trade-off in `cma/mcp/github.md`. Mitigation: rotate or split the PAT later (CTL-295 may revisit).

### Neutral
- The clone lives at `/workspace/thoughts-repo/`; symlinks at `/workspace/thoughts/{shared,global}` mirror the local Catalyst layout. Routines do not need to know whether they are running locally or in CMA.

## Implementation

The startup ritual is encoded in the base agent's system prompt (see `cma/agents/base-system-prompt.md`). The PAT is sourced from the GitHub MCP vault entry — exposed to the container as `GITHUB_PAT` env var at session creation. The required PAT scope is documented in `cma/mcp/github.md`: `Repository access` includes both `coalesce-labs/catalyst` and `coalesce-labs/thoughts`; `Repository permissions` for the thoughts repo is `Contents: Read` only.

The session container is ephemeral — the cloned tree is discarded at session end. There is no cleanup step required.

## Open questions for CTL-295

- **Write-back model.** Do routines write back? If yes, does each routine push directly, or does the orchestrator collect fragments and push as a single commit?
- **Per-write vs per-session push.** If write-back exists, does it happen per session (push at session end) or in-process (push every N writes)?
- **Conflict handling.** What happens when two concurrent sessions write the same file?
- **Memory Store split.** Is Memory Store the better long-term home for the small mutable subset (agent preferences, ticket triage exclusions, cross-session learned state)? Hybrid: git for read of historical corpus + Memory Store for mutable shared state?
- **PAT rotation / scope split.** Should the thoughts-repo clone PAT be split from the GitHub MCP PAT, despite the small scope difference, to limit blast radius?

These questions are explicitly out of scope for CTL-286 and tracked in CTL-295.
