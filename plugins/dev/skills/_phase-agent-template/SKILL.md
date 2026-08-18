---
name: _phase-agent-template
description: |
  Reference template every phase-agent skill copies (CTL-448). The leading underscore keeps the skill
  loader from registering it — it is NOT runnable, only the structure the ELEVEN real phase agents
  (phase-triage, phase-research, phase-plan, phase-implement, phase-verify, phase-remediate,
  phase-review, phase-pr, phase-monitor-merge, phase-monitor-deploy, phase-teardown) clone. The count
  and the list are load-bearing: an agent authored from a template that does not know phase-remediate
  exists will not wire the verify -> remediate cycle. Real phase skills MUST set
  `user-invocable: true` so phase-agent-dispatch's `claude --bg "/catalyst-dev:phase-X ..."` resolves
  (CTL-490).
user-invocable: true
disable-model-invocation: false  # invocable by model (Skill tool) AND user (slash command)
allowed-tools: [Bash, Read, Grep, Glob, Edit, Write]
---

# _phase-agent-template — the shape every phase agent clones

Copy this skeleton, fill the `{{...}}` placeholders, and read the reference for whichever part you
are writing. ⚠️ **There is no automatic propagation**: a change here does not reach the eleven live
skills, so fixing the template is never the whole fix.

## Load on demand

| when | read |
| -- | -- |
| writing the startup block (env, comms join, session, signal file) | `references/prelude.md` |
| writing the exit path (`/goal`, end block, failure handling) | `references/end-block.md` |
| wiring messaging, or filling in the work block | `references/comms.md` |
| the phase can escalate to a human | `references/escalation-explanation.md` |
| the phase resolves a thoughts artifact by ticket | `scripts/lib/phase-artifact-gate.sh` — see below |

## Contract

Every phase agent:

1. Joins the shared `orch-${CATALYST_ORCHESTRATOR_ID}` comms channel at entry.
2. Reads the **prior phase artifact** (lookup table in `plugins/dev/scripts/phase-agent-dispatch`) —
   aborts if missing.
3. Starts a `catalyst-session` and writes per-phase status updates.
4. Does the phase-specific work — **delegating to a canonical skill via the Task tool** wherever
   possible, rather than reimplementing it.
5. On exit calls `plugins/dev/scripts/phase-agent-emit-complete`, which emits
   `phase.<name>.{complete,failed}.<ticket>` (broker `phase_lifecycle` route, CTL-447),
   updates `${ORCH_DIR}/workers/<TICKET>/phase-<name>.json`, and ends the session.

## Invariants

- **Linear reads → the local replica**, never a bare `linearis`/`linear issues read` (it 429s a quota
  shared by the whole fleet). Prefer
  `sqlite3 "${CATALYST_REPLICA_DB:-${CATALYST_DIR:-$HOME/catalyst}/catalyst-replica.db}"` — bg-safe and
  resolves in any shell. ⚠️ `linear_read_ticket` is a plugin **shell function**: without
  `source "${CLAUDE_PLUGIN_ROOT}/scripts/lib/linear-read-replica.sh"` it is "command not found" and you
  fall through to the bare CLI silently. Writes and `issues list`/`search` stay on `linearis`.
- **Resolve thoughts artifacts with the SHARED matcher**, not a hand-written glob. The prelude
  sources `scripts/lib/phase-artifact-gate.sh` from the root it resolved, so just call
  `match_thoughts_artifact <dir> "$TICKET"`. It accepts `*-<ticket>.md` **and** `*-<ticket>-<slug>.md`,
  which is what the dispatcher gates on. ⛔ A stricter glob here means the dispatcher green-lights a
  plan the phase then rejects with "no plan found" — that was a live bug in `phase-implement` (CTL-1998).
- **Assign before use.** Every variable the exit path touches is assigned before the work block; the
  failure-handling fence is a separate bash block (CTL-1998).
- **Declare your shell options deliberately.** "Copies this verbatim" has not held — see
  `references/prelude.md`.
- **Turn caps** come from `.catalyst/config.json:catalyst.orchestration.phaseAgents.turnCaps.<phase>`,
  with per-phase defaults in `phase-agent-dispatch`.

## Phase-specific work block (TEMPLATE)

```text
/goal "{{ transcript-evaluable goal condition naming the artifact this phase produces }}"

{{ Phase-specific instructions. The work delegates to the canonical skill
   (e.g. /catalyst-dev:research-codebase) via the Task tool wherever possible. }}
```

## Why this is a template and not a base skill

Skills have no inheritance — there is no `extends`. Each phase skill is a full, standalone SKILL.md,
so this file is a **structural reference**, not a runtime dependency. When it changes, the eleven live
skills must be re-aligned by hand.
