---
title: Linear is your control room
description: You write tickets and set priority; the agents reply in comments, move the cards, and work the PR. The whole conversation lives in Linear.
sidebar:
  order: 0
---

Linear is where you and your agents talk. You write the ticket. They reply in comments and move the card across the board. You don't watch a terminal — you read the ticket.

## Every step reports back

As each step runs, it posts a comment on the ticket:

- the triage estimate (small, medium, large, or epic)
- what the research found
- the plan it's going to follow
- a summary of what it implemented
- the verify and review results
- the pull request number and link
- the merge result, and the deploy

So the ticket becomes a full log of the work. You scroll the comments to see what happened, without opening a single file. (Comments are best-effort — a rare failed post is skipped, not retried.)

## The card moves itself

You don't drag the card after the first move. As the agent works, Catalyst mirrors each transition to your board — research, then planning, then in progress, then in review, then done. It keeps your board's status in step with the work.

## It reacts to what you change

The agents watch the ticket while they work:

- **Change the priority** and the queue re-ranks — bump a ticket to Urgent and it jumps the line.
- **Move a ticket to Canceled** (or Backlog or Duplicate) and the running worker stops.
- **Add a comment** and the agent sees it in the event stream.

One limit: the agents watch a ticket's **status, priority, and labels**. They do not read edits you make to the **description** after work starts. To change the spec mid-run, cancel the ticket, fix it, and move it back to Todo.

## It works the pull request for you

Once the PR is open, the agent doesn't stop and wait. It loops until the PR is clean or it hits a human decision:

- answers automated review bots and makes the fixes they ask for
- fixes failing CI (the checks that run on every PR), up to three tries
- rebases the branch when it falls behind `main`
- merges once GitHub says the PR is clean, then sets the ticket to Done

It stops and tags the ticket **needs-human** when a person must decide. That means a human reviewer asked for changes, there's a merge conflict, or a required approval is missing.

## Your job

Write good tickets. Set priorities. The rest of the conversation happens in Linear comments — you read them, and you step in only when a ticket is tagged needs-human.

Next: [See all your work](/autonomous-workflow/see-your-work/).
