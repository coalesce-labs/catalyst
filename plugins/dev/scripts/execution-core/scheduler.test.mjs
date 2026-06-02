// Unit + filesystem-fixture tests for the pull-loop scheduler (CTL-536).
// Run: cd plugins/dev/scripts/execution-core && bun test scheduler.test.mjs
//
// Phase 3 adds the selection-core blocks; Phases 4-5 extend this same file.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readPhaseSignals,
  isTicketInFlight,
  listInFlightTickets,
  readMaxParallel,
  readExecutionCoreConcurrency,
  readExecutionCoreConcurrencyLayer2,
  mergeExecutionCoreConcurrency,
  DEFAULT_MAX_PARALLEL,
  computeFreeSlots,
  predecessorPhaseOf,
  resolveReapPredecessor,
  computeReadyTickets,
  selectDispatchable,
  selectDispatchablePerProject,
  validatePerProjectBudgets,
  buildPerProjectGauge,
  deriveAdvancement,
  maybeResetForRemediateCycle,
  maybeEscalateRemediateExhausted,
  listStartedTickets,
  schedulerTick,
  readAllEligibleTickets,
  hydrateOutOfSetBlockers,
  startScheduler,
  stopScheduler,
  preflightWorkspaceLabels,
  inDispatchCooldown,
  recordDispatchFailure,
  clearDispatchCooldown,
  dispatchCooldownPath,
  escalateDispatchExhausted,
  verifyDispatchedSignal,
  gcDispatchCooldowns,
  maybeEscalateDispatchFailures,
  __resetForTests,
  // CTL-705: Phase 2 helpers
  STAGE_RANK,
  stageRankForTicket,
  readWorkerPriority,
  writeWorkerPriority,
  buildGlobalRanking,
} from "./scheduler.mjs";
import { createTicketStateCache } from "./linear-cache.mjs";
import { REMEDIATE_CYCLE_CAP } from "../lib/phase-fsm.mjs";

let orchDir;
let catalystDir;
let prevCatalystDir;
beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "sched-"));
  // Redirect CATALYST_DIR so getEventLogPath() resolves under a fixture —
  // the same redirect monitor.test.mjs uses.
  prevCatalystDir = process.env.CATALYST_DIR;
  catalystDir = mkdtempSync(join(tmpdir(), "sched-cat-"));
  process.env.CATALYST_DIR = catalystDir;
});
afterEach(() => {
  rmSync(orchDir, { recursive: true, force: true });
  if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
  else process.env.CATALYST_DIR = prevCatalystDir;
  rmSync(catalystDir, { recursive: true, force: true });
});

function writeSignal(ticket, phase, status) {
  const dir = join(orchDir, "workers", ticket);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `phase-${phase}.json`), JSON.stringify({ ticket, phase, status }));
}

// writeSignalRaw — writes phase-<phase>.json with arbitrary raw fields (e.g.
// bg_job_id, worktreePath) that the existing writeSignal helper omits.
function writeSignalRaw(ticket, phase, obj) {
  const dir = join(orchDir, "workers", ticket);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `phase-${phase}.json`), JSON.stringify(obj));
}

// readEventLog — reads the current UTC YYYY-MM.jsonl under catalystDir/events/
// and returns parsed event objects. Returns [] on missing/empty log.
function readEventLog() {
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const logPath = join(catalystDir, "events", `${ym}.jsonl`);
  try {
    return readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// appendToEventLog — mkdirSync <CATALYST_DIR>/events/ and append to the
// current UTC YYYY-MM.jsonl (the path getEventLogPath() resolves).
function appendToEventLog(line) {
  const dir = join(catalystDir, "events");
  mkdirSync(dir, { recursive: true });
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  appendFileSync(join(dir, `${ym}.jsonl`), line);
}

// eligibleDir / writeEligibleProjection — getEligibleDir() resolves to
// <CATALYST_DIR>/execution-core/eligible (config.mjs); write a per-project
// projection there so readAllEligibleTickets() reads a fixture. `raw` writes
// arbitrary file content (used for the malformed-JSON case).
const eligibleDir = () => join(catalystDir, "execution-core", "eligible");
function writeEligibleProjection(projectKey, body, { raw = false } = {}) {
  mkdirSync(eligibleDir(), { recursive: true });
  writeFileSync(join(eligibleDir(), `${projectKey}.json`), raw ? body : JSON.stringify(body));
}

// waitFor — poll `predicate` every `intervalMs` until it returns truthy, or
// throw after `timeoutMs`. Replaces fixed-duration sleeps in the daemon tests:
// fs.watch / timer delivery latency is variable (macOS FSEvents spikes well past
// a fixed sleep, and can drop an event that lands before the watch finishes
// registering), so a fixed sleep races the watcher and flakes. A bounded poll is
// deterministic — it returns as soon as the condition holds and only fails if it
// genuinely never does. `onTick` runs once per poll, so a test can re-trigger a
// droppable event each iteration instead of relying on a single delivery.
async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 25, onTick } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    onTick?.();
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  if (!predicate()) {
    throw new Error(`waitFor: predicate not satisfied within ${timeoutMs}ms`);
  }
}

describe("readPhaseSignals", () => {
  test("returns a phase→status map for a worker dir", () => {
    writeSignal("CTL-1", "triage", "done");
    writeSignal("CTL-1", "research", "running");
    expect(readPhaseSignals(orchDir, "CTL-1")).toEqual({
      triage: "done",
      research: "running",
    });
  });
  test("returns {} when the worker dir does not exist", () => {
    expect(readPhaseSignals(orchDir, "CTL-404")).toEqual({});
  });

  test("ignores phase-*-yield-*.json files (CTL-702)", () => {
    const dir = join(orchDir, "workers", "CTL-702");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "phase-plan.json"), JSON.stringify({ status: "done" }));
    writeFileSync(join(dir, "phase-plan-yield-20260528T050740Z.json"), JSON.stringify({}));
    const signals = readPhaseSignals(orchDir, "CTL-702");
    expect(Object.keys(signals)).toEqual(["plan"]);
    expect(signals.plan).toBe("done");
  });
});

describe("isTicketInFlight", () => {
  test("a non-terminal signal means in-flight", () => {
    expect(isTicketInFlight({ triage: "done", research: "running" })).toBe(true);
  });
  test("plan done + no later signal (advance window) is still in-flight", () => {
    expect(isTicketInFlight({ triage: "done", research: "done", plan: "done" })).toBe(true);
  });
  test("monitor-deploy done is terminal success → NOT in-flight", () => {
    expect(isTicketInFlight({ "monitor-deploy": "done" })).toBe(false);
  });
  test("monitor-deploy skipped is terminal success → NOT in-flight (CTL-512)", () => {
    expect(isTicketInFlight({ "monitor-deploy": "skipped" })).toBe(false);
  });
  test("monitor-deploy skipped with earlier phases done → NOT in-flight (CTL-512)", () => {
    expect(
      isTicketInFlight({
        triage: "done",
        research: "done",
        plan: "done",
        implement: "done",
        verify: "done",
        review: "done",
        pr: "done",
        "monitor-merge": "done",
        "monitor-deploy": "skipped",
      })
    ).toBe(false);
  });
  test("non-terminal phase with status=skipped (defensive) → still in-flight (CTL-512)", () => {
    // skipped is only a recognized terminal for monitor-deploy. Treating it as
    // terminal on any other phase would silently free slots on producer bugs.
    expect(isTicketInFlight({ triage: "skipped" })).toBe(true);
  });
  test("a failed or stalled signal is terminal → NOT in-flight", () => {
    expect(isTicketInFlight({ implement: "failed" })).toBe(false);
    expect(isTicketInFlight({ verify: "stalled" })).toBe(false);
  });
  test("an 'aborted' signal frees the slot (CTL-565 kill-on-drag-out)", () => {
    expect(isTicketInFlight({ research: "done", implement: "aborted" })).toBe(false);
  });
  test("no signals at all → NOT in-flight", () => {
    expect(isTicketInFlight({})).toBe(false);
  });
});

describe("listInFlightTickets / readMaxParallel / computeFreeSlots", () => {
  test("counts only in-flight worker dirs", () => {
    writeSignal("CTL-1", "implement", "running");
    writeSignal("CTL-2", "monitor-deploy", "done");
    writeSignal("CTL-3", "triage", "failed");
    expect([...listInFlightTickets(orchDir)]).toEqual(["CTL-1"]);
  });
  test("readMaxParallel reads state.json, defaults to 1", () => {
    expect(readMaxParallel(orchDir)).toBe(1);
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 3 }));
    expect(readMaxParallel(orchDir)).toBe(3);
  });
  test("computeFreeSlots never goes negative", () => {
    expect(computeFreeSlots(3, 1)).toBe(2);
    expect(computeFreeSlots(3, 5)).toBe(0);
  });
});

// CTL-665 Phase 1 — the committed-config reader + readMaxParallel config-first
// precedence + clamp. Mirrors the readOrphanReaperConfig reader contract.
describe("readExecutionCoreConcurrency (CTL-665)", () => {
  function writeConfig(obj) {
    const p = join(orchDir, "config.json");
    writeFileSync(p, JSON.stringify(obj));
    return p;
  }
  test("returns {} for a null/empty configPath", () => {
    expect(readExecutionCoreConcurrency(null)).toEqual({});
    expect(readExecutionCoreConcurrency("")).toEqual({});
  });
  test("returns {} for an absent file (ENOENT silent — no throw)", () => {
    expect(readExecutionCoreConcurrency(join(orchDir, "nope.json"))).toEqual({});
  });
  test("returns {} for unparseable JSON (no throw)", () => {
    const p = join(orchDir, "bad.json");
    writeFileSync(p, "{ not json");
    expect(readExecutionCoreConcurrency(p)).toEqual({});
  });
  test("returns the catalyst.orchestration.executionCore object", () => {
    const p = writeConfig({
      catalyst: {
        orchestration: {
          executionCore: {
            maxParallel: 4,
            minParallel: 1,
            maxParallelCeiling: 10,
            eligibleQuery: { status: "Ready" },
          },
        },
      },
    });
    expect(readExecutionCoreConcurrency(p)).toEqual({
      maxParallel: 4,
      minParallel: 1,
      maxParallelCeiling: 10,
      eligibleQuery: { status: "Ready" },
    });
  });
  test("returns {} when the key is absent", () => {
    const p = writeConfig({ catalyst: { orchestration: {} } });
    expect(readExecutionCoreConcurrency(p)).toEqual({});
  });
});

// CTL-678 — Layer-2 reader (machine-canonical override) mirrors the Layer-1
// reader's failure semantics: ENOENT silent, unparseable JSON silent, absent
// key → {}.
describe("readExecutionCoreConcurrencyLayer2 (CTL-678)", () => {
  function writeLayer2(obj) {
    const p = join(orchDir, "layer2.json");
    writeFileSync(p, JSON.stringify(obj));
    return p;
  }
  test("returns {} for a null/empty layer2Path", () => {
    expect(readExecutionCoreConcurrencyLayer2(null)).toEqual({});
    expect(readExecutionCoreConcurrencyLayer2("")).toEqual({});
  });
  test("returns {} for an absent file (ENOENT silent — no throw)", () => {
    expect(readExecutionCoreConcurrencyLayer2(join(orchDir, "nope.json"))).toEqual({});
  });
  test("returns {} for unparseable JSON (no throw)", () => {
    const p = join(orchDir, "bad-layer2.json");
    writeFileSync(p, "{ not json");
    expect(readExecutionCoreConcurrencyLayer2(p)).toEqual({});
  });
  test("returns the catalyst.orchestration.executionCore object", () => {
    const p = writeLayer2({
      catalyst: {
        orchestration: {
          executionCore: { maxParallel: 6 },
        },
      },
    });
    expect(readExecutionCoreConcurrencyLayer2(p)).toEqual({ maxParallel: 6 });
  });
  test("returns {} when the file exists but lacks catalyst.orchestration.executionCore", () => {
    const p = writeLayer2({ catalyst: { orchestration: {} } });
    expect(readExecutionCoreConcurrencyLayer2(p)).toEqual({});
  });
});

// CTL-678 — per-field pre-merge of Layer-1 (committed seed) + Layer-2
// (machine-canonical override). Layer-2 wins per VALID INTEGER field; absent
// or invalid Layer-2 fields fall back to Layer-1. eligibleQuery and any other
// non-concurrency key on Layer-1 passes through unchanged.
describe("mergeExecutionCoreConcurrency (CTL-678)", () => {
  test("both empty → {}", () => {
    expect(mergeExecutionCoreConcurrency({}, {})).toEqual({});
    expect(mergeExecutionCoreConcurrency()).toEqual({});
  });
  test("Layer-1 only → Layer-1 verbatim", () => {
    const l1 = { maxParallel: 4, minParallel: 1, maxParallelCeiling: 10 };
    expect(mergeExecutionCoreConcurrency(l1, {})).toEqual(l1);
  });
  test("Layer-2 only → Layer-2 verbatim", () => {
    const l2 = { maxParallel: 6, minParallel: 2, maxParallelCeiling: 20 };
    expect(mergeExecutionCoreConcurrency({}, l2)).toEqual(l2);
  });
  test("Layer-2 partial override: only maxParallel set in Layer-2", () => {
    const l1 = { maxParallel: 4, minParallel: 1, maxParallelCeiling: 10 };
    const l2 = { maxParallel: 6 };
    expect(mergeExecutionCoreConcurrency(l1, l2)).toEqual({
      maxParallel: 6,
      minParallel: 1,
      maxParallelCeiling: 10,
    });
  });
  test("per-field override: Layer-2 wins independently per field", () => {
    const l1 = { maxParallel: 4, minParallel: 1, maxParallelCeiling: 10 };
    const l2 = { maxParallel: 6, maxParallelCeiling: 20 };
    expect(mergeExecutionCoreConcurrency(l1, l2)).toEqual({
      maxParallel: 6,
      minParallel: 1,
      maxParallelCeiling: 20,
    });
  });
  test("invalid type in Layer-2 does NOT block Layer-1 fallback", () => {
    const l1 = { maxParallel: 4 };
    const l2 = { maxParallel: "six" };
    expect(mergeExecutionCoreConcurrency(l1, l2)).toEqual({ maxParallel: 4 });
  });
  test("non-positive integer in Layer-2 falls back to Layer-1", () => {
    expect(
      mergeExecutionCoreConcurrency({ maxParallel: 4 }, { maxParallel: 0 }),
    ).toEqual({ maxParallel: 4 });
    expect(
      mergeExecutionCoreConcurrency({ maxParallel: 4 }, { maxParallel: -1 }),
    ).toEqual({ maxParallel: 4 });
  });
  test("eligibleQuery on Layer-1 passes through unchanged", () => {
    const l1 = {
      maxParallel: 4,
      minParallel: 1,
      maxParallelCeiling: 10,
      eligibleQuery: { status: "Ready" },
    };
    const l2 = { maxParallel: 6 };
    expect(mergeExecutionCoreConcurrency(l1, l2)).toEqual({
      maxParallel: 6,
      minParallel: 1,
      maxParallelCeiling: 10,
      eligibleQuery: { status: "Ready" },
    });
  });
});

describe("mergeExecutionCoreConcurrency — perProject (CTL-706)", () => {
  test("layer-1-only perProject passes through", () => {
    const l1 = { maxParallel: 6, perProject: { CTL: { maxParallel: 3, reserve: 1 } } };
    expect(mergeExecutionCoreConcurrency(l1, {})).toMatchObject({
      perProject: { CTL: { maxParallel: 3, reserve: 1 } },
    });
  });
  test("layer-2 adds a new project key", () => {
    const l1 = { maxParallel: 6, perProject: { CTL: { maxParallel: 3, reserve: 1 } } };
    const l2 = { perProject: { ADV: { maxParallel: 4, reserve: 2 } } };
    const result = mergeExecutionCoreConcurrency(l1, l2);
    expect(result.perProject.CTL).toMatchObject({ maxParallel: 3, reserve: 1 });
    expect(result.perProject.ADV).toMatchObject({ maxParallel: 4, reserve: 2 });
  });
  test("layer-2 sub-field override wins per field, other fields preserved", () => {
    const l1 = { maxParallel: 6, perProject: { CTL: { maxParallel: 3, reserve: 1 } } };
    const l2 = { perProject: { CTL: { reserve: 2 } } };
    expect(mergeExecutionCoreConcurrency(l1, l2).perProject.CTL).toMatchObject({
      maxParallel: 3,
      reserve: 2,
    });
  });
  test("invalid layer-2 sub-field (non-positive / non-int) is ignored", () => {
    const l1 = { maxParallel: 6, perProject: { CTL: { maxParallel: 3, reserve: 1 } } };
    const l2 = { perProject: { CTL: { maxParallel: 0, reserve: -1 } } };
    expect(mergeExecutionCoreConcurrency(l1, l2).perProject.CTL).toMatchObject({
      maxParallel: 3,
      reserve: 1,
    });
  });
  test("scalar-only merge with no perProject is unchanged (regression)", () => {
    expect(mergeExecutionCoreConcurrency({ maxParallel: 4 }, { maxParallel: 6 })).toEqual({
      maxParallel: 6,
    });
  });
});

describe("validatePerProjectBudgets (CTL-706)", () => {
  test("absent perProject → unchanged", () => {
    expect(validatePerProjectBudgets({ maxParallel: 6 })).toEqual({ maxParallel: 6 });
  });
  test("sum(reserve) ≤ maxParallel → reserves untouched", () => {
    const c = { maxParallel: 6, perProject: { ADV: { reserve: 2 }, CTL: { reserve: 1 } } };
    const out = validatePerProjectBudgets(c);
    expect(out.perProject.ADV.reserve).toBe(2);
    expect(out.perProject.CTL.reserve).toBe(1);
  });
  test("sum(reserve) > maxParallel → reserves clamped so sum ≤ maxParallel", () => {
    const c = { maxParallel: 3, perProject: { ADV: { reserve: 3 }, CTL: { reserve: 2 } } };
    const out = validatePerProjectBudgets(c).perProject;
    const sum = (out.ADV.reserve ?? 0) + (out.CTL.reserve ?? 0);
    expect(sum).toBeLessThanOrEqual(3);
    expect(out.ADV.reserve ?? 0).toBeGreaterThanOrEqual(0);
  });
  test("never throws on garbage entries", () => {
    expect(() =>
      validatePerProjectBudgets({ maxParallel: 6, perProject: { X: { reserve: "nope" } } }),
    ).not.toThrow();
  });
});

describe("selectDispatchablePerProject — equivalence (CTL-706)", () => {
  const tk = (id) => ({
    identifier: id,
    priority: 1,
    createdAt: "x",
    state: "Todo",
    relations: { nodes: [] },
    inverseRelations: { nodes: [] },
  });
  const ids = (sel) => sel.map((t) => t.identifier);

  test("empty perProject behaves exactly like selectDispatchable", () => {
    const ranked = [tk("CTL-1"), tk("CTL-2"), tk("CTL-3")];
    expect(ids(selectDispatchablePerProject(ranked, new Set(["CTL-2"]), 2, {}))).toEqual([
      "CTL-1",
      "CTL-3",
    ]);
  });
  test("freeSlots 0 → []", () => {
    expect(
      selectDispatchablePerProject([tk("CTL-1")], new Set(), 0, {
        perProject: { CTL: { maxParallel: 2 } },
      }),
    ).toEqual([]);
  });
});

describe("selectDispatchablePerProject — cap saturation (CTL-706)", () => {
  const tk = (id) => ({
    identifier: id,
    priority: 1,
    createdAt: "x",
    state: "Todo",
    relations: { nodes: [] },
    inverseRelations: { nodes: [] },
  });
  const ids = (sel) => sel.map((t) => t.identifier);

  test("project at cap is skipped; next non-saturated project picked", () => {
    const ranked = [tk("ADV-1"), tk("ADV-2"), tk("CTL-1")];
    const sel = selectDispatchablePerProject(ranked, new Set(), 2, {
      perProject: { ADV: { maxParallel: 1, reserve: 0 }, CTL: { maxParallel: 3, reserve: 0 } },
      inFlight: new Set(),
    });
    expect(ids(sel)).toEqual(["ADV-1", "CTL-1"]);
  });
  test("in-flight count counts toward the cap", () => {
    const ranked = [tk("ADV-2"), tk("CTL-1")];
    const sel = selectDispatchablePerProject(ranked, new Set(), 2, {
      perProject: { ADV: { maxParallel: 1 }, CTL: { maxParallel: 3 } },
      inFlight: new Set(["ADV-9"]),
    });
    expect(ids(sel)).toEqual(["CTL-1"]);
  });
});

describe("selectDispatchablePerProject — reserve enforcement (CTL-706)", () => {
  const tk = (id) => ({
    identifier: id,
    priority: 1,
    createdAt: "x",
    state: "Todo",
    relations: { nodes: [] },
    inverseRelations: { nodes: [] },
  });
  const ids = (sel) => sel.map((t) => t.identifier);

  test("last shared slot withheld so another project can reach its reserve", () => {
    const ranked = [tk("ADV-1"), tk("CTL-1")];
    const sel = selectDispatchablePerProject(ranked, new Set(), 1, {
      perProject: { ADV: { reserve: 0 }, CTL: { reserve: 1 } },
      inFlight: new Set(),
    });
    expect(ids(sel)).toEqual(["CTL-1"]);
  });
  test("reserve does NOT bite when the reserved project has no waiting work", () => {
    const ranked = [tk("ADV-1"), tk("ADV-2")];
    const sel = selectDispatchablePerProject(ranked, new Set(), 1, {
      perProject: { ADV: { reserve: 0 }, CTL: { reserve: 1 } },
      inFlight: new Set(),
    });
    expect(ids(sel)).toEqual(["ADV-1"]);
  });
  test("a project filling its OWN reserve is never blocked by the reserve guard", () => {
    const ranked = [tk("CTL-1"), tk("CTL-2")];
    const sel = selectDispatchablePerProject(ranked, new Set(), 2, {
      perProject: { CTL: { reserve: 2 } },
      inFlight: new Set(),
    });
    expect(ids(sel)).toEqual(["CTL-1", "CTL-2"]);
  });
});

describe("readMaxParallel precedence + clamp (CTL-665)", () => {
  test("config wins over state.json", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    expect(readMaxParallel(orchDir, { maxParallel: 4 })).toBe(4);
  });
  test("state.json fallback when config silent", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    expect(readMaxParallel(orchDir, {})).toBe(2);
  });
  test("hardcoded fallback constant when both silent", () => {
    expect(readMaxParallel(orchDir, {})).toBe(DEFAULT_MAX_PARALLEL);
  });
  test("clamp to ceiling", () => {
    expect(
      readMaxParallel(orchDir, { maxParallel: 50, minParallel: 1, maxParallelCeiling: 10 }),
    ).toBe(10);
  });
  test("clamp to floor — a resolved value below minParallel is raised", () => {
    // state.json resolves to 1; config carries only the bounds (no maxParallel),
    // so the resolved 1 is clamped up to minParallel: 2.
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    expect(readMaxParallel(orchDir, { minParallel: 2, maxParallelCeiling: 10 })).toBe(2);
  });
  test("no clamp when bounds absent", () => {
    expect(readMaxParallel(orchDir, { maxParallel: 50 })).toBe(50);
  });
  test("backward compatibility — one-arg call unchanged (default 1, state.json 3)", () => {
    expect(readMaxParallel(orchDir)).toBe(1);
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 3 }));
    expect(readMaxParallel(orchDir)).toBe(3);
  });
});

describe("computeReadyTickets", () => {
  const tk = (id, priority, createdAt, relations) => ({
    identifier: id,
    priority,
    createdAt,
    state: "Todo",
    relations: relations ?? { nodes: [] },
    inverseRelations: { nodes: [] },
  });

  test("returns ranked ready tickets, excluding blocked ones", () => {
    // CTL-2 blocks CTL-1 → CTL-1 blocked; CTL-2 and CTL-3 ready. Distinct
    // priorities (CTL-2 Urgent=1, CTL-3 High=2) make the ranked order exact.
    const eligible = [
      tk("CTL-1", 3, "x", {
        nodes: [{ type: "blocked_by", relatedIssue: { identifier: "CTL-2" } }],
      }),
      tk("CTL-2", 1, "x"),
      tk("CTL-3", 2, "x"),
    ];
    const ready = computeReadyTickets(eligible);
    expect(ready.map((t) => t.identifier)).toEqual(["CTL-2", "CTL-3"]);
  });
  test("with no relations every eligible ticket is ready, priority-ranked", () => {
    const ready = computeReadyTickets([tk("CTL-9", 4, "x"), tk("CTL-8", 1, "x")]);
    expect(ready.map((t) => t.identifier)).toEqual(["CTL-8", "CTL-9"]);
  });
  test("empty eligible set → empty ready set", () => {
    expect(computeReadyTickets([])).toEqual([]);
  });
  test("a blocker outside the eligible set does not block (finished/non-Todo)", () => {
    // The eligible set is all-Todo; a finished (Done/Canceled) or otherwise
    // non-Todo blocker is simply absent from it. buildDependencyEdges drops
    // any edge with an out-of-set endpoint, so CTL-1's blocked_by edge to the
    // absent CTL-99 is dropped and CTL-1 is ready.
    const ready = computeReadyTickets([
      tk("CTL-1", 2, "x", {
        nodes: [{ type: "blocked_by", relatedIssue: { identifier: "CTL-99" } }],
      }),
    ]);
    expect(ready.map((t) => t.identifier)).toEqual(["CTL-1"]);
  });
  test("a mutual dependency cycle leaves both tickets blocked — no crash", () => {
    // CTL-A blocked_by CTL-B and CTL-B blocked_by CTL-A. The scheduler must
    // tolerate the cycle: both partition as blocked, neither is dispatched.
    const ready = computeReadyTickets([
      tk("CTL-A", 1, "x", {
        nodes: [{ type: "blocked_by", relatedIssue: { identifier: "CTL-B" } }],
      }),
      tk("CTL-B", 1, "x", {
        nodes: [{ type: "blocked_by", relatedIssue: { identifier: "CTL-A" } }],
      }),
    ]);
    expect(ready).toEqual([]);
  });
});

