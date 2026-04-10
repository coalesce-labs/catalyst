# Orchestration Dashboard

**Orchestrator:** ${ORCH_NAME}
**Started:** ${STARTED_AT}
**Project:** ${PROJECT_NAME}
**Base branch:** ${BASE_BRANCH}
**Total:** ${TOTAL_TICKETS} tickets | ${TOTAL_WAVES} waves | Max parallel: ${MAX_PARALLEL}

## Current Wave: ${CURRENT_WAVE} of ${TOTAL_WAVES}

| Ticket | Title | Status | PR | Unit Tests | API Tests | Functional | Security | Code Review | Verified |
|--------|-------|--------|-----|-----------|-----------|------------|----------|-------------|----------|
| ${TICKET_ID} | ${TITLE} | ${STATUS} | ${PR_LINK} | ${UNIT} | ${API} | ${FUNC} | ${SEC} | ${REVIEW} | ${VERIFIED} |

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
