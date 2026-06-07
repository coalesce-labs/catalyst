---
title: How Catalyst works
description: The whole loop — you write the ticket and set its priority, the agents build and ship it, and you follow along on your Linear board.
sidebar:
  order: 1
---

Here is the whole idea: you describe the work, autonomous agents build and ship it, and you watch it happen on your Linear board. You stay away from the keyboard for the run itself.

Linear is the issue tracker Catalyst works from. (An issue, or "ticket," is one unit of work.) A background scheduler — the **execution-core** daemon (part of the Catalyst service stack: broker, monitor, execution-core) — watches your board and does the rest.

## The loop, in four steps

### 1. Write the ticket

Spell out what you want and how it should work. This is where your time goes. Clear tickets in, good code out. A vague ticket gives a vague result, so this is the part worth getting right.

### 2. Set the priority and move it to Todo

Set the ticket's priority (Urgent, High, Medium, or Low) and drag it to your **Todo** column. That is your "go" signal. (Todo is the default queue column; you can point Catalyst at a different one in config.)

### 3. Catalyst picks it up on its own

You don't run a command. The executor sees the ticket and starts — within seconds, or on its next check (about every 10 minutes). It moves the ticket to **Triage**, sizes it up as small, medium, large, or epic, and posts that estimate as a comment on the ticket. Large and epic tickets automatically get a stronger model and more thinking time during planning.

### 4. Watch it ship

The ticket walks a fixed set of steps, one at a time:

```
triage → research → plan → implement → verify → review → pr → monitor-merge → monitor-deploy
```

What each step does:

- **research** — reads your codebase and writes down what it found
- **plan** — turns that into a step-by-step plan
- **implement** — writes the code and tests
- **verify** — runs checks and tests against the changes
- **review** — does a code review (a `remediate` step fixes problems and loops back to verify, up to three times)
- **pr** — opens a pull request (a "PR" — the GitHub request to merge your code)
- **monitor-merge** — answers automated review bots, fixes failing CI (continuous integration — the automated checks), and merges once GitHub says the PR is clean
- **monitor-deploy** — watches the deploy after merge

Every step posts a comment to the ticket and moves the card across your board. You just follow along.

## What this gets you

- **Many at once.** The executor runs several tickets in parallel, each in its own isolated copy of the repo (a git "worktree"). You set the limit with `maxParallel` (default 3). Queue a batch and walk away.
- **An automatic queue.** It always works your highest-priority ticket first — Urgent before High before Medium before Low. You don't schedule anything.
- **You stay in control.** You steer by writing tickets and setting priority, not by typing commands. It stops and tags a ticket for you when something truly needs a human.

## Where to go next

- [Linear is your control room](/autonomous-workflow/linear-control-room/) — how you and the agents talk through the ticket
- [See all your work](/autonomous-workflow/see-your-work/) — the board and the live dashboard
- [Install Catalyst](/getting-started/) — get set up