describe("selectDispatchable", () => {
  const tk = (id) => ({ identifier: id });
  test("takes the top freeSlots ready tickets not already in-flight", () => {
    const ranked = [tk("A"), tk("B"), tk("C"), tk("D")];
    const sel = selectDispatchable(ranked, new Set(["B"]), 2);
    expect(sel.map((t) => t.identifier)).toEqual(["A", "C"]);
  });
  test("freeSlots 0 → selects nothing", () => {
    expect(selectDispatchable([tk("A")], new Set(), 0)).toEqual([]);
  });
  test("caps the selection at freeSlots when more tickets are ready", () => {
    const ranked = [tk("A"), tk("B"), tk("C")];
    expect(selectDispatchable(ranked, new Set(), 1).map((t) => t.identifier)).toEqual(["A"]);
  });
});

// ── Phase 4: dispatch and FSM-driven phase advancement ──

// A dispatch stub: records every call, returns a configurable exit code.
function fakeDispatch({ code = 0 } = {}) {
  const calls = [];
  const fn = (args) => {
    calls.push(args);
    return { code, stdout: "", stderr: "" };
  };
  fn.calls = calls;
  return fn;
}

// CTL-611: verifier-pass stub. The default verifyDispatchedSignal reads the
// signal file and is `false` for tests that don't write one — pass this to
// schedulerTick to opt out of demotion for non-CTL-611 tests.
const verifyOk = () => ({ ok: true });

// ── CTL-624: per-(ticket,phase) dispatch cool-down helpers ──
describe("dispatch cool-down helpers", () => {
  test("no marker → not in cool-down", () => {
    expect(inDispatchCooldown(orchDir, "CTL-1", "research", 1_000)).toBe(false);
  });

  test("recordDispatchFailure writes a timestamped marker", () => {
    recordDispatchFailure(orchDir, "CTL-1", "research", 2, 5_000);
    const p = dispatchCooldownPath(orchDir, "CTL-1", "research");
    expect(existsSync(p)).toBe(true);
    const m = JSON.parse(readFileSync(p, "utf8"));
    expect(m).toMatchObject({ phase: "research", code: 2, failedAt: 5_000 });
  });

  test("within the window → in cool-down; past the window → not", () => {
    // code=1 (transient) → 60s window (CTL-713: code=2 uses 30 min permanent window).
    recordDispatchFailure(orchDir, "CTL-1", "research", 1, 5_000);
    // 30 s later (< 60 s window) → still cooling down.
    expect(inDispatchCooldown(orchDir, "CTL-1", "research", 35_000)).toBe(true);
    // 61 s later (> 60 s window) → window elapsed.
    expect(inDispatchCooldown(orchDir, "CTL-1", "research", 66_000)).toBe(false);
  });

  test("cool-down is per-(ticket,phase)", () => {
    recordDispatchFailure(orchDir, "CTL-1", "research", 2, 5_000);
    expect(inDispatchCooldown(orchDir, "CTL-1", "plan", 6_000)).toBe(false);
    expect(inDispatchCooldown(orchDir, "CTL-2", "research", 6_000)).toBe(false);
  });

  test("clearDispatchCooldown removes the marker (idempotent if absent)", () => {
    recordDispatchFailure(orchDir, "CTL-1", "research", 2, 5_000);
    clearDispatchCooldown(orchDir, "CTL-1", "research");
    expect(existsSync(dispatchCooldownPath(orchDir, "CTL-1", "research"))).toBe(false);
    expect(() => clearDispatchCooldown(orchDir, "CTL-1", "research")).not.toThrow();
  });

  test("a malformed marker is treated as absent (not in cool-down)", () => {
    // recordDispatchFailure creates the cool-down dir + a valid marker; then
    // corrupt the file in place so the path stays decoupled from its location.
    recordDispatchFailure(orchDir, "CTL-1", "research", 2, 5_000);
    writeFileSync(dispatchCooldownPath(orchDir, "CTL-1", "research"), "not json");
    expect(inDispatchCooldown(orchDir, "CTL-1", "research", 6_000)).toBe(false);
  });

  // ── CTL-713: enriched marker schema (TTL + ticket + consecutiveFailures) ──

  test("recordDispatchFailure stamps ticket, expiresAt, and consecutiveFailures", () => {
    recordDispatchFailure(orchDir, "CTL-1", "research", 1, 5_000);
    const m = JSON.parse(readFileSync(dispatchCooldownPath(orchDir, "CTL-1", "research"), "utf8"));
    expect(m).toMatchObject({ ticket: "CTL-1", phase: "research", code: 1, failedAt: 5_000 });
    expect(m.expiresAt).toBe(5_000 + 60_000);
    expect(m.consecutiveFailures).toBe(1);
  });

  test("code=2 (prior_artifact_missing) uses the permanent cooldown window", () => {
    recordDispatchFailure(orchDir, "CTL-1", "plan", 2, 5_000);
    const m = JSON.parse(readFileSync(dispatchCooldownPath(orchDir, "CTL-1", "plan"), "utf8"));
    expect(m.expiresAt).toBe(5_000 + 30 * 60 * 1000);
  });

  test("consecutiveFailures increments on same-code overwrite, resets on a different code", () => {
    recordDispatchFailure(orchDir, "CTL-1", "research", 1, 1_000);
    recordDispatchFailure(orchDir, "CTL-1", "research", 1, 2_000);
    let m = JSON.parse(readFileSync(dispatchCooldownPath(orchDir, "CTL-1", "research"), "utf8"));
    expect(m.consecutiveFailures).toBe(2);
    recordDispatchFailure(orchDir, "CTL-1", "research", 2, 3_000);
    m = JSON.parse(readFileSync(dispatchCooldownPath(orchDir, "CTL-1", "research"), "utf8"));
    expect(m.consecutiveFailures).toBe(1);
  });

  test("recordDispatchFailure returns the written marker", () => {
    const m = recordDispatchFailure(orchDir, "CTL-1", "review", 2, 5_000);
    expect(m).toMatchObject({ ticket: "CTL-1", phase: "review", code: 2, consecutiveFailures: 1 });
    expect(m.expiresAt).toBe(5_000 + 30 * 60 * 1000);
  });

  test("inDispatchCooldown honors expiresAt for permanent (code=2) markers", () => {
    recordDispatchFailure(orchDir, "CTL-1", "plan", 2, 5_000);
    expect(inDispatchCooldown(orchDir, "CTL-1", "plan", 5_000 + 5 * 60 * 1000)).toBe(true);
    expect(inDispatchCooldown(orchDir, "CTL-1", "plan", 5_000 + 31 * 60 * 1000)).toBe(false);
  });

  test("inDispatchCooldown falls back to failedAt+COOLDOWN_MS for legacy markers without expiresAt", () => {
    mkdirSync(join(orchDir, ".dispatch-cooldowns"), { recursive: true });
    writeFileSync(dispatchCooldownPath(orchDir, "CTL-9", "research"),
      JSON.stringify({ phase: "research", code: 1, failedAt: 5_000 }));
    expect(inDispatchCooldown(orchDir, "CTL-9", "research", 35_000)).toBe(true);
    expect(inDispatchCooldown(orchDir, "CTL-9", "research", 66_000)).toBe(false);
  });
});

// ── CTL-624: dispatch cool-down wired into schedulerTick ──
describe("dispatch cool-down (schedulerTick)", () => {
  const eligibleOne = (id) => [
    {
      identifier: id,
      priority: 1,
      createdAt: "x",
      state: "Todo",
      relations: { nodes: [] },
      inverseRelations: { nodes: [] },
    },
  ];

  test("a refused new-work dispatch (transient code) writes a cool-down marker and stops re-dispatching", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    // code=1 is a transient failure → 60 s window (code=2 uses the 30-min
    // permanent window, covered separately by the recordDispatchFailure unit
    // tests). The < 60 s / > 60 s assertions below depend on the transient TTL.
    const dispatch = fakeDispatch({ code: 1 });
    const marker = dispatchCooldownPath(orchDir, "CTL-3", "research");

    // Tick 1 at t=1000: dispatch refused → 1 call, marker written.
    schedulerTick(orchDir, {
      readEligible: () => eligibleOne("CTL-3"),
      dispatch,
      now: () => 1_000,
      liveBackgroundCount: () => 0,
    });
    expect(dispatch.calls).toHaveLength(1);
    expect(existsSync(marker)).toBe(true);

    // Tick 2 at t=30_000 (< 60 s window): suppressed → still 1 call.
    schedulerTick(orchDir, {
      readEligible: () => eligibleOne("CTL-3"),
      dispatch,
      now: () => 30_000,
      liveBackgroundCount: () => 0,
    });
    expect(dispatch.calls).toHaveLength(1);

    // Tick 3 at t=70_000 (> 60 s window): re-dispatch fires → 2 calls.
    schedulerTick(orchDir, {
      readEligible: () => eligibleOne("CTL-3"),
      dispatch,
      now: () => 70_000,
      liveBackgroundCount: () => 0,
    });
    expect(dispatch.calls).toHaveLength(2);
  });

  test("a successful dispatch clears any prior cool-down marker", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const marker = dispatchCooldownPath(orchDir, "CTL-4", "research");

    // First a refusal seeds the marker. code=1 is transient (60 s window) so
    // the t=70_000 success below lands past the window; code=2 would hold a
    // 30-min permanent marker and suppress the clearing dispatch entirely.
    schedulerTick(orchDir, {
      readEligible: () => eligibleOne("CTL-4"),
      dispatch: fakeDispatch({ code: 1 }),
      now: () => 1_000,
      liveBackgroundCount: () => 0,
    });
    expect(existsSync(marker)).toBe(true);

    // After the window, a successful dispatch clears it.
    schedulerTick(orchDir, {
      readEligible: () => eligibleOne("CTL-4"),
      dispatch: fakeDispatch({ code: 0 }),
      now: () => 70_000,
      verifyDispatched: verifyOk, // CTL-611: not testing the verifier here
      liveBackgroundCount: () => 0,
    });
    expect(existsSync(marker)).toBe(false);
  });

  test("a pre-seeded in-window marker suppresses the dispatch entirely (calls === 0)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    recordDispatchFailure(orchDir, "CTL-5", "research", 2, 1_000);
    const dispatch = fakeDispatch({ code: 0 });
    schedulerTick(orchDir, {
      readEligible: () => eligibleOne("CTL-5"),
      dispatch,
      now: () => 20_000,
    });
    expect(dispatch.calls).toHaveLength(0);
  });

  test("a refused advancement dispatch is throttled by the cool-down", () => {
    writeSignal("CTL-6", "research", "done"); // FSM next = plan
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({ code: 2 });

    schedulerTick(orchDir, { readEligible: () => [], dispatch, now: () => 1_000 });
    expect(dispatch.calls).toHaveLength(1);
    expect(existsSync(dispatchCooldownPath(orchDir, "CTL-6", "plan"))).toBe(true);

    schedulerTick(orchDir, { readEligible: () => [], dispatch, now: () => 30_000 });
    expect(dispatch.calls).toHaveLength(1); // suppressed within window
  });
});

// ── CTL-713: GC sweep ──
describe("dispatch cool-down GC", () => {
  test("gcDispatchCooldowns deletes an expired marker for a non-eligible ticket", () => {
    recordDispatchFailure(orchDir, "CTL-DONE", "review", 1, 1_000); // expiresAt = 61_000
    const deleted = gcDispatchCooldowns(orchDir, new Set(["CTL-LIVE"]), 100_000);
    expect(deleted).toEqual([{ ticket: "CTL-DONE", phase: "review" }]);
    expect(existsSync(dispatchCooldownPath(orchDir, "CTL-DONE", "review"))).toBe(false);
  });

  test("gc keeps a marker whose ticket is still eligible even if expired", () => {
    recordDispatchFailure(orchDir, "CTL-LIVE", "research", 1, 1_000);
    gcDispatchCooldowns(orchDir, new Set(["CTL-LIVE"]), 100_000);
    expect(existsSync(dispatchCooldownPath(orchDir, "CTL-LIVE", "research"))).toBe(true);
  });

  test("gc keeps an unexpired marker for a non-eligible ticket", () => {
    recordDispatchFailure(orchDir, "CTL-DONE", "research", 1, 1_000); // expiresAt = 61_000
    gcDispatchCooldowns(orchDir, new Set(), 30_000); // before expiry
    expect(existsSync(dispatchCooldownPath(orchDir, "CTL-DONE", "research"))).toBe(true);
  });

  test("gc reaps a legacy marker (no expiresAt/ticket) using failedAt+COOLDOWN_MS and filename", () => {
    mkdirSync(join(orchDir, ".dispatch-cooldowns"), { recursive: true });
    writeFileSync(join(orchDir, ".dispatch-cooldowns", "CTL-671-monitor-deploy.json"),
      JSON.stringify({ phase: "monitor-deploy", code: 1, failedAt: 1_000 }));
    const deleted = gcDispatchCooldowns(orchDir, new Set(), 100_000);
    expect(deleted).toEqual([{ ticket: "CTL-671", phase: "monitor-deploy" }]);
  });

  test("gc tolerates a missing .dispatch-cooldowns dir and malformed files", () => {
    expect(gcDispatchCooldowns(orchDir, new Set(), 100_000)).toEqual([]);
    mkdirSync(join(orchDir, ".dispatch-cooldowns"), { recursive: true });
    writeFileSync(join(orchDir, ".dispatch-cooldowns", "junk.json"), "not json");
    expect(() => gcDispatchCooldowns(orchDir, new Set(), 100_000)).not.toThrow();
  });

  test("schedulerTick runs the GC sweep and emits a cooldown-gc event per reaped marker", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    recordDispatchFailure(orchDir, "CTL-GONE", "review", 1, 1_000);
    const events = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch({ code: 0 }),
      liveBackgroundCount: () => 0,
      now: () => 100_000,
      appendCooldownGcEvent: (e) => events.push(e),
    });
    expect(existsSync(dispatchCooldownPath(orchDir, "CTL-GONE", "review"))).toBe(false);
    expect(events).toEqual([expect.objectContaining({ ticket: "CTL-GONE", target_phase: "review" })]);
  });
});

// ── CTL-713: consecutive-failure escalation ──
describe("dispatch cool-down escalation", () => {
  const fakeWriteStatus = (applied) => ({
    applyLabel: ({ ticket, label }) => { applied.push({ ticket, label }); return { applied: true }; },
    transition: () => {},
    applyPhaseStatus: () => {},
  });

  test("maybeEscalateDispatchFailures applies needs-human at the threshold", () => {
    const applied = [];
    const ws = fakeWriteStatus(applied);
    const marker = { ticket: "CTL-5", phase: "research", code: 2, consecutiveFailures: 3 };
    const events = [];
    maybeEscalateDispatchFailures(orchDir, marker, { writeStatus: ws, appendEvent: (e) => events.push(e) });
    expect(applied).toEqual([{ ticket: "CTL-5", label: "needs-human" }]);
    expect(events).toEqual([expect.objectContaining({ ticket: "CTL-5", target_phase: "research", consecutiveFailures: 3 })]);
  });

  test("maybeEscalateDispatchFailures is a no-op below the threshold", () => {
    const applied = [];
    const ws = fakeWriteStatus(applied);
    maybeEscalateDispatchFailures(orchDir, { ticket: "CTL-5", phase: "research", code: 2, consecutiveFailures: 2 },
      { writeStatus: ws, appendEvent: () => {} });
    expect(applied).toEqual([]);
  });

  test("schedulerTick escalates after N consecutive same-code refusals on new-work", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({ code: 2 });
    const applied = [];
    const ws = fakeWriteStatus(applied);
    let t = 0;
    for (let i = 0; i < 3; i++) {
      schedulerTick(orchDir, {
        readEligible: () => [{ identifier: "CTL-7", priority: 1, createdAt: "x", state: "Todo",
                               relations: { nodes: [] }, inverseRelations: { nodes: [] } }],
        dispatch,
        writeStatus: ws,
        liveBackgroundCount: () => 0,
        now: () => (t += 31 * 60 * 1000),
      });
    }
    expect(applied).toContainEqual({ ticket: "CTL-7", label: "needs-human" });
  });
});

describe("deriveAdvancement", () => {
  test("latest phase done → returns the FSM successor", () => {
    expect(deriveAdvancement({ triage: "done" })).toBe("research");
    expect(deriveAdvancement({ triage: "done", research: "done", plan: "done" })).toBe("implement");
  });
  test("latest phase not done → null (nothing owed)", () => {
    expect(deriveAdvancement({ triage: "done", research: "running" })).toBeNull();
  });
  test("successor already has a signal → null (already advanced)", () => {
    expect(deriveAdvancement({ triage: "done", research: "running" })).toBeNull();
    expect(deriveAdvancement({ research: "done", plan: "dispatched" })).toBeNull();
  });
  test("monitor-deploy done → null (pipeline terminal)", () => {
    expect(deriveAdvancement({ "monitor-deploy": "done" })).toBeNull();
  });
  test("latest phase failed → null (nothing owed — revive is another owner's job)", () => {
    expect(deriveAdvancement({ implement: "failed" })).toBeNull();
  });
  test("no signals → null", () => {
    expect(deriveAdvancement({})).toBeNull();
  });
});

// ─── CTL-653: verdict + cycle routing in deriveAdvancement ───
describe("CTL-653: deriveAdvancement verdict + cycle routing", () => {
  const base = { triage: "done", research: "done", plan: "done", implement: "done" };

  test("no opts: verify done → review (legacy default treats absent verdict as pass)", () => {
    expect(deriveAdvancement({ ...base, verify: "done" })).toBe("review");
  });
  test("verdict pass → review", () => {
    expect(deriveAdvancement({ ...base, verify: "done" }, { verifyVerdict: "pass" })).toBe("review");
  });
  test("verdict null → review (conservative: missing verify.json is not a regression)", () => {
    expect(deriveAdvancement({ ...base, verify: "done" }, { verifyVerdict: null })).toBe("review");
  });
  test("verdict fail + cycle < cap + remediate not dispatched → remediate", () => {
    expect(
      deriveAdvancement({ ...base, verify: "done" }, { verifyVerdict: "fail", remediateCycleCount: 0 })
    ).toBe("remediate");
  });
  test("verdict fail + remediate already dispatched this cycle → null (no double-dispatch)", () => {
    expect(
      deriveAdvancement(
        { ...base, verify: "done", remediate: "running" },
        { verifyVerdict: "fail", remediateCycleCount: 0 }
      )
    ).toBeNull();
  });
  test("verdict fail + cycle >= cap → null (escalation handled by the sweep, not a dispatch)", () => {
    expect(
      deriveAdvancement(
        { ...base, verify: "done" },
        { verifyVerdict: "fail", remediateCycleCount: REMEDIATE_CYCLE_CAP }
      )
    ).toBeNull();
  });
  test("remediate signal is invisible to the latest-phase scan (not in PHASES)", () => {
    // a remediate `done` signal must not make remediate the 'latest' phase.
    expect(deriveAdvancement({ ...base, verify: "done", remediate: "done" }, { verifyVerdict: "pass" })).toBe(
      "review"
    );
  });
  test("post-reset: implement done is latest → verify", () => {
    expect(deriveAdvancement(base)).toBe("verify");
  });
});

// ─── CTL-653: maybeResetForRemediateCycle — re-entry deletes the cycle signals ───
describe("CTL-653: maybeResetForRemediateCycle", () => {
  test("remediate done → deletes the 3 cycle files, keeps the rest, returns true", () => {
    writeSignal("CTL-653", "implement", "done");
    writeSignal("CTL-653", "verify", "done");
    writeSignal("CTL-653", "remediate", "done");
    const wdir = join(orchDir, "workers", "CTL-653");
    writeFileSync(join(wdir, "verify.json"), JSON.stringify({ regression_risk: 7, findings: [] }));
    writeFileSync(join(wdir, "triage.json"), JSON.stringify({ classification: "feature" }));

    expect(maybeResetForRemediateCycle(orchDir, "CTL-653")).toBe(true);
    expect(existsSync(join(wdir, "phase-verify.json"))).toBe(false);
    expect(existsSync(join(wdir, "phase-remediate.json"))).toBe(false);
    expect(existsSync(join(wdir, "verify.json"))).toBe(false);
    // never deletes upstream signals/artifacts:
    expect(existsSync(join(wdir, "phase-implement.json"))).toBe(true);
    expect(existsSync(join(wdir, "triage.json"))).toBe(true);
  });
  test("GATE-0: clears the cycle members' claim tombstones (verify/remediate) so the re-verify wins a fresh gen-1 claim", () => {
    writeSignal("CTL-736", "implement", "done");
    writeSignal("CTL-736", "verify", "done");
    writeSignal("CTL-736", "remediate", "done");
    const wdir = join(orchDir, "workers", "CTL-736");
    // leftover CTL-736 claim tombstones from the first verify + the remediate
    writeFileSync(join(wdir, "verify.claim.1"), "{}");
    writeFileSync(join(wdir, "remediate.claim.1"), "{}");
    // an UNRELATED phase's claim must survive (only the cycle members are cleared)
    writeFileSync(join(wdir, "implement.claim.1"), "{}");

    expect(maybeResetForRemediateCycle(orchDir, "CTL-736")).toBe(true);
    // cycle-member claims cleared → the re-dispatch's fresh (no-signal ⇒ gen 1)
    // claim is exclusive and wins instead of colliding on the leftover gen-1 file
    expect(existsSync(join(wdir, "verify.claim.1"))).toBe(false);
    expect(existsSync(join(wdir, "remediate.claim.1"))).toBe(false);
    expect(existsSync(join(wdir, "implement.claim.1"))).toBe(true);
  });
  test("CTL-736: clears the cycle members' .progress-<phase> high-water markers (fresh verify/remediate not false-STOPPED)", () => {
    writeSignal("CTL-736P", "implement", "done");
    writeSignal("CTL-736P", "verify", "done");
    writeSignal("CTL-736P", "remediate", "done");
    const wdir = join(orchDir, "workers", "CTL-736P");
    // leftover progress high-waters from the prior cycle's verify + remediate…
    writeFileSync(join(wdir, ".progress-verify"), "120");
    writeFileSync(join(wdir, ".progress-remediate"), "3");
    // …and an UNRELATED phase's progress marker, which must survive.
    writeFileSync(join(wdir, ".progress-implement"), "4");

    expect(maybeResetForRemediateCycle(orchDir, "CTL-736P")).toBe(true);
    // cycle-member progress markers cleared → the fresh verify/remediate attempt
    // is measured from zero, not false-STOPPED by the prior cycle's high-water.
    expect(existsSync(join(wdir, ".progress-verify"))).toBe(false);
    expect(existsSync(join(wdir, ".progress-remediate"))).toBe(false);
    expect(existsSync(join(wdir, ".progress-implement"))).toBe(true);
  });
  test("remediate not done → no-op, returns false (cycle signals untouched)", () => {
    writeSignal("CTL-653", "verify", "done");
    writeSignal("CTL-653", "remediate", "running");
    expect(maybeResetForRemediateCycle(orchDir, "CTL-653")).toBe(false);
    expect(existsSync(join(orchDir, "workers", "CTL-653", "phase-verify.json"))).toBe(true);
  });
  test("no remediate signal at all → false", () => {
    writeSignal("CTL-653", "verify", "done");
    expect(maybeResetForRemediateCycle(orchDir, "CTL-653")).toBe(false);
  });
});

// ─── CTL-653: maybeEscalateRemediateExhausted — cap → stalled ───
describe("CTL-653: maybeEscalateRemediateExhausted", () => {
  test("verify done + fail + cycle >= cap → writes phase-verify.json status:stalled, returns true", () => {
    writeSignal("CTL-653", "verify", "done");
    expect(
      maybeEscalateRemediateExhausted(orchDir, "CTL-653", { verify: "done" }, "fail", REMEDIATE_CYCLE_CAP)
    ).toBe(true);
    const sig = JSON.parse(readFileSync(join(orchDir, "workers", "CTL-653", "phase-verify.json"), "utf8"));
    expect(sig.status).toBe("stalled");
    expect(sig.stalledReason).toBe("remediate-cycle-cap-exhausted");
  });
  test("idempotent: file already stalled → returns true, leaves it stalled", () => {
    const wdir = join(orchDir, "workers", "CTL-653");
    mkdirSync(wdir, { recursive: true });
    writeFileSync(
      join(wdir, "phase-verify.json"),
      JSON.stringify({ ticket: "CTL-653", phase: "verify", status: "stalled" })
    );
    expect(
      maybeEscalateRemediateExhausted(orchDir, "CTL-653", { verify: "done" }, "fail", REMEDIATE_CYCLE_CAP)
    ).toBe(true);
    expect(JSON.parse(readFileSync(join(wdir, "phase-verify.json"), "utf8")).status).toBe("stalled");
  });
  test("cycle < cap → no-op false", () => {
    expect(maybeEscalateRemediateExhausted(orchDir, "CTL-653", { verify: "done" }, "fail", 0)).toBe(false);
  });
  test("verdict pass → no-op false (never stalls a passing verify)", () => {
    expect(maybeEscalateRemediateExhausted(orchDir, "CTL-653", { verify: "done" }, "pass", 99)).toBe(false);
  });
  test("verify not done → no-op false", () => {
    expect(maybeEscalateRemediateExhausted(orchDir, "CTL-653", { verify: "running" }, "fail", 99)).toBe(false);
  });
});

