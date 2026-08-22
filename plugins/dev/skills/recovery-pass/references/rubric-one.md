# Rubric One — Done-judgment over a PR-state ticket

> You are a senior engineer with the authority to move a ticket to Done autonomously. This is NEVER a
> mechanical merge→Done, and it is NOT a fail-closed gate that refuses you (the owner removed that
> handcuff — see "Consistency with the code" in the SKILL.md). It is a JUDGMENT you make after reading
> the facts and remediating every open PR yourself. The open-PR check is FACTS you read, not an
> auto-refuse and not an auto-escalate. You escalate (Rubric Three) ONLY when an open PR presents a
> genuine judgment call you cannot safely decide — never just because an open PR exists.
>
> **STEP PR-1 — Enumerate ALL the ticket's PRs (open + merged + closed) — the FACTS.** Run `gh pr
> list --search "<TICKET>" --state all --json number,title,state,mergedAt,isDraft,reviewDecision` (a PR
> is merged when `state == "MERGED"` / `mergedAt` is non-null — there is no `merged` JSON field).
> Also read `workers/<T>/phase-pr.json` and `workers/<T>/phase-monitor-merge.json` for `.pr.number`;
> also check `gh pr list --head "<branch>"` (the `ryan/<ticket>-slug` Linear branch — catches human
> PRs whose title omits the key); and the ticket's **Linear attachments** (linked PRs) via
> `catalyst-linear read <T>` (source:replica — NEVER bare `linearis`). Union all PR numbers. The
> facts helper `open-pr-gate.mjs` (`defaultCheckOpenPrs`) already UNIONs exactly these three
> discovery passes and confirms OPEN state via `gh` — it is the single source of truth for "which PRs
> are still open"; `gh` directly is the manual equivalent. The signal file records only the
> phase-pr agent's OWN PR — never trust it as the complete set.
>
> **STEP PR-2 — THE MULTI-PR TRAP: reason about EACH open PR and remediate it YOURSELF.** Do NOT mark
> the ticket Done just because ONE of several PRs merged. For EVERY PR in the union with
> `state:"open"`, make a senior-engineer call:
>
> - **Still needed / part of the solution** → **FINISH it**: rebase, fix CI, merge it via Rubric
>   Two's rc=0/1/2/3 flow. If the enumerator printed it as `owner/repo#n` (cross-repo), pass
>   `-R <owner/repo>` on the merge so you don't merge the ticket-repo's same-numbered PR instead.
> - **Abandoned / superseded** (a later PR replaced it, a dead spike, a duplicate, scope dropped) →
>   **CLOSE it yourself**: `gh pr close <n> -R <owner/repo> --comment "<why — superseded by #X /
>   abandoned spike / duplicate of #Y / scope moved to CTL-NNN>"`. ALWAYS pass `-R <owner/repo>` when
>   the open-PR enumerator reported the PR in a repo OTHER than the ticket's own. Closing a dead PR is
>   an autonomous senior-engineer call, NOT an escalation.
> - **Genuine judgment call** — the open PR conflicts with an ADR/principle you must not override, OR
>   you genuinely cannot safely decide needed-vs-abandoned → **escalate (Rubric Three)**. This is the
>   ONLY open-PR branch that escalates.
>
> Loop until NO open PR remains that SHOULD remain (every one is finished/merged, or closed, or
> escalated). A stale/BEHIND open PR, a red-CI open PR with a deterministic fix, and an abandoned PR
> are NEVER escalations — you remediate them here.
>
> **STEP PR-3 — Read the plan (deliverable scope).** Spawn the `thoughts-locator` subagent (via the
> Task tool) to find docs in `thoughts/shared/{plans,prs,research}/` mentioning the ticket; spawn
> `thoughts-analyzer` on the most recent plan. Extract the declared deliverable scope. No plan doc →
> fall back to `catalyst-linear read <T>` for the description+title.
>
> **STEP PR-4 — Deliverable completeness (judgment, not a block).** Cross-reference each merged PR's
> coverage against the plan's declared deliverable. Work that is in NO PR at all (never built) and is
> load-bearing → escalate (`escalation_type:"decision"`: reopen vs. scope a new ticket) — do NOT Done
> over a missing deliverable.
>
> **STEP PR-5 — Children gate.** `catalyst-linear read <T>` → `.children`. Any child in a
> non-terminal state that the plan says is in-scope for this parent → do NOT Done it. Surface the
> open children as the real blockers.
>
> **STEP PR-6 — Mark the ticket Done autonomously (no human in the loop).** Once every open PR is
> finished/merged or closed (PR-2), the deliverable is covered (PR-4), and no non-terminal in-scope
> child remains (PR-5), confirm live state is non-terminal (`catalyst-linear read <T>` —
> verify-before-act), then declare Done. **The CLI surface is POSITIONAL: `declare <TICKET>` — ticket
> is a positional arg, the author flag is `--by` (NOT `--declared-by`), `--state` defaults to `done`.
> There is no `--ticket` flag; an unknown `--` flag makes the CLI error out.**
>
> ```bash
> # Use the catalyst-linear-reconcile WRAPPER (prefers bun, node fallback) — NOT bare `node`.
> # The CLI's default current-state reader imports bun:sqlite; under node it degrades to
> # unknown-current, so a `--state done` write is SKIPPED as "unknown-current-unsafe" WHILE
> # the CLI still exits 0 (it persisted the declaration). Use bun so the current-state read
> # is real and the Done write actually lands.
> "${EXEC_CORE%/*}/catalyst-linear-reconcile" declare "$TICKET" \
>   --by "recovery-pass" --state done ${BRANCH:+--branch "$BRANCH"} \
>   --prs-closed "$PRS_CLOSED" --prs-kept "$PRS_KEPT" --open-prs-at-done "$PRS_STILL_OPEN"
> ```
>
> Pass your PR-2 tallies: `--prs-closed` = how many abandoned/superseded PRs you closed;
> `--prs-kept` = how many you finished/merged as part-of-solution; `--open-prs-at-done` = how many
> are STILL open at the Done (this should be **0** for a clean delegate Done). Then record the win:
>
> ```bash
> node "${EXEC_CORE}/recovery-emit.mjs" fixed --ticket "$TICKET" \
>   --reason "Reasoned about every open PR (finished/merged the needed, closed the abandoned); deliverable verified against plan; declared Done."
> _rp_comment "$TICKET" "✅ **recovery-pass** resolved every open PR (merged the needed, closed the abandoned) + verified the plan deliverable → declared Done."
> ```
>
> **STEP PR-7 — When to escalate instead of Done (genuine judgment ONLY → Rubric Three):**
> a. An open PR conflicts with an ADR/principle you must not override.
> b. You genuinely cannot safely decide an open PR's needed-vs-abandoned.
> c. Plan declared N PRs; M<N merged, the rest CLOSED — and ship-now-vs-new-ticket is a real call.
> d. Merged-PR diff misses a plan-declared subsystem that's in NO PR (partial, load-bearing deliverable).
> e. Non-terminal in-scope children that the plan owns under this parent.
> f. No plan doc AND ambiguous Linear description — escalate rather than guess.
>
> NOT escalations (you remediate these in PR-2 yourself): a stale/BEHIND open PR (rebase + merge it),
> a red-CI open PR with a deterministic fix (fix it, push, re-check), an abandoned/superseded open PR
> (close it). Mechanically-resolvable ⇒ FIX; genuine-judgment ⇒ escalate.
