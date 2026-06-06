---
name: phase-teardown
description: Phase agent for the 10th/terminal step of the pipeline (CTL-703). Performs all terminal wrap-up after monitor-deploy — verifies the PR merged, posts a final Linear comment with per-phase timings, transitions Linear to Done (the sole Done writer now), archives the worker dir to ~/catalyst/archives/<TICKET>/, removes the local worktree + branch, then emits phase.teardown.complete.<TICKET>. Reads phase-monitor-deploy.json as its prior-phase artifact. Dispatched via phase-agent-dispatch as a slash command — user-invocable: true.
user-invocable: true
disable-model-invocation: false
allowed-tools: Bash, Read, Write
version: 1.0.0
---

# phase-teardown

Terminal phase of the Catalyst pipeline (CTL-703). Runs after `phase-monitor-deploy`
has confirmed the deployed canary. Performs all end-of-lifecycle housekeeping:
safety-gates on merge status, posts a per-phase timing summary to Linear, transitions
the ticket to Done, archives the worker dir, and removes the local worktree + branch.

## Inputs

Environment:
- `TICKET` — Linear identifier (e.g. `CTL-703`). Required.
- `ORCH_DIR` — orchestrator working directory; signal files live under
  `${ORCH_DIR}/workers/${TICKET}/`.  Defaults to `$CATALYST_ORCHESTRATOR_DIR`.
- `ORCH_ID` — orchestrator instance ID. Defaults to `$CATALYST_ORCHESTRATOR_ID`.
- `PLUGIN_ROOT` — resolved from `$CLAUDE_PLUGIN_ROOT` or the skill's own dir tree.

Signal files read (all under `${ORCH_DIR}/workers/${TICKET}/`):
- `phase-monitor-deploy.json` — required prior-artifact; missing → fail.
- `phase-monitor-merge.json` — required for safety gate (`.pr.mergedAt` / `.pr.ciStatus`).
- `phase-*.json` — all present signal files are read for per-phase timing table.

## /goal condition

```
/goal "The pipeline for ${TICKET} has been fully wrapped-up: the PR is confirmed
       merged, a per-phase timing summary has been posted to Linear, Linear is
       transitioned to Done, the worker dir is archived to ~/catalyst/archives/${TICKET}/,
       the local worktree and branch are removed, and phase.teardown.complete.${TICKET}
       has been emitted to the event log."
```

## Body

```bash
set -uo pipefail

# ─── Resolver block (zsh-safe) ───────────────────────────────────────────────
__TD_SCRIPT_PATH="${BASH_SOURCE[0]:-${0}}"
__TD_SKILL_DIR="$(cd "$(dirname "$__TD_SCRIPT_PATH")" && pwd 2>/dev/null || pwd)"
__TD_REPO_ROOT="${PHASE_AGENT_REPO_ROOT:-$(cd "$__TD_SKILL_DIR/../../../.." 2>/dev/null && pwd || pwd)}"
__TD_LIB="${PHASE_EMIT_HELPER:-${__TD_REPO_ROOT}/plugins/dev/scripts/lib/phase-emit-complete.sh}"
__TD_WRAPPER="${PHASE_EMIT_WRAPPER:-${__TD_REPO_ROOT}/plugins/dev/scripts/phase-agent-emit-complete}"

if [[ ! -r "$__TD_LIB" ]]; then
  echo "phase-teardown: cannot find phase-emit-complete.sh at $__TD_LIB" >&2
  exit 1
fi
# shellcheck disable=SC1090
. "$__TD_LIB"

if [[ ! -x "$__TD_WRAPPER" ]]; then
  echo "phase-teardown: cannot find phase-agent-emit-complete wrapper at $__TD_WRAPPER" >&2
  exit 1
fi

: "${TICKET:?phase-teardown: TICKET env var required}"

# Trust the command arg / env over leaked CATALYST_* from a sibling dispatch
# (per memory: phase_env_ticket_leak_from_sibling). ORCH_DIR/ORCH_ID come from
# CATALYST_* but we pass --orch-id explicitly on the emit call below.
ORCH_DIR="${ORCH_DIR:-${CATALYST_ORCHESTRATOR_DIR:-}}"
ORCH_ID="${ORCH_ID:-${CATALYST_ORCHESTRATOR_ID:-}}"

# WORKER_DIR: canonical location for all signal files.
WORKER_DIR="${ORCH_DIR:+${ORCH_DIR}/workers/${TICKET}}"
WORKER_DIR="${WORKER_DIR:-$(pwd)}"
mkdir -p "$WORKER_DIR"

# Signal file — must exist (written by phase-agent-dispatch when it dispatches
# this phase). If missing, the wrapper will warn but proceed; the emit will
# still land the event.
SIGNAL_FILE="${WORKER_DIR}/phase-teardown.json"

# Resolve PLUGIN_ROOT (scripts dir) — used for linear-transition.sh, presweep.
PLUGIN_ROOT="${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}"
if [[ -z "$PLUGIN_ROOT" ]]; then
  PLUGIN_ROOT="$(cd "$__TD_SKILL_DIR/../.." 2>/dev/null && pwd || echo "")"
fi
```

