# Context Library Setup

The context library is a project-specific directory structure that powers PM skills.
Skills reference `thoughts/shared/pm/` paths to load business context, strategy docs,
research, and more.

## Quick Setup

Create this structure in your thoughts repository:

```
thoughts/shared/pm/
├── context/
│   ├── business-info.md          # Company/product overview, North Star metric
│   ├── stakeholders.md           # Key stakeholders and their concerns
│   └── writing-style.md          # Internal communication style guide
├── frameworks/                   # OKRs, quarterly goals, strategic pillars
├── prds/                         # Product Requirements Documents
├── launches/                     # Launch plans and checklists
├── metrics/                      # Metric baselines and dashboards
└── example-prds/                 # Example PRDs for reference
thoughts/shared/product/
├── meeting-notes/                # Meeting notes and action items
├── decisions/                    # Decision documents and ADRs
└── strategy/                     # Product strategy documents
```

## Templates

Use the template files in this directory as starting points:
- `business-info-template.md` - Fill in your product/company details
- `stakeholder-template.md` - Map your stakeholders

## How Skills Use Context

Skills automatically check `thoughts/shared/pm/context/` for relevant context:
- `/weekly-plan` reads frameworks/ for OKR alignment
- `/prd-draft` reads business-info and frameworks for product context
- `/ralph-wiggum` reads frameworks, research, and decisions to challenge assumptions
- `/status-update` reads stakeholders for audience-aware updates
