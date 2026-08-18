# Comms discipline, and the phase-specific work block

Read this when wiring a phase agent's messaging or filling in its work block.


Outbound message types — phase agent → orchestrator:

| Type        | When                                           | Cadence per session |
|-------------|-----------------------------------------------|---------------------|
| `info`      | Phase started / phase work milestones          | 3–5 |
| `attention` | Scope conflict, missing access, repeated failures, stalled | 0–2 |
| `question`  | Specific clarification needed (msg_id is correlation key) | 0–1 |
| `done`      | Terminal success (emitted by phase-agent-emit-complete) | 1 |

Inbound message types — orchestrator → phase agent (reads on every loop tick):

| Type        | Effect                                                       |
|-------------|-------------------------------------------------------------|
| `directive` | Answer to a previously-posted `question` (correlated via `.re` field). Phase agent uses the answer and proceeds. |
| `pause`     | Halt and poll. Resumes on `directive` or `info` resume signal. |
| `abort`     | Phase agent cleans up, calls phase-agent-emit-complete with `--status failed --reason aborted_by_orchestrator`, exits. |

Use the helper functions in `plugins/dev/scripts/catalyst-comms` directly —
do NOT reimplement send/poll logic per phase. The contract tests live in
`plugins/dev/scripts/__tests__/phase-agent-comms.test.sh`.

## Phase-specific work block (TEMPLATE)

```text
/goal "{{ transcript-evaluable goal condition for this phase }}"

{{ Phase-specific instructions. The actual work delegates to the canonical
   skill (e.g., /catalyst-dev:research-codebase) via the Task tool wherever
   possible. See plan §"Phase agents wrap canonical skills" for the mapping. }}
```

