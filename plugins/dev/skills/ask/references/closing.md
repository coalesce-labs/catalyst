# Closing an ask — verify, reply, then Done

When the answer satisfies the ask: **verify** that it does (e.g. a token really carries the permission),
then:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/ask.mjs" accept CTL-NNNN --as <AGENT> --body "accepted — …"
#   --body -     read the reply from stdin
#   --dry-run    show what it would reply and close, without writing
```

`accept` replies in-thread as the app actor and moves the ticket to Done. Two refusals are
deliberate: it **refuses a ticket without the `catalyst-ask` label** (closing a work ticket
because an id was mistyped is not recoverable by the person who typed it), and if the reply
fails it leaves the ticket **OPEN** rather than closing it — a Done ask with no recorded
answer is worse than an open one, because it clears the human's view while the decision goes
unrecorded.

The manual equivalent: reply threaded **"accepted — has what it needs"** (or state exactly what
is still missing), and **move the ticket to Done yourself** (`linearis issues update <ID> --status Done`). Downstream work continues
on the work tickets. If the human's action surfaces a defect (CTC-649 → CTC-652), file the defect,
`blocks →` the ask, keep the ask open, say so in the thread.

