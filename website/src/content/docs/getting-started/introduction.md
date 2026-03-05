---
title: Introduction
description: What Catalyst is, why it exists, and what problems it helps solve.
sidebar:
  order: 0
---

# Catalyst

Catalyst is a structured workspace for building real software with AI.

It installs into Claude Code and provides commands, agents, skills, hooks, scripts, and workflows designed to help developers tackle large, real-world codebases.

Not toy demos. Not prompt experiments.

The goal is simple: make it easier to build production systems with AI while keeping humans in the loop.

---

## What Catalyst Is

Catalyst is a set of tools that plug directly into Claude Code.

Once installed, it provides:

### Commands

Structured commands designed to be run in sequences and workflows. These break complex work into repeatable development flows.

### Agents

Predefined agent roles that can be delegated work or organized into teams.

### Skills

Reusable capabilities that teach Claude how to approach tasks like debugging, planning, investigation, and implementation.

### Hooks

Hooks allow checks and automation to run at specific moments in a workflow. This makes it possible to enforce guardrails, add quality control, or trigger additional actions before or after key steps.

### Scripts

Deterministic scripts for actions that should not rely purely on LLM behavior.

### Context and Examples

Reference files that help guide how agents reason about projects and tasks.

Modules can focus on different responsibilities such as:

- Development
- Product planning
- DevOps
- Debugging and investigation
- Analytics

The goal is not to replace engineering judgment. The goal is to give AI structure to operate inside real engineering workflows.

---

## Why This Exists

Most AI coding workflows today look like this:

> prompt → generate code → review → repeat

That works well for quick experiments.

But real software development involves things like:

- Navigating large repositories
- Debugging complex issues
- Coordinating multi-step changes
- Planning implementation work
- Maintaining production systems

AI can help with this work. But it works far better when it operates inside clear structure and repeatable workflows.

Catalyst is an attempt to create that structure.

---

## Where These Ideas Come From

This project is shaped by three threads of thinking about how AI changes software development.

### HumanLayer and Agent Systems

A big influence is the work from HumanLayer on building reliable agent systems, especially the [12 Factor Agents](https://github.com/humanlayer/12-factor-agents) model.

A lot of what Dex and the HumanLayer team talk about comes down to **context engineering**: getting the right context into the right agent for the right task so it can reason effectively.

Catalyst starts from that foundation. The HumanLayer thought system is the philosophical starting point here. This project tweaks and extends those ideas for my own workflows and applies them to a broader set of engineering tasks beyond just writing code.

I've been working this way for close to a year now (as of March 2026), and it has fundamentally changed how I build software with AI.

### The Full-Stack Builder

Another influence is the idea of the "full-stack builder" that Satya Nadella and others have talked about.

AI makes it possible for a single builder to move across product thinking, engineering, debugging, infrastructure, and operations. The opportunity is huge, but only if the tools support working across an entire system rather than just generating code snippets.

Catalyst is designed for that kind of builder.

### Modernizing the Development Lifecycle for AI

One thing becomes clear quickly when AI starts writing large amounts of code: writing code stops being the bottleneck.

The bottleneck becomes the software development lifecycle.

Code review. Testing. Security. Deployment. Governance. Coordination.

AI accelerates coding, but without structure around the development process, teams quickly get stuck.

Catalyst does not try to solve the entire SDLC. But it does try to bring more structure and workflow to agent-driven development so that teams can ship faster while still maintaining rigor and confidence.

Catalyst borrows heavily from work by others exploring how humans and AI collaborate in engineering.

---

## Why Claude Code

Catalyst is intentionally opinionated. It is built specifically around Claude Code.

Claude Code currently exposes several capabilities that make these workflows possible:

- **Sub-agents** — Agents can fork new contexts to explore problems independently
- **Agent teams** — Multiple agents can collaborate on complex work
- **Commands** — Reusable commands allow structured workflows rather than free-form prompting
- **Skills** — Composable capabilities that agents can reuse
- **Hooks** — Workflow checkpoints where validation, checks, or automation can run
- **Plugin distribution** — Workflows can be shared and installed without copying scripts between environments

Supporting every AI coding environment usually means losing access to the features that make these workflows powerful. Catalyst focuses on taking advantage of what Claude Code can do today.

---

## What Problems Catalyst Helps With

Catalyst is useful when you want to:

- Work inside large or unfamiliar codebases
- Run structured development workflows
- Coordinate multiple agents on complex tasks
- Keep humans involved in decision making
- Build production systems rather than demos

It is especially helpful for investigation, debugging, and incremental changes to existing systems.

---

## What This Project Is

Catalyst is my personal workspace.

It reflects how I currently work with Claude Code while building software. I am sharing it publicly because others might find it useful or interesting.

A few expectations:

- It evolves frequently
- It reflects personal workflows
- Parts may change as Claude Code introduces new capabilities

Anthropic ships new features quickly. Much of this project is simply an attempt to understand those capabilities and figure out how they can support real development work.

---

## Where Catalyst Works Best

Today Catalyst has primarily been used with local Claude Code environments such as:

- Claude Code CLI
- HumanLayer
- CodeLayer
- Conductor

These environments allow tighter feedback loops and more control over execution.

Cloud-based asynchronous coding agents may work but have not been extensively tested.

---

## The Goal

Catalyst explores a simple question:

> What does software engineering look like when AI is a real collaborator?

Not a prompt collection. Not a demo environment.

A workspace for developers who want to be more ambitious about what they build with AI.
