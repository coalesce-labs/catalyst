# Readiness — deciding what to dispatch

A ticket is **ready** only when all four tests pass. Record a verdict for every ticket you looked at, not just the ones you dispatched — the ones you skipped are the half a reader cannot reconstruct.

## The four tests

### 1. Acceptance criteria are present

The description contains the outcome and its acceptance criteria (`catalyst-dev:gherkin-ticket` shape: an outcome title `<actor> should <outcome> so that <benefit>`, plus Given/When/Then). A ticket whose ACs are "make it work" sends a worker to guess. Not ready — say what is missing in the thread.

⚠️ **Check what the ACs point AT, not just that they exist.** A ticket can be perfectly well-formed and still target a directory, app or route that no longer exists after a refactor. That is not a worker's problem to discover at Implement time.

### 2. No open blocker

⛔ **Read the `relations` table. Do not read the prose.** "Blocked by the auth work" in a description is not a relation, and a `blocks →` relation whose other end is already Done is not a blocker.

```sql
-- open blockers on <TICKET>: rows where something that is NOT Done blocks it
SELECT r.*, i.identifier, i.state
FROM relations r JOIN issues i ON i.id = r.related_issue_id
WHERE r.issue_identifier = '<TICKET>' AND r.type = 'blocked_by' AND i.state != 'Done';
```

Prose-scraped dependencies were retired deliberately (CTL-838): link them, don't infer them. If you believe a dependency exists and no relation records it, **create the relation**, then re-test.

### 3. Not owner-held

Somebody — a lane agent or a human — is mid-flight in that file set or on that ticket. Dispatching a fleet worker into it produces two agents editing the same surface. Check: recent commits, an assignee who is not you, an open PR, a channel turn claiming it in the last hour.

### 4. Not colliding with a live gate or rehearsal

A ticket can be unblocked in the graph and still be the wrong ticket for the hour: it touches the surface a rehearsal is walking, or the file set a live migration/credential gate is executing in. Hold it and name the collision. This is a judgement call and it must be written down as one.

## Recording the verdict

In the plan thread, one row per ticket:

| ticket | ACs | blockers | owner-held | collision | verdict |
| -- | -- | -- | -- | -- | -- |
| CTC-441 | ✅ | none | no | no | **dispatch** |
| CTC-55 | ⛔ targets a retired app | none | no | no | **hold — needs re-scoping** |

A "hold" with no reason is indistinguishable from an oversight. See `dispatch.md`.
