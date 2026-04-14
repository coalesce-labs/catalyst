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

## Your Tickets (Wave ${WAVE_NUMBER})

- **${TICKET_ID}**: ${TITLE} (depends on ${DEPENDENCY})

${MIGRATION_ASSIGNMENTS}

## Important

- Build ON TOP of Wave ${PREV_WAVE}'s patterns — don't reinvent what already exists
- Use the established test helpers listed above
- Follow the naming conventions and file organization from completed PRs
- Check `thoughts/shared/research/` for any relevant research from prior waves
