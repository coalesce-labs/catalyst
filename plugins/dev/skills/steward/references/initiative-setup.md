# Setting up a new initiative or project

The human says what they want, in one sentence, wherever they already are. Everything below is yours.
They do not create projects, tickets, labels or docs by hand.

## 1. Clarify — with `grilling`, and bound it

Before the first dispatch on a **new** scope, run the `grilling` skill (`grill-me` / `grill-with-docs`
are its shims; `grill-with-docs` also produces ADRs and a glossary via `domain-modeling`).

Its contract, which is why it is the right tool here:

- **One question at a time**, waiting for the answer before the next. Asking five at once is bewildering
  and gets one answer back.
- **Every question carries your recommended answer**, so "use your recommendations" is always a valid
  reply and the human can stop at any point.
- **If the codebase can answer it, go read the codebase instead of asking.**

⚠️ **Bound it: 3–6 questions.** The output is a project with an outcome and acceptance criteria — not a
transcript. Anything still unresolved when you stop becomes an **ask** with a default, not a seventh
question.

⚠️ **If the human is not present**, do not wait. `grilling` is interactive by construction; a steward
running unattended converts every open question into an ask with a stated default and proceeds. A
clarification interview nobody is attending is just a stalled project.

## 2. Set it up

1. **Initiative** — if the scope needs a new one; otherwise attach to the existing one.
2. **Project**, with a one-line outcome in its description.
3. **Tickets** in `catalyst-dev:gherkin-ticket` shape: outcome title `<actor> should <outcome> so that
   <benefit>`, tiered Given/When/Then ACs, sizes. Wire real `blocks` / `blocked-by` **relations** —
   dependencies are linked, never left in prose.
4. **`Status — <project>`** document from the template (`status-doc.md`), 🟡 "set up, not started".
5. **Labels** the team lacks (`catalyst-ask`, `ask/decision`) — Linear labels are team-scoped, and the
   app actor cannot create them, so this needs the personal token, once.
6. **Your plan comment** — the one top-level `Steward — <date> · <scope>` root.
7. **The board row**, via the concierge.

## 3. Confirm, in one threaded reply

Under the human's original message: links to the project, the status doc, the tickets, and your plan
comment. Then two lists, explicitly:

- **what you decided on their behalf**, each with a one-line why;
- **what only they can decide** — already filed as asks, with defaults running.

## 4. Wait for "go" — or don't

"Go" from the human and a ticket moved to Todo are **both** real dispatch verbs. If the human says go, you
dispatch (capped, holds named). If they say nothing and nothing is irreversible, proceed on the defaults
you stated. Irreversible things wait for an explicit go — always.