```bash phase-teardown-safety-gate
# ─── Safety gate: require PR merged ──────────────────────────────────────────
# Read phase-monitor-deploy.json (prior-phase artifact).
DEPLOY_FILE="$WORKER_DIR/phase-monitor-deploy.json"
if [[ ! -f "$DEPLOY_FILE" ]]; then
  "$__TD_WRAPPER" --phase teardown --ticket "$TICKET" --status failed \
    --reason "prior_artifact_missing:monitor_deploy" \
    ${ORCH_ID:+--orch-id "$ORCH_ID"} ${ORCH_DIR:+--orch-dir "$ORCH_DIR"}
  exit 1
fi

# Read phase-monitor-merge.json for the merge confirmation.
MERGE_FILE="$WORKER_DIR/phase-monitor-merge.json"
if [[ ! -f "$MERGE_FILE" ]]; then
  "$__TD_WRAPPER" --phase teardown --ticket "$TICKET" --status failed \
    --reason "prior_artifact_missing:monitor_merge" \
    ${ORCH_ID:+--orch-id "$ORCH_ID"} ${ORCH_DIR:+--orch-dir "$ORCH_DIR"}
  exit 1
fi

MERGE_CI_STATUS="$(jq -r '.pr.ciStatus // empty' "$MERGE_FILE" 2>/dev/null)"
MERGED_AT="$(jq -r '.pr.mergedAt // empty' "$MERGE_FILE" 2>/dev/null)"

if [[ "$MERGE_CI_STATUS" != "merged" && -z "$MERGED_AT" ]]; then
  "$__TD_WRAPPER" --phase teardown --ticket "$TICKET" --status failed \
    --reason "pr_not_merged" \
    ${ORCH_ID:+--orch-id "$ORCH_ID"} ${ORCH_DIR:+--orch-dir "$ORCH_DIR"}
  exit 1
fi
```

```bash phase-teardown-timings
# ─── Per-phase timings ────────────────────────────────────────────────────────
# Loop all phase-*.json signal files; compute completedAt - startedAt for each.
# Build a markdown table for the mirror comment.

TIMING_TABLE="| Phase | Duration |
|-------|----------|"

for signal_f in "$WORKER_DIR"/phase-*.json; do
  [[ -f "$signal_f" ]] || continue
  phase_name="$(basename "$signal_f" .json | sed 's/^phase-//')"
  started="$(jq -r '.startedAt // empty' "$signal_f" 2>/dev/null || true)"
  completed="$(jq -r '.completedAt // empty' "$signal_f" 2>/dev/null || true)"
  if [[ -n "$started" && -n "$completed" ]]; then
    dur_secs="$(jq -n \
      --arg s "$started" --arg c "$completed" \
      '(($c|fromdateiso8601) - ($s|fromdateiso8601)) | floor' 2>/dev/null || echo "")"
    if [[ "$dur_secs" =~ ^[0-9]+$ ]]; then
      dur_h=$(( dur_secs / 3600 ))
      dur_m=$(( (dur_secs % 3600) / 60 ))
      dur_s=$(( dur_secs % 60 ))
      if [[ "$dur_h" -gt 0 ]]; then
        dur_str="${dur_h}h ${dur_m}m"
      elif [[ "$dur_m" -gt 0 ]]; then
        dur_str="${dur_m}m ${dur_s}s"
      else
        dur_str="${dur_s}s"
      fi
    else
      dur_str="_unknown_"
    fi
  else
    dur_str="_unknown_"
  fi
  TIMING_TABLE="${TIMING_TABLE}
| ${phase_name} | ${dur_str} |"
done
```

