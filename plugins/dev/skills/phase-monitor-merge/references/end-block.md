# End Block: Thoughts Doc, Terminal Emit, Failure Handling

After posting the [Linear mirror](mirror.md) and [compound-log entry](compound-log.md), write a
durable local thoughts doc and emit the terminal event.

## Thoughts doc and sync gate

```bash phase-monitor-merge-thoughts-doc
# CTL-1490: write durable local thoughts doc (unconditional; push is mode-gated).
# Reuses MIRROR_BODY already computed in the mirror block above.
source "${PLUGIN_ROOT}/scripts/lib/write-phase-thoughts-doc.sh"
write_phase_thoughts_doc "monitor-merge" "$TICKET" "${MIRROR_BODY:-}" || true
"${PLUGIN_ROOT}/scripts/lib/thoughts-sync-gate.sh" --phase "$PHASE" --ticket "$TICKET" || exit 11
```

## Terminal emit

```bash
# EMIT comes from the prelude (CTL-1998).
if [[ -x "$EMIT" ]]; then
  "$EMIT" --phase "$PHASE" --ticket "$TICKET" --status complete
fi
[[ -n "$COMMS" && -x "$COMMS" ]] && "$COMMS" done "$CHANNEL" --as "$TICKET" >/dev/null 2>&1 || true
```

## Failure handling

```bash
REASON="${1:-listen loop terminal failure}"
"$EMIT" --phase "$PHASE" --ticket "$TICKET" --status failed --reason "$REASON"
[[ -n "$COMMS" && -x "$COMMS" ]] && "$COMMS" send "$CHANNEL" \
  "phase-monitor-merge failed: ${REASON}" \
  --as "$TICKET" --type attention --orch "$ORCH_ID" >/dev/null 2>&1 || true
exit 1
```

Failure modes that emit `phase.monitor-merge.failed.${TICKET}`:

- `dirty` (merge conflicts) — operator must rebase manually.
- Human reviewer `CHANGES_REQUESTED` — operator must address comments.
- Unresolved **human** review thread(s) — an unresolved `COMMENTED`/`APPROVED` conversation
  blocks the merge but is not `CHANGES_REQUESTED`, so it terminates here for the operator
  rather than being auto-remediated (CTL-1680).
- CI blocked after 3 auto-fix attempts.
- `gh pr merge` succeeded but REST confirms `.merged == false` (rare; usually a branch-protection
  rule mismatch).
- 24-hour wall-clock cap — orchestrator dispatches a fix-up or escalates.

## Comms discipline

Inherits the contract from [[_phase-agent-template]]:

| Type        | When                                                                   |
| ----------- | ---------------------------------------------------------------------- |
| `info`      | At start with PR number; after each successful inline fix-up.          |
| `attention` | DIRTY, human changes-requested, CI blocked after 3 attempts.           |
| `question`  | Reserved — this phase rarely needs to ask, since the work is reactive. |
| `done`      | Emitted by `phase-agent-emit-complete` on merge confirmed.             |

## Why this is a thin wrapper

Plan architectural commitment #3. The listen loop logic lives in [[oneshot]] SKILL.md and is
exercised every day. Lifting it into a phase-agent skill without duplicating the body keeps both
paths in lockstep — when the legacy oneshot path retires (plan §Initiative 1 Phase 6), this skill
becomes the sole owner.
