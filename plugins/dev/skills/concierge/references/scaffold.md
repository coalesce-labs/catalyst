# Scaffolding a project from a human's request

Trigger: a human says what they want on their `Concierge — <human>` ticket (or any un-owned surface).
Target: **≤ 45 minutes** from their comment to a launched steward, confirmed in-thread with links.

## 1. The grill — bounded, and you are the only role allowed to run it

⛔ **One question at a time, each with a recommended answer.** Not a questionnaire, not a wall.
⭐ **"Use your recommendations" ends the grill immediately** and you proceed on every recommendation you
had queued. Say that sentence to them in your first reply so they always have the exit.

Use the `grilling` skill for the question shapes. Stop when you can write acceptance criteria — not when
you have run out of questions. A grill that keeps going after the ACs are writable is a grill that is
costing the human attention for nothing, which is the one currency this role is protecting.

⚠️ **A steward does NOT do this.** A steward grills the **codebase and the replica**, and files what
survives as **one ask** with Options + Default. Only the concierge grills a human interactively.

## 2. Scaffold — you create, the steward fills

You create:

- the **Linear project**, with `lead` = the decider (default: whoever asked for it)
- **tickets** in `gherkin-ticket` shape: outcome title (`<actor> should <outcome> so that <benefit>`) plus
  tiered Given/When/Then ACs, sized
- a **tracking ticket** for the scope
- a **`Status — <project>` stub** — the stub only; the steward fills it
- a **board row**
- the launched **`steward/<slug>`** (via the supervisor's manifest, `role-supervisor`)

The steward then fills the status doc, plans, and dispatches. ⛔ **Do not pre-dispatch its tickets.**
Moving something to Todo is the steward's verb; doing it for them makes you a second orchestrator and the
scope now has two owners, which is the failure mode the role names are chosen to prevent.

## 3. Confirm in-thread

One threaded reply under the root of their request, as `concierge`, containing:

- the project link · the ticket identifiers (⛔ **only after `create` returned them**) · the status-doc
  link · the steward that is now running
- what you assumed, if the grill ended early on "use your recommendations"
- what you did **not** do and why

Then the human says "go" — or corrects you, in the same thread, once.

## Orphans — a scope with no steward

A hand-made project with no steward is **yours by default**, and that is a temporary state, not a home.
Scaffold a steward for it rather than keeping it: a concierge that quietly stewards three projects has
stopped being one door and has become a bottleneck with no status docs. Record the handover in-thread.
