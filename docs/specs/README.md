# Specs

The durable, in-repo home for **design and requirements explorations** — specs,
mockups, and the prose that frames them — with an explicit `draft → accepted`
lifecycle recorded in git history.

If you are starting a new design or requirements exploration and want a
committed, discoverable place for it (not repo-root `mockups/`, not the external
`thoughts/` repo), it goes here.

## Layout

```
docs/specs/
├── README.md            ← you are here (the convention)
├── draft/               ← still under discussion / not yet shipped
│   └── <slug>/
│       ├── spec.md      ← the prose: problem, options, open questions
│       └── *.html       ← colocated mockups / prototypes
└── accepted/            ← approved and/or shipped to the product
    └── <slug>/
        ├── spec.md
        └── *.html
```

Each spec is a **folder** named with a short kebab-case `<slug>`, containing a
`spec.md` plus any mockup HTML it references. Keeping the prose and the mockup
side by side means a spec is self-describing — you never have to hunt for "which
mockup did this doc mean?"

## Lifecycle: draft → accepted

- **draft/** — the exploration is still under discussion. Competing directions,
  prototypes, and proofs-of-concept live here. Nothing in `draft/` is a promise
  that it will ship.
- **accepted/** — the design was approved and/or has shipped to the product.

**Promotion is a `git mv`:**

```bash
git mv docs/specs/draft/<slug> docs/specs/accepted/<slug>
```

Because promotion is a single tracked move, the PR history shows *exactly* when
something crossed from "under discussion" to "approved" — no separate status
field to keep in sync, no ambiguity about when a decision was made.

## `spec.md` frontmatter

Keep it light. The only required field is `status`:

```markdown
---
title: Human-readable title
status: draft            # draft | accepted
ticket: CTL-1234         # optional — the Linear ticket, if any
pr: 2345                 # optional — the PR that shipped it, if accepted
created: 2026-07-01      # optional
---

## Problem
What need or gap is this exploring?

## Approach / options
The direction(s) under consideration. For a draft with competing mockups,
describe each and what distinguishes them.

## Open questions          # drafts
## Outcome                  # accepted — what shipped, and where
```

`status:` in frontmatter must always agree with the folder the spec lives in
(`draft/` ↔ `status: draft`). The folder is the source of truth; the field is a
convenience for readers and tooling.

## How this differs from ADRs and `thoughts/`

| Home | What it holds | Lifecycle |
|---|---|---|
| **`docs/specs/`** (here) | Specs, requirements, mockups — *forward-looking*, "what should we build" | `draft → accepted`, in git |
| **`docs/adrs.md`** | Architecture **decisions already made** — *retrospective*, append-only log | Immutable once recorded |
| **`thoughts/`** (external, gitignored) | Research, plans, session-continuity notes | Ephemeral / not durably checked in |

A spec proposes and explores; an ADR records the decision that resulted. When a
spec's design settles into an architectural commitment, that commitment is
written up as an ADR — the spec is the *how we got there*, the ADR is the *what
we decided*.

## Screenshots are not specs

Ephemeral screenshots captured while iterating (agent-browser / design-review
captures) do **not** belong in the repo. They default to a scratchpad dir and
are gitignored (`docs/specs/**/*.png` — same rule that already covers
`mockups/**/*.png`). Commit a mockup's HTML, which reflows and is diffable — not
a pile of PNGs. If a screenshot genuinely must be preserved (e.g. a
before/after that the mockup HTML can't reproduce), that is the rare exception,
and it should be called out in the spec's `spec.md`.

## Relationship to `mockups/`

Repo-root `mockups/` predates this convention and holds ad-hoc mockup HTML with
no accompanying prose. New design work should start under `docs/specs/`, not
`mockups/`. See [`MIGRATION.md`](./MIGRATION.md) for the record of what moved
here from `mockups/` when this convention landed (CTL-1411).
