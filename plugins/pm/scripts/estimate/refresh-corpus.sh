#!/usr/bin/env bash
# refresh-corpus.sh — re-run the corpus WRITE SIDE from real actuals (CTL-813).
#
# Closes the estimation feedback loop: until CTL-813 the committed read-side
# corpus (reference-class-corpus.json) was a frozen one-shot bootstrap
# (CTL-751) produced by the lossy adapt-reference-corpus.ts path (title=''
# / tier=null / empty signals). This script makes score-tickets.ts the
# RECURRING producer:
#
#   1. Extract    bun extract-actuals-from-transcripts.ts  → actuals.csv
#   2. Aggregate  compound-log.sh aggregate                → human re-scores
#   3. Collect    bun collect-ticket-signals.ts            → signals.csv
#   4. Score      bun score-tickets.ts --check-labels      → fresh corpus
#   5. Merge      fresh entries REPLACE same-ticket old entries; old entries
#                 not re-scored are RETAINED (e.g. the ADV bootstrap anchors
#                 whose PRs live in another repo). generated_at advances.
#   6. Commit     (--commit) git add + commit the corpus.
#
# adapt-reference-corpus.ts stays bootstrap-only (the historical /tmp dict).
#
# Usage:
#   refresh-corpus.sh [--team CTL] [--corpus <path>] [--thoughts-dir <path>]
#                     [--actuals <csv>]   # skip Extract, use this CSV
#                     [--signals <csv>]   # skip Extract+Collect, use this CSV
#                     [--limit N] [--pr-limit N] [--no-check-labels]
#                     [--dry-run] [--commit] [--force] [--keep-workdir]
#
# Offline test seam: --signals makes steps 1-3 no-ops, so the integration
# test exercises Score+Merge with zero network (no linearis/gh/transcripts).
#
# Exit codes: 0 success; 1 validation/step failure (fails loud).

set -uo pipefail

err()   { echo "error: $*" >&2; }
fatal() { err "$*"; exit 1; }
note()  { echo "[refresh-corpus] $*"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
COMPOUND_LOG="${REPO_ROOT}/plugins/dev/scripts/compound-log.sh"

TEAM="CTL"
CORPUS="${SCRIPT_DIR}/reference-class-corpus.json"
THOUGHTS_DIR="${REPO_ROOT}/thoughts"
ACTUALS=""
SIGNALS=""
LIMIT="250"
PR_LIMIT="1000"
CHECK_LABELS=1
DRY_RUN=0
DO_COMMIT=0
FORCE=0
KEEP_WORKDIR=0

while [ $# -gt 0 ]; do
  case "$1" in
    --team)            TEAM="$2"; shift 2 ;;
    --corpus)          CORPUS="$2"; shift 2 ;;
    --thoughts-dir)    THOUGHTS_DIR="$2"; shift 2 ;;
    --actuals)         ACTUALS="$2"; shift 2 ;;
    --signals)         SIGNALS="$2"; shift 2 ;;
    --limit)           LIMIT="$2"; shift 2 ;;
    --pr-limit)        PR_LIMIT="$2"; shift 2 ;;
    --no-check-labels) CHECK_LABELS=0; shift ;;
    --dry-run)         DRY_RUN=1; shift ;;
    --commit)          DO_COMMIT=1; shift ;;
    --force)           FORCE=1; shift ;;
    --keep-workdir)    KEEP_WORKDIR=1; shift ;;
    -h|--help)         sed -n '2,33p' "$0" | sed 's|^# \{0,1\}||'; exit 0 ;;
    *) fatal "unknown flag: $1" ;;
  esac
done

command -v jq  >/dev/null 2>&1 || fatal "jq is required"
command -v bun >/dev/null 2>&1 || fatal "bun is required"

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/refresh-corpus.XXXXXX")"
cleanup() { [ "$KEEP_WORKDIR" -eq 1 ] || rm -rf "$WORKDIR"; }
trap cleanup EXIT
[ "$KEEP_WORKDIR" -eq 1 ] && note "workdir: $WORKDIR (kept)"

# ── 1-3. Build the signals CSV (unless injected) ────────────────────────────