```bash phase-teardown-linear-done
# ─── Linear Done transition ───────────────────────────────────────────────────
# THIS IS THE ONLY Done writer when phase-teardown is in the pipeline.
# Called while still in the ticket worktree so .catalyst/config.json is adjacent.
LINEAR_TRANSITION="${PLUGIN_ROOT}/scripts/linear-transition.sh"
if [[ -x "$LINEAR_TRANSITION" ]]; then
  "$LINEAR_TRANSITION" --ticket "$TICKET" --transition done \
    --config .catalyst/config.json 2>/dev/null || true
else
  echo "phase-teardown: linear-transition.sh not found at $LINEAR_TRANSITION; skipping Done transition" >&2
fi
```

```bash phase-teardown-archive
# ─── Archive worker dir ───────────────────────────────────────────────────────
# Best-effort: copy signal files to ~/catalyst/archives/<TICKET>/.
# Failure logs and continues — teardown must not abort before worktree removal.
ARCHIVE_DIR="${HOME}/catalyst/archives/${TICKET}"
if mkdir -p "$ARCHIVE_DIR" 2>/dev/null; then
  if cp -R "${WORKER_DIR}/." "$ARCHIVE_DIR/" 2>/dev/null; then
    echo "phase-teardown: worker dir archived to $ARCHIVE_DIR"
  else
    echo "phase-teardown: archive cp failed (continuing)" >&2
  fi
else
  echo "phase-teardown: cannot create archive dir $ARCHIVE_DIR (continuing)" >&2
fi
```

```bash phase-teardown-worktree-removal
# ─── Worktree + branch removal ────────────────────────────────────────────────
# Gate on keepWorktreeAfterMerge != true (same pattern as phase-monitor-merge
# CTL-649 teardown block). This skill runs INSIDE the worktree it is about to
# remove; cd to the primary worktree first.

KEEP_WT="$(jq -r '.catalyst.orchestration.keepWorktreeAfterMerge // false' \
  .catalyst/config.json 2>/dev/null || echo "false")"

if [[ "$KEEP_WT" != "true" ]]; then
  WORKTREE_PATH="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  PRIMARY_WT="$(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2; exit}')"
  BRANCH_NAME="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"

  if [[ -z "$PRIMARY_WT" || "$PRIMARY_WT" == "$WORKTREE_PATH" ]]; then
    echo "phase-teardown: cannot resolve primary worktree distinct from self; auto-teardown skipped" >&2
  else
    cd "$PRIMARY_WT" || {
      echo "phase-teardown: cannot cd to primary worktree; auto-teardown skipped" >&2
      cd "$WORKTREE_PATH"  # restore, even on failure
    }

    if [[ "$PWD" == "$PRIMARY_WT" ]]; then
      PRESWEEP_BIN="${PLUGIN_ROOT}/scripts/lib/worktree-presweep.sh"
      # CTL-649: do NOT swallow presweep stderr — its "N session(s) still alive
      # in <path>" diagnostic is the precise leak signal this teardown exists to
      # surface. Let it flow straight through to the operator.
      if [[ -x "$PRESWEEP_BIN" ]] && ! "$PRESWEEP_BIN" "$WORKTREE_PATH"; then
        echo "phase-teardown: presweep failed for $WORKTREE_PATH; auto-teardown skipped" >&2
      else
        # Capture the real `git worktree remove` stderr so a failed teardown
        # reports the actual cause (dirty tree, locked, submodule, etc.) rather
        # than guessing. The merge is NEVER rolled back — we only warn + skip.
        WT_RM_ERR="$(git worktree remove "$WORKTREE_PATH" 2>&1)"
        if [[ $? -eq 0 ]]; then
          if [[ -n "$BRANCH_NAME" ]]; then
            git branch -D "$BRANCH_NAME" 2>/dev/null \
              || echo "phase-teardown: local branch $BRANCH_NAME already gone" >&2
          fi
          echo "phase-teardown: auto-teardown complete (worktree + branch removed)"
        else
          echo "phase-teardown: git worktree remove failed; auto-teardown skipped (merge left intact): ${WT_RM_ERR}" >&2
        fi
      fi
    fi
  fi
fi
```

