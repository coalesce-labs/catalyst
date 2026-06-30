---
title: See all your work
description: Watch every ticket's real status on your Linear board and in a live dashboard — phase, PR, cost, and time, across all the work running at once.
sidebar:
  order: 1
---

You can see the state of every ticket at a glance. Two views show it: your Linear board, and a live dashboard.

## Your Linear board

The board is the simplest view. Each ticket's column **is** its real status, updated as the agents work. A ticket in "In Review" really has an open PR. A ticket in "Done" really merged. Just watch the columns move.

## The Catalyst Monitor dashboard

The Monitor is a web page that shows every running worker in one place. Start it:

```bash
bash plugins/dev/scripts/catalyst-monitor.sh start
```

Then open [http://localhost:7400](http://localhost:7400). (Change the port with `MONITOR_PORT`.)

For each ticket it shows:

- which step it's on (research, implement, review, and so on)
- its pull request and whether the checks passed
- how much it has cost
- how long it has run

This is read-only — it shows you what's happening; you act from Linear and GitHub. It's the best view when several tickets run at once.

## Watch from anywhere — even with your laptop closed

In a **split** setup — a developer laptop plus an always-on **worker** machine — the worker is the read-replica host. Its broker is the only process that writes the dashboard's data store (`filter-state.db`) from the live GitHub and Linear webhooks, and its Monitor serves that data read-only over HTTP. The Monitor listens on every network interface, so you reach it from any device on the same network (or Tailscale):

- **From your phone:** open `http://<worker-host>:7400` in the browser, or add it to your home screen as an app. The board, ticket details, and search all render from the worker's fresh replica — so you can check on the work from the couch with your laptop shut.
- **From your laptop's terminal HUD:** point it at the worker by setting [`catalyst.readReplica.baseUrl`](/reference/configuration/) (or the `CATALYST_MONITOR_URL` environment variable) to `http://<worker-host>:7400`. A developer laptop runs no broker of its own, so without this it has nothing to show — it reads the worker's replica instead of an empty local one.

Everything here is **read-only**. You still act on the work from Linear and GitHub, and writing to Linear still requires a host that has its own Linear key — so pointing more devices at the worker's board never changes who can make changes.

This dashboard is for **human visibility** — it is *not* how Catalyst's agents read Linear during a workflow. Agent reads follow the two-mode rule in the `catalyst-dev:linearis` skill's "Reading Linear" section (standard node → direct `linearis`; Catalyst Cloud node → the SDK-managed local replica first, with `linearis` as the evidence-triggered fallback).

## A live terminal view

Prefer the terminal? Run `catalyst-hud` for a live stream of events as they happen. On a minimal setup (like SSH from an iPad), use `catalyst-hud-classic` instead.

## Updates within seconds

Set up GitHub webhooks (a webhook is a message GitHub sends Catalyst when something happens), and PR, review, check, and deploy events reach the dashboard within a few seconds. Without webhooks, Catalyst falls back to checking about every 10 minutes.

## When something needs you

When a worker gets stuck or needs a decision, Catalyst shows it — but it does **not** page or message you. You'll see:

- a red "attention" badge on the dashboard
- the event in `catalyst-hud`
- a **needs-human** label on the Linear ticket

So keep the board or dashboard in view. Nothing pushes a notification to your phone; you watch the work, and step in when a ticket asks for you.
