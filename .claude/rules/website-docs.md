---
paths: ["website/**"]
---

# Website Documentation Rules

## Content Structure
- Website is the canonical user-facing documentation source
- docs/ in repo root is developer-only reference
- Use Starlight conventions for page organization
- Three sidebar sections: Getting Started, Reference, Plugins

## Terminology
- Always use "skills" — never "commands" when referring to Catalyst functionality
- User-invocable skills: triggered by user with `/skill-name` (plugin shown in description for disambiguation)
- Model-invocable skills: activated automatically by Claude when relevant context detected
- CI skills: non-interactive variants for automation pipelines

## Writing Style
- Clear, concise, actionable
- Include code examples for all workflows
- Link to GitHub source when referencing specific files