// ─── CTL-712: escalateDispatchExhausted — retry ceiling → stalled ───
describe("CTL-712: escalateDispatchExhausted — retry ceiling → stalled", () => {
  test("creates phase-<phase>.json with status:stalled when no signal exists", () => {
    expect(escalateDispatchExhausted(orchDir, "CTL-712", "pr")).toBe(true);
    const sig = JSON.parse(
      readFileSync(join(orchDir, "workers", "CTL-712", "phase-pr.json"), "utf8")
    );
    expect(sig.status).toBe("stalled");
    expect(sig.stalledReason).toBe("prior-artifact-retry-exhausted");
  });

  test("the stalled signal makes the ticket NOT in-flight", () => {
    escalateDispatchExhausted(orchDir, "CTL-712", "pr");
    expect(isTicketInFlight(readPhaseSignals(orchDir, "CTL-712"))).toBe(false);
  });

  test("merges over an existing half-written signal (preserves bg_job_id)", () => {
    const p = join(orchDir, "workers", "CTL-712", "phase-pr.json");
    mkdirSync(join(orchDir, "workers", "CTL-712"), { recursive: true });
    writeFileSync(p, JSON.stringify({ ticket: "CTL-712", phase: "pr", status: "dispatched", bg_job_id: "abc123" }));
    escalateDispatchExhausted(orchDir, "CTL-712", "pr");
    const sig = JSON.parse(readFileSync(p, "utf8"));
    expect(sig.status).toBe("stalled");
    expect(sig.bg_job_id).toBe("abc123");
  });

  test("idempotent: a second call returns true and leaves it stalled", () => {
    escalateDispatchExhausted(orchDir, "CTL-712", "pr");
    expect(escalateDispatchExhausted(orchDir, "CTL-712", "pr")).toBe(true);
    const sig = JSON.parse(
      readFileSync(join(orchDir, "workers", "CTL-712", "phase-pr.json"), "utf8")
    );
    expect(sig.status).toBe("stalled");
  });

  test("clears the dispatch cool-down marker on escalation", () => {
    recordDispatchFailure(orchDir, "CTL-712", "pr", 2, 1_000);
    escalateDispatchExhausted(orchDir, "CTL-712", "pr");
    expect(existsSync(dispatchCooldownPath(orchDir, "CTL-712", "pr"))).toBe(false);
  });
});

// ─── CTL-712: dispatch retry ceiling wired into schedulerTick ───
describe("CTL-712: dispatch retry ceiling (schedulerTick)", () => {
  let prevMax;
  beforeEach(() => {
    prevMax = process.env.SCHEDULER_MAX_DISPATCH_RETRIES;
    process.env.SCHEDULER_MAX_DISPATCH_RETRIES = "3";
  });
  afterEach(() => {
    if (prevMax === undefined) delete process.env.SCHEDULER_MAX_DISPATCH_RETRIES;
    else process.env.SCHEDULER_MAX_DISPATCH_RETRIES = prevMax;
  });

  const noWrites = () => ({ applyPhaseStatus() {}, applyTerminalDone() {} });

  test("a refused advancement dispatch stalls + escalates after N failures, then stops", () => {
    writeSignal("CTL-712", "review", "done"); // FSM next = pr; review.json artifact is absent
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({ code: 2 });
    const labels = [];
    const writeStatus = { ...noWrites(), applyLabel: (a) => { labels.push(a); return { applied: true }; } };

    // 3 ticks, each past the code=2 permanent cooldown window (CTL-713: 30 min)
    // → 3 refused dispatches → consecutiveFailures hits the ceiling on the 3rd.
    const STEP_MS = 31 * 60_000; // > DISPATCH_PERMANENT_COOLDOWN_MS so each tick re-dispatches
    for (let i = 0; i < 3; i++) {
      schedulerTick(orchDir, {
        readEligible: () => [],
        dispatch,
        writeStatus,
        verifyDispatched: verifyOk,
        now: () => 1_000 + i * STEP_MS,
      });
    }
    expect(dispatch.calls).toHaveLength(3);

    const sig = JSON.parse(
      readFileSync(join(orchDir, "workers", "CTL-712", "phase-pr.json"), "utf8")
    );
    expect(sig.status).toBe("stalled");
    expect(sig.stalledReason).toBe("prior-artifact-retry-exhausted");

    // Next tick: ticket is no longer in-flight → zero further dispatches; needs-human applied.
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      writeStatus,
      verifyDispatched: verifyOk,
      now: () => 1_000 + 4 * STEP_MS,
    });
    expect(dispatch.calls).toHaveLength(3); // unchanged
    expect(labels.some((l) => l.label === "needs-human")).toBe(true);
  });
});

describe("schedulerTick — new-work pull", () => {
  test("dispatches research for the top-ranked ready ticket into a free slot", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    const dispatch = fakeDispatch();
    const eligible = [
      {
        identifier: "CTL-9",
        priority: 4,
        createdAt: "x",
        state: "Todo",
        relations: { nodes: [] },
        inverseRelations: { nodes: [] },
      },
      {
        identifier: "CTL-8",
        priority: 1,
        createdAt: "x",
        state: "Todo",
        relations: { nodes: [] },
        inverseRelations: { nodes: [] },
      },
    ];
    const r = schedulerTick(orchDir, {
      readEligible: () => eligible,
      dispatch,
      verifyDispatched: verifyOk, // CTL-611: bypass the dispatch verifier
      liveBackgroundCount: () => 0,
    });
    // 2 free slots, both ready → both dispatched, urgent (CTL-8) first.
    expect(dispatch.calls.map((c) => c.ticket)).toEqual(["CTL-8", "CTL-9"]);
    // CTL-565: new-work enters the pipeline at research, not triage.
    expect(dispatch.calls.every((c) => c.phase === "research")).toBe(true);
    expect(r.dispatched).toEqual(["CTL-8", "CTL-9"]);
  });

  // CTL-665: a committed executionCore.maxParallel threaded via `concurrency`
  // drives the new-work ceiling end-to-end, overriding a smaller state.json value.
  test("concurrency.maxParallel overrides state.json for the new-work ceiling (CTL-665)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch();
    const eligible = [
      {
        identifier: "CTL-1",
        priority: 1,
        createdAt: "x",
        state: "Todo",
        relations: { nodes: [] },
        inverseRelations: { nodes: [] },
      },
      {
        identifier: "CTL-2",
        priority: 1,
        createdAt: "x",
        state: "Todo",
        relations: { nodes: [] },
        inverseRelations: { nodes: [] },
      },
      {
        identifier: "CTL-3",
        priority: 1,
        createdAt: "x",
        state: "Todo",
        relations: { nodes: [] },
        inverseRelations: { nodes: [] },
      },
    ];
    const r = schedulerTick(orchDir, {
      readEligible: () => eligible,
      dispatch,
      verifyDispatched: verifyOk, // CTL-611: bypass the dispatch verifier
      liveBackgroundCount: () => 0,
      // committed config raises the ceiling from state.json's 1 to 3.
      concurrency: { maxParallel: 3, minParallel: 1, maxParallelCeiling: 10 },
    });
    // state.json caps at 1, but the threaded config ceiling is 3 → all 3 dispatch.
    expect(dispatch.calls).toHaveLength(3);
    expect(r.dispatched).toHaveLength(3);
  });

  test("new-work pull dispatches Ready tickets at the research phase, not triage (CTL-565)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch();
    const eligible = [
      {
        identifier: "CTL-1",
        priority: 2,
        createdAt: "x",
        state: "Todo",
        relations: { nodes: [] },
        inverseRelations: { nodes: [] },
      },
    ];
    schedulerTick(orchDir, { readEligible: () => eligible, dispatch, liveBackgroundCount: () => 0 });
    expect(dispatch.calls).toHaveLength(1);
    expect(dispatch.calls[0]).toMatchObject({ ticket: "CTL-1", phase: "research" });
  });

  test("respects maxParallel — no dispatch when slots are full", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    writeSignal("CTL-1", "implement", "running"); // 1 in-flight, ceiling 1
    const dispatch = fakeDispatch();
    const eligible = [
      {
        identifier: "CTL-2",
        priority: 1,
        createdAt: "x",
        state: "Todo",
        relations: { nodes: [] },
        inverseRelations: { nodes: [] },
      },
    ];
    // CTL-657: concurrency is the live background-agent count, not a workers/
    // scan — one live worker fills the single slot.
    const r = schedulerTick(orchDir, {
      readEligible: () => eligible,
      dispatch,
      liveBackgroundCount: () => 1,
    });
    expect(dispatch.calls).toHaveLength(0);
    expect(r.dispatched).toEqual([]);
  });

  test("is idempotent — a second tick re-dispatches nothing", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    const eligible = [
      {
        identifier: "CTL-5",
        priority: 2,
        createdAt: "x",
        state: "Todo",
        relations: { nodes: [] },
        inverseRelations: { nodes: [] },
      },
    ];
    // First tick dispatches; the stub also writes the signal
    // phase-agent-dispatch would.
    const dispatch = (args) => {
      writeSignal(args.ticket, args.phase, "dispatched");
      return { code: 0, stdout: "", stderr: "" };
    };
    schedulerTick(orchDir, { readEligible: () => eligible, dispatch });
    const second = fakeDispatch();
    schedulerTick(orchDir, { readEligible: () => eligible, dispatch: second });
    expect(second.calls).toHaveLength(0); // CTL-5 already started → not re-pulled
  });

  test("advancement sweep dispatches the owed next phase for an in-flight ticket", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    writeSignal("CTL-7", "triage", "done"); // research is owed
    const dispatch = fakeDispatch();
    const r = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      verifyDispatched: verifyOk, // CTL-611: bypass dispatch verifier
    });
    expect(dispatch.calls).toEqual([{ orchDir, ticket: "CTL-7", phase: "research" }]);
    expect(r.advanced).toEqual([{ ticket: "CTL-7", phase: "research" }]);
  });

  test("a failed-dispatch (non-zero exit) is a soft skip, not a throw", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({ code: 1 });
    const eligible = [
      {
        identifier: "CTL-3",
        priority: 1,
        createdAt: "x",
        state: "Todo",
        relations: { nodes: [] },
        inverseRelations: { nodes: [] },
      },
    ];
    const r = schedulerTick(orchDir, { readEligible: () => eligible, dispatch });
    expect(r.dispatched).toEqual([]); // dispatch failed → not recorded
    // no throw — the tick completes
  });

  test("one tick both advances an in-flight ticket and pulls new work", () => {
    // maxParallel 2; CTL-7 in-flight at triage:done (advances to research,
    // still 1 in-flight); 1 free slot remains → CTL-X is pulled. The
    // advancement sweep must NOT consume the slot the pull then fills.
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    writeSignal("CTL-7", "triage", "done");
    const dispatch = fakeDispatch();
    const eligible = [
      {
        identifier: "CTL-X",
        priority: 1,
        createdAt: "x",
        state: "Todo",
        relations: { nodes: [] },
        inverseRelations: { nodes: [] },
      },
    ];
    const r = schedulerTick(orchDir, {
      readEligible: () => eligible,
      dispatch,
      verifyDispatched: verifyOk, // CTL-611: bypass dispatch verifier
      liveBackgroundCount: () => 0,
    });
    expect(r.advanced).toEqual([{ ticket: "CTL-7", phase: "research" }]);
    expect(r.dispatched).toEqual(["CTL-X"]);
    expect(dispatch.calls).toEqual([
      { orchDir, ticket: "CTL-7", phase: "research" },
      // CTL-565: new-work pull enters at research, not triage.
      { orchDir, ticket: "CTL-X", phase: "research" },
    ]);
  });

  // ── CTL-731 Phase 00: staleness-gate new-work dispatch ──
  // A stale/never-populated liveness snapshot means we cannot trust the live
  // background count, so the scheduler HOLDS new-work admission (freeSlots → 0)
  // rather than over-spawning on an unknown count. Advancement of in-flight
  // phases is independent of the live count and must continue.
  test("a stale liveness snapshot holds new-work dispatch (freeSlots → 0)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 3 }));
    const dispatch = fakeDispatch();
    const eligible = [
      {
        identifier: "CTL-9",
        priority: 1,
        createdAt: "x",
        state: "Todo",
        relations: { nodes: [] },
        inverseRelations: { nodes: [] },
      },
    ];
    const r = schedulerTick(orchDir, {
      readEligible: () => eligible,
      dispatch,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0, // would otherwise show 3 free slots
      livenessIsFresh: () => false, // but the snapshot is stale/cold → hold
    });
    expect(dispatch.calls).toHaveLength(0);
    expect(r.dispatched).toEqual([]);
  });

  test("a stale liveness snapshot still advances in-flight phases (advancement is count-independent)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    writeSignal("CTL-7", "triage", "done"); // should advance to research
    const dispatch = fakeDispatch();
    const eligible = [
      {
        identifier: "CTL-X",
        priority: 1,
        createdAt: "x",
        state: "Todo",
        relations: { nodes: [] },
        inverseRelations: { nodes: [] },
      },
    ];
    const r = schedulerTick(orchDir, {
      readEligible: () => eligible,
      dispatch,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      livenessIsFresh: () => false, // stale → new-work held, advancement unaffected
    });
    expect(r.advanced).toEqual([{ ticket: "CTL-7", phase: "research" }]);
    expect(dispatch.calls).toEqual([{ orchDir, ticket: "CTL-7", phase: "research" }]);
    expect(r.dispatched).toEqual([]); // CTL-X held by the staleness gate
  });

  test("a fresh liveness snapshot (default) dispatches new work normally", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    const dispatch = fakeDispatch();
    const eligible = [
      {
        identifier: "CTL-9",
        priority: 1,
        createdAt: "x",
        state: "Todo",
        relations: { nodes: [] },
        inverseRelations: { nodes: [] },
      },
    ];
    const r = schedulerTick(orchDir, {
      readEligible: () => eligible,
      dispatch,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      livenessIsFresh: () => true, // explicit; also the default
    });
    expect(r.dispatched).toEqual(["CTL-9"]);
  });

  // CTL-736: the reclaim death trigger is the LOCAL state.json lifecycle, so the
  // sweep no longer reads the `claude agents` snapshot nor binds a per-worker
  // liveness — the CTL-731 reclaimColdSkip + snapshot-binding are both deleted.
  // The sweep runs every tick (no cold/warm distinction) and NEVER passes a
  // `liveness` reclaim option, regardless of snapshot state.
  for (const [label, livenessSnapshot, livenessIsFresh] of [
    ["cold/unpopulated snapshot", () => ({ populated: false, agents: [], isFresh: false }), () => false],
    ["null snapshot seam (legacy/test)", null, () => false],
    [
      "populated snapshot",
      () => ({ populated: true, agents: [{ sessionId: "1111-2222", kind: "background", status: "idle" }], isFresh: true }),
      () => true,
    ],
  ]) {
    test(`reclaim sweep runs and binds NO snapshot liveness — ${label}`, () => {
      writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
      writeSignal("CTL-1", "implement", "running"); // an in-flight worker the sweep visits
      const reclaimOpts = [];
      const reclaimDeadWork = (_orchDir, _sig, opts) => {
        reclaimOpts.push(opts);
        return "noop";
      };
      schedulerTick(orchDir, {
        readEligible: () => [],
        dispatch: fakeDispatch(),
        reclaimDeadWork,
        liveBackgroundCount: () => 1,
        livenessSnapshot,
        livenessIsFresh,
      });
      expect(reclaimOpts.length).toBe(1); // sweep runs every tick
      expect(reclaimOpts[0].liveness).toBeUndefined(); // state.json trigger — no snapshot binding
    });
  }
});

// ── CTL-706: per-project cap + reserve wired into schedulerTick ──
describe("schedulerTick — CTL-706 per-project budgets", () => {
  const mk = (id, p = 1) => ({
    identifier: id,
    priority: p,
    createdAt: "x",
    state: "Todo",
    relations: { nodes: [] },
    inverseRelations: { nodes: [] },
  });

  test("perProject cap saturation skips the next pick", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 3 }));
    const dispatch = fakeDispatch();
    const eligible = [mk("ADV-1", 1), mk("ADV-2", 1), mk("CTL-1", 2)];
    const r = schedulerTick(orchDir, {
      readEligible: () => eligible,
      dispatch,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      concurrency: { maxParallel: 3, perProject: { ADV: { maxParallel: 1 } } },
    });
    expect(r.dispatched).toEqual(["ADV-1", "CTL-1"]);
  });

  test("perProject reserve withholds a slot for a starved project", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch();
    const eligible = [mk("ADV-1", 1), mk("CTL-1", 2)];
    const r = schedulerTick(orchDir, {
      readEligible: () => eligible,
      dispatch,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      concurrency: { maxParallel: 1, perProject: { CTL: { reserve: 1 } } },
    });
    expect(r.dispatched).toEqual(["CTL-1"]);
  });

  test("no perProject config → identical to pre-CTL-706 behavior (regression)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    const dispatch = fakeDispatch();
    const eligible = [mk("CTL-9", 4), mk("CTL-8", 1)];
    const r = schedulerTick(orchDir, {
      readEligible: () => eligible,
      dispatch,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
    });
    expect(r.dispatched).toEqual(["CTL-8", "CTL-9"]);
  });
});

describe("CTL-706 — per-project budgets integration", () => {
  const mk = (id, p = 1) => ({
    identifier: id,
    priority: p,
    createdAt: "x",
    state: "Todo",
    relations: { nodes: [] },
    inverseRelations: { nodes: [] },
  });

  test("ADV burst respects cap=3; CTL reserve=1 is never starved", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 4 }));
    const dispatch = fakeDispatch();
    const eligible = [
      mk("ADV-1", 1),
      mk("ADV-2", 1),
      mk("ADV-3", 1),
      mk("ADV-4", 1),
      mk("ADV-5", 1),
      mk("ADV-6", 1),
      mk("CTL-1", 2),
      mk("CTL-2", 2),
    ];
    const r = schedulerTick(orchDir, {
      readEligible: () => eligible,
      dispatch,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      concurrency: {
        maxParallel: 4,
        perProject: { ADV: { maxParallel: 3, reserve: 2 }, CTL: { maxParallel: 3, reserve: 1 } },
      },
    });
    const advCount = r.dispatched.filter((t) => t.startsWith("ADV")).length;
    const ctlCount = r.dispatched.filter((t) => t.startsWith("CTL")).length;
    expect(advCount).toBeLessThanOrEqual(3);
    expect(ctlCount).toBeGreaterThanOrEqual(1);
    expect(r.dispatched.length).toBeLessThanOrEqual(4);
  });
});

describe("buildPerProjectGauge (CTL-706)", () => {
  test("counts in-flight per project and surfaces cap/reserve", () => {
    const g = buildPerProjectGauge(
      new Set(["ADV-1", "ADV-2", "CTL-1"]),
      { ADV: { maxParallel: 4, reserve: 2 }, CTL: { maxParallel: 3, reserve: 1 } },
      1,
    );
    expect(g.freeSlots).toBe(1);
    expect(g.perProject.ADV).toEqual({ inFlight: 2, maxParallel: 4, reserve: 2 });
    expect(g.perProject.CTL).toEqual({ inFlight: 1, maxParallel: 3, reserve: 1 });
  });
  test("includes an in-flight project with no config entry", () => {
    const g = buildPerProjectGauge(new Set(["ZZZ-1"]), { CTL: { reserve: 1 } }, 0);
    expect(g.perProject.ZZZ).toEqual({ inFlight: 1 });
    expect(g.perProject.CTL).toEqual({ inFlight: 0, reserve: 1 });
  });
});

// ── CTL-657: live-count concurrency + predecessor reap on scheduler advance ──
describe("schedulerTick — CTL-657 live-count concurrency & predecessor reap", () => {
  // Write a phase signal that carries a bg_job_id (the default writeSignal
  // helper omits it; the predecessor reap reads it from the raw signal).
  function writeSignalWithBg(ticket, phase, status, bgJobId) {
    const dir = join(orchDir, "workers", ticket);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `phase-${phase}.json`),
      JSON.stringify({ ticket, phase, status, bg_job_id: bgJobId }),
    );
  }

  function readEventLog() {
    const now = new Date();
    const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const p = join(catalystDir, "events", `${ym}.jsonl`);
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  const oneEligible = (id) => [
    {
      identifier: id,
      priority: 1,
      createdAt: "x",
      state: "Todo",
      relations: { nodes: [] },
      inverseRelations: { nodes: [] },
    },
  ];

  test("holds at max — no new-work dispatch when live background count == maxParallel", () => {
    // No worker dirs at all, but the live fleet already has 2 background agents
    // (e.g. leaked workers whose signals went terminal). The paper-count model
    // would see 0 in-flight and over-dispatch; the live-count model holds.
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    const dispatch = fakeDispatch();
    const r = schedulerTick(orchDir, {
      readEligible: () => oneEligible("CTL-2"),
      dispatch,
      liveBackgroundCount: () => 2,
    });
    expect(r.freeSlots).toBe(0);
    expect(r.dispatched).toEqual([]);
    expect(dispatch.calls).toHaveLength(0);
  });

  test("fills exactly the freed slot — live count below max admits new work", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    const dispatch = fakeDispatch();
    const r = schedulerTick(orchDir, {
      readEligible: () => oneEligible("CTL-2"),
      dispatch,
      liveBackgroundCount: () => 1, // 1 live bg worker, 1 slot free
      verifyDispatched: verifyOk, // CTL-611: fakeDispatch writes no signal; bypass the verifier
    });
    expect(r.freeSlots).toBe(1);
    expect(r.dispatched).toEqual(["CTL-2"]);
  });

  test("emits phase.predecessor.reap-requested for the completed phase on advance", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    // research done (bg worker bg-aaaa1111) → FSM advances to plan; the research
    // worker is the predecessor and must be nominated for stopping.
    writeSignalWithBg("CTL-7", "research", "done", "aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee");
    const dispatch = fakeDispatch();
    const r = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      liveBackgroundCount: () => 0,
      verifyDispatched: verifyOk, // CTL-611: fakeDispatch writes no signal; bypass the verifier
    });
    expect(r.advanced).toEqual([{ ticket: "CTL-7", phase: "plan" }]);
    const reap = readEventLog().find(
      (e) => e.event === "phase.predecessor.reap-requested" && e.ticket === "CTL-7",
    );
    expect(reap).toBeTruthy();
    expect(reap.phase).toBe("research");
    expect(reap.bg_job_id).toBe("aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee");
  });

  test("no predecessor reap when the completed-phase signal has no bg_job_id", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    writeSignal("CTL-8", "research", "done"); // no bg_job_id
    const dispatch = fakeDispatch();
    schedulerTick(orchDir, { readEligible: () => [], dispatch, liveBackgroundCount: () => 0 });
    expect(
      readEventLog().filter((e) => e.event === "phase.predecessor.reap-requested"),
    ).toHaveLength(0);
  });

  // CTL-661 hole #2 — verify⇄remediate detour reaps, driven through schedulerTick.
  function writeVerifyJson(ticket, regressionRisk) {
    const dir = join(orchDir, "workers", ticket);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "verify.json"),
      JSON.stringify({ regression_risk: regressionRisk, findings: [], gates: {} }),
    );
  }

  test("verify→remediate advance reaps the verify worker", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    // implement+verify done; verify.json verdict-fail (regression_risk≥5) routes
    // verify → remediate. The verify worker is the detour predecessor.
    writeSignalWithBg("CTL-7", "implement", "done", "impl1111-0000-0000-0000-000000000000");
    writeSignalWithBg("CTL-7", "verify", "done", "veri2222-0000-0000-0000-000000000000");
    writeVerifyJson("CTL-7", 8);
    const dispatch = fakeDispatch();
    const r = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      liveBackgroundCount: () => 0,
      verifyDispatched: verifyOk,
    });
    expect(r.advanced).toEqual([{ ticket: "CTL-7", phase: "remediate" }]);
    const reap = readEventLog().find(
      (e) => e.event === "phase.predecessor.reap-requested" && e.ticket === "CTL-7",
    );
    expect(reap).toBeTruthy();
    expect(reap.phase).toBe("verify");
    expect(reap.bg_job_id).toBe("veri2222-0000-0000-0000-000000000000");
    expect(reap.reason).toBe("ctl-661-remediate-detour");
  });

  test("remediate→verify re-entry reaps the remediate worker, NOT implement", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    // implement+verify+remediate all done → maybeResetForRemediateCycle wipes the
    // verify+remediate signals and re-dispatches a fresh verify. The remediate
    // worker (captured before the reset) is the predecessor to reap.
    writeSignalWithBg("CTL-7", "implement", "done", "impl1111-0000-0000-0000-000000000000");
    writeSignalWithBg("CTL-7", "verify", "done", "veri2222-0000-0000-0000-000000000000");
    writeSignalWithBg("CTL-7", "remediate", "done", "reme3333-0000-0000-0000-000000000000");
    const dispatch = fakeDispatch();
    const r = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      liveBackgroundCount: () => 0,
      verifyDispatched: verifyOk,
    });
    expect(r.advanced).toEqual([{ ticket: "CTL-7", phase: "verify" }]);
    const reaps = readEventLog().filter(
      (e) => e.event === "phase.predecessor.reap-requested" && e.ticket === "CTL-7",
    );
    expect(reaps).toHaveLength(1);
    expect(reaps[0].phase).toBe("remediate");
    expect(reaps[0].bg_job_id).toBe("reme3333-0000-0000-0000-000000000000");
    // Explicitly NOT the long-finished implement worker.
    expect(reaps[0].phase).not.toBe("implement");
  });
});

