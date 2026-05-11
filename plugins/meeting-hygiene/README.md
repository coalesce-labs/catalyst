# Catalyst Meeting Hygiene Plugin

Meeting workflow skills — agenda creation, transcript processing, end-of-day batch cleanup, and post-meeting effectiveness retros.

> **Companion to [catalyst-pm](../pm/README.md)** which focuses on strategy, PRDs, priorities, and release sequencing. This plugin handles the meeting-workflow layer that runs *alongside* the product work.

## Skills (4)

### Pre-meeting
- `/catalyst-meeting-hygiene:meeting-agenda` — Create structured agendas with timeboxing, pre-reads, and clear outcomes

### Post-meeting (single session)
- `/catalyst-meeting-hygiene:meeting-notes` — Transform transcripts, raw notes, or voice memos into structured action items and decisions

### Post-meeting (batch)
- `/catalyst-meeting-hygiene:meeting-cleanup` — End-of-day batch processing across all of today's meetings; consolidates action items and insights

### Retrospective
- `/catalyst-meeting-hygiene:meeting-feedback` — Post-meeting 5-dimension effectiveness retro; tracks patterns over time

## Installation

```bash
/plugin marketplace add coalesce-labs/catalyst
/plugin install catalyst-meeting-hygiene
```

## License

MIT
