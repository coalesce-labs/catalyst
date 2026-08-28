# The status doc — template and cadence

One Linear **document per project**, attached to the project, titled exactly `Status — <project>`. It is the human's one screen for that scope. It exists **before your first dispatch** — a project with tickets in flight and no status doc reads, correctly, as "nobody is running this".

> **Every status doc — initiative and every project — is REPLACED/RECREATED in full on each
> refresh.** It is a concise exec summary of NOW, not an append log of history. Never add a new
> section or append to an existing one; write the whole document from scratch on every update.

## Template (CTL-2094 / COORD-380 — five sections, in this order; ≤60 lines / ~3K chars)

The first line under the title, always:

```markdown
> Last updated: <America/Chicago timestamp> by <steward/scope>
```

Then, exactly these five headings:

```markdown
## Goal right now
One sentence: the outcome this work is driving to, and the landing date.

## Needs from Ryan
Live items only. Each row links to an ask; a row with no ask does not belong.

| what | default if silent |

## Current status
One line per leg.

## Next
Numbered, ≤5.

## Risks
Each with its mitigation. A risk with no mitigation is a complaint.
```

≤60 lines / ~3K chars. If it does not fit, the Goal is doing too little work.

## Cadence

| scope state | update the doc |
| -- | -- |
| **active** (anything in flight) | on every merge · on every blocker change · at least every **90 min** |
| **quiet** (nothing in flight, no open ask) | once per 24 h — a dated "no change, next check `<time>`" line |
| **stale** (active, timestamp > 2 h old) | this is a defect; the concierge flags it 🔴 and pages you |

⛔ **Never write a timestamp you did not read from the clock.** `TZ=America/Chicago date` — an estimated timestamp on a document whose whole purpose is freshness is worse than no timestamp, because the stale check then silently passes.

⚠️ **The cadence is enforced by the supervisor, not by your memory.** A steward that held exactly this cadence as a brief instruction produced **zero** status docs in 90 minutes while dispatching five tickets. If your supervisor re-enters you saying the doc is stale, it is stale — update it, don't argue with the clock.

## Announcing it

Post the URL on the channel **once**, in this form, so the concierge's roll-up can find it:

```
STATUS-DOC <project>: <url>
```

Not every update — once, when the doc is created.
