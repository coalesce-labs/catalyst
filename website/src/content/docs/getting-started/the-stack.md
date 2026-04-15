---
title: The Stack
description: The specific development environment Catalyst is built around — and what that means for you.
sidebar:
  order: 1
---

Catalyst is built around a specific development environment. It's not trying to be universal — it's trying to be excellent for one workflow. This page tells you exactly what that workflow looks like, so you can decide whether to jump in.

## Who This Is For

Catalyst is for developers who like to tinker. You're comfortable spinning up a Docker Compose stack, installing CLIs you haven't used before, and experimenting with new platforms. You might fork this repo and reshape it for your own workflow.

This is **not** a one-click installer. It's not a polished, end-to-end package that's been battle-tested by tens of thousands of users. It's a working toolkit that one developer uses daily, released so others can benefit from the patterns and adapt them.

## The Development Environment

### Core (Required)

| Tool | Role |
|------|------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | The AI engine everything plugs into |
| [GitHub](https://github.com) | PRs, issues, CI/CD |
| [Git](https://git-scm.com) | Worktrees, branching, thoughts system |
| macOS | Primary supported platform |

### Task Management

| Tool | Role |
|------|------|
| [Linear](https://linear.app) | Task management, cycle tracking |
| [Linearis CLI](https://www.npmjs.com/package/linearis) | Linear integration for Claude Code |

### Observability

| Tool | Role |
|------|------|
| [OpenTelemetry](https://opentelemetry.io) | Structured telemetry from agent runs |
| [Grafana](https://grafana.com) | Dashboards, alerting, log exploration |
| SQLite | Local session store and cost tracking |

### Development Environment

| Tool | Role |
|------|------|
| [Conductor](https://conductor.build) | Parallel agent orchestration UI |
| [Warp](https://www.warp.dev) | Terminal |
| [Bun](https://bun.sh) | Runtime for scripts and tooling |

### AI Agents (Beyond Claude Code)

| Tool | Role |
|------|------|
| [Devin](https://devin.ai) | Autonomous coding agent |
| [Codex](https://openai.com/index/codex/) | OpenAI's coding agent |

Catalyst skills can orchestrate handoffs between these agents and Claude Code.

## What This Means for You

If your stack looks like this, Catalyst works out of the box. Install the plugins, run the setup script, and you're in a working workflow within minutes.

If you're on Windows, use Jira instead of Linear, or prefer a different AI coding tool — Catalyst may still be useful for ideas and patterns, but you'll be adapting rather than installing. There's no active effort to add support for alternative task managers, IDEs, operating systems, or AI providers. This is a working toolkit, not a framework.

You're welcome to fork the repo and adapt it for your own stack. That's part of why it's open source.

## A Note on Security

Installing these plugins means installing code that runs on your computer — or has the potential to run on your computer.

**Don't trust me or anybody else.** You should review anything you install into Claude Code. At minimum, use [GitHub's code scanning](https://docs.github.com/en/code-security/code-scanning) (Copilot or CodeQL) to run a security check on this or any other plugin before installing it.

Catalyst bakes security checks and security reviews into its own CI/CD pipeline. But of course, that's exactly what someone would tell you if they were trying to put something nasty on your machine. Run your own scans. Read the code. Trust your own review, not someone else's assurances.

## Start at Level 2

Catalyst describes three levels of AI-assisted development (detailed in [Beyond Prompt and Pray](https://slides.rozich.net/ai/structured-ai-development-guide)):

- **Level 1** — Prompt and generate. Basic AI code completion.
- **Level 2** — Structured workflows. Research, plan, implement, validate — one ticket at a time.
- **Level 3** — Orchestrated parallelism. Multiple agents working across multiple tickets simultaneously.

**Start at Level 2.** Spend real time there. Work ticket by ticket through the research-plan-implement cycle. Get a feel for what's happening under the hood. Understand how context flows between phases, how handoffs work, how the AI reasons about your codebase.

Ship with rigor and confidence at Level 2 before you think about Level 3. If you jump straight to orchestrating parallel work streams, you'll burn through tokens fast and get frustrated when things go sideways — because you won't have the mental model to debug what went wrong.

Level 3 is powerful, but it assumes you already know how each individual workflow phase behaves. Master the single-ticket workflow first.