describe("predecessorPhaseOf", () => {
  test("returns the done phase whose successor is `next`", () => {
    expect(predecessorPhaseOf({ research: "done" }, "plan")).toBe("research");
    expect(predecessorPhaseOf({ implement: "done" }, "verify")).toBe("implement");
  });

  test("ignores a non-done predecessor and unrelated done phases", () => {
    expect(predecessorPhaseOf({ research: "running" }, "plan")).toBeNull();
    expect(predecessorPhaseOf({ triage: "done" }, "plan")).toBeNull();
  });

  test("null for the router-only remediate detour (no NEXT_PHASE edge) and empty input", () => {
    expect(predecessorPhaseOf({ verify: "done" }, "remediate")).toBeNull();
    expect(predecessorPhaseOf(null, "plan")).toBeNull();
  });
});

// ── CTL-661 hole #2: detour-aware reap predecessor resolution ──
describe("resolveReapPredecessor", () => {
  test("linear edge → NEXT_PHASE inversion (ctl-657 reason)", () => {
    expect(resolveReapPredecessor({ research: "done" }, "plan")).toEqual({
      phase: "research",
      reason: "ctl-657-scheduler-advance",
    });
    expect(resolveReapPredecessor({ implement: "done" }, "verify")).toEqual({
      phase: "implement",
      reason: "ctl-657-scheduler-advance",
    });
  });

  test("verify → remediate detour reaps the verify worker", () => {
    expect(
      resolveReapPredecessor({ implement: "done", verify: "done" }, "remediate"),
    ).toEqual({ phase: "verify", reason: "ctl-661-remediate-detour" });
  });

  test("remediate → verify detour reaps remediate, NOT implement", () => {
    const r = resolveReapPredecessor(
      { implement: "done", verify: "done", remediate: "done" },
      "verify",
    );
    expect(r).toEqual({ phase: "remediate", reason: "ctl-661-remediate-detour" });
    expect(r.phase).not.toBe("implement");
  });

  test("no resolvable predecessor → null", () => {
    // verify → remediate but verify is not done yet.
    expect(resolveReapPredecessor({ implement: "done" }, "remediate")).toBeNull();
    expect(resolveReapPredecessor(null, "plan")).toBeNull();
  });
});

describe("listStartedTickets", () => {
  test("returns every worker dir regardless of status (started ≠ in-flight)", () => {
    writeSignal("CTL-1", "implement", "running");
    writeSignal("CTL-2", "triage", "failed");
    writeSignal("CTL-3", "monitor-deploy", "done");
    expect([...listStartedTickets(orchDir)].sort()).toEqual(["CTL-1", "CTL-2", "CTL-3"]);
  });
});

describe("readAllEligibleTickets", () => {
  test("returns [] when the eligible dir does not exist", () => {
    expect(readAllEligibleTickets()).toEqual([]);
  });
  test("concatenates tickets across every per-project projection", () => {
    writeEligibleProjection("alpha", { tickets: [{ identifier: "A-1" }] });
    writeEligibleProjection("beta", {
      tickets: [{ identifier: "B-1" }, { identifier: "B-2" }],
    });
    expect(
      readAllEligibleTickets()
        .map((t) => t.identifier)
        .sort()
    ).toEqual(["A-1", "B-1", "B-2"]);
  });
  test("skips a malformed projection file and still returns the valid ones", () => {
    writeEligibleProjection("good", { tickets: [{ identifier: "G-1" }] });
    writeEligibleProjection("bad", "{ not valid json", { raw: true });
    expect(readAllEligibleTickets().map((t) => t.identifier)).toEqual(["G-1"]);
  });
  test("skips a projection whose `tickets` field is not an array", () => {
    writeEligibleProjection("shapeless", { tickets: "nope" });
    writeEligibleProjection("ok", { tickets: [{ identifier: "OK-1" }] });
    expect(readAllEligibleTickets().map((t) => t.identifier)).toEqual(["OK-1"]);
  });
});

// ── CTL-565 D5: out-of-set blocker-state hydration ──

describe("hydrateOutOfSetBlockers / D5 readiness", () => {
  // blkTk — an eligible ticket carrying a `blocked_by` relation to `blockedBy`.
  const blkTk = (id, { priority = 2, blockedBy } = {}) => ({
    identifier: id,
    priority,
    createdAt: "x",
    state: "Todo",
    relations: blockedBy
      ? { nodes: [{ type: "blocked_by", relatedIssue: { identifier: blockedBy } }] }
      : { nodes: [] },
    inverseRelations: { nodes: [] },
  });

  test("fetches each unique out-of-set blocker once (deduped)", () => {
    const fetched = [];
    const exec = (_cmd, args) => {
      fetched.push(args[2]);
      return { code: 0, stdout: JSON.stringify({ state: { name: "Backlog" } }), stderr: "" };
    };
    const map = hydrateOutOfSetBlockers(
      [blkTk("CTL-1", { blockedBy: "CTL-99" }), blkTk("CTL-2", { blockedBy: "CTL-99" })],
      { exec }
    );
    expect(fetched).toEqual(["CTL-99"]); // deduped — one fetch
    expect(map).toEqual({ "CTL-99": "Backlog" });
  });

  test("an in-set blocker is not fetched (only out-of-set blockers hydrate)", () => {
    const fetched = [];
    const exec = (_cmd, args) => {
      fetched.push(args[2]);
      return { code: 0, stdout: JSON.stringify({ state: { name: "Backlog" } }), stderr: "" };
    };
    // CTL-2 is in the eligible set, so the CTL-1→CTL-2 edge is in-set.
    hydrateOutOfSetBlockers([blkTk("CTL-1", { blockedBy: "CTL-2" }), blkTk("CTL-2")], { exec });
    expect(fetched).toEqual([]);
  });

  test("a Ready ticket blocked by a Backlog out-of-set blocker is not dispatched", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({ code: 0 });
    const exec = () => ({
      code: 0,
      stdout: JSON.stringify({ state: { name: "Backlog" } }),
      stderr: "",
    });
    schedulerTick(orchDir, {
      readEligible: () => [blkTk("CTL-1", { blockedBy: "CTL-99" })],
      dispatch,
      exec,
    });
    expect(dispatch.calls).toHaveLength(0);
  });

  test("a Ready ticket blocked by a Done out-of-set blocker IS dispatched", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({ code: 0 });
    const exec = () => ({
      code: 0,
      stdout: JSON.stringify({ state: { name: "Done" } }),
      stderr: "",
    });
    schedulerTick(orchDir, {
      readEligible: () => [blkTk("CTL-1", { blockedBy: "CTL-99" })],
      dispatch,
      exec,
      liveBackgroundCount: () => 0,
    });
    expect(dispatch.calls.map((c) => c.ticket)).toEqual(["CTL-1"]);
  });

  test("a failed blocker fetch fails safe — the dependent is held back, not dispatched", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({ code: 0 });
    const exec = () => ({ code: 1, stdout: "", stderr: "boom" });
    schedulerTick(orchDir, {
      readEligible: () => [blkTk("CTL-1", { blockedBy: "CTL-99" })],
      dispatch,
      exec,
    });
    expect(dispatch.calls).toHaveLength(0);
  });
});

// CTL-634 Tier 1 — an opt-in cache deduplicates out-of-set blocker reads
// across ticks. The blocker-ticket fixture matches the D5 `blkTk` shape above
// verbatim: a `blocked_by` relation carrying `relatedIssue.identifier`, the
// edge `referencedBlockerIds` reads.
describe("hydrateOutOfSetBlockers — cache reuse (CTL-634)", () => {
  const blkTk = (id, blockedBy) => ({
    identifier: id,
    priority: 2,
    createdAt: "x",
    state: "Todo",
    relations: { nodes: [{ type: "blocked_by", relatedIssue: { identifier: blockedBy } }] },
    inverseRelations: { nodes: [] },
  });

  test("reads an out-of-set blocker once across two hydrations within TTL", () => {
    const cache = createTicketStateCache({ now: () => 0, ttlMs: 60_000 });
    const fetched = [];
    const exec = (_cmd, args) => {
      fetched.push(args[2]);
      return { code: 0, stdout: JSON.stringify({ state: { name: "Backlog" } }), stderr: "" };
    };
    const eligible = [blkTk("CTL-1", "CTL-99")];
    hydrateOutOfSetBlockers(eligible, { exec, cache });
    hydrateOutOfSetBlockers(eligible, { exec, cache });
    expect(fetched).toEqual(["CTL-99"]); // one read, second hydration is a hit
  });

  test("preserves the fail-safe: a failed fetch is the sentinel AND is not cached", () => {
    const cache = createTicketStateCache({ now: () => 0 });
    let calls = 0;
    const exec = () => {
      calls += 1;
      return { code: 1, stdout: "", stderr: "" };
    };
    const eligible = [blkTk("CTL-1", "CTL-99")];
    const a = hydrateOutOfSetBlockers(eligible, { exec, cache });
    const b = hydrateOutOfSetBlockers(eligible, { exec, cache });
    expect(a["CTL-99"]).toBe("__unfetched__");
    expect(b["CTL-99"]).toBe("__unfetched__");
    expect(calls).toBe(2); // never cached the failure
  });
});

// CTL-634 — schedulerTick threads the cache into hydration and logs per-tick
// stats. Asserting the observable cache counters (a log-line assertion is
// impractical under bun:test): one tick that hydrates an out-of-set blocker
// records exactly one cache miss.
describe("schedulerTick — cache stats (CTL-634)", () => {
  const blkTk = (id, blockedBy) => ({
    identifier: id,
    priority: 2,
    createdAt: "x",
    state: "Todo",
    relations: { nodes: [{ type: "blocked_by", relatedIssue: { identifier: blockedBy } }] },
    inverseRelations: { nodes: [] },
  });

  test("a tick that hydrates an out-of-set blocker records cache activity", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const cache = createTicketStateCache({ now: () => 0 });
    const dispatch = fakeDispatch({ code: 0 });
    const exec = () => ({
      code: 0,
      stdout: JSON.stringify({ state: { name: "Backlog" } }),
      stderr: "",
    });
    schedulerTick(orchDir, {
      readEligible: () => [blkTk("CTL-1", "CTL-99")],
      dispatch,
      exec,
      cache,
    });
    const s = cache.stats();
    expect(s.misses + s.hits).toBeGreaterThan(0); // the hydrate read went through the cache
  });
});

// ── Phase 5: the pull-loop daemon ──

describe("startScheduler / stopScheduler", () => {
  afterEach(() => __resetForTests());

  test("startScheduler runs one tick immediately", () => {
    const dispatch = fakeDispatch();
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    writeSignal("CTL-1", "triage", "done"); // research owed
    startScheduler({
      orchDir,
      dispatch,
      readEligible: () => [],
      tickIntervalMs: 60_000,
      debounceMs: 5,
    });
    expect(dispatch.calls).toEqual([{ orchDir, ticket: "CTL-1", phase: "research" }]);
  });

  // CTL-665: startScheduler's forward of the threaded `concurrency` into the
  // immediate runTick → schedulerTick is a trivial one-property pass-through
  // (runningOpts.concurrency), identical to the existing untested cache /
  // writeStatus forwards. It is covered transitively: the "new-work ceiling"
  // schedulerTick test (above) proves schedulerTick honors `concurrency`, and the
  // daemon "threads the concurrency knobs into startScheduler" test proves
  // startDaemon supplies it. A dedicated startScheduler dispatch-count assertion
  // is intentionally omitted — it can only observe `concurrency` through the
  // freeSlots-gated new-work pull, whose count depends on the live
  // countBackgroundAgents() shell-out (not injectable through startScheduler),
  // making such a test environment-fragile without adding coverage.

  test("the periodic timer fires another tick", async () => {
    const dispatch = fakeDispatch();
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    startScheduler({
      orchDir,
      dispatch,
      readEligible: () => [],
      tickIntervalMs: 20,
      debounceMs: 5,
    });
    writeSignal("CTL-2", "triage", "done"); // becomes owed after the first tick
    await waitFor(() => dispatch.calls.some((c) => c.ticket === "CTL-2"));
    expect(dispatch.calls.some((c) => c.ticket === "CTL-2")).toBe(true);
  });

  test("an event-log change triggers a debounced tick", async () => {
    const dispatch = fakeDispatch();
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    // Pre-create the event log so the later append is an in-place change
    // (fs.watch fires `change`), not a create (`rename`). In production the
    // event log always exists — workers append to it continuously.
    appendToEventLog("");
    startScheduler({
      orchDir,
      dispatch,
      readEligible: () => [],
      tickIntervalMs: 60_000,
      debounceMs: 10,
    });
    writeSignal("CTL-3", "triage", "done");
    const dispatched = () =>
      dispatch.calls.some((c) => c.ticket === "CTL-3" && c.phase === "research");
    // Appending to the event log must wake the scheduler. macOS FSEvents can
    // drop an append that lands before the watcher finishes registering, so
    // re-append once per poll — each append is a fresh chance for the watcher to
    // fire — instead of racing a single fixed sleep against watcher latency.
    await waitFor(dispatched, {
      intervalMs: 100,
      onTick: () => appendToEventLog('{"event":"phase.triage.complete.CTL-3"}\n'),
    });
    expect(dispatched()).toBe(true);
  });

  test("stopScheduler is idempotent and safe before start", () => {
    expect(() => {
      stopScheduler();
      stopScheduler();
    }).not.toThrow();
  });
});

// ── CTL-676: hot-reload concurrency knobs via per-tick re-read ──
//
// The scheduler stores `configPath` on `runningOpts` and, when set, re-reads
// `readExecutionCoreConcurrency(configPath)` at the top of every `runTick`
// instead of re-passing the boot-captured object. An edit to the config takes
// effect on the next debounced tick (≤2s under event-log activity) or the
// next periodic tick (≤30s in production; smaller in tests). When `configPath`
// is unset (back-compat scheduler harnesses), `runTick` re-passes
// `runningOpts.concurrency` exactly as before CTL-676.
describe("startScheduler — per-tick concurrency re-read (CTL-676)", () => {
  afterEach(() => __resetForTests());

  // Test 5 (back-compat hinge) — calling startScheduler without `configPath`
  // keeps the boot-captured concurrency object on every tick. Observable via
  // the dispatch ceiling: with `concurrency: { maxParallel: 2 }` and 3 eligible
  // ready tickets, exactly 2 dispatch on the first tick.
  test("configPath unset → boot-captured concurrency reaches schedulerTick (back-compat)", () => {
    const dispatch = fakeDispatch();
    const tk = (id, priority) => ({
      identifier: id,
      priority,
      createdAt: "x",
      state: "Todo",
      relations: { nodes: [] },
      inverseRelations: { nodes: [] },
    });
    startScheduler({
      orchDir,
      dispatch,
      readEligible: () => [tk("CTL-A", 1), tk("CTL-B", 2), tk("CTL-C", 3)],
      concurrency: { maxParallel: 2 },
      liveBackgroundCount: () => 0, // CTL-676: deterministic in-flight count
      tickIntervalMs: 60_000,
      debounceMs: 5,
    });
    // 2 dispatches (the ceiling), not 3 — proves runningOpts.concurrency
    // reached the schedulerTick call.
    expect(dispatch.calls.length).toBe(2);
  });

  // Test 1 (happy path) — editing the config file between two ticks raises
  // the slot ceiling on the next tick. The observation route is the dispatch
  // count under a controlled-size ready set, gated by readMaxParallel which
  // schedulerTick computes from the threaded `concurrency` object.
  test("editing the config raises the ceiling on the next tick", async () => {
    const configPath = join(orchDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        catalyst: { orchestration: { executionCore: { maxParallel: 1 } } },
      }),
    );
    // Pre-create the event log so a later append is an in-place `change`
    // (not a `rename` that some macOS hosts can drop). Mirrors the existing
    // "an event-log change triggers a debounced tick" test.
    appendToEventLog("");
    const dispatch = fakeDispatch();
    const tk = (id, priority) => ({
      identifier: id,
      priority,
      createdAt: "x",
      state: "Todo",
      relations: { nodes: [] },
      inverseRelations: { nodes: [] },
    });
    startScheduler({
      orchDir,
      dispatch,
      readEligible: () => [tk("CTL-A", 1), tk("CTL-B", 2), tk("CTL-C", 3)],
      configPath,
      liveBackgroundCount: () => 0, // CTL-676
      tickIntervalMs: 60_000,
      debounceMs: 10,
    });
    // First tick honored the file's maxParallel: 1 → exactly one dispatch.
    expect(dispatch.calls.length).toBe(1);
    const firstTicket = dispatch.calls[0].ticket;

    // Raise the ceiling. The already-dispatched ticket has a worker dir, so
    // the new-work pull will skip it; on the next tick we expect the next
    // two ranked tickets to dispatch.
    writeFileSync(
      configPath,
      JSON.stringify({
        catalyst: { orchestration: { executionCore: { maxParallel: 3 } } },
      }),
    );
    await waitFor(() => dispatch.calls.length >= 3, {
      intervalMs: 100,
      onTick: () => appendToEventLog('{"event":"wake.CTL-676"}\n'),
    });
    expect(dispatch.calls.length).toBe(3);
    // The originally-dispatched ticket is not re-dispatched (its worker dir
    // gates it out of the new-work pull).
    expect(dispatch.calls.filter((c) => c.ticket === firstTicket).length).toBe(1);
  });

  // Test 2 (in-flight safety) — lowering the ceiling does NOT kill the
  // already-dispatched worker; it gates only the next selectDispatchable
  // result. teardownWorktree is the seam that would tear down a worker.
  test("lowering the ceiling does not kill in-flight workers", async () => {
    const configPath = join(orchDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        catalyst: { orchestration: { executionCore: { maxParallel: 2 } } },
      }),
    );
    appendToEventLog("");
    const dispatch = fakeDispatch();
    const teardownCalls = [];
    const teardownWorktree = (args) => {
      teardownCalls.push(args);
    };
    const tk = (id, priority) => ({
      identifier: id,
      priority,
      createdAt: "x",
      state: "Todo",
      relations: { nodes: [] },
      inverseRelations: { nodes: [] },
    });
    startScheduler({
      orchDir,
      dispatch,
      teardownWorktree,
      readEligible: () => [tk("CTL-A", 1), tk("CTL-B", 2)],
      configPath,
      liveBackgroundCount: () => 0, // CTL-676
      tickIntervalMs: 60_000,
      debounceMs: 10,
    });
    expect(dispatch.calls.length).toBe(2);

    // Drop the ceiling below the in-flight count. The next tick must not
    // tear down or re-dispatch anything.
    writeFileSync(
      configPath,
      JSON.stringify({
        catalyst: { orchestration: { executionCore: { maxParallel: 1 } } },
      }),
    );
    // Burn a few wake cycles so a hypothetical teardown would have fired.
    for (let i = 0; i < 5; i++) {
      appendToEventLog('{"event":"wake.CTL-676.b"}\n');
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(teardownCalls.length).toBe(0);
    // No additional dispatches were issued either (no new eligible tickets,
    // and the in-flight ones gate themselves out of the pull).
    expect(dispatch.calls.length).toBe(2);
  });

  // Test 3 (invalid/partial new config falls back) — rewriting the file to
  // malformed JSON makes readExecutionCoreConcurrency return {}, so the next
  // tick falls back to state.json.maxParallel (here, 2) exactly as a fresh
  // boot against the same malformed config would.
  test("invalid new config falls back to state.json on the next tick", async () => {
    const configPath = join(orchDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        catalyst: { orchestration: { executionCore: { maxParallel: 1 } } },
      }),
    );
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    appendToEventLog("");
    const dispatch = fakeDispatch();
    const tk = (id, priority) => ({
      identifier: id,
      priority,
      createdAt: "x",
      state: "Todo",
      relations: { nodes: [] },
      inverseRelations: { nodes: [] },
    });
    startScheduler({
      orchDir,
      dispatch,
      readEligible: () => [tk("CTL-A", 1), tk("CTL-B", 2), tk("CTL-C", 3)],
      configPath,
      liveBackgroundCount: () => 0, // CTL-676
      tickIntervalMs: 60_000,
      debounceMs: 10,
    });
    // First tick: config wins → maxParallel = 1.
    expect(dispatch.calls.length).toBe(1);

    // Corrupt the config. Next tick must fall back to state.json (2).
    writeFileSync(configPath, "{ not json");
    await waitFor(() => dispatch.calls.length >= 2, {
      intervalMs: 100,
      onTick: () => appendToEventLog('{"event":"wake.CTL-676.c"}\n'),
    });
    // Exactly 2 (one before, one after) — config-absent ceiling of 2.
    expect(dispatch.calls.length).toBe(2);
  });

  // Test 4 (surface pinning) — the per-tick re-read only consults
  // `readExecutionCoreConcurrency`; out-of-scope fields in the new config
  // (here `dispatchMode`) cannot change scheduler behavior. We assert this
  // indirectly: an edit that flips `maxParallel` to 1 AND adds
  // `dispatchMode: "oneshot-legacy"` is honored for maxParallel (the next
  // tick gates dispatch to 1) and has no other visible effect on the
  // scheduler's choices.
  test("only readExecutionCoreConcurrency drives the per-tick re-read (no other fields)", async () => {
    const configPath = join(orchDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        catalyst: {
          orchestration: {
            executionCore: { maxParallel: 3, dispatchMode: "phase-agent" },
          },
        },
      }),
    );
    appendToEventLog("");
    const dispatch = fakeDispatch();
    const tk = (id, priority) => ({
      identifier: id,
      priority,
      createdAt: "x",
      state: "Todo",
      relations: { nodes: [] },
      inverseRelations: { nodes: [] },
    });
    startScheduler({
      orchDir,
      dispatch,
      readEligible: () => [tk("CTL-A", 1), tk("CTL-B", 2), tk("CTL-C", 3), tk("CTL-D", 4)],
      configPath,
      liveBackgroundCount: () => 0, // CTL-676
      tickIntervalMs: 60_000,
      debounceMs: 10,
    });
    expect(dispatch.calls.length).toBe(3);

    // Edit lowers maxParallel and flips dispatchMode. The maxParallel change
    // bites the next tick; dispatchMode is structural (not re-read) and is a
    // no-op here. The 3 in-flight tickets are still gated out of the pull,
    // and the 4th ticket cannot dispatch because freeSlots = max(0, 1-3) = 0.
    writeFileSync(
      configPath,
      JSON.stringify({
        catalyst: {
          orchestration: {
            executionCore: { maxParallel: 1, dispatchMode: "oneshot-legacy" },
          },
        },
      }),
    );
    for (let i = 0; i < 5; i++) {
      appendToEventLog('{"event":"wake.CTL-676.d"}\n');
      await new Promise((r) => setTimeout(r, 30));
    }
    // Still 3 — the 4th ticket did not dispatch under the lower ceiling.
    expect(dispatch.calls.length).toBe(3);
  });
});

