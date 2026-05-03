# Wave ${WAVE_NUMBER} Briefing — ${ORCH_NAME}

**Date:** ${TIMESTAMP}
**Project:** ${PROJECT_NAME}

## Context from Wave ${PREV_WAVE}

### Completed Tickets

- **${TICKET_ID}**: ${TITLE}
  - PR ${PR_LINK} merged
  - Key finding: ${KEY_FINDING}
  - New pattern established: ${PATTERN_DESCRIPTION}
  - Tests: ${UNIT_COUNT} unit, ${API_COUNT} API tests

### Patterns and Conventions Established

- ${PATTERN_NAME}: ${PATTERN_USAGE}

### New Dependencies Added

- ${PACKAGE_NAME}: ${PACKAGE_PURPOSE}

### Test Helpers Created

- ${HELPER_NAME}: ${HELPER_DESCRIPTION} (location: ${HELPER_PATH})

### Known Issues / Gotchas

- ${GOTCHA_DESCRIPTION}

## Wave ${WAVE_NUMBER} roster

This briefing is shared across every worker in Wave ${WAVE_NUMBER}. Your assigned ticket is
the one passed as `$1` when you were dispatched — the others below are FYI only, so you
understand what siblings are touching in parallel and can avoid scope conflicts.

- **${TICKET_ID}**: ${TITLE} (depends on ${DEPENDENCY})

${MIGRATION_ASSIGNMENTS}

## Important

- Build ON TOP of Wave ${PREV_WAVE}'s patterns — don't reinvent what already exists
- Use the established test helpers listed above
- Follow the naming conventions and file organization from completed PRs
- Check `thoughts/shared/research/` for any relevant research from prior waves
- **Do NOT** treat the roster above as your work scope — work only on the ticket from `$1`
