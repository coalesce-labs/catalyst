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
