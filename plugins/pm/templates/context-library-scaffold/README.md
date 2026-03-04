# Context Library Setup

The context library is a project-specific directory structure that powers PM skills.
Skills reference `pm/context-library/` paths to load business context, strategy docs,
research, and more.

## Quick Setup

Create this structure in your project root:

```
pm/context-library/
├── business-info.md          # Company/product overview, North Star metric
├── stakeholders.md           # Key stakeholders and their concerns
├── writing-style.md          # Internal communication style guide
├── strategy/                 # OKRs, quarterly goals, strategic pillars
├── research/                 # User research, competitive analysis
├── decisions/                # Decision documents and ADRs
├── prds/                     # Product Requirements Documents
├── launches/                 # Launch plans and checklists
└── meetings/                 # Meeting notes and action items
```

## Templates

Use the template files in this directory as starting points:
- `business-info-template.md` - Fill in your product/company details
- `stakeholder-template.md` - Map your stakeholders

## How Skills Use Context

Skills automatically check `pm/context-library/` for relevant context:
- `/weekly-plan` reads strategy/ for OKR alignment
- `/prd-draft` reads business-info and strategy for product context
- `/ralph-wiggum` reads strategy, research, and decisions to challenge assumptions
- `/status-update` reads stakeholders for audience-aware updates
