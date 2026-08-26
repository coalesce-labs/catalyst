---
name: morning-briefing
description:
  Generate a daily briefing markdown at thoughts/briefings/YYYY-MM-DD.md with six sections —
  Review yesterday, Surface decisions, Plan today, relay-dispatch candidates, Friction since last
  briefing, and Learnings since last briefing — synthesized from Linear, GitHub,
  Granola, Google Drive, Google Calendar, and the compound-engineering stores in parallel. Then
  fans the briefing out to four destinations (Slack DM, Slack channel, Notion page, Loom script
  file). Use when the user says "morning briefing" / "run my briefing", or on a weekday-morning
  schedule via the CMA Routine wrapping this same skill.
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, mcp__linear__*, mcp__notion__*
---

# Morning Briefing — canonical markdown + fan-out

Invoke as `/catalyst-dev:morning-briefing` to produce today's briefing locally and fan it out to
Slack DM, Slack channel, Notion page, and a Loom recording script.

## Flags

| Flag | Meaning |
|---|---|
| `--date YYYY-MM-DD` | Target date. Default: today (UTC). |
| `--dry-run` | Write to `/tmp/morning-briefing-<date>.md` instead of `thoughts/briefings/`. |

## Load on demand

| when | read |
| -- | -- |
| gathering yesterday/today from Linear, GitHub, Granola, Drive, Calendar | `references/gather.md` |
| surfacing decisions — ADR drift, blocked PRs, judgment calls, compound proposals | `references/decisions.md` |
| the ADR-drift detector's frontmatter contract, output shape, and config resolution | `references/adr-drift.md` |
| the friction / learnings "since last briefing" digests | `references/digests.md` |
| suggesting which tickets look ready for a relay-ticket dispatch | `references/suggest-dispatch.md` |
| rendering the markdown, or fanning it out to Slack/Notion/Loom | `references/render-fanout.md` |
| this host might have no cloud mirror, or a Linear read looks stale | `steward/references/cloud-detection.md` (canonical) |

## Loop

1. **Prelude** — start a session, resolve the output path for `$DATE`.
2. **Gather** — five sources in parallel, each degrading silently to `{}` if its credentials are absent (`references/gather.md`).
3. **Decisions + digests** — ADR drift, blocked PRs, judgment calls, compound proposals, friction/learnings windows (`references/decisions.md`, `references/digests.md`).
4. **Suggest relay-dispatch candidates** — tickets that look ready for `/relay-ticket` (`references/suggest-dispatch.md`).
5. **Render + fan out** — merge fragments, render the markdown, append the digests, fan out, and end the session (`references/render-fanout.md` — this is the last step; do not end the session again after it).

## Invariants

- **Single-ticket Linear reads go through the replica, gated by cloud-detection.** List/search calls (this skill's normal shape — an activity window, not one ticket) have no replica form yet and correctly stay on `linearis` directly, per the `linearis` skill's "Reading Linear" contract — that is not a shortcut.
- **"Suggest relay-dispatch candidates" names candidates for `/relay-ticket <TICKET>`**, never the legacy orchestrator or a retired background-dispatch path (CTL-2218).
- Every gather/fan-out helper degrades to an empty or skipped result rather than failing the whole run — the briefing always lands locally.

## Output contract

YAML frontmatter validated against `plugins/dev/templates/briefing-frontmatter.schema.json`
(required: `date`, `generated_by`, `decisions`; optional `output_status`). Six `## ...` body
sections: the four `render.sh` owns (Review yesterday, Surface decisions, Plan today, and the
relay-dispatch-candidates section — `render.sh` still hardcodes its heading as `## Suggest
orchestrator runs`, a residual label tracked in `references/suggest-dispatch.md`, not a live
dependency) plus the two compound digests. `Plan today` carries a `### Retro signals`
sub-section. Empty render sources render `_no data_`; empty compound stores render `_none_`. A
companion `<date>-loom-script.md` lands beside the briefing whenever the loom fan-out runs
(always — it has no credential prerequisite).

Pending compound-engineering ADR proposals (`thoughts/shared/compound/pending/*.md`) surface as
`decisions:` entries so `briefing-followup`'s `action-compound.sh` can apply/edit/defer/reject
them — the human-gated ADR approval surface.

## Pointers

`catalyst-dev:briefing-followup` (consumes this skill's output) · `catalyst-dev:linearis` ·
`relay-ticket` (what "suggest relay-dispatch candidates" points at) · `catalyst-dev:ticket-retro`.
