<!-- CTL design doc — 2026-05-30. Status: DESIGN (not yet implemented). Author: Ryan + Claude (multi-agent design panel). -->
# Workflow Descriptors — Design

**Status:** Design proposal. Not implemented. This document specifies a reusable *workflow
descriptor* that collapses the orchestrator's hardcoded 9-phase pipeline into a single declarative
source of truth, and reserves the seams for non-Linear triggers and off-box executors.

**Why now:** the question that started this — *"do we have a good general way to encode workflow
steps so the engine is reusable for other trigger events and sequential/parallel steps?"* The honest
answer today: the *substrate* (dispatch, claim/fencing, event bus, recovery, concurrency) is already
general, but the *workflow definition* is hardwired to one pipeline and to Linear-as-trigger, encoded
as constants and switch statements duplicated across ~10 files. This design extracts that definition
into data without rebuilding the substrate.

> Companion artifacts: the implementation plan lives in
> `thoughts/shared/plans/` (TDD, follows this design); the user-facing docs land under `website/`
> (see [§11 Docs plan](#11-docs--website-update-plan)). This doc is the developer-facing rationale.

---

## 1. Problem: one pipeline, ten copies

The death/advance logic is data-driven on the happy path (`lib/phase-fsm.mjs` `PHASES` +
`NEXT_PHASE`), but the *same ordered list of phases* and its per-phase attributes are re-encoded in
~10 places that must be kept in lockstep by hand:

| Site | What it encodes |
|---|---|
| `lib/phase-fsm.mjs:9` `PHASES` | the ordered phase list (canonical) |
| `lib/phase-fsm.mjs:53` `NEXT_PHASE` | happy-path successor edges |
| `lib/phase-fsm.mjs:75` `PHASE_LINEAR_KEY` | phase → Linear stateMap key |
| `execution-core/scheduler.mjs:108` `STAGE_RANK` | per-phase preemption rank (non-dense; `remediate=4`) |
| `execution-core/scheduler.mjs:93,99,213` | `TERMINAL_PHASE`, `NEW_WORK_ENTRY_PHASE`, `NON_PREEMPTABLE_PHASES` |
| `phase-agent-dispatch:114` `prior_artifact_for_phase()` | each step's input artifact |
| `phase-agent-dispatch:93` `phase_default_turn_cap()` | each step's default turn cap |
| `execution-core/work-done-probes.mjs:314` `WORK_DONE_PROBES` | per-step completion probe fn |
| `lib/phase-sequence.sh:16` `PHASES` (bash) | bash mirror (recovery path; node-free by design) |
| `orchestrate-phase-advance:82,102` | `phase_next()` + `linear_key_for_phase()` bash mirrors |
| `plugins/dev/skills/phase-<name>/SKILL.md` | one bespoke skill body per step |

Adding, removing, or reordering a step today means editing all of these and trusting a
byte-identical drift-guard test to catch divergence. The pipeline is also **singular** — there is no
way to express a *second* workflow (e.g. a PR-triggered review pipeline) without forking the engine.

The **only** non-linear edge in the whole engine is `verify → remediate`, and it is a hardcoded
`if (latest === "verify" && verifyVerdict === "fail")` at `scheduler.mjs:874`, with the
`remediate → verify` cycle implemented by *deleting signal files* so the `PHASES` walk re-lands on
`verify`. The cycle cap (`REMEDIATE_CYCLE_CAP=3`) is counted from the durable event log, not signals.

## 2. Goals & non-goals

**Goals (v1):**
1. One JSON descriptor is the single source of truth for the step list and every per-step attribute.
2. The lone non-linear edge (`verify→remediate`) becomes **data**, not a hardcoded `if`.
3. Per-step `model`, `effort` (reasoning) level, `turnCap`, and prompt `preamble`/`postamble` —
   three orthogonal levers (§6), conditionally overridable by a small, safe rules engine (e.g. *large
   ticket ⇒ plan uses a stronger model + more effort + is told to use `/workflows`*).
4. Global descriptor, with narrow per-ticket overrides; changes are deterministic and never mutate an
   in-flight run.
5. **Zero behavior change at cutover** — a pure provenance swap proven by a drift-guard test.

**Non-goals (v1 — reserved for v2, see [§10](#10-v2-extensibility-reserved-seams)):** parallel/DAG
steps, multiple triggers, reusable/parameterized templates, full predicate composition, a YAML
authoring lane, and off-box executors. These are designed as *reserved seams* so v1 doesn't preclude
them, but **v1 fails loud** if an unimplemented field/value appears (no silent accept-and-ignore).

## 3. Format decision: canonical JSON + JSON Schema

**Decision: the descriptor is JSON**, validated by a versioned JSON Schema (`schemaVersion:
"workflow/v1"`), stored at `.catalyst/workflows/default.json` (Layer-1, committable). This was the
strong consensus of the design panel and survived two adversarial format critics.

Rationale — the decision is over-determined by the existing system:

- **The engine is already all-JSON with zero non-stdlib parsers in the core.** `phase-fsm.mjs`
  imports nothing; `registry.mjs` is the single I/O seam; every signal, the registry, config, and the
  eligible projections are `JSON.parse`d. The **bash recovery path is deliberately node-free** and
  reads JSON via `jq`. Adding a YAML/TOML runtime parser would introduce a new dependency and failure
  mode into a deliberately dependency-free core — and there is no bash YAML reader.
- **The primary author is a headless agent** (req: agents create/edit workflows). LLMs emit valid
  JSON natively and self-correct against a parse/schema error in a deterministic loop;
  whitespace-significant YAML is a top LLM failure mode (and Linear ids like `CTL-736` plus `#`
  comments collide with YAML syntax).
- **The orch-monitor UI round-trips JSON losslessly** via `JSON.stringify(obj, null, 2)` + atomic
  `tmp+rename`. There is no comment/format to destroy on form save.

| Format | Verdict |
|---|---|
| **JSON** | ✅ Canonical. Zero new deps; agent-emittable; lossless UI round-trip; JSON-Schema-validatable. |
| YAML | ❌ Rejected as canonical (agent-authorability + node-free bash) **and** as a compile-to-JSON sugar lane for v1 (the drift-guard becomes a CI footgun: every UI edit invalidates the YAML source). |
| TOML | ❌ Array-of-tables is unreadable for nested step objects; no mature round-trip-with-comments JS lib. |
| JS/TS module | ❌ Executing agent-authored code is a trust-boundary/RCE problem and can't render as a UI form. |
| JSON5 / HCL / Starlark | ❌ JSON5 needs a non-stdlib runtime parser (breaks `JSON.parse`-everywhere); HCL/Starlark are config-as-code. |

**Recovering JSON's two real warts cheaply (no second format):**
- **Multi-line prompts** (`preamble`/`postamble`) are stored as **arrays of lines**, joined with
  `\n` at load. Clean in diffs, editable as a UI textarea.
- **Comments** are first-class `description` / `$comment` *data* fields (which the JSON Schema
  tolerates) — they survive UI form saves because they are real data, not lexical trivia.

*(Optional future nicety, not v1: the `catalyst-workflow` CLI may accept JSON5 on input and normalize
to JSON on write — strictly less machinery than a YAML compile lane, deferred until asked for.)*

## 4. The descriptor schema (v1)

A worked example for the current pipeline (abridged — every step shown structurally):

```json
{
  "$comment": "The default 9-step ticket pipeline. Replaces the ~10 hardcoded phase-list sites.",
  "schemaVersion": "workflow/v1",
  "id": "default",
  "trigger": { "kind": "linear.ready" },
  "linearMirror": true,
  "entryStep": "research",
  "terminalStep": "monitor-deploy",
  "defaults": { "model": "opus", "effort": "medium", "preemptable": true },
  "steps": [
    { "id": "triage", "rank": 0, "preemptable": false, "linearKey": null,
      "turnCap": 10, "input": null, "workDoneProbe": "triageJson", "next": "research" },
    { "id": "research", "rank": 1, "linearKey": "research", "turnCap": 35,
      "input": { "signal": "triage.json" }, "workDoneProbe": "researchDoc", "next": "plan" },
    { "id": "plan", "rank": 2, "linearKey": "planning", "turnCap": 25, "effort": "high",
      "input": { "glob": "thoughts/shared/research/*-${ticket}.md" },
      "workDoneProbe": "planDoc", "next": "implement",
      "rules": [
        { "when": { "field": "ticket.scope", "op": "in", "value": ["large", "epic"] },
          "set": { "effort": "max", "model": "opusplan" },
          "appendPostamble": [
            "This is a large ticket (scope: ${ticket.scope}, ~${ticket.estimate} pts).",
            "Use the /workflows Workflow tool to decompose the plan into parallel sub-steps",
            "before writing the final plan document." ] }
      ] },
    { "id": "implement", "rank": 3, "linearKey": "inProgress", "turnCap": 75,
      "input": { "glob": "thoughts/shared/plans/*-${ticket}.md" },
      "workDoneProbe": "implementCommit", "next": "verify" },
    { "id": "verify", "rank": 5, "linearKey": "verifying", "turnCap": 20,
      "input": { "signal": "phase-implement.json" }, "workDoneProbe": "verifyJson",
      "next": [ { "when": { "field": "verifyVerdict", "op": "eq", "value": "fail" }, "to": "remediate" },
                { "default": "review" } ] },
    { "id": "review", "rank": 6, "linearKey": "reviewing", "turnCap": 25,
      "input": { "signal": "verify.json" }, "workDoneProbe": "reviewJson", "next": "pr" },
    { "id": "pr", "rank": 7, "linearKey": "inReview", "turnCap": 12,
      "input": { "signal": "review.json" }, "workDoneProbe": "prOpened", "next": "monitor-merge" },
    { "id": "monitor-merge", "rank": 8, "linearKey": "inReview", "turnCap": 50,
      "input": { "signal": "phase-pr.json" }, "workDoneProbe": "merged", "next": "monitor-deploy" },
    { "id": "monitor-deploy", "rank": 9, "linearKey": "done", "turnCap": 30,
      "input": { "signal": "phase-monitor-merge.json" }, "workDoneProbe": "deployed", "next": null }
  ],
  "ancillarySteps": [
    { "id": "remediate", "rank": 4, "linearKey": "remediating", "turnCap": 40,
      "input": { "signal": "verify.json" }, "workDoneProbe": "remediateCommit", "cycleWith": "verify" }
  ],
  "cycles": [
    { "id": "verify-remediate", "members": ["verify", "remediate"], "cap": 3,
      "countBy": "event", "countEvent": "phase.remediate.complete.${ticket}",
      "onExhaust": "escalate-needs-human",
      "reset": { "signals": ["phase-verify.json", "phase-remediate.json", "verify.json"],
                 "releaseClaims": true } }
  ]
}
```

Key schema decisions:

- **`run` is derived, not stored** by default: `run = "/catalyst-dev:phase-${id}"`. The signal path
  (`workers/<ticket>/phase-<id>.json`), env vars (incl. the `CATALYST_GENERATION` fence), and event
  name (`phase.<id>.<status>.<ticket>`) stay **mechanically derived from `id`** — so all 9 existing
  `SKILL.md` files work unchanged. The descriptor changes *where the lists live*, never the contract.
- **`next` is a string (linear) OR an ordered list of `{when, to}` clauses with a `{default}`.** This
  turns the one hardcoded non-linear edge into data. The `when` is a structured predicate (§6), never
  an eval'd string.
- **`remediate` is an `ancillarySteps[]` member, NOT in `steps[]`,** with an **explicit `rank: 4`**
  (not array-index-derived). This preserves `phaseIndex(remediate) = verify`'s index
  (`phase-fsm.mjs:119`) and the non-dense `STAGE_RANK` whose `Object.keys` order is
  `[...PHASES, "remediate"]` — both of which the preemption logic and the drift-guard depend on. A
  naive positional rank would rank `remediate` as last/closest-to-done and corrupt preemption.
- **Cycles are a named, durable, reusable structure.** `countBy: "event"` is **load-bearing**: the
  cap is counted from the immutable event log (`countRemediateCycles`), which *survives* the signal
  deletion the reset performs. Re-deriving the cap from signal files (which the reset deletes) would
  reset it to 0 each cycle → infinite remediate loop (the exact CTL-735/736 storm class). The reset's
  **`releaseClaims: true`** is also load-bearing — see [Appendix A](#appendix-a-gate-0).
- **`workDoneProbe` is a string name resolved against the `WORK_DONE_PROBES` registry**; probe
  *functions* stay in `work-done-probes.mjs` (behavior-in-modules, data-in-JSON). **Validation
  HARD-FAILS any step without a registered probe** — a probe-less step false-deads into the
  `no-probe-for-phase` → needs-human escalation, defeating autonomy. This is a completeness gate, not
  a warning.
- **`input`** mirrors `prior_artifact_for_phase()`: `null` | `{ "signal": "x.json" }` |
  `{ "glob": "...-${ticket}.md" }`.

## 5. Conditional rules — safe, structured, UI-bindable

Every condition (routing `when`, per-step `rules[].when`) uses **one structured predicate shape** —
not a string DSL, not JS eval, not CEL/Jinja (those are documented v2 upgrades):

```json
{ "field": "ticket.scope", "op": "in", "value": ["large", "epic"] }
```

- **Ops for v1: `{ eq, gte, lt, in }`** (a deliberately small set; the design panel's 10-operator
  engine with `allOf`/`anyOf`/`not` composition and regex `matches` was cut as YAGNI — added when a
  second real rule demands it). `matches`/regex is explicitly excluded from v1 (ReDoS surface).
- **Why structured, not a string:** the object binds 1:1 to UI form controls (field/op/value
  dropdowns) → lossless round-trip; it is statically validatable; and it is structurally incapable of
  arbitrary code execution. An agent emits it as trivial JSON.
- **`rules[]` shape:** `{ when, set: {…fields to patch…}, appendPreamble: [...], appendPostamble:
  [...] }`. Resolution is a pure function `resolveStep(baseStep, context) → effectiveStep`:
  matching rules patch the step in array order (last-match-wins for `set`; `append*` accumulate). It
  emits an `_applied` audit trail into the dispatch event so the HUD shows *why* a step resolved as it
  did. Bounded: the accumulated `--append-system-prompt` has a max length (falls back to
  `--append-system-prompt-file`).

**The context contract (frozen, schema-enforced).** A `when.field` may only reference a documented
context path; an unknown path is a **validation error**, not silent-false — otherwise an agent can't
tell "my rule is wrong" from "my rule didn't match." v1 context:

| Path | Source | Notes |
|---|---|---|
| `ticket.scope` | `triage.json.estimated_scope` | `small`\|`medium`\|`large`\|`epic` — **exists today** |
| `ticket.estimate` | `scope→points` map `{small:1, medium:3, large:8, epic:13}` | **new v1 deliverable** (below) |
| `ticket.priority`, `ticket.labels`, `ticket.team` | Linear projection | |
| `verifyVerdict` | `work-done-probes` `readVerifyVerdict` | `pass`\|`fail`\|null |
| `remediateCycleCount` | event-log count | for cycle routing |

> **⚠️ The flagship example must actually fire.** The design panel's marquee rule was
> `estimate >= 5 → ultra thinking`, but `triage.json` writes `estimated_scope` as a *word*, not a
> numeric points field — so that rule would ship **dead** (silently false). v1 therefore **must**
> ship the `scope→points` map as a real context binding (the example above predicates on
> `ticket.scope in [large, epic]`, a field that exists today, and also exposes `ticket.estimate` via
> the map). This is a non-negotiable v1 deliverable, not a fallback.

## 6. Per-step execution levers — three orthogonal axes

A step controls *how* its worker runs through **three independent levers**. They are easy to
conflate (the question that prompted this section: *"is `opus-plan` a model param, and is that
different from putting the `workflow` keyword in a prompt?"* — yes, and yes). Keeping them separate
in the schema is deliberate; a single rule can set all three. All three are verified against
`claude --help` (`--model`, `--effort`, `--append-system-prompt`) on the installed CLI.

| Lever | Field | Threads to | What it changes |
|---|---|---|---|
| **Model** | `model` | `claude --model <v>` | *which* model runs |
| **Effort (reasoning)** | `effort` | `claude --effort <v>` | *how hard* it reasons |
| **Prompt directives** | `preamble` / `postamble` | `claude --append-system-prompt` | *what the worker does* (e.g. use `/workflows`) |

**1. `model` — which model (`--model`).** Accepts a latest-model alias (`opus`, `sonnet`, `haiku`),
a full id (`claude-opus-4-8`), **or a Claude Code model alias** — including **`opusplan`** ("Opus
Plan Mode": Opus for plan-mode reasoning, Sonnet for execution). So `"model": "opusplan"` is a valid,
first-class step value; it is a *model-selection* lever, unrelated to the `/workflows` keyword.
Precedence is preserved exactly as today — `CLI flag > config.modelOverrides[phase][ticket] >
config.models[phase] > descriptor.step.model > descriptor.defaults.model` — the descriptor is the new
innermost default (covered by a precedence test).

**2. `effort` — how hard it reasons (`--effort`).** `claude` exposes a **native** effort flag,
`--effort <low|medium|high|xhigh|max>` — this is the correct, native way to thread "thinking level,"
*not* a system-prompt hack (an earlier draft of this doc mis-stated that no such flag exists; it
does). The descriptor `effort` enum **mirrors the flag exactly: `low | medium | high | xhigh | max`**
(plus `default` = omit the flag / inherit). It is independent of `model`: combine `model: opusplan`
\+ `effort: max` freely.
  > The interactive `/effort ultracode` is a Claude Code convenience that *bundles* `xhigh` effort
  > **plus** auto-`/workflows` orchestration — i.e. lever 2 (`xhigh`) **and** lever 3 (the workflow
  > nudge) together. The descriptor keeps them **unbundled** so authors opt into each independently;
  > to reproduce "ultracode," set `effort: xhigh` **and** add the `/workflows` postamble (lever 3).

**3. `preamble` / `postamble` — prompt directives (`--append-system-prompt`).** This is the
*"`workflow` keyword in a prompt"* mechanism, genuinely distinct from model/effort: it changes **what
the worker does**, not which model or how hard it thinks. There is **no `--append-system-prompt`
block in `phase-agent-dispatch` today** — net-new dispatch surface. v1 adds one block composing
`preamble` + `postamble` + any rule `append*` lines into a single `--append-system-prompt` arg
(bounded length; `--append-system-prompt-file` fallback). The flagship *"for large tickets, tell the
plan step to use `/workflows`"* is exactly a rule-appended postamble (the `plan` step in §4) — it
works *because* the worker's prompt carries the `/workflows` instruction, independent of `effort`.

**Why support both the native flags and the prompt nudge (the original question):** they do
different jobs and compose. A large ticket might want *all three* — `model: opusplan` (stronger
planning model), `effort: max` (more reasoning), **and** a postamble telling the worker to decompose
via `/workflows` (multi-agent fan-out). The descriptor exposes them as three separate fields; the
`website/` docs + configuration reference state the distinction explicitly so authors never assume
one implies the others. *(A fourth, optional lever — `--max-budget-usd` per step — is available but
deferred from v1-core; noted as a reserved field.)*

**The v1 vertical slice (must run end-to-end, not just be schema):** per-step `model` + `turnCap` +
`effort` (native `--effort`) + `preamble`/`postamble` (native `--append-system-prompt`), plus the one
`scope→points` predicate that actually fires. If this slice doesn't run, the design fails the core
ask regardless of schema cleanliness. Proven by a dispatch dry-run test asserting the exact
`--model` / `--effort` / `--append-system-prompt` args composed for a large vs. small ticket.

## 7. Dynamic config & layering

Three layers, deep-merged, with steps merged **by `id`/name** (never by array index — the one merge
rule teams get wrong; index-merge corrupts every step when overriding one):

```
effective = merge( engine-default descriptor,          // shipped, = today's pipeline
                   .catalyst/workflows/default.json,   // global, committable (Layer 1)
                   workers/<ticket>/workflow-override.json )   // per-ticket (RFC-7386 merge patch)
```

- **Global change:** edit `.catalyst/workflows/default.json` (or via the CLI/UI). Affects tickets
  that *enter* after the edit.
- **Per-ticket change (req: "change globally OR per-ticket"):** a narrow
  `workers/<ticket>/workflow-override.json` JSON Merge Patch. **v1 restricts per-ticket overrides to
  leaf fields** (`model`, `effort`, `turnCap`, `preamble`, `postamble`, `rules`) — **routing/`next`
  overrides are forbidden** so a one-off patch can never construct an unreachable/cyclic graph that
  the base schema already validated. (`model` already has a per-ticket path today via
  `config.modelOverrides[phase][ticket]`, which is preserved.)
- **No mid-flight surprises — pinned-per-ticket.** At a ticket's **first dispatch** the engine stamps
  a frozen `workers/<ticket>/resolved-workflow.json` + a `resolvedWorkflowVersion`; every subsequent
  dispatch for that ticket reads the *pin*, not the live global file. A global edit therefore can
  **never** mutate an in-flight multi-hour run — directly applying CTL-736's "no mid-flight surprises"
  fencing discipline (a hot-reloaded topology could make `deriveAdvancement`'s `PHASES` walk land on
  a phase with no signal and hard-stall the run). An explicit, operator-only `repin` is the escape
  hatch, and it must respect/bump the generation fence token (don't re-pin a ticket whose worker
  holds a live claim without bumping the generation).
- **Merge semantics, frozen:** scalars deep-merge by key; `preamble`/`postamble`/`rules` **replace**
  (predictable); "append" is expressed only via a rule's `appendPreamble`/`appendPostamble`. The
  dispatch precedence ladder is unchanged: `CLI > config.modelOverrides > descriptor-override >
  descriptor-base > engine-default`, with an explicit precedence test.

*(Full `repin`/etag optimistic-concurrency is v1.1 — see §8; v1 is last-write-wins on the global file
\+ the frozen per-ticket pin, which is sufficient and far less machinery.)*

## 8. Authoring DevEx — CLI + UI

- **`catalyst-workflow` CLI** (`show` | `validate` | `set` | `diff` | `codegen` | `graph` | `lint`).
  `set`/write **refuses unless `validate` passes on the MERGED effective result**, not just the
  patch. This is the load-bearing piece for the headless-agent feedback loop and UI write-safety.
- **Validation gives a tight feedback loop** — errors emit `{ path, expected, got, hint }` in **both
  human and `--json`** form. Validation covers: schema; **every step has a registered
  `workDoneProbe`** (hard fail, §4); edge reachability (every step reachable, terminal reachable, no
  orphan/cycle except declared `cycles[]`); referenced steps/skills exist; `when.field` references a
  documented context path; reserved fields hold their v1-restricted values (`executor == "local"`,
  `trigger.kind == "linear.ready"` — §10).
- **orch-monitor UI** reads the descriptor, renders the step graph (mermaid/flow), and edits per-step
  `model`/`effort`/`turnCap`/`preamble`/`postamble` + rules via forms (the structured `{field, op,
  value}` predicate binds 1:1 to field/op/value form controls — the reason §5 chose it). A
  scope toggle `[ Global | This ticket ]` writes the global file vs. a per-ticket patch.
  - **Honest scoping:** the UI write-back is **net-new server code** — `orch-monitor/server.ts` has
    *no* existing etag/If-Match/validate-before-write framework (only an annotation flag-toggle PUT).
    v1 ships either read-only display **or** a single validate-before-write route reusing the shared
    `validateWorkflow()` (the same function the CLI calls); etag optimistic concurrency for
    concurrent agent-vs-UI edits is deferred to v1.1 (the pinned-per-ticket model already sidesteps
    the mid-flight race).

## 9. Migration & sequencing — a pure provenance swap

The single most important constraint: **zero behavior change at cutover**, proven, not asserted.

1. **`lib/workflow-descriptor.mjs`** loads `lib/workflow.default.json` and **re-exports the IDENTICAL
   constant names** the engine already imports — `PHASES`, `NEXT_PHASE`, `PHASE_LINEAR_KEY`,
   `STAGE_RANK` (incl. `Object.keys` order), `TERMINAL_PHASE`, `NEW_WORK_ENTRY_PHASE`,
   `NON_PREEMPTABLE_PHASES`, the prior-artifact map, default turn caps, the probe registry. Only
   `scheduler.mjs` and `recovery.mjs` import these FSM constants, so the blast radius is two import
   lines: they change their *source*, not their *interface*.
2. **Drift-guard test FIRST** (`workflow-descriptor.test.mjs`): asserts descriptor-derived constants
   **deep-equal today's frozen literals** (including `Object.keys(STAGE_RANK)` *order*) **before any
   consumer switches source**. This turns the refactor into a provable provenance swap — the single
   most important destabilization control.
3. **Bash mirror is generated, not hand-maintained.** A `gen-phase-sequence.mjs` codegen emits
   `phase-sequence.sh` + `phase-tables.generated.sh` (the `phase_next` / `linear_key_for_phase` /
   turn-cap / prior-artifact case statements). CI runs the codegen and `git diff --exit-code` to
   prove it was run — retiring the hand-mirroring + byte-identical drift guard. **Constraints:** the
   generated `.sh` stays **pure bash, node-free** (CTL-736's claim path must not gain a node
   dependency); emits **POSIX-portable** case statements only (no `${VAR,,}` / `shopt` / `declare -A`
   bash-4 idioms — they silently break under the zsh Bash-tool harness); and is tested under **both
   `zsh -c 'source …'` and `bash -c`**.
4. **No `bun`/`node` in the dispatch claim window.** Any descriptor read in `phase-agent-dispatch`
   must be `jq` against a **static pre-generated JSON file**, hoisted **before** the claim window
   (`:503`), never interleaved with it — because two concurrent `bun` launches race the execution-core
   lockfile and one returns empty, re-opening the double-spawn CTL-736 just closed. Best: **zero**
   runtime descriptor read on the bash side (use the generated, sourced constants).

### 🔴 Sequencing vs CTL-736 — a HARD gate (and a blocker found en route)

CTL-736 is mid-stabilization in the **exact** `scheduler.mjs` / `recovery.mjs` /
`phase-agent-dispatch` regions this refactor re-sources. Therefore:

- **Land the descriptor as a pure-provenance PR _after_ CTL-736 Phases 2-3 merge.** No descriptor
  commit may touch the claim/revive/reclaim regions. **Defer the bash-codegen half** (highest textual
  collision with CTL-736's `phase-agent-dispatch` edits) to a follow-up PR. If forced to interleave,
  do the `.mjs` half first.
- The `verify→remediate`-as-data change and the conditional/`effort`/preamble slice are **separate
  follow-up PRs**, never bundled into the constant-swap.
- **Blocker found (GATE 0 — CONFIRMED, see [Appendix A](#appendix-a-gate-0)):** the
  `verify→remediate→verify` cycle is **already broken on HEAD** under CTL-736 fencing (the cycle reset
  deletes signals but not `.claim.<gen>` tombstones → the 2nd verify loses its claim and never
  dispatches). The descriptor must **not** model the cycle until this is fixed in the CTL-736 thread,
  and when it does, the `cycles[].reset.releaseClaims: true` (§4) is the declarative form of the fix.

## 10. v2 extensibility — reserved seams (off-box executors + non-Linear triggers)

This section designs the *direction* (off-box executors; triggers beyond Linear) and the **minimal
v1 seams** that keep it reachable. **Binding invariant: no off-box and no off-Linear value is
*reachable* before v2.0.** v1 reserves *shape*, never *behavior*.

### 10.1 The load-bearing insight: the generation token is already a distributed fencing token

CTL-736's fence (`isCurrentGeneration`, `claim.mjs:99-107`; the emit-complete check,
`phase-agent-emit-complete:167-181`) compares **two persisted integers** — the worker's
`CATALYST_GENERATION` vs the signal's `generation` — with **zero local-process / pid / host
dependency**. That is precisely a **Lamport / Kleppmann fencing token**: a stale-generation remote
completion is rejected by the *same* check that rejects a local false-dead duplicate. So the
**at-most-one-*write*** guarantee generalizes off-box **for free**. What does *not* generalize is the
local mutual-exclusion *primitive* (`openSync(path,"wx")` is single-filesystem) and local liveness
(`claude agents --json`). Off-box therefore needs only: relocate the *claim caller* to the
coordinator, add a *lease + heartbeat* for liveness, and add an *authenticated bus-ingest* for
completion — **not** a new claim protocol.

> **Honesty up front (promoted from a footnote):** the "needs only a lease, not a new claim" framing
> is true **for a single coordinator**. The O_EXCL claim fences only callers sharing one filesystem;
> **single-coordinator-instance is therefore a hard v2 invariant.** HA / failover (two schedulers on
> one queue) requires a **network-atomic CAS** backend (S3 `If-None-Match`, Postgres `ON CONFLICT`,
> Redis `SET NX`, or a Durable Object) — genuinely unsolved, and v1 reserves *nothing* for it.

### 10.2 The executor seam

The executor is already one injectable function — `dispatch.mjs` `defaultRunPhaseAgent:55` (the only
shell-out to `phase-agent-dispatch`), with `lib/executor.sh` owning `claude --bg` + `claude stop`
behind one file (its header literally calls itself "the single executor seam (D9)"). v2 turns that
into a name→impl **executor registry** (mirroring the `WORK_DONE_PROBES` HARD-FAIL pattern) behind a
small adapter interface — the verbs the engine *already* calls, made transport-agnostic:

```
ExecutorAdapter (v2):
  dispatch(stepCtx) -> handle      // local: defaultDispatch; remote: provider POST /sessions
  claim(key, gen)   -> won|lost    // local: O_EXCL file; remote: coordinator-owned CAS (v2 backend)
  liveness(handle)  -> busy|idle|absent|unknown   // local: claude agents; remote: lease + provider status
  stop(handle)                     // local: claude stop; remote: provider cancel (best-effort)
  // completion CONTRACT (not a verb): worker pushes commits to origin/<branch> + posts a
  //   phase.<step>.complete event carrying its `generation` to the authenticated bus ingest.
```

Off-box dispatch is **three coordinator steps, not "relocate the caller"** (a correction the
feasibility critic forced): (1) `claim` runs **on the coordinator** *before* the provider call;
(2) the returned **handle persists to the signal *before* the provider create returns** — else a
coordinator crash orphans an uncancellable remote session; (3) there is **no `bg_job_id`-from-stdout
analogue** off-box, so the provider session id *is* the handle. The signal stays **coordinator-owned**
— a remote worker never writes the local signal file; the coordinator flips it on a fenced completion
event (preserving recovery.mjs's "the signal is the source of truth" invariant).

### 10.3 Liveness, artifacts, ingest — and the honest gaps

- **Liveness = lease TTL + heartbeats on the existing bus.** A new canonical action
  `phase.<step>.heartbeat.<workItem>` renews `signal.leaseExpiresAt`; death = lease lapse. The broker
  already ignores non-`PHASE_EVENT_PATTERN` audit events, so heartbeats need **zero broker change**
  (only `shouldSkipEvent` must list the new action so the broker doesn't self-loop). `claude-agents.mjs:50-55`
  *already names this* as the required distributed substitute. This **extends** `classifyWorker`'s
  existing `terminal|running|dead|unknown` quad-state (it is *not* a new tri-state — the
  non-Linear-triggers perspective misread this; corrected).
- **Artifacts = commits pushed to `origin/<branch>`.** ⚠️ **Probe portability is *not* free** (the
  feasibility critic's key correction): the work-done probes read git **of the local worktree**
  (`implementProbe` `git -C <worktree> rev-list origin/main..HEAD`, `work-done-probes.mjs:229`;
  `artifactProbe` reads local `.md` files, `:282`). Off-box, `resolveWorktree` returns null → every
  probe returns false → **the reclaim safety net vanishes**. v2 must give the coordinator a **mirror
  clone** that fetches `origin/<branch>` for the probes (or a shared store). This is **v2-blocking**,
  not a reserved seam. Likewise the `thoughts/*` research/plan handoff: off-box producers must commit
  those docs to the branch and the prior-artifact gate (`phase-agent-dispatch:403`, refuse+exit 2)
  must read `origin/<branch>` — otherwise a mixed local/off-box pipeline **strands** at "prior
  artifact missing." v1 keeps `input` strictly `null|{signal}|{glob}`; the off-box artifact transport
  is a named v2 problem, **not** a v1 `gitRef` input source (a reserved-but-unhandled value would be
  dead config).
- **Ingest is new code + a new SPOF** (not "near-free reuse"): `webhook-handler.ts` has an HMAC
  secret but parses *GitHub* payloads only. The agent-completion ingest needs: a **fence-on-ingest**
  check (`isCurrentGeneration` *before* append) that **fails CLOSED** — the local fence returns
  *true* on missing/non-numeric `generation` (fail-open, fine for legacy local emits), but **over the
  network a dropped/garbled generation must be rejected `4xx`**, never accepted; and a
  **fsync-before-`2xx`** exactly-once contract (a fire-and-forget webhook loses the completion of a
  worker whose session already ended). The `commits-ahead` reclaim probe (host-independent, via the
  mirror clone) is the safety net for a dropped completion POST.

### 10.4 Non-Linear triggers + the generic work-item

- **The monitor becomes a registry of trigger adapters** (`registerTriggerAdapter(kind, {onEvent,
  poll})`); the Linear poll is just the first registration (wrapping today's exact handlers → zero
  CTL behavior change). **GitHub envelopes are already on the bus** (`webhook-handler.ts:657-693`
  appends `github.*`); `monitor.mjs` simply drops them today. A `bus-event` adapter lets them enter
  the **same** scheduler — no second pipeline.
- **`trigger.kind` is the `<source>.<entity>.<action>` discriminant**, matched 1:1 against the bus
  `attributes["event.name"]` the receiver already writes: `linear.ready` (v1),
  `github.pull_request.opened`, `github.push`, `schedule.cron`, `manual.api`, `webhook.generic`.
- **The deepest Linear assumption is `teamOf()`'s `^<PREFIX>-<n>$` regex** (`dispatch.mjs:28`) — the
  *only* place a work-item string is *interpreted* rather than passed through. The fix is
  **structural, not schema**: route all work-item→repoRoot resolution through `resolveProject`
  (already the seam at `dispatch.mjs:35`); `teamOf` becomes *one implementation* (the `source:linear`
  branch), and the registry owns the mapping (a GitHub item resolves `repoRoot` by repo). The
  work-item stays a **bare string** in v1; `workItem.source` is **doc-reserved only** (no second
  computable value today → a v1 field would be dead config).
- **Conditions are source-scoped.** A GitHub PR exposes `pr_*`, not `estimate`/`scope`; a `when.field`
  referencing a field the source doesn't expose is a **validation error** (extends the §5 rule). The
  *same* `{field, op, value}` vocabulary serves v2 `trigger.match` — no new DSL is ever introduced.
- **Linear mirror is optional per descriptor.** `workflow.linearMirror` (const `true` in v1) gates
  the `PHASE_LINEAR_KEY` write-back in `linear-write.safeWrite`. A v2 non-Linear descriptor sets it
  `false` and posts verdicts to its native system (e.g. a GitHub PR comment); steps with no stateMap
  entry advance silently (exactly how `remediate` already behaves). ⚠️ Flipping it `false` is **gated
  on first defining a non-Linear stop/kill channel** — today the human-override/kill path
  (`DRAG_OUT_STATES`, `monitor.mjs:56`) is Linear-state-driven, so a non-Linear workflow has *no*
  equivalent "stop this work-item" switch until v2 adds a `manual.api`/`webhook` cancel intent.

### 10.5 The v1 reserved-seam discipline (shape-valid, value-restricted)

The rule that resolves "scope discipline vs reserve seams": **a reserved seam is schema-*valid* but
value-*restricted*** (fails as a *known-key bad-value* error, e.g. `executor:"cloud"` → "must be
`local`"); an **unimplemented behavior key fails loud** as an *unknown-key* error via
`additionalProperties:false` at **every** object level. A v1 file is thus *a valid v2 file by
construction*, yet no v2 behavior is expressible in it.

| Reserved field | v1 form | v2 widening | Real or doc-only? |
|---|---|---|---|
| `step.executor` | `const "local"` (no `executorConfig` key in v1) | enum widens; `executorConfig` object added in `workflow/v2` schema | **Real** (live seam: `dispatch.mjs:55`) |
| `workflow.trigger.kind` | `const "linear.ready"`; trigger obj `additionalProperties:false` ⇒ only `{kind, linearMirror}` | enum widens to the 6 kinds | **Real** (live seam: `monitor.mjs`) |
| `workflow.linearMirror` | `const true` | `false` allowed (gated on a kill-channel) | **Real** (live seam: `linear-write.safeWrite`) |
| `schemaVersion` | `"workflow/v1"` selects the frozen v1 validator | `"workflow/v2"` = a *second*, widen-only schema; unknown ⇒ hard-fail | **Real** |
| `signal.generation` | already written every dispatch (CTL-736) | reused as the off-box fence token | **Real** (already present) |
| `step.claimBackend`, `workItem.source` | **not in the schema** (`additionalProperties:false` rejects them) | added in `workflow/v2` | **Doc-reserved only** |

Explicitly **rejected from v1** (the scope-coherence critic's cuts): an open-string `executor` + a
populated `executorConfig`/`signal.executor` object (would make a v1 file a degenerate v2 file); a
pre-widened `trigger.kind` enum; `workItem.kind`/`registryKey` schema fields; a `gitRef` input
source. And two **factual corrections** baked in above: `classifyWorker` already returns `unknown`
(no new tri-state needed); `work-done-probes` is **phase-name-keyed** (re-keying to probe-name is a
real v1.1 refactor with its own test, *not* a free seam).

### 10.6 Prior-art anchor

Closest analogue: **AWS Step Functions *Activities*** (opaque `taskToken` + worker `poll` +
`SendTaskSuccess`/`SendTaskHeartbeat`) — the worker is off-box and reports back over an arbitrary
channel, exactly our event-bus model (vs. GitHub Actions' runner-registration or Temporal's held-TCP
long-poll, both wrong for ephemeral 30-min agent sessions). The synthesis we adopt: **Temporal-style
lease heartbeat on the bus + Kleppmann fencing token at the coordinator + a thin per-harness
adapter.** Agent-as-a-service invocation (Devin `POST /sessions`→poll→`structured_output`; Claude
Managed Agents `POST /sessions`→events→poll; Codex cloud tasks) is **poll-based** (none offer
outbound completion webhooks as of design time) and lives **behind the adapter's `dispatch`/`liveness`
verbs**. *(All concrete provider endpoints / TTL constants / SDK surfaces are knowledge-cutoff-dated
external research and are **quarantined to a v2 design doc**, never the v1 schema — the only thing
prior-art contributes to v1 is corroboration that `generation` must be on every dispatch (already
true) and that heartbeat-on-the-bus is the right distributed liveness substitute.)*

### 10.7 Hard problems (v2 must solve; named, not waved)

Distributed claim (multi-coordinator CAS); distributed liveness (per-harness status + the local-bg
recovery jurisprudence re-derived off-box); **probe portability** (coordinator mirror clone —
v2-blocking); off-box **artifact handoff** (`thoughts/*` + prior-artifact gate over `origin/<branch>`);
**ingest as a SPOF** (fence-on-ingest fail-closed + fsync-before-2xx); **lease-TTL false-death** on
legitimate long sub-agent fan-outs (the CTL-662 trap, off-box); **branch push-races** (a false-dead
gen-N and its gen-N+1 revive can both push before the *signal* fence rejects the loser → need
*git-ref* fencing: force-reset to `origin/main` on revive, or generation-namespaced refs the
coordinator promotes); network-partition-vs-death (fence keeps the *write* correct but wastes a paid
duplicate session); heterogeneous **cost attribution** (Devin/Codex emit no Claude OTEL); and the
non-Linear **kill switch**.

### 10.8 The phase ladder (binding)

```
CTL-736 Ph1  ── DONE (claim + fence merged)            ┐ stabilization
CTL-736 Ph2-3 ─ in flight (state.json trigger, probe)  ┘ (must close first)
        │
v1.0  ── descriptor PROVENANCE SWAP (after CTL-736 Ph2-3): collapse the ~10 sites,
        │   drift-guard = today's literals. ZERO new value reachable.
v1.1  ── data-driven verify→remediate edge + conditions + effort/model/preamble slice
        │   (separate PRs; bash codegen here).
v2.0  ── workflow/v2 schema: executor + trigger adapters widen the enums; off-box + non-Linear
            become reachable. Gated on the §10.7 hard problems.
```

## 11. Docs & website update plan

(Numbered 11 to sit after the v2 section; produced from a full `website/` audit.) The pipeline is
documented in ~14 pages that assume a fixed 9-phase list; the descriptor reframes those as *one
instance of a descriptor*.

- **New concept page:** `website/src/content/docs/reference/orchestration/workflows.md` — titled
  **"Workflow descriptors"** (`sidebar.order: 0`), modeled on `phase-agents.md`. ⚠️ name-collision
  caveat with the existing top-level `reference/workflows.md` (the *Level-2 manual* dev cycle) — hence
  the distinct title.
- **New extensibility/roadmap page:** `reference/orchestration/extensibility.md` — non-Linear triggers
  \+ off-box/Codex/Devin executors (content from §10).
- **Schema home:** extend `reference/configuration.md` with a `### Workflow descriptor` subsection
  under `## Orchestration Config` (after the `phaseAgents` table). New keys must also land in
  `plugins/dev/templates/config.template.json` or the config drift-checker warns.
- **Heaviest rewrites:** `reference/orchestration/phase-agents.md` (reframe the fixed 9-phase as *the
  default descriptor*; the per-phase model/turnCap tables move to step fields + the new `effort` /
  preamble levers) and `reference/orchestration/scheduler.md` (stage-rank + non-preemptable set derive
  from descriptor edges).
- **Prose touch-ups:** `reference/orchestration.md`, `guided-workflows/phases.md`,
  `getting-started/introduction.mdx` (hard-coded 9-phase list at `:111`), `guided-workflows/index.md`,
  and the `phase.*` event-name pages in `observability/`. **Lockstep (repo-root, dev-only):**
  `docs/orchestrator-overview.md` + `docs/architecture.md`.
- **Conventions:** Starlight frontmatter with `sidebar.order`; mermaid via fenced blocks;
  `Field | Type | Default | Description` tables; the `docs-gate` CI requires a clean `astro build`.

## 12. Open questions

- The `effort` enum mirrors `--effort` (`low|medium|high|xhigh|max`). If a future native
  reasoning-budget knob ships, do we widen the enum or keep the flag-faithful set?
- `triage.json.estimate` provenance: write the `scope→points` map at triage time (chosen v1), and
  *optionally* also write through a real Linear points field when present — confirm the eligible
  projection (`linear-query.mjs`) can carry points without an extra fetch.
- Per-ticket override of `rules` (allowed) vs `next` (forbidden v1): is leaf-only too restrictive for
  any real near-term use case, or exactly right?
- Bash codegen ownership: a pre-commit hook vs. a CI-only regenerate-and-diff (a forgotten local
  regen reintroduces the drift the descriptor exists to delete).

## Appendix A: GATE 0 — the verify→remediate cycle is broken on HEAD (CONFIRMED)

While grounding this design, an adversarial reviewer flagged — and a forensic verification
**confirmed against `main` @ `d09fb2b2`** — a latent correctness bug in the merged CTL-736 Phase-1
claim. It is **not** caused by this descriptor work, but it (a) must be fixed before the descriptor
can faithfully model the cycle, and (b) is exactly why `cycles[].reset.releaseClaims: true` (§4) is in
the schema.

**The bug.** The `verify→remediate→verify` self-healing cycle silently dies under fencing:

1. `maybeResetForRemediateCycle` (`scheduler.mjs:903-918`) deletes only signal files —
   `REMEDIATE_CYCLE_FILES = ["phase-verify.json", "phase-remediate.json", "verify.json"]`
   (`scheduler.mjs:893`) — and **never** the `*.claim.<gen>` tombstones. `releaseClaim`
   (`claim.mjs:61`) has **zero** production callers.
2. On the re-dispatch, `phase-agent-dispatch:503-509` derives `TARGET_GENERATION` **from the (now
   absent) signal** ⇒ `EXISTING_STATUS` empty ⇒ `TARGET_GENERATION=1`. (The high-water-mark
   `currentGeneration` path that would compute `2` is *deliberately* not used here —
   `phase-agent-dispatch:482-484` forbids it to preserve the fixed-target single-flight invariant.)
3. The `noclobber` create of `verify.claim.1` collides with the **leftover** `verify.claim.1` from the
   first verify ⇒ `EEXIST` ⇒ the dispatcher prints `claim-lost`, `exit 0`, **writes no signal, spawns
   no worker** (`phase-agent-dispatch:528-541`).
4. `verifyDispatched` then reads a missing signal ⇒ `{ok:false, reason:"signal_missing"}` ⇒ the
   scheduler demotes it to a **dispatch failure + cooldown** (`scheduler.mjs:1766+`), accruing toward
   `escalateDispatchExhausted → needs-human`. The second verify never runs; the loop is dead.

**Why no test caught it.** Coverage exercises the cycle only at the `.mjs` signal layer
(`scheduler.test.mjs:1027-1042`, no `.claim.*` created). Worse, `phase-agent-dispatch.test.sh` Test 43
pre-seeds `triage.claim.1` with no signal and asserts `claim-lost`/no-spawn **as intended** — it
codifies the failing state, seeing it only through the concurrent-race lens, blind to the
remediate-reset producing the same state non-concurrently.

**The author already knew the failure mode** — the worktree-recreate path (added by CTL-736 at
`phase-agent-dispatch:735-739`) explicitly `rm -f "${WORKER_DIR}/${PHASE}.claim."*` "so the re-exec's
fresh (no-signal ⇒ gen 1) claim is exclusive and wins instead of colliding on gen 1." That same
cleanup was simply not applied in `maybeResetForRemediateCycle`.

**Fix (recommended — #1 of 3 candidates).** Extend `maybeResetForRemediateCycle` to glob-unlink the
cycle's `verify.claim.*` and `remediate.claim.*` tombstones (mirroring `phase-agent-dispatch:739`),
keeping the fixed-generation invariant intact. Add a **bash-level** e2e test that runs
`verify→remediate→verify` under fencing and asserts the 2nd verify dispatches a **live worker**.
*(Alternatives: have the reset call `releaseClaim` — collapses into #1 since it must read the claim
files; or derive `TARGET_GENERATION` from `currentGeneration()` when "signal absent but claims exist"
— riskiest, conflicts with the fixed-target invariant / Test 43.)*

**Ownership.** This is a **CTL-736 thread** fix (tracked separately), landing before/with Phase 2-3 —
not part of the descriptor PR. The descriptor's declarative `cycles[].reset.releaseClaims: true` is
the forward-compatible encoding of the fix.
