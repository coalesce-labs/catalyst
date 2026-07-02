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

# Re-validate the ticket-ID shape before TICKET is interpolated into archive /
# worker paths. phase-agent-dispatch validates this, but a standalone invocation
# does not — without it a crafted TICKET could path-traverse the archive dest.
if ! printf '%s' "$TICKET" | grep -Eq '^[A-Za-z][A-Za-z0-9_]*-[0-9]+$'; then
  echo "phase-teardown: invalid TICKET '$TICKET' (expected e.g. CTL-703)" >&2
  exit 1
fi

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
    ${ORCH_ID:+--orch-id "$ORCH_ID"} ${ORCH_DIR:+--orch-dir "$ORCH_DIR"} \
    || echo "phase-teardown: CRITICAL — phase-agent-emit-complete failed; no terminal teardown event landed" >&2
  exit 1
fi

# Read phase-monitor-merge.json for the merge confirmation.
MERGE_FILE="$WORKER_DIR/phase-monitor-merge.json"
if [[ ! -f "$MERGE_FILE" ]]; then
  "$__TD_WRAPPER" --phase teardown --ticket "$TICKET" --status failed \
    --reason "prior_artifact_missing:monitor_merge" \
    ${ORCH_ID:+--orch-id "$ORCH_ID"} ${ORCH_DIR:+--orch-dir "$ORCH_DIR"} \
    || echo "phase-teardown: CRITICAL — phase-agent-emit-complete failed; no terminal teardown event landed" >&2
  exit 1
fi

MERGE_CI_STATUS="$(jq -r '.pr.ciStatus // empty' "$MERGE_FILE" 2>/dev/null)"
MERGED_AT="$(jq -r '.pr.mergedAt // empty' "$MERGE_FILE" 2>/dev/null)"

if [[ "$MERGE_CI_STATUS" != "merged" && -z "$MERGED_AT" ]]; then
  "$__TD_WRAPPER" --phase teardown --ticket "$TICKET" --status failed \
    --reason "pr_not_merged" \
    ${ORCH_ID:+--orch-id "$ORCH_ID"} ${ORCH_DIR:+--orch-dir "$ORCH_DIR"} \
    || echo "phase-teardown: CRITICAL — phase-agent-emit-complete failed; no terminal teardown event landed" >&2
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

## Done-judgment — verify the ticket is GENUINELY done before you tear down (CTL-1157)

You are a phase agent that CAN reason, and teardown is the LAST gate before the
ticket is marked Done and its worktree destroyed. **Before you write Done, verify
the ticket is genuinely done — do NOT trust "monitor-merge merged a PR" as proof
the whole ticket is complete.** A ticket commonly has more than one PR (a second
PR, a human PR opened outside the pipeline, an abandoned spike); monitor-merge
tracked only the pipeline's OWN PR. Marking Done while another PR that is part of
the solution is still open is the silent-rot failure CTL-1157 exists to prevent.

This is the same open-PR remediation rubric the recovery-pass delegate uses —
applied here as **"teardown verifies it's done."** It complements (does not
replace) the merge safety-gate above.

**STEP 1 — Enumerate the ticket's OPEN PRs (the facts).** The fence below runs the
CTL-1157 open-PR ENUMERATOR (`open-pr-gate.mjs` — the single source of truth that
UNIONs the ticket-key search + the branch-head pass + the Linear-attachment pass,
confirming OPEN via `gh`) and prints any still-open PRs. It is a FACTS source, not
a block: it never aborts teardown on its own (alarm-not-block). YOU read its output.

