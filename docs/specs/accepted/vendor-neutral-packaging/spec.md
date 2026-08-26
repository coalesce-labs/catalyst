---
title: Vendor-neutral packaging — one pack manifest, many distribution targets
status: accepted
ticket: CTL-1463
created: 2026-08-24
---

## Problem

Catalyst packaged its 10 plugins for exactly one distribution target: Claude Code. Each plugin carried a `.claude-plugin/plugin.json`, discovery ran through the root `.claude-plugin/marketplace.json`, and Release Please owned every version through a per-package `extra-files` entry. That mechanism was clean but single-target — a design that happened to have only one instance, not one that resisted a second.

CTL-1461 (the ratified design, `docs/agent-skill-portability-design.md` in catalyst-cloud) defines the neutral render interface Catalyst's skills/agents should ultimately compile through. CTL-1463 ships the multi-target *system* around a **provisional** version of that interface, behind a seam CTL-1461 can swap in later without reworking anything downstream.

## Model

```
plugins/*/                                   authored source — never moved, never rewritten
   │
   ▼
┌──────────────────────────────┐
│ SOURCE PROVIDER (the seam)   │  ← providers/local-provisional.mjs (CTL-1463, provisional)
│                               │    replaced wholesale by CTL-1461's real provider
└──────────────────────────────┘
   │  returns a RenderedPack — frozen, versioned, validated at the boundary
   ▼
┌──────────────────────────────┐
│ CORE (never replaced)        │
│  • contract validation       │  scripts/packaging/core/contract.mjs
│  • pack.json read/merge      │  scripts/packaging/core/pack-manifest.mjs
│  • two-tier loss classifier  │  scripts/packaging/core/loss.mjs
│  • byte-exact JSON writer    │  scripts/packaging/core/json-format.mjs
└──────────────────────────────┘
   │
   ▼
┌──────────────────────────────┐
│ TARGET EMITTERS               │  scripts/packaging/emitters/
│  • claude.mjs   (byte-exact) │
│  • codex.mjs                 │
│  • agents-skills.mjs         │
└──────────────────────────────┘
```

