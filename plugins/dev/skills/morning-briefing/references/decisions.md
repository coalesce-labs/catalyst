# Decisions — the four sources

Populate the `decisions:` array from four sources:

1. **ADR drift** — `adr-drift.sh` reads ADR `code_assertions` frontmatter and surfaces patterns
   that drift from the codebase. See `references/adr-drift.md`.
2. **Blocked PRs** — `gh search prs --review-requested @me --state open --json …` filtered to PRs
   with no commit in the last 48h. Each becomes one `{type: blocked_pr, …}` decision.
3. **Judgment-call Linear tickets** — `linearis issues list --team <team> --status "Triage,In
   Progress" --label needs-decision` (label name is informational; substitute whatever signal the operator uses). List-shaped, so it stays on `linearis` directly per the cloud-detection note in `references/gather.md`.
4. **Pending compound-engineering ADR proposals** — the `ticket-compound` curator queues
   APPROVE-gated ADR changes at `thoughts/shared/compound/pending/<TICKET>.md`. Each pending file becomes one decision the morning ritual can approve via `briefing-followup`'s `action-compound.sh`. Emitted as `type: judgment_call` (the frontmatter schema's `type` enum has no `compound_adr` value) carrying a `pending:` path — the discriminator `briefing-followup` routes on.

```bash
# ADR drift detection
bash "$SCRIPT_DIR/adr-drift.sh" --root "$(pwd)" > "$SCRATCH/adr-drift.json"

# Blocked-PR + judgment-call sources are still TODO — start with an empty fragment.
echo '{"decisions": []}' > "$SCRATCH/decisions-other.json"

# Pending compound ADR proposals. Resilient to an absent/empty store: the glob
# below simply yields nothing when thoughts/shared/compound/pending/ is missing.
PENDING_DIR="thoughts/shared/compound/pending"
: > "$SCRATCH/compound-pending.jsonl"
if [[ -d "$PENDING_DIR" ]]; then
  for pf in "$PENDING_DIR"/*.md; do
    [[ -e "$pf" ]] || continue   # no-match glob guard (no nullglob needed)
    PTICKET=$(grep -m1 '^ticket:' "$pf" 2>/dev/null \
      | sed -E 's/^ticket:[[:space:]]*//; s/^"//; s/"$//; s/^'\''//; s/'\''$//')
    [[ -z "$PTICKET" ]] && PTICKET="$(basename "$pf" .md)"
    PTARGET=$(grep -m1 '^target:'  "$pf" 2>/dev/null | sed -E 's/^target:[[:space:]]*//')
    PADRID=$(grep -m1 '^adr_id:'   "$pf" 2>/dev/null | sed -E 's/^adr_id:[[:space:]]*//')
    PRAT=$(grep -m1 '^rationale:'  "$pf" 2>/dev/null | sed -E 's/^rationale:[[:space:]]*//')
    PSUMMARY="ADR proposal (${PTARGET:-new}${PADRID:+ $PADRID}) from ${PTICKET}${PRAT:+: $PRAT}"
    jq -nc \
      --arg id "compound-${PTICKET}" \
      --arg summary "$PSUMMARY" \
      --arg ticket "$PTICKET" \
      --arg pending "$pf" \
      '{id: $id, type: "judgment_call", summary: $summary, status: "open",
        ticket: $ticket, pending: $pending}' >> "$SCRATCH/compound-pending.jsonl"
  done
fi
jq -sc '{decisions: .}' "$SCRATCH/compound-pending.jsonl" > "$SCRATCH/compound-pending.json"

# Merge all decision sources into one fragment
jq -s '{decisions: (
        ((.[0] // {}).decisions // [])
      + ((.[1] // {}).decisions // [])
      + ((.[2] // {}).decisions // []))}' \
  "$SCRATCH/adr-drift.json" "$SCRATCH/decisions-other.json" "$SCRATCH/compound-pending.json" \
  > "$SCRATCH/decisions.json"
```
