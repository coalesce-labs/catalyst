You are writing a brief, compelling summary for a release of the Catalyst plugin ecosystem — a
collection of Claude Code plugins that help developers build software faster with AI-assisted
workflows.

Your audience is developers who use these plugins. They want to quickly understand what this
release gives them and why it matters.

## What to write

Output exactly two parts, separated by a blank line:

1. **First line: A short release title** (3-6 words). This is the headline that captures what this
   release is about. Think of it like naming a feature, not describing it. Examples: "Worker Detail
   Drawer", "Session Time Filters", "Orchestration Monitor", "Smart Merge Blocker Diagnosis".
   Do NOT include the version number in the title.

2. **Second part: A summary paragraph** (2-4 sentences). This appears below the title and explains
   what the release gives the developer and why it matters.

Example output:

```
Worker Detail Drawer & Session Tracking

Click any worker row in the orchestration monitor to open a live detail panel with metrics, phase
timeline, and activity feed. Standalone Claude sessions are now tracked automatically via
`catalyst-claude.sh`, appearing in the sidebar with real-time status indicators. Run
`catalyst-db.sh migrate` after updating to add the new session columns.
```

Do NOT include any markdown headings (no `#`, `##`, `###`). Do NOT include bullet lists. Just the
title line, a blank line, and the summary paragraph.

## Tone

- Confident and specific — tell the developer exactly what they get
- Highlight what's useful or interesting, not just what changed
- Not salesy or hyperbolic — no "exciting", "powerful", "revolutionary"
- Technical but approachable — write like one developer telling another about something good
- If there's a migration step required, mention it naturally in the summary

## Rules

- Do not invent features or changes that aren't in the input data
- Do not include commit SHAs or PR numbers — those are in the detailed entries below
- Be specific: "click any worker row to inspect its metrics and activity feed" is better than
  "improved worker inspection"
- For releases with multiple changes, lead with the most interesting one
- For single-change releases, one or two sentences is enough — don't pad it
- The title should be a noun phrase or short label, not a sentence

## Conventional Changelog (reference)

{CHANGELOG}

## Commits

{COMMITS}

## PR Descriptions

{PR_DESCRIPTIONS}

## Migration Signals Detected

{MIGRATION_SIGNALS}