**The seam is load-bearing, not aspirational.** `scripts/packaging/__tests__/packaging-seam.test.mjs` enforces, by source-scanning `core/` and `emitters/`, that neither imports `providers/` or reads a `plugins/` path literal, and that `providers/local-provisional.mjs` is imported by exactly one file (`cli.mjs`). When CTL-1461 lands, the swap is: delete `providers/local-provisional.mjs`, add `providers/ctl1461.mjs`, delete the per-skill `effects`/`invocation` block from each `pack.json` (it moves to CTL-1461's `agents/portability.yaml` sidecars), flip one default in the CLI. No change to the pack manifest schema's identity/distribution halves, no emitter, no `release-please-config.json`, no CI gate. If a future reviewer finds that swap touching an emitter or a gate, this design was wrong.

**CTL-1461 landed — checked against the prediction above, honestly.** The provider swap itself was exactly the pure relocation predicted: `providers/local.mjs` (not `ctl1461.mjs` — the real name chosen when the ticket was scoped) replaced `providers/local-provisional.mjs` wholesale, `pack.json`'s per-skill block moved verbatim to `agents/portability.yaml` sidecars, and the seam guard's "imported by exactly one file" invariant held throughout. But the swap **did** touch an emitter and **did** add a gate — `emitters/agents-skills.mjs` gained a per-skill `agents/openai.yaml` (Phase 2) and `emitters/codex.mjs` gained a `.generated-by-catalyst-packaging` marker (Phase 3), and the drift gate is a new CI job. Per this spec's own closing sentence that would mean "this design was wrong" — it is not: the ratified CTL-1446 design assigns the non-negotiable safety gate and the drift gate to CTL-1461 explicitly, scope this spec's own "What this ticket explicitly did NOT do" section named as CTL-1461's to build, not as an extension of the CTL-1463 seam contract. The seam itself (core/emitters never importing `providers/` or reading `plugins/` literals) was never violated; what changed is that CTL-1461 added new, seam-respecting code to `emitters/` and to CI, which this spec did not anticipate needing to say explicitly. Recorded here per this ticket's own invitation to check the prediction, rather than silently exceeding it. Phases 4–6 (shared conformance fixtures, loss-report quantification, and the install/authoring docs this spec's own scope excluded) are CTL-1461's follow-on, tracked separately.

## The pack manifest (`plugins/<name>/pack.json`)

One hand-authored file per plugin, carrying everything except the version:

- `identity` — description, author, homepage, repository, keywords, license, optional `dependencies`/`agents` (the Claude-only subagent-file list).
- `distribution.claude.marketplace` — the independently-maintained, hand-tuned prose/category/ keywords that already differ from `plugin.json`'s own description (verified: `plugins/dev`'s `plugin.json` description and `marketplace.json` description are materially different strings).
- `distribution.codex` / `distribution.agentsSkills` — `{ enabled }` only.
- `skills` — the per-skill neutral opt-in block (`{ effects, invocation, exposure }`). This is the ONE field whose *source* moves when CTL-1461 lands.

**Version is deliberately absent.** Release Please owns it exclusively via each `plugin.json`'s `extra-files` jsonpath; a `version` key in `pack.json` would be a third source of truth. `pack-manifest.mjs` rejects one with a message naming release-please as the owner — not merely "unknown key", because that would read as a typo rather than a deliberate constraint.

## The two-tier loss classifier

The enumeration is closed (it comes from the ratified design's schema-field-shaped boundary), so this is a table (`core/loss.mjs`), not a detector:

| Component | Class | Policy for a non-Claude target |
| --- | --- | --- |
| `hooks.toml` | **safety** | never projected; marks the pack's skills guard-reduced |
| `allowed-tools:` / `disable-model-invocation:` | **safety** | skill **omitted** unless `pack.json` declares a neutral classification |
| `agents/*.md` subagents | **capability** | omitted + warned (a capability the target lacks, not a guard) |
| `model:` / `color:` / `argument-hint:` / `user-invocable:` / `version:` (skill/agent frontmatter) | **cosmetic** | dropped + warned |
| `${CLAUDE_PLUGIN_ROOT}`, `/plugin:skill`, `Task(subagent_type=…)` in prose | **presentation** | warned (rewriting is CTL-1462's lint, not this pipeline's) |
| `.mcp.json` co-location | **capability** | reported; emitting a Codex tool-wiring equivalent is out of scope |

**Only safety-class losses omit.** Everything else is a target that is less powerful or less pretty, not less safe — the ratified design's line is exactly there.

**No silent caps.** `cli.mjs render` exits non-zero on any unacknowledged loss unless `--allow-losses` is passed, and always prints the omitted/degraded/warning counts. `dist/loss-report.json` + `dist/LOSSES.md` (gitignored generated output, `--write` to persist) are byte-deterministic for the same input.

## Day-one scope: a pipeline, not 115 portable skills

Every `plugins/dev` skill carries `allowed-tools:` (a Claude-vocabulary effects guard); none has a neutral declaration yet — authoring those is CTL-1461/1462's scope. So on day one the Codex and `.agents/skills` targets export only the skills whose `pack.json` opts them in, and every other skill is correctly omitted and named in the loss report. Measured on this repo at ship time: 114 skills, 3 opted in (`catalyst-dev:linearis`, `catalyst-meta:validate-frontmatter`, `catalyst-foundry:setup-catalyst` — chosen to prove the emitters end-to-end), 111 omitted with a named safety reason. That large loss report is the correct, designed output of this ticket, not a gap — it is the work-list CTL-1461/1462 burn down.

## Real drift the byte-exact round-trip surfaced

Proving the Claude emitter byte-identical (`claude-emitter.test.mjs`) surfaced two pre-existing facts about the committed tree, reproduced faithfully rather than "fixed":

- `.claude-plugin/plugin.json` stores non-ASCII as literal UTF-8 (no `\u` escapes, verified across all 10 files); `.claude-plugin/marketplace.json` stores it as `\uXXXX` escapes. The byte-exact JSON writer (`core/json-format.mjs`) takes `escapeNonAscii` as a required per-call parameter because the two files disagree with each other.
- Every `marketplace.json` entry's `author` is a constant catalog-level `{name, email}` — independent of that plugin's own `plugin.json` author (which differs for `dev`/`foundry`/`legacy`, `hello@coalesce-labs.com` vs. every marketplace entry's `hello@coalesce.dev`).

Separately, shipping a REAL YAML parser (`Bun.YAML.parse`, not a regex) surfaced 4 genuinely invalid YAML frontmatter blocks (`description:` prose containing an unquoted colon-space sequence — confirmed invalid against PyYAML, not a Bun quirk) in already-committed `SKILL.md` files. Fixed by quoting the value; prose and rendered text are byte-identical.

## Version propagation (the ticket's acceptance criterion)

> Given a release PR merges with a version bump for a plugin, when release-please updates manifests,
> then the Claude and Codex manifests for that plugin carry the same new version.

Satisfied by making **release-please itself** write both files in the same commit — a second `extra-files` entry per package in `release-please-config.json` — so the criterion holds even if the compiler never runs. `scripts/validate-release-config.sh` Checks 9–11 assert the invariant on every PR (Check 10's "0 comparisons → inconclusive, never PASS" guard is deliberately the strictest check in the set — every other check in this phase can be satisfied by a script that never compares anything).

## What this ticket explicitly did NOT do

- Build the render/compile engine, real source discovery, or conformance fixtures graded across Catalyst AND catalyst-cloud — **CTL-1461's** scope.
- Build the portability lint that flags executor-specific constructs in authored source — **CTL-1462's** scope.
- Prove Codex installs the generated artifacts — the **CTL-1465** probe. This pipeline claims well-formedness only.
- Extract `@coalesce/agent-skills` as a standalone package — the ratified criterion ("only after Catalyst AND catalyst-cloud pass the shared fixture set") is not met; `cli.mjs extraction-readiness` reports `inconclusive` and names why.

## References

- Research: `thoughts/shared/research/2026-08-24-CTL-1463-vendor-neutral-packaging.md`
- Plan: `thoughts/shared/plans/2026-08-24-ctl-1463.md`
- Ratified design (CTL-1446): `docs/agent-skill-portability-design.md` (catalyst-cloud repo)
- `docs/releases.md` — Version Source of Truth table, extended for the Codex manifest
- `docs/architecture.md` — pointer section
- `.claude/rules/plugin-editing.md` — pack.json / generated-tree editing rules
