# role-supervisor (CTL-1994)

Keeps a long-running coordination **role** — a steward or the concierge — alive on the
[Claude Agent SDK], replacing the `claude -p` brief it used to be launched with.

It is not an orchestrator. It never talks in Linear, never touches a ticket, and has no opinion about
the work. It starts a role, keeps it alive, and pages when it cannot.

## Why it exists

Measured on 2026-08-18, the day this was written:

| what happened | how it was handled that day |
| -- | -- |
| a provider **529 killed seven agent lanes at once** — and again 6–7 an hour later | a human noticed and pasted the briefs back in, 10–60 min later |
| print mode ends the run the moment the agent waits | the role's watcher had to live *outside* the agent, and its findings never re-entered it |
| no heartbeat | "quiet" and "dead" were indistinguishable |
| the brief was a file that got edited per relaunch | `launch-backend13.txt` — thirteen versions of one role's brief in one day |

⭐ **The phase workers already had 429/529 backoff** (`execution-core/sdk-run-phase-agent.mjs`, CTL-1365b).
The long-running roles had none. This package is that policy applied to the process shape that needed it.

⛔ **Nothing that had been WRITTEN was lost in either outage. Everything that had only been INTENDED was.**
That is why the resume path reads artifacts — handoff, status doc, the role's own thread, the replica —
and never a re-pasted brief.

## Layout

| file | what it is |
| -- | -- |
| `../lib/agent-liveness.mjs` | **the decision logic** — overload classification, backoff, auth, heartbeat states, the restart ladder, the status-doc cadence. Pure, node-builtins only, injectable clock and randomness |
| `paths.mjs` | where a role's state lives (honours `CATALYST_DIR`) |
| `state.mjs` | atomic reads/writes: manifest, heartbeat, lease, session, counters |
| `supervisor.mjs` | the loop — one role, until it is told to stop |
| `sdk-session.mjs` | the only file that talks to the SDK; kept thin |
| `doctor.mjs` | one row per role, and a red row names the artifact that is missing |
| `cli.mjs` | `run` · `doctor` · `stop` · `list` |
| `install.sh` + `com.catalyst.role.plist` | one launchd label per role |

`agent-liveness.mjs` lives in `lib/` rather than in this package because two very different processes
need the same answers, and execution-core's `config.mjs` chain reaches `bun:sqlite` — so a role runner
cannot simply import from there. One copy, imported by both, is the alternative to a second one that drifts.

## The restart ladder

| situation | action | wait |
| -- | -- | -- |
| provider 429/529 | **resume the SAME session** — never re-paste the brief | 60 s → 2 m → 5 m → 15 m, jittered |
| quota exhausted | restart | 15 min, and one board line; no relaunch storm |
| non-zero exit / crash | restart from the handoff, fresh session | exponential, capped at 2 min |
| clean exit, scope **active** | **re-enter** the session ("you stopped while your scope is active") | none; bounded to 3/hour |
| clean exit, scope quiet | stop | — |
| > 5 restarts in an hour | **stop and page** | — |
| explicit `stop` | write the handoff, exit, stay down until `run` | — |

Jitter is not decoration: seven lanes died together, so without it seven lanes retry together.

**"Active" is computable**, never a judgement call — a ticket in flight, an open ask this role raised, or
a human comment newer than the role's last reply.

## Liveness

`heartbeat.json` is written on every session boundary and carries `{role, scope, ts, state, session,
last_turn_ts, last_artifact, host, pid}`.

- **≥ 10 min old → silent · ≥ 30 min old → dead.**
- ⛔ **A missing heartbeat is `MISSING`, never `LIVE`.** Defaulting absence to healthy is how a dead role hides.
- `last_artifact` is why the heartbeat is more than a liveness ping: a heartbeat that only proves the
  process exists cannot tell a working role from a wedged one.

## The lease

One live process per role. A second `run` refuses while a live pid holds the lease — two stewards on one
scope means double dispatch. A **stale** lease (the holder's pid is gone) is takeable, or a `kill -9`
would lock the role out permanently, which is the opposite of the goal.

## Usage

```bash
bash install.sh --role steward-p13 --scope "P13 · Coordination SOP" \
                --skill catalyst-dev:steward --brief ~/catalyst/comms/coord/launch-p13-1.txt

node cli.mjs doctor          # one row per role; exit 1 if any row is red
node cli.mjs stop steward-p13
```

`doctor` prints `no roles configured (this is not the same as 'all roles healthy')` when there are none —
a green line there would be a false clean result.

## Tests

```bash
node ../lib/agent-liveness.test.mjs      # the policy: 30 cases
node supervisor.test.mjs                  # the loop, driven by a fake session runner: 13 cases
```

No network, no SDK, no real `~/catalyst`: every test runs against a scratch `CATALYST_DIR`. The outage
behaviour is testable **before** an outage — which on 2026-08-18 it was not.

## Known follow-ups

- ⚠️ `execution-core/sdk-run-phase-agent.mjs` still carries its **own** copies of `backoffMs`,
  `isOverloadedResult/Error` and `assertSdkAuth`. They are now duplicated by `lib/agent-liveness.mjs`.
  Converging them is a one-import change, deliberately **not** done on rehearsal day because that file is
  the live dispatch path. Filed as a follow-up; until it lands, this is two copies of one rule and it is
  named here rather than left to be discovered.
- The status-doc staleness re-entry (`buildStatusDocPrompt`) is wired into the policy but not yet into a
  timer inside the loop; today it fires on session boundaries, not mid-session.

[Claude Agent SDK]: https://docs.claude.com/en/api/agent-sdk/overview