// ── CTL-678: per-tick Layer-2 hot-reload — extends CTL-676 ──
//
// CTL-676 hot-reloads the Layer-1 config every tick. CTL-678 layers a
// machine-canonical Layer-2 override on top: when `layer2Path` is wired in
// alongside `configPath`, runTick reads BOTH files per tick and merges
// Layer-2 over Layer-1 per field. An edit to either file takes effect on the
// next debounced tick — no daemon restart.
describe("startScheduler — per-tick Layer-2 merge (CTL-678)", () => {
  afterEach(() => __resetForTests());

  const tk = (id, priority) => ({
    identifier: id,
    priority,
    createdAt: "x",
    state: "Todo",
    relations: { nodes: [] },
    inverseRelations: { nodes: [] },
  });

  // Boot-time precedence: with both files present, Layer-2 wins per field on
  // the very first tick. Observable via the dispatch ceiling.
  test("Layer-2 maxParallel wins on the first tick when both files present", () => {
    const configPath = join(orchDir, "config.json");
    const layer2Path = join(orchDir, "layer2.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        catalyst: { orchestration: { executionCore: { maxParallel: 1 } } },
      }),
    );
    writeFileSync(
      layer2Path,
      JSON.stringify({
        catalyst: { orchestration: { executionCore: { maxParallel: 3 } } },
      }),
    );
    const dispatch = fakeDispatch();
    startScheduler({
      orchDir,
      dispatch,
      readEligible: () => [tk("CTL-A", 1), tk("CTL-B", 2), tk("CTL-C", 3)],
      configPath,
      layer2Path,
      liveBackgroundCount: () => 0,
      tickIntervalMs: 60_000,
      debounceMs: 5,
    });
    // Layer-2 ceiling 3, not Layer-1 ceiling 1.
    expect(dispatch.calls.length).toBe(3);
  });

  // Hot-reload: editing the Layer-2 file between ticks raises the ceiling
  // on the next tick — proves the per-tick re-read pulls Layer-2 too.
  test("editing Layer-2 raises the ceiling on the next tick", async () => {
    const configPath = join(orchDir, "config.json");
    const layer2Path = join(orchDir, "layer2.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        catalyst: { orchestration: { executionCore: { maxParallel: 1 } } },
      }),
    );
    writeFileSync(
      layer2Path,
      JSON.stringify({
        catalyst: { orchestration: { executionCore: { maxParallel: 1 } } },
      }),
    );
    appendToEventLog("");
    const dispatch = fakeDispatch();
    startScheduler({
      orchDir,
      dispatch,
      readEligible: () => [tk("CTL-A", 1), tk("CTL-B", 2), tk("CTL-C", 3)],
      configPath,
      layer2Path,
      liveBackgroundCount: () => 0,
      tickIntervalMs: 60_000,
      debounceMs: 10,
    });
    expect(dispatch.calls.length).toBe(1);

    writeFileSync(
      layer2Path,
      JSON.stringify({
        catalyst: { orchestration: { executionCore: { maxParallel: 3 } } },
      }),
    );
    await waitFor(() => dispatch.calls.length >= 3, {
      intervalMs: 100,
      onTick: () => appendToEventLog('{"event":"wake.CTL-678"}\n'),
    });
    expect(dispatch.calls.length).toBe(3);
  });

  // Back-compat: layer2Path unset → byte-for-byte CTL-676 behavior (Layer-1
  // only). The merger's both-empty path returns Layer-1 verbatim.
  test("layer2Path unset → Layer-1 reaches schedulerTick (CTL-676 back-compat)", () => {
    const configPath = join(orchDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        catalyst: { orchestration: { executionCore: { maxParallel: 2 } } },
      }),
    );
    const dispatch = fakeDispatch();
    startScheduler({
      orchDir,
      dispatch,
      readEligible: () => [tk("CTL-A", 1), tk("CTL-B", 2), tk("CTL-C", 3)],
      configPath,
      // layer2Path intentionally omitted
      liveBackgroundCount: () => 0,
      tickIntervalMs: 60_000,
      debounceMs: 5,
    });
    // Layer-1 ceiling 2 reached schedulerTick — no Layer-2 path, no merge work.
    expect(dispatch.calls.length).toBe(2);
  });
});

// ── CTL-539: idempotent-dispatch proof — re-deriving the tick after a
// "crash" can never double-dispatch the same {ticket, phase} ──

describe("CTL-539 — idempotent dispatch across a crash", () => {
  const tk = (id, priority = 2) => ({
    identifier: id,
    priority,
    createdAt: "x",
    state: "Todo",
    relations: { nodes: [] },
    inverseRelations: { nodes: [] },
  });

  test("re-running schedulerTick after a 'crash' never dispatches the same {ticket,phase} twice", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    const eligible = [tk("CTL-9")];

    // Tick 1 — dispatches the new-work entry phase (research, CTL-565) for the
    // ready ticket. The stub writes the dispatched signal the real
    // phase-agent-dispatch would have written BEFORE spawning claude --bg
    // (signal-first ordering).
    const calls = [];
    const dispatch = (args) => {
      calls.push(`${args.ticket}:${args.phase}`);
      writeSignal(args.ticket, args.phase, "dispatched");
      return { code: 0, stdout: "", stderr: "" };
    };
    // CTL-611: inject verifyOk — the stub writes status:"dispatched" with no
    // bg_job_id (the intermediate state phase-agent-dispatch leaves before
    // spawn at :406). The verifier correctly rejects that shape; the real
    // dispatch only returns AFTER status flips to running + bg_job_id is set.
    // The idempotency proof here is orthogonal to verification.
    const r1 = schedulerTick(orchDir, {
      readEligible: () => eligible,
      dispatch,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
    });
    expect(r1.dispatched).toEqual(["CTL-9"]);

    // "Crash" — the daemon dies; the dispatched signal survives on disk.
    // Tick 2 (post-restart) re-derives everything from the filesystem.
    const r2 = schedulerTick(orchDir, {
      readEligible: () => eligible,
      dispatch,
      verifyDispatched: verifyOk,
    });

    // CTL-9 now has a worker dir → excluded from the pull. research:dispatched
    // is not 'done' → deriveAdvancement returns null. No re-dispatch.
    expect(r2.dispatched).toEqual([]);
    expect(r2.advanced).toEqual([]);
    // Every {ticket,phase} appears exactly once across both ticks.
    const byKey = new Map();
    for (const k of calls) byKey.set(k, (byKey.get(k) ?? 0) + 1);
    expect([...byKey.values()].every((n) => n === 1)).toBe(true);
    expect(calls).toEqual(["CTL-9:research"]);
  });

  test("an orphan 'dispatched' signal (bg_job_id:null) is not re-dispatched", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    // Pre-write the orphan signal a crash mid-dispatch leaves: the signal was
    // written but claude --bg never spawned, so bg_job_id is null.
    const dir = join(orchDir, "workers", "CTL-7");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "phase-triage.json"),
      JSON.stringify({
        ticket: "CTL-7",
        phase: "triage",
        status: "dispatched",
        bg_job_id: null,
      })
    );
    const dispatch = fakeDispatch();
    const r = schedulerTick(orchDir, {
      readEligible: () => [tk("CTL-7")],
      dispatch,
    });
    // CTL-7 has a worker dir → excluded from the new-work pull; triage is
    // dispatched (not done) → nothing owed. The orphan is not re-dispatched.
    expect(dispatch.calls).toHaveLength(0);
    expect(r.dispatched).toEqual([]);
    expect(r.advanced).toEqual([]);
  });
});

// ── CTL-558: deterministic Linear status write-back from the scheduler ──

describe("schedulerTick — Linear status write-back (CTL-558)", () => {
  const readyTicket = (id, priority = 2) => ({
    identifier: id,
    priority,
    createdAt: "x",
    state: "Todo",
    relations: { nodes: [] },
    inverseRelations: { nodes: [] },
  });
  const okDispatch = fakeDispatch();
  const failDispatch = fakeDispatch({ code: 1 });

  test("writes the dispatched phase's status after a successful advancement dispatch", () => {
    // research done → advancement owes `plan`
    writeSignal("CTL-1", "research", "done");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    const writes = [];
    const writeStatus = {
      applyPhaseStatus: (a) => writes.push(a),
      applyTerminalDone: () => {},
      applyLabel: () => {},
    };
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: okDispatch,
      writeStatus,
      verifyDispatched: verifyOk, // CTL-611
    });
    expect(writes).toContainEqual(expect.objectContaining({ ticket: "CTL-1", phase: "plan" }));
  });

  test("writes `research` status for a new-work pull dispatch", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const writes = [];
    const writeStatus = {
      applyPhaseStatus: (a) => writes.push(a),
      applyTerminalDone: () => {},
      applyLabel: () => {},
    };
    schedulerTick(orchDir, {
      readEligible: () => [readyTicket("CTL-2")],
      dispatch: okDispatch,
      writeStatus,
      verifyDispatched: verifyOk, // CTL-611
      liveBackgroundCount: () => 0,
    });
    expect(writes).toContainEqual(expect.objectContaining({ ticket: "CTL-2", phase: "research" }));
  });

  test("does NOT write status when the dispatch fails", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const writes = [];
    const writeStatus = {
      applyPhaseStatus: (a) => writes.push(a),
      applyTerminalDone: () => {},
      applyLabel: () => {},
    };
    schedulerTick(orchDir, {
      readEligible: () => [readyTicket("CTL-3")],
      dispatch: failDispatch,
      writeStatus,
    });
    expect(writes).toHaveLength(0);
  });

  test("writes terminal Done when a ticket's monitor-deploy signal is done", () => {
    writeSignal("CTL-4", "monitor-deploy", "done");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dones = [];
    const writeStatus = {
      applyPhaseStatus: () => {},
      applyTerminalDone: (a) => dones.push(a),
      applyLabel: () => {},
    };
    schedulerTick(orchDir, { readEligible: () => [], dispatch: okDispatch, writeStatus });
    expect(dones).toContainEqual(expect.objectContaining({ ticket: "CTL-4" }));
  });

  test("writes terminal Done when a ticket's monitor-deploy signal is skipped (CTL-589)", () => {
    // CTL-512 fixed isTicketInFlight to treat `skipped` as terminal; this is
    // the matching half — the terminal-Done sweep must also fire on `skipped`
    // so the Linear ticket actually lands at Done (not stale at PR).
    writeSignal("CTL-4", "monitor-deploy", "skipped");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dones = [];
    const writeStatus = {
      applyPhaseStatus: () => {},
      applyTerminalDone: (a) => dones.push(a),
      applyLabel: () => {},
    };
    schedulerTick(orchDir, { readEligible: () => [], dispatch: okDispatch, writeStatus });
    expect(dones).toContainEqual(expect.objectContaining({ ticket: "CTL-4" }));
  });

  test("a status-write throw never aborts the tick", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const writeStatus = {
      applyPhaseStatus: () => {
        throw new Error("boom");
      },
      applyTerminalDone: () => {},
      applyLabel: () => {},
    };
    expect(() =>
      schedulerTick(orchDir, {
        readEligible: () => [readyTicket("CTL-5")],
        dispatch: okDispatch,
        writeStatus,
      })
    ).not.toThrow();
  });
});

// ── CTL-558: deterministic label write-back (needs-human) ──

describe("schedulerTick — label write-back (CTL-558)", () => {
  const noWrites = () => ({
    applyPhaseStatus() {},
    applyTerminalDone() {},
  });

  test("applies `needs-human` when any phase signal is stalled", () => {
    writeSignal("CTL-7", "implement", "stalled");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const labels = [];
    const writeStatus = { ...noWrites(), applyLabel: (a) => labels.push(a) };
    schedulerTick(orchDir, { readEligible: () => [], dispatch: fakeDispatch(), writeStatus });
    expect(labels).toContainEqual(
      expect.objectContaining({ ticket: "CTL-7", label: "needs-human" })
    );
  });

  test("does not re-apply a label once the .applied marker exists", () => {
    writeSignal("CTL-7", "implement", "stalled");
    writeFileSync(join(orchDir, "workers", "CTL-7", ".linear-label-needs-human.applied"), "");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const labels = [];
    const writeStatus = { ...noWrites(), applyLabel: (a) => labels.push(a) };
    schedulerTick(orchDir, { readEligible: () => [], dispatch: fakeDispatch(), writeStatus });
    expect(labels).toHaveLength(0);
  });

  test("writes the .applied marker only after applyLabel reports applied:true", () => {
    writeSignal("CTL-8", "implement", "stalled");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const markerPath = join(orchDir, "workers", "CTL-8", ".linear-label-needs-human.applied");
    // applyLabel reports failure → no marker written → retried next tick.
    const failWrite = { ...noWrites(), applyLabel: () => ({ applied: false }) };
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus: failWrite,
    });
    expect(existsSync(markerPath)).toBe(false);
    // applyLabel succeeds → marker written → not retried.
    const okWrite = { ...noWrites(), applyLabel: () => ({ applied: true }) };
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus: okWrite,
    });
    expect(existsSync(markerPath)).toBe(true);
  });

  test("a label-write throw never aborts the tick", () => {
    writeSignal("CTL-9", "implement", "stalled");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const writeStatus = {
      ...noWrites(),
      applyLabel: () => {
        throw new Error("label boom");
      },
    };
    expect(() =>
      schedulerTick(orchDir, { readEligible: () => [], dispatch: fakeDispatch(), writeStatus })
    ).not.toThrow();
  });

  // CTL-585: short-circuit the per-tick retry on an unrecoverable miss.
  test("writes the .skipped marker on reason:'missing-label' and stops retrying", () => {
    writeSignal("CTL-10", "implement", "stalled");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const skipped = join(orchDir, "workers", "CTL-10", ".linear-label-needs-human.skipped");
    const applied = join(orchDir, "workers", "CTL-10", ".linear-label-needs-human.applied");

    let calls = 0;
    const writeStatus = {
      ...noWrites(),
      applyLabel: () => {
        calls += 1;
        return { applied: false, reason: "missing-label" };
      },
    };

    // Tick 1: missing-label → .skipped written, .applied not written.
    schedulerTick(orchDir, { readEligible: () => [], dispatch: fakeDispatch(), writeStatus });
    expect(existsSync(skipped)).toBe(true);
    expect(existsSync(applied)).toBe(false);
    expect(calls).toBe(1);

    // Tick 2: marker present → applyLabel never invoked again.
    schedulerTick(orchDir, { readEligible: () => [], dispatch: fakeDispatch(), writeStatus });
    expect(calls).toBe(1);
  });

  test("a transient failure still retries on the next tick", () => {
    writeSignal("CTL-11", "implement", "stalled");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const skipped = join(orchDir, "workers", "CTL-11", ".linear-label-needs-human.skipped");

    let calls = 0;
    const writeStatus = {
      ...noWrites(),
      applyLabel: () => {
        calls += 1;
        return { applied: false, reason: "transient" };
      },
    };

    schedulerTick(orchDir, { readEligible: () => [], dispatch: fakeDispatch(), writeStatus });
    schedulerTick(orchDir, { readEligible: () => [], dispatch: fakeDispatch(), writeStatus });
    expect(calls).toBe(2);
    expect(existsSync(skipped)).toBe(false);
  });

  test("a rate-limited failure still retries on the next tick", () => {
    writeSignal("CTL-12", "implement", "stalled");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    let calls = 0;
    const writeStatus = {
      ...noWrites(),
      applyLabel: () => {
        calls += 1;
        return { applied: false, reason: "rate-limited" };
      },
    };
    schedulerTick(orchDir, { readEligible: () => [], dispatch: fakeDispatch(), writeStatus });
    schedulerTick(orchDir, { readEligible: () => [], dispatch: fakeDispatch(), writeStatus });
    expect(calls).toBe(2);
  });

  test("a pre-existing .skipped marker prevents re-attempt", () => {
    writeSignal("CTL-13", "implement", "stalled");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    // Pre-seed the .skipped marker (simulates a previous daemon run that hit
    // the missing-label path).
    writeFileSync(join(orchDir, "workers", "CTL-13", ".linear-label-needs-human.skipped"), "");
    let calls = 0;
    const writeStatus = {
      ...noWrites(),
      applyLabel: () => {
        calls += 1;
        return { applied: true, reason: null };
      },
    };
    schedulerTick(orchDir, { readEligible: () => [], dispatch: fakeDispatch(), writeStatus });
    expect(calls).toBe(0);
  });
});

// ── CTL-582: worktree teardown on terminal Done ──

describe("schedulerTick — worktree teardown on Done (CTL-582)", () => {
  // teardownWorktreeOnce resolves repoRoot from the registry; write a fixture
  // under the test's CATALYST_DIR so the resolution succeeds.
  function writeRegistry(team, repoRoot) {
    const ecDir = join(catalystDir, "execution-core");
    mkdirSync(ecDir, { recursive: true });
    writeFileSync(
      join(ecDir, "registry.json"),
      JSON.stringify({ projects: [{ team, repoRoot, eligibleQuery: {} }] })
    );
  }
  const noStatusWrites = () => ({
    applyPhaseStatus() {},
    applyTerminalDone() {},
    applyLabel() {},
  });
  const markerPath = (ticket) => join(orchDir, "workers", ticket, ".worktree-removed");

  test("calls teardownWorktree with { repoRoot, ticket } when monitor-deploy is done", () => {
    writeSignal("CTL-4", "monitor-deploy", "done");
    writeRegistry("CTL", "/repo/ctl");
    const calls = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus: noStatusWrites(),
      teardownWorktree: (a) => {
        calls.push(a);
        return true;
      },
    });
    expect(calls).toEqual([{ repoRoot: "/repo/ctl", ticket: "CTL-4" }]);
  });

  test("calls teardownWorktree when monitor-deploy is skipped (CTL-589)", () => {
    // CTL-512 followup — `skipped` is the second terminal status for
    // monitor-deploy; without this, the worktree leaks on disk forever for
    // tickets whose deploy verification was skipped.
    writeSignal("CTL-4", "monitor-deploy", "skipped");
    writeRegistry("CTL", "/repo/ctl");
    const calls = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus: noStatusWrites(),
      teardownWorktree: (a) => {
        calls.push(a);
        return true;
      },
    });
    expect(calls).toEqual([{ repoRoot: "/repo/ctl", ticket: "CTL-4" }]);
  });

  test("a once-marker makes teardown fire a single time across ticks", () => {
    writeSignal("CTL-4", "monitor-deploy", "done");
    writeRegistry("CTL", "/repo/ctl");
    let count = 0;
    const opts = {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus: noStatusWrites(),
      teardownWorktree: () => {
        count += 1;
        return true;
      },
    };
    schedulerTick(orchDir, opts);
    schedulerTick(orchDir, opts);
    expect(count).toBe(1);
    expect(existsSync(markerPath("CTL-4"))).toBe(true);
  });

  test("a teardown that returns false is retried — no once-marker written", () => {
    writeSignal("CTL-4", "monitor-deploy", "done");
    writeRegistry("CTL", "/repo/ctl");
    let count = 0;
    const opts = {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus: noStatusWrites(),
      teardownWorktree: () => {
        count += 1;
        return false; // git failure — not yet torn down
      },
    };
    schedulerTick(orchDir, opts);
    schedulerTick(orchDir, opts);
    expect(count).toBe(2);
    expect(existsSync(markerPath("CTL-4"))).toBe(false);
  });

  test("a thrown teardown never aborts the tick", () => {
    writeSignal("CTL-4", "monitor-deploy", "done");
    writeRegistry("CTL", "/repo/ctl");
    expect(() =>
      schedulerTick(orchDir, {
        readEligible: () => [],
        dispatch: fakeDispatch(),
        writeStatus: noStatusWrites(),
        teardownWorktree: () => {
          throw new Error("boom");
        },
      })
    ).not.toThrow();
  });

  test("no teardown when the ticket has not reached terminal Done", () => {
    writeSignal("CTL-5", "implement", "done"); // mid-pipeline, not monitor-deploy
    writeRegistry("CTL", "/repo/ctl");
    let called = false;
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus: noStatusWrites(),
      teardownWorktree: () => {
        called = true;
        return true;
      },
    });
    expect(called).toBe(false);
  });

  test("no teardown + no marker when the ticket's team has no registry entry", () => {
    writeSignal("CTL-4", "monitor-deploy", "done");
    // deliberately no writeRegistry — getProjectConfig("CTL") resolves to null
    let called = false;
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus: noStatusWrites(),
      teardownWorktree: () => {
        called = true;
        return true;
      },
    });
    expect(called).toBe(false);
    expect(existsSync(markerPath("CTL-4"))).toBe(false); // retryable — no marker
  });
});

// --- CTL-574: reclaim-dead-work step in schedulerTick -----------------------

describe("schedulerTick — CTL-574 reclaim-dead-work sweep", () => {
  // writeNestedSignal — write a worker signal with the full shape signal-reader
  // produces (status + bg_job_id), so classifyWorker can be driven by the real
  // pipeline. The reclaim path uses this signal's phase + ticket.
  function writeNestedSignal(ticket, phase, body) {
    const dir = join(orchDir, "workers", ticket);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `phase-${phase}.json`), JSON.stringify({ ticket, phase, ...body }));
  }

  test("schedulerTick calls the injected reclaimDeadWork once per worker signal", () => {
    // Two in-flight tickets with a single phase signal each — readWorkerSignals
    // returns one (active) per ticket, so reclaimDeadWork is called twice.
    writeNestedSignal("CTL-1", "implement", { status: "running", bg_job_id: "j1" });
    writeNestedSignal("CTL-2", "implement", { status: "running", bg_job_id: "j2" });

    const reclaimDeadWork = recorder("noop");
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      writeStatus: { applyPhaseStatus: () => {}, applyTerminalDone: () => {} },
      teardownWorktree: () => true,
      reclaimDeadWork,
    });
    expect(reclaimDeadWork.calls.length).toBe(2);
    // each call gets (orchDir, signal, { repoRoot }).
    for (const args of reclaimDeadWork.calls) {
      expect(args[0]).toBe(orchDir);
      expect(args[1].phase).toBe("implement");
      expect(["CTL-1", "CTL-2"]).toContain(args[1].ticket);
      expect(typeof args[2]).toBe("object");
      expect(args[2]).toHaveProperty("repoRoot");
    }
  });

  test("a 'reclaimed' result flips the signal (via emit-complete) so advancement fires the next phase same tick", () => {
    // The reclaim's emit-complete spawns phase-agent-emit-complete which flips
    // the signal on disk. In this unit test we don't actually run that script,
    // so we simulate it by mutating the on-disk signal inside the injected
    // reclaimDeadWork itself — the canonical "reclaim outcome" the production
    // path produces.
    writeNestedSignal("CTL-1", "implement", { status: "running", bg_job_id: "j1" });
    writeNestedSignal("CTL-1", "research", { status: "done" });
    writeNestedSignal("CTL-1", "plan", { status: "done" });
    writeNestedSignal("CTL-1", "triage", { status: "done" });

    const reclaimDeadWork = (_orchDir, sig) => {
      // simulate the emit-complete signal flip
      const signalPath = join(orchDir, "workers", sig.ticket, `phase-${sig.phase}.json`);
      writeFileSync(
        signalPath,
        JSON.stringify({ ticket: sig.ticket, phase: sig.phase, status: "done", completedAt: "t" })
      );
      return "reclaimed";
    };
    const dispatch = recorder({ code: 0 });
    const writeStatus = { applyPhaseStatus: () => {}, applyTerminalDone: () => {} };

    const result = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      writeStatus,
      teardownWorktree: () => true,
      reclaimDeadWork,
      verifyDispatched: verifyOk, // CTL-611: not testing dispatch verification
    });

    // Advancement saw the reclaimed implement: dispatch was called with the
    // next phase (`verify`) for CTL-1. dispatchTicket invokes the seam as
    // `dispatch({ orchDir, ticket, phase })`, so calls[i][0] is the object.
    const verifyDispatches = dispatch.calls.filter((args) => args[0]?.phase === "verify");
    expect(verifyDispatches.length).toBe(1);
    expect(verifyDispatches[0][0].ticket).toBe("CTL-1");

    // The tick's return object reports the reclaim alongside the advance.
    expect(result.reclaimed).toEqual([{ ticket: "CTL-1", phase: "implement" }]);
    expect(result.advanced).toEqual([{ ticket: "CTL-1", phase: "verify" }]);
  });

  test("a 'noop' / 'not-done' / 'not-applicable' result is invisible to advancement", () => {
    writeNestedSignal("CTL-1", "implement", { status: "running", bg_job_id: "j1" });

    // reclaim returns not-done — signal stays running, advancement skips.
    const reclaimDeadWork = () => "not-done";
    const dispatch = recorder({ code: 0 });
    const result = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      writeStatus: { applyPhaseStatus: () => {}, applyTerminalDone: () => {} },
      teardownWorktree: () => true,
      reclaimDeadWork,
    });
    expect(dispatch.calls.length).toBe(0);
    expect(result.reclaimed).toEqual([]);
  });

  test("default reclaimDeadWork is wired to the real recovery function (no injection still safe)", () => {
    // No injected reclaimDeadWork. With no dead workers in the fixture, the
    // real reclaim short-circuits to 'noop' for every signal and the tick is
    // a normal-path no-op. This proves the default seam doesn't throw on a
    // clean tick.
    expect(() =>
      schedulerTick(orchDir, {
        readEligible: () => [],
        dispatch: () => ({ code: 0 }),
        writeStatus: { applyPhaseStatus: () => {}, applyTerminalDone: () => {} },
        teardownWorktree: () => true,
      })
    ).not.toThrow();
  });
});

// CTL-702: per-worker error isolation in schedulerTick reclaim sweep.
describe("schedulerTick — per-worker error isolation (CTL-702)", () => {
  function writeNestedSignal(ticket, phase, body) {
    const dir = join(orchDir, "workers", ticket);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `phase-${phase}.json`), JSON.stringify({ ticket, phase, ...body }));
  }

  test("schedulerTick continues past one worker's per-worker exception", () => {
    // Two in-flight worker dirs. reclaimDeadWork throws for CTL-BAD-702 — the
    // tick must survive and still process CTL-GOOD-702.
    writeNestedSignal("CTL-GOOD-702", "plan", { status: "running", bg_job_id: "j1" });
    writeNestedSignal("CTL-BAD-702", "plan", { status: "running", bg_job_id: "j2" });

    const processedTickets = [];
    const reclaimDeadWork = (_orchDir, sig) => {
      if (sig.ticket === "CTL-BAD-702") throw new Error("injected crash for CTL-BAD-702");
      processedTickets.push(sig.ticket);
      return "noop";
    };

    expect(() => {
      schedulerTick(orchDir, {
        reclaimDeadWork,
        readEligible: () => [],
        dispatch: () => ({ code: 1 }),
      });
    }).not.toThrow();

    expect(processedTickets).toContain("CTL-GOOD-702");
  });

  test("schedulerTick emits yield-file-skip once per observed yield file (CTL-702)", () => {
    // Worker dir with one yield tombstone. schedulerTick emits once on the first
    // tick and nothing on the second (same absolute path already in the observed set).
    const dir = join(orchDir, "workers", "CTL-YIELD-702");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "phase-plan.json"), JSON.stringify({ ticket: "CTL-YIELD-702", phase: "plan", status: "done" }));
    writeFileSync(join(dir, "phase-plan-yield-20260528T050740Z.json"), JSON.stringify({}));

    const emits = [];
    schedulerTick(orchDir, {
      appendYieldFileSkipEvent: (args) => { emits.push(args); return true; },
      readEligible: () => [],
      dispatch: () => ({ code: 1 }),
    });
    expect(emits).toHaveLength(1);
    expect(emits[0]).toMatchObject({
      ticket: "CTL-YIELD-702",
      filename: "phase-plan-yield-20260528T050740Z.json",
    });
    // Second tick with same seam — same absolute path, no second emit.
    schedulerTick(orchDir, {
      appendYieldFileSkipEvent: (args) => { emits.push(args); return true; },
      readEligible: () => [],
      dispatch: () => ({ code: 1 }),
    });
    expect(emits).toHaveLength(1);
  });
});

