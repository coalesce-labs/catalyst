#!/usr/bin/env bash
# writeback.sh — At end of a briefing-followup session, persist resolutions back
# to the briefing markdown's frontmatter, append a "Decisions Made Today"
# section, commit + push the change to the routine-scoped branch, and emit
# `briefing.followup.complete.<date>` so the next morning's briefing routine
# can surface yesterday's decisions as carryovers. (CTL-465 Phase 4.)
#
# Usage:
#   writeback.sh --briefing <briefing.md> --resolutions <resolutions.json> \
#                --date YYYY-MM-DD [--no-commit] [--no-push] [--no-event] \
#                [--events-dir DIR]
#
# Output: one JSON line on stdout with at minimum a `status` field
# (`updated` | `skipped` | `failed`). On `updated` also emits `commit_sha`,
# `resolutionCount`, `event`, `briefing`. On non-zero exit, status is `failed`
# and `reason` is populated.

set -uo pipefail

# ─── Flag parsing ───────────────────────────────────────────────────────────
BRIEFING=""
RESOLUTIONS=""
DATE=""
NO_COMMIT=0
NO_PUSH=0
NO_EVENT=0
EVENTS_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --briefing)    BRIEFING="${2:-}"; shift 2 ;;
    --resolutions) RESOLUTIONS="${2:-}"; shift 2 ;;
    --date)        DATE="${2:-}"; shift 2 ;;
    --no-commit)   NO_COMMIT=1; shift ;;
    --no-push)     NO_PUSH=1; shift ;;
    --no-event)    NO_EVENT=1; shift ;;
    --events-dir)  EVENTS_DIR="${2:-}"; shift 2 ;;
    -h|--help)     sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "writeback.sh: unknown flag $1" >&2; exit 2 ;;
  esac
done

for required in BRIEFING RESOLUTIONS DATE; do
  if [[ -z "${!required}" ]]; then
    echo "writeback.sh: --${required,,} is required" >&2
    exit 2
  fi
done

