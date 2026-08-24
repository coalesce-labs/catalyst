# Diagnostic Mode vs Subscription Mode

_Read this when `catalyst-events tail` appears silent or you suspect the event stream is stalled
— the difference between live subscription (seeks to EOF) and diagnostic mode (reads from start)._

The patterns in this skill are all subscription-mode usage. `tail` and `wait-for` seek to EOF on
first run, so they only see events that arrive *after* the command starts. That is the correct
default when a worker is blocking on a fresh PR merge — historical heartbeat noise would otherwise
drown out the signal.

It is the wrong default when the question is *"are events flowing at all?"*

```bash
# User runs this to "check if any events are coming through"
catalyst-events tail --filter '.attributes."event.name" | startswith("github.")'
# Sits silent. User concludes: tunnel is dead.
# Reality: tunnel is fine, just no NEW events since they started tailing.
```

A silent live-tail does NOT mean the tunnel is dead. It means there has been no NEW
activity matching your filter since you started tailing. To verify flow, switch to
diagnostic mode by passing `--since-line 0`, which reads the entire current month's log
from the start.

## Diagnostic recipes

```bash
# Most recent github event of any kind, regardless of repo
catalyst-events tail --since-line 0 --filter '.attributes."event.name" | startswith("github.")' \
  | tail -1

# Hourly count over the current log file
catalyst-events tail --since-line 0 --filter '.attributes."event.name" | startswith("github.")' \
  | jq -r '.ts | sub("Z$"; "") | sub(":[0-9]{2}:[0-9]{2}$"; ":00:00")' \
  | sort | uniq -c

# Per-repo breakdown — distinguishes "quiet repo" from "dead tunnel"
catalyst-events tail --since-line 0 --filter '.attributes."event.name" | startswith("github.")' \
  | jq -r '.attributes."vcs.repository.name"' | sort | uniq -c | sort -rn
```

The per-repo breakdown is the one that most often resolves the misdiagnosis — a tunnel
can be perfectly healthy while one watched repo has been quiet for hours and another is
flowing normally.

## Prefer status JSON when available

Once CTL-244 lands, `catalyst-monitor status --json` will expose a `webhookTunnel`
object (`{connected, smeeUrl, lastEventAt, eventCount24h, eventCount24hByRepo}`). That
is the structured first diagnostic step and should be checked before reaching for the
recipes above. The diagnostic recipes here are the manual deep-dive when status JSON is
unavailable, insufficient, or contradicts what you expect.
