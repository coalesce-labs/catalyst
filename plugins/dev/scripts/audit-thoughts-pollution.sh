#!/usr/bin/env bash
# audit-thoughts-pollution.sh — classify the files in a thoughts checkout by their
# `repos/<subdir>/` PATH PREFIX and emit a misroute manifest. (CTL-1246, §6 of the
# cluster HLT thoughts-model design, CTL-1214.)
#
# The reliable discriminator is the path prefix, NOT content keywords (CTL- /
# catalyst / ADV-): an Adva friction note that mentions a CTL ticket is still legit
# Adva work and must stay put. Classifications:
#
#   MOVE     catalyst content (repos/{catalyst,catalyst-workspace,catalyst-otel}/…)
#            sitting in a NON-coalesce-labs thoughts repo — a true misroute.
#   REVERSE  Adva content (repos/Adva/…) sitting UNDER the coalesce-labs thoughts
#            repo — the reverse misroute; flagged, not auto-moved (operator call).
#   LEAVE    everything else: Adva content in the Adva repo, correctly-homed
#            catalyst content, and anything not under repos/<subdir>/.
#
# Read-only on --root. Pairs with migrate-thoughts-pollution.sh, which consumes the
# MOVE records from this manifest.
#
# Usage:
#   audit-thoughts-pollution.sh --root <thoughts-checkout> [--org <name>]
#                               [--out <manifest.jsonl>] [--format jsonl|md]
#
#   --root    REQUIRED. A thoughts checkout (git working tree).
#   --org     Org identity of the checkout. Auto-derived from the `origin` git
#             remote when omitted (groundworkapp normalizes to rightsite-cloud).
#   --out     Manifest destination (default: stdout).
#   --format  jsonl (default) — one record per non-LEAVE file; or md — a summary
#             table. A human-readable summary line always goes to stderr.
#
# Exit codes: 0 success · 1 bad/missing --root, undetermined org, or missing dep.
set -euo pipefail

info() { echo "[audit-thoughts] $*" >&2; }
fail() { echo "[audit-thoughts] ERROR: $*" >&2; }

usage() { sed -n '2,30p' "$0" >&2; }

# Adva code lives under groundworkapp/ locally but its THOUGHTS repo is
# rightsite-cloud — mirror provision-thoughts.sh:44 so org identity matches.
normalize_org() { case "$1" in groundworkapp) echo "rightsite-cloud" ;; *) echo "$1" ;; esac; }

ROOT=""; ORG=""; OUT=""; FORMAT="jsonl"
while [[ $# -gt 0 ]]; do case "$1" in
  --root)   ROOT="${2:-}"; shift 2 ;;
  --org)    ORG="${2:-}"; shift 2 ;;
  --out)    OUT="${2:-}"; shift 2 ;;
  --format) FORMAT="${2:-}"; shift 2 ;;
  -h|--help) usage; exit 0 ;;
  *) fail "unknown arg: $1"; usage; exit 1 ;;
esac; done

command -v jq  >/dev/null || { fail "jq required";  exit 1; }
command -v git >/dev/null || { fail "git required"; exit 1; }

[[ -n "$ROOT" ]]   || { fail "--root is required (a thoughts checkout)"; exit 1; }
[[ -d "$ROOT" ]]   || { fail "--root does not exist or is not a directory: $ROOT"; exit 1; }
git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || { fail "--root is not a git working tree: $ROOT"; exit 1; }

# Derive + normalize the org from the origin remote when not given explicitly.
if [[ -z "$ORG" ]]; then
  remote="$(git -C "$ROOT" remote get-url origin 2>/dev/null || true)"
  org_raw="$(sed -nE 's#.*github\.com[:/]([^/]+)/.*#\1#p' <<<"$remote" | head -1)"
  ORG="$(normalize_org "$org_raw")"
fi
[[ -n "$ORG" ]] || { fail "could not determine --org (pass --org or add a github origin remote)"; exit 1; }

# Catalyst thoughts subdirs (research Area 5: path-prefix boundary, NOT keywords).
is_catalyst_subdir() { case "$1" in catalyst|catalyst-workspace|catalyst-otel) return 0 ;; *) return 1 ;; esac; }