if ! [[ "$DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  echo "writeback.sh: --date must be YYYY-MM-DD, got: $DATE" >&2
  exit 2
fi
if [[ ! -f "$BRIEFING" ]]; then
  echo "writeback.sh: briefing not found: $BRIEFING" >&2
  exit 2
fi

# ─── Helpers ────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="${SCRIPT_DIR}/../briefing-frontmatter-lib.sh"
# shellcheck source=../briefing-frontmatter-lib.sh
if [[ -f "$LIB" ]]; then source "$LIB"; fi

CATALYST_DIR_DEFAULT="${CATALYST_DIR:-$HOME/catalyst}"
EVENTS_DIR="${EVENTS_DIR:-$CATALYST_DIR_DEFAULT/events}"

# Print a one-line JSON status to stdout. Caller-friendly when chained from
# the SKILL.md so the result lands in the resolutions log alongside handler
# outputs.
emit_status() {
  jq -nc "$@" || echo "{}"
}

# ─── Short-circuit when there are no resolutions to write back ──────────────
if [[ ! -f "$RESOLUTIONS" ]]; then
  emit_status \
    --arg status "skipped" \
    --arg reason "resolutions file not found" \
    --arg path "$RESOLUTIONS" \
    '{status: $status, reason: $reason, path: $path}'
  exit 0
fi

RES_COUNT=$(jq 'length' "$RESOLUTIONS" 2>/dev/null || echo 0)
if [[ -z "$RES_COUNT" || "$RES_COUNT" -eq 0 ]]; then
  emit_status \
    --arg status "skipped" \
    --arg reason "no resolutions recorded" \
    --arg path "$RESOLUTIONS" \
    '{status: $status, reason: $reason, path: $path}'
  exit 0
fi

# ─── Merge resolutions into frontmatter + body ──────────────────────────────
# Python is already a hard dep of parse-briefing.sh + validate-frontmatter.sh
# (via PyYAML). One python invocation handles both the frontmatter mutation and
# the body splice deterministically — no fragile in-place sed.
NEW_FILE=$(mktemp)
trap 'rm -f "$NEW_FILE"' EXIT

python3 - "$BRIEFING" "$RESOLUTIONS" "$NEW_FILE" <<'PY'
import sys, json, re
import yaml

briefing_path, resolutions_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]

with open(briefing_path, "r", encoding="utf-8") as f:
    raw = f.read()

# Split frontmatter from body. The schema requires a leading `---\n...\n---`
# block — fall back to "no frontmatter" if anything else.
m = re.match(r"^---\s*\n(.*?\n)---\s*\n?(.*)$", raw, re.DOTALL)
if not m:
    sys.stderr.write("writeback.sh: briefing has no YAML frontmatter\n")
    sys.exit(2)
fm_text, body = m.group(1), m.group(2)
fm = yaml.safe_load(fm_text) or {}
if not isinstance(fm, dict):
    sys.stderr.write("writeback.sh: YAML root must be a mapping\n")
    sys.exit(2)

with open(resolutions_path, "r", encoding="utf-8") as f:
    resolutions = json.load(f)
if not isinstance(resolutions, list):
    sys.stderr.write("writeback.sh: resolutions JSON must be an array\n")
    sys.exit(2)

# Frontmatter mutations:
# 1. Replace the entire resolutions list (idempotent — second run produces the
#    same list as the first).
fm["resolutions"] = resolutions

# 2. Flip each matching decision's status to "resolved". Decisions without a
#    resolution stay at their original status (open / deferred / etc.).
resolved_ids = {r.get("decision_id") for r in resolutions if isinstance(r, dict)}
for dec in fm.get("decisions", []) or []:
    if isinstance(dec, dict) and dec.get("id") in resolved_ids:
        dec["status"] = "resolved"

# Body mutations: strip any existing "## Decisions Made Today" section so a
# rerun never duplicates the block. The section runs from its heading to the
# next `## ` heading (or EOF).
section_re = re.compile(
    r"\n*## Decisions Made Today\n.*?(?=\n## |\Z)",
    re.DOTALL,
)
body_clean = section_re.sub("", body).rstrip()

# Render the new section. Each bullet captures the decision id, action, and a
# human-readable summary derived from the handler's result JSON. We keep the
# rules simple — handlers return well-known shapes (see action-*.sh), but the
# fallback prints `<action> (<status>)` so unknown shapes still show up.
def bullet_for(res):
    if not isinstance(res, dict):
        return None
    rid = res.get("decision_id") or "?"
    action = res.get("action") or "noop"
    result = res.get("result") or {}
    status = result.get("status") or "logged"
    extra = ""
    if "url" in result:
        extra = f" — <{result['url']}>"
    elif "html_link" in result:
        extra = f" — <{result['html_link']}>"
    elif "identifier" in result:
        extra = f" — {result['identifier']}"
    elif "adr_id" in result:
        extra = f" — {result['adr_id']}"
    return f"- **{rid}**: {action} _({status})_{extra}"

bullets = [b for b in (bullet_for(r) for r in resolutions) if b]
section_lines = ["", "## Decisions Made Today", ""] + bullets + [""]
new_body = body_clean.rstrip() + "\n" + "\n".join(section_lines)

# Re-serialize. PyYAML's safe_dump preserves the existing frontmatter shape
# well enough for our schema. Quoting/indent stays consistent with render.sh.
new_fm = yaml.safe_dump(fm, default_flow_style=False, sort_keys=False)
with open(out_path, "w", encoding="utf-8") as f:
    f.write("---\n")
    f.write(new_fm)
    f.write("---\n")
    f.write(new_body if new_body.endswith("\n") else new_body + "\n")
PY
PY_EXIT=$?
if [[ $PY_EXIT -ne 0 ]]; then
  emit_status --arg status "failed" --arg reason "frontmatter merge failed" \
    '{status: $status, reason: $reason}'
  exit 1
fi

# Move into place atomically. If the file already matches (idempotent rerun
# with the same inputs), there's nothing more to do for git/event.
if cmp -s "$NEW_FILE" "$BRIEFING"; then
  CHANGED=0
else
  CHANGED=1
  mv "$NEW_FILE" "$BRIEFING"
  trap - EXIT
fi

# ─── Git commit + optional push ─────────────────────────────────────────────
COMMIT_SHA=""
COMMIT_STATUS="skipped"
if [[ $NO_COMMIT -eq 0 ]]; then
  REPO_ROOT=$(git -C "$(dirname "$BRIEFING")" rev-parse --show-toplevel 2>/dev/null || echo "")
  if [[ -z "$REPO_ROOT" ]]; then
    COMMIT_STATUS="skipped"
  elif [[ $CHANGED -eq 0 ]]; then
    COMMIT_STATUS="unchanged"
  else
    # Stage only the briefing file — keeps unrelated working-tree state out of
    # the routine's commit stream.
    git -C "$REPO_ROOT" add "$BRIEFING" >/dev/null 2>&1 || true
    if git -C "$REPO_ROOT" diff --cached --quiet "$BRIEFING"; then
      COMMIT_STATUS="unchanged"
    else
      COMMIT_MSG="briefing(followup): ${DATE} resolutions"
      if git -C "$REPO_ROOT" commit -q -m "$COMMIT_MSG" >/dev/null 2>&1; then
        COMMIT_SHA=$(git -C "$REPO_ROOT" rev-parse HEAD)
        COMMIT_STATUS="committed"
      else
        COMMIT_STATUS="failed"
      fi
    fi

    # Push the routine-scoped branch if requested. The push target comes from
    # whatever upstream is configured — in the morning-briefing routine that's
    # `origin/routines/briefings` per the §1a write-back block.
    if [[ $NO_PUSH -eq 0 && "$COMMIT_STATUS" == "committed" ]]; then
      if ! git -C "$REPO_ROOT" push >/dev/null 2>&1; then
        # One retry with fetch+rebase, matching the ADR contract.
        BRANCH=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
        git -C "$REPO_ROOT" fetch origin "$BRANCH" >/dev/null 2>&1 || true
        git -C "$REPO_ROOT" rebase "origin/$BRANCH" >/dev/null 2>&1 \
          || git -C "$REPO_ROOT" rebase --abort >/dev/null 2>&1 || true
        git -C "$REPO_ROOT" push >/dev/null 2>&1 || COMMIT_STATUS="committed-not-pushed"
      fi
    fi
  fi
fi

# ─── Emit briefing.followup.complete.<date> ─────────────────────────────────
EVENT_NAME="briefing.followup.complete.${DATE}"
EVENT_EMITTED="false"
if [[ $NO_EVENT -eq 0 ]]; then
  # Source the canonical event lib. It's idempotent and writes one JSONL line
  # per call into the orchestrator's global event log so wait-for / tail can
  # pick up the completion signal alongside other Catalyst events.
  CE_LIB="${SCRIPT_DIR}/../lib/canonical-event.sh"
  if [[ -f "$CE_LIB" ]]; then
    # shellcheck source=../lib/canonical-event.sh
    source "$CE_LIB"
    TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    PAYLOAD=$(jq -nc \
      --arg date "$DATE" \
      --arg briefing "$BRIEFING" \
      --arg commit "${COMMIT_SHA:-}" \
      --argjson resolutionCount "${RES_COUNT:-0}" \
      '{date: $date,
        briefing: $briefing,
        commitSha: (if $commit == "" then null else $commit end),
        resolutionCount: $resolutionCount}')
    LINE=$(build_canonical_line \
      --ts "$TS" \
      --severity INFO \
      --service "catalyst.briefing" \
      --event-name "$EVENT_NAME" \
      --entity briefing \
      --action complete \
      --label "$DATE" \
      --session "${CATALYST_SESSION_ID:-}" \
      --orch "${CATALYST_ORCHESTRATOR_ID:-}" \
      --worker "${CATALYST_WORKER_TICKET:-}" \
      --payload-json "$PAYLOAD" 2>/dev/null) || LINE=""
    if [[ -n "$LINE" ]]; then
      canonical_jsonl_append "$EVENTS_DIR" "$LINE"
      EVENT_EMITTED="true"
    fi
  fi
fi

# ─── Status JSON ────────────────────────────────────────────────────────────
emit_status \
  --arg status "updated" \
  --arg briefing "$BRIEFING" \
  --arg commit_sha "${COMMIT_SHA:-}" \
  --arg commit_status "$COMMIT_STATUS" \
  --arg event "$EVENT_NAME" \
  --argjson resolutionCount "${RES_COUNT:-0}" \
  --argjson event_emitted "$EVENT_EMITTED" \
  '{status: $status,
    briefing: $briefing,
    resolutionCount: $resolutionCount,
    commit_sha: (if $commit_sha == "" then null else $commit_sha end),
    commit_status: $commit_status,
    event: $event,
    event_emitted: $event_emitted}'
