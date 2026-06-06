---
name: ticket-retro
description:
  "Cross-ticket retrospective VIEW (CTL-789 Loop C / CTL-814). **ALWAYS use when** the user says
  'ticket retro', 'run a retro', 'retrospective', 'what did we learn lately', or 'how are the
  estimates calibrating'. Synthesizes everything the compound loops captured since the last retro —
  friction logs, learnings, compound-log calibration, catalyst.db / merged-PR actuals — into
  thoughts/shared/compound/retros/<date>.md with a persisted watch-items block, and surfaces top
  patterns in the morning briefing's Plan today."
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Grep, Glob
---

# Ticket Retro — the cross-ticket compound view

Loop C of compound engineering: a human-readable reflection across a SET of tickets. It mostly
**reads** what Loop B (friction logs, learnings) and Loop A (compound-log, estimation corpus)
captured, then writes ONE artifact: the retro document.

**Hard contract — read-only VIEW:**

- The ONLY thing this skill writes is `thoughts/shared/compound/retros/<YYYY-MM-DD>.md`.
- It must NOT curate the learnings store, edit `thoughts/shared/CONCEPTS.md`, or touch ADRs —
  that is `ticket-compound`'s job (per-ticket curator). No Linear writes, no corpus writes.
- Every input store degrades to `_none_` — empty stores are the normal early state, never an error.

## Invocation

```
/catalyst-dev:ticket-retro                      # since-last-retro (default scope)
/catalyst-dev:ticket-retro --since 2026-06-01   # explicit window floor
/catalyst-dev:ticket-retro --tickets CTL-1,CTL-2  # explicit ticket set (all time)
```

Default scope is **since-last-retro, no time box** (solo-dev rhythm — design decision, plan
line 114): the window floor is the date of the most recent retro in
`thoughts/shared/compound/retros/`; the first retro ever falls back to 14 days.

## Step 1: Gather (deterministic, read-only)

All reads go through the gather helper — one JSON document, every section degrades to empty:

```bash
GATHER="${CLAUDE_PLUGIN_ROOT:-plugins/dev}/scripts/ticket-retro/gather-retro.sh"
RETRO_JSON=$(mktemp)
bash "$GATHER" --thoughts-dir thoughts "$@" > "$RETRO_JSON"
jq '{window, prior_retro: (.prior_retro != null), friction: (.friction|length),
     learnings: (.learnings|length), calibration: (.calibration.entries // 0),
     merged_prs: (.merged_prs|length), db_stats: (.db_stats|length)}' "$RETRO_JSON"
```

What it returns (see the script header for the full shape):

| Key | Source | Degrades to |
|---|---|---|
| `window` | latest `retros/YYYY-MM-DD.md` / `--since` / `--tickets` | 14-day default |
| `prior_retro.watch_items` | the previous retro's fenced `yaml watch-items` block | `null` |
| `friction[]` | `thoughts/shared/friction/*.md` (`## <phase> · <TICKET> · <ISO-8601>` records after the floor) | `[]` |
| `learnings[]` | `thoughts/shared/learnings/**` frontmatter, mtime after the floor | `[]` |
| `calibration` | `compound-log.sh aggregate` (estimate_at_start vs estimate_actual) | `{}` |
| `merged_prs[]` | `gh pr list --state merged` in-window, ticket id from branch/title | `[]` |
| `db_stats[]` | `~/catalyst/catalyst.db` sessions⋈session_metrics per ticket (SPARSE — see note) | `[]` |

**Actuals note:** `db_stats` covers only orchestrator-run tickets with metrics rows (historically
~13 of 333). `merged_prs[].additions/deletions` (diff churn) is the universal actuals fallback —
use it for the aggregate stats; treat db cost/hours as a bonus column where present.

## Step 2: Synthesize (your judgment — this is the LLM half)

1. **What we did** — group `merged_prs` by ticket; one line each. Failed/abandoned tickets that
   show up in friction but not in `merged_prs` belong here too (often highest-signal).