# Classify a single tracked path. Echoes "CLASSIFICATION<TAB>repo<TAB>reason".
classify() {
  local path="$1" sub
  if [[ "$path" == repos/*/* ]]; then
    sub="${path#repos/}"; sub="${sub%%/*}"
    if [[ "$ORG" != "coalesce-labs" ]] && is_catalyst_subdir "$sub"; then
      printf 'MOVE\t%s\tcatalyst content (repos/%s) in non-coalesce-labs thoughts repo %s\n' "$sub" "$sub" "$ORG"
      return
    fi
    if [[ "$ORG" == "coalesce-labs" && "$sub" == "Adva" ]]; then
      printf 'REVERSE\t%s\tAdva content (repos/Adva) under the coalesce-labs thoughts repo\n' "$sub"
      return
    fi
    printf 'LEAVE\t%s\tcorrectly-homed or non-catalyst content under repos/%s\n' "$sub" "$sub"
    return
  fi
  printf 'LEAVE\t-\tnot under repos/<subdir>/ (shared/global content)\n'
}

# ── Walk the tracked file set, classify, accumulate records ───────────────────
RECORDS=""           # JSONL, one record per non-LEAVE file
move_count=0; reverse_count=0; leave_count=0
declare -a ID_HITS=()

while IFS= read -r path; do
  [[ -z "$path" ]] && continue
  IFS=$'\t' read -r cls repo reason < <(classify "$path")
  case "$cls" in
    MOVE)    move_count=$((move_count + 1)) ;;
    REVERSE) reverse_count=$((reverse_count + 1)) ;;
    *)       leave_count=$((leave_count + 1)); continue ;;  # LEAVE not emitted
  esac
  rec="$(jq -nc --arg path "$path" --arg cls "$cls" --arg repo "$repo" \
               --arg org "$ORG" --arg reason "$reason" \
               '{path:$path, classification:$cls, repo:$repo, org:$org, reason:$reason}')"
  RECORDS+="${rec}"$'\n'
  # Informational only: collect any CTL-/ADV- IDs from the path (NOT used to classify).
  while IFS= read -r id; do [[ -n "$id" ]] && ID_HITS+=("$id"); done \
    < <(grep -oE 'CTL-[0-9]+|ADV-[0-9]+' <<<"$path" || true)
done < <(git -C "$ROOT" ls-files)

# Distinct IDs (informational).
distinct_ids=""
if ((${#ID_HITS[@]})); then
  distinct_ids="$(printf '%s\n' "${ID_HITS[@]}" | sort -u | tr '\n' ' ')"
fi

# ── Emit ──────────────────────────────────────────────────────────────────────
emit_jsonl() { printf '%s' "$RECORDS"; }
emit_md() {
  printf '# Thoughts pollution manifest — %s\n\n' "$ORG"
  printf '| classification | count |\n|---|---|\n'
  printf '| MOVE | %d |\n| REVERSE | %d |\n| LEAVE | %d |\n\n' "$move_count" "$reverse_count" "$leave_count"
  printf 'Distinct CTL/ADV IDs (informational): %s\n\n' "${distinct_ids:-none}"
  if [[ -n "$RECORDS" ]]; then
    printf '| path | classification | repo |\n|---|---|---|\n'
    while IFS= read -r rec; do
      [[ -z "$rec" ]] && continue
      printf '| %s | %s | %s |\n' \
        "$(jq -r .path <<<"$rec")" "$(jq -r .classification <<<"$rec")" "$(jq -r .repo <<<"$rec")"
    done <<<"$RECORDS"
  fi
}

render() { case "$FORMAT" in
  jsonl) emit_jsonl ;;
  md)    emit_md ;;
  *) fail "unknown --format: $FORMAT (want jsonl|md)"; exit 1 ;;
esac; }

if [[ -n "$OUT" ]]; then
  mkdir -p "$(dirname "$OUT")"
  render > "$OUT"
  info "manifest written: $OUT"
else
  render
fi

# Summary line (always stderr; "0 true misroutes" is the clean-tree signal).
if [[ "$move_count" -eq 0 ]]; then
  info "org=$ORG  MOVE=0 REVERSE=$reverse_count LEAVE=$leave_count — 0 true misroutes"
else
  info "org=$ORG  MOVE=$move_count REVERSE=$reverse_count LEAVE=$leave_count — $move_count true misroutes"
fi
exit 0
