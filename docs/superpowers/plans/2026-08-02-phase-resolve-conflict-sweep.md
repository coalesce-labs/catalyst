# phase-resolve-conflict Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `resolve-conflict-sweep` + `phase-resolve-conflict` architecture (ADR-028, `docs/adrs.md`) so a resolvable sibling-PR-merge source conflict self-heals instead of sitting stalled until a human notices (#1461).

**Architecture:** A new tick-loop sweep (`execution-core/resolve-conflict-sweep.mjs`) scans for tickets stalled with `source_conflict_ctl708_unavailable`, classifies resolvability live via the existing `classifyMergeTree`, and dispatches a new `phase-resolve-conflict` skill (cloned from `phase-remediate`'s envelope) through the standard `dispatch.mjs → phase-agent-dispatch` path already used by `recovery-pass`. On completion the sweep mechanically clears the original stall (reusing `defaultClearStall`) so the phase that stalled redispatches fresh, this time past a clean rebase.

**Tech Stack:** Node/Bun (`.mjs`, `bun test`), bash (phase-agent-dispatch/lib scripts), Claude Code skill Markdown (SKILL.md).

## Global Constraints

- Repo: `~/code-repos/github/coalesce-labs/catalyst`. Branch: `feat/phase-resolve-conflict-sweep` (based on latest `origin/main`, already has the ADR-028 commit). Remotes: `fork` = `thagale/catalyst` (push here only), `origin` = `coalesce-labs/catalyst` (read-only, never push).
- Test runner: `bun test <file>` per file. Every new/modified `.mjs` gets a colocated `<name>.test.mjs` (repo convention: `stale-pr-rescue.mjs`/`.test.mjs`, `scheduler.mjs`/`.test.mjs`). Shell-side changes (`lib/phase-artifact-gate.sh`) get a colocated `lib/__tests__/<name>.test.sh`.
- **Baseline measured 2026-08-02**, clean `feat/phase-resolve-conflict-sweep` checkout (`git status --short` clean, only the ADR-028 commit + this plan file present): `bun test plugins/dev/scripts/execution-core/scheduler.test.mjs` → **506 pass / 102 fail / 1126 expect() calls, 608 tests, ~189s wall time**. This is the real, re-measured baseline — it does NOT match the old PR #2864's cited 515/101 (repo has moved on since); do not "correct" it back to the old numbers. The run takes ~3 minutes — budget a Bash timeout of at least 300s (600s to be safe) whenever running this file, and note the same for `unstuck-sweep.test.mjs` if it proves similarly large. Task 12's A/B comparison must reproduce 506 pass / 102 fail on the pre-change stash before asserting "0 new failures" after the change (any deviation before applying this plan's changes means the codebase moved between Task 0 and Task 12 — re-measure both sides fresh rather than trusting this recorded number if that happens).
- **Confirmed real field-name bug** (discovered during planning, not yet fixed anywhere): `phase-agent-dispatch:1150-1157` writes the dispatch-time-rebase conflict stall as `status:"stalled"` + **`failureReason`** (NOT `stalledReason`) — e.g. `.failureReason = "source_conflict_ctl708_unavailable"`. But `unstuck-sweep.mjs`'s `defaultCollectUnstuckCandidates` (line 154) and `recovery-reasoning.mjs:758`'s `checkBoundedLlmFixes` both key on `signal.stalledReason` for this exact string — meaning, in production, neither of those `source_conflict_ctl708_unavailable` branches has ever actually matched a real signal (the field name doesn't match what's written). Every task below that reads this stall reason MUST check `raw.failureReason` (matching the real producer), and Task 9 fixes `unstuck-sweep.mjs`'s collector to also check `failureReason` so its existing (never-yet-live) `source-conflict` category starts working too.
- Never touch `plugins/dev/skills/recovery-pass/SKILL.md` (ADR-028 Consequences: explicitly a follow-up, out of scope here).
- Never touch `plugins/dev/scripts/orch-monitor/lib/inbox-ask.mjs` (ADR-028 amendment: its header regexes are hardcoded to the literal string `recovery-pass`; generalizing them is a separate follow-up, not this plan — the escalation comment mirrors the visual convention only).
- No private repo/org/ticket references in any commit message, code comment, or Linear-facing string — this is a public repo. Only public GitHub issue/PR numbers (`#1461`, etc.) and public `CTL-`/`CATALYST_`-prefixed identifiers are fine (matches PR #2863/#2864's own commits).
- Every `stalledReason`/`failureReason` string this plan introduces (`source_conflict_resolvable`, `resolve-conflict-cycle-cap-exhausted`) must not collide with the existing enum: `remediate-cycle-cap-exhausted`, `prior-artifact-retry-exhausted`, `escalation-ask-cap`, `boot-resume-gate-expired`, `source_conflict_ctl708_unavailable`, `rebase_refused_dirty_tree`, `thoughts_conflict_with_origin_main`, `orphan-sweep-stale`, `worker-oom`, `pr_not_merged`, `push_rejected_no_workflow_scope`. (Verified via grep — confirmed clean.)

---

## Task 0: Measure the current test baseline

**Files:** none created/modified — measurement only.

`scheduler.test.mjs`'s baseline (506 pass / 102 fail / 608 tests, ~189s) is already measured and recorded in Global Constraints above (2026-08-02, this branch, clean tree). If implementation starts the same day this baseline was recorded, skip straight to Task 1. If meaningful time has passed (this branch has since been rebased, or it's a different day), re-measure before trusting it:

- [ ] **Step 1: Re-run the full scheduler + unstuck-sweep + event-scan suites on a clean checkout**

```bash
cd ~/code-repos/github/coalesce-labs/catalyst
git status --short   # must be clean before measuring
bun test plugins/dev/scripts/execution-core/scheduler.test.mjs 2>&1 | tail -8   # allow ~200s
bun test plugins/dev/scripts/execution-core/unstuck-sweep.test.mjs 2>&1 | tail -5
bun test plugins/dev/scripts/execution-core/event-scan.test.mjs 2>&1 | tail -5
```

- [ ] **Step 2: Record the exact pass/fail counts**

If the numbers differ from the recorded 506/102, update the Global Constraints section with the fresh numbers and a new date — this is the baseline Task 12's A/B check reproduces. Do not proceed to Task 1 with a stale/unverified baseline (a wrong baseline invalidates the whole A/B safety check).

---

## Task 1: `event-scan.mjs` — cycle-cap counter

**Files:**
- Modify: `plugins/dev/scripts/execution-core/event-scan.mjs`
- Test: `plugins/dev/scripts/execution-core/event-scan.test.mjs`

**Interfaces:**
- Produces: `RESOLVE_CONFLICT_NAME_PREFIX = "phase.resolve-conflict.complete."` (const), `countResolveConflictCycles({ticket, orchId, since, path = getEventLogPath()})` → number.

- [ ] **Step 1: Write the failing tests**

Find the existing `describe("countRecoveryPassCycles", ...)` block in `event-scan.test.mjs` and add a sibling block directly after it:

```js
describe("countResolveConflictCycles", () => {
  const path = "/tmp/resolve-conflict-cycles-test.jsonl";

  beforeEach(() => {
    __resetEventScanIndexForTest();
    try { unlinkSync(path); } catch {}
  });

  test("counts phase.resolve-conflict.complete.<ticket> envelopes", () => {
    writeFileSync(
      path,
      [
        JSON.stringify({ ts: "2026-08-02T00:00:00Z", attributes: { "event.name": "phase.resolve-conflict.complete.CTL-1" } }),
        JSON.stringify({ ts: "2026-08-02T00:01:00Z", attributes: { "event.name": "phase.resolve-conflict.complete.CTL-1" } }),
        JSON.stringify({ ts: "2026-08-02T00:02:00Z", attributes: { "event.name": "phase.resolve-conflict.complete.CTL-2" } }),
      ].join("\n") + "\n",
    );
    expect(countResolveConflictCycles({ ticket: "CTL-1", path })).toBe(2);
    expect(countResolveConflictCycles({ ticket: "CTL-2", path })).toBe(1);
    expect(countResolveConflictCycles({ ticket: "CTL-9", path })).toBe(0);
  });

  test("does not match a suffix-only ticket (CTL-1 vs CTL-10)", () => {
    writeFileSync(
      path,
      JSON.stringify({ ts: "2026-08-02T00:00:00Z", attributes: { "event.name": "phase.resolve-conflict.complete.CTL-10" } }) + "\n",
    );
    expect(countResolveConflictCycles({ ticket: "CTL-1", path })).toBe(0);
  });

  test("throws without a ticket", () => {
    expect(() => countResolveConflictCycles({ path })).toThrow("countResolveConflictCycles: ticket required");
  });
});
```

Add `countResolveConflictCycles` to the file's top-of-file import list (it currently imports `countRemediateCycles, countRecoveryPassCycles, ...` from `./event-scan.mjs` — add the new name to that same import).

- [ ] **Step 2: Run to verify it fails**

Run: `bun test plugins/dev/scripts/execution-core/event-scan.test.mjs -t "countResolveConflictCycles"`
Expected: FAIL — `countResolveConflictCycles is not a function` / not exported.

- [ ] **Step 3: Implement in event-scan.mjs**

Add directly after the existing `RECOVERY_PASS_NAME_PREFIX` constant (around line 52):

```js
// CTL-1176-adjacent, #1461: the resolve-conflict-sweep dispatch budget, event-
// counted exactly like countRemediateCycles/countRecoveryPassCycles. One
// completed resolve-conflict run == one phase.resolve-conflict.complete.<ticket>
// event. Durable (survives the stalled-signal clear), so the cap holds across
// ticks/restarts.
const RESOLVE_CONFLICT_NAME_PREFIX = "phase.resolve-conflict.complete.";
```

Add `RESOLVE_CONFLICT_NAME_PREFIX` to the `isRelevant()` predicate's `startsWith` chain (around line 89):

```js
function isRelevant(name) {
  return (
    typeof name === "string" &&
    (REVIVE_NAME_RE.test(name) ||
      name.startsWith(REMEDIATE_NAME_PREFIX) ||
      name.startsWith(RESOLVE_CONFLICT_NAME_PREFIX) ||
      COMPLETE_NAME_RE.test(name))
  );
}
```

Add the exported counter directly after `countRecoveryPassCycles`:

```js
// countResolveConflictCycles — number of phase.resolve-conflict.complete.<ticket>
// envelopes (#1461). The event-counted resolve-conflict-sweep dispatch budget,
// mirroring countRemediateCycles/countRecoveryPassCycles exactly.
export function countResolveConflictCycles({ ticket, orchId, since, path = getEventLogPath() } = {}) {
  if (!ticket) throw new Error("countResolveConflictCycles: ticket required");
  return countByExactName(`${RESOLVE_CONFLICT_NAME_PREFIX}${ticket}`, { orchId, since, path });
}
```

Also export the prefix constant (it is not exported for the other two either — keep it internal, matching `REMEDIATE_NAME_PREFIX`'s own non-exported convention. Do NOT export `RESOLVE_CONFLICT_NAME_PREFIX`).

- [ ] **Step 4: Run to verify it passes**

Run: `bun test plugins/dev/scripts/execution-core/event-scan.test.mjs`
Expected: PASS, all tests including the 3 new ones. No regressions in the rest of the file.

- [ ] **Step 5: Commit**

```bash
git add plugins/dev/scripts/execution-core/event-scan.mjs plugins/dev/scripts/execution-core/event-scan.test.mjs
git commit -m "feat(dev): #1461 — countResolveConflictCycles event counter"
```

---

## Task 2: `config.mjs` — three-mode config reader

**Files:**
- Modify: `plugins/dev/scripts/execution-core/config.mjs`
- Test: `plugins/dev/scripts/execution-core/config.test.mjs`

**Interfaces:**
- Produces: `readResolveConflictSweepConfig(envObj = process.env)` → `{ mode: "off"|"shadow"|"enforce" }`. No `intervalMs` field (this sweep runs every tick, unlike unstuck-sweep — confirmed design decision).

- [ ] **Step 1: Write the failing tests**

Find the existing `describe("readRecoveryPassConfig", ...)` block in `config.test.mjs` and add a sibling block after it:

```js
describe("readResolveConflictSweepConfig", () => {
  const ORIGINAL_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  test("defaults to off", () => {
    delete process.env.CATALYST_RESOLVE_CONFLICT_SWEEP;
    expect(readResolveConflictSweepConfig({})).toEqual({ mode: "off" });
  });

  test("env CATALYST_RESOLVE_CONFLICT_SWEEP=shadow overrides default", () => {
    expect(readResolveConflictSweepConfig({ CATALYST_RESOLVE_CONFLICT_SWEEP: "shadow" })).toEqual({ mode: "shadow" });
  });

  test("env CATALYST_RESOLVE_CONFLICT_SWEEP=enforce overrides default", () => {
    expect(readResolveConflictSweepConfig({ CATALYST_RESOLVE_CONFLICT_SWEEP: "enforce" })).toEqual({ mode: "enforce" });
  });

  test("env '0' is the off kill-switch", () => {
    expect(readResolveConflictSweepConfig({ CATALYST_RESOLVE_CONFLICT_SWEEP: "0" })).toEqual({ mode: "off" });
  });

  test("an unrecognized env value falls back to off (safe default)", () => {
    expect(readResolveConflictSweepConfig({ CATALYST_RESOLVE_CONFLICT_SWEEP: "bogus" })).toEqual({ mode: "off" });
  });
});
```

Add `readResolveConflictSweepConfig` to the file's existing import of `config.mjs` exports at the top of the test file (alongside `readRecoveryPassConfig`, etc.).

- [ ] **Step 2: Run to verify it fails**

Run: `bun test plugins/dev/scripts/execution-core/config.test.mjs -t "readResolveConflictSweepConfig"`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement in config.mjs**

Add directly after `readRecoveryPassConfig` (mirrors its shape exactly, including the Layer-2 path — but note this sweep has no Layer-2 override in this plan; env-only, matching the "one operator knob" pattern; a Layer-2 hook can be added later if operators ask):

```js
// #1461: resolve-conflict-sweep mode reader. Mirrors readRecoveryPassConfig
// exactly: env (CATALYST_RESOLVE_CONFLICT_SWEEP) is the single operator knob,
// default 'off' (ADR-023) — operators opt in to shadow then enforce.
const RESOLVE_CONFLICT_SWEEP_MODES = new Set(["off", "shadow", "enforce"]);

export function readResolveConflictSweepConfig(envObj = process.env) {
  const env = envObj.CATALYST_RESOLVE_CONFLICT_SWEEP;
  let mode;
  if (env === "0") {
    mode = "off";
  } else if (typeof env === "string" && RESOLVE_CONFLICT_SWEEP_MODES.has(env)) {
    mode = env;
  } else {
    mode = "off"; // safe default: off — operators opt into shadow then enforce
  }
  return { mode };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test plugins/dev/scripts/execution-core/config.test.mjs`
Expected: PASS, all tests including the 5 new ones.

- [ ] **Step 5: Commit**

```bash
git add plugins/dev/scripts/execution-core/config.mjs plugins/dev/scripts/execution-core/config.test.mjs
git commit -m "feat(dev): #1461 — readResolveConflictSweepConfig (off/shadow/enforce)"
```

---

## Task 3: `resolve-conflict-sweep-event-types.mjs` — event vocabulary

**Files:**
- Create: `plugins/dev/scripts/execution-core/resolve-conflict-sweep-event-types.mjs`
- Test: `plugins/dev/scripts/execution-core/resolve-conflict-sweep-event-types.test.mjs`

**Interfaces:**
- Produces: `RESOLVE_CONFLICT_SWEEP_EVENT_TYPES` — frozen array of 8 strings.

- [ ] **Step 1: Write the failing test**

```js
import { describe, test, expect } from "bun:test";
import { RESOLVE_CONFLICT_SWEEP_EVENT_TYPES } from "./resolve-conflict-sweep-event-types.mjs";

describe("RESOLVE_CONFLICT_SWEEP_EVENT_TYPES", () => {
  test("is a frozen array of exactly these 8 strings", () => {
    expect(Object.isFrozen(RESOLVE_CONFLICT_SWEEP_EVENT_TYPES)).toBe(true);
    expect(RESOLVE_CONFLICT_SWEEP_EVENT_TYPES).toEqual([
      "resolve-conflict.marked.resolvable",
      "resolve-conflict.would.mark",
      "resolve-conflict.dispatched",
      "resolve-conflict.would.dispatch",
      "resolve-conflict.cleared",
      "resolve-conflict.would.clear",
      "resolve-conflict.escalated",
      "resolve-conflict.would.escalate",
    ]);
  });

  test("every entry is unique", () => {
    expect(new Set(RESOLVE_CONFLICT_SWEEP_EVENT_TYPES).size).toBe(RESOLVE_CONFLICT_SWEEP_EVENT_TYPES.length);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test plugins/dev/scripts/execution-core/resolve-conflict-sweep-event-types.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// resolve-conflict-sweep-event-types.mjs — #1461 resolve-conflict-sweep event
// vocabulary. Dependency-free leaf, mirroring unstuck-sweep-event-types.mjs and
// janitor-event-types.mjs. Every string the sweep passes to its emit() seam MUST
// be listed here. This is its OWN closed vocabulary — not routed through
// reap-intent.mjs or unstuck-sweep's UNSTUCK_SWEEP_EVENT_TYPES (same "closed
// list per sweep" discipline those two modules already establish).

export const RESOLVE_CONFLICT_SWEEP_EVENT_TYPES = Object.freeze([
  // A resolvable candidate found — marked and about to dispatch.
  "resolve-conflict.marked.resolvable",
  "resolve-conflict.would.mark", // shadow twin
  // phase-resolve-conflict dispatched via the standard envelope.
  "resolve-conflict.dispatched",
  "resolve-conflict.would.dispatch", // shadow twin
  // The original stall cleared after a resolve-conflict completion.
  "resolve-conflict.cleared",
  "resolve-conflict.would.clear", // shadow twin
  // Cycle cap exhausted without a clean resolution — escalated to the operator.
  "resolve-conflict.escalated",
  "resolve-conflict.would.escalate", // shadow twin
]);
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test plugins/dev/scripts/execution-core/resolve-conflict-sweep-event-types.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/dev/scripts/execution-core/resolve-conflict-sweep-event-types.mjs plugins/dev/scripts/execution-core/resolve-conflict-sweep-event-types.test.mjs
git commit -m "feat(dev): #1461 — resolve-conflict-sweep event vocabulary"
```

---

## Task 4: `resolve-conflict-sweep.mjs` — pure classifier + candidate collection

**Files:**
- Create: `plugins/dev/scripts/execution-core/resolve-conflict-sweep.mjs`
- Test: `plugins/dev/scripts/execution-core/resolve-conflict-sweep.test.mjs`

**Interfaces:**
- Consumes: `classifyMergeTree({exitCode, output}, {maxConflictFiles})` from `./stale-pr-rescue.mjs` (unmodified import); `defaultMergeTree(worktreePath, base, head)` from `./stale-pr-rescue-timer.mjs` (unmodified import, async, fetches then runs `git merge-tree --write-tree`); `RESOLVE_CONFLICT_CYCLE_CAP`-consuming callers will import it from this file (defined here, Task 6 wires the cap check).
- Produces: `RESOLVE_CONFLICT_STALL_REASON = "source_conflict_ctl708_unavailable"`, `RESOLVED_MARKER_REASON = "source_conflict_resolvable"`, `CAP_EXHAUSTED_REASON = "resolve-conflict-cycle-cap-exhausted"`, `RESOLVE_CONFLICT_CYCLE_CAP` (number, env `CATALYST_RESOLVE_CONFLICT_CYCLE_CAP` override, default 3), `classifyResolveConflictCandidate(ctx)` → `{action, reason}`, `defaultCollectResolveConflictCandidates({orchDir, readdirSync, readFileSync, resolveWorktreePath, base})` → `[{ticket, phase, workerDir, worktreePath, base, raw}]`. `worktreePath` comes from an injected `resolveWorktreePath(ticket)` seam (mirrors `defaultCollectUnstuckCandidates`'s own param — production default resolves `null`, since git-worktree resolution is a separate concern the driver wiring in Task 12 injects the real one from; a `null` worktreePath makes `classifyLiveConflict` (Task 5) return `null` — safe fail-closed). `base` defaults to `"main"`, overridable via the same-named param. `cycleCount` is NOT on the candidate — the driver (Task 8) calls `cycleCountOf(ticket)` separately, since the cap is event-counted (Task 1), not signal-stored.

- [ ] **Step 1: Write the failing tests for the pure classifier**

```js
import { describe, test, expect } from "bun:test";
import {
  classifyResolveConflictCandidate,
  RESOLVE_CONFLICT_STALL_REASON,
  RESOLVED_MARKER_REASON,
  CAP_EXHAUSTED_REASON,
  RESOLVE_CONFLICT_CYCLE_CAP,
  defaultCollectResolveConflictCandidates,
} from "./resolve-conflict-sweep.mjs";

describe("constants", () => {
  test("stall reason strings match the real producer + do not collide with the enum", () => {
    expect(RESOLVE_CONFLICT_STALL_REASON).toBe("source_conflict_ctl708_unavailable");
    expect(RESOLVED_MARKER_REASON).toBe("source_conflict_resolvable");
    expect(CAP_EXHAUSTED_REASON).toBe("resolve-conflict-cycle-cap-exhausted");
    expect(RESOLVE_CONFLICT_CYCLE_CAP).toBeGreaterThan(0);
  });
});

describe("classifyResolveConflictCandidate", () => {
  test("not our stall reason and not already resolving → skip", () => {
    expect(classifyResolveConflictCandidate({ stalledReasonMatches: false, alreadyResolving: false, cycleCount: 0, classification: null }))
      .toEqual({ action: "skip", reason: "not-our-stall" });
  });

  test("cap already exhausted → cap-exhausted regardless of classification", () => {
    expect(classifyResolveConflictCandidate({ stalledReasonMatches: true, alreadyResolving: false, cycleCount: 3, classification: { resolvable: true, conflictFiles: [], conflictTypes: [] } }))
      .toEqual({ action: "cap-exhausted", reason: "cycle-cap-exhausted" });
  });

  test("already marked/dispatched this cycle → skip (dispatch is in flight)", () => {
    expect(classifyResolveConflictCandidate({ stalledReasonMatches: false, alreadyResolving: true, cycleCount: 0, classification: null }))
      .toEqual({ action: "skip", reason: "already-resolving" });
  });

  test("classification unavailable (merge-tree probe failed this tick) → skip, retry next tick", () => {
    expect(classifyResolveConflictCandidate({ stalledReasonMatches: true, alreadyResolving: false, cycleCount: 0, classification: null }))
      .toEqual({ action: "skip", reason: "classification-unavailable" });
  });

  test("classified not-resolvable → skip, leave for existing needs-human surfacing", () => {
    expect(classifyResolveConflictCandidate({ stalledReasonMatches: true, alreadyResolving: false, cycleCount: 0, classification: { resolvable: false, conflictFiles: ["a.ts"], conflictTypes: ["modify/delete"] } }))
      .toEqual({ action: "skip", reason: "not-resolvable" });
  });

  test("resolvable and under cap → mark-and-dispatch", () => {
    expect(classifyResolveConflictCandidate({ stalledReasonMatches: true, alreadyResolving: false, cycleCount: 1, classification: { resolvable: true, conflictFiles: ["a.ts"], conflictTypes: ["content"] } }))
      .toEqual({ action: "mark-and-dispatch", reason: "resolvable" });
  });
});

describe("defaultCollectResolveConflictCandidates", () => {
  function fakeFs({ workerDirs, files }) {
    return {
      readdirSync: (p, opts) => {
        if (opts?.withFileTypes) {
          return (workerDirs[p] ?? []).map((name) => ({ name, isDirectory: () => true }));
        }
        return files[p] ?? [];
      },
      readFileSync: (p) => {
        if (!(p in files)) throw new Error(`ENOENT: ${p}`);
        return files[p];
      },
    };
  }

  test("finds a ticket stalled via failureReason (the real producer field)", () => {
    const orchDir = "/orch";
    const fs = fakeFs({
      workerDirs: { "/orch/workers": ["CTL-1"] },
      files: {
        "/orch/workers/CTL-1": ["phase-implement.json"],
        "/orch/workers/CTL-1/phase-implement.json": JSON.stringify({
          status: "stalled",
          failureReason: "source_conflict_ctl708_unavailable",
        }),
      },
    });
    const out = defaultCollectResolveConflictCandidates({ orchDir, ...fs });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ ticket: "CTL-1", phase: "implement" });
  });

  test("also finds a ticket via the legacy stalledReason field (defensive dual-check)", () => {
    const orchDir = "/orch";
    const fs = fakeFs({
      workerDirs: { "/orch/workers": ["CTL-2"] },
      files: {
        "/orch/workers/CTL-2": ["phase-verify.json"],
        "/orch/workers/CTL-2/phase-verify.json": JSON.stringify({
          status: "stalled",
          stalledReason: "source_conflict_ctl708_unavailable",
        }),
      },
    });
    const out = defaultCollectResolveConflictCandidates({ orchDir, ...fs });
    expect(out).toHaveLength(1);
    expect(out[0].ticket).toBe("CTL-2");
  });

  test("finds an already-marked (in-flight) ticket via RESOLVED_MARKER_REASON", () => {
    const orchDir = "/orch";
    const fs = fakeFs({
      workerDirs: { "/orch/workers": ["CTL-3"] },
      files: {
        "/orch/workers/CTL-3": ["phase-review.json"],
        "/orch/workers/CTL-3/phase-review.json": JSON.stringify({
          status: "stalled",
          failureReason: "source_conflict_resolvable",
        }),
      },
    });
    const out = defaultCollectResolveConflictCandidates({ orchDir, ...fs });
    expect(out).toHaveLength(1);
    expect(out[0].raw.failureReason).toBe("source_conflict_resolvable");
  });

  test("ignores an unrelated stall reason", () => {
    const orchDir = "/orch";
    const fs = fakeFs({
      workerDirs: { "/orch/workers": ["CTL-4"] },
      files: {
        "/orch/workers/CTL-4": ["phase-implement.json"],
        "/orch/workers/CTL-4/phase-implement.json": JSON.stringify({
          status: "stalled",
          failureReason: "rebase_refused_dirty_tree",
        }),
      },
    });
    expect(defaultCollectResolveConflictCandidates({ orchDir, ...fs })).toHaveLength(0);
  });

  test("a missing workers dir returns []", () => {
    expect(defaultCollectResolveConflictCandidates({ orchDir: "/nope", readdirSync: () => { throw new Error("ENOENT"); } })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test plugins/dev/scripts/execution-core/resolve-conflict-sweep.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// resolve-conflict-sweep.mjs — #1461 deterministic resolvable-conflict sweep
// (ADR-028). Structurally mirrors stall-janitor.mjs / unstuck-sweep.mjs: a PURE
// classifier (no IO) + an action driver (Task 6/7/8) with every side-effect seam
// injected. Runs on stalled tickets DIRECTLY, independent of isTicketInFlight —
// deriveAdvancement excludes any "stalled" ticket from its sweep entirely, so
// this is a dedicated pass, not a deriveAdvancement detour (ADR-028 rationale).
//
// CONFIRMED FIELD-NAME BUG (see this plan's Global Constraints): the real
// producer (phase-agent-dispatch:1150-1157) writes this stall as
// `status:"stalled"` + `.failureReason`, NOT `.stalledReason` — despite every
// existing consumer of this exact reason string (unstuck-sweep.mjs,
// recovery-reasoning.mjs) checking `stalledReason`. This module checks BOTH
// fields defensively so it actually finds real candidates in production.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isTicketKey } from "./ticket-key.mjs";

export const RESOLVE_CONFLICT_STALL_REASON = "source_conflict_ctl708_unavailable";
export const RESOLVED_MARKER_REASON = "source_conflict_resolvable";
export const CAP_EXHAUSTED_REASON = "resolve-conflict-cycle-cap-exhausted";
export const RESOLVE_CONFLICT_CYCLE_CAP =
  Number(process.env.CATALYST_RESOLVE_CONFLICT_CYCLE_CAP) || 3;

// classifyResolveConflictCandidate — PURE. ctx fields:
//   stalledReasonMatches — the candidate's raw reason === RESOLVE_CONFLICT_STALL_REASON
//   alreadyResolving     — the candidate's raw reason === RESOLVED_MARKER_REASON
//                           (already marked + dispatched this cycle; awaiting completion)
//   cycleCount            — countResolveConflictCycles({ticket}) — event-counted, durable
//   classification         — classifyMergeTree(...) result, or null if the merge-tree
//                            probe has not run yet / failed this tick
export function classifyResolveConflictCandidate(ctx = {}) {
  const { stalledReasonMatches, alreadyResolving, cycleCount = 0, classification } = ctx;
  if (!stalledReasonMatches && !alreadyResolving) {
    return { action: "skip", reason: "not-our-stall" };
  }
  if (cycleCount >= RESOLVE_CONFLICT_CYCLE_CAP) {
    return { action: "cap-exhausted", reason: "cycle-cap-exhausted" };
  }
  if (alreadyResolving) {
    return { action: "skip", reason: "already-resolving" };
  }
  if (!classification) {
    return { action: "skip", reason: "classification-unavailable" };
  }
  if (!classification.resolvable) {
    return { action: "skip", reason: "not-resolvable" };
  }
  return { action: "mark-and-dispatch", reason: "resolvable" };
}

// defaultCollectResolveConflictCandidates — read-only census over
// workers/<ticket>/phase-*.json, mirroring defaultCollectUnstuckCandidates'
// scope exactly (same dir layout, same per-candidate try/catch discipline).
// Matches BOTH the real producer's field (failureReason) and the documented-
// but-unused field (stalledReason) for RESOLVE_CONFLICT_STALL_REASON, plus
// RESOLVED_MARKER_REASON (an in-flight candidate this sweep already marked).
export function defaultCollectResolveConflictCandidates({
  orchDir,
  readdirSync: readdir = readdirSync,
  readFileSync: readFile = readFileSync,
  // resolveWorktreePath(ticket) → worktree path or null. Production wiring
  // (Task 12) injects the real resolver; the bare default is null (fail-closed
  // — classifyLiveConflict, Task 5, returns null for a null worktreePath, which
  // the classifier reads as "classification-unavailable" and retries next tick).
  resolveWorktreePath = () => null,
  base = "main",
} = {}) {
  const out = [];
  let workerDirs;
  try {
    workerDirs = readdir(join(orchDir, "workers"), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of workerDirs) {
    if (!d.isDirectory()) continue;
    const ticket = d.name;
    if (!isTicketKey(ticket)) continue;
    try {
      const workerDir = join(orchDir, "workers", ticket);
      let files;
      try {
        files = readdir(workerDir);
      } catch {
        continue;
      }
      for (const f of files) {
        const m = /^phase-(.+)\.json$/.exec(f);
        if (!m) continue;
        let raw;
        try {
          raw = JSON.parse(readFile(join(workerDir, f), "utf8"));
        } catch {
          continue;
        }
        if (raw?.status !== "stalled") continue;
        const reason = raw.failureReason ?? raw.stalledReason ?? null;
        if (reason !== RESOLVE_CONFLICT_STALL_REASON && reason !== RESOLVED_MARKER_REASON) continue;
        let worktreePath = null;
        try {
          worktreePath = resolveWorktreePath(ticket);
        } catch {
          worktreePath = null; // fail-closed — never let a throwing resolver drop the candidate
        }
        out.push({ ticket, phase: m[1], workerDir, worktreePath, base, raw });
      }
    } catch {
      // per-candidate failures degrade to "skip this ticket" — never abort the census.
      continue;
    }
  }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test plugins/dev/scripts/execution-core/resolve-conflict-sweep.test.mjs`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/dev/scripts/execution-core/resolve-conflict-sweep.mjs plugins/dev/scripts/execution-core/resolve-conflict-sweep.test.mjs
git commit -m "feat(dev): #1461 — resolve-conflict-sweep pure classifier + candidate census"
```

---

## Task 5: `resolve-conflict-sweep.mjs` — live classification (merge-tree) + brief write

**Files:**
- Modify: `plugins/dev/scripts/execution-core/resolve-conflict-sweep.mjs`
- Test: `plugins/dev/scripts/execution-core/resolve-conflict-sweep.test.mjs`

**Interfaces:**
- Consumes: `classifyMergeTree` (`./stale-pr-rescue.mjs`), `defaultMergeTree` (`./stale-pr-rescue-timer.mjs`).
- Produces: `classifyLiveConflict({worktreePath, base}, {mergeTree})` → `Promise<classification|null>`; `writeResolveConflictBrief(orchDir, ticket, brief)` (atomic tmp+rename, mirrors `writeRecoveryBrief` in `recovery-reasoning.mjs:1642-1648`).

- [ ] **Step 1: Write the failing tests**

Append to `resolve-conflict-sweep.test.mjs`:

```js
describe("classifyLiveConflict", () => {
  test("delegates to the injected mergeTree seam then classifyMergeTree", async () => {
    const mergeTree = async (wt, base, head) => {
      expect(wt).toBe("/wt/CTL-1");
      expect(base).toBe("main");
      expect(head).toBe("CTL-1");
      return { exitCode: 1, output: "CONFLICT (content): Merge conflict in a.ts" };
    };
    const result = await classifyLiveConflict({ worktreePath: "/wt/CTL-1", base: "main", head: "CTL-1" }, { mergeTree });
    expect(result).toEqual({ resolvable: true, conflictFiles: ["a.ts"], conflictTypes: ["content"] });
  });

  test("returns null when the mergeTree seam throws (probe failed this tick)", async () => {
    const mergeTree = async () => { throw new Error("fetch failed"); };
    const result = await classifyLiveConflict({ worktreePath: "/wt/CTL-1", base: "main", head: "CTL-1" }, { mergeTree });
    expect(result).toBeNull();
  });

  test("returns null when worktreePath is missing (never spawn git blind)", async () => {
    const result = await classifyLiveConflict({ worktreePath: null, base: "main", head: "CTL-1" }, { mergeTree: async () => ({ exitCode: 0, output: "" }) });
    expect(result).toBeNull();
  });
});

describe("writeResolveConflictBrief", () => {
  test("writes the v1 brief atomically and returns the path", () => {
    const writes = [];
    const renames = [];
    const deps = {
      mkdirSync: () => {},
      writeFileSync: (p, body) => writes.push([p, body]),
      renameSync: (from, to) => renames.push([from, to]),
    };
    const brief = { ticket: "CTL-1", stalledPhase: "implement", conflictFiles: ["a.ts"], conflictTypes: ["content"], attempt: 1, maxAttempts: 3 };
    const p = writeResolveConflictBrief("/orch", "CTL-1", brief, deps);
    expect(p).toBe("/orch/workers/CTL-1/resolve-conflict-brief.json");
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toMatch(/\.tmp\./);
    const written = JSON.parse(writes[0][1]);
    expect(written.schema).toBe("resolve-conflict-brief/v1");
    expect(written.ticket).toBe("CTL-1");
    expect(written.stalledPhase).toBe("implement");
    expect(renames).toEqual([[writes[0][0], p]]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test plugins/dev/scripts/execution-core/resolve-conflict-sweep.test.mjs -t "classifyLiveConflict|writeResolveConflictBrief"`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

Add to `resolve-conflict-sweep.mjs` (after the imports, add `mkdirSync, writeFileSync, renameSync` to the `node:fs` import and `dirname` to the `node:path` import; add the `classifyMergeTree`/`defaultMergeTree` imports):

```js
import { readdirSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { isTicketKey } from "./ticket-key.mjs";
import { classifyMergeTree } from "./stale-pr-rescue.mjs";
import { defaultMergeTree } from "./stale-pr-rescue-timer.mjs";
```

```js
// classifyLiveConflict — re-run git merge-tree against the LIVE worktree (never
// trust stale census evidence — mirrors sourceConflictActSeam's own re-check
// discipline in unstuck-act-seams.mjs) and classify with the existing,
// UNMODIFIED classifyMergeTree. Returns null (not a classification) on any
// probe failure or missing worktree — the caller's classifier then reads that
// as "classification-unavailable" and retries next tick; it never guesses.
export async function classifyLiveConflict({ worktreePath, base, head }, { mergeTree = defaultMergeTree } = {}) {
  if (!worktreePath) return null;
  try {
    const mt = await mergeTree(worktreePath, base, head);
    return classifyMergeTree(mt);
  } catch {
    return null;
  }
}

// writeResolveConflictBrief — atomic tmp+rename of resolve-conflict-brief.json,
// mirroring writeRecoveryBrief (recovery-reasoning.mjs). This is the
// phase-resolve-conflict skill's prior-phase artifact (Task 9 wires
// `signal:resolve-conflict-brief.json` into phase-artifact-gate.sh).
export function writeResolveConflictBrief(
  orchDir,
  ticket,
  brief,
  { mkdirSync: mkdir = mkdirSync, writeFileSync: writeFile = writeFileSync, renameSync: rename = renameSync } = {},
) {
  const p = join(orchDir, "workers", ticket, "resolve-conflict-brief.json");
  mkdir(dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}`;
  writeFile(tmp, JSON.stringify({ schema: "resolve-conflict-brief/v1", writtenAt: new Date().toISOString(), ...brief }, null, 2));
  rename(tmp, p);
  return p;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test plugins/dev/scripts/execution-core/resolve-conflict-sweep.test.mjs`
Expected: PASS, all tests (Task 4's + Task 5's).

- [ ] **Step 5: Commit**

```bash
git add plugins/dev/scripts/execution-core/resolve-conflict-sweep.mjs plugins/dev/scripts/execution-core/resolve-conflict-sweep.test.mjs
git commit -m "feat(dev): #1461 — live merge-tree classification + brief writer"
```

---

## Task 6: `resolve-conflict-sweep.mjs` — mark + dispatch action seam

**Files:**
- Modify: `plugins/dev/scripts/execution-core/resolve-conflict-sweep.mjs`
- Test: `plugins/dev/scripts/execution-core/resolve-conflict-sweep.test.mjs`

**Interfaces:**
- Consumes: `writeResolveConflictBrief` (Task 5), `dispatchTicket`/`isThenable`/`settleDispatchSync`/`backstopOnRejection`/`sdkSignalRunnable` from `./dispatch.mjs` (lazy-required, mirrors `defaultInvokeRecoveryPass` in `recovery-reasoning.mjs:1650-1828`).
- Produces: `defaultMarkAndDispatch({ticket, phase, workerDir, worktreePath, base, classification, cycleCount, orchDir}, deps)` → `{success, dispatched}`. `markStalledSignalResolving(signalPath, {readFileSync, writeFileSync, renameSync})` (the phase-<phase>.json rewrite, extracted so Task 6's test can assert it in isolation).

- [ ] **Step 1: Write the failing tests**

```js
describe("markStalledSignalResolving", () => {
  test("rewrites failureReason to RESOLVED_MARKER_REASON, preserves other fields", () => {
    const reads = { "/w/phase-implement.json": JSON.stringify({ status: "stalled", failureReason: "source_conflict_ctl708_unavailable", bg_job_id: "abc123" }) };
    const writes = [];
    const renames = [];
    markStalledSignalResolving("/w/phase-implement.json", {
      readFileSync: (p) => reads[p],
      writeFileSync: (p, body) => writes.push([p, body]),
      renameSync: (from, to) => renames.push([from, to]),
    });
    const written = JSON.parse(writes[0][1]);
    expect(written.status).toBe("stalled");
    expect(written.failureReason).toBe("source_conflict_resolvable");
    expect(written.bg_job_id).toBe("abc123"); // untouched
    expect(renames).toHaveLength(1);
  });
});

describe("defaultMarkAndDispatch", () => {
  function baseDeps(overrides = {}) {
    return {
      readFileSync: () => JSON.stringify({ status: "stalled", failureReason: "source_conflict_ctl708_unavailable" }),
      writeFileSync: () => {},
      renameSync: () => {},
      mkdirSync: () => {},
      dispatch: () => ({ code: 0, signal: { bg_job_id: "job-1" } }),
      isThenable: () => false,
      ...overrides,
    };
  }

  test("marks the signal, writes the brief, dispatches — returns success:true", () => {
    const dispatched = [];
    const deps = baseDeps({ dispatch: (orchDir, ticket, phase) => { dispatched.push([orchDir, ticket, phase]); return { code: 0 }; } });
    const result = defaultMarkAndDispatch(
      { ticket: "CTL-1", phase: "implement", workerDir: "/orch/workers/CTL-1", worktreePath: "/wt/CTL-1", base: "main", classification: { resolvable: true, conflictFiles: ["a.ts"], conflictTypes: ["content"] }, cycleCount: 0, orchDir: "/orch" },
      deps,
    );
    expect(result.success).toBe(true);
    expect(result.dispatched).toBe(true);
    expect(dispatched).toEqual([["/orch", "CTL-1", "resolve-conflict"]]);
  });

  test("returns success:false when dispatch reports a non-zero code", () => {
    const deps = baseDeps({ dispatch: () => ({ code: 1, stderr: "boom" }) });
    const result = defaultMarkAndDispatch(
      { ticket: "CTL-1", phase: "implement", workerDir: "/orch/workers/CTL-1", worktreePath: "/wt/CTL-1", base: "main", classification: { resolvable: true, conflictFiles: [], conflictTypes: [] }, cycleCount: 0, orchDir: "/orch" },
      deps,
    );
    expect(result.success).toBe(false);
    expect(result.dispatched).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test plugins/dev/scripts/execution-core/resolve-conflict-sweep.test.mjs -t "markStalledSignalResolving|defaultMarkAndDispatch"`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

Add `createRequire` to the imports (`import { createRequire } from "node:module";`) and:

```js
const _require = createRequire(import.meta.url);

// markStalledSignalResolving — atomic read-modify-write of the STALLED phase's
// own signal file: rewrite failureReason (or stalledReason, whichever is
// present) to RESOLVED_MARKER_REASON. Every other field (bg_job_id, status,
// etc.) is preserved untouched — read-modify-write, never a blind overwrite.
export function markStalledSignalResolving(
  signalPath,
  { readFileSync: readFile = readFileSync, writeFileSync: writeFile = writeFileSync, renameSync: rename = renameSync } = {},
) {
  const sig = JSON.parse(readFile(signalPath, "utf8"));
  if ("stalledReason" in sig) sig.stalledReason = RESOLVED_MARKER_REASON;
  else sig.failureReason = RESOLVED_MARKER_REASON;
  sig.updatedAt = new Date().toISOString();
  const tmp = `${signalPath}.tmp.${process.pid}`;
  writeFile(tmp, JSON.stringify(sig, null, 2));
  rename(tmp, signalPath);
}

// defaultMarkAndDispatch — the "mark-and-dispatch" action seam. Mirrors
// defaultInvokeRecoveryPass's dispatch section (recovery-reasoning.mjs:1650-
// 1828) exactly: lazy-require dispatch.mjs (avoids loading the dispatch graph
// on the off/shadow paths), settle an sdk-fleet Promise synchronously via
// isThenable/settleDispatchSync so the success check works identically for bg
// and sdk executors.
export function defaultMarkAndDispatch(
  { ticket, phase, workerDir, worktreePath, base, classification, cycleCount, orchDir },
  deps = {},
) {
  const signalPath = join(workerDir, `phase-${phase}.json`);
  markStalledSignalResolving(signalPath, deps);

  writeResolveConflictBrief(
    orchDir,
    ticket,
    {
      stalledPhase: phase,
      conflictFiles: classification.conflictFiles,
      conflictTypes: classification.conflictTypes,
      worktreePath,
      base,
      attempt: cycleCount + 1,
      maxAttempts: RESOLVE_CONFLICT_CYCLE_CAP,
    },
    deps,
  );

  let dispatchTicket, isThenable, settleDispatchSync;
  try {
    ({ dispatchTicket, isThenable, settleDispatchSync } = deps.dispatchMod ?? _require("./dispatch.mjs"));
  } catch (err) {
    return { success: false, dispatched: false, reason: `dispatch module load failed: ${err.message}` };
  }
  const dispatch = deps.dispatch ?? dispatchTicket;
  const thenableCheck = deps.isThenable ?? isThenable;

  let r;
  try {
    const rawR = dispatch(orchDir, ticket, "resolve-conflict");
    if (thenableCheck && thenableCheck(rawR)) {
      const settle = deps.settleDispatchSync ?? settleDispatchSync;
      r = settle(rawR, { verifySync: () => true });
    } else {
      r = rawR;
    }
  } catch (err) {
    return { success: false, dispatched: false, reason: `dispatch threw: ${err.message}` };
  }

  if (r && r.code === 0) {
    return { success: true, dispatched: true, bgJobId: r.signal?.bg_job_id ?? null };
  }
  return { success: false, dispatched: false, reason: r?.stderr ?? `dispatch failed (code ${r?.code ?? "unknown"})` };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test plugins/dev/scripts/execution-core/resolve-conflict-sweep.test.mjs`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/dev/scripts/execution-core/resolve-conflict-sweep.mjs plugins/dev/scripts/execution-core/resolve-conflict-sweep.test.mjs
git commit -m "feat(dev): #1461 — mark-and-dispatch action seam for resolve-conflict"
```

---

## Task 7: `resolve-conflict-sweep.mjs` — cap-exhaustion escalate seam

**Files:**
- Modify: `plugins/dev/scripts/execution-core/resolve-conflict-sweep.mjs`
- Test: `plugins/dev/scripts/execution-core/resolve-conflict-sweep.test.mjs`

**Interfaces:**
- Produces: `defaultEscalateCapExhausted({ticket, phase, workerDir, cycleCount}, deps)` → `boolean` (posted or not).

- [ ] **Step 1: Write the failing test**

```js
describe("defaultEscalateCapExhausted", () => {
  test("marks the signal cap-exhausted and posts the escalation comment", () => {
    const reads = { "/w/phase-implement.json": JSON.stringify({ status: "stalled", failureReason: "source_conflict_resolvable" }) };
    const writes = [];
    const posted = [];
    const deps = {
      readFileSync: (p) => reads[p],
      writeFileSync: (p, body) => writes.push([p, body]),
      renameSync: () => {},
      postComment: (ticket, body) => { posted.push([ticket, body]); return true; },
    };
    const ok = defaultEscalateCapExhausted({ ticket: "CTL-1", phase: "implement", workerDir: "/w", cycleCount: 3 }, deps);
    expect(ok).toBe(true);
    const written = JSON.parse(writes[0][1]);
    expect(written.failureReason).toBe("resolve-conflict-cycle-cap-exhausted");
    expect(posted).toHaveLength(1);
    expect(posted[0][0]).toBe("CTL-1");
    expect(posted[0][1]).toMatch(/^🔼 \*\*phase-resolve-conflict\*\* escalated/);
    expect(posted[0][1]).toMatch(/cycle cap \(3\)/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test plugins/dev/scripts/execution-core/resolve-conflict-sweep.test.mjs -t "defaultEscalateCapExhausted"`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

```js
import { spawnSync } from "node:child_process";

// defaultPostResolveConflictComment — thin wrapper over the shared
// linear-comment-post.sh helper, mirroring defaultRunCommentPost in
// unstuck-sweep.mjs. Best-effort: never throws.
function defaultPostResolveConflictComment(ticket, body) {
  const helperPath = join(process.env.PLUGIN_ROOT ?? process.cwd(), "scripts/lib/linear-comment-post.sh");
  const res = spawnSync(helperPath, [ticket, body], { encoding: "utf8", timeout: 10_000 });
  return !res.error && (res.status ?? 1) === 0;
}

// defaultEscalateCapExhausted — the cap-exhaustion escalate seam. Rewrites the
// stalled phase's signal to CAP_EXHAUSTED_REASON (a NEW, non-colliding reason —
// this is a normal `stalled` status, so the existing terminal-label sweep
// (scheduler.mjs) applies needs-human to it exactly like
// remediate-cycle-cap-exhausted already does; Task 10's exemption is scoped
// ONLY to RESOLVED_MARKER_REASON, never to this one). Posts the escalation
// comment mirroring recovery-emit.mjs's header convention VISUALLY (not wired
// into inbox-ask.mjs's parser — see this plan's Global Constraints).
export function defaultEscalateCapExhausted(
  { ticket, phase, workerDir, cycleCount },
  { readFileSync: readFile = readFileSync, writeFileSync: writeFile = writeFileSync, renameSync: rename = renameSync, postComment = defaultPostResolveConflictComment } = {},
) {
  const signalPath = join(workerDir, `phase-${phase}.json`);
  const sig = JSON.parse(readFile(signalPath, "utf8"));
  if ("stalledReason" in sig) sig.stalledReason = CAP_EXHAUSTED_REASON;
  else sig.failureReason = CAP_EXHAUSTED_REASON;
  sig.updatedAt = new Date().toISOString();
  const tmp = `${signalPath}.tmp.${process.pid}`;
  writeFile(tmp, JSON.stringify(sig, null, 2));
  rename(tmp, signalPath);

  const body = `🔼 **phase-resolve-conflict** escalated this to the operator — ${ticket}/${phase} hit the resolve-conflict cycle cap (${RESOLVE_CONFLICT_CYCLE_CAP}) after ${cycleCount} attempt(s) without a clean resolution; manual conflict resolution needed.`;
  return postComment(ticket, body);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test plugins/dev/scripts/execution-core/resolve-conflict-sweep.test.mjs`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/dev/scripts/execution-core/resolve-conflict-sweep.mjs plugins/dev/scripts/execution-core/resolve-conflict-sweep.test.mjs
git commit -m "feat(dev): #1461 — cap-exhaustion escalate seam"
```

---

## Task 8: `resolve-conflict-sweep.mjs` — stall-clear-on-complete + the action driver

**Files:**
- Modify: `plugins/dev/scripts/execution-core/resolve-conflict-sweep.mjs`
- Test: `plugins/dev/scripts/execution-core/resolve-conflict-sweep.test.mjs`

**Interfaces:**
- Consumes: `defaultClearStall(orchDir, writeStatus)` from `./scheduler.mjs` (unmodified import — this IS the existing J3 unstick primitive; reused as-is, not reimplemented).
- Produces: `defaultCollectResolveConflictCompletions({orchDir, readdirSync, readFileSync})` → `[{ticket, stalledPhase}]`; `runResolveConflictSweepPass({mode, collectCandidates, collectCompletions, classifyLive, classify, cycleCountOf, markAndDispatch, escalateCapExhausted, clearStall, emit})` → report object (the action driver, mirrors `runUnstuckSweepPass`'s shape).

- [ ] **Step 1: Write the failing tests**

```js
describe("defaultCollectResolveConflictCompletions", () => {
  function fakeFs({ workerDirs, files }) {
    return {
      readdirSync: (p, opts) => (opts?.withFileTypes ? (workerDirs[p] ?? []).map((n) => ({ name: n, isDirectory: () => true })) : (files[p] ?? [])),
      readFileSync: (p) => { if (!(p in files)) throw new Error(`ENOENT: ${p}`); return files[p]; },
    };
  }

  test("finds a ticket whose resolve-conflict phase is done and reads stalledPhase from the brief", () => {
    const fs = fakeFs({
      workerDirs: { "/orch/workers": ["CTL-1"] },
      files: {
        "/orch/workers/CTL-1": ["phase-resolve-conflict.json", "resolve-conflict-brief.json"],
        "/orch/workers/CTL-1/phase-resolve-conflict.json": JSON.stringify({ status: "done" }),
        "/orch/workers/CTL-1/resolve-conflict-brief.json": JSON.stringify({ stalledPhase: "implement" }),
      },
    });
    const out = defaultCollectResolveConflictCompletions({ orchDir: "/orch", ...fs });
    expect(out).toEqual([{ ticket: "CTL-1", stalledPhase: "implement" }]);
  });

  test("skips a ticket whose resolve-conflict phase is not done", () => {
    const fs = fakeFs({
      workerDirs: { "/orch/workers": ["CTL-2"] },
      files: {
        "/orch/workers/CTL-2": ["phase-resolve-conflict.json", "resolve-conflict-brief.json"],
        "/orch/workers/CTL-2/phase-resolve-conflict.json": JSON.stringify({ status: "running" }),
        "/orch/workers/CTL-2/resolve-conflict-brief.json": JSON.stringify({ stalledPhase: "verify" }),
      },
    });
    expect(defaultCollectResolveConflictCompletions({ orchDir: "/orch", ...fs })).toEqual([]);
  });

  test("skips a ticket with no resolve-conflict signal at all", () => {
    const fs = fakeFs({ workerDirs: { "/orch/workers": ["CTL-3"] }, files: { "/orch/workers/CTL-3": ["phase-implement.json"] } });
    expect(defaultCollectResolveConflictCompletions({ orchDir: "/orch", ...fs })).toEqual([]);
  });
});

describe("runResolveConflictSweepPass", () => {
  test("mode 'off' skips everything, no census called", () => {
    const collectCandidates = () => { throw new Error("must not be called"); };
    const report = runResolveConflictSweepPass({ mode: "off", collectCandidates });
    expect(report).toEqual({ marked: [], wouldMark: [], escalated: [], wouldEscalate: [], cleared: [], wouldClear: [], skipped: [], failed: [] });
  });

  test("shadow mode classifies and emits would-mark, takes no action", async () => {
    const emitted = [];
    const report = await runResolveConflictSweepPass({
      mode: "shadow",
      collectCandidates: () => [{ ticket: "CTL-1", phase: "implement", workerDir: "/w", raw: { failureReason: "source_conflict_ctl708_unavailable" }, worktreePath: "/wt", base: "main" }],
      collectCompletions: () => [],
      cycleCountOf: () => 0,
      classifyLive: async () => ({ resolvable: true, conflictFiles: [], conflictTypes: [] }),
      markAndDispatch: () => { throw new Error("must not be called in shadow"); },
      emit: (type) => emitted.push(type),
    });
    expect(report.wouldMark).toEqual([{ ticket: "CTL-1", phase: "implement" }]);
    expect(emitted).toContain("resolve-conflict.would.mark");
  });

  test("enforce mode marks + dispatches a resolvable candidate", async () => {
    const dispatched = [];
    const report = await runResolveConflictSweepPass({
      mode: "enforce",
      collectCandidates: () => [{ ticket: "CTL-1", phase: "implement", workerDir: "/w", raw: { failureReason: "source_conflict_ctl708_unavailable" }, worktreePath: "/wt", base: "main" }],
      collectCompletions: () => [],
      cycleCountOf: () => 0,
      classifyLive: async () => ({ resolvable: true, conflictFiles: ["a.ts"], conflictTypes: ["content"] }),
      markAndDispatch: (c) => { dispatched.push(c.ticket); return { success: true, dispatched: true }; },
      emit: async () => true,
    });
    expect(report.marked).toEqual([{ ticket: "CTL-1", phase: "implement" }]);
    expect(dispatched).toEqual(["CTL-1"]);
  });

  test("enforce mode escalates a cap-exhausted candidate", async () => {
    const escalated = [];
    const report = await runResolveConflictSweepPass({
      mode: "enforce",
      collectCandidates: () => [{ ticket: "CTL-1", phase: "implement", workerDir: "/w", raw: { failureReason: "source_conflict_resolvable" }, worktreePath: "/wt", base: "main" }],
      collectCompletions: () => [],
      cycleCountOf: () => 3,
      classifyLive: async () => ({ resolvable: true, conflictFiles: [], conflictTypes: [] }),
      escalateCapExhausted: (c) => { escalated.push(c.ticket); return true; },
      emit: async () => true,
    });
    expect(report.escalated).toEqual([{ ticket: "CTL-1", phase: "implement" }]);
    expect(escalated).toEqual(["CTL-1"]);
  });

  test("enforce mode clears a completion via the injected clearStall seam", async () => {
    const cleared = [];
    const report = await runResolveConflictSweepPass({
      mode: "enforce",
      collectCandidates: () => [],
      collectCompletions: () => [{ ticket: "CTL-1", stalledPhase: "implement" }],
      clearStall: (c) => { cleared.push(c); return true; },
      emit: async () => true,
    });
    expect(report.cleared).toEqual([{ ticket: "CTL-1", phase: "implement" }]);
    expect(cleared).toEqual([{ ticket: "CTL-1", phase: "implement" }]);
  });

  test("a throwing census degrades to an empty pass, never aborts", async () => {
    const report = await runResolveConflictSweepPass({
      mode: "enforce",
      collectCandidates: () => { throw new Error("census exploded"); },
      collectCompletions: () => [],
      emit: async () => true,
    });
    expect(report.marked).toEqual([]);
    expect(report.failed).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test plugins/dev/scripts/execution-core/resolve-conflict-sweep.test.mjs -t "defaultCollectResolveConflictCompletions|runResolveConflictSweepPass"`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

```js
// defaultCollectResolveConflictCompletions — find every ticket whose
// resolve-conflict phase signal is "done" and read which original phase to
// clear from resolve-conflict-brief.json's stalledPhase. Read-only.
export function defaultCollectResolveConflictCompletions({
  orchDir,
  readdirSync: readdir = readdirSync,
  readFileSync: readFile = readFileSync,
} = {}) {
  const out = [];
  let workerDirs;
  try {
    workerDirs = readdir(join(orchDir, "workers"), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of workerDirs) {
    if (!d.isDirectory()) continue;
    const ticket = d.name;
    if (!isTicketKey(ticket)) continue;
    try {
      const workerDir = join(orchDir, "workers", ticket);
      let sig;
      try {
        sig = JSON.parse(readFile(join(workerDir, "phase-resolve-conflict.json"), "utf8"));
      } catch {
        continue; // no resolve-conflict signal for this ticket
      }
      if (sig?.status !== "done") continue;
      let brief;
      try {
        brief = JSON.parse(readFile(join(workerDir, "resolve-conflict-brief.json"), "utf8"));
      } catch {
        continue; // done signal but no brief — cannot know which phase to clear
      }
      if (!brief?.stalledPhase) continue;
      out.push({ ticket, stalledPhase: brief.stalledPhase });
    } catch {
      continue;
    }
  }
  return out;
}

// runResolveConflictSweepPass — the action driver. Every side-effect seam is
// injected; mirrors runUnstuckSweepPass's off/shadow/enforce shape + report.
// Two independent sub-passes per tick: (1) candidates → classify → mark-and-
// dispatch or cap-exhausted-escalate; (2) completions → clearStall. Order is
// completions-then-candidates so a just-completed ticket's stall is cleared
// before that same tick's candidate scan would otherwise re-see it (defensive;
// either order is safe since a cleared ticket has no more stalled signal).
export async function runResolveConflictSweepPass({
  mode = "off",
  collectCandidates = () => [],
  collectCompletions = () => [],
  classifyLive = async () => null,
  cycleCountOf = () => 0,
  markAndDispatch = () => ({ success: false, dispatched: false }),
  escalateCapExhausted = () => false,
  clearStall = () => false,
  emit = async () => true,
} = {}) {
  const report = { marked: [], wouldMark: [], escalated: [], wouldEscalate: [], cleared: [], wouldClear: [], skipped: [], failed: [] };
  if (mode === "off") return report;
  const enforce = mode === "enforce";

  const fire = (type, fields, ticket) => {
    try {
      const p = emit(type, fields);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {
      /* best-effort */
    }
  };

  // ---- completions: clear the stall for a finished resolve-conflict run ----
  let completions = [];
  try {
    completions = collectCompletions() ?? [];
  } catch {
    completions = [];
  }
  for (const c of completions) {
    try {
      if (!enforce) {
        fire("resolve-conflict.would.clear", { ticket: c.ticket, phase: c.stalledPhase }, c.ticket);
        report.wouldClear.push({ ticket: c.ticket, phase: c.stalledPhase });
        continue;
      }
      const ok = clearStall({ ticket: c.ticket, phase: c.stalledPhase });
      if (ok === false) {
        report.failed.push({ ticket: c.ticket, phase: c.stalledPhase, reason: "clearStall-returned-false" });
        continue;
      }
      fire("resolve-conflict.cleared", { ticket: c.ticket, phase: c.stalledPhase }, c.ticket);
      report.cleared.push({ ticket: c.ticket, phase: c.stalledPhase });
    } catch (err) {
      report.failed.push({ ticket: c?.ticket, phase: c?.stalledPhase, reason: err?.message });
    }
  }

  // ---- candidates: classify then mark-and-dispatch / cap-exhausted ----
  let candidates = [];
  try {
    candidates = collectCandidates() ?? [];
  } catch {
    return report; // a throwing census degrades to "nothing to do" this tick
  }
  for (const c of candidates) {
    try {
      const reason = c.raw?.failureReason ?? c.raw?.stalledReason ?? null;
      const stalledReasonMatches = reason === RESOLVE_CONFLICT_STALL_REASON;
      const alreadyResolving = reason === RESOLVED_MARKER_REASON;
      const cycleCount = cycleCountOf(c.ticket);
      // Only probe merge-tree for a reason this sweep actually owns — never
      // spawn git for a not-our-stall candidate (classifier would skip it anyway).
      const classification =
        stalledReasonMatches && cycleCount < RESOLVE_CONFLICT_CYCLE_CAP
          ? await classifyLive({ worktreePath: c.worktreePath, base: c.base, head: c.ticket })
          : null;
      const decision = classifyResolveConflictCandidate({ stalledReasonMatches, alreadyResolving, cycleCount, classification });

      if (decision.action === "skip") {
        report.skipped.push({ ticket: c.ticket, phase: c.phase, reason: decision.reason });
        continue;
      }

      if (decision.action === "cap-exhausted") {
        if (!enforce) {
          fire("resolve-conflict.would.escalate", { ticket: c.ticket, phase: c.phase }, c.ticket);
          report.wouldEscalate.push({ ticket: c.ticket, phase: c.phase });
          continue;
        }
        const posted = escalateCapExhausted({ ticket: c.ticket, phase: c.phase, workerDir: c.workerDir, cycleCount });
        fire("resolve-conflict.escalated", { ticket: c.ticket, phase: c.phase, posted }, c.ticket);
        report.escalated.push({ ticket: c.ticket, phase: c.phase });
        continue;
      }

      // mark-and-dispatch
      if (!enforce) {
        fire("resolve-conflict.would.mark", { ticket: c.ticket, phase: c.phase }, c.ticket);
        report.wouldMark.push({ ticket: c.ticket, phase: c.phase });
        continue;
      }
      const result = markAndDispatch({
        ticket: c.ticket,
        phase: c.phase,
        workerDir: c.workerDir,
        worktreePath: c.worktreePath,
        base: c.base,
        classification,
        cycleCount,
      });
      if (!result?.success) {
        report.failed.push({ ticket: c.ticket, phase: c.phase, reason: result?.reason ?? "mark-and-dispatch-failed" });
        continue;
      }
      fire("resolve-conflict.marked.resolvable", { ticket: c.ticket, phase: c.phase }, c.ticket);
      if (result.dispatched) fire("resolve-conflict.dispatched", { ticket: c.ticket, phase: c.phase }, c.ticket);
      report.marked.push({ ticket: c.ticket, phase: c.phase });
    } catch (err) {
      report.failed.push({ ticket: c?.ticket, phase: c?.phase, reason: err?.message });
    }
  }

  return report;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test plugins/dev/scripts/execution-core/resolve-conflict-sweep.test.mjs`
Expected: PASS, all tests in the file (Tasks 4–8 combined).

- [ ] **Step 5: Commit**

```bash
git add plugins/dev/scripts/execution-core/resolve-conflict-sweep.mjs plugins/dev/scripts/execution-core/resolve-conflict-sweep.test.mjs
git commit -m "feat(dev): #1461 — resolve-conflict-sweep action driver (mark/escalate/clear)"
```

---

## Task 9: `lib/phase-artifact-gate.sh` — prior-artifact gate for the new phase

**Files:**
- Modify: `plugins/dev/scripts/lib/phase-artifact-gate.sh`
- Test: `plugins/dev/scripts/lib/__tests__/phase-artifact-gate.test.sh` (create if it does not already exist — check first with `ls plugins/dev/scripts/lib/__tests__/ | grep phase-artifact-gate`; if it exists, add to it instead of creating a duplicate)

**Interfaces:**
- Produces: `prior_artifact_for_phase resolve-conflict` → `"signal:resolve-conflict-brief.json"`.

- [ ] **Step 1: Write the failing test**

If `plugins/dev/scripts/lib/__tests__/phase-artifact-gate.test.sh` exists, add this case to its existing test list; otherwise create it following the sibling `.test.sh` files' harness convention (source the script, assert stdout). Minimal case either way:

```bash
test_resolve_conflict_prior_artifact() {
  source "${SCRIPT_DIR}/../phase-artifact-gate.sh"
  local result
  result="$(prior_artifact_for_phase resolve-conflict)"
  if [[ "$result" != "signal:resolve-conflict-brief.json" ]]; then
    echo "FAIL: prior_artifact_for_phase resolve-conflict = '${result}', expected 'signal:resolve-conflict-brief.json'"
    return 1
  fi
  echo "PASS: prior_artifact_for_phase resolve-conflict"
}
test_resolve_conflict_prior_artifact
```

- [ ] **Step 2: Run to verify it fails**

Run: `bash plugins/dev/scripts/lib/__tests__/phase-artifact-gate.test.sh`
Expected: FAIL (empty string returned, falls to the `*) echo "" ;;` default case).

- [ ] **Step 3: Implement**

In `plugins/dev/scripts/lib/phase-artifact-gate.sh`, add a case directly after the existing `recovery-pass)` entry:

```bash
	# #1461: resolve-conflict's brief is resolve-conflict-brief.json — the
	# classification + which-phase-stalled envelope resolve-conflict-sweep.mjs
	# writes before dispatch (the analogue of recovery-pass.json for recovery-pass,
	# verify.json for remediate). The skill reads it as its prior-phase artifact.
	resolve-conflict) echo "signal:resolve-conflict-brief.json" ;;
```

- [ ] **Step 4: Run to verify it passes**

Run: `bash plugins/dev/scripts/lib/__tests__/phase-artifact-gate.test.sh`
Expected: PASS, plus every pre-existing case in that file still passes.

- [ ] **Step 5: Commit**

```bash
git add plugins/dev/scripts/lib/phase-artifact-gate.sh plugins/dev/scripts/lib/__tests__/phase-artifact-gate.test.sh
git commit -m "feat(dev): #1461 — prior-artifact gate for phase-resolve-conflict"
```

---

## Task 10: `unstuck-sweep.mjs` — STALL_CATEGORY_MAP entries + the collector field-name bugfix

**Files:**
- Modify: `plugins/dev/scripts/execution-core/unstuck-sweep.mjs`
- Test: `plugins/dev/scripts/execution-core/unstuck-sweep.test.mjs`

**Interfaces:** none new — targeted edits to existing exports (`STALL_CATEGORY_MAP`, `defaultCollectUnstuckCandidates`).

- [ ] **Step 1: Write the failing tests**

Add to `unstuck-sweep.test.mjs`'s existing `describe("STALL_CATEGORY_MAP", ...)` or `describe("classifyStalledTicket", ...)` block (whichever exists — check the file first; add a new `describe` block if neither matches):

```js
describe("STALL_CATEGORY_MAP — #1461 additions", () => {
  test("source_conflict_resolvable routes to skip (resolve-conflict-sweep already owns it)", () => {
    expect(classifyStalledTicket({ reason: "source_conflict_resolvable" })).toEqual({ category: "skip", action: "skip" });
  });

  test("resolve-conflict-cycle-cap-exhausted routes to escalate", () => {
    expect(classifyStalledTicket({ reason: "resolve-conflict-cycle-cap-exhausted" })).toEqual({ category: "resolve-conflict-cap", action: "escalate" });
  });
});

describe("defaultCollectUnstuckCandidates — #1461 field-name bugfix", () => {
  test("finds source_conflict_ctl708_unavailable via failureReason (the real producer field), not just stalledReason", () => {
    const readdirSync = (p, opts) => {
      if (p.endsWith("/workers")) return [{ name: "CTL-1", isDirectory: () => true }];
      return [{ name: "phase-implement.json", isDirectory: () => false }];
    };
    const readFileSync = () => JSON.stringify({ status: "stalled", failureReason: "source_conflict_ctl708_unavailable" });
    const out = defaultCollectUnstuckCandidates({ orchDir: "/orch", readdirSync, readFileSync });
    expect(out).toHaveLength(1);
    expect(out[0].evidence.reason).toBe("source_conflict_ctl708_unavailable");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test plugins/dev/scripts/execution-core/unstuck-sweep.test.mjs -t "source_conflict_resolvable|resolve-conflict-cycle-cap-exhausted|failureReason"`
Expected: FAIL — the map entries don't exist yet; the field-name test fails because `defaultCollectUnstuckCandidates` currently only checks `signal.stalledReason`, never `signal.failureReason`, for a `status:"stalled"` signal (confirmed bug — see Global Constraints).

- [ ] **Step 3: Implement**

Add two entries to `STALL_CATEGORY_MAP` (directly after the existing `"boot-resume-gate-expired"` entry):

```js
  // #1461: resolve-conflict-sweep already owns a ticket once it marks
  // source_conflict_resolvable — the unstuck sweep must stay quiet, not
  // force-push over a ticket the dedicated sweep is actively resolving.
  "source_conflict_resolvable":       { category: "skip",              action: "skip" },
  // #1461: mirrors remediate-cycle-cap-exhausted's own entry shape — a
  // typed category label for telemetry rather than falling to 'unknown'.
  "resolve-conflict-cycle-cap-exhausted": { category: "resolve-conflict-cap", action: "escalate" },
```

Fix the field-name bug in `defaultCollectUnstuckCandidates` (the `if (signal.status === "stalled" && signal.stalledReason)` branch, around line 154):

```js
        // Accept both status shapes (CTL-1064 §Confirmed gaps), PLUS the real
        // producer field for a dispatch-time-rebase stall (#1461 finding:
        // phase-agent-dispatch writes status:"stalled" + .failureReason, NOT
        // .stalledReason, for source_conflict_ctl708_unavailable — this
        // category's force-push-if-clean action has never fired in production
        // without this fix).
        let reason = null;
        if (signal.status === "stalled" && (signal.stalledReason || signal.failureReason)) {
          reason = signal.stalledReason ?? signal.failureReason;
        } else if (signal.status === "failed" && signal.failureReason === "orphan-sweep-stale") {
          reason = "orphan-sweep-stale";
        } else {
          continue;
        }
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test plugins/dev/scripts/execution-core/unstuck-sweep.test.mjs`
Expected: PASS, all tests including the new ones — and confirm no pre-existing test in this file asserted the OLD (buggy) behavior of ignoring `failureReason` for a stalled signal (skim the diff; if one did, it was asserting the bug and should be updated, not preserved).

- [ ] **Step 5: Commit**

```bash
git add plugins/dev/scripts/execution-core/unstuck-sweep.mjs plugins/dev/scripts/execution-core/unstuck-sweep.test.mjs
git commit -m "fix(dev): unstuck-sweep source-conflict category never matched failureReason (#1461)

STALL_CATEGORY_MAP also gains two #1461 entries: source_conflict_resolvable
(skip — resolve-conflict-sweep owns it) and resolve-conflict-cycle-cap-exhausted
(escalate)."
```

---

## Task 11: `scheduler.mjs` — terminal-label-sweep exemption for an in-flight resolve

**Files:**
- Modify: `plugins/dev/scripts/execution-core/scheduler.mjs`
- Test: `plugins/dev/scripts/execution-core/scheduler.test.mjs`

**Interfaces:** none new — a targeted conditional added inside the existing terminal-Done + label sweep (~line 6931-961, the non-terminal stalled/failed branch that calls `labelNeedsHumanUnlessBeliefOwner`).

- [ ] **Step 1: Write the failing test**

Find `scheduler.test.mjs`'s existing test(s) for the terminal-label sweep (search for `labelNeedsHumanUnlessBeliefOwner` or `"needs-human"` in a `describe` block covering `schedulerTick`) and add:

```js
test("#1461: does not apply needs-human while resolve-conflict-sweep is actively resolving a ticket", async () => {
  // Set up a worker dir whose active signal carries failureReason:
  // source_conflict_resolvable (the marker resolve-conflict-sweep writes while
  // dispatch is in flight) and assert labelNeedsHumanUnlessBeliefOwner (or the
  // writeStatus.applyLabel seam it calls) is never invoked for this ticket.
  // Follow this file's existing fixture-building convention for a stalled
  // ticket test (locate the nearest sibling test asserting needs-human IS
  // applied for an ordinary stalled reason, and mirror its worker-dir/signal
  // setup exactly, swapping the reason string).
});
```

(This step intentionally references "the nearest sibling test" rather than inlining fixture-construction code: `scheduler.test.mjs` is a very large file (see Task 0's baseline) with its own established fixture-builder helpers for this exact sweep — copy the real helper names from the sibling test you find, don't invent new ones.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun test plugins/dev/scripts/execution-core/scheduler.test.mjs -t "1461"`
Expected: FAIL — needs-human is currently applied unconditionally for any `status:"stalled"` signal, regardless of reason.

- [ ] **Step 3: Implement**

In the non-terminal branch (the `else` at what was read as line 6931, inside `if (fenceGuard(...))`), guard the label write on the reason:

```js
        } else {
          // #1461: exempt a ticket resolve-conflict-sweep is actively resolving
          // (failureReason/stalledReason === source_conflict_resolvable) from
          // immediate needs-human labeling — otherwise every candidate is
          // flagged needs-human the same tick the fix is already in flight. A
          // cap-exhausted stall (resolve-conflict-cycle-cap-exhausted) is a
          // NORMAL stalled reason and is NOT exempted — it surfaces exactly
          // like remediate-cycle-cap-exhausted already does.
          const activeSignal = signalByTicket.get(ticket);
          const activeReason = activeSignal?.raw?.failureReason ?? activeSignal?.raw?.stalledReason ?? null;
          if (activeReason === "source_conflict_resolvable") {
            emitOrphanDetectedOnce(orchDir, ticket, signals, appendOrphanDetectedEvent);
            continue;
          }
          // Non-terminal stalled/failed ticket → apply the belief-aware needs-human
          // label (CTL-1241: skipped when the belief engine owns the reclaim).
          if (fenceGuard({ ticket, orchDir, multiHost, gateway, self })) {
```

Note: `continue` here is inside a `for (const ticket of _listStartedTickets(orchDir))` loop (confirmed from the read context) — verify this is syntactically a direct loop body (it is, per the read at line ~6803) before landing this edit; if a nested function boundary sits between, use an early-return pattern instead of `continue` and adjust the diff accordingly during implementation.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test plugins/dev/scripts/execution-core/scheduler.test.mjs -t "1461"`
Expected: PASS. Then run the FULL file (this is also covered by Task 12's A/B check, but confirm no immediate regression before moving on):

Run: `bun test plugins/dev/scripts/execution-core/scheduler.test.mjs 2>&1 | tail -5`
Expected: pass/fail counts match Task 0's baseline plus exactly the new test(s) added here — no other deltas.

- [ ] **Step 5: Commit**

```bash
git add plugins/dev/scripts/execution-core/scheduler.mjs plugins/dev/scripts/execution-core/scheduler.test.mjs
git commit -m "feat(dev): #1461 — exempt an in-flight resolve-conflict from needs-human labeling"
```

---

## Task 12: `scheduler.mjs` — wire resolve-conflict-sweep into the tick loop + A/B comparison

**Files:**
- Modify: `plugins/dev/scripts/execution-core/scheduler.mjs`
- Test: `plugins/dev/scripts/execution-core/scheduler.test.mjs`

**Interfaces:**
- Consumes: `readResolveConflictSweepConfig` (Task 2), `runResolveConflictSweepPass`, `defaultCollectResolveConflictCandidates`, `defaultCollectResolveConflictCompletions`, `classifyLiveConflict`, `defaultMarkAndDispatch`, `defaultEscalateCapExhausted` (Tasks 4–8), `countResolveConflictCycles` (Task 1), `defaultClearStall` (existing, `scheduler.mjs:3235`).

- [ ] **Step 1: Write the failing test**

Add a test mirroring the existing stall-janitor/unstuck-sweep wiring tests in `scheduler.test.mjs` (search for `"scheduler: stall-janitor pass"` or a test that injects `_collectUnstuckCandidates` into `schedulerTick`'s options to find the exact injection-point convention this file uses):

```js
test("#1461: resolve-conflict-sweep runs every tick when mode is not off, uses the injected collectors", async () => {
  let called = false;
  await schedulerTick(orchDir, {
    // ... same base options the sibling unstuck-sweep wiring test uses ...
    _resolveConflictMode: "shadow",
    _collectResolveConflictCandidates: () => { called = true; return []; },
    _collectResolveConflictCompletions: () => [],
  });
  expect(called).toBe(true);
});

test("#1461: resolve-conflict-sweep is skipped entirely when mode is off", async () => {
  let called = false;
  await schedulerTick(orchDir, {
    _resolveConflictMode: "off",
    _collectResolveConflictCandidates: () => { called = true; return []; },
  });
  expect(called).toBe(false);
});
```

(Match this file's actual `schedulerTick` option-injection naming convention exactly — the sibling unstuck-sweep test's injected option names, found in Step 1's search, are the ground truth; adjust the `_resolveConflict*` names above only if they clash with an existing convention.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun test plugins/dev/scripts/execution-core/scheduler.test.mjs -t "1461"`
Expected: FAIL — no wiring exists yet.

- [ ] **Step 3: Implement**

Add the imports (near the existing `stall-janitor.mjs`/`unstuck-sweep.mjs` imports at the top of `scheduler.mjs`):

```js
import {
  runResolveConflictSweepPass,
  defaultCollectResolveConflictCandidates,
  defaultCollectResolveConflictCompletions,
  classifyLiveConflict,
  defaultMarkAndDispatch,
  defaultEscalateCapExhausted,
} from "./resolve-conflict-sweep.mjs";
import { readResolveConflictSweepConfig } from "./config.mjs"; // add to the existing config.mjs import
import { countResolveConflictCycles } from "./event-scan.mjs"; // add to the existing event-scan.mjs import
```

Add the wiring block directly after the unstuck-sweep block (after its `tick?.lap("unstuck-sweep")`, mirroring its shape — every tick, no throttle, per the confirmed design decision):

```js
  // #1461: resolve-conflict-sweep — every tick (no throttle: candidates are
  // rare and the classify step only spawns git for a candidate this sweep
  // actually owns). Mode='off' by default (ADR-023/ADR-028); operators opt in
  // via CATALYST_RESOLVE_CONFLICT_SWEEP=shadow then =enforce.
  {
    const rcMode = _resolveConflictMode ?? readResolveConflictSweepConfig().mode;
    if (rcMode !== "off" && (_collectResolveConflictCandidates || _collectResolveConflictCompletions)) {
      try {
        const rcReport = await runResolveConflictSweepPass({
          mode: rcMode,
          collectCandidates: _collectResolveConflictCandidates ?? (() => defaultCollectResolveConflictCandidates({ orchDir })),
          collectCompletions: _collectResolveConflictCompletions ?? (() => defaultCollectResolveConflictCompletions({ orchDir })),
          classifyLive: _resolveConflictClassifyLive ?? classifyLiveConflict,
          cycleCountOf: _resolveConflictCycleCountOf ?? ((ticket) => countResolveConflictCycles({ ticket })),
          markAndDispatch: _resolveConflictMarkAndDispatch ?? ((c) => defaultMarkAndDispatch({ ...c, orchDir })),
          escalateCapExhausted: _resolveConflictEscalate ?? defaultEscalateCapExhausted,
          clearStall: _resolveConflictClearStall ?? defaultClearStall(orchDir, writeStatus),
          emit: _resolveConflictEmit,
        });
        if (rcReport.marked.length || rcReport.escalated.length || rcReport.cleared.length || rcReport.wouldMark.length || rcReport.wouldEscalate.length || rcReport.wouldClear.length) {
          log.info(
            { mode: rcMode, marked: rcReport.marked.length, escalated: rcReport.escalated.length, cleared: rcReport.cleared.length },
            "scheduler: resolve-conflict-sweep pass (#1461)",
          );
        }
      } catch (err) {
        log.warn({ step: "resolve-conflict-sweep", err: err.message }, "scheduler: resolve-conflict-sweep pass failed — continuing tick (#1461)");
      }
    }
  }

  tick?.lap("resolve-conflict-sweep");
```

Add the corresponding destructured options (`_resolveConflictMode`, `_collectResolveConflictCandidates`, `_collectResolveConflictCompletions`, `_resolveConflictClassifyLive`, `_resolveConflictCycleCountOf`, `_resolveConflictMarkAndDispatch`, `_resolveConflictEscalate`, `_resolveConflictClearStall`, `_resolveConflictEmit`) to `schedulerTick`'s options-destructuring signature, alongside the existing `_unstuckMode` / `_collectUnstuckCandidates` / etc. entries — match their exact destructuring style (found in Step 1's search).

- [ ] **Step 4: Run to verify it passes**

Run: `bun test plugins/dev/scripts/execution-core/scheduler.test.mjs -t "1461"`
Expected: PASS.

- [ ] **Step 5: The A/B comparison (do not skip — this is the safety check for touching shared scheduler.mjs)**

```bash
cd ~/code-repos/github/coalesce-labs/catalyst
git status --short   # confirm only the expected files are modified
git stash push -u -m "pre-#1461 A/B baseline"
bun test plugins/dev/scripts/execution-core/scheduler.test.mjs 2>&1 | tail -5   # must match Task 0's recorded baseline exactly
git stash pop
bun test plugins/dev/scripts/execution-core/scheduler.test.mjs 2>&1 | tail -5   # compare
```

Confirm: the post-change run has exactly (Task 0's baseline pass count + every new test added across Tasks 10–12) passing, and the SAME fail count as the baseline (0 new failures). If the fail count differs, stop and investigate before proceeding — do not paper over a new failure by editing an unrelated pre-existing-failing test.

- [ ] **Step 6: Commit**

```bash
git add plugins/dev/scripts/execution-core/scheduler.mjs plugins/dev/scripts/execution-core/scheduler.test.mjs
git commit -m "feat(dev): #1461 — wire resolve-conflict-sweep into the scheduler tick loop"
```

---

## Task 13: `phase-resolve-conflict/SKILL.md` — the new phase-agent skill

**Files:**
- Create: `plugins/dev/skills/phase-resolve-conflict/SKILL.md`

**Interfaces:** none (Markdown skill file, not unit-testable) — validated by manual review checklist below.

- [ ] **Step 1: Author the skill, cloned from phase-remediate/SKILL.md's envelope**

Copy `plugins/dev/skills/phase-remediate/SKILL.md` to `plugins/dev/skills/phase-resolve-conflict/SKILL.md` as a starting point, then make these specific changes (do not leave any `remediate`-specific text unedited — walk every section):

1. **Frontmatter**: `name: phase-resolve-conflict`; description rewritten to describe this skill (reads `resolve-conflict-brief.json`, rebases additively per its conflictFiles/conflictTypes, commits, emits `phase.resolve-conflict.complete.<ticket>`; dispatched by `resolve-conflict-sweep.mjs` via the standard `phase-agent-dispatch` envelope, cap 3 via `RESOLVE_CONFLICT_CYCLE_CAP`). Keep `user-invocable: true`, `disable-model-invocation: false`, `allowed-tools: [Bash, Read, Grep, Glob, Edit, Write, Task]` (same as phase-remediate — this skill also commits code).
2. **Prelude**: change `PHASE`/artifact references from `verify.json` to `resolve-conflict-brief.json`; drop the CTL-484 continuation-handoff block (resolve-conflict is a short, bounded rebase — no observed need for continuation handoff; if this proves wrong in practice, add it later, matching the template's own "not automatic" philosophy). Replace the "Remediate-specific brief read" step (reads `verify.json`) with:

```bash
BRIEF="${ORCH_DIR}/workers/${TICKET}/resolve-conflict-brief.json"
[[ -f "$BRIEF" ]] || { echo "phase-resolve-conflict: resolve-conflict-brief.json missing for ${TICKET}" >&2; exit 1; }
STALLED_PHASE="$(jq -r '.stalledPhase' "$BRIEF")"
BASE_REF="$(jq -r '.base' "$BRIEF")"
CONFLICT_FILES="$(jq -r '.conflictFiles[]?' "$BRIEF")"
CONFLICT_TYPES="$(jq -r '.conflictTypes[]?' "$BRIEF")"
echo "phase-resolve-conflict: ${TICKET} stalled on ${STALLED_PHASE}; base=${BASE_REF}"
echo "phase-resolve-conflict: conflict files: ${CONFLICT_FILES}"
echo "phase-resolve-conflict: conflict types: ${CONFLICT_TYPES}"
```

3. **`/goal` condition**:

```
/goal "I have rebased this branch onto ${BASE_REF} (origin/main), resolved the
       conflicts in the files resolve-conflict-brief.json named additively
       (preserving both sides' intent — a content conflict keeps both edits
       where they don't logically collide; an add/add conflict keeps both
       files, renaming if the same path was independently added), run a
       targeted gate (tsc/test/lint) on the touched files showing exit 0, and
       committed so `git diff <base>..HEAD` includes the resolution. The
       resolve-conflict-sweep clears the original stall once it sees
       phase.resolve-conflict.complete — I do NOT redispatch the stalled phase
       myself. (Linear status is written by the coordinator, not this agent.)"
```

4. **Phase-specific work**: replace the "Triage the findings" / fix-work section with:

```
1. Fetch and rebase: `git fetch origin ${BASE_REF}` then `git rebase origin/${BASE_REF}`.
2. On each conflict, resolve ADDITIVELY per the conflict type resolve-conflict-brief.json
   named: for a `content` conflict, read both sides and merge them so neither
   ticket's change is silently dropped (this is bounded — the brief's
   classifyMergeTree gate already confirmed only `content`/`add/add` types and a
   file count within the cap; if a conflict marker is found that ISN'T one of
   these types, STOP and emit `failed` — see Failure handling, do not attempt an
   unbounded resolution). For `add/add`, keep both files; rename one if the same
   logical path was independently created for two different purposes.
3. `git rebase --continue` after each resolution; repeat until the rebase completes.
4. Run the targeted gate (tsc/test/lint scoped to the resolved files, e.g. via
   `/catalyst-dev:validate-type-safety` scoped to the diff) and print its `exit 0`.
5. The rebase itself IS the "commit" here (no separate fix-commit like remediate —
   the resolution lands as part of the rebased history). Force-push is NOT this
   skill's job — the redispatched phase (after the sweep clears the stall) will
   push normally as part of its own work.
```

5. **End block**: keep the Linear-mirror block and the empty-branch self-emit gate verbatim from phase-remediate (rename `phase-remediate-mirror`/`phase-remediate-empty-branch-gate` fence names to `phase-resolve-conflict-mirror`/`phase-resolve-conflict-empty-branch-gate`; update the mirror body's header from `**Phase Remediate**` to `**Phase Resolve-Conflict**` and drop the `regression_risk` line (not applicable — replace with `**Resolved conflict in**: <conflictFiles list>`). Terminal emit is unchanged (`--status complete`, no `--reason`).
6. **Failure handling**: keep the same `authorization`-type escalation shape as phase-remediate, but change the `--problem`/`--risk` text to describe an unbounded/unexpected conflict (e.g. a conflict type outside `{content, add/add}` slipping through, or the rebase hitting a THIRD conflict wave mid-resolution) rather than remediate's regression-risk framing.
7. **Drop** the closing "Why remediate is a phase, not a `verify` branch" section (remediate-specific) and replace with a short "Why this sweep, not a `deriveAdvancement` detour" section pointing at ADR-028 in `docs/adrs.md` instead of the CTL-653 plan doc.

- [ ] **Step 2: Manual review checklist (no automated test — SKILL.md is Markdown)**

Check against `_phase-agent-template/SKILL.md`'s `## Contract` (6 points) one by one:
1. Joins `orch-${ORCH_ID}` comms channel at entry — present?
2. Reads the prior-phase artifact (`resolve-conflict-brief.json`, gated by Task 9's `phase-artifact-gate.sh` entry) — present, and does the skill abort loudly if missing?
3. Starts a `catalyst-session` — present?
4. Does the phase-specific work — present (Step 1.4 above)?
5. Terminal emit via `phase-agent-emit-complete` — present, both success and failure paths?
6. Linear reads prefer the local sqlite replica — N/A (this skill doesn't do a single-ticket Linear read; note this explicitly rather than silently omitting the section).

Confirm the frontmatter's `name:` field exactly matches the skill directory name (`phase-resolve-conflict`) — `phase-agent-dispatch`'s `skill_for_phase()` default convention (`phase-$1` for phase name `resolve-conflict`) resolves to `/catalyst-dev:phase-resolve-conflict`, so a mismatch here would silently break dispatch (confirmed in Task 9's research: no special-case needed in `skill_for_phase()` itself).

- [ ] **Step 3: Commit**

```bash
git add plugins/dev/skills/phase-resolve-conflict/SKILL.md
git commit -m "feat(dev): #1461 — phase-resolve-conflict skill"
```

---

## Task 14: `docs/architecture.md` — update the conflict-handling section

**Files:**
- Modify: `docs/architecture.md` (lines ~171-173, the "L3 — Phase-aware fallback" bullet)

- [ ] **Step 1: Update the L3 bullet**

Current text (line 171-173):

```
- **L3 — Phase-aware fallback** (`phase-agent-dispatch`): terminal source conflict (rc=2) on
  `research`/`plan` → destroy+recreate worktree fresh; same on `implement`/`verify`/`review` → park
  `needs-human`; thoughts conflict (rc=3) → park on all phases.
```

Replace with:

```
- **L3 — Phase-aware fallback** (`phase-agent-dispatch`): terminal source conflict (rc=2) on
  `research`/`plan` → destroy+recreate worktree fresh; same on `implement`/`verify`/`review` → park
  `stalled`/`source_conflict_ctl708_unavailable` (see below, no longer a dead end); thoughts conflict
  (rc=3) → park on all phases.
- **`resolve-conflict-sweep` (#1461, ADR-028)** — a tick-loop sweep (`execution-core/resolve-conflict-
  sweep.mjs`, off/shadow/enforce, default off) that scans DIRECTLY for `source_conflict_ctl708_unavailable`
  stalls (bypassing the in-flight gate `deriveAdvancement` uses, since a stalled ticket is excluded from
  it), classifies resolvability live via the existing `classifyMergeTree` (`stale-pr-rescue.mjs`), and
  dispatches `phase-resolve-conflict` (cloned from `phase-remediate`'s envelope) through the standard
  `dispatch.mjs → phase-agent-dispatch` path for a RESOLVABLE conflict — capped at
  `RESOLVE_CONFLICT_CYCLE_CAP` (default 3, env `CATALYST_RESOLVE_CONFLICT_CYCLE_CAP`), escalating to
  `needs-human` past the cap exactly like the verify⇄remediate cycle already does. An UNRESOLVABLE
  conflict is left for the existing needs-human surfacing, unchanged.
```

- [ ] **Step 2: Commit**

```bash
git add docs/architecture.md
git commit -m "docs(architecture): #1461 — document resolve-conflict-sweep in the conflict-handling section"
```

---

## Task 15: Final verification pass

**Files:** none — verification only.

- [ ] **Step 1: Run every touched test file once more, together**

```bash
cd ~/code-repos/github/coalesce-labs/catalyst
bun test \
  plugins/dev/scripts/execution-core/event-scan.test.mjs \
  plugins/dev/scripts/execution-core/config.test.mjs \
  plugins/dev/scripts/execution-core/resolve-conflict-sweep-event-types.test.mjs \
  plugins/dev/scripts/execution-core/resolve-conflict-sweep.test.mjs \
  plugins/dev/scripts/execution-core/unstuck-sweep.test.mjs \
  plugins/dev/scripts/execution-core/scheduler.test.mjs \
  2>&1 | tail -20
bash plugins/dev/scripts/lib/__tests__/phase-artifact-gate.test.sh
```

Expected: every new test passes; `scheduler.test.mjs` and `unstuck-sweep.test.mjs` show 0 new failures versus Task 0's / Task 12's recorded baselines.

- [ ] **Step 2: Scrub for private-repo references**

```bash
git log --oneline origin/main..HEAD   # review every commit subject on this branch
git diff origin/main..HEAD -- . | grep -inE "hagaletechnologies|thagale/(?!catalyst)|internal[_-]?ticket|coalesce-labs/(?!catalyst)" || echo "clean"
```

Confirm every commit subject and every added line contains only public `#<number>` GitHub references and public `CTL-`/`CATALYST_`-prefixed identifiers — no private org/repo names, no internal-only ticket systems.

- [ ] **Step 3: Review the full diff once**

```bash
git diff origin/main..HEAD --stat
git status --short
```

Confirm the file list matches exactly what this plan touched (Tasks 1–14's Files sections) — nothing stray staged, nothing left uncommitted.
