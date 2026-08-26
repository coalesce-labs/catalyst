# Classifying and sizing a ticket by eye

Relocated from the retired `phase-triage` daemon phase-agent (CTL-2223), with the `triage.json` /
`phase.triage.complete` daemon plumbing stripped down to the rubric itself. A quick, deterministic
heuristic for reading a raw ticket and getting a type + rough size before you reason about it further
— useful during `initiative-setup.md` when scanning a fresh backlog, or anywhere in `readiness.md`'s
SELECT step where "what kind of ticket is this, roughly how big" helps you sequence the plan.

This is a first pass, not a verdict: use it to sort quickly, then apply judgment where the ticket is
ambiguous or the mechanical read looks wrong.

## Classification — first match wins

Scan the title + description (case-insensitive) against these patterns, in order:

| Pattern | Classification |
|---|---|
| `bug`, `fix`, `bugfix`, `broken`, `regression` | `bug` |
| `doc`, `docs`, `documentation`, `readme` | `docs` |
| `refactor`, `rename`, `cleanup`, `extract` | `refactor` |
| `chore`, `bump`, `dependency update`, `deps:` | `chore` |
| (none of the above matched) | `feature` |

First match wins — check in this order, don't average signals across patterns.

## Estimated scope — by word count

Count words across the title + description, then bucket:

| Word count | Estimated scope |
|---|---|
| < 150 | small |
| 150–399 | medium |
| 400–999 | large |
| ≥ 1000 | epic |

Word count is a proxy for how much context the ticket author needed to explain the work — not a
promise about implementation effort. A 40-word ticket that touches a subtle invariant can still be
harder than a 500-word one that's mostly background. Treat the bucket as a starting sort, not a
commitment.

## Do not infer dependencies from prose — ever

This rubric deliberately produces **no** dependency list. An earlier version of this logic scraped
every `TEAM-NNN`-shaped token out of the title/description and recorded each as a durable `blocked_by`
edge — turning prior-art mentions, incident examples, and "see also" references into false blockers
that deadlocked tickets against work they didn't actually depend on (CTL-838). Real prerequisites are
captured exactly two ways, never by regex:

1. The ticket **author** sets a formal Linear `blocked_by` relation at creation time
   (`catalyst-dev:gherkin-ticket` / `linearis`) — this is what `readiness.md`'s blocker test reads.
2. A deliberate, semantic second pass over the backlog — a human or an LLM actually reasoning about
   whether a genuine prerequisite was missed — adds the relation explicitly. Never a prose scrape.

If you're using this classify-and-estimate pass while scanning a backlog and you *believe* a
dependency exists, that belief is not itself a relation: create the relation, then let
`readiness.md`'s test re-evaluate the ticket.