if [ -z "$SIGNALS" ]; then
  if [ -z "$ACTUALS" ]; then
    ACTUALS="${WORKDIR}/actuals.csv"
    note "extract: harvesting transcript actuals (team=${TEAM})"
    bun "${SCRIPT_DIR}/extract-actuals-from-transcripts.ts" \
      --team "$TEAM" --apply --out "$ACTUALS" \
      || fatal "extract step failed"
  else
    note "extract: skipped (--actuals ${ACTUALS})"
  fi

  COMPOUND_JSON="${WORKDIR}/compound-aggregate.json"
  if [ -x "$COMPOUND_LOG" ]; then
    # Best-effort: an empty/absent compound-log store aggregates to a zeroed
    # object and the collector simply emits no human column values.
    "$COMPOUND_LOG" aggregate --thoughts-dir "$THOUGHTS_DIR" > "$COMPOUND_JSON" 2>/dev/null \
      || { note "compound-log aggregate failed — proceeding without human re-scores"; echo '{}' > "$COMPOUND_JSON"; }
    note "compound-log: $(jq -r '.entries // 0' "$COMPOUND_JSON") entr(ies), $(jq -r '.tickets // {} | length' "$COMPOUND_JSON") ticket(s)"
  else
    echo '{}' > "$COMPOUND_JSON"
    note "compound-log helper not found — proceeding without human re-scores"
  fi

  SIGNALS="${WORKDIR}/signals.csv"
  note "collect: joining Linear + merged PRs + actuals + compound-log"
  bun "${SCRIPT_DIR}/collect-ticket-signals.ts" \
    --team "$TEAM" --limit "$LIMIT" --pr-limit "$PR_LIMIT" \
    --actuals "$ACTUALS" --compound-log "$COMPOUND_JSON" \
    --out "$SIGNALS" \
    || fatal "collect step failed"
else
  note "extract+collect: skipped (--signals ${SIGNALS})"
fi

[ -s "$SIGNALS" ] || fatal "signals CSV is missing/empty: $SIGNALS"

# ── 4. Score → fresh corpus ─────────────────────────────────────────────────

FRESH="${WORKDIR}/fresh-corpus.json"
SCORE_ARGS=(--in "$SIGNALS" --out "${WORKDIR}/estimates.md" --json "$FRESH" --team "$TEAM")
[ "$CHECK_LABELS" -eq 1 ] && SCORE_ARGS+=(--check-labels)
note "score: voting calibrated heuristic (check-labels=$([ "$CHECK_LABELS" -eq 1 ] && echo on || echo off))"
bun "${SCRIPT_DIR}/score-tickets.ts" "${SCORE_ARGS[@]}" || fatal "score step failed"

FRESH_COUNT=$(jq -r '.entries | length' "$FRESH" 2>/dev/null) || fatal "fresh corpus unparseable: $FRESH"
if [ "$FRESH_COUNT" -eq 0 ] && [ "$FORCE" -eq 0 ]; then
  fatal "fresh corpus has 0 entries — nothing to refresh (pass --force to write anyway)"
fi

# ── 5. Merge fresh over old ─────────────────────────────────────────────────

if [ -f "$CORPUS" ]; then
  OLD_COUNT=$(jq -r '.entries | length' "$CORPUS" 2>/dev/null) || OLD_COUNT=0
  OLD_GENERATED=$(jq -r '.generated_at // "unknown"' "$CORPUS" 2>/dev/null)
else
  OLD_COUNT=0
  OLD_GENERATED="none"
  echo '{"generated_at":null,"schema":"catalyst.estimation.corpus.v1","count":0,"entries":[]}' > "${WORKDIR}/empty.json"
  CORPUS_INPUT="${WORKDIR}/empty.json"
fi

MERGED="${WORKDIR}/merged-corpus.json"
jq -s '
  (.[0].entries | map({key: .ticket_id, value: true}) | from_entries) as $fresh_ids
  | {
      generated_at: .[0].generated_at,
      schema: .[0].schema,
      entries: (
        .[0].entries
        + (.[1].entries | map(select($fresh_ids[.ticket_id] | not)))
      )
    }
  | .count = (.entries | length)
' "$FRESH" "${CORPUS_INPUT:-$CORPUS}" > "$MERGED" || fatal "merge step failed"

MERGED_COUNT=$(jq -r '.count' "$MERGED")
RETAINED=$(( MERGED_COUNT - FRESH_COUNT ))
NEW_GENERATED=$(jq -r '.generated_at' "$MERGED")

note "summary: old=${OLD_COUNT} fresh=${FRESH_COUNT} retained=${RETAINED} merged=${MERGED_COUNT}"
note "generated_at: ${OLD_GENERATED} → ${NEW_GENERATED}"

if [ "$MERGED_COUNT" -lt "$OLD_COUNT" ] && [ "$FORCE" -eq 0 ]; then
  fatal "merged corpus (${MERGED_COUNT}) is SMALLER than the old one (${OLD_COUNT}) — refusing (pass --force to override)"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  note "--dry-run: corpus not written (${CORPUS})"
  exit 0
fi

mkdir -p "$(dirname "$CORPUS")"
cp "$MERGED" "$CORPUS" || fatal "could not write corpus: $CORPUS"
note "wrote ${MERGED_COUNT} entries → ${CORPUS}"

# ── 6. Optional commit ──────────────────────────────────────────────────────

if [ "$DO_COMMIT" -eq 1 ]; then
  git -C "$(dirname "$CORPUS")" add "$CORPUS" \
    && git -C "$(dirname "$CORPUS")" commit -m "chore(pm): refresh reference-class corpus (${FRESH_COUNT} fresh, ${MERGED_COUNT} total)" \
    || fatal "git commit failed"
  note "committed corpus refresh"
fi
