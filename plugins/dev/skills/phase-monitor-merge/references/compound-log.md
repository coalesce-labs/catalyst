# Compound-log Closing Entry and Cross-ticket Retro

After the merge lands, write the ticket's compound-log entry so the estimation loop's sink fills
autonomously (the unbuilt CTL-189 — in `merge-pr` a human answers these prompts; here YOU author
them). **Best-effort: on ANY failure log one line and continue to the End block — never fail or
block the phase on this.**

1. **Re-score from the merged diff** (CTL-746 structural bands → points XS=1 S=3 M=5 L=8 XL=13; LOC
   = additions+deletions: `<50→1, <200→3, <800→5, <2000→8, else 13`):

```bash
LOC=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}" --jq '.additions + .deletions' 2>/dev/null || echo "")
if   [[ -z "$LOC" ]];      then POINTS=""
elif [[ "$LOC" -lt 50 ]];  then POINTS=1
elif [[ "$LOC" -lt 200 ]]; then POINTS=3
elif [[ "$LOC" -lt 800 ]]; then POINTS=5
elif [[ "$LOC" -lt 2000 ]]; then POINTS=8
else POINTS=13; fi
```

Adjust ±1 step with judgment (e.g. heavy rework you personally resolved — CI fix-up loops, rebases —
justifies a bump). Skip the whole section when `POINTS` is empty.

2. **Author the two reflections yourself** — you just walked this PR through merge, so you have the
   ground truth: `what_worked` (1-2 sentences) and `what_surprised_me` (1-2 sentences; the
   BEHIND-rebase treadmill, bot review threads, or flaky CI you resolved are exactly this signal).

3. **Write the entry.** The helper resolves `estimate_at_start`/cost/wall from its defaults; on a
   missing default, retry once with explicit overrides; on a duplicate (re-walked phase), the
   "already exists" failure IS the skip path:

```bash
CL="${PLUGIN_ROOT}/scripts/compound-log.sh"
"$CL" write "$TICKET" --pr "$PR_NUMBER" --estimate-actual "$POINTS" \
  --what-worked "$WHAT_WORKED" --what-surprised-me "$WHAT_SURPRISED" 2>/dev/null \
|| "$CL" write "$TICKET" --pr "$PR_NUMBER" --estimate-actual "$POINTS" \
  --what-worked "$WHAT_WORKED" --what-surprised-me "$WHAT_SURPRISED" \
  --cost-usd 0 --estimate-start 0 \
|| echo "phase-monitor-merge: compound-log entry skipped (non-fatal)" >&2
```

Do NOT run the corpus refresh here (that is `compound-estimate` step 6 / operator cadence — a
background phase worker must not mutate the committed corpus).

4. **Run the cross-ticket retro (CTL-831 — the per-ticket learning step).** After the compound-log
   entry (success OR skip), invoke `/catalyst-dev:ticket-retro` with no arguments. It regenerates
   `thoughts/shared/retros/ticket/<today>.md` over the since-last-retro window (same-day re-runs are
   cumulative by design) and refreshes the watch-items the morning briefing surfaces — this is how
   the system learns from every ticket it ships. Same contract as the entry above: **best-effort,
   never blocks the End block** — on any retro failure, log one line and continue.