// CTL-587: scheduler Step 0 returns parallel arrays for the new outcomes
// from reclaimDeadWorkIfPossible — revived, reviveSuppressed, escalated —
// alongside the pre-existing reclaimed[]. Existing consumers that ignore
// unknown keys are unaffected.
describe("schedulerTick — CTL-587 Step 0 multi-result shape", () => {
  function writeNestedSignal(ticket, phase, body) {
    const dir = join(orchDir, "workers", ticket);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `phase-${phase}.json`), JSON.stringify({ ticket, phase, ...body }));
  }

  const writeStatus = {
    applyPhaseStatus: () => {},
    applyTerminalDone: () => {},
    applyLabel: () => ({ applied: true }),
  };

  test("'revived' result populates result.revived (and leaves reclaimed empty)", () => {
    writeNestedSignal("CTL-7", "implement", { status: "running", bg_job_id: "bg-7" });
    const result = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      writeStatus,
      teardownWorktree: () => true,
      reclaimDeadWork: () => "revived",
    });
    expect(result.revived).toEqual([{ ticket: "CTL-7", phase: "implement" }]);
    expect(result.reclaimed).toEqual([]);
    expect(result.escalated).toEqual([]);
    expect(result.reviveSuppressed).toEqual([]);
  });

  test("'revive-suppressed' result populates result.reviveSuppressed", () => {
    writeNestedSignal("CTL-8", "implement", { status: "running", bg_job_id: "bg-8" });
    const result = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      writeStatus,
      teardownWorktree: () => true,
      reclaimDeadWork: () => "revive-suppressed",
    });
    expect(result.reviveSuppressed).toEqual([{ ticket: "CTL-8", phase: "implement" }]);
    expect(result.revived).toEqual([]);
  });

  test("'escalated' result populates result.escalated", () => {
    writeNestedSignal("CTL-9", "pr", { status: "running", bg_job_id: "bg-9" });
    const result = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      writeStatus,
      teardownWorktree: () => true,
      reclaimDeadWork: () => "escalated",
    });
    expect(result.escalated).toEqual([{ ticket: "CTL-9", phase: "pr" }]);
  });

  test("mixed returns across multiple signals end up in the right buckets", () => {
    writeNestedSignal("CTL-7", "implement", { status: "running", bg_job_id: "bg-7" });
    writeNestedSignal("CTL-8", "implement", { status: "running", bg_job_id: "bg-8" });
    writeNestedSignal("CTL-9", "pr", { status: "running", bg_job_id: "bg-9" });
    const reclaimDeadWork = (_orchDir, sig) => {
      if (sig.ticket === "CTL-7") return "revived";
      if (sig.ticket === "CTL-8") return "reclaimed";
      if (sig.ticket === "CTL-9") return "escalated";
      return "noop";
    };
    const result = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      writeStatus,
      teardownWorktree: () => true,
      reclaimDeadWork,
    });
    expect(result.revived).toEqual([{ ticket: "CTL-7", phase: "implement" }]);
    expect(result.escalated).toEqual([{ ticket: "CTL-9", phase: "pr" }]);
    // reclaimed: emit-complete is stubbed via the seam, but the canonical
    // path mutates the signal — we just check the array is populated.
    expect(result.reclaimed.map((e) => e.ticket)).toContain("CTL-8");
  });

  test("CTL-610: 'alive-quiet-suppressed' is invisible by design — no crash, not in any bucket", () => {
    // The alive-quiet guard exists precisely to suppress noise. Bucketing it
    // explicitly into result.revived / .reviveSuppressed / .escalated would
    // re-create the very revive-storm reporting the guard exists to eliminate.
    // It MUST handle the case without crashing, and MUST NOT populate any of
    // the visible buckets — the next tick re-evaluates.
    writeNestedSignal("CTL-10", "implement", { status: "running", bg_job_id: "bg-10" });
    const result = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      writeStatus,
      teardownWorktree: () => true,
      reclaimDeadWork: () => "alive-quiet-suppressed",
    });
    expect(result.revived).toEqual([]);
    expect(result.reviveSuppressed).toEqual([]);
    expect(result.escalated).toEqual([]);
    expect(result.reclaimed).toEqual([]);
  });

  test("clean tick (no dead workers) returns empty arrays for every CTL-587 outcome", () => {
    const result = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      writeStatus,
      teardownWorktree: () => true,
      reclaimDeadWork: () => "noop",
    });
    expect(result.revived).toEqual([]);
    expect(result.reviveSuppressed).toEqual([]);
    expect(result.escalated).toEqual([]);
    expect(result.reclaimed).toEqual([]);
  });
});

// CTL-643: the step-0 reclaim sweep filters out terminal tickets, so
// reclaimDeadWork is never invoked for them. reclaimDeadWorkIfPossible already
// short-circuits on terminal signals at recovery.mjs (~1009); pre-filtering here
// eliminates iteration cost + the log/audit churn that fed the HUD escalation
// storm (2/min) and lets the per-tick cost match the in-flight set size, not
// the started-ticket set size.
describe("schedulerTick — CTL-643 terminal-ticket reclaim filter", () => {
  function writeNestedSignal(ticket, phase, body) {
    const dir = join(orchDir, "workers", ticket);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `phase-${phase}.json`), JSON.stringify({ ticket, phase, ...body }));
  }

  const writeStatus = {
    applyPhaseStatus: () => {},
    applyTerminalDone: () => {},
    applyLabel: () => ({ applied: true }),
  };

  test("reclaimDeadWork is called for in-flight tickets only, never for terminal ones", () => {
    writeNestedSignal("CTL-A", "implement", { status: "running", bg_job_id: "bg-a" });
    writeNestedSignal("CTL-B", "monitor-deploy", { status: "done" });
    writeNestedSignal("CTL-C", "verify", { status: "failed" });

    const reclaimDeadWork = recorder("noop");
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      writeStatus,
      teardownWorktree: () => true,
      reclaimDeadWork,
    });

    const seenTickets = reclaimDeadWork.calls.map((args) => args[1].ticket);
    expect(seenTickets).toContain("CTL-A");
    expect(seenTickets).not.toContain("CTL-B");
    expect(seenTickets).not.toContain("CTL-C");
    expect(reclaimDeadWork.calls.length).toBe(1);
  });

  test("preserves the existing result shape (reclaimed/revived/reviveSuppressed/escalated)", () => {
    writeNestedSignal("CTL-A", "implement", { status: "running", bg_job_id: "bg-a" });
    writeNestedSignal("CTL-B", "monitor-deploy", { status: "done" });

    const r = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      writeStatus,
      teardownWorktree: () => true,
      reclaimDeadWork: () => "noop",
    });

    expect(Array.isArray(r.reclaimed)).toBe(true);
    expect(Array.isArray(r.revived)).toBe(true);
    expect(Array.isArray(r.reviveSuppressed)).toBe(true);
    expect(Array.isArray(r.escalated)).toBe(true);
  });

  test("skips the loop entirely when no tickets are in-flight (all terminal)", () => {
    writeNestedSignal("CTL-B", "monitor-deploy", { status: "done" });
    writeNestedSignal("CTL-C", "verify", { status: "failed" });

    const reclaimDeadWork = recorder("noop");
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      writeStatus,
      teardownWorktree: () => true,
      reclaimDeadWork,
    });

    expect(reclaimDeadWork.calls.length).toBe(0);
  });

  test("filters out aborted/stalled tickets (slot-freeing per isTicketInFlight)", () => {
    writeNestedSignal("CTL-A", "implement", { status: "running", bg_job_id: "bg-a" });
    writeNestedSignal("CTL-D", "implement", { status: "aborted" });
    writeNestedSignal("CTL-E", "implement", { status: "stalled" });

    const reclaimDeadWork = recorder("noop");
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      writeStatus,
      teardownWorktree: () => true,
      reclaimDeadWork,
    });

    const seen = reclaimDeadWork.calls.map((args) => args[1].ticket);
    expect(seen).toEqual(["CTL-A"]);
  });
});

// recorder — small spy that records args and returns either a constant value or
// a function-derived value. Local to this describe to avoid leaking into the
// existing block-scope helpers.
function recorder(returnValue) {
  const calls = [];
  const fn = (...args) => {
    calls.push(args);
    return typeof returnValue === "function" ? returnValue(...args) : returnValue;
  };
  fn.calls = calls;
  return fn;
}

// ── CTL-585: daemon-start preflight for missing workspace labels ──

describe("preflightWorkspaceLabels (CTL-585)", () => {
  test("warns once per missing label per team", () => {
    const warnings = [];
    const fakeLog = {
      warn: (obj, msg) => warnings.push({ obj, msg }),
      info: () => {},
      error: () => {},
    };
    const exec = (cmd, args) => {
      expect(cmd).toBe("linearis");
      expect(args.slice(0, 3)).toEqual(["labels", "list", "--team"]);
      const team = args[3];
      // linearis labels list emits JSON ({nodes:[{name,...},...]}).
      // CTL is missing the expected label; ENG has it.
      const nodes =
        team === "CTL"
          ? [{ name: "orchestrate" }, { name: "enhancement" }]
          : [{ name: "needs-human" }, { name: "bug" }];
      return { code: 0, stdout: JSON.stringify({ nodes }), stderr: "" };
    };
    preflightWorkspaceLabels({
      teams: ["CTL", "ENG"],
      exec,
      log: fakeLog,
    });
    const ctlWarns = warnings.filter(
      (w) => w.obj?.team === "CTL" && w.msg.includes("missing required label")
    );
    expect(ctlWarns.map((w) => w.obj.label).sort()).toEqual(["needs-human"]);
    const engWarns = warnings.filter((w) => w.obj?.team === "ENG");
    expect(engWarns).toHaveLength(0);
  });

  test("does not throw on a linearis spawn failure", () => {
    const fakeLog = { warn: () => {}, info: () => {}, error: () => {} };
    const exec = () => ({ code: 127, stdout: "", stderr: "ENOENT" });
    expect(() => preflightWorkspaceLabels({ teams: ["CTL"], exec, log: fakeLog })).not.toThrow();
  });

  test("does not throw on a thrown exec", () => {
    const fakeLog = { warn: () => {}, info: () => {}, error: () => {} };
    const exec = () => {
      throw new Error("boom");
    };
    expect(() => preflightWorkspaceLabels({ teams: ["CTL"], exec, log: fakeLog })).not.toThrow();
  });

  test("real JSON shape with both labels present produces zero warnings", () => {
    // Regression: an early draft split stdout on newlines, which produced
    // false-positive warnings against the real JSON output every daemon start.
    const warnings = [];
    const fakeLog = {
      warn: (obj, msg) => warnings.push({ obj, msg }),
      info: () => {},
      error: () => {},
    };
    const exec = () => ({
      code: 0,
      stdout: JSON.stringify({
        nodes: [
          { name: "triaged", color: "#000" },
          { name: "needs-human", color: "#fff" },
          { name: "bug" },
        ],
      }),
      stderr: "",
    });
    preflightWorkspaceLabels({ teams: ["CTL"], exec, log: fakeLog });
    expect(warnings).toHaveLength(0);
  });

  test("non-JSON stdout is a soft skip, not a throw", () => {
    const infos = [];
    const fakeLog = {
      warn: () => {},
      info: (obj, msg) => infos.push({ obj, msg }),
      error: () => {},
    };
    const exec = () => ({ code: 0, stdout: "not json at all", stderr: "" });
    expect(() => preflightWorkspaceLabels({ teams: ["CTL"], exec, log: fakeLog })).not.toThrow();
    expect(infos.some((i) => i.msg.includes("stdout is not JSON"))).toBe(true);
  });

  test("empty teams list is a no-op", () => {
    const fakeLog = { warn: () => {}, info: () => {}, error: () => {} };
    let calls = 0;
    const exec = () => {
      calls += 1;
      return { code: 0, stdout: "", stderr: "" };
    };
    preflightWorkspaceLabels({ teams: [], exec, log: fakeLog });
    expect(calls).toBe(0);
  });
});

describe("startScheduler — preflight wiring (CTL-585)", () => {
  afterEach(() => __resetForTests());

  test("invokes preflightWorkspaceLabels once at startup using listProjects() teams", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const calls = [];
    const fakePreflight = (opts) => calls.push(opts);
    startScheduler({
      orchDir,
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus: { applyPhaseStatus() {}, applyTerminalDone() {}, applyLabel() {} },
      preflight: fakePreflight,
      tickIntervalMs: 1_000_000, // suppress the periodic tick from firing in-test
    });
    stopScheduler();
    expect(calls).toHaveLength(1);
    expect(Array.isArray(calls[0].teams)).toBe(true);
  });
});

// ── CTL-597: terminal-Done once-marker (.terminal-done.applied) ──

describe("schedulerTick — terminal-Done once-marker (CTL-597)", () => {
  // Helper consistent with the existing suites: a writeStatus whose label/phase
  // writes are no-ops; only applyTerminalDone is the subject under test.
  function terminalNoWrites() {
    return { applyPhaseStatus() {}, applyLabel() {} };
  }

  test("does not re-write terminal Done once the .terminal-done.applied marker exists", () => {
    writeSignal("CTL-20", "monitor-deploy", "done");
    writeFileSync(join(orchDir, "workers", "CTL-20", ".terminal-done.applied"), "");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dones = [];
    const writeStatus = {
      ...terminalNoWrites(),
      applyTerminalDone: (a) => dones.push(a),
    };
    schedulerTick(orchDir, { readEligible: () => [], dispatch: fakeDispatch(), writeStatus });
    // Marker present → applyTerminalDone (and its Linear read) is never called.
    expect(dones).toHaveLength(0);
  });

  test("writes the .terminal-done.applied marker only after applyTerminalDone reports applied:true", () => {
    writeSignal("CTL-21", "monitor-deploy", "done");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const markerPath = join(orchDir, "workers", "CTL-21", ".terminal-done.applied");
    // applied:false → no marker → retried next tick.
    const failWrite = { ...terminalNoWrites(), applyTerminalDone: () => ({ applied: false }) };
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus: failWrite,
    });
    expect(existsSync(markerPath)).toBe(false);
    // applied:true → marker written → not retried.
    const okWrite = { ...terminalNoWrites(), applyTerminalDone: () => ({ applied: true }) };
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus: okWrite,
    });
    expect(existsSync(markerPath)).toBe(true);
  });

  test("fires applyTerminalDone once across ticks (skipped is also terminal, CTL-589)", () => {
    writeSignal("CTL-22", "monitor-deploy", "skipped");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    let count = 0;
    const writeStatus = {
      ...terminalNoWrites(),
      applyTerminalDone: () => {
        count++;
        return { applied: true };
      },
    };
    schedulerTick(orchDir, { readEligible: () => [], dispatch: fakeDispatch(), writeStatus });
    schedulerTick(orchDir, { readEligible: () => [], dispatch: fakeDispatch(), writeStatus });
    expect(count).toBe(1);
    expect(existsSync(join(orchDir, "workers", "CTL-22", ".terminal-done.applied"))).toBe(true);
  });

  test("a terminal-Done write throw never aborts the tick", () => {
    writeSignal("CTL-23", "monitor-deploy", "done");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const writeStatus = {
      ...terminalNoWrites(),
      applyTerminalDone: () => {
        throw new Error("terminal boom");
      },
    };
    expect(() =>
      schedulerTick(orchDir, { readEligible: () => [], dispatch: fakeDispatch(), writeStatus })
    ).not.toThrow();
    // No marker on a thrown apply → retried next tick.
    expect(existsSync(join(orchDir, "workers", "CTL-23", ".terminal-done.applied"))).toBe(false);
  });
});

// ─── CTL-653: end-to-end verify⇄remediate cycle through schedulerTick ───
// Drives the full router → reset → re-verify loop. The dispatch fake plays the
// worker: it writes each phase's `done` signal, writes verify.json with a
// verdict that fails for the first `failCycles` verify runs (then passes), and
// on a remediate dispatch appends a phase.remediate.complete event so
// countRemediateCycles advances. reclaimDeadWork + writeStatus are stubbed so
// the test isolates the advancement sweep.
describe("CTL-653: schedulerTick verify⇄remediate cycle (end-to-end)", () => {
  const TICKET = "CTL-653";
  // A no-op Linear writer: every method returns undefined, which labelOnce /
  // terminalDoneOnce treat as success (so once-markers still get written).
  const noopWriteStatus = new Proxy({}, { get: () => () => undefined });

  // cyclingDispatch — the worker stand-in. failCycles = how many verify runs
  // produce a verdict-fail (risk 7) before one passes (risk 1).
  function cyclingDispatch(failCycles) {
    const calls = [];
    let verifyRuns = 0;
    const fn = ({ orchDir: od, ticket, phase }) => {
      calls.push(phase);
      const wdir = join(od, "workers", ticket);
      mkdirSync(wdir, { recursive: true });
      if (phase === "verify") {
        verifyRuns += 1;
        const risk = verifyRuns <= failCycles ? 7 : 1;
        writeFileSync(
          join(wdir, "verify.json"),
          JSON.stringify({
            regression_risk: risk,
            findings: risk >= 5 ? [{ severity: "high", kind: "test", message: "x" }] : [],
            tests_attempted: 1,
            gates: {},
            generatedAt: "2026-05-27T00:00:00Z",
          })
        );
        writeFileSync(join(wdir, "phase-verify.json"), JSON.stringify({ ticket, phase, status: "done" }));
      } else if (phase === "remediate") {
        writeFileSync(
          join(wdir, "phase-remediate.json"),
          JSON.stringify({ ticket, phase, status: "done" })
        );
        // one completed cycle == one phase.remediate.complete.<ticket> event
        appendToEventLog(
          JSON.stringify({
            ts: new Date().toISOString(),
            attributes: { "event.name": `phase.remediate.complete.${ticket}` },
          }) + "\n"
        );
      } else {
        writeFileSync(join(wdir, `phase-${phase}.json`), JSON.stringify({ ticket, phase, status: "done" }));
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    fn.calls = calls;
    return fn;
  }

  const runTicks = (dispatch, n) => {
    for (let i = 0; i < n; i += 1) {
      schedulerTick(orchDir, {
        readEligible: () => [],
        dispatch,
        writeStatus: noopWriteStatus,
        reclaimDeadWork: () => "noop",
        verifyDispatched: verifyOk, // CTL-611: cyclingDispatch writes status:"done", not a runnable dispatched signal; bypass the verifier
        // CTL-705: inject the liveBackgroundCount seam so this end-to-end cycle
        // test does NOT shell out to the real `claude agents --json` once per
        // tick. With no eligible/queued tickets the slot-counting sweeps (0.5
        // preemption, 2 new-work) are no-ops anyway, so a free-slot stub is
        // behavior-preserving — and it makes the 12-tick run deterministic
        // instead of dependent on real subprocess latency (which timed the test
        // out under load even after the scheduler hoisted the call 3x→1x).
        liveBackgroundCount: () => 0,
      });
    }
  };

  test("fail once → remediate → re-verify pass → review", () => {
    writeSignal(TICKET, "implement", "done"); // seed: implement landed
    const dispatch = cyclingDispatch(1); // verify run #1 fails, #2 passes
    runTicks(dispatch, 6);

    // The self-heal path leads: verify(fail) → remediate → verify(pass) → review.
    // (The fake auto-completes review/pr/… too, so assert the leading sequence
    // and the exact cycle count rather than the full tail.)
    expect(dispatch.calls.slice(0, 4)).toEqual(["verify", "remediate", "verify", "review"]);
    expect(dispatch.calls.filter((p) => p === "remediate").length).toBe(1); // exactly one cycle
    expect(dispatch.calls.filter((p) => p === "verify").length).toBe(2); // initial + one re-verify
    // Landed on review against a now-passing branch — no human needed, no stall.
    expect(readPhaseSignals(orchDir, TICKET).review).toBe("done");
    expect(
      JSON.parse(readFileSync(join(orchDir, "workers", TICKET, "phase-verify.json"), "utf8")).status
    ).toBe("done");
  });

  test("verify never passes → 3 remediations, 3rd re-verified, then stall → needs-human", () => {
    writeSignal(TICKET, "implement", "done");
    const dispatch = cyclingDispatch(99); // verify always fails
    runTicks(dispatch, 12);

    const remediates = dispatch.calls.filter((p) => p === "remediate").length;
    const verifies = dispatch.calls.filter((p) => p === "verify").length;
    expect(remediates).toBe(REMEDIATE_CYCLE_CAP); // exactly 3 remediation attempts
    expect(verifies).toBe(REMEDIATE_CYCLE_CAP + 1); // the 3rd remediation IS re-verified
    // Never routed to review on a failing verdict.
    expect(dispatch.calls).not.toContain("review");
    // Cap exhausted → verify signal stalled → terminal sweep applies needs-human.
    const verifySig = JSON.parse(
      readFileSync(join(orchDir, "workers", TICKET, "phase-verify.json"), "utf8")
    );
    expect(verifySig.status).toBe("stalled");
    expect(verifySig.stalledReason).toBe("remediate-cycle-cap-exhausted");
    expect(existsSync(join(orchDir, "workers", TICKET, ".linear-label-needs-human.applied"))).toBe(true);
  });
});

// ── CTL-611: post-dispatch verifier + phase.dispatch.failed event ─────────
//
// Two defects in the existing dispatch flow:
//   Gap 1: rc=0 with no successor signal (--dry-run leak / half-write) was
//          silently treated as a real advance. The verifier closes this.
//   Gap 2: rc!=0 wrote a cool-down marker but emitted no event, so the
//          broker / HUD / operator never saw the dropped advancement.
// Every dispatch failure (real or demoted) now appends a single
// phase.dispatch.failed.<TICKET> entry to ~/catalyst/events/YYYY-MM.jsonl.

// readEventLogLines — read every line of the current UTC YYYY-MM.jsonl under
// the redirected CATALYST_DIR; returns [] when the file does not exist (the
// happy-path regression assertion). Each line is parsed as a canonical
// envelope.
function readEventLogLines() {
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const logPath = join(catalystDir, "events", `${ym}.jsonl`);
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

// dispatchFailedEvents — narrow the unified log to just the CTL-611 emissions
// for a given ticket. The canonical name is phase.dispatch.failed.<TICKET>.
function dispatchFailedEvents(ticket) {
  return readEventLogLines().filter(
    (e) => e?.attributes?.["event.name"] === `phase.dispatch.failed.${ticket}`
  );
}

describe("verifyDispatchedSignal (CTL-611)", () => {
  test("returns false when signal file is absent", () => {
    expect(verifyDispatchedSignal(orchDir, "CTL-100", "research")).toEqual({
      ok: false,
      reason: "signal_missing",
    });
  });

  test("returns false when bg_job_id is null (--dry-run leak shape)", () => {
    const dir = join(orchDir, "workers", "CTL-101");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "phase-research.json"),
      JSON.stringify({ ticket: "CTL-101", phase: "research", status: "dispatched", bg_job_id: null })
    );
    expect(verifyDispatchedSignal(orchDir, "CTL-101", "research")).toEqual({
      ok: false,
      reason: "bg_job_id_missing",
    });
  });

  test("returns false when status is not runnable (e.g. stalled)", () => {
    const dir = join(orchDir, "workers", "CTL-102");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "phase-research.json"),
      JSON.stringify({ ticket: "CTL-102", phase: "research", status: "stalled", bg_job_id: "abc" })
    );
    expect(verifyDispatchedSignal(orchDir, "CTL-102", "research")).toEqual({
      ok: false,
      reason: "status_not_runnable",
    });
  });

  test("returns true on a healthy dispatched signal", () => {
    const dir = join(orchDir, "workers", "CTL-103");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "phase-research.json"),
      JSON.stringify({ ticket: "CTL-103", phase: "research", status: "running", bg_job_id: "abcd1234" })
    );
    expect(verifyDispatchedSignal(orchDir, "CTL-103", "research")).toEqual({ ok: true });
  });
});

