---
title: Why Catalyst
description: Catalyst turns Claude Code into an autonomous engineering team you run from your Linear board — and how that compares to alternatives like Every's compound engineering.
sidebar:
  order: 0
---

Catalyst turns [Claude Code](https://www.anthropic.com/claude-code) into an autonomous engineering team that you run from your [Linear](https://linear.app) board. You describe the work and set its priority. Agents research, plan, write, and ship it — while you watch the board.

## The problem with "prompt and pray"

Plain AI coding keeps you at the keyboard. You ask for code, wait, review, and ask again. You are the bottleneck. On a real project it gets worse: the AI forgets what you said, can't see a large codebase, repeats mistakes, and writes code without ever shipping a tested change.

## What makes Catalyst different

You stop driving each step. Instead:

- **You specify and prioritize.** Write a clear ticket, set its priority, and drop it in your Todo column. That's your whole job for the run.
- **Agents do the rest, away from the keyboard.** A background executor picks the ticket up on its own and runs the whole pipeline — research, plan, implement, verify, review, open a pull request, handle review bots and CI (continuous integration), and merge.
- **Linear is your control room.** Every step posts a comment on the ticket and moves the card. You follow the work by reading the board, not a terminal.
- **It runs many tickets at once.** Each runs in its own copy of the repo, so you can queue a batch and walk away.

Catalyst is tuned for one setup: macOS, Claude Code, Linear (tickets), and GitHub (code). See [How Catalyst works](/getting-started/how-catalyst-works/) for the full loop.

## How it compares to compound engineering

[Every](https://every.to) has a popular approach called **compound engineering**. The idea: every task should make the *next* task easier. Each bug fix prevents a class of future bugs. Each lesson becomes a rule the AI reuses, so the system gets smarter over time. Every ships it as an open-source Claude Code plugin:

```
/plugin marketplace add EveryInc/compound-engineering-plugin
/plugin install compound-engineering
```

It runs a hands-on loop — **Plan → Work → Review → Compound** — with commands like `/ce-plan`, `/ce-work`, and `/ce-compound`.

**How they're alike:** both add structure and memory on top of Claude Code, fan work out to several agents, and treat saved lessons as an asset that builds up over time.

**How they differ:** compound engineering is philosophy-first and lightweight. You stay in the driver's seat and run each step, and it works on any repo or AI host. Catalyst is opinionated and autonomous. It runs whole tickets end to end with no command from you, wired into Linear, GitHub, and a [live dashboard](/autonomous-workflow/see-your-work/). It is Claude-Code-only.

**Which to pick:** reach for **Catalyst** when you want to queue many tickets and let them ship while you watch the board. Reach for **compound engineering** when you want a lighter, hands-on loop. Catalyst is opinionated — that's the point, and it isn't for everyone.

**Sources:** [Compound Engineering guide](https://every.to/guides/compound-engineering) · [The Definitive Guide](https://every.to/source-code/compound-engineering-the-definitive-guide) · [Plugin repo](https://github.com/EveryInc/compound-engineering-plugin)