**STEP 1½ — If the check came back UNVERIFIABLE, do NOT treat it as clean.** The
enumerator returns `unverifiable:true` (with a reason) when the authoritative GitHub
check could not be completed — the ticket's repo could not be derived, a `gh`
list/view failed, or an attachment-linked PR could not be viewed. The fence surfaces
that state explicitly ("open-PR verification was UNVERIFIABLE … (reason)") instead of
collapsing it to an empty list. **UNVERIFIABLE ≠ CLEAN.** An unverifiable check is
NOT "no open PR remains" — do not mark Done and remove the worktree on it. Finish the
verification (re-run the enumerator, or eyeball the ticket's PRs by hand) and, if you
still cannot confirm the board is clean, fail-out per STEP 2's genuine-judgment path
(emit `phase.teardown.failed.${TICKET}` with the reason) so the unverified teardown
surfaces rather than proceeding silently.

**STEP 2 — Reason about EACH open PR and remediate it yourself.** For every PR the
enumerator printed:

- **Still needed / part of the solution** → FINISH it (rebase onto base, fix CI,
  merge it) before you proceed. Do NOT tear down with deliverable work unmerged.
- **Abandoned / superseded** (a later PR replaced it, a dead spike, a duplicate) →
  CLOSE it yourself: `gh pr close <n> -R <owner/repo> --comment "<why — superseded by
  #X / abandoned / duplicate of #Y>"`. Closing a dead PR is autonomous, not an escalation.
- **Cross-repo PRs (CTL-1157):** when the enumerator printed a PR as `owner/repo#n`
  (a cross-repo Linear attachment — a DIFFERENT repo than this ticket's), you MUST
  target that repo explicitly on BOTH paths — `gh pr merge <n> -R <owner/repo> …` and
  `gh pr close <n> -R <owner/repo> …`. A bare `gh pr merge/close <n>` runs against the
  ticket's repo and would merge/close the wrong same-numbered PR while leaving the
  attached `owner/repo#n` open (this matches the fence's own `-R` warning above).
- **Genuine judgment call** (the open PR conflicts with an ADR/principle, or you
  cannot safely decide needed-vs-abandoned) → do NOT mark Done; emit
  `phase.teardown.failed.${TICKET}` via the failure template with a concrete reason
  so the stuck PR surfaces (the scheduler/recovery layer then escalates it). This
  is the rare case — mechanically-resolvable PRs you finish/close yourself.

**STEP 3 — Only once no open PR remains that SHOULD remain**, continue to the Linear
Done transition below and tear down. A clean teardown (every open PR finished or
closed) leaves the backstops silent; tearing down with an open PR still present
fires the loud `recovery.done-applied-with-open-pr` alarm — which is exactly the
signal that you skipped this verification.

```bash phase-teardown-open-pr-verify
# ─── Done-judgment: enumerate the ticket's open PRs (FACTS, non-blocking) ──────
# CTL-1157: print any still-open PRs for this ticket so the agent can reason about
# each (finish/merge the needed, close the abandoned) BEFORE the Done write below.
# Runs the shared open-PR ENUMERATOR; this is alarm-not-block — it NEVER aborts
# teardown by itself. The agent's reasoning (STEP 2 above) is what acts.
EXEC_CORE_TD="${PLUGIN_ROOT}/scripts/execution-core"
OPEN_PR_ENUM="${EXEC_CORE_TD}/open-pr-gate.mjs"
TD_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
if [[ -f "$OPEN_PR_ENUM" ]] && command -v node >/dev/null 2>&1; then
  # Invoke the enumerator's defaultCheckOpenPrs; print the FULL result as JSON —
  # both the open-PR list AND the `unverifiable` flag + reason. UNVERIFIABLE ≠ CLEAN:
  # if we serialized only `r.prs`, an unverifiable result (repo underivable / gh
  # failed) would collapse to an empty list and falsely read as "no open PR remains".
  # Best-effort: any throw is itself UNVERIFIABLE (never a silent clean list).
  TD_OPEN_RESULT="$(OPEN_PR_ENUM="$OPEN_PR_ENUM" TICKET="$TICKET" TD_BRANCH="$TD_BRANCH" \
    node --input-type=module -e '
      const { defaultCheckOpenPrs } = await import(process.env.OPEN_PR_ENUM);
      const t = process.env.TICKET;
      const branchName = process.env.TD_BRANCH || undefined;
      try {
        // CTL-1157 (Codex round-8): teardown ALREADY runs inside the ticket worktree, so
        // pass cwd=process.cwd() — defaultCheckOpenPrs then queries gh in THIS repo
        // directly instead of relying on registry derivation, which reports
        // repo-underivable/UNVERIFIABLE on an unenrolled repo or a repoRoot the registry
        // convention cannot map, even though the current worktree is the right repo.
        const r = defaultCheckOpenPrs(t, { branchName, cwd: process.cwd() });
        process.stdout.write(JSON.stringify({ prs: r.prs || [], unverifiable: !!r.unverifiable, reason: r.reason || "" }));
      } catch (e) {
        process.stdout.write(JSON.stringify({ prs: [], unverifiable: true, reason: String((e && e.message) || e) }));
      }
    ' 2>/dev/null || echo "{\"prs\":[],\"unverifiable\":true,\"reason\":\"enumerator invocation failed\"}")"
  [[ -n "$TD_OPEN_RESULT" ]] || TD_OPEN_RESULT="{\"prs\":[],\"unverifiable\":true,\"reason\":\"empty enumerator output\"}"
  TD_OPEN_PRS="$(printf '%s' "$TD_OPEN_RESULT" | jq -c '.prs // []' 2>/dev/null || echo "[]")"
  TD_UNVERIFIABLE="$(printf '%s' "$TD_OPEN_RESULT" | jq -r '.unverifiable // false' 2>/dev/null || echo "false")"
  TD_UNVERIF_REASON="$(printf '%s' "$TD_OPEN_RESULT" | jq -r '.reason // ""' 2>/dev/null || echo "")"
  TD_OPEN_COUNT="$(printf '%s' "$TD_OPEN_PRS" | jq 'length' 2>/dev/null || echo 0)"
  if [[ "$TD_OPEN_COUNT" =~ ^[0-9]+$ && "$TD_OPEN_COUNT" -gt 0 ]]; then
    echo "phase-teardown: CTL-1157 Done-judgment — ${TD_OPEN_COUNT} OPEN PR(s) still exist for ${TICKET}:" >&2
    # CTL-1157 (Codex round-5): print the PR's OWN repo (owner/repo#n) when the
    # enumerator recorded it — a cross-repo Linear attachment is a DIFFERENT PR than a
    # same-numbered PR in the ticket's repo. Printing a bare "#n" would let the agent
    # inspect/close the ticket-repo's #n while leaving the attached org/other#n open.
    printf '%s\n' "$TD_OPEN_PRS" | jq -r '.[] | "  " + (if .repo then .repo + "#" else "#" end) + (.number|tostring) + " [" + (.state // "?") + "] " + (.title // "")' 2>/dev/null >&2 || true
    echo "phase-teardown: reason about EACH (STEP 2): finish/merge the needed, close the abandoned, or fail-out on a genuine judgment call — BEFORE the Done transition below. IMPORTANT: for any entry printed as owner/repo#n, target THAT repo explicitly — 'gh pr close <n> -R <owner/repo> --comment ...' — never a bare 'gh pr close <n>' (which would act on the ticket repo's same-numbered PR)." >&2
  elif [[ "$TD_UNVERIFIABLE" == "true" ]]; then
    # UNVERIFIABLE ≠ CLEAN. The authoritative gh check could NOT confirm zero open PRs
    # (repo underivable, gh/auth/rate-limit failure, or an attachment PR we could not
    # view). Do NOT let this read as clean — surface it so the agent reasons (STEP 1½).
    echo "phase-teardown: CTL-1157 Done-judgment — open-PR verification was UNVERIFIABLE for ${TICKET} (${TD_UNVERIF_REASON:-reason unknown})." >&2
    echo "phase-teardown: UNVERIFIABLE ≠ CLEAN — the authoritative gh check could NOT confirm zero open PRs. Do NOT assume the board is clean and do NOT silently mark Done + remove the worktree. Finish the verification (re-run the enumerator / eyeball the ticket's PRs by hand) or, on a genuine judgment call, fail-out: emit phase.teardown.failed.${TICKET} via the failure template carrying this reason so the unverified teardown surfaces." >&2
  else
    echo "phase-teardown: CTL-1157 Done-judgment — no open PR remains for ${TICKET}; proceeding to Done." >&2
  fi
fi
```

```bash phase-teardown-linear-done
# ─── Linear Done transition ───────────────────────────────────────────────────
# THIS IS THE ONLY Done writer when phase-teardown is in the pipeline.
# Called while still in the ticket worktree so .catalyst/config.json is adjacent.
LINEAR_TRANSITION="${PLUGIN_ROOT}/scripts/linear-transition.sh"
LINEAR_DONE_ACTION=""
if [[ -x "$LINEAR_TRANSITION" ]]; then
  # Capture rc + the JSON result: linear-transition.sh can print "transitioned" even
  # when the underlying linearis update fails (memory: linear_transition_silent_success),
  # AND it exits 0 for idempotent skip, dry-run, and skipped-no-linearis — so rc==0 alone
  # is NOT proof a Done was actually written (CTL-1157 Codex round-7). Run with --json and
  # read `.action`: only "transitioned" (a real move) or "skipped" (confirmed already in
  # the target Done state) count as a genuine Done. "skipped-no-linearis" / "dry-run" do
  # NOT. Non-fatal — terminalDoneOnce backstop (fires on teardown===done) retries — but
  # the failure must be LOUD so it is diagnosable.
  LINEAR_DONE_OUT="$("$LINEAR_TRANSITION" --ticket "$TICKET" --transition done \
    --config .catalyst/config.json --json 2>&1)"
  LINEAR_DONE_RC=$?
  LINEAR_DONE_ACTION="$(printf '%s' "$LINEAR_DONE_OUT" | jq -r '.action // ""' 2>/dev/null || echo "")"
  if [[ $LINEAR_DONE_RC -ne 0 ]]; then
    echo "phase-teardown: Linear Done transition FAILED (rc=${LINEAR_DONE_RC}) — terminalDoneOnce backstop will retry: ${LINEAR_DONE_OUT}" >&2
  else
    echo "phase-teardown: Linear Done transition (action=${LINEAR_DONE_ACTION:-unknown}): ${LINEAR_DONE_OUT}"
  fi
else
  echo "phase-teardown: linear-transition.sh not found at $LINEAR_TRANSITION; skipping Done transition" >&2
fi

# ─── Durable completion declaration (CTL-1371) ────────────────────────────────
# Drop a durable "done" completion marker so the completion-signal reconciler's
# drain backstops this Done state from an off-disk record that survives worker-dir
# reaping — independent of the scheduler's terminalDoneOnce (which needs the live
# worker dir + signals[teardown]==='done'). --no-write: the Done write above is
# authoritative; this only records the declaration. The drain marks it reconciled
# once Linear shows Done, or re-writes it if the transition above silently failed.
#
# CTL-1157 F #3 (+ Codex round-7): pass --transition-verified ONLY when the real
# linear-transition.sh above reported a GENUINE Done — action "transitioned" (a real
# move) or "skipped" (confirmed already in the Done state). rc==0 alone is NOT enough:
# it also covers dry-run and "skipped-no-linearis" (a node without linearis writes
# NOTHING yet still exits 0). That flag gates the ENFORCE recovery.done-applied telemetry
# + open-PR alarm: without it, a marker dropped after a failed/missing/no-op transition
# would report an applied Done that never happened. On the unverified path we still drop
# the marker (so the drain/terminalDoneOnce backstop reconciles), but as a shadow
# would-event, not an enforce Done-move.
LINEAR_RECONCILE="${PLUGIN_ROOT}/scripts/catalyst-linear-reconcile"
if [[ -x "$LINEAR_RECONCILE" ]]; then
  # Single no-space token → a set-but-empty string is safe under `set -u` and the
  # unquoted expansion contributes no arg when empty (avoids the bash-3.2 empty-array
  # trap). LINEAR_DONE_ACTION is empty when the transition script was missing → shadow.
  TRANSITION_VERIFIED_FLAG=""
  if [[ "$LINEAR_DONE_ACTION" == "transitioned" || "$LINEAR_DONE_ACTION" == "skipped" ]]; then
    TRANSITION_VERIFIED_FLAG="--transition-verified"
  fi
  "$LINEAR_RECONCILE" declare "$TICKET" --state done --by pipeline --no-write \
    $TRANSITION_VERIFIED_FLAG >/dev/null 2>&1 || true
fi
```

```bash phase-teardown-archive
# ─── Archive worker dir ───────────────────────────────────────────────────────
# Archive-first contract (CTL-791): copy signal files to
# ~/catalyst/archives/<TICKET>/ BEFORE any destructive step. ARCHIVE_OK gates
# the worktree-removal block below — if the archive failed we keep the worktree
# (its artifacts are the only remaining copy) and continue to the mirror/emit.
ARCHIVE_DIR="${HOME}/catalyst/archives/${TICKET}"
ARCHIVE_OK="false"
if mkdir -p "$ARCHIVE_DIR" 2>/dev/null; then
  if cp -R "${WORKER_DIR}/." "$ARCHIVE_DIR/" 2>/dev/null; then
    echo "phase-teardown: worker dir archived to $ARCHIVE_DIR"
    ARCHIVE_OK="true"
  else
    echo "phase-teardown: archive cp failed — worktree removal will be SKIPPED (archive-first contract)" >&2
  fi
else
  echo "phase-teardown: cannot create archive dir $ARCHIVE_DIR — worktree removal will be SKIPPED" >&2
fi
```

```bash phase-teardown-worktree-removal
# ─── Worktree + branch removal ────────────────────────────────────────────────
# Gate on keepWorktreeAfterMerge != true (same pattern as phase-monitor-merge
# CTL-649 teardown block). This skill runs INSIDE the worktree it is about to
# remove; cd to the primary worktree first.

KEEP_WT="$(jq -r '.catalyst.orchestration.keepWorktreeAfterMerge // false' \
  .catalyst/config.json 2>/dev/null || echo "false")"

# Archive-first gate: never remove the worktree when the archive step above did
# not complete — the worker dir / worktree artifacts would be lost (CTL-791).
if [[ "${ARCHIVE_OK:-false}" != "true" ]]; then
  echo "phase-teardown: archive did not complete; auto-teardown skipped (worktree kept)" >&2
elif [[ "$KEEP_WT" != "true" ]]; then
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
      # FAIL CLOSED: removal proceeds ONLY when the presweep liveness check
      # actually ran and passed. A missing/non-executable presweep helper must
      # NOT fall through to an ungated `git worktree remove` — that can yank a
      # worktree from under a live claude --bg session (the CTL-649 leak class).
      if [[ ! -x "$PRESWEEP_BIN" ]]; then
        echo "phase-teardown: worktree-presweep.sh missing/non-executable at $PRESWEEP_BIN; auto-teardown skipped (fail-closed)" >&2
      elif ! "$PRESWEEP_BIN" "$WORKTREE_PATH"; then
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
     "$COMMENT_POST" "${TICKET}" "${MIRROR_BODY}" >/dev/null; then
    : > "${LINEAR_MIRROR_MARKER}"
  else
    echo "phase-teardown: linear-comment-post failed (continuing)" >&2
  fi
fi
```

```bash phase-teardown-emit
# ─── Emit canonical phase event ──────────────────────────────────────────────
# Pass --orch-id explicitly to avoid CATALYST_* leak from a sibling dispatch
# (per memory: phase_env_ticket_leak_from_sibling). Loud (non-fatal) diagnostic
# if the emitter itself fails — otherwise the ticket stalls with the failure of
# the surfacing mechanism itself unobservable.
"$__TD_WRAPPER" --phase teardown --ticket "$TICKET" --status complete \
  ${ORCH_ID:+--orch-id "$ORCH_ID"} ${ORCH_DIR:+--orch-dir "$ORCH_DIR"} \
  || echo "phase-teardown: CRITICAL — phase-agent-emit-complete failed; no terminal teardown event landed" >&2
exit 0
```

## Failure handling

```bash phase-teardown-failure-template
# TEMPLATE fence — invoked by the agent ad-hoc on a fatal error, NOT part of
# the sequential body (the e2e harness excludes this fence by name: after the
# emit block's `exit 0` it would be unreachable dead code in a concatenated run).
# Called when a fatal error is detected before the emit block.
# $1 = reason string
_REASON="${1:-phase-teardown fatal error}"
"$__TD_WRAPPER" --phase teardown --ticket "$TICKET" --status failed \
  --reason "$_REASON" \
  ${ORCH_ID:+--orch-id "$ORCH_ID"} ${ORCH_DIR:+--orch-dir "$ORCH_DIR"} \
  || echo "phase-teardown: CRITICAL — phase-agent-emit-complete failed; no terminal teardown event landed" >&2
exit 1
```

Failure modes that emit `phase.teardown.failed.${TICKET}`:

- `prior_artifact_missing:monitor_deploy` — `phase-monitor-deploy.json` absent.
- `prior_artifact_missing:monitor_merge` — `phase-monitor-merge.json` absent.
- `pr_not_merged` — safety gate: merge confirmation missing.