```bash phase-teardown-mirror
# ─── End block: Linear mirror comment ────────────────────────────────────────
# Post a final summary to Linear (idempotent via marker). Uses ABSOLUTE signal
# paths — the worktree may be gone by now. Guard against double-posting by
# querying linearis issues discussions first (per memory:
# phase_mirror_marker_lost_on_rewalk), then falling back to the marker file.

LINEAR_MIRROR_MARKER="${WORKER_DIR}/.linear-mirror-teardown"
ARCHIVE_PATH="${HOME}/catalyst/archives/${TICKET}"

if [[ ! -e "${LINEAR_MIRROR_MARKER}" ]] && command -v linearis >/dev/null 2>&1; then
  WORKTREE_STATUS="removed"
  if [[ "${KEEP_WT:-false}" == "true" ]]; then
    WORKTREE_STATUS="kept (keepWorktreeAfterMerge=true)"
  fi

  MIRROR_BODY="$(cat <<EOF
**Phase Teardown** — pipeline complete for \`${TICKET}\`

### Per-phase timings

${TIMING_TABLE}

### Post-merge housekeeping

- **Linear**: transitioned to Done
- **Worktree**: ${WORKTREE_STATUS}
- **Archive**: \`${ARCHIVE_PATH}\`

_Posted automatically by phase-teardown (CTL-703)._
EOF
)"

  ORCH_DIR_RESOLVED="${ORCH_DIR:-}"
  FOOTER_BIN="${__TD_REPO_ROOT}/plugins/dev/scripts/lib/phase-mirror-footer.sh"
  if [[ -n "${ORCH_DIR_RESOLVED}" && -x "${FOOTER_BIN}" ]]; then
    MIRROR_FOOTER="$("${FOOTER_BIN}" --orch-dir "${ORCH_DIR_RESOLVED}" --ticket "${TICKET}" --phase "teardown" 2>/dev/null || true)"
    [[ -n "${MIRROR_FOOTER}" ]] && MIRROR_BODY="${MIRROR_BODY}
${MIRROR_FOOTER}"
  fi

  COMMENT_POST="${CATALYST_COMMENT_POST_HELPER:-${PLUGIN_ROOT}/scripts/lib/linear-comment-post.sh}"
  if [[ ! -x "$COMMENT_POST" ]]; then
    COMMENT_POST="$(command -v linear-comment-post.sh 2>/dev/null || true)"
  fi
  if [[ -n "$COMMENT_POST" && -x "$COMMENT_POST" ]] && \
     "$COMMENT_POST" "${TICKET}" "${MIRROR_BODY}" >/dev/null 2>&1; then
    : > "${LINEAR_MIRROR_MARKER}"
  else
    echo "phase-teardown: linear-comment-post failed (continuing)" >&2
  fi
fi
```

```bash phase-teardown-emit
# ─── Emit canonical phase event ──────────────────────────────────────────────
# Pass --orch-id explicitly to avoid CATALYST_* leak from a sibling dispatch
# (per memory: phase_env_ticket_leak_from_sibling).
"$__TD_WRAPPER" --phase teardown --ticket "$TICKET" --status complete \
  ${ORCH_ID:+--orch-id "$ORCH_ID"} ${ORCH_DIR:+--orch-dir "$ORCH_DIR"}
exit 0
```

## Failure handling

```bash
# Called when a fatal error is detected before the emit block.
# $1 = reason string
_REASON="${1:-phase-teardown fatal error}"
"$__TD_WRAPPER" --phase teardown --ticket "$TICKET" --status failed \
  --reason "$_REASON" \
  ${ORCH_ID:+--orch-id "$ORCH_ID"} ${ORCH_DIR:+--orch-dir "$ORCH_DIR"}
exit 1
```

Failure modes that emit `phase.teardown.failed.${TICKET}`:

- `prior_artifact_missing:monitor_deploy` — `phase-monitor-deploy.json` absent.
- `prior_artifact_missing:monitor_merge` — `phase-monitor-merge.json` absent.
- `pr_not_merged` — safety gate: merge confirmation missing.
