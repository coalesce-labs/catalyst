# Orchestration Dashboard

**Orchestrator:** ${ORCH_NAME}
**Started:** ${STARTED_AT}
**Project:** ${PROJECT_NAME}
**Base branch:** ${BASE_BRANCH}
**Total:** ${TOTAL_TICKETS} tickets | ${TOTAL_WAVES} waves | Max parallel: ${MAX_PARALLEL}

## Current Wave: ${CURRENT_WAVE} of ${TOTAL_WAVES}

| Ticket | Title | Status | PR | PR Opened | Auto-Merge Armed | Merged | Unit Tests | API Tests | Functional | Security | Code Review | Verified | Fix-up Commit | Follow-up To |
|--------|-------|--------|-----|-----------|------------------|--------|-----------|-----------|------------|----------|-------------|----------|---------------|--------------|
| ${TICKET_ID} | ${TITLE} | ${STATUS} | ${PR_LINK} | ${PR_OPENED_AT} | ${AUTO_MERGE_ARMED_AT} | ${MERGED_AT} | ${UNIT} | ${API} | ${FUNC} | ${SEC} | ${REVIEW} | ${VERIFIED} | ${FIXUP_COMMIT} | ${FOLLOW_UP_TO} |

`PR Opened` and `Merged` are tracked separately because workers exit at "PR open + auto-merge
armed" (their success contract) while actual merge detection happens later in the orchestrator's
Phase 4 poll loop — the gap between them is CI + review + merge-queue latency, not worker time.

`Fix-up Commit` and `Follow-up To` track post-merge recovery paths:
- `Fix-up Commit` — short SHA of a fix-up worker's remediation commit on an already-open PR
  (Pattern A). Empty for normal workers.
- `Follow-up To` — parent ticket ID for follow-up tickets filed after the parent PR was already
  merged (Pattern B). Empty for normal workers and fix-up workers.

See the orchestrate skill's "Recovery Paths" section for how these are generated via
`orchestrate-fixup` / `orchestrate-followup`.

## Upcoming Waves

### Wave ${NEXT_WAVE} (blocked on Wave ${CURRENT_WAVE})

| Ticket | Title | Depends On |
|--------|-------|------------|
| ${TICKET_ID} | ${TITLE} | ${DEPENDS_ON} |

## Completed Waves

### Wave ${PREV_WAVE}

| Ticket | PR | Duration | Remediation |
|--------|-----|----------|-------------|
| ${TICKET_ID} | ${PR_LINK} | ${DURATION} | ${REMEDIATION_NOTE} |

## Event Log

- ${TIMESTAMP} — ${EVENT_DESCRIPTION}