describe("phase.dispatch.failed event emission (CTL-611)", () => {
  const eligibleOne = (id) => [
    {
      identifier: id,
      priority: 1,
      createdAt: "x",
      state: "Todo",
      labels: ["Ready"],
      blockedBy: [],
      raw: { team: { key: "CTL" } },
    },
  ];

  test("advancement sweep demotes rc=0 + missing bg job to failure", () => {
    // FSM owes plan; fakeDispatch returns rc=0 but does NOT write the signal.
    writeSignal("CTL-200", "research", "done");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({ code: 0, writeSignal: false });

    const result = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      now: () => 1_000,
    });

    expect(dispatch.calls).toHaveLength(1);
    // Demotion: no advance recorded.
    expect(result?.advanced ?? []).not.toContainEqual({ ticket: "CTL-200", phase: "plan" });
    // Cool-down marker exists (failure-on-disk effect).
    expect(existsSync(dispatchCooldownPath(orchDir, "CTL-200", "plan"))).toBe(true);
    // Exactly one event emitted with verify_failed reason + code=0.
    const events = dispatchFailedEvents("CTL-200");
    expect(events).toHaveLength(1);
    expect(events[0].body.payload).toMatchObject({
      target_phase: "plan",
      code: 0,
    });
    expect(events[0].body.payload.reason).toMatch(/^verify_failed:/);
  });

  test("advancement sweep emits phase.dispatch.failed on rc!=0", () => {
    writeSignal("CTL-201", "research", "done");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({ code: 1 });

    schedulerTick(orchDir, { readEligible: () => [], dispatch, now: () => 1_000 });

    const events = dispatchFailedEvents("CTL-201");
    expect(events).toHaveLength(1);
    expect(events[0].body.payload).toMatchObject({
      target_phase: "plan",
      code: 1,
      reason: "dispatch_nonzero_exit",
    });
  });

  test("new-work sweep emits phase.dispatch.failed on rc!=0", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({ code: 1 });

    schedulerTick(orchDir, {
      readEligible: () => eligibleOne("CTL-202"),
      dispatch,
      now: () => 1_000,
      liveBackgroundCount: () => 0, // CTL-611: deterministic free slot post-CTL-657 rebase
    });

    const events = dispatchFailedEvents("CTL-202");
    expect(events).toHaveLength(1);
    expect(events[0].body.payload).toMatchObject({
      target_phase: "research",
      code: 1,
      reason: "dispatch_nonzero_exit",
    });
  });

  test("new-work sweep demotes rc=0 + missing bg job to failure", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({ code: 0, writeSignal: false });

    const result = schedulerTick(orchDir, {
      readEligible: () => eligibleOne("CTL-203"),
      dispatch,
      now: () => 1_000,
      liveBackgroundCount: () => 0, // CTL-611: deterministic free slot post-CTL-657 rebase
    });

    expect(dispatch.calls).toHaveLength(1);
    expect(result?.dispatched ?? []).not.toContain("CTL-203");
    expect(existsSync(dispatchCooldownPath(orchDir, "CTL-203", "research"))).toBe(true);
    const events = dispatchFailedEvents("CTL-203");
    expect(events).toHaveLength(1);
    expect(events[0].body.payload).toMatchObject({ target_phase: "research", code: 0 });
    expect(events[0].body.payload.reason).toMatch(/^verify_failed:/);
  });

  test("event is emitted exactly once per failure (cool-down suppresses retry)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({ code: 1 });

    // Tick 1: failure → 1 dispatch, 1 event.
    schedulerTick(orchDir, {
      readEligible: () => eligibleOne("CTL-204"),
      dispatch,
      now: () => 1_000,
      liveBackgroundCount: () => 0, // CTL-611: deterministic free slot post-CTL-657 rebase
    });
    // Tick 2 inside the 60s window: suppressed by cool-down → 0 new dispatch,
    // 0 new event (the dispatch never re-attempts so emission never fires).
    schedulerTick(orchDir, {
      readEligible: () => eligibleOne("CTL-204"),
      dispatch,
      now: () => 30_000,
      liveBackgroundCount: () => 0, // CTL-611: deterministic free slot post-CTL-657 rebase
    });

    expect(dispatch.calls).toHaveLength(1);
    expect(dispatchFailedEvents("CTL-204")).toHaveLength(1);
  });

  test("successful dispatch with verified signal does NOT emit phase.dispatch.failed", () => {
    // Advancement happy-path regression — verifier returns ok, no failure
    // event is appended. fakeDispatch does not write a signal, so the
    // verifier is injected directly to assert the success-branch behaviour.
    writeSignal("CTL-205", "research", "done");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({ code: 0 });

    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      now: () => 1_000,
      verifyDispatched: verifyOk,
    });

    expect(dispatch.calls).toHaveLength(1);
    expect(dispatchFailedEvents("CTL-205")).toHaveLength(0);
    // No cool-down marker either — verifier ok ⇒ existing CTL-624 clear path.
    expect(existsSync(dispatchCooldownPath(orchDir, "CTL-205", "plan"))).toBe(false);
  });
});

// ── CTL-660: phase.dispatch.requested / .launched emission (scheduler) ────
//
// The success-path complement to CTL-611's phase.dispatch.failed. `requested`
// fires when the scheduler DECIDES to dispatch (before the spawn); `launched`
// fires ONLY after verifyDispatched confirms a live worker, carrying the
// signal's bg_job_id + worktreePath so pickup→launch latency is derivable.
// Asserted via the injection seam (spy emitters) per the plan; the envelope
// shape itself is round-tripped in recovery.test.mjs.
describe("CTL-660: phase.dispatch.requested/launched emission (scheduler)", () => {
  const eligibleOne = (id) => [
    {
      identifier: id,
      priority: 1,
      createdAt: "x",
      state: "Todo",
      labels: ["Ready"],
      blockedBy: [],
      raw: { team: { key: "CTL" } },
    },
  ];

  // Spy emitter: records each call's single argument object, returns true
  // (the best-effort contract; no caller gates on it).
  function spy() {
    const calls = [];
    const fn = (arg) => {
      calls.push(arg);
      return true;
    };
    fn.calls = calls;
    return fn;
  }

  // A dispatch fake that writes a runnable signal carrying bg_job_id +
  // worktreePath so the default verifyDispatchedSignal returns ok AND the
  // launched emit (which re-reads the signal via readPhaseSignalRaw) sees them.
  function dispatchWritesSignal({ bgJobId = "abcd1234", worktreePath = "/wt/x" } = {}) {
    const calls = [];
    const fn = ({ orchDir: od, ticket, phase }) => {
      calls.push({ ticket, phase });
      const dir = join(od, "workers", ticket);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `phase-${phase}.json`),
        JSON.stringify({ ticket, phase, status: "running", bg_job_id: bgJobId, worktreePath })
      );
      return { code: 0, stdout: "", stderr: "" };
    };
    fn.calls = calls;
    return fn;
  }

  test("advance success: requested(advance) then launched with signal bg_job_id + worktree_path", () => {
    writeSignal("CTL-300", "research", "done"); // FSM owes plan
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = dispatchWritesSignal({ bgJobId: "deadbeef", worktreePath: "/wt/CTL-300" });
    const requested = spy();
    const launched = spy();

    const r = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      now: () => 1_000,
      appendDispatchRequestedEvent: requested,
      appendDispatchLaunchedEvent: launched,
    });

    expect(r.advanced).toContainEqual({ ticket: "CTL-300", phase: "plan" });
    expect(requested.calls).toHaveLength(1);
    expect(requested.calls[0]).toMatchObject({
      ticket: "CTL-300",
      target_phase: "plan",
      reason: "advance",
    });
    expect(launched.calls).toHaveLength(1);
    expect(launched.calls[0]).toMatchObject({
      ticket: "CTL-300",
      target_phase: "plan",
      bg_job_id: "deadbeef",
      worktree_path: "/wt/CTL-300",
    });
  });

  test("new-work success: requested(new-work) then launched", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = dispatchWritesSignal({ bgJobId: "f00dface", worktreePath: "/wt/CTL-301" });
    const requested = spy();
    const launched = spy();

    const r = schedulerTick(orchDir, {
      readEligible: () => eligibleOne("CTL-301"),
      dispatch,
      now: () => 1_000,
      liveBackgroundCount: () => 0,
      appendDispatchRequestedEvent: requested,
      appendDispatchLaunchedEvent: launched,
    });

    expect(r.dispatched).toContain("CTL-301");
    expect(requested.calls).toHaveLength(1);
    expect(requested.calls[0]).toMatchObject({
      ticket: "CTL-301",
      target_phase: "research",
      reason: "new-work",
    });
    expect(launched.calls).toHaveLength(1);
    expect(launched.calls[0]).toMatchObject({
      ticket: "CTL-301",
      target_phase: "research",
      bg_job_id: "f00dface",
      worktree_path: "/wt/CTL-301",
    });
  });

  test("dispatch rc!=0: requested emitted (decision happened), launched NOT", () => {
    writeSignal("CTL-302", "research", "done");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({ code: 1 });
    const requested = spy();
    const launched = spy();

    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      now: () => 1_000,
      appendDispatchRequestedEvent: requested,
      appendDispatchLaunchedEvent: launched,
    });

    expect(requested.calls).toHaveLength(1);
    expect(requested.calls[0]).toMatchObject({ ticket: "CTL-302", target_phase: "plan", reason: "advance" });
    expect(launched.calls).toHaveLength(0);
  });

  test("verify !ok (rc=0, no live signal): requested emitted, launched NOT (no CTL-611 regression)", () => {
    writeSignal("CTL-303", "research", "done");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({ code: 0 }); // writes no signal → verifier !ok
    const requested = spy();
    const launched = spy();

    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      now: () => 1_000,
      appendDispatchRequestedEvent: requested,
      appendDispatchLaunchedEvent: launched,
    });

    expect(requested.calls).toHaveLength(1);
    expect(launched.calls).toHaveLength(0);
    // CTL-611 failure event still fires on the demotion.
    expect(dispatchFailedEvents("CTL-303")).toHaveLength(1);
  });

  test("fail-open: a throwing requested/launched emitter does not break the tick", () => {
    writeSignal("CTL-304", "research", "done");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = dispatchWritesSignal({ bgJobId: "abc12345", worktreePath: "/wt/CTL-304" });
    const thrower = () => {
      throw new Error("emit boom");
    };

    const r = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      now: () => 1_000,
      appendDispatchRequestedEvent: thrower,
      appendDispatchLaunchedEvent: thrower,
    });

    // The dispatch still advanced despite both lifecycle emitters throwing.
    expect(r.advanced).toContainEqual({ ticket: "CTL-304", phase: "plan" });
  });
});

// ─── CTL-705 Phase 2: stageRankForTicket, readWorkerPriority, writeWorkerPriority, buildGlobalRanking ───
import { PHASES } from "../lib/phase-fsm.mjs";

describe("STAGE_RANK (CTL-705)", () => {
  test("keys are exactly PHASES + 'remediate'", () => {
    const expected = [...PHASES, "remediate"];
    expect(Object.keys(STAGE_RANK)).toEqual(expected);
  });

  test("order: triage=0, research=1, plan=2, implement=3, remediate=4, verify=5, review=6, pr=7, monitor-merge=8, monitor-deploy=9", () => {
    expect(STAGE_RANK.triage).toBe(0);
    expect(STAGE_RANK.research).toBe(1);
    expect(STAGE_RANK.plan).toBe(2);
    expect(STAGE_RANK.implement).toBe(3);
    expect(STAGE_RANK.remediate).toBe(4);
    expect(STAGE_RANK.verify).toBe(5);
    expect(STAGE_RANK.review).toBe(6);
    expect(STAGE_RANK.pr).toBe(7);
    expect(STAGE_RANK["monitor-merge"]).toBe(8);
    expect(STAGE_RANK["monitor-deploy"]).toBe(9);
  });
});

describe("stageRankForTicket (CTL-705)", () => {
  test("returns -1 for empty signals", () => {
    expect(stageRankForTicket({})).toBe(-1);
    expect(stageRankForTicket(null)).toBe(-1);
    expect(stageRankForTicket(undefined)).toBe(-1);
  });

  test("triage running → 0", () => {
    expect(stageRankForTicket({ triage: "running" })).toBe(0);
  });

  test("research running → 1", () => {
    expect(stageRankForTicket({ research: "running" })).toBe(1);
  });

  test("picks highest-indexed non-terminal phase when multiple signals", () => {
    // plan done + implement running → implement wins (3)
    expect(stageRankForTicket({ plan: "done", implement: "running" })).toBe(3);
    // all of triage/research done, verify running → verify wins (5)
    expect(stageRankForTicket({ triage: "done", research: "done", plan: "done", verify: "running" })).toBe(5);
  });

  test("preempted signal still yields its phase rank", () => {
    expect(stageRankForTicket({ research: "preempted" })).toBe(1);
    expect(stageRankForTicket({ implement: "preempted" })).toBe(3);
  });

  test("failed/stalled/aborted phases are excluded", () => {
    expect(stageRankForTicket({ implement: "failed" })).toBe(-1);
    expect(stageRankForTicket({ research: "stalled" })).toBe(-1);
    expect(stageRankForTicket({ plan: "aborted" })).toBe(-1);
  });

  test("monitor-deploy done is terminal — excluded", () => {
    expect(stageRankForTicket({ "monitor-deploy": "done" })).toBe(-1);
    expect(stageRankForTicket({ "monitor-deploy": "skipped" })).toBe(-1);
  });

  test("monitor-deploy running is NOT terminal — included", () => {
    expect(stageRankForTicket({ "monitor-deploy": "running" })).toBe(9);
  });

  test("remediate running → 4", () => {
    expect(stageRankForTicket({ remediate: "running" })).toBe(4);
  });
});

describe("readWorkerPriority / writeWorkerPriority (CTL-705)", () => {
  test("missing priority.json → safe default {priority:5, createdAt:null}", () => {
    expect(readWorkerPriority(orchDir, "CTL-NOT-EXIST")).toEqual({ priority: 5, createdAt: null });
  });

  test("round-trips priority + createdAt through write → read", () => {
    mkdirSync(join(orchDir, "workers", "CTL-42"), { recursive: true });
    writeWorkerPriority(orchDir, "CTL-42", { priority: 1, createdAt: "2026-05-01T00:00:00Z" });
    expect(readWorkerPriority(orchDir, "CTL-42")).toEqual({ priority: 1, createdAt: "2026-05-01T00:00:00Z" });
  });

  test("write is idempotent — second write overwrites first", () => {
    mkdirSync(join(orchDir, "workers", "CTL-43"), { recursive: true });
    writeWorkerPriority(orchDir, "CTL-43", { priority: 3, createdAt: "2026-01-01T00:00:00Z" });
    writeWorkerPriority(orchDir, "CTL-43", { priority: 2, createdAt: "2026-02-01T00:00:00Z" });
    expect(readWorkerPriority(orchDir, "CTL-43")).toEqual({ priority: 2, createdAt: "2026-02-01T00:00:00Z" });
  });

  test("unreadable/malformed priority.json → safe default, never throws", () => {
    const dir = join(orchDir, "workers", "CTL-44");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "priority.json"), "not-json");
    expect(() => readWorkerPriority(orchDir, "CTL-44")).not.toThrow();
    expect(readWorkerPriority(orchDir, "CTL-44")).toEqual({ priority: 5, createdAt: null });
  });
});

describe("buildGlobalRanking (CTL-705)", () => {
  function seedInFlight(ticket, phase, status, bgJobId, priority, createdAt) {
    mkdirSync(join(orchDir, "workers", ticket), { recursive: true });
    writeFileSync(
      join(orchDir, "workers", ticket, `phase-${phase}.json`),
      JSON.stringify({ ticket, phase, status, bg_job_id: bgJobId })
    );
    if (priority !== undefined) {
      writeWorkerPriority(orchDir, ticket, { priority, createdAt: createdAt ?? null });
    }
  }

  function makeEligible(identifier, priority, createdAt) {
    return { identifier, priority, createdAt: createdAt ?? "2026-05-01T00:00:00Z" };
  }

  test("in-flight ticket → inFlight:true with its stageRankForTicket stage", () => {
    seedInFlight("CTL-1", "implement", "running", "abc1", 2, "2026-05-01T00:00:00Z");
    const result = buildGlobalRanking(orchDir, []);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ identifier: "CTL-1", inFlight: true, stage: 3 });
  });

  test("queued (eligible, not started) ticket → inFlight:false with stage:-1", () => {
    const eligible = [makeEligible("CTL-99", 2, "2026-05-01T00:00:00Z")];
    const result = buildGlobalRanking(orchDir, eligible);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ identifier: "CTL-99", inFlight: false, stage: -1 });
  });

  test("ticket in both eligible and in-flight → listed once, as in-flight", () => {
    seedInFlight("CTL-5", "research", "running", "abc5", 2, "2026-05-01T00:00:00Z");
    const eligible = [makeEligible("CTL-5", 2, "2026-05-01T00:00:00Z")];
    const result = buildGlobalRanking(orchDir, eligible);
    expect(result.filter((d) => d.identifier === "CTL-5")).toHaveLength(1);
    expect(result.find((d) => d.identifier === "CTL-5").inFlight).toBe(true);
  });

  test("result is sorted by rankTickets (higher stage in same band first)", () => {
    seedInFlight("CTL-A", "verify", "running", "abc-a", 2, "2026-05-01T00:00:00Z");
    seedInFlight("CTL-B", "research", "running", "abc-b", 2, "2026-05-01T00:00:00Z");
    const result = buildGlobalRanking(orchDir, []);
    // verify (stage 5) before research (stage 1) within same priority band
    expect(result[0].identifier).toBe("CTL-A");
    expect(result[1].identifier).toBe("CTL-B");
  });

  test("terminal in-flight tickets are excluded", () => {
    seedInFlight("CTL-X", "monitor-deploy", "done", "dead", undefined, undefined);
    const result = buildGlobalRanking(orchDir, []);
    expect(result.find((d) => d.identifier === "CTL-X")).toBeUndefined();
  });
});

describe("schedulerTick — writeWorkerPriority at new-work dispatch (CTL-705)", () => {
  function dispatchWritesSignalWithBg(bgJobId, worktreePath) {
    return ({ orchDir: od, ticket, phase }) => {
      const dir = join(od, "workers", ticket);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `phase-${phase}.json`),
        JSON.stringify({ ticket, phase, status: "dispatched", bg_job_id: bgJobId, worktreePath })
      );
      return { code: 0, stdout: "", stderr: "", worktreePath };
    };
  }

  test("writes priority.json for a newly dispatched new-work ticket", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    writeEligibleProjection("CTL", {
      tickets: [{ identifier: "CTL-9", priority: 1, createdAt: "2026-05-01T00:00:00Z" }],
    });
    const dispatch = dispatchWritesSignalWithBg("bg-job-9", "/wt/CTL-9");
    schedulerTick(orchDir, {
      readEligible: undefined,
      dispatch,
      liveBackgroundCount: () => 0,
      now: () => 1_000,
    });
    const pj = readWorkerPriority(orchDir, "CTL-9");
    expect(pj.priority).toBe(1);
    expect(pj.createdAt).toBe("2026-05-01T00:00:00Z");
  });
});

// ─── CTL-705 Phase 4: preemption sweep ───

describe("preemption sweep (CTL-705 Phase 4)", () => {
  // Seed a fully-formed in-flight signal with startedAt + bg_job_id + priority.json
  function seedWorker(ticket, phase, priority, startedAtMs, bgJobId, createdAt) {
    const dir = join(orchDir, "workers", ticket);
    mkdirSync(dir, { recursive: true });
    const startedAt = new Date(startedAtMs).toISOString();
    writeFileSync(
      join(dir, `phase-${phase}.json`),
      JSON.stringify({ ticket, phase, status: "running", bg_job_id: bgJobId, startedAt })
    );
    writeWorkerPriority(orchDir, ticket, { priority, createdAt: createdAt ?? "2026-05-01T00:00:00Z" });
  }

  function readSignal(ticket, phase) {
    return JSON.parse(readFileSync(join(orchDir, "workers", ticket, `phase-${phase}.json`), "utf8"));
  }

  function makePrioEligible(identifier, priority) {
    return { identifier, priority, createdAt: "2026-05-01T00:00:00Z" };
  }

  // killBgJob recording stub
  function makeKillStub() {
    const calls = [];
    const fn = (args) => calls.push(args);
    fn.calls = calls;
    return fn;
  }

  // appendPreemptedEvent recording stub
  function makePreemptStub() {
    const calls = [];
    const fn = (args) => { calls.push(args); return true; };
    fn.calls = calls;
    return fn;
  }

  const noopReclaim = () => "noop";

  test("happy path: saturated, Urgent queued vs 2 Low in-flight — parks lowest-stage Low", () => {
    const T0 = 100_000;
    // CTL-1: Low @ verify (stage 5), CTL-2: Low @ research (stage 1) — CTL-2 is lowest stage
    seedWorker("CTL-1", "verify", 4, T0 - 90_000, "bg-ctl1");
    seedWorker("CTL-2", "research", 4, T0 - 90_000, "bg-ctl2");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    const tickOpts = {
      readEligible: () => [makePrioEligible("CTL-9", 1)], // Urgent
      dispatch: fakeDispatch(),
      liveBackgroundCount: () => 2, // saturated
      reclaimDeadWork: noopReclaim,
    };
    // Tick 1: hysteresis window opens, no preemption yet.
    schedulerTick(orchDir, { ...tickOpts, now: () => T0, killBgJob: makeKillStub() });
    // Tick 2 (35s later): past the 30s hysteresis → preemption fires.
    const kill = makeKillStub();
    const appendPreempted = makePreemptStub();
    schedulerTick(orchDir, {
      ...tickOpts,
      now: () => T0 + 35_000,
      killBgJob: kill,
      appendPreemptedEvent: appendPreempted,
    });
    // CTL-2 should be preempted (research = lowest stage)
    expect(kill.calls.map((c) => c.bgJobId)).toContain("bg-ctl2");
    expect(kill.calls.map((c) => c.bgJobId)).not.toContain("bg-ctl1");
    const sig = readSignal("CTL-2", "research");
    expect(sig.status).toBe("preempted");
    expect(sig.parkedFrom).toBe("research");
    expect(sig.attentionReason).toBe("preempted-by-priority");
    expect(appendPreempted.calls).toHaveLength(1);
    expect(appendPreempted.calls[0].ticket).toBe("CTL-2");
  });

  test("no preemption when a slot is free (liveBackgroundCount < maxParallel)", () => {
    const NOW = 100_000;
    seedWorker("CTL-1", "verify", 4, NOW - 90_000, "bg-ctl1");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    const kill = makeKillStub();
    schedulerTick(orchDir, {
      readEligible: () => [makePrioEligible("CTL-9", 1)],
      dispatch: fakeDispatch(),
      liveBackgroundCount: () => 1, // slot free
      reclaimDeadWork: noopReclaim,
      now: () => NOW,
      killBgJob: kill,
    });
    expect(kill.calls).toHaveLength(0);
  });

  test("no preemption when queued ticket does not out-rank any in-flight", () => {
    const NOW = 100_000;
    // In-flight: both Urgent (priority 1), queued: also priority 4 (Low)
    seedWorker("CTL-1", "verify", 1, NOW - 90_000, "bg-ctl1");
    seedWorker("CTL-2", "research", 1, NOW - 90_000, "bg-ctl2");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    const kill = makeKillStub();
    schedulerTick(orchDir, {
      readEligible: () => [makePrioEligible("CTL-9", 4)], // Low — doesn't out-rank Urgent
      dispatch: fakeDispatch(),
      liveBackgroundCount: () => 2,
      reclaimDeadWork: noopReclaim,
      now: () => NOW,
      killBgJob: kill,
    });
    expect(kill.calls).toHaveLength(0);
  });

  test("guard: non-preemptable phase (monitor-deploy) is skipped", () => {
    const NOW = 100_000;
    // Only in-flight worker is at monitor-deploy — non-preemptable
    seedWorker("CTL-MD", "monitor-deploy", 4, NOW - 90_000, "bg-md");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const kill = makeKillStub();
    schedulerTick(orchDir, {
      readEligible: () => [makePrioEligible("CTL-9", 1)],
      dispatch: fakeDispatch(),
      liveBackgroundCount: () => 1,
      reclaimDeadWork: noopReclaim,
      now: () => NOW,
      killBgJob: kill,
    });
    expect(kill.calls).toHaveLength(0); // non-preemptable → skip, no preemption
  });

  test("guard: triage is non-preemptable", () => {
    const NOW = 100_000;
    seedWorker("CTL-T", "triage", 4, NOW - 90_000, "bg-t");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const kill = makeKillStub();
    schedulerTick(orchDir, {
      readEligible: () => [makePrioEligible("CTL-9", 1)],
      dispatch: fakeDispatch(),
      liveBackgroundCount: () => 1,
      reclaimDeadWork: noopReclaim,
      now: () => NOW,
      killBgJob: kill,
    });
    expect(kill.calls).toHaveLength(0);
  });

  test("guard: min-runtime floor 60s — 30s-old candidate not preempted", () => {
    const NOW = 100_000;
    // Worker started only 30s ago (< 60s floor)
    seedWorker("CTL-Young", "research", 4, NOW - 30_000, "bg-young");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const kill = makeKillStub();
    schedulerTick(orchDir, {
      readEligible: () => [makePrioEligible("CTL-9", 1)],
      dispatch: fakeDispatch(),
      liveBackgroundCount: () => 1,
      reclaimDeadWork: noopReclaim,
      now: () => NOW,
      killBgJob: kill,
    });
    expect(kill.calls).toHaveLength(0);
  });

  test("guard: implement quiet-window — mtime too recent (<10s) → not preempted, mtime stale → preempted", async () => {
    const { utimesSync } = await import("node:fs");
    const NOW = 100_000;
    // Worker old enough (> 60s) but at implement
    seedWorker("CTL-Impl", "implement", 4, NOW - 90_000, "bg-impl");
    const signalPath = join(orchDir, "workers", "CTL-Impl", "phase-implement.json");
    // Set mtime to 3s ago (within the 10s quiet window)
    const recentMtime = new Date(NOW - 3_000);
    utimesSync(signalPath, recentMtime, recentMtime);
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const kill = makeKillStub();
    schedulerTick(orchDir, {
      readEligible: () => [makePrioEligible("CTL-9", 1)],
      dispatch: fakeDispatch(),
      liveBackgroundCount: () => 1,
      reclaimDeadWork: noopReclaim,
      now: () => NOW,
      killBgJob: kill,
      appendPreemptedEvent: makePreemptStub(),
    });
    expect(kill.calls).toHaveLength(0); // 3s mtime < 10s quiet window → not preempted

    // Now make mtime stale (15s ago — past the quiet window). Run two ticks so
    // hysteresis allows the second tick to fire.
    const staleMtime = new Date(NOW - 15_000);
    utimesSync(signalPath, staleMtime, staleMtime);
    const tickOpts2 = {
      readEligible: () => [makePrioEligible("CTL-9", 1)],
      dispatch: fakeDispatch(),
      liveBackgroundCount: () => 1,
      reclaimDeadWork: noopReclaim,
    };
    // __resetForTests clears hysteresis from the first tick (mtime-guarded tick above).
    __resetForTests();
    schedulerTick(orchDir, { ...tickOpts2, now: () => NOW, killBgJob: makeKillStub() }); // tick 1: open hysteresis
    const kill2 = makeKillStub();
    schedulerTick(orchDir, {
      ...tickOpts2,
      now: () => NOW + 35_000, // tick 2: past hysteresis
      killBgJob: kill2,
      appendPreemptedEvent: makePreemptStub(),
    });
    expect(kill2.calls).toHaveLength(1); // 15s mtime > 10s quiet window → preempted
  });

  test("guard: hysteresis 30s — first observation skips, ≥30s observation preempts", () => {
    const T0 = 100_000;
    seedWorker("CTL-H", "research", 4, T0 - 90_000, "bg-h");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const eligible = [makePrioEligible("CTL-9", 1)];

    // Tick 1 at T0: first observation — hysteresis window opens, no preemption yet
    const kill1 = makeKillStub();
    schedulerTick(orchDir, {
      readEligible: () => eligible,
      dispatch: fakeDispatch(),
      liveBackgroundCount: () => 1,
      reclaimDeadWork: noopReclaim,
      now: () => T0,
      killBgJob: kill1,
    });
    expect(kill1.calls).toHaveLength(0); // first observation → hysteresis window just opened

    // Tick 2 at T0 + 35s: past the 30s hysteresis window → preempt
    const kill2 = makeKillStub();
    schedulerTick(orchDir, {
      readEligible: () => eligible,
      dispatch: fakeDispatch(),
      liveBackgroundCount: () => 1,
      reclaimDeadWork: noopReclaim,
      now: () => T0 + 35_000,
      killBgJob: kill2,
      appendPreemptedEvent: makePreemptStub(),
    });
    expect(kill2.calls).toHaveLength(1); // ≥30s → preempted
  });

  test("reclaim sweep ignores 'preempted' signals — no false revive", () => {
    // Seed a preempted signal WITH a (now-dead) bg_job_id — the exact shape a
    // worker parks in: status "preempted", but its killed bg_job_id is still on
    // the signal. Without the CTL-705 reclaim guard, classifyWorker routes this
    // through the death trigger (liveness.kind='bg', process gone) and
    // reclaimDeadWorkIfPossible returns "revived", spawning a duplicate and
    // defeating the resume sweep. Seeding bg_job_id is what makes this test
    // actually exercise that path — the prior fixture omitted it, so
    // classifyWorker returned 'unknown' and the gap was invisible.
    const dir = join(orchDir, "workers", "CTL-Park");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "phase-research.json"),
      JSON.stringify({
        ticket: "CTL-Park",
        phase: "research",
        status: "preempted",
        parkedFrom: "research",
        bg_job_id: "dead-bg-from-preemption",
      })
    );
    // Saturate the slot so the resume sweep (1.5) also sees 0 free slots and doesn't fire.
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch();
    const reclaimCalls = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      liveBackgroundCount: () => 1, // saturated → resume sweep skips
      // If the guard were missing, the reclaim loop would call this for the
      // preempted signal; returning "revived" models reclaimDeadWorkIfPossible's
      // real verdict for a preempted-signal-with-dead-bg. The guard means it is
      // never invoked for a preempted ticket at all.
      reclaimDeadWork: (_od, sig) => {
        reclaimCalls.push({ ticket: sig.ticket, status: sig.status });
        return "revived";
      },
    });
    // The reclaim guard skips the preempted signal BEFORE reclaimDeadWork is
    // called — so it must never fire for CTL-Park even though the signal carries
    // a dead bg_job_id that would otherwise trip the death trigger.
    expect(reclaimCalls.find((c) => c.ticket === "CTL-Park")).toBeUndefined();
    // And no advancement / re-dispatch fired for it (advancement guard).
    const parkedAdvance = dispatch.calls.filter((c) => c.ticket === "CTL-Park");
    expect(parkedAdvance).toHaveLength(0); // not advanced
  });

  test("advancement sweep ignores 'preempted' — deriveAdvancement never dispatched", () => {
    // preempted research → advancement must not advance to plan
    const dir = join(orchDir, "workers", "CTL-Adv");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "phase-research.json"),
      JSON.stringify({ ticket: "CTL-Adv", phase: "research", status: "preempted", parkedFrom: "research" })
    );
    // Saturate so resume sweep (1.5) also sees 0 free slots.
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch();
    const r = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      liveBackgroundCount: () => 1, // saturated → neither advancement nor resume fires
    });
    // No advancement dispatch for CTL-Adv (the early continue in the advancement loop)
    expect(r.advanced.find((a) => a.ticket === "CTL-Adv")).toBeUndefined();
    // No dispatch call at all for CTL-Adv when saturated
    expect(dispatch.calls.find((c) => c.ticket === "CTL-Adv")).toBeUndefined();
  });
});

