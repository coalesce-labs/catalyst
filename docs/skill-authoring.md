# Authoring a portable skill

This is the contributor-facing guide to getting a skill from `plugins/*/skills/` into the portable pack — the tree the `agentsSkills` target renders to `.agents/skills/` and (on release) publishes to `coalesce-labs/catalyst-skills` for `npx skills add`. It covers the packaging pipeline: the `agents/portability.yaml` sidecar, the closed vocabularies it declares, the invocation-parity rule that renders a hard error on a mismatch, and the pack-wide safety hooks veto that is the single most surprising fact about this pipeline. For frontmatter field reference (which `SKILL.md` keys are recognized and which are portable vs Claude-only), see `docs/frontmatter-standard.md`. For the pipeline's place in the wider architecture, see `docs/architecture.md` → "Multi-Target Packaging".

Writing a `SKILL.md` with a `name` and `description` is enough to make a skill work inside Claude Code. It is **not** enough to make it eligible for the portable pack — that requires an explicit `agents/portability.yaml` sidecar. A skill with no sidecar is not a bug and does not fail the build; it is simply excluded from every non-Claude target, on purpose (`core/safety-gate.mjs`'s `NO_NEUTRAL` reason: "missing classification is an error, and a safety-bearing loss must omit, never ship silently").

## The `agents/portability.yaml` sidecar

Location: `<skill-dir>/agents/portability.yaml`, sibling to the skill's `SKILL.md` (not to be confused with the *emitted* `agents/openai.yaml` a portable pack writes into its output — the sidecar is a **source** file you author, the `openai.yaml` is a **generated** file the pipeline writes). Three real examples, verbatim, from this repo today:

```yaml
# plugins/foundry/skills/setup-catalyst/agents/portability.yaml
effects: ["file-read", "file-write", "shell-exec"]
invocation: explicit
exposure: ["catalog"]
```

```yaml
# plugins/meta/skills/validate-frontmatter/agents/portability.yaml
effects: ["file-read", "file-write"]
invocation: explicit
exposure: ["catalog"]
```

```yaml
# plugins/dev/skills/linearis/agents/portability.yaml
effects: []
invocation: auto
exposure: ["catalog"]
```

All three keys are required; an extra or misspelled key, a value outside the accepted set, or a missing key is a hard error at render time naming the sidecar file, the offending key or value, and the accepted set (`core/neutral-schema.mjs`'s `validateNeutralDeclaration` — it fails closed by design, the same discipline `providers/local.mjs` applies to `SKILL.md` frontmatter keys).

## The closed vocabularies

Enumerated directly from `scripts/packaging/core/neutral-schema.mjs` — not from memory, since this file is the actual enforcement point and the one place these values can be trusted not to have drifted:

| Key | Accepted values | Notes |
|---|---|---|
| `effects` | `file-read`, `file-write`, `shell-exec`, `network` (array, may be empty) | What the skill actually does to the machine or network. `file-write` and `shell-exec` are the **mutating** effects — see the invocation-parity rule below. `network` is deliberately excluded from "mutating": a read-only fetch is not a mutation. |
| `invocation` | `explicit` or `auto` (exactly one) | `explicit` means the skill must never auto-trigger from model judgment alone — a human or an explicit slash-command invokes it. `auto` means the skill may auto-trigger like any other Claude Code skill. |
| `exposure` | `catalog`, `internal` (array, non-empty) | `catalog` marks a skill as eligible for a public distribution catalog (a necessary condition for the portable pack — see below for why it is not sufficient). `internal` marks it maintainer-facing only. |

## The invocation-parity rule

A skill whose `effects` intersect the mutating set (`file-write` or `shell-exec`) must declare **both** of the following, or rendering fails with a hard error naming the skill, both declarations, and what each must be:

- `invocation: explicit` in `agents/portability.yaml` (the neutral vocabulary), **and**
- `disable-model-invocation: true` in `SKILL.md`'s frontmatter (the Claude vocabulary).

This is `core/safety-gate.mjs`'s `checkInvocationParity`, generalized from a proven check in `catalyst-cloud`'s `tools/validate-skills.mjs`. The point is cross-vendor **parity**, not either vocabulary in isolation: a skill that is explicit-only under one vocabulary and auto-invocable under the other is not merely inconsistent, it is *inconsistently unsafe* — a harness reading only the vocabulary that says `auto` would auto-trigger a mutating skill the author believed was locked down. Both `setup-catalyst` and `validate-frontmatter` above declare `file-write`/`shell-exec` in their effects, `invocation: explicit` in the sidecar, and `disable-model-invocation: true` in their `SKILL.md` — that pairing is what parity looks like in practice; `linearis` above has no mutating effects at all, so the rule does not apply to it and it can stay `invocation: auto`.

## What `exposure: ["catalog"]` gets you — and does not

`catalog` exposure is **necessary but not sufficient** for a skill to reach the portable pack. Two further gates apply after exposure is checked, and either can still exclude a `catalog`-exposed skill:

1. **The pack-wide hooks veto** (below) — applies regardless of any individual skill's declaration.
2. **The target's invocation-expressiveness.** If a skill declares `invocation: explicit` but the target cannot guarantee enforcement of an explicit-invocation-only constraint, the skill is still emitted (never silently dropped for this reason) but is recorded as **degraded** — a named, counted capability shortfall, not a silent one. Today `TARGET_CAPABILITIES.agentsSkills.canExpressInvocationConstraint` is `false` (verified by reading the real `skills@1.5.23` CLI's own parser — it has no field equivalent to `disable-model-invocation`), so every `explicit`-invocation skill that does reach the portable pack is counted degraded. Both `setup-catalyst` and `validate-frontmatter` are in exactly this state: emitted, and degraded, simultaneously — degraded is not the opposite of emitted.

`internal` exposure is a hard omission, not a degrade: an `internal`-exposed skill never reaches any non-Claude target no matter what else is true about it.

## The pack-wide hooks veto — the single most surprising fact about this pipeline

`plugins/dev/hooks.toml`'s mere **presence** vetoes all **53** `catalyst-dev` skills from every non-Claude target, pack-wide — including skills that carry a perfectly valid `agents/portability.yaml` with `exposure: ["catalog"]`. `linearis` above is exactly this case: a well-formed sidecar, `catalog` exposure, and it is still omitted, because `catalyst-dev` as a whole has hooks and `classifySkillEmission`'s `HOOKS_PRESENT` check runs before a skill's own declaration is even consulted. The rationale (`core/safety-gate.mjs`): "hooks.toml is never projected to non-Claude targets — emitting this skill would silently remove a pack-level safety guard." A hook is pack-level infrastructure (audit logging, workflow-context tracking, etc.); a non-Claude target has no mechanism to carry it, so emitting the skill without its hooks would ship a *different*, less-guarded skill under the same name.

**Adding a portability sidecar to a `catalyst-dev` skill will not make it appear in `catalyst-skills`.** This is the confusion this section exists to preempt: a green `render` build with a correctly-authored sidecar and zero errors can still emit nothing for that skill, because the veto operates one level above the skill. The only way out is removing `catalyst-dev`'s pack-level hooks entirely, which is a safety decision for the plugin as a whole, not a per-skill authoring choice.

The measured result today: of 103 skills across 9 plugins, exactly **2** reach the portable pack — `catalyst-foundry/setup-catalyst` and `catalyst-meta/validate-frontmatter`, the only two skills that are simultaneously (a) in a hook-free pack and (b) carrying a valid `catalog`-exposed sidecar. Run `bun scripts/packaging/cli.mjs render --dry-run --target agentsSkills` to see the current census and loss counts for yourself rather than trusting this document as the census ages.

## Practical steps to make a skill portable

1. Confirm the skill's pack has no `hooks.toml`. If it does, stop — no sidecar will help (see above).
2. Decide the skill's real `effects`. Be honest about `file-write`/`shell-exec` — under-declaring is a safety bug the invocation-parity rule cannot catch (parity only fires when effects are declared truthfully), and over-declaring only costs you the `explicit`-invocation requirement below.
3. If any effect is mutating, set `invocation: explicit` in the sidecar **and** add `disable-model-invocation: true` to the `SKILL.md` frontmatter. If no effect is mutating, either value is legal; match whether you want the skill to auto-trigger under Claude Code today.
4. Set `exposure: ["catalog"]` if the skill is meant for a public, cross-harness audience; `["internal"]` if it is maintainer-only.
5. Run `bun scripts/packaging/cli.mjs render --dry-run --target agentsSkills` and confirm the skill's plugin now shows a non-zero delta in the census, and `bun scripts/packaging/cli.mjs conformance --target agentsSkills` to confirm the emitted `SKILL.md` (name/description only — Claude-only fields are dropped, not carried through) satisfies the external CLI's own contract.
