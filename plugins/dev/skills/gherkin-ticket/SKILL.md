---
name: gherkin-ticket
description:
  "Shape every ticket around a scannable use-case before it's filed. **ALWAYS use when** the user
  says 'file a ticket', 'create a ticket', 'file tickets for', 'open an issue', 'add a ticket',
  'log a bug', or whenever drafting, titling, or rewriting a ticket. Turns vague,
  implementation-first tickets into an outcome title (`<actor> should <outcome> so that <benefit>`)
  plus tiered Gherkin (Given/When/Then) acceptance criteria — even for backend bugs and chores."
disable-model-invocation: false
user-invocable: true
allowed-tools: Read, Write, Edit, Grep, Glob, Bash(linearis *), Bash(jq *)
version: 1.0.0
---

# Gherkin Ticket — Use-Case-First Ticket Authoring

Every ticket must open with **a use case a stranger can understand**: who gets what outcome, under
what condition, and why. Most tickets fail this — they dive straight into implementation ("Wire HRW
ownership into dispatchTriage") and the reader has to reverse-engineer the point. This skill fixes
that at authoring time.

This skill owns **ticket format** (title voice + body structure). It does **not** own the Linear CLI
mechanics — once a draft is ready, hand off to the `/catalyst-dev:linear` skill to actually create
or update the issue. CLI syntax lives in `/catalyst-dev:linearis`.

## When this fires

Auto-invoked whenever a ticket is being born or rewritten — you do **not** need to say "gherkin":

- "file a ticket for X", "create tickets for A and B", "open an issue", "log this bug"
- breaking a PRD/plan into tickets (pair with `/catalyst-pm:create-tickets`)
- "rewrite this ticket", "clean up these ticket titles", "this backlog is unreadable"

If the user is mid-creation in another skill (`linear`, `create-tickets`, `phase-triage`), apply
these rules to the title and body before the issue is written.

---

## The two parts of every ticket

### Part 1 — The title IS the use case (the scannable line)

The title must let a reader who didn't write the ticket understand, in one glance, **what it is and
what the expected outcome of doing it is** — enough to judge whether and when it should be done.

A useful *starting shape* (not a template to force) is:

```
<Actor> should <outcome> [when <condition>] [so that <benefit>].
```

where the actor is whoever gets value — *not always a human*: `Operators`, `Developers`,
`The scheduler`, `The reaper`, `A phase worker`, `The daemon`, `The dashboard`.

But **bias hard toward concise and scannable. Do not force the formula.**

- **Prefer the shortest title that still conveys context + expected outcome.** Drop `so that…` the
  moment the benefit is obvious; drop `when…` unless the trigger is the point. A 90-char title that
  reads cleanly beats a 150-char one that recites every clause. Vary the phrasing — identical
  "X should Y so that Z" scaffolding on every ticket becomes noise the reader tunes out.
- **Length is earned by clarity, never spent on mechanism.** Soft cap ~120 characters. Go longer
  only if the extra words remove ambiguity.
- **No jargon in the title — hard rule.** No symbol, function, event, file, or flag names
  (`reap-complete`, `bootReplay`, `schedulerTick`, `layoutId`, `--label-mode`). The title is for
  someone deciding whether to care, not implementing. **If you can't state the outcome without
  naming an internal mechanism, you don't yet understand the outcome — go figure out what the work
  is *for*, then write that.** The mechanism belongs in the body.
- **Component does NOT go in the title.** Put it in a Linear *label* (CTL uses component labels:
  orchestrator / phase-agent / broker / monitor / cli / …). No `[API]` / `[Frontend]` prefixes.

The hardest case is deep-internals work (a reaper fix, a scheduler reorder). The temptation is to
title it by its mechanism because the outcome feels invisible. It isn't — every change exists to make
*something* better for *someone* (the operator, the daemon, the next developer). Name that. "The
reaper should record an already-gone session as reaped so the daemon stops re-checking it every boot"
beats "Reap echo on already-gone bg session" even though both describe the same patch.

#### Title: before → after

| ❌ Implementation-first (cryptic) | ✅ Outcome-first (scannable) |
|---|---|
| `Wire HRW ownership + claim into monitor dispatchTriage` | `The orchestrator should claim a ticket before triaging it so that two workers never grab the same job` |
| `Fix CTL-874 preflight label scope` | `catalyst-monitor preflight should pass in workspaces that have no team-level labels` |
| `Add stale-worker detection to dispatcher` | `The dispatcher should skip workers that have gone silent when assigning new work` |
| `Dashboard needs-attention banner` | `Humans should see an indication on the dashboard when something needs their attention so that they can react to it` |
| `Refactor: extract dispatchAndVerify` | `Developers should change dispatch-and-verify logic in one place so that the three sweeps can't silently diverge` |

Notice the actor varies (orchestrator, monitor, dispatcher, humans, developers) and the `so that`
is present only when it adds information.

### Part 2 — The body: tiered Gherkin

Match the ceremony to the work. Forcing a full `Given/When/Then` block onto a pure chore produces
vacuous Gherkin (`Then the code is cleaner`) — a known anti-pattern. Use the tier that fits:

**Always wrap scenarios in a ` ```gherkin ` fenced code block.** This renders as a monospace block in
Linear (and picks up Gherkin syntax coloring wherever the viewer supports it), keeping the
Given/When/Then visually distinct from the prose around it. The Tier-C Context/Motivation/Outcome
prose stays as normal text; only the scenario blocks are fenced.

#### Tier A — Features, bugs, API/behavior changes → full scenarios

A one-line intent (the title already carries it; restate only if the body needs framing) **plus one
or more `Scenario:` blocks**:

```gherkin
Scenario: <one specific behavior, stated as a complete sentence>
  Given <minimum starting state>
  And <additional precondition>
  When <the single action or event>
  Then <observable outcome>
  And <additional observable outcome>
```

Rules (borrowed from gherkin-lint heuristics — these are hard rules):
- **Exactly one `When` per scenario.** A second `When` means a second behavior → second scenario.
- **`Then` asserts an *observable* outcome** (user-visible or caller-visible), not an internal
  artifact — *unless* it's an explicitly technical/backend scenario where the state change IS the
  observable outcome (then say so).
- **Declarative, not imperative.** No "click the Sign-In button", no `POST /api/v2/users`, no field
  IDs. Mechanics belong in the implementation, not the acceptance criterion.
- **Concrete values**, never "some user" / "certain data" / "valid input".
- **`Given` = minimum context** to trigger the behavior, not a full user journey.
- Multiple behaviors → multiple scenarios. Branching (happy path vs edge) → one scenario each.

#### Tier B — Bugs (a failing scenario)

Same as Tier A, with a discipline: **`Then` states the CORRECT behavior** (the scenario must go green
when fixed), and a `# CURRENTLY:` comment marks what's broken today.

```gherkin
Scenario: Preflight passes when the workspace has no team-level labels
  Given the workspace defines labels only at the workspace scope
  And no labels are defined at the team scope
  When catalyst-monitor preflight runs
  Then the preflight check exits 0
  And no "label not found" error is emitted
  # CURRENTLY: preflight queries --team labels, returns "label not found", and the team starves
```

#### Tier C — Pure chores / refactors (no observable behavior change) → motivation prose

A full scenario would be hollow. Lead with **Context / Motivation / Outcome** instead:

```
Context: dispatchAndVerify() is duplicated verbatim in sweep-triage, sweep-implement, sweep-verify.
Motivation: when one copy's timeout changes, the other two silently stay wrong (the CTL-826 class).
Outcome: a single shared dispatchAndVerify() is extracted; all three sweeps import it.
```

Add **invariant scenarios** *only* if there is behavior that must survive the change and can be
written as a testable postcondition (e.g. "the dispatcher still assigns to the least-loaded worker").
Do not invent a scenario whose `Then` is "the code is cleaner".

---

## Worked examples (one per ticket type)

### Feature

> **Title:** Humans should be able to see which workers need assistance so that they can respond in time

```gherkin
Scenario: A blocked worker surfaces in the assistance list
  Given a phase worker has been waiting on a needs-human decision for 5 minutes
  When an operator opens the dashboard
  Then that worker appears in the "needs assistance" list
  And the list shows the ticket, the phase, and how long it has been waiting

Scenario: A worker drops off the list once unblocked
  Given a worker is shown in the "needs assistance" list
  When the operator resolves its needs-human decision
  Then the worker disappears from the list without a page reload
```

### Backend API behavior

> **Title:** Integrating systems should have failed webhook deliveries retried so that a transient downstream error doesn't lose data

```gherkin
Scenario: A transient 503 triggers a backoff retry
  Given a webhook event is queued for delivery
  And the endpoint returns HTTP 503 on the first attempt
  When the retry scheduler evaluates the event
  Then a second attempt is scheduled with a 30-second backoff
  And the event is NOT yet marked as delivered

Scenario: An event is abandoned after five consecutive failures
  Given a webhook event has failed delivery four consecutive times
  When the fifth attempt also fails
  Then the event is marked "abandoned"
  And it is moved to the dead-letter queue
```

### Backend bug

> **Title:** The daemon should not declare a live phase worker dead on its first commit

```gherkin
Scenario: A committing worker is left alone
  Given a --bg phase-implement worker has just made its first commit
  And its signal mtime is older than the stale-bg threshold
  When the reclaim sweep evaluates the worker
  Then the worker is left running
  And no implement-complete event is emitted on its behalf
  # CURRENTLY: reclaim fires implement-complete on the first commit, so verify runs on a partial branch
```

### CI / infra chore (Tier C)

> **Title:** Developers should change dispatch-and-verify logic in one place so that the three sweeps can't silently diverge

```
Context: dispatchAndVerify() is copy-pasted across three scheduler sweeps.
Motivation: a timeout tweak in one copy leaves the other two wrong with no error.
Outcome: extract a shared dispatchAndVerify(); all three sweeps import it; behavior unchanged.

Scenario: Dispatch still waits for completion before returning  # invariant
  Given a task is eligible for dispatch
  When dispatchAndVerify is called
  Then the task is dispatched to a worker
  And the call does not return until a completion signal arrives or the timeout elapses
```

---

## Modes

### DRAFT (new ticket)
1. Extract the real use case from what the user said — ask "who benefits and why?" if it's unclear.
2. Write the outcome **title** (Part 1).
3. Pick the tier (A/B/C) and write the **body** (Part 2).
4. Run the **quality checklist** below.
5. Hand the title + body to `/catalyst-dev:linear` to create the issue. Add component label,
   estimate, priority there (see `feedback_linear_ticket_hygiene`).

### REWRITE (existing ticket)
1. Read the **full** existing ticket (title + description + comments) — never partial.
2. **Preserve all technical content** (file refs, repro steps, root-cause notes, SHAs). You are
   restructuring, not deleting. Move technical detail under a `## Technical notes` section below the
   Gherkin so it stays but doesn't lead.
3. Rewrite the title to outcome-first; rewrite the body into the right tier.
4. Show a **before → after** so the user can eyeball it before you push the update.

### VALIDATE (audit, don't change)
Score a ticket against the checklist and report gaps. Used to triage a backlog before a rewrite pass.

---

## Quality checklist

Title:
- [ ] Leads with the actor who benefits (human or system component).
- [ ] States an outcome in intent language, not a mechanism or file name.
- [ ] A stranger could understand the point in one read. No unexplained acronyms in the outcome.
- [ ] `so that` present only when it adds information (not hollow filler).
- [ ] No `[Component]` prefix — component is a label.

Body:
- [ ] Right tier chosen (A features/bugs, B bug-with-`# CURRENTLY`, C chore prose).
- [ ] Every scenario has **exactly one `When`**.
- [ ] Every scenario title is a complete, specific sentence (no duplicates).
- [ ] `Then` is observable (or explicitly technical); no leaked DB/queue internals on user features.
- [ ] Declarative — no UI clicks, endpoints, or field IDs in the steps.
- [ ] Concrete values throughout.
- [ ] Bug `Then` describes the CORRECT behavior; `# CURRENTLY:` documents the break.
- [ ] No vacuous chore scenarios (`Then the code is cleaner`).

Dependencies:
- [ ] Real prerequisites are set as formal Linear **blocker links**, not narrated in prose.
- [ ] No "depends on TEAM-123" / "after TEAM-456" sentences in the body expecting something to read them.

---

## Dependencies — link them, don't narrate them

If you know that other work **must finish before this ticket can start**, record it as a first-class
Linear `blocked_by` **link** at authoring time — you know the prerequisites better than any later
pass will. **Catalyst does NOT infer dependencies from prose** (CTL-838): writing "depends on
CTL-123" or "see CTL-456" in the description does nothing — it is not scraped into a blocker, and it
should not be (a mention is not a dependency).

```bash
# After the ticket exists, link each genuine prerequisite (see /catalyst-dev:linearis for syntax):
linearis issues update <NEW-TICKET> --blocked-by <PREREQ-TICKET>
```

Rules of thumb:
- Link only **true** prerequisites — work that must reach Done/Canceled first. A shared topic,
  prior-art reference, or "related" ticket is **not** a blocker.
- Never link across teams for auto-sequencing (a `CTL` ticket on an `OTL`/`ADV` ticket): the
  execution-core daemon only works its own team, so a cross-team blocker just deadlocks. Coordinate
  cross-team work out-of-band.
- A blocker you miss is fine — `/catalyst-dev:phase-triage` does a semantic second pass over the
  backlog and can add genuine ones it finds. But a **false** blocker you add stalls real work, so
  when in doubt, leave it out.

---

## Per-project criteria (override hook)

Catalyst ships these defaults, but **other teams write tickets differently**. Before drafting, check
for a project override and layer it on top of (it wins over) the defaults here:

```bash
# Optional project-specific ticket style — actor vocabulary, extra sections, stricter tiers
OVERRIDE=".catalyst/ticket-style.md"
[[ -f "$OVERRIDE" ]] && echo "Applying project ticket-style overrides from $OVERRIDE"
```

If `.catalyst/ticket-style.md` exists, read it and honor its actor list, required sections, and any
stricter rules (e.g. "every ticket including chores must carry one literal Given/When/Then"). Absent
that file, use the defaults above. This is how the same shipped skill serves teams with different
conventions.

---

## Relationship to other skills

- `/catalyst-dev:linear` — does the actual Linear create/update. This skill produces the title +
  body it consumes.
- `/catalyst-pm:create-tickets` — when exploding a PRD into many tickets, apply these title/body
  rules to each. (Its legacy `[Component] Action:` title format is superseded by outcome titles +
  component labels.)
- `/catalyst-dev:phase-triage` — triage reads tickets; a ticket authored to this standard makes
  triage's classify/estimate step far more reliable.
- `/catalyst-dev:linearis` — CLI syntax reference. Never hardcode linearis commands here.
