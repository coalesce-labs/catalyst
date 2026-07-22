# Skill Reference Naming

Plugin skills always require the fully-qualified `plugin-name:skill-name` form for invocation.

When outputting skill invocation instructions to the user (in templates, error messages, "next steps" suggestions), always use the full prefix:

- catalyst-dev skills: `/catalyst-dev:skill-name`
- catalyst-pm skills: `/catalyst-pm:skill-name`
- catalyst-meta skills: `/catalyst-meta:skill-name`
- catalyst-debugging skills: `/catalyst-debugging:skill-name`
- catalyst-analytics skills: `/catalyst-analytics:skill-name`

In explanatory prose describing workflow relationships (e.g., "Called by /implement-plan as part of quality gates"), bare names are acceptable for readability since nobody types those.

Agent `subagent_type` references always use the full `plugin-name:agent-name` format.