// ─── CTL-705 Phase 5: resume-after-preemption re-dispatch ───
describe("resume-after-preemption sweep (CTL-705 Phase 5)", () => {
  function seedPreempted(ticket, phase, bgJobId, priority) {
    const dir = join(orchDir, "workers", ticket);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `phase-${phase}.json`),
      JSON.stringify({
        ticket, phase, status: "preempted", parkedFrom: phase, bg_job_id: bgJobId,
        attentionReason: "preempted-by-priority",
      })
    );
    writeWorkerPriority(orchDir, ticket, { priority, createdAt: "2026-05-01T00:00:00Z" });
  }

  function makeResumeStub() {
    const calls = [];
    const fn = (args) => { calls.push(args); return true; };
    fn.calls = calls;
    return fn;
  }

  function makeDispatchCapture() {
    const calls = [];
    const fn = (args) => {
      calls.push(args);
      const dir = join(orchDir, "workers", args.ticket);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `phase-${args.phase}.json`),
        JSON.stringify({ ticket: args.ticket, phase: args.phase, status: "dispatched", bg_job_id: "new-bg" })
      );
      return { code: 0, stdout: "", stderr: "" };
    };
    fn.calls = calls;
    return fn;
  }

  test("re-dispatches a preempted ticket at parkedFrom phase with resumeSession when slot frees", () => {
    seedPreempted("CTL-2", "research", "bg-ctl2", 2);
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    const dispatch = makeDispatchCapture();
    const appendResumed = makeResumeStub();
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      liveBackgroundCount: () => 1, // 1 free slot
      reclaimDeadWork: () => "noop",
      resolveSession: () => "uuid-x", // injectable resolver
      appendResumedAfterPreemptionEvent: appendResumed,
      verifyDispatched: verifyOk,
    });
    // dispatch called at phase "research" with resumeSession
    const call = dispatch.calls.find((c) => c.ticket === "CTL-2");
    expect(call).toBeDefined();
    expect(call.phase).toBe("research");
    expect(call.resumeSession).toBe("uuid-x");
    // signal reset to running
    const sig = JSON.parse(readFileSync(
      join(orchDir, "workers", "CTL-2", "phase-research.json"), "utf8"
    ));
    expect(sig.status).toBe("dispatched"); // written by makeDispatchCapture
    // resumed event emitted
    expect(appendResumed.calls).toHaveLength(1);
    expect(appendResumed.calls[0].ticket).toBe("CTL-2");
  });

  test("no resume when no slot is free (liveBackgroundCount >= maxParallel)", () => {
    seedPreempted("CTL-2", "research", "bg-ctl2", 2);
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch();
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      liveBackgroundCount: () => 1, // saturated
      reclaimDeadWork: () => "noop",
      resolveSession: () => "uuid-x",
    });
    expect(dispatch.calls.find((c) => c.ticket === "CTL-2")).toBeUndefined();
  });

  test("resolveSession returns null → re-dispatches without resumeSession (cold re-dispatch)", () => {
    seedPreempted("CTL-2", "research", "bg-ctl2", 2);
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    const dispatch = makeDispatchCapture();
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      liveBackgroundCount: () => 1,
      reclaimDeadWork: () => "noop",
      resolveSession: () => null, // no resumable session
      appendResumedAfterPreemptionEvent: makeResumeStub(),
      verifyDispatched: verifyOk,
    });
    const call = dispatch.calls.find((c) => c.ticket === "CTL-2");
    expect(call).toBeDefined();
    expect(call.resumeSession).toBeUndefined(); // no resumeSession when null
  });

  test("new-work pull still excludes parked ticket (listStartedTickets covers it)", () => {
    // preempted worker has a worker dir → listStartedTickets includes it → selectDispatchable excludes it
    seedPreempted("CTL-2", "research", "bg-ctl2", 2);
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    const dispatch = makeDispatchCapture();
    const r = schedulerTick(orchDir, {
      // CTL-2 is also eligible — but it's in listStartedTickets, so it should not be pulled as new work
      readEligible: () => [{ identifier: "CTL-2", priority: 2, createdAt: "2026-05-01T00:00:00Z" }],
      dispatch,
      liveBackgroundCount: () => 0, // slots free
      reclaimDeadWork: () => "noop",
      resolveSession: () => null, // no resume
      verifyDispatched: verifyOk,
    });
    // The resume sweep may dispatch CTL-2 at its parkedFrom phase (correct behavior).
    // But the new-work pull (sweep 2) must NOT include CTL-2 in r.dispatched (that's for fresh starts).
    expect(r.dispatched).not.toContain("CTL-2");
  });
});

// ── CTL-695: terminal-worker reap sweep ──────────────────────────────────────

describe("schedulerTick — terminal-worker reap sweep (CTL-695)", () => {
  test("emits phase.terminal.reap-requested for a failed worker with a bg_job_id", () => {
    writeSignalRaw("CTL-1", "implement", {
      status: "failed",
      bg_job_id: "dead1234",
      worktreePath: "/wt/CTL-1",
    });
    schedulerTick(orchDir, { readEligible: () => [], dispatch: () => ({ code: 0 }) });
    const evts = readEventLog().filter(
      (e) => e.event === "phase.terminal.reap-requested" && e.bg_job_id === "dead1234"
    );
    expect(evts.length).toBe(1);
    expect(evts[0].phase).toBe("implement");
  });

  test("emits for stalled worker and for terminal monitor-deploy done/skipped", () => {
    writeSignalRaw("CTL-2", "review", { status: "stalled", bg_job_id: "stl12345" });
    writeSignalRaw("CTL-3", "monitor-deploy", { status: "done", bg_job_id: "fin12345" });
    schedulerTick(orchDir, { readEligible: () => [], dispatch: () => ({ code: 0 }) });
    const evts = readEventLog();
    expect(evts.some((e) => e.event === "phase.terminal.reap-requested" && e.bg_job_id === "stl12345")).toBe(true);
    expect(evts.some((e) => e.event === "phase.terminal.reap-requested" && e.bg_job_id === "fin12345")).toBe(true);
  });

  test("does NOT re-emit on a second tick (once-marker)", () => {
    writeSignalRaw("CTL-1", "implement", { status: "failed", bg_job_id: "dead1234" });
    schedulerTick(orchDir, { readEligible: () => [], dispatch: () => ({ code: 0 }) });
    schedulerTick(orchDir, { readEligible: () => [], dispatch: () => ({ code: 0 }) });
    const n = readEventLog().filter(
      (e) => e.event === "phase.terminal.reap-requested" && e.bg_job_id === "dead1234"
    ).length;
    expect(n).toBe(1);
    expect(existsSync(join(orchDir, "workers", "CTL-1", ".terminal-reap-implement.applied"))).toBe(true);
  });

  test("skips a terminal signal with no bg_job_id (no spurious emit, no marker)", () => {
    writeSignalRaw("CTL-1", "implement", { status: "failed" }); // no bg_job_id
    schedulerTick(orchDir, { readEligible: () => [], dispatch: () => ({ code: 0 }) });
    expect(readEventLog().some((e) => e.event === "phase.terminal.reap-requested")).toBe(false);
    expect(
      existsSync(join(orchDir, "workers", "CTL-1", ".terminal-reap-implement.applied"))
    ).toBe(false);
  });

  test("does NOT emit terminal-reap for an intermediate done phase that is advancing", () => {
    // research:done → plan dispatches (advancement sweep); the terminal-reap sweep
    // must not also emit phase.terminal.reap-requested for the research worker.
    writeSignalRaw("CTL-4", "research", { status: "done", bg_job_id: "res12345" });
    const dispatch = ({ orchDir: od, ticket, phase }) => {
      const dir = join(od, "workers", ticket);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `phase-${phase}.json`),
        JSON.stringify({ ticket, phase, status: "running" })
      );
      return { code: 0 };
    };
    schedulerTick(orchDir, { readEligible: () => [], dispatch });
    const evts = readEventLog();
    expect(evts.some((e) => e.event === "phase.terminal.reap-requested" && e.bg_job_id === "res12345")).toBe(false);
  });
});

describe("schedulerTick — predecessor reap on dispatch failure (CTL-695)", () => {
  test("reaps the finished predecessor when successor dispatch fails (rc!=0)", () => {
    writeSignalRaw("CTL-5", "research", {
      status: "done",
      bg_job_id: "pre12345",
      worktreePath: "/wt/CTL-5",
    });
    const dispatch = () => ({ code: 1 }); // plan dispatch fails
    schedulerTick(orchDir, { readEligible: () => [], dispatch });
    expect(
      readEventLog().some(
        (e) => e.event === "phase.predecessor.reap-requested" && e.bg_job_id === "pre12345"
      )
    ).toBe(true);
  });

  test("reaps the finished predecessor when verify-dispatched check fails (rc=0, no live signal)", () => {
    writeSignalRaw("CTL-6", "research", {
      status: "done",
      bg_job_id: "pre67890",
      worktreePath: "/wt/CTL-6",
    });
    // rc=0 but dispatch does NOT write a signal → verifyDispatched returns !ok
    const dispatch = () => ({ code: 0 });
    schedulerTick(orchDir, { readEligible: () => [], dispatch });
    expect(
      readEventLog().some(
        (e) => e.event === "phase.predecessor.reap-requested" && e.bg_job_id === "pre67890"
      )
    ).toBe(true);
  });
});

// ── CTL-537: sequencing seam in schedulerTick ──
describe("CTL-537 sequencing seam (schedulerTick)", () => {
  const eligibleTwo = (id) => [
    {
      identifier: id,
      priority: 1,
      createdAt: "x",
      state: "Todo",
      relations: { nodes: [] },
      inverseRelations: { nodes: [] },
    },
  ];

  beforeEach(() => {
    // maxParallel:2 so a 2nd candidate can be admitted while one is in-flight
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    // Write an in-flight signal so listInFlightTickets returns a non-empty set
    writeSignal("CTL-IN", "research", "running");
  });

  test("seam not consulted when nothing in-flight — checkSequencing spy never called", () => {
    let spyCount = 0;
    const checkSequencing = () => { spyCount++; return { verdict: "go", hard_dependencies: [] }; };
    const dispatch = fakeDispatch({ code: 0 });
    schedulerTick(orchDir, {
      readEligible: () => eligibleTwo("CTL-NEW"),
      dispatch,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0, // nothing in-flight
      checkSequencing,
    });
    expect(spyCount).toBe(0);
    expect(dispatch.calls).toHaveLength(1); // dispatch still proceeds
  });

  test("go verdict → dispatch proceeds", () => {
    const dispatch = fakeDispatch({ code: 0 });
    const checkSequencing = () => ({ verdict: "go", hard_dependencies: [] });
    schedulerTick(orchDir, {
      readEligible: () => eligibleTwo("CTL-NEW"),
      dispatch,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 1,
      checkSequencing,
    });
    expect(dispatch.calls.some((c) => c.ticket === "CTL-NEW" || c[1] === "CTL-NEW")).toBe(true);
  });

  test("hold verdict → dispatch suppressed, no cooldown marker written", () => {
    const dispatch = fakeDispatch({ code: 0 });
    const checkSequencing = () => ({ verdict: "hold", hard_dependencies: [] });
    schedulerTick(orchDir, {
      readEligible: () => eligibleTwo("CTL-NEW"),
      dispatch,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 1,
      checkSequencing,
    });
    // Dispatch must not have been called for CTL-NEW
    const dispatchedNew = dispatch.calls.some(
      (c) => (c.ticket === "CTL-NEW" || (Array.isArray(c) && c[1] === "CTL-NEW"))
    );
    expect(dispatchedNew).toBe(false);
    // No cooldown marker must have been written (hold is transient — no marker)
    expect(existsSync(dispatchCooldownPath(orchDir, "CTL-NEW", "research"))).toBe(false);
  });

  test("hard_dependencies verdict → applyBlockedByRelation called + dispatch held", () => {
    const dispatch = fakeDispatch({ code: 0 });
    const blockedByRelationCalls = [];
    const writeStatus = {
      applyPhaseStatus: () => ({ applied: true, reason: null }),
      applyTerminalDone: () => ({ applied: true, reason: null }),
      applyBlockedByRelation: (args) => { blockedByRelationCalls.push(args); return { applied: true, reason: null }; },
    };
    const checkSequencing = () => ({
      verdict: "go",
      reason: "",
      hard_dependencies: [{ candidate: "CTL-NEW", blocked_by: "CTL-IN", reason: "ordering" }],
    });
    schedulerTick(orchDir, {
      readEligible: () => eligibleTwo("CTL-NEW"),
      dispatch,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 1,
      checkSequencing,
      writeStatus,
    });
    // applyBlockedByRelation called with the dep
    expect(blockedByRelationCalls).toHaveLength(1);
    expect(blockedByRelationCalls[0]).toMatchObject({ ticket: "CTL-NEW", blockedBy: "CTL-IN" });
    // Dispatch suppressed
    const dispatchedNew = dispatch.calls.some(
      (c) => (c.ticket === "CTL-NEW" || (Array.isArray(c) && c[1] === "CTL-NEW"))
    );
    expect(dispatchedNew).toBe(false);
  });

  test("untrusted dep ids dropped → no blocked-by write, falls through to verdict (phase-review hardening)", () => {
    const dispatch = fakeDispatch({ code: 0 });
    const blockedByRelationCalls = [];
    const writeStatus = {
      applyPhaseStatus: () => ({ applied: true, reason: null }),
      applyTerminalDone: () => ({ applied: true, reason: null }),
      applyBlockedByRelation: (args) => { blockedByRelationCalls.push(args); return { applied: true, reason: null }; },
    };
    // LLM returns deps that DON'T arbitrate the (CTL-NEW, in-flight) pair:
    // one with a foreign candidate, one blocked_by a non-in-flight ticket.
    const checkSequencing = () => ({
      verdict: "go",
      reason: "",
      hard_dependencies: [
        { candidate: "CTL-OTHER", blocked_by: "CTL-IN", reason: "hallucinated candidate" },
        { candidate: "CTL-NEW", blocked_by: "CTL-NOTLIVE", reason: "blocked_by not in-flight" },
      ],
    });
    schedulerTick(orchDir, {
      readEligible: () => eligibleTwo("CTL-NEW"),
      dispatch,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 1,
      checkSequencing,
      writeStatus,
    });
    // No durable blocked-by edge written for the bogus deps
    expect(blockedByRelationCalls).toHaveLength(0);
    // With no VALID hard dep and a "go" verdict, dispatch proceeds
    const dispatchedNew = dispatch.calls.some(
      (c) => c.ticket === "CTL-NEW" || (Array.isArray(c) && c[1] === "CTL-NEW")
    );
    expect(dispatchedNew).toBe(true);
  });

  test("seam undefined → byte-for-byte legacy: dispatch proceeds with one in-flight + free slot", () => {
    const dispatch = fakeDispatch({ code: 0 });
    schedulerTick(orchDir, {
      readEligible: () => eligibleTwo("CTL-NEW"),
      dispatch,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 1,
      // checkSequencing omitted → undefined default
    });
    // Dispatch must proceed (legacy behavior — seam absent means no gate)
    const dispatchedNew = dispatch.calls.some(
      (c) => c.ticket === "CTL-NEW" || (Array.isArray(c) && c[1] === "CTL-NEW")
    );
    expect(dispatchedNew).toBe(true);
  });

  test("cooldown precedes seam — checkSequencing spy NOT called for a cooling-down candidate", () => {
    let spyCount = 0;
    const checkSequencing = () => { spyCount++; return { verdict: "go", hard_dependencies: [] }; };
    // Pre-seed a cooldown marker for CTL-NEW
    recordDispatchFailure(orchDir, "CTL-NEW", "research", 1, 1_000);
    schedulerTick(orchDir, {
      readEligible: () => eligibleTwo("CTL-NEW"),
      dispatch: fakeDispatch({ code: 0 }),
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 1,
      now: () => 30_000, // within the 60 s window
      checkSequencing,
    });
    expect(spyCount).toBe(0);
  });
});

// ── CTL-537 Phase 5: startScheduler forwards checkSequencing to runTick ──
describe("CTL-537 Phase 5: startScheduler forwards checkSequencing (runTick wiring)", () => {
  afterEach(() => __resetForTests());

  test("startScheduler forwards an injected checkSequencing spy — it is consulted on the initial tick", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    // Write an in-flight signal so inFlightCount >= 1
    writeSignal("CTL-INFLIGHT", "research", "running");

    let spyCount = 0;
    const checkSequencing = () => { spyCount++; return { verdict: "go", hard_dependencies: [] }; };

    const dispatch = fakeDispatch({ code: 0 });
    startScheduler({
      orchDir,
      dispatch,
      readEligible: () => [
        {
          identifier: "CTL-NEW",
          priority: 1,
          createdAt: "x",
          state: "Todo",
          relations: { nodes: [] },
          inverseRelations: { nodes: [] },
        },
      ],
      liveBackgroundCount: () => 1,
      checkSequencing,
      tickIntervalMs: 60_000,
      debounceMs: 5,
    });

    // The spy must have been consulted during the initial synchronous tick
    expect(spyCount).toBeGreaterThan(0);
  });
});

describe("CTL-751: applyEstimate write-back on triage→research advance", () => {
  const okDispatch = fakeDispatch();

  function writeTriageJson(ticket, obj) {
    const dir = join(orchDir, "workers", ticket);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "triage.json"), JSON.stringify(obj));
  }

  function makeWriteStatus(estimateCalls) {
    return {
      applyPhaseStatus: () => {},
      applyTerminalDone: () => {},
      applyLabel: () => {},
      applyEstimate: (a) => { estimateCalls.push(a); return { applied: true, reason: null }; },
    };
  }

  test("triage.json with estimate:5 → applyEstimate called once with {ticket, estimate:5}", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    writeSignal("CTL-1", "triage", "done");
    writeTriageJson("CTL-1", { estimated_scope: "medium", estimate: 5 });
    const calls = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: okDispatch,
      writeStatus: makeWriteStatus(calls),
      verifyDispatched: verifyOk,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ ticket: "CTL-1", estimate: 5 });
  });

  test("triage.json with no estimate → applyEstimate not called", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    writeSignal("CTL-1", "triage", "done");
    writeTriageJson("CTL-1", { estimated_scope: "medium" });
    const calls = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: okDispatch,
      writeStatus: makeWriteStatus(calls),
      verifyDispatched: verifyOk,
    });
    expect(calls).toHaveLength(0);
  });

  test("triage.json with invalid estimate:4 → applyEstimate not called by scheduler", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    writeSignal("CTL-1", "triage", "done");
    writeTriageJson("CTL-1", { estimated_scope: "medium", estimate: 4 });
    const calls = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: okDispatch,
      writeStatus: makeWriteStatus(calls),
      verifyDispatched: verifyOk,
    });
    expect(calls).toHaveLength(0);
  });

  test("advance to plan (not research) → applyEstimate not called", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    writeSignal("CTL-1", "triage", "done");
    writeSignal("CTL-1", "research", "done");
    writeTriageJson("CTL-1", { estimated_scope: "medium", estimate: 5 });
    const calls = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: okDispatch,
      writeStatus: makeWriteStatus(calls),
      verifyDispatched: verifyOk,
    });
    expect(calls).toHaveLength(0);
  });

  test("applyEstimate throwing does not break the tick", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    writeSignal("CTL-1", "triage", "done");
    writeTriageJson("CTL-1", { estimated_scope: "medium", estimate: 5 });
    const writeStatus = {
      applyPhaseStatus: () => {},
      applyTerminalDone: () => {},
      applyLabel: () => {},
      applyEstimate: () => { throw new Error("Linear exploded"); },
    };
    expect(() =>
      schedulerTick(orchDir, {
        readEligible: () => [],
        dispatch: okDispatch,
        writeStatus,
        verifyDispatched: verifyOk,
      })
    ).not.toThrow();
  });
});
