# Creating tickets from thoughts documents

## Steps

1. **Locate and read the thoughts document** — given a path, read it directly; given a
   topic/keyword, search `thoughts/` with Grep; if multiple matches, show a list and ask.

2. **Analyze the content** — identify the core problem/feature, extract key technical decisions,
   note specific files, look for action items, and judge the stage (ideation vs ready to implement).

3. **Check related context** — read any code files or other thoughts docs it references; look for
   existing Linear tickets mentioned.

4. **Draft the ticket** following the `/catalyst-dev:gherkin-ticket` standard, and present it:

   ```
   ## Draft Linear Ticket

   **Title**: [outcome-first use-case sentence — <actor> should <outcome> [so that <benefit>];
   no mechanism/file/symbol names, no [Component] prefix]

   **Description**:
   [short plain-English use case — who benefits and why]

   [Gherkin acceptance criteria in a ```gherkin fenced block, at the right tier:
    A = features/bugs (full Given/When/Then), B = bugs (Then states correct behavior + # CURRENTLY:),
    C = pure chores (Context/Motivation/Outcome prose)]

   ## Technical notes
   - [implementation detail, constraints — preserved, but BELOW the use case]

   ## References
   - Source: `thoughts/[path]` ([View on GitHub](converted URL))
   - Related code: [any file:line references]
   ```

5. **Interactive refinement** — confirm accuracy, priority (default Medium/3), extra context,
   assignment. Ticket is created in "Backlog" status by default.

6. **Create with Linearis** — `linearis issues usage` for syntax, or see `/catalyst-dev:linearis`.
   `--team` only accepts UUIDs, not keys/names (czottmann/linearis#56) — use `$TEAM_UUID` from
   config. Linearis creates in the team's default backlog state; to set status/assignee, create
   then update. Capture the issue ID from the JSON output with jq.

7. **Link genuine prerequisites as formal blockers (CTL-838)** — set a Linear `blocked_by` link
   now; do NOT rely on mentioning the id in prose (Catalyst does not infer dependencies from text).

   ```bash
   linearis issues update <NEW-TICKET> --blocked-by <PREREQ-TICKET>
   ```

   Link only TRUE prerequisites (must reach Done/Canceled first). Do NOT link across teams for
   auto-sequencing. Missing a blocker is fine (phase-triage does a semantic second pass); a FALSE
   blocker stalls real work, so when in doubt leave it out.

8. **Post-creation** — show the ticket URL; offer to add a comment or update the source thoughts
   doc with the ticket reference:

   ```
   ---
   linear_ticket: [TEAM-123]
   created: [date]
   ---
   ```