2. **Recurring friction patterns** — cluster `friction[].line` entries that describe the same
   underlying problem (same component, same failure shape — NOT necessarily same wording). A
   pattern needs **≥2 records** (across tickets or phases). One-off frictions are listed only if
   severe. For each pattern: a name, the supporting records (`ticket·phase`), and one sentence of
   synthesis.
3. **Watch-item recurrence** — for each `prior_retro.watch_items[]` pattern, check whether this
   window's friction/learnings show it again. Verdict per item: `recurred` (cite evidence),
   `quiet` (no sighting), or `resolved` (a learning/ADR/fix landed that addresses it — cite it).
4. **Estimation calibration** — from `calibration`: count/exact/mean-signed-delta/median-abs-delta
   plus a per-ticket start→actual table. When `calibration.entries == 0`, render `_none_` and note
   the sink fills at merge (`merge-pr` 12b / `phase-monitor-merge`).
5. **Next watch items** — carry forward unresolved prior items (keep their `first_seen`) and add
   new patterns from (2) worth tracking. Cap at ~7 — a watch list longer than that is a backlog,
   not a watch list.

## Step 3: Write the retro document

Path: `thoughts/shared/compound/retros/<YYYY-MM-DD>.md` (today UTC). Template:

```markdown
---
date: <YYYY-MM-DD>
type: retro
generated_by: ticket-retro
window_since: <window.since>
window_source: <window.source>
tickets_shipped: <N>
---

# Ticket Retro — <YYYY-MM-DD>

Window: <window.since> → today (<window.source>)

## What we did

- `CTL-x` title — #PR (+adds/−dels)
- …                                      (_none_ when empty)

## Aggregate stats

| Metric | Value |
|---|---|
| Tickets shipped | N |
| Diff churn (LOC) | +A / −D |
| Sessions / cost / hours (catalyst.db, sparse) | N / $C / H |

## Recurring friction patterns

- **<pattern name>** (N records: CTL-a·research, CTL-b·implement) — one-sentence synthesis.
- …                                      (_none_ when empty)

## What we learned

- [component] title — `path`             (_none_ when empty)

## Estimation calibration

entries: N · exact: N · mean signed delta: +X.X · median |delta|: X

| Ticket | start | actual | Δ |
|---|---|---|---|
…                                        (_none_ when empty)

## Watch items from last retro

- ✅ resolved / 🔁 recurred / 💤 quiet — <pattern> (evidence)
…                                        (_no prior retro_ on the first run)

## Watch items

```yaml watch-items
- pattern: "<short greppable description>"
  component: <orchestrator|phase-agent|broker|monitor|cli|ci|worktree|linear|execution-core|estimation|website|plugins>
  first_seen: <YYYY-MM-DD of when it first appeared — preserve across retros>
  source: <TICKET the clearest record came from>
```
```

**The watch-items block is the only stateful contract.** The next retro and the morning briefing
both machine-parse it: keep the exact fence info string `yaml watch-items`, the exact four keys,
and `pattern` values double-quoted. `component` uses the learnings-store enum
(`ticket-compound/reference.md`).

## Step 4: Sync + report

```bash
humanlayer thoughts sync 2>/dev/null || true
echo "ticket-retro: wrote thoughts/shared/compound/retros/$(date -u +%Y-%m-%d).md"
```

Report to the user: the retro path, top 3 recurring patterns, the calibration one-liner, and any
recurred watch-items. The next morning briefing surfaces the watch-items automatically
(`Plan today → Retro signals`).

## Relationship to the other compound skills

| Skill | Owns | Scope |
|---|---|---|
| `ticket-compound` | learnings / CONCEPTS / ADR proposals (writes) | one ticket |
| `compound-estimate` | estimation numbers → compound-log (writes) | one PR |
| **`ticket-retro`** | the cross-ticket VIEW (reads both, writes only its retro doc) | a window of tickets |
