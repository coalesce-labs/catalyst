# Moving tickets through workflow, and searching

## Adding comments

> ⛔ **`linearis issues discuss` posts AS THE HUMAN — do not use it for machine replies.** It authenticates with the personal `lin_api_…` token, so the comment carries the human's identity — and the ask-resolution gate (CTL-1567) reads a human-identity comment as *the human deciding* and clears the escalation hold. Post machine replies through the app actor (`Catalyst Cloud`) instead, via `linear-reply.mjs <TICKET-ID> --as <AGENT>` — the canonical copyable invocation is owned by the `linearis` skill's "Core Operations" section; use it from there. For decision/ask tickets use the `catalyst-dev:ask` skill. Full syntax and rationale: `linearis` skill (CTL-1922).

1. Determine which ticket — from conversation context, or read it via the replica (`source "${CLAUDE_PLUGIN_ROOT}/scripts/lib/linear-read-replica.sh"; linear_read_ticket "$TICKET"`) per the `linearis` skill's "Reading Linear" rule.
2. Keep comments concise (~10 lines); focus on key insight; include file references with backticks and GitHub links, for both `thoughts/` and code files.
3. Example:

   ```markdown
   Implemented retry logic in webhook handler to address rate limit issues.

   Key insight: The 429 responses were clustered during batch operations, so exponential backoff
   alone wasn't sufficient - added request queuing.

   Files updated:
   - `src/webhooks/handler.ts` ([GitHub](link))
   ```

## Moving tickets through workflow

1. Get current status by reading the ticket (`linearis issues usage`).
2. Suggest the next status using the `stateMap` transition table — the `linearis` skill's "Workflow: Status Transitions" is the single source; this skill does not restate it.
3. **Automatic status updates**: `/research-codebase`/`/create-plan`/`/implement-plan`/`/create-pr`/`/merge-pr` each move the ticket per `stateMap` — same source, same pointer.
4. Manual updates and transition comments — `linearis issues usage` for syntax.

## Searching for tickets

1. Gather criteria: query text, status, assignee.
2. `issues search` for server-side matching; `issues list` + `jq` for fields search doesn't cover. `--team` requires a UUID on search (czottmann/linearis#56).
3. Present: ticket ID, title, status, assignee, direct link.
