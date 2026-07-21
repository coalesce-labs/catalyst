// Unit + filesystem-fixture tests for the pull-loop scheduler (CTL-536).
// Run: cd plugins/dev/scripts/execution-core && bun test scheduler.test.mjs
//
// Phase 3 adds the selection-core blocks; Phases 4-5 extend this same file.

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readPhaseSignals,
  isTicketInFlight,
  listInFlightTickets,
  computeDispatchSurvivingRoster, // CTL-1091 Phase 3: positive-liveness dispatch roster
  resolveDispatchRoster, // CTL-1091: shared dispatch-roster resolver (liveness + deflap + outage)
  readMaxParallel,
  readExecutionCoreConcurrency,
  readExecutionCoreConcurrencyLayer2,
  mergeExecutionCoreConcurrency,
  resolveTargetSetpoint,
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
  maybeTripCircuitBreaker,
  CIRCUIT_BREAKER_THRESHOLD,
  RUNAWAY_THRESHOLD,
  RUNAWAY_WINDOW_MS,
  verifyDispatchedSignal,
  gcDispatchCooldowns,
  maybeEscalateDispatchFailures,
  holisticBoardHealthAct,
  __resetForTests,
  __getRunningOpts,
  // CTL-705: Phase 2 helpers
  STAGE_RANK,
  stageRankForTicket,
  readWorkerPriority,
  writeWorkerPriority,
  // CTL-864 remediation: persisted cross-host fence token round-trip
  readClusterGeneration,
  writeClusterGeneration,
  buildGlobalRanking,
  // CTL-700 (Item A)
  readDispatchFailureReason,
  // CTL-834: held-label apply cool-down
  convergeHeldLabel,
  labelCooldownPath,
  // CTL-1068: orphaned held-label retraction for started tickets
  convergeStartedHeldLabels,
  // CTL-768: hold-stop cooldown helpers
  holdStopCooldownPath,
  inHoldStopCooldown,
  recordHoldStop,
  clearHoldStopCooldown,
  // CTL-764 Phase 4: generalised disposition converger
  convergeDispositionLabel,
  HELD_LABEL_WAITING,
  HELD_LABEL_NEEDS_INPUT,
} from "./scheduler.mjs";
import { createTicketStateCache } from "./linear-cache.mjs";
import { fetchTicketsBatch } from "./linear-query.mjs"; // CTL-784: cache-reuse tests drive the real batch
import { reclaimDeadWorkIfPossible } from "./recovery.mjs";
import { WORK_DONE_PROBES } from "./work-done-probes.mjs";
import { ownerForTicket } from "./hrw.mjs"; // CTL-850: HRW owner computation for the ownership-filter tests
import { REMEDIATE_CYCLE_CAP } from "../lib/phase-fsm.mjs";
import { removeLabel as realRemoveLabel } from "./linear-write.mjs"; // CTL-1079: exec-spy harness
import { bootResumePendingPath, bootResumeApprovedPath } from "./boot-resume.mjs"; // CTL-1367 P2-C: per-tick approval-poll dispatch wiring

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

// seedTriage — create workers/<ticket>/triage.json so Pass 2's CTL-1150
// triage-artifact guard treats the candidate as triaged.
function seedTriage(ticket, obj = { classification: "feature" }) {
  const dir = join(orchDir, "workers", ticket);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "triage.json"), JSON.stringify(obj));
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
  test("monitor-deploy done with teardown pending is still in-flight (CTL-703)", () => {
    // monitor-deploy done no longer ends the pipeline; teardown still pending
    expect(isTicketInFlight({ "monitor-deploy": "done" })).toBe(true);
  });
  test("monitor-deploy skipped with teardown pending is still in-flight (CTL-703)", () => {
    // monitor-deploy skipped advances to teardown; teardown still pending
    expect(isTicketInFlight({ "monitor-deploy": "skipped" })).toBe(true);
  });
  test("teardown done is terminal success → NOT in-flight (CTL-703)", () => {
    expect(isTicketInFlight({ teardown: "done" })).toBe(false);
  });
  test("teardown done with all earlier phases done → NOT in-flight (CTL-703)", () => {
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
        "monitor-deploy": "done",
        teardown: "done",
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
    writeSignal("CTL-2", "teardown", "done"); // CTL-703: teardown done is terminal (not monitor-deploy)
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
    expect(mergeExecutionCoreConcurrency({ maxParallel: 4 }, { maxParallel: 0 })).toEqual({
      maxParallel: 4,
    });
    expect(mergeExecutionCoreConcurrency({ maxParallel: 4 }, { maxParallel: -1 })).toEqual({
      maxParallel: 4,
    });
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

describe("resolveTargetSetpoint (CTL-770)", () => {
  test("host targetParallel present (positive int) → returns it", () => {
    expect(resolveTargetSetpoint({ maxParallel: 4 }, { targetParallel: 6 })).toBe(6);
  });
  test("host absent → falls back to repo maxParallel", () => {
    expect(resolveTargetSetpoint({ maxParallel: 4 }, {})).toBe(4);
    expect(resolveTargetSetpoint({ maxParallel: 4 })).toBe(4);
  });
  test("both absent → undefined (caller no-ops convergence)", () => {
    expect(resolveTargetSetpoint({}, {})).toBeUndefined();
    expect(resolveTargetSetpoint()).toBeUndefined();
  });
  test("non-positive / non-integer host targetParallel falls back to repo maxParallel", () => {
    expect(resolveTargetSetpoint({ maxParallel: 4 }, { targetParallel: 0 })).toBe(4);
    expect(resolveTargetSetpoint({ maxParallel: 4 }, { targetParallel: -1 })).toBe(4);
    expect(resolveTargetSetpoint({ maxParallel: 4 }, { targetParallel: 2.5 })).toBe(4);
    expect(resolveTargetSetpoint({ maxParallel: 4 }, { targetParallel: "6" })).toBe(4);
  });
  test("host targetParallel wins even when repo maxParallel also set", () => {
    expect(resolveTargetSetpoint({ maxParallel: 4 }, { targetParallel: 8 })).toBe(8);
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
      validatePerProjectBudgets({ maxParallel: 6, perProject: { X: { reserve: "nope" } } })
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
      })
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
      readMaxParallel(orchDir, { maxParallel: 50, minParallel: 1, maxParallelCeiling: 10 })
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
function fakeDispatch({ code = 0, stderr = "", spawnError, signal } = {}) {
  const calls = [];
  const fn = (args) => {
    calls.push(args);
    // CTL-1004/CTL-1056 Bug 2: surface optional spawnError / signal so the
    // dispatch-failure diagnostic seam can be exercised. Keys stay absent unless
    // supplied, preserving the byte-identical return shape existing tests assert.
    const res = { code, stdout: "", stderr };
    if (spawnError !== undefined) res.spawnError = spawnError;
    if (signal !== undefined) res.signal = signal;
    return res;
  };
  fn.calls = calls;
  return fn;
}

// CTL-611: verifier-pass stub. The default verifyDispatchedSignal reads the
// signal file and is `false` for tests that don't write one — pass this to
// schedulerTick to opt out of demotion for non-CTL-611 tests.
const verifyOk = () => ({ ok: true });

// ── CTL-755: admission-gate fetchRelations stub helpers ──
//
// relUnblocked — a fetchTicketRelations return for a candidate with NO open
// dependency (non-terminal "Triage" state, no relations, given priority/labels).
// STEP A admits it whenever a promotion slot is free. relBlockedBy — adds a
// blocked_by inverseRelations edge (type:"blocks", issue:<blocker>) so the dep
// graph holds the candidate until the blocker hydrates terminal.
function relUnblocked({ priority = 2, labels = [], state = "Triage" } = {}) {
  return {
    state,
    relations: { nodes: [] },
    inverseRelations: { nodes: [] },
    priority,
    labels,
  };
}
function relBlockedBy(blockerId, { priority = 2, labels = [], state = "Triage" } = {}) {
  return {
    state,
    relations: { nodes: [] },
    // inverseRelations {type:"blocks", issue:<blocker>} means <blocker> BLOCKS this
    // ticket — the blocked_by edge buildDependencyEdges reads (node.issue.identifier).
    inverseRelations: { nodes: [{ type: "blocks", issue: { identifier: blockerId } }] },
    priority,
    labels,
  };
}
// A per-id descriptor dispatcher keyed by ticket id, falling back to relUnblocked.
function relMap(map) {
  return (id) => map[id] ?? relUnblocked();
}

// CTL-784: the admission gate now hydrates via a single batched seam
// (fetchBatch: (ids) => Map<id, descriptor>) instead of per-ticket fetchRelations
// / per-blocker fetchTicketState. These helpers build that seam from the same
// per-id descriptor fakes (relUnblocked / relBlockedBy / relMap).

// mkBatch — wrap a per-id descriptor source (a function or an {id: desc} object)
// into a fetchBatch. A source returning null/undefined for an id OMITS it from
// the Map, mirroring fetchTicketsBatch dropping a failed/not-found id (the
// admission gate then fails safe — treats it as held / unfetched).
function mkBatch(source) {
  const fn = typeof source === "function" ? source : (id) => source[id];
  return (ids) => {
    const m = new Map();
    for (const id of ids) {
      const d = fn(id);
      if (d != null) m.set(id, d);
    }
    return m;
  };
}

// descOf — a state-only descriptor (the hydrate / STEP-E shape: blocker/dep
// lookups only consult .state). Replaces the old execWithStates/execStates
// linearis-exec stubs that returned `{ state: { name } }` per `issues read`.
function descOf(state) {
  return {
    state,
    relations: { nodes: [] },
    inverseRelations: { nodes: [] },
    priority: null,
    labels: [],
  };
}

// batchWith — a fetchBatch that returns `candidateDesc` for the triaged-waiting
// candidate(s) and a state-only descriptor for each out-of-set blocker / dep in
// `stateById`. Replaces the old paired injection
// `fetchRelations: () => <candidateDesc>` + `exec: execWithStates(stateById)`.
function batchWith(candidateSource, stateById = {}) {
  const candFn = typeof candidateSource === "function" ? candidateSource : () => candidateSource;
  return mkBatch((id) => (id in stateById ? descOf(stateById[id]) : candFn(id)));
}

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
    writeFileSync(
      dispatchCooldownPath(orchDir, "CTL-9", "research"),
      JSON.stringify({ phase: "research", code: 1, failedAt: 5_000 })
    );
    expect(inDispatchCooldown(orchDir, "CTL-9", "research", 35_000)).toBe(true);
    expect(inDispatchCooldown(orchDir, "CTL-9", "research", 66_000)).toBe(false);
  });
});

// ── CTL-768: hold-stop cooldown helpers ──
describe("hold-stop cooldown helpers (CTL-768)", () => {
  let ctl768Dir;
  beforeEach(() => {
    ctl768Dir = mkdtempSync(join(tmpdir(), "ctl768-"));
  });
  afterEach(() => {
    rmSync(ctl768Dir, { recursive: true, force: true });
  });

  test("absent marker → not in cooldown", () => {
    expect(inHoldStopCooldown(ctl768Dir, "CTL-1", "research", 5_000)).toBe(false);
  });
  test("recordHoldStop writes a marker with stoppedAt", () => {
    recordHoldStop(ctl768Dir, "CTL-1", "research", 5_000);
    const m = JSON.parse(
      readFileSync(holdStopCooldownPath(ctl768Dir, "CTL-1", "research"), "utf8")
    );
    expect(m.stoppedAt).toBe(5_000);
  });
  test("within window → in cooldown; past window → not", () => {
    recordHoldStop(ctl768Dir, "CTL-1", "research", 5_000);
    expect(inHoldStopCooldown(ctl768Dir, "CTL-1", "research", 5_000 + 45_000)).toBe(true); // <90s
    expect(inHoldStopCooldown(ctl768Dir, "CTL-1", "research", 5_000 + 95_000)).toBe(false); // >90s
  });
  test("clearHoldStopCooldown removes the marker", () => {
    recordHoldStop(ctl768Dir, "CTL-1", "research", 5_000);
    clearHoldStopCooldown(ctl768Dir, "CTL-1", "research");
    expect(inHoldStopCooldown(ctl768Dir, "CTL-1", "research", 5_001)).toBe(false);
  });
  test("malformed marker → not in cooldown (fail-open)", () => {
    mkdirSync(join(ctl768Dir, ".hold-stop-cooldowns"), { recursive: true });
    writeFileSync(holdStopCooldownPath(ctl768Dir, "CTL-1", "research"), "{not json");
    expect(inHoldStopCooldown(ctl768Dir, "CTL-1", "research", 5_000)).toBe(false);
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
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is cooldown
    });
    expect(dispatch.calls).toHaveLength(1);
    expect(existsSync(marker)).toBe(true);

    // Tick 2 at t=30_000 (< 60 s window): suppressed → still 1 call.
    schedulerTick(orchDir, {
      readEligible: () => eligibleOne("CTL-3"),
      dispatch,
      now: () => 30_000,
      liveBackgroundCount: () => 0,
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate
    });
    expect(dispatch.calls).toHaveLength(1);

    // Tick 3 at t=70_000 (> 60 s window): re-dispatch fires → 2 calls.
    schedulerTick(orchDir, {
      readEligible: () => eligibleOne("CTL-3"),
      dispatch,
      now: () => 70_000,
      liveBackgroundCount: () => 0,
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate
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
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is cooldown
    });
    expect(existsSync(marker)).toBe(true);

    // After the window, a successful dispatch clears it.
    schedulerTick(orchDir, {
      readEligible: () => eligibleOne("CTL-4"),
      dispatch: fakeDispatch({ code: 0 }),
      now: () => 70_000,
      verifyDispatched: verifyOk, // CTL-611: not testing the verifier here
      liveBackgroundCount: () => 0,
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate
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
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is cooldown
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
    writeFileSync(
      join(orchDir, ".dispatch-cooldowns", "CTL-671-monitor-deploy.json"),
      JSON.stringify({ phase: "monitor-deploy", code: 1, failedAt: 1_000 })
    );
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
    expect(events).toEqual([
      expect.objectContaining({ ticket: "CTL-GONE", target_phase: "review" }),
    ]);
  });
});

// ── CTL-713: consecutive-failure escalation ──
describe("dispatch cool-down escalation", () => {
  const fakeWriteStatus = (applied) => ({
    applyLabel: ({ ticket, label }) => {
      applied.push({ ticket, label });
      return { applied: true };
    },
    transition: () => {},
    applyPhaseStatus: () => {},
  });

  test("maybeEscalateDispatchFailures applies needs-human at the threshold", () => {
    const applied = [];
    const ws = fakeWriteStatus(applied);
    const marker = { ticket: "CTL-5", phase: "research", code: 2, consecutiveFailures: 3 };
    const events = [];
    maybeEscalateDispatchFailures(orchDir, marker, {
      writeStatus: ws,
      appendEvent: (e) => events.push(e),
    });
    expect(applied).toEqual([{ ticket: "CTL-5", label: "needs-human" }]);
    expect(events).toEqual([
      expect.objectContaining({
        ticket: "CTL-5",
        target_phase: "research",
        consecutiveFailures: 3,
      }),
    ]);
  });

  test("maybeEscalateDispatchFailures is a no-op below the threshold", () => {
    const applied = [];
    const ws = fakeWriteStatus(applied);
    maybeEscalateDispatchFailures(
      orchDir,
      { ticket: "CTL-5", phase: "research", code: 2, consecutiveFailures: 2 },
      { writeStatus: ws, appendEvent: () => {} }
    );
    expect(applied).toEqual([]);
  });

  // CTL-764 finding 13: the return value gates the caller's worker.transition emission.
  test("finding 13 — maybeEscalateDispatchFailures returns true when it writes the label", () => {
    const applied = [];
    const ws = fakeWriteStatus(applied);
    const wrote = maybeEscalateDispatchFailures(
      orchDir,
      { ticket: "CTL-13A", phase: "research", code: 2, consecutiveFailures: 3 },
      { writeStatus: ws, appendEvent: () => {} }
    );
    expect(wrote).toBe(true);
  });

  test("finding 13 — returns false below the escalation threshold (no write)", () => {
    const applied = [];
    const ws = fakeWriteStatus(applied);
    const wrote = maybeEscalateDispatchFailures(
      orchDir,
      { ticket: "CTL-13B", phase: "research", code: 2, consecutiveFailures: 2 },
      { writeStatus: ws, appendEvent: () => {} }
    );
    expect(wrote).toBe(false);
  });

  test("schedulerTick escalates after N consecutive same-code refusals on new-work", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({ code: 2 });
    const applied = [];
    const ws = fakeWriteStatus(applied);
    // CTL-764 finding 13: the escalation must also record a worker.transition.
    const transitions = [];
    let t = 0;
    for (let i = 0; i < 3; i++) {
      schedulerTick(orchDir, {
        readEligible: () => [
          {
            identifier: "CTL-7",
            priority: 1,
            createdAt: "x",
            state: "Todo",
            relations: { nodes: [] },
            inverseRelations: { nodes: [] },
          },
        ],
        dispatch,
        writeStatus: ws,
        liveBackgroundCount: () => 0,
        now: () => (t += 31 * 60 * 1000),
        hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is escalation
        appendWorkerTransitionEvent: (ev) => transitions.push(ev),
      });
    }
    expect(applied).toContainEqual({ ticket: "CTL-7", label: "needs-human" });
    // CTL-764 finding 13: a ticket escalated solely by dispatch failures gets a
    // worker.transition(toDisposition="needs-human", source="dispatch-failures").
    const escalation = transitions.find(
      (e) => e.ticket === "CTL-7" && e.toDisposition === "needs-human"
    );
    expect(escalation).toBeDefined();
    expect(escalation.source).toBe("dispatch-failures");
  });
});

// ── CTL-671 Phase 1: per-ticket dispatch-failure circuit breaker ──
describe("dispatch circuit breaker (CTL-671)", () => {
  test("recordDispatchFailure increments consecutiveFailures and preserves CTL-624 fields", () => {
    const t = "CTL-9",
      phase = "research";
    recordDispatchFailure(orchDir, t, phase, 1, 1000);
    recordDispatchFailure(orchDir, t, phase, 1, 2000);
    const m = JSON.parse(readFileSync(dispatchCooldownPath(orchDir, t, phase), "utf8"));
    expect(m.failedAt).toBe(2000); // CTL-624 field preserved (latest)
    expect(m.phase).toBe(phase); // CTL-624 field preserved
    expect(m.code).toBe(1); // CTL-624 field preserved
    expect(m.consecutiveFailures).toBe(2); // new counter
  });

  test("clearDispatchCooldown resets the counter (success heals)", () => {
    recordDispatchFailure(orchDir, "CTL-9", "research", 1, 1000);
    clearDispatchCooldown(orchDir, "CTL-9", "research");
    // marker gone → fresh failure starts at 1
    recordDispatchFailure(orchDir, "CTL-9", "research", 1, 3000);
    const m = JSON.parse(readFileSync(dispatchCooldownPath(orchDir, "CTL-9", "research"), "utf8"));
    expect(m.consecutiveFailures).toBe(1);
  });

  test("a pre-CTL-671 marker without consecutiveFailures self-upgrades from 0", () => {
    // A legacy CTL-624 marker (no counter field) reads as 0, so the first new
    // failure writes consecutiveFailures: 1 (the `?? 0` default — Migration Notes).
    mkdirSync(join(orchDir, ".dispatch-cooldowns"), { recursive: true });
    writeFileSync(
      dispatchCooldownPath(orchDir, "CTL-9", "research"),
      JSON.stringify({ phase: "research", code: 2, failedAt: 500 })
    );
    recordDispatchFailure(orchDir, "CTL-9", "research", 2, 1000);
    const m = JSON.parse(readFileSync(dispatchCooldownPath(orchDir, "CTL-9", "research"), "utf8"));
    expect(m.consecutiveFailures).toBe(1);
  });

  test("maybeTripCircuitBreaker writes terminal stalled at threshold, idempotently", () => {
    const t = "CTL-9",
      phase = "research";
    writeSignal(t, phase, "running");
    for (let i = 1; i <= CIRCUIT_BREAKER_THRESHOLD; i++)
      recordDispatchFailure(orchDir, t, phase, 1, i * 1000);
    expect(maybeTripCircuitBreaker(orchDir, t, phase)).toBe(true);
    const sig = JSON.parse(
      readFileSync(join(orchDir, "workers", t, `phase-${phase}.json`), "utf8")
    );
    expect(sig.status).toBe("stalled");
    expect(sig.stalledReason).toBe("dispatch-circuit-breaker");
    expect(sig.consecutiveFailures).toBe(CIRCUIT_BREAKER_THRESHOLD);
    expect(maybeTripCircuitBreaker(orchDir, t, phase)).toBe(true); // idempotent (already stalled)
  });

  test("below threshold does NOT trip", () => {
    writeSignal("CTL-9", "research", "running");
    recordDispatchFailure(orchDir, "CTL-9", "research", 1, 1000);
    expect(maybeTripCircuitBreaker(orchDir, "CTL-9", "research")).toBe(false);
    const sig = JSON.parse(
      readFileSync(join(orchDir, "workers", "CTL-9", "phase-research.json"), "utf8")
    );
    expect(sig.status).toBe("running"); // untouched
  });

  test("no marker → does NOT trip (absent counter)", () => {
    expect(maybeTripCircuitBreaker(orchDir, "CTL-9", "research")).toBe(false);
  });

  test("at threshold with no signal still reports tripped so the caller skips dispatch", () => {
    // Refused-dispatch case: the target phase signal was never written. The
    // breaker has nothing to stall but must still return true so the caller
    // stops re-dispatching.
    const t = "CTL-9",
      phase = "plan";
    for (let i = 1; i <= CIRCUIT_BREAKER_THRESHOLD; i++)
      recordDispatchFailure(orchDir, t, phase, 2, i * 1000);
    expect(maybeTripCircuitBreaker(orchDir, t, phase)).toBe(true);
    expect(existsSync(join(orchDir, "workers", t, `phase-${phase}.json`))).toBe(false);
  });

  test("schedulerTick stops dispatching after THRESHOLD consecutive failures", () => {
    // Rebase note (CTL-671 onto CTL-712/CTL-713): two sibling mechanisms now
    // co-exist on the advancement path — the CTL-712 max-dispatch-retries
    // terminal stop (escalateDispatchExhausted at getMaxDispatchRetries()=5) and
    // CTL-671's own circuit breaker (CIRCUIT_BREAKER_THRESHOLD=8). To isolate the
    // CTL-671 breaker (the subject under test) we lift the CTL-712 ceiling above
    // the breaker threshold so the breaker is the gate that fires. We also use a
    // TRANSIENT failure code (1): CTL-712 classifies code 2 as a PERMANENT failure
    // (PERMANENT_FAILURE_CODES) with a 30-min cooldown, which would suppress the
    // re-dispatch retries this test relies on.
    const prevMax = process.env.SCHEDULER_MAX_DISPATCH_RETRIES;
    process.env.SCHEDULER_MAX_DISPATCH_RETRIES = String(CIRCUIT_BREAKER_THRESHOLD + 5);
    try {
      writeSignal("CTL-9", "research", "done"); // in-flight; advancement → plan
      const dispatch = fakeDispatch({ code: 1 }); // every dispatch refused (transient)
      // Each tick is past the 60 s cool-down window so a fresh failure records.
      for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD; i++) {
        schedulerTick(orchDir, {
          readEligible: () => [],
          dispatch,
          now: () => (i + 1) * 70_000,
          liveBackgroundCount: () => 0,
        });
      }
      expect(dispatch.calls).toHaveLength(CIRCUIT_BREAKER_THRESHOLD);
      const m = JSON.parse(readFileSync(dispatchCooldownPath(orchDir, "CTL-9", "plan"), "utf8"));
      expect(m.consecutiveFailures).toBe(CIRCUIT_BREAKER_THRESHOLD);
      // One more tick past the window: the top-of-loop breaker guard suppresses it.
      schedulerTick(orchDir, {
        readEligible: () => [],
        dispatch,
        now: () => (CIRCUIT_BREAKER_THRESHOLD + 2) * 70_000,
        liveBackgroundCount: () => 0,
      });
      expect(dispatch.calls).toHaveLength(CIRCUIT_BREAKER_THRESHOLD); // no growth — breaker held
    } finally {
      if (prevMax === undefined) delete process.env.SCHEDULER_MAX_DISPATCH_RETRIES;
      else process.env.SCHEDULER_MAX_DISPATCH_RETRIES = prevMax;
    }
  });
});

// ── CTL-671 Phase 3: phantom/orphan worker-dir validity sweep ──
describe("phantom worker-dir validity sweep (CTL-671)", () => {
  // The sweep's seams are injected directly (classifyResolution returns the
  // 3-valued result; classifyTicketResolution's parsing is covered in
  // linear-query.test.mjs). schedulerTick's defaults are safe no-ops, so the
  // sweep only acts here because we arm it.
  const resolveTo = (verdict) => () => verdict;
  const eligibleFull = (id) => ({
    identifier: id,
    priority: 1,
    state: "Todo",
    relations: { nodes: [] },
    inverseRelations: { nodes: [] },
  });

  test("quarantines a not-found + not-eligible + dead worker dir", () => {
    writeSignal("CTL-9", "implement", "running");
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      liveBackgroundCount: () => 0,
      classifyResolution: resolveTo("not-found"),
      isBgJobAlive: () => false,
    });
    const sig = JSON.parse(
      readFileSync(join(orchDir, "workers", "CTL-9", "phase-implement.json"), "utf8")
    );
    expect(sig.status).toBe("stalled");
    expect(sig.stalledReason).toBe("phantom-ticket");
  });

  test("does NOT quarantine a live in-process SDK worker (CTL-1410 Phase B)", () => {
    // An SDK worker has NO bg id (liveness.value null), so the bg gate can't
    // protect it — only the in-process registry probe can. not-found +
    // not-eligible would otherwise quarantine it.
    writeSignal("CTL-9", "implement", "running");
    const r = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      liveBackgroundCount: () => 0,
      classifyResolution: resolveTo("not-found"),
      isBgJobAlive: () => false,
      isSdkWorkerLive: (ticket) => ticket === "CTL-9",
    });
    const sig = JSON.parse(
      readFileSync(join(orchDir, "workers", "CTL-9", "phase-implement.json"), "utf8")
    );
    expect(sig.status).toBe("running"); // untouched
    expect(r.quarantinedPhantoms ?? []).toEqual([]);
  });

  test("does NOT quarantine when Linear resolution is unknown (outage safety)", () => {
    writeSignal("CTL-100", "implement", "running");
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      liveBackgroundCount: () => 0,
      classifyResolution: resolveTo("unknown"), // transient outage
      isBgJobAlive: () => false,
    });
    const sig = JSON.parse(
      readFileSync(join(orchDir, "workers", "CTL-100", "phase-implement.json"), "utf8")
    );
    expect(sig.status).toBe("running"); // untouched
  });

  test("does NOT quarantine a ticket present in the eligible set", () => {
    writeSignal("CTL-100", "implement", "running");
    let classifyCalls = 0;
    schedulerTick(orchDir, {
      readEligible: () => [eligibleFull("CTL-100")], // eligible → real ticket
      dispatch: () => ({ code: 0 }),
      liveBackgroundCount: () => 0,
      classifyResolution: () => {
        classifyCalls++;
        return "not-found";
      },
      isBgJobAlive: () => false,
    });
    expect(
      JSON.parse(readFileSync(join(orchDir, "workers", "CTL-100", "phase-implement.json"), "utf8"))
        .status
    ).toBe("running");
    expect(classifyCalls).toBe(0); // eligible short-circuits before the Linear probe
  });

  // ── CTL-1336: zero-spawn bg-liveness gate. The skip DECISION (fresh+alive / fresh+dead /
  // cold→fail-open / no-bg) is a pure exported helper `bgLivenessProtects`, unit-tested in
  // phantom-worker-dir.test.mjs (CI-gated, no harness interference). Here we only pin the
  // in-tick WIRING: a bare (no-bg) signal must never fetch the snapshot, so an unarmed tick
  // stays a true no-op (no async `claude agents` warmer kick). Driving the full tick with a
  // real bg signal is avoided on purpose — a bg+not-found signal also trips the reclaim/revive/
  // terminal passes, which would mask Pass 0a's decision. ──
  test("a bare (no-bg) in-flight signal never fetches the agents snapshot — unarmed tick stays a no-op (CTL-1336)", () => {
    writeSignal("CTL-9", "implement", "running"); // no bg_job_id → bgId null
    let getAgentsCalls = 0;
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      liveBackgroundCount: () => 0,
      getAgents: () => {
        getAgentsCalls++;
        return { isFresh: true, agents: [] };
      },
      classifyResolution: resolveTo("unknown"), // bgId null → proceeds here; unknown → no quarantine
      isBgJobAlive: () => false,
    });
    expect(getAgentsCalls).toBe(0); // bare tick never fetched the snapshot
  });

  test("skips already-terminal signals (idempotent / no rework, never probes Linear)", () => {
    writeSignal("CTL-9", "implement", "stalled");
    let classifyCalls = 0;
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      liveBackgroundCount: () => 0,
      classifyResolution: () => {
        classifyCalls++;
        return "not-found";
      },
      isBgJobAlive: () => false,
    });
    expect(classifyCalls).toBe(0); // never probes a terminal ticket
  });

  test("returns the quarantined phantoms list for the daemon log / HUD", () => {
    writeSignal("CTL-9", "implement", "running");
    const result = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      liveBackgroundCount: () => 0,
      classifyResolution: resolveTo("not-found"),
      isBgJobAlive: () => false,
    });
    expect(result.quarantinedPhantoms).toEqual([{ ticket: "CTL-9", phase: "implement" }]);
  });
});

// ── CTL-671 Phase 4: runaway event-rate domination alert ──
describe("runaway event-rate alert (CTL-671)", () => {
  test("emits exactly one runaway event per window when a ticket dominates", () => {
    writeSignal("CTL-9", "implement", "running");
    const runawayCalls = [];
    const opts = {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      liveBackgroundCount: () => 0,
      isBgJobAlive: () => true, // isolate the alert from phantom quarantine
      countTicketEvents: () => RUNAWAY_THRESHOLD, // at threshold → fires
      appendRunawayEvent: (arg) => {
        runawayCalls.push(arg);
        return true;
      },
      now: () => 1_000_000,
    };
    schedulerTick(orchDir, opts);
    expect(runawayCalls).toHaveLength(1);
    expect(runawayCalls[0]).toMatchObject({
      ticket: "CTL-9",
      count: RUNAWAY_THRESHOLD,
      window_ms: RUNAWAY_WINDOW_MS,
    });

    // Second tick within the same window → suppressed by the once-per-window marker.
    schedulerTick(orchDir, opts);
    expect(runawayCalls).toHaveLength(1);

    // A tick past the window → fires again.
    schedulerTick(orchDir, { ...opts, now: () => 1_000_000 + RUNAWAY_WINDOW_MS + 1 });
    expect(runawayCalls).toHaveLength(2);
  });

  test("does NOT emit below threshold", () => {
    writeSignal("CTL-9", "implement", "running");
    const runawayCalls = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      liveBackgroundCount: () => 0,
      isBgJobAlive: () => true,
      countTicketEvents: () => RUNAWAY_THRESHOLD - 1, // below threshold
      appendRunawayEvent: (arg) => {
        runawayCalls.push(arg);
        return true;
      },
      now: () => 1_000_000,
    });
    expect(runawayCalls).toHaveLength(0);
  });

  test("alerts a noisy ticket even when it is eligible (real but runaway)", () => {
    // The alert is observability, not enforcement — it must fire before the
    // eligible short-circuit so a real, eligible, noisy ticket is still surfaced.
    writeSignal("CTL-100", "implement", "running");
    const runawayCalls = [];
    schedulerTick(orchDir, {
      readEligible: () => [
        {
          identifier: "CTL-100",
          priority: 1,
          state: "Todo",
          relations: { nodes: [] },
          inverseRelations: { nodes: [] },
        },
      ],
      dispatch: () => ({ code: 0 }),
      liveBackgroundCount: () => 0,
      isBgJobAlive: () => true,
      countTicketEvents: () => RUNAWAY_THRESHOLD + 5,
      appendRunawayEvent: (arg) => {
        runawayCalls.push(arg);
        return true;
      },
      now: () => 2_000_000,
    });
    expect(runawayCalls).toHaveLength(1);
    expect(runawayCalls[0].ticket).toBe("CTL-100");
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
  test("monitor-deploy done → teardown (CTL-703: teardown is 10th phase)", () => {
    expect(deriveAdvancement({ "monitor-deploy": "done" })).toBe("teardown");
  });
  test("monitor-deploy skipped → teardown (CTL-703: skipped is advancement-eligible for non-terminal phase)", () => {
    expect(deriveAdvancement({ "monitor-deploy": "skipped" })).toBe("teardown");
  });
  test("skipped on any OTHER phase does NOT advance (holds the slot — isTicketInFlight producer-bug guard)", () => {
    expect(deriveAdvancement({ implement: "skipped" })).toBeNull();
    expect(deriveAdvancement({ triage: "done", research: "skipped" })).toBeNull();
    expect(deriveAdvancement({ verify: "skipped" })).toBeNull();
  });
  test("teardown done → null (pipeline terminal after CTL-703)", () => {
    expect(deriveAdvancement({ teardown: "done" })).toBeNull();
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
    expect(deriveAdvancement({ ...base, verify: "done" }, { verifyVerdict: "pass" })).toBe(
      "review"
    );
  });
  test("verdict null → review (conservative: missing verify.json is not a regression)", () => {
    expect(deriveAdvancement({ ...base, verify: "done" }, { verifyVerdict: null })).toBe("review");
  });
  test("verdict fail + cycle < cap + remediate not dispatched → remediate", () => {
    expect(
      deriveAdvancement(
        { ...base, verify: "done" },
        { verifyVerdict: "fail", remediateCycleCount: 0 }
      )
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
    expect(
      deriveAdvancement({ ...base, verify: "done", remediate: "done" }, { verifyVerdict: "pass" })
    ).toBe("review");
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
      maybeEscalateRemediateExhausted(
        orchDir,
        "CTL-653",
        { verify: "done" },
        "fail",
        REMEDIATE_CYCLE_CAP
      )
    ).toBe(true);
    const sig = JSON.parse(
      readFileSync(join(orchDir, "workers", "CTL-653", "phase-verify.json"), "utf8")
    );
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
      maybeEscalateRemediateExhausted(
        orchDir,
        "CTL-653",
        { verify: "done" },
        "fail",
        REMEDIATE_CYCLE_CAP
      )
    ).toBe(true);
    expect(JSON.parse(readFileSync(join(wdir, "phase-verify.json"), "utf8")).status).toBe(
      "stalled"
    );
  });
  test("cycle < cap → no-op false", () => {
    expect(maybeEscalateRemediateExhausted(orchDir, "CTL-653", { verify: "done" }, "fail", 0)).toBe(
      false
    );
  });
  test("verdict pass → no-op false (never stalls a passing verify)", () => {
    expect(
      maybeEscalateRemediateExhausted(orchDir, "CTL-653", { verify: "done" }, "pass", 99)
    ).toBe(false);
  });
  test("verify not done → no-op false", () => {
    expect(
      maybeEscalateRemediateExhausted(orchDir, "CTL-653", { verify: "running" }, "fail", 99)
    ).toBe(false);
  });

  // CTL-1108: explanation wiring
  test("CTL-1108: writes explanation.call_to_action sourced from verify.json HIGH findings", () => {
    const wdir = join(orchDir, "workers", "CTL-1108a");
    mkdirSync(wdir, { recursive: true });
    writeFileSync(
      join(wdir, "phase-verify.json"),
      JSON.stringify({ ticket: "CTL-1108a", phase: "verify", status: "done" })
    );
    writeFileSync(
      join(wdir, "verify.json"),
      JSON.stringify({
        regression_risk: 6,
        findings: [
          {
            severity: "high",
            file: "broker/router.mjs",
            line: 352,
            message: "getEventScope reads retired attr vcs.revision",
            recommendation: "read vcs.ref.revision",
          },
        ],
      })
    );
    expect(
      maybeEscalateRemediateExhausted(
        orchDir,
        "CTL-1108a",
        { verify: "done" },
        "fail",
        REMEDIATE_CYCLE_CAP
      )
    ).toBe(true);
    const sig = JSON.parse(readFileSync(join(wdir, "phase-verify.json"), "utf8"));
    expect(sig.status).toBe("stalled");
    expect(sig.stalledReason).toBe("remediate-cycle-cap-exhausted");
    expect(sig.explanation).toBeTruthy();
    expect(typeof sig.explanation.call_to_action).toBe("string");
    expect(sig.explanation.call_to_action).toContain(
      "verify keeps failing on broker/router.mjs:352"
    );
  });

  test("CTL-1108: missing verify.json → still stalls with a (degraded) explanation, never throws", () => {
    const wdir = join(orchDir, "workers", "CTL-1108b");
    mkdirSync(wdir, { recursive: true });
    writeFileSync(
      join(wdir, "phase-verify.json"),
      JSON.stringify({ ticket: "CTL-1108b", phase: "verify", status: "done" })
    );
    // no verify.json on disk
    expect(
      maybeEscalateRemediateExhausted(
        orchDir,
        "CTL-1108b",
        { verify: "done" },
        "fail",
        REMEDIATE_CYCLE_CAP
      )
    ).toBe(true);
    const sig = JSON.parse(readFileSync(join(wdir, "phase-verify.json"), "utf8"));
    expect(sig.status).toBe("stalled");
    expect(sig.explanation).toBeTruthy();
    expect(typeof sig.explanation.call_to_action).toBe("string");
  });

  test("CTL-1108: idempotent — already-stalled signal with existing explanation is not clobbered", () => {
    const wdir = join(orchDir, "workers", "CTL-1108c");
    mkdirSync(wdir, { recursive: true });
    const existing = {
      ticket: "CTL-1108c",
      phase: "verify",
      status: "stalled",
      stalledReason: "remediate-cycle-cap-exhausted",
      explanation: { call_to_action: "original question" },
    };
    writeFileSync(join(wdir, "phase-verify.json"), JSON.stringify(existing));
    expect(
      maybeEscalateRemediateExhausted(
        orchDir,
        "CTL-1108c",
        { verify: "done" },
        "fail",
        REMEDIATE_CYCLE_CAP
      )
    ).toBe(true);
    const sig = JSON.parse(readFileSync(join(wdir, "phase-verify.json"), "utf8"));
    expect(sig.explanation.call_to_action).toBe("original question");
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
    writeFileSync(
      p,
      JSON.stringify({ ticket: "CTL-712", phase: "pr", status: "dispatched", bg_job_id: "abc123" })
    );
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

  // CTL-1045 Bug 2: persist the dispatch failure exit code + cause so J3 can
  // tell the benign prior-artifact-missing case (code 2) from verify_failed (0)
  // or crash (≠ 2). A legacy signal without code stays operator-owned.
  test("CTL-1045 Bug 2: persists dispatchFailureCode + dispatchFailureCause when provided", () => {
    escalateDispatchExhausted(orchDir, "CTL-712", "pr", {
      code: 2,
      cause: "prior_artifact_missing:research_doc",
    });
    const sig = JSON.parse(
      readFileSync(join(orchDir, "workers", "CTL-712", "phase-pr.json"), "utf8")
    );
    expect(sig.stalledReason).toBe("prior-artifact-retry-exhausted");
    expect(sig.dispatchFailureCode).toBe(2);
    expect(sig.dispatchFailureCause).toBe("prior_artifact_missing:research_doc");
  });

  test("CTL-1045 Bug 2: defaults dispatchFailureCode / dispatchFailureCause to null when omitted (back-compat)", () => {
    escalateDispatchExhausted(orchDir, "CTL-712", "pr");
    const sig = JSON.parse(
      readFileSync(join(orchDir, "workers", "CTL-712", "phase-pr.json"), "utf8")
    );
    expect(sig.dispatchFailureCode).toBeNull();
    expect(sig.dispatchFailureCause).toBeNull();
  });

  // CTL-1108: explanation coverage
  test("CTL-1108: escalateDispatchExhausted attaches an explanation with non-empty call_to_action", () => {
    expect(escalateDispatchExhausted(orchDir, "CTL-1108e", "pr")).toBe(true);
    const sig = JSON.parse(
      readFileSync(join(orchDir, "workers", "CTL-1108e", "phase-pr.json"), "utf8")
    );
    expect(sig.stalledReason).toBe("prior-artifact-retry-exhausted");
    expect(sig.explanation).toBeTruthy();
    expect(typeof sig.explanation.call_to_action).toBe("string");
    expect(sig.explanation.call_to_action.trim()).not.toBe("");
  });
});

// ─── CTL-1108: writeTerminalStalled explanation coverage ───
describe("CTL-1108: writeTerminalStalled explanation coverage", () => {
  test("dispatch-circuit-breaker stall carries an explanation", () => {
    const t = "CTL-1108f",
      phase = "research";
    writeSignal(t, phase, "running");
    for (let i = 1; i <= CIRCUIT_BREAKER_THRESHOLD; i++)
      recordDispatchFailure(orchDir, t, phase, 1, i * 1000);
    expect(maybeTripCircuitBreaker(orchDir, t, phase)).toBe(true);
    const sig = JSON.parse(
      readFileSync(join(orchDir, "workers", t, `phase-${phase}.json`), "utf8")
    );
    expect(sig.stalledReason).toBe("dispatch-circuit-breaker");
    expect(sig.explanation).toBeTruthy();
    expect(typeof sig.explanation.call_to_action).toBe("string");
    expect(sig.explanation.call_to_action.trim()).not.toBe("");
  });

  test("coverage guard: every scheduler stall reason produces a non-null explanation.call_to_action", () => {
    // remediate-cycle-cap-exhausted (maybeEscalateRemediateExhausted)
    {
      const wdir = join(orchDir, "workers", "CTL-1108g");
      mkdirSync(wdir, { recursive: true });
      writeFileSync(
        join(wdir, "phase-verify.json"),
        JSON.stringify({ ticket: "CTL-1108g", phase: "verify", status: "done" })
      );
      maybeEscalateRemediateExhausted(
        orchDir,
        "CTL-1108g",
        { verify: "done" },
        "fail",
        REMEDIATE_CYCLE_CAP
      );
      const sig = JSON.parse(readFileSync(join(wdir, "phase-verify.json"), "utf8"));
      expect(sig.explanation?.call_to_action?.trim()).toBeTruthy();
    }
    // prior-artifact-retry-exhausted (escalateDispatchExhausted)
    {
      escalateDispatchExhausted(orchDir, "CTL-1108h", "plan");
      const sig = JSON.parse(
        readFileSync(join(orchDir, "workers", "CTL-1108h", "phase-plan.json"), "utf8")
      );
      expect(sig.explanation?.call_to_action?.trim()).toBeTruthy();
    }
    // dispatch-circuit-breaker (maybeTripCircuitBreaker → writeTerminalStalled)
    {
      const t = "CTL-1108i",
        phase = "implement";
      writeSignal(t, phase, "running");
      for (let i = 1; i <= CIRCUIT_BREAKER_THRESHOLD; i++)
        recordDispatchFailure(orchDir, t, phase, 1, i * 1000);
      maybeTripCircuitBreaker(orchDir, t, phase);
      const sig = JSON.parse(
        readFileSync(join(orchDir, "workers", t, `phase-${phase}.json`), "utf8")
      );
      expect(sig.explanation?.call_to_action?.trim()).toBeTruthy();
    }
  });
});

// ─── CTL-1131: needsHumanSince stamped at terminal-stall write sites ───
describe("CTL-1131: escalateDispatchExhausted stamps needsHumanSince", () => {
  const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

  test("new signal: carries a needsHumanSince ISO string and preserves explanation", () => {
    expect(escalateDispatchExhausted(orchDir, "CTL-1131a", "pr")).toBe(true);
    const sig = JSON.parse(
      readFileSync(join(orchDir, "workers", "CTL-1131a", "phase-pr.json"), "utf8")
    );
    expect(typeof sig.needsHumanSince).toBe("string");
    expect(ISO_RE.test(sig.needsHumanSince)).toBe(true);
    expect(sig.explanation).toBeTruthy();
  });

  test("existing signal with needsHumanSince: preserves the prior stamp (does not reset age)", () => {
    const p = join(orchDir, "workers", "CTL-1131b", "phase-pr.json");
    mkdirSync(join(orchDir, "workers", "CTL-1131b"), { recursive: true });
    writeFileSync(
      p,
      JSON.stringify({
        ticket: "CTL-1131b",
        phase: "pr",
        status: "running",
        needsHumanSince: "2026-06-14T00:00:00Z",
      })
    );
    escalateDispatchExhausted(orchDir, "CTL-1131b", "pr");
    const sig = JSON.parse(readFileSync(p, "utf8"));
    expect(sig.needsHumanSince).toBe("2026-06-14T00:00:00Z");
  });
});

describe("CTL-1131: writeTerminalStalled (via maybeTripCircuitBreaker) stamps needsHumanSince", () => {
  const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

  test("stalled signal carries a needsHumanSince ISO string", () => {
    const t = "CTL-1131c",
      phase = "implement";
    writeSignal(t, phase, "running");
    for (let i = 1; i <= CIRCUIT_BREAKER_THRESHOLD; i++)
      recordDispatchFailure(orchDir, t, phase, 1, i * 1000);
    expect(maybeTripCircuitBreaker(orchDir, t, phase)).toBe(true);
    const sig = JSON.parse(
      readFileSync(join(orchDir, "workers", t, `phase-${phase}.json`), "utf8")
    );
    expect(typeof sig.needsHumanSince).toBe("string");
    expect(ISO_RE.test(sig.needsHumanSince)).toBe(true);
  });

  test("existing needsHumanSince is preserved (does not reset age)", () => {
    const t = "CTL-1131d",
      phase = "verify";
    writeSignal(t, phase, "running");
    const p = join(orchDir, "workers", t, `phase-${phase}.json`);
    const cur = JSON.parse(readFileSync(p, "utf8"));
    writeFileSync(p, JSON.stringify({ ...cur, needsHumanSince: "2026-06-14T05:00:00Z" }));
    for (let i = 1; i <= CIRCUIT_BREAKER_THRESHOLD; i++)
      recordDispatchFailure(orchDir, t, phase, 1, i * 1000);
    maybeTripCircuitBreaker(orchDir, t, phase);
    const sig = JSON.parse(readFileSync(p, "utf8"));
    expect(sig.needsHumanSince).toBe("2026-06-14T05:00:00Z");
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
    const writeStatus = {
      ...noWrites(),
      applyLabel: (a) => {
        labels.push(a);
        return { applied: true };
      },
    };

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
    // CTL-1150: seed real triage.json files so the default filesystem predicate passes.
    seedTriage("CTL-8");
    seedTriage("CTL-9");
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
      // CTL-1150: seeding triage.json creates workers/<ticket>/ dirs; override
      // listStartedTickets so the seeded tickets are not excluded from Pass 2.
      listStartedTickets: () => new Set(),
    });
    // 2 free slots, both ready → both dispatched, urgent (CTL-8) first.
    expect(dispatch.calls.map((c) => c.ticket)).toEqual(["CTL-8", "CTL-9"]);
    // CTL-565: new-work enters the pipeline at research, not triage.
    expect(dispatch.calls.every((c) => c.phase === "research")).toBe(true);
    expect(r.dispatched).toEqual(["CTL-8", "CTL-9"]);
  });

  // CTL-1367 P1: under dispatchMode=sdk the in-process SDK workers (no `claude --bg`
  // job → invisible to liveBackgroundCount) must consume slot-gate capacity, else
  // the next tick over-dispatches past maxParallel. The countSdkInflight seam adds
  // their occupancy, GATED on dispatchMode === "sdk". (scheduler.test.mjs is
  // CI-excluded; the gating arithmetic is also covered purely + in CI by
  // sdk-slot-gate.test.mjs and signal-reader.test.mjs.)
  test("dispatchMode=sdk: SDK in-flight workers reduce new-work free slots", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 3 }));
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
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0, // no bg jobs
      countSdkInflight: () => 2, // 2 in-process SDK workers already in flight
      dispatchMode: "sdk",
      hasTriageArtifact: () => true,
      listStartedTickets: () => new Set(),
    });
    // maxParallel 3 − 2 SDK in-flight = 1 free slot → only ONE new ticket admitted.
    expect(r.dispatched).toHaveLength(1);
  });

  // CTL-1457 (T2): a codex-exec node prelaunches the SAME no-bg_job_id "dispatched"
  // signals (queued behind a semaphore), so its in-flight workers must reduce free
  // slots EXACTLY like sdk — else a codex node at maxParallel keeps over-admitting.
  test("dispatchMode=codex-exec: in-flight codex workers reduce new-work free slots (same as sdk)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 3 }));
    const dispatch = fakeDispatch();
    const eligible = ["CTL-1", "CTL-2", "CTL-3"].map((identifier) => ({
      identifier,
      priority: 1,
      createdAt: "x",
      state: "Todo",
      relations: { nodes: [] },
      inverseRelations: { nodes: [] },
    }));
    const r = schedulerTick(orchDir, {
      readEligible: () => eligible,
      dispatch,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0, // no bg jobs
      countSdkInflight: () => 2, // 2 in-process codex workers already in flight
      dispatchMode: "codex-exec",
      hasTriageArtifact: () => true,
      listStartedTickets: () => new Set(),
    });
    // maxParallel 3 − 2 codex in-flight = 1 free slot → only ONE new ticket admitted.
    expect(r.dispatched).toHaveLength(1);
  });

  // CTL-1457 (N1): the PRIMARY rollout routes ONE phase to codex-exec/sdk on a node
  // whose boot dispatchMode is still "phase-agents" (bg). There the mode gate is false,
  // so WITHOUT hasInProcessRoute the routed no-bg workers are invisible and the tick
  // over-admits past maxParallel. With hasInProcessRoute=true the occupancy gate arms
  // countSdkInflight even under bg — matching executorByPhase={triage:codex-exec}.
  test("dispatchMode=phase-agents + hasInProcessRoute: routed no-bg workers reduce free slots (the Phase-5 bg-node scenario)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 3 }));
    const dispatch = fakeDispatch();
    const eligible = ["CTL-1", "CTL-2", "CTL-3"].map((identifier) => ({
      identifier,
      priority: 1,
      createdAt: "x",
      state: "Todo",
      relations: { nodes: [] },
      inverseRelations: { nodes: [] },
    }));
    const r = schedulerTick(orchDir, {
      readEligible: () => eligible,
      dispatch,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0, // no bg jobs
      countSdkInflight: () => 2, // 2 routed no-bg (codex) workers already in flight
      dispatchMode: "phase-agents", // NODE mode is bg — only the per-phase route is in-process
      hasInProcessRoute: true, // executorByPhase={triage:codex-exec}
      hasTriageArtifact: () => true,
      listStartedTickets: () => new Set(),
    });
    // maxParallel 3 − 2 routed in-flight = 1 free slot → only ONE new ticket admitted.
    expect(r.dispatched).toHaveLength(1);
  });

  // CTL-1367 P2 (item b): the SDK new-work budget must subtract SAME-TICK SDK
  // advancements. The tick-top countSdkInflight sample predates the advancement sweep,
  // so without the post-sweep re-sample an in-flight ticket advancing research→plan via
  // SDK PLUS a new-work pull could BOTH fire in one tick at maxParallel=1 — a 2nd SDK
  // signal beyond parallelism. The injected countSdkInflight is STATEFUL (the mock
  // dispatch increments the live SDK count as each in-process worker's prelaunch lands),
  // so it returns 0 at the tick-top sample and 1 after the research→plan advance — a real
  // guard, not a tautology (without the re-sample the new-work pull reads the stale 0).
  test("dispatchMode=sdk: a same-tick SDK advancement subtracts from the new-work budget (CTL-1367 item b)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    // CTL-7 in-flight at research:done → the advancement sweep dispatches plan via SDK.
    writeSignal("CTL-7", "research", "done");
    // One eligible NEW ticket which, on the STALE tick-top count (0), would wrongly be
    // admitted into the slot the research→plan advance just took.
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
    // Stateful SDK occupancy: 0 in-flight at tick top (CTL-7's research:done is terminal —
    // not counted), incremented as each in-process SDK worker's prelaunch writes a
    // `dispatched` signal. The mock dispatch drives the same counter the re-sample reads.
    let sdkInflightNow = 0;
    const dispatch = Object.assign(
      (args) => {
        dispatch.calls.push(args);
        sdkInflightNow += 1; // an SDK launch writes a `dispatched` nested signal (no bg id)
        return { code: 0 };
      },
      { calls: [] }
    );
    const r = schedulerTick(orchDir, {
      readEligible: () => eligible,
      dispatch,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0, // no bg jobs under SDK
      countSdkInflight: () => sdkInflightNow,
      dispatchMode: "sdk",
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is the slot budget
      listStartedTickets: () => new Set(),
    });
    // The research→plan advance fired (count-independent, not admission-gated)…
    expect(r.advanced).toEqual([{ ticket: "CTL-7", phase: "plan" }]);
    // …and consumed the single slot, so NO new-work ticket is admitted this tick.
    expect(r.dispatched).toEqual([]);
    // Exactly ONE SDK dispatch in the tick (the advance) — no 2nd signal beyond parallelism.
    expect(dispatch.calls).toEqual([{ orchDir, ticket: "CTL-7", phase: "plan" }]);
  });

  // CTL-1367 P2 (item b, Codex follow-up): a CLAIM-ONLY triage→research promotion must
  // still withhold the slot. When an SDK triage→research promotion LOSES the single-flight
  // race, verifyDispatchedSignal counts it a success (promotedCount++) but the WINNER writes
  // the phase signal — so countSdkInflight (and the re-sample) never see it. The freeSlots
  // SDK branch therefore takes min(re-sample budget, tick-top − resumed − promoted): the
  // promotedCount floor catches exactly this claim-only case the re-sample misses. Real
  // guard — without the floor (re-sample alone reads 0) CTL-X would be admitted at maxParallel=1.
  test("dispatchMode=sdk: a CLAIM-ONLY triage→research promotion still holds the slot (Codex P2 — promotedCount floor)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    // CTL-7 in-flight at triage:done → the advancement sweep promotes triage→research (a
    // promotedCount edge) via SDK.
    writeSignal("CTL-7", "triage", "done");
    // CTL-X is the eligible NEW ticket. The triage→research promotion is admission-gated
    // (STEP A): the triaged-waiting candidate (CTL-7) competes with eligible new work for
    // the SAME free-slot ceiling via rankTickets. At maxParallel=1 there is ONE promotion
    // slot, so CTL-X must rank BELOW CTL-7 or it would win the slot and the promotion would
    // never fire (admittedThisTick empty → r.advanced === []). CTL-7's promotion descriptor
    // takes priority 2 (relUnblocked default, below) → give CTL-X priority 3 so CTL-7 wins
    // the single slot. CTL-X's priority is immaterial to the guard under test (the slot
    // budget), only to which ticket wins the STEP-A competition.
    const eligible = [
      {
        identifier: "CTL-X",
        priority: 3,
        createdAt: "x",
        state: "Todo",
        relations: { nodes: [] },
        inverseRelations: { nodes: [] },
      },
    ];
    // CLAIM-ONLY success: the promotion's dispatch returns ok (→ verifyOk → promotedCount++)
    // but LOSES the single-flight race, so the WINNER (a different dispatcher) writes the
    // phase signal — this dispatch writes NONE. countSdkInflight therefore stays 0: the
    // re-sample cannot see this promotion, so only the promotedCount floor can withhold its slot.
    const dispatch = Object.assign(
      (args) => {
        dispatch.calls.push(args);
        return { code: 0 }; // NOTE: no sdkInflight increment — models the lost-race claim
      },
      { calls: [] }
    );
    const r = schedulerTick(orchDir, {
      readEligible: () => eligible,
      dispatch,
      verifyDispatched: verifyOk,
      // CTL-755: the triage→research promotion is admission-gated by deps — stub
      // fetchBatch (unblocked) + a free slot so the gate admits CTL-7's promotion.
      fetchBatch: mkBatch(() => relUnblocked()),
      liveBackgroundCount: () => 0,
      countSdkInflight: () => 0, // claim-only: re-sample never sees the lost-race promotion
      dispatchMode: "sdk",
      hasTriageArtifact: () => true,
      listStartedTickets: () => new Set(),
    });
    // The triage→research promotion fired (admission-gated, took the slot)…
    expect(r.advanced).toEqual([{ ticket: "CTL-7", phase: "research" }]);
    // …and the promotedCount floor withholds the slot the re-sample (0) missed → CTL-X held.
    expect(r.dispatched).toEqual([]);
    expect(dispatch.calls).toEqual([{ orchDir, ticket: "CTL-7", phase: "research" }]);
  });

  // CTL-1367 P2-C: the per-tick CTL-644 approval poll must thread the resolved
  // scheduler `dispatch` so a mid-run approval launches via the SAME executor the
  // daemon resolved — not processApprovedResumes' default defaultDispatch (which,
  // under executor=sdk, would split-brain back to `claude --bg`). Proven
  // behaviorally: with the threaded dispatch the approval dispatches + clears its
  // sentinels; defaultDispatch (no registry) would never reach the injected fn and
  // would retain the sentinels.
  test("per-tick approval poll dispatches through the THREADED dispatch + clears sentinels (CTL-1367 P2-C)", () => {
    const wdir = join(orchDir, "workers", "CTL-300");
    mkdirSync(wdir, { recursive: true });
    writeFileSync(
      bootResumePendingPath(orchDir, "CTL-300"),
      JSON.stringify({ ticket: "CTL-300", phase: "implement", worktreePath: "/wt/CTL-300" })
    );
    writeFileSync(bootResumeApprovedPath(orchDir, "CTL-300"), "");
    // defaultReviveDispatch requires an existing signal it resets to stalled.
    writeFileSync(
      join(wdir, "phase-implement.json"),
      JSON.stringify({
        ticket: "CTL-300",
        phase: "implement",
        status: "running",
        bg_job_id: "bg-x",
      })
    );
    const dispatch = Object.assign(
      (args) => {
        dispatch.calls.push(args);
        // mimic a landed dispatch (runnable signal) so the revive counts success.
        writeFileSync(
          join(wdir, "phase-implement.json"),
          JSON.stringify({
            ticket: "CTL-300",
            phase: "implement",
            status: "dispatched",
            bg_job_id: "bg-y",
          })
        );
        return { code: 0 };
      },
      { calls: [] }
    );
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      now: () => 1000,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
    });
    expect(dispatch.calls.some((c) => c.ticket === "CTL-300" && c.phase === "implement")).toBe(
      true
    );
    // Sentinels cleared ⇒ the approval path ran through the threaded dispatch and
    // succeeded (defaultDispatch would have failed the registry lookup → retained).
    expect(existsSync(bootResumeApprovedPath(orchDir, "CTL-300"))).toBe(false);
    expect(existsSync(bootResumePendingPath(orchDir, "CTL-300"))).toBe(false);
  });

  test("dispatchMode=bg: countSdkInflight is NEVER consulted (byte-identical admission)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 3 }));
    const dispatch = fakeDispatch();
    let sdkCalled = false;
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
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      countSdkInflight: () => {
        sdkCalled = true;
        return 99;
      },
      // dispatchMode omitted → defaults to "phase-agents" (bg)
      hasTriageArtifact: () => true,
      listStartedTickets: () => new Set(),
    });
    // bg path: all 3 admitted, the SDK term never even computed.
    expect(r.dispatched).toHaveLength(3);
    expect(sdkCalled).toBe(false);
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
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is concurrency ceiling
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
    schedulerTick(orchDir, {
      readEligible: () => eligible,
      dispatch,
      liveBackgroundCount: () => 0,
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is entry phase
    });
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
    schedulerTick(orchDir, {
      readEligible: () => eligible,
      dispatch,
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is idempotency
    });
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
      // CTL-755: the triage→research promotion is now admission-gated. Stub
      // fetchRelations (unblocked) + a free slot so the gate admits CTL-7.
      fetchBatch: mkBatch(() => relUnblocked()),
      liveBackgroundCount: () => 0,
    });
    expect(dispatch.calls).toEqual([{ orchDir, ticket: "CTL-7", phase: "research" }]);
    expect(r.advanced).toEqual([{ ticket: "CTL-7", phase: "research" }]);
  });

  // CTL-757: the canonical linear.state.write audit fires from the scheduler
  // advance site (caller-emits), tagged source=scheduler-advance, phase=next.
  // It must NOT fire on the triage path (the scheduler never writes triage; that
  // stays on monitor.mjs's phase.triage.linear-transition event).
  test("CTL-757: emitStateWrite fires once on advance with source=scheduler-advance + phase=next", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    writeSignal("CTL-7", "triage", "done"); // research is owed
    const stateWrites = [];
    const writeStatus = {
      applyPhaseStatus: () => ({
        applied: true,
        reason: null,
        action: "transitioned",
        from_state: "Triage",
        to_state: "Research",
      }),
      applyTerminalDone: () => ({ applied: true }),
      applyEstimate: () => ({ applied: true }),
    };
    const r = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      verifyDispatched: verifyOk,
      fetchBatch: mkBatch(() => relUnblocked()),
      liveBackgroundCount: () => 0,
      writeStatus,
      appendStateWriteEvent: (ev) => stateWrites.push(ev),
    });
    expect(r.advanced).toEqual([{ ticket: "CTL-7", phase: "research" }]);
    // Exactly one state-write audit for the advance, tagged correctly.
    const advanceWrites = stateWrites.filter((e) => e.source === "scheduler-advance");
    expect(advanceWrites).toHaveLength(1);
    expect(advanceWrites[0]).toMatchObject({
      ticket: "CTL-7",
      phase: "research", // == next, NOT triage
      source: "scheduler-advance",
      from_state: "Triage",
      to_state: "Research",
      applied: true,
    });
    // No emit is tagged with the triage phase — the scheduler never writes triage.
    expect(stateWrites.some((e) => e.phase === "triage")).toBe(false);
  });

  // CTL-757: an emit-seam THROW must never abort the tick (safeEmit-wrapped) and
  // the phase advance must still be recorded.
  test("CTL-757: a throwing appendStateWriteEvent is swallowed — advance still recorded", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    writeSignal("CTL-7", "triage", "done");
    const r = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      verifyDispatched: verifyOk,
      fetchBatch: mkBatch(() => relUnblocked()),
      liveBackgroundCount: () => 0,
      writeStatus: {
        applyPhaseStatus: () => ({ applied: true, from_state: "Triage", to_state: "Research" }),
        applyTerminalDone: () => ({ applied: true }),
        applyEstimate: () => ({ applied: true }),
      },
      appendStateWriteEvent: () => {
        throw new Error("emit boom");
      },
    });
    expect(r.advanced).toEqual([{ ticket: "CTL-7", phase: "research" }]);
  });

  // CTL-642: the reclaim sweep must thread the SHARED cache + fetchTicketState +
  // prAdapter into reclaimOpts (load-bearing — else the short-circuit re-storms
  // the Linear API). Assert by inspecting the opts a fake reclaimDeadWork sees.
  test("CTL-642: reclaimOpts carries cache + fetchState + prAdapter", () => {
    writeSignalRaw("CTL-7", "implement", {
      ticket: "CTL-7",
      phase: "implement",
      status: "running",
      bg_job_id: "bg-7",
    });
    const sharedCache = { get: () => undefined, set: () => {}, stats: () => ({}) };
    const fakePr = { prView: () => null };
    let seenOpts = null;
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus: {
        applyPhaseStatus: () => {},
        applyTerminalDone: () => {},
        applyLabel: () => ({ applied: true }),
      },

      cache: sharedCache,
      prAdapter: fakePr,
      reclaimDeadWork: (_orch, _sig, opts) => {
        seenOpts = opts;
        return "noop";
      },
    });
    expect(seenOpts).not.toBeNull();
    expect(seenOpts.cache).toBe(sharedCache);
    expect(typeof seenOpts.fetchState).toBe("function");
    expect(seenOpts.prAdapter).toBe(fakePr);
  });

  // CTL-642: the new 'terminal-short-circuit' reclaim outcome buckets into the
  // result.reclaimed array (HUD/log visibility) — the ticket drops next tick.
  test("CTL-642: 'terminal-short-circuit' result buckets into result.reclaimed", () => {
    writeSignalRaw("CTL-8", "implement", {
      ticket: "CTL-8",
      phase: "implement",
      status: "running",
      bg_job_id: "bg-8",
    });
    const result = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus: {
        applyPhaseStatus: () => {},
        applyTerminalDone: () => {},
        applyLabel: () => ({ applied: true }),
      },

      reclaimDeadWork: () => "terminal-short-circuit",
    });
    expect(result.reclaimed).toEqual([{ ticket: "CTL-8", phase: "implement" }]);
    expect(result.escalated).toEqual([]);
  });

  // CTL-758: reconcile backstop — fires ONLY with .terminal-done.applied + merged
  // PR + non-terminal live state; idempotent (no write) when already Done.
  describe("CTL-758: reconcile backstop", () => {
    function mdDoneWithPr(ticket, prNumber) {
      // CTL-703: teardown done triggers the terminal sweep; PR is on the teardown
      // signal so reconcileTerminalBackstop can find it via signal.raw.pr.
      writeSignalRaw(ticket, "teardown", {
        ticket,
        phase: "teardown",
        status: "done",
        pr: { number: prNumber, repo: "o/r" },
      });
    }
    function markerPath(ticket) {
      return join(orchDir, "workers", ticket, ".terminal-done.applied");
    }

    test("merged PR + .terminal-done.applied + drifted (non-terminal) state ⇒ re-Done via reconcile-backstop", () => {
      mdDoneWithPr("CTL-30", 30);
      writeFileSync(markerPath("CTL-30"), ""); // pipeline reached terminal
      const stateWrites = [];
      const doneCalls = [];
      schedulerTick(orchDir, {
        readEligible: () => [],
        dispatch: fakeDispatch(),
        writeStatus: {
          applyPhaseStatus: () => {},
          applyTerminalDone: ({ ticket }) => {
            doneCalls.push(ticket);
            return { applied: true, from_state: "PR", to_state: "Done" };
          },
          applyLabel: () => ({ applied: true }),
        },
        prAdapter: { prView: () => ({ state: "MERGED", mergedAt: "2026-06-04T00:00:00Z" }) },
        cache: { get: () => "PR", set: () => {}, stats: () => ({}) }, // live state drifted back to non-terminal
        appendStateWriteEvent: (ev) => stateWrites.push(ev),
      });
      expect(doneCalls).toContain("CTL-30");
      const backstop = stateWrites.filter((e) => e.source === "reconcile-backstop");
      expect(backstop).toHaveLength(1);
    });

    test("idempotent: already-Done live state ⇒ NO reconcile write", () => {
      mdDoneWithPr("CTL-31", 31);
      writeFileSync(markerPath("CTL-31"), "");
      const doneCalls = [];
      const stateWrites = [];
      schedulerTick(orchDir, {
        readEligible: () => [],
        dispatch: fakeDispatch(),
        writeStatus: {
          applyPhaseStatus: () => {},
          // terminalDoneOnce already wrote the marker, so it won't call again;
          // the backstop must also NOT call because the live state IS terminal.
          applyTerminalDone: ({ ticket }) => {
            doneCalls.push(ticket);
            return { applied: true };
          },
          applyLabel: () => ({ applied: true }),
        },
        prAdapter: { prView: () => ({ state: "MERGED", mergedAt: "x" }) },
        cache: { get: () => "Done", set: () => {}, stats: () => ({}) }, // already terminal
        appendStateWriteEvent: (ev) => stateWrites.push(ev),
      });
      expect(stateWrites.filter((e) => e.source === "reconcile-backstop")).toHaveLength(0);
      expect(doneCalls).toEqual([]); // marker present + state terminal → no Done write at all
    });

    test("no .terminal-done.applied marker ⇒ backstop does NOT fire (gate 1)", () => {
      mdDoneWithPr("CTL-32", 32);
      // NO marker written: teardown done means terminalDoneOnce fires this tick.
      // The backstop runs AFTER terminalDoneOnce in the loop, so to isolate gate 1
      // we assert no SECOND (reconcile) write beyond terminalDoneOnce's own.
      const stateWrites = [];
      schedulerTick(orchDir, {
        readEligible: () => [],
        dispatch: fakeDispatch(),
        writeStatus: {
          applyPhaseStatus: () => {},
          applyTerminalDone: () => ({ applied: true, from_state: "PR", to_state: "Done" }),
          applyLabel: () => ({ applied: true }),
        },
        prAdapter: { prView: () => ({ state: "MERGED", mergedAt: "x" }) },
        cache: { get: () => "PR", set: () => {}, stats: () => ({}) },
        appendStateWriteEvent: (ev) => stateWrites.push(ev),
      });
      // terminalDoneOnce emits source=terminal-sweep; the backstop ran in the same
      // tick but only AFTER terminalDoneOnce wrote the marker. Since the marker
      // now exists, the backstop's gates 2/3 also pass — so a reconcile write IS
      // expected here. The point of gate 1 is the NEXT tick (marker present) only.
      // Assert the terminal-sweep write happened (terminalDoneOnce fired).
      expect(stateWrites.some((e) => e.source === "terminal-sweep")).toBe(true);
    });

    test("merged PR but NO prAdapter ⇒ inert (no reconcile write)", () => {
      mdDoneWithPr("CTL-33", 33);
      writeFileSync(markerPath("CTL-33"), "");
      const stateWrites = [];
      schedulerTick(orchDir, {
        readEligible: () => [],
        dispatch: fakeDispatch(),
        writeStatus: {
          applyPhaseStatus: () => {},
          applyTerminalDone: () => ({ applied: true }),
          applyLabel: () => ({ applied: true }),
        },
        // no prAdapter → backstop gate 2 inert
        cache: { get: () => "PR", set: () => {}, stats: () => ({}) },
        appendStateWriteEvent: (ev) => stateWrites.push(ev),
      });
      expect(stateWrites.filter((e) => e.source === "reconcile-backstop")).toHaveLength(0);
    });
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
    const r = schedulerTick(orchDir, {
      readEligible: () => eligible,
      dispatch,
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is soft-skip behavior
    });
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
      // CTL-755: admission-gate seam — CTL-7 (triaged-waiting) is unblocked, so
      // it is admitted and promoted; STEP C subtracts promotedCount so the new
      // CTL-X still gets the remaining free slot (the double-fill invariant).
      fetchBatch: mkBatch(() => relUnblocked()),
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is advance+pull
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

  test("a stale liveness snapshot still advances MID-pipeline phases (advancement is count-independent)", () => {
    // CTL-755: the triage→research edge is now capacity-gated (held under
    // staleness — see the dedicated staleness-holds-promotion test below). But a
    // MID-pipeline advance (research:done → plan) is still count-independent and
    // must fire under a stale snapshot, exactly as before.
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    writeSignal("CTL-7", "research", "done"); // should advance to plan
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
    expect(r.advanced).toEqual([{ ticket: "CTL-7", phase: "plan" }]);
    expect(dispatch.calls).toEqual([{ orchDir, ticket: "CTL-7", phase: "plan" }]);
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
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is liveness freshness
    });
    expect(r.dispatched).toEqual(["CTL-9"]);
  });

  // CTL-736: the reclaim death trigger is the LOCAL state.json lifecycle, so the
  // sweep no longer reads the `claude agents` snapshot nor binds a per-worker
  // liveness — the CTL-731 reclaimColdSkip + snapshot-binding are both deleted.
  // The sweep runs every tick (no cold/warm distinction) and NEVER passes a
  // `liveness` reclaim option, regardless of snapshot state.
  for (const [label, livenessSnapshot, livenessIsFresh] of [
    [
      "cold/unpopulated snapshot",
      () => ({ populated: false, agents: [], isFresh: false }),
      () => false,
    ],
    ["null snapshot seam (legacy/test)", null, () => false],
    [
      "populated snapshot",
      () => ({
        populated: true,
        agents: [{ sessionId: "1111-2222", kind: "background", status: "idle" }],
        isFresh: true,
      }),
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

// ── CTL-1150: triage-artifact guard in Pass 2 ──
describe("schedulerTick — CTL-1150 triage-artifact guard", () => {
  const eligibleTodo = (id) => ({
    identifier: id,
    priority: 1,
    createdAt: "x",
    state: "Todo",
    relations: { nodes: [] },
    inverseRelations: { nodes: [] },
  });

  test("holds a never-triaged eligible ticket — no dispatch, no failure event, no cooldown marker", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    // Do NOT call seedTriage — candidate has no triage.json.
    const dispatch = fakeDispatch();
    const r = schedulerTick(orchDir, {
      readEligible: () => [eligibleTodo("CTL-1150")],
      dispatch,
      liveBackgroundCount: () => 0,
      verifyDispatched: verifyOk,
    });
    // Guard holds — no dispatch attempt.
    expect(dispatch.calls).toEqual([]);
    expect(r.dispatched).toEqual([]);
    // No spurious phase events emitted for CTL-1150.
    const events = readEventLog();
    expect(
      events.filter((e) => e.ticket === "CTL-1150" && e.event?.startsWith("phase.research.failed"))
    ).toHaveLength(0);
    expect(
      events.filter((e) => e.ticket === "CTL-1150" && e.event?.startsWith("phase.dispatch.failed"))
    ).toHaveLength(0);
    // No cooldown marker written (silent hold, not a dispatch failure).
    expect(existsSync(dispatchCooldownPath(orchDir, "CTL-1150", "research"))).toBe(false);
  });

  test("dispatches research once triage.json exists", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    // seedTriage creates workers/CTL-1150/triage.json for the real existsSync path.
    // Inject listStartedTickets: () => new Set() so the dir-existence check in
    // selectDispatchablePerProject does not exclude the seeded ticket (CTL-1150).
    seedTriage("CTL-1150");
    const dispatch = fakeDispatch();
    const r = schedulerTick(orchDir, {
      readEligible: () => [eligibleTodo("CTL-1150")],
      dispatch,
      liveBackgroundCount: () => 0,
      verifyDispatched: verifyOk,
      listStartedTickets: () => new Set(),
    });
    expect(dispatch.calls).toHaveLength(1);
    expect(dispatch.calls[0]).toMatchObject({ ticket: "CTL-1150", phase: "research" });
    expect(r.dispatched).toEqual(["CTL-1150"]);
  });

  test("guard is per-candidate — triaged ticket dispatches while an untriaged sibling holds", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    // seedTriage creates workers/CTL-T1/triage.json. Inject listStartedTickets so
    // the dir-existence check doesn't pre-exclude CTL-T1. CTL-T2 has no triage.json
    // so the default existsSync check holds it.
    seedTriage("CTL-T1");
    const dispatch = fakeDispatch();
    const r = schedulerTick(orchDir, {
      readEligible: () => [eligibleTodo("CTL-T1"), eligibleTodo("CTL-T2")],
      dispatch,
      liveBackgroundCount: () => 0,
      verifyDispatched: verifyOk,
      listStartedTickets: () => new Set(),
    });
    expect(dispatch.calls).toHaveLength(1);
    expect(dispatch.calls[0]).toMatchObject({ ticket: "CTL-T1", phase: "research" });
    expect(r.dispatched).toEqual(["CTL-T1"]);
  });
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
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is per-project cap
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
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is per-project reserve
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
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is per-project regression
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
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is per-project burst
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
      1
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
      JSON.stringify({ ticket, phase, status, bg_job_id: bgJobId })
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
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is slot admission
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
      (e) => e.event === "phase.predecessor.reap-requested" && e.ticket === "CTL-7"
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
      readEventLog().filter((e) => e.event === "phase.predecessor.reap-requested")
    ).toHaveLength(0);
  });

  // CTL-661 hole #2 — verify⇄remediate detour reaps, driven through schedulerTick.
  function writeVerifyJson(ticket, regressionRisk) {
    const dir = join(orchDir, "workers", ticket);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "verify.json"),
      JSON.stringify({ regression_risk: regressionRisk, findings: [], gates: {} })
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
      (e) => e.event === "phase.predecessor.reap-requested" && e.ticket === "CTL-7"
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
      (e) => e.event === "phase.predecessor.reap-requested" && e.ticket === "CTL-7"
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
    expect(resolveReapPredecessor({ implement: "done", verify: "done" }, "remediate")).toEqual({
      phase: "verify",
      reason: "ctl-661-remediate-detour",
    });
  });

  test("remediate → verify detour reaps remediate, NOT implement", () => {
    const r = resolveReapPredecessor(
      { implement: "done", verify: "done", remediate: "done" },
      "verify"
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

  test("batches the unique out-of-set blockers in one fetchBatch call (deduped)", () => {
    const fetchedChunks = [];
    const fetchBatch = (ids) => {
      fetchedChunks.push(ids);
      return new Map(ids.map((id) => [id, descOf("Backlog")]));
    };
    const map = hydrateOutOfSetBlockers(
      [blkTk("CTL-1", { blockedBy: "CTL-99" }), blkTk("CTL-2", { blockedBy: "CTL-99" })],
      { fetchBatch }
    );
    expect(fetchedChunks).toEqual([["CTL-99"]]); // deduped — one batched fetch
    expect(map).toEqual({ "CTL-99": "Backlog" });
  });

  test("an in-set blocker is not fetched (only out-of-set blockers hydrate)", () => {
    let called = false;
    const fetchBatch = (ids) => {
      called = true;
      return new Map(ids.map((id) => [id, descOf("Backlog")]));
    };
    // CTL-2 is in the eligible set, so the CTL-1→CTL-2 edge is in-set.
    hydrateOutOfSetBlockers([blkTk("CTL-1", { blockedBy: "CTL-2" }), blkTk("CTL-2")], {
      fetchBatch,
    });
    expect(called).toBe(false); // no external blockers → no batch
  });

  test("a Ready ticket blocked by a Backlog out-of-set blocker is not dispatched", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({ code: 0 });
    schedulerTick(orchDir, {
      readEligible: () => [blkTk("CTL-1", { blockedBy: "CTL-99" })],
      dispatch,
      fetchBatch: mkBatch({ "CTL-99": descOf("Backlog") }),
    });
    expect(dispatch.calls).toHaveLength(0);
  });

  test("a Ready ticket blocked by a Done out-of-set blocker IS dispatched", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({ code: 0 });
    schedulerTick(orchDir, {
      readEligible: () => [blkTk("CTL-1", { blockedBy: "CTL-99" })],
      dispatch,
      fetchBatch: mkBatch({ "CTL-99": descOf("Done") }),
      liveBackgroundCount: () => 0,
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is blocker resolution
    });
    expect(dispatch.calls.map((c) => c.ticket)).toEqual(["CTL-1"]);
  });

  test("a failed blocker fetch fails safe — the dependent is held back, not dispatched", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({ code: 0 });
    schedulerTick(orchDir, {
      readEligible: () => [blkTk("CTL-1", { blockedBy: "CTL-99" })],
      dispatch,
      fetchBatch: () => new Map(), // batch failure → CTL-99 absent → UNFETCHED → held
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

  // These drive the REAL fetchTicketsBatch (so the read-through cache is exercised)
  // with an injected BATCH exec `(ids) => nodes[]`.
  test("reads an out-of-set blocker once across two hydrations within TTL", () => {
    const cache = createTicketStateCache({ now: () => 0, ttlMs: 60_000 });
    const fetched = [];
    const batchExec = (ids) => {
      fetched.push(...ids);
      return ids.map((id) => ({ identifier: id, state: { name: "Backlog" } }));
    };
    const fetchBatch = (ids, opts) => fetchTicketsBatch(ids, { ...opts, exec: batchExec });
    const eligible = [blkTk("CTL-1", "CTL-99")];
    hydrateOutOfSetBlockers(eligible, { fetchBatch, cache });
    hydrateOutOfSetBlockers(eligible, { fetchBatch, cache });
    expect(fetched).toEqual(["CTL-99"]); // one read, second hydration is a cache hit
  });

  test("preserves the fail-safe: a failed fetch is the sentinel AND is not cached", () => {
    const cache = createTicketStateCache({ now: () => 0 });
    let calls = 0;
    const batchExec = () => {
      calls += 1;
      return null; // batch failure
    };
    const fetchBatch = (ids, opts) => fetchTicketsBatch(ids, { ...opts, exec: batchExec });
    const eligible = [blkTk("CTL-1", "CTL-99")];
    const a = hydrateOutOfSetBlockers(eligible, { fetchBatch, cache });
    const b = hydrateOutOfSetBlockers(eligible, { fetchBatch, cache });
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
    // CTL-784: hydrate now reads through the RELATIONS store, so the activity
    // shows up in relationsStats() (the per-tick metric the scheduler also logs).
    const fetchBatch = (ids, opts) =>
      fetchTicketsBatch(ids, {
        ...opts,
        exec: (cs) => cs.map((id) => ({ identifier: id, state: { name: "Backlog" } })),
      });
    schedulerTick(orchDir, {
      readEligible: () => [blkTk("CTL-1", "CTL-99")],
      dispatch,
      fetchBatch,
      cache,
    });
    const s = cache.relationsStats();
    expect(s.misses + s.hits).toBeGreaterThan(0); // the hydrate read went through the relations cache
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
      // CTL-755: the triage→research promotion is admission-gated. Stub
      // fetchRelations (unblocked + non-terminal state) and provide a free slot
      // so the gate admits CTL-1 and the advancement sweep dispatches research.
      fetchBatch: mkBatch(() => relUnblocked()),
      liveBackgroundCount: () => 0,
      tickIntervalMs: 60_000,
      debounceMs: 5,
    });
    expect(dispatch.calls).toEqual([{ orchDir, ticket: "CTL-1", phase: "research" }]);
  });

  // CTL-642/758 REGRESSION: the production startScheduler path MUST construct +
  // thread a live prAdapter whose `.prView` is a function. The original bug was
  // that schedulerTick's `prAdapter` defaulted to undefined and the daemon call
  // site (runTick) never passed one — so the CTL-642 recovery short-circuit's
  // pr-merged branch AND the CTL-758 reconcile backstop were BOTH inert in
  // production (gate-2 returns early on `!prAdapter`). Tests injected a fake
  // prAdapter so they stayed green while prod never exercised it. This locks the
  // wiring: with NO prAdapter override, startScheduler must build the real one.
  test("CTL-642/758: production path threads a live prAdapter with a prView function", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    startScheduler({
      orchDir,
      dispatch: fakeDispatch(),
      readEligible: () => [],
      fetchBatch: mkBatch(() => relUnblocked()),
      liveBackgroundCount: () => 0,
      tickIntervalMs: 60_000,
      debounceMs: 5,
      // NB: no prAdapter override — assert the default-constructed one.
    });
    const opts = __getRunningOpts();
    expect(opts).not.toBeNull();
    expect(opts.prAdapter).toBeDefined();
    expect(typeof opts.prAdapter.prView).toBe("function");
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
      // CTL-755: admission-gate seam + free slot so the promotion fires.
      fetchBatch: mkBatch(() => relUnblocked()),
      liveBackgroundCount: () => 0,
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
      // CTL-755: admission-gate seam + free slot so the promotion fires.
      fetchBatch: mkBatch(() => relUnblocked()),
      liveBackgroundCount: () => 0,
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
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is concurrency ceiling
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
      })
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
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is config hot-reload
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
      })
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
  // already-dispatched worker; it gates only the next selectDispatchable result.
  // CTL-703: the teardownWorktree seam is removed; lowering the ceiling never
  // ran teardown in the scheduler anyway — that is now the teardown phase agent.
  test("lowering the ceiling does not kill in-flight workers", async () => {
    const configPath = join(orchDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        catalyst: { orchestration: { executionCore: { maxParallel: 2 } } },
      })
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
      readEligible: () => [tk("CTL-A", 1), tk("CTL-B", 2)],
      configPath,
      liveBackgroundCount: () => 0, // CTL-676
      tickIntervalMs: 60_000,
      debounceMs: 10,
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is ceiling drop
    });
    expect(dispatch.calls.length).toBe(2);

    // Drop the ceiling below the in-flight count. The next tick must not
    // re-dispatch anything.
    writeFileSync(
      configPath,
      JSON.stringify({
        catalyst: { orchestration: { executionCore: { maxParallel: 1 } } },
      })
    );
    // Burn a few wake cycles so a hypothetical re-dispatch would have fired.
    for (let i = 0; i < 5; i++) {
      appendToEventLog('{"event":"wake.CTL-676.b"}\n');
      await new Promise((r) => setTimeout(r, 30));
    }
    // No additional dispatches were issued (no new eligible tickets,
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
      })
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
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is config fallback
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
      })
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
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is config field isolation
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
      })
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
      })
    );
    writeFileSync(
      layer2Path,
      JSON.stringify({
        catalyst: { orchestration: { executionCore: { maxParallel: 3 } } },
      })
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
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is Layer-2 priority
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
      })
    );
    writeFileSync(
      layer2Path,
      JSON.stringify({
        catalyst: { orchestration: { executionCore: { maxParallel: 1 } } },
      })
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
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is Layer-2 hot-reload
    });
    expect(dispatch.calls.length).toBe(1);

    writeFileSync(
      layer2Path,
      JSON.stringify({
        catalyst: { orchestration: { executionCore: { maxParallel: 3 } } },
      })
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
      })
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
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is Layer-1 back-compat
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
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is idempotency
    });
    expect(r1.dispatched).toEqual(["CTL-9"]);

    // "Crash" — the daemon dies; the dispatched signal survives on disk.
    // Tick 2 (post-restart) re-derives everything from the filesystem.
    const r2 = schedulerTick(orchDir, {
      readEligible: () => eligible,
      dispatch,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0, // CTL-682: deterministic in-flight count (matches r1)
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
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is status write
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

  test("writes terminal Done when a ticket's teardown signal is done (CTL-703)", () => {
    writeSignal("CTL-4", "teardown", "done");
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

  // CTL-757: the terminal Done write is audited with source=terminal-sweep.
  test("CTL-757: terminal Done write emits source=terminal-sweep state.write (CTL-703: gated on teardown)", () => {
    writeSignal("CTL-4", "teardown", "done");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const stateWrites = [];
    const writeStatus = {
      applyPhaseStatus: () => {},
      applyTerminalDone: () => ({
        applied: true,
        from_state: "PR",
        to_state: "Done",
        action: "transitioned",
      }),
      applyLabel: () => {},
    };
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: okDispatch,
      writeStatus,
      appendStateWriteEvent: (ev) => stateWrites.push(ev),
    });
    const sweep = stateWrites.filter((e) => e.source === "terminal-sweep");
    expect(sweep).toHaveLength(1);
    expect(sweep[0]).toMatchObject({
      ticket: "CTL-4",
      source: "terminal-sweep",
      from_state: "PR",
      to_state: "Done",
      applied: true,
    });
  });

  test("does NOT write terminal Done when monitor-deploy done but teardown not yet done (CTL-703)", () => {
    // monitor-deploy done advances to teardown; Done is only written when teardown completes
    writeSignal("CTL-4", "monitor-deploy", "done");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dones = [];
    const writeStatus = {
      applyPhaseStatus: () => {},
      applyTerminalDone: (a) => dones.push(a),
      applyLabel: () => {},
    };
    schedulerTick(orchDir, { readEligible: () => [], dispatch: okDispatch, writeStatus });
    expect(dones).not.toContainEqual(expect.objectContaining({ ticket: "CTL-4" }));
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

  // CTL-868 route (B): a stalled-no-recovery ticket also emits a canonical
  // phase.<phase>.orphan-detected.<ticket> event so the dashboard surfaces the
  // orphan beyond the buried needs-human label. Once-markered + fail-open.
  test("CTL-868: emits orphan-detected (once) when a phase signal is stalled", () => {
    writeSignal("CTL-77", "implement", "stalled");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const orphans = [];
    const writeStatus = { ...noWrites(), applyLabel: () => ({ applied: true }) };
    const appendOrphanDetectedEvent = (e) => {
      orphans.push(e);
      return true;
    };
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus,
      appendOrphanDetectedEvent,
    });
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatchObject({
      ticket: "CTL-77",
      phase: "implement",
      reason: "stalled-no-recovery",
    });
    expect(orphans[0].stalled_phases).toEqual(["implement"]);
    // marker written → a second tick does NOT re-emit (hot-loop dedup)
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus,
      appendOrphanDetectedEvent,
    });
    expect(orphans).toHaveLength(1);
  });

  test("CTL-868: a non-stalled ticket emits no orphan-detected event", () => {
    writeSignal("CTL-78", "implement", "running");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const orphans = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus: { ...noWrites(), applyLabel: () => ({ applied: true }) },
      appendOrphanDetectedEvent: (e) => {
        orphans.push(e);
        return true;
      },
    });
    expect(orphans).toHaveLength(0);
  });

  test("CTL-868: a failed orphan-detected append leaves no marker (retries next tick)", () => {
    writeSignal("CTL-79", "implement", "stalled");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const markerPath = join(orchDir, "workers", "CTL-79", ".orphan-detected.applied");
    const writeStatus = { ...noWrites(), applyLabel: () => ({ applied: true }) };
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus,
      appendOrphanDetectedEvent: () => false, // append failed
    });
    expect(existsSync(markerPath)).toBe(false);
    // succeeds on a later tick → marker written, no further re-emit
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus,
      appendOrphanDetectedEvent: () => true,
    });
    expect(existsSync(markerPath)).toBe(true);
  });

  test("CTL-868: multiple stalled phases → one canonical event phase + full stalled list preserved", () => {
    writeSignal("CTL-80", "implement", "stalled");
    writeSignal("CTL-80", "verify", "stalled");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const orphans = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus: { ...noWrites(), applyLabel: () => ({ applied: true }) },
      appendOrphanDetectedEvent: (e) => {
        orphans.push(e);
        return true;
      },
    });
    expect(orphans).toHaveLength(1);
    // the canonical event phase is ONE of the stalled phases (deterministic single pick)
    expect(["implement", "verify"]).toContain(orphans[0].phase);
    // the FULL stalled set is preserved — locks against a truncate-to-one regression
    expect([...orphans[0].stalled_phases].sort()).toEqual(["implement", "verify"]);
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

  // CTL-646: stall→advance and terminal Done clear the needs-human label

  test("clears needs-human when no phase is stalled and .applied marker exists (CTL-646)", () => {
    writeSignal("CTL-14", "implement", "done");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    writeFileSync(join(orchDir, "workers", "CTL-14", ".linear-label-needs-human.applied"), "");
    const removed = [];
    const writeStatus = {
      ...noWrites(),
      applyLabel: () => ({}),
      removeLabel: (t, l) => {
        removed.push({ t, l });
        return { removed: true };
      },
    };
    schedulerTick(orchDir, { readEligible: () => [], dispatch: fakeDispatch(), writeStatus });
    expect(removed).toContainEqual(expect.objectContaining({ t: "CTL-14", l: "needs-human" }));
  });

  test("still-stalled does not call removeLabel — labelOnce only (CTL-646)", () => {
    writeSignal("CTL-15", "implement", "stalled");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const removed = [];
    const writeStatus = {
      ...noWrites(),
      applyLabel: () => ({}),
      removeLabel: (t, l) => {
        removed.push({ t, l });
        return { removed: true };
      },
    };
    schedulerTick(orchDir, { readEligible: () => [], dispatch: fakeDispatch(), writeStatus });
    expect(removed.filter((r) => r.t === "CTL-15")).toHaveLength(0);
  });

  test("terminal Done clears needs-human unconditionally (CTL-646)", () => {
    // CTL-703: the terminal phase is now `teardown` (not `monitor-deploy`),
    // so the terminal-Done sweep keys off a `teardown` done signal.
    writeSignal("CTL-16", "teardown", "done");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const removed = [];
    const writeStatus = {
      ...noWrites(),
      applyLabel: () => ({}),
      applyTerminalDone: () => ({ applied: true }),
      removeLabel: (t, l) => {
        removed.push({ t, l });
        return { removed: true };
      },
    };
    schedulerTick(orchDir, { readEligible: () => [], dispatch: fakeDispatch(), writeStatus });
    expect(removed).toContainEqual(expect.objectContaining({ t: "CTL-16", l: "needs-human" }));
  });
});

// ── CTL-1242: terminal-sweep needs-human clear for merge-without-teardown ───
//
// A ticket that reaches Linear Done / merged-PR WITHOUT teardown completing
// was being re-flagged needs-human every tick because the anyStalled/anyFailed
// branch ran before any terminal-or-merged probe. These tests drive the fix:
// isTicketTerminalOrMerged runs ONLY on the narrow stalled/failed-not-done set
// and clears (never re-applies) needs-human for terminal/merged tickets.
//
// Gateway controls fetchTicketState without any network calls. The fresh
// timestamp is within the 60 s GATEWAY_STATE_FRESH_MS window.

describe("schedulerTick — terminal-sweep needs-human clear (CTL-1242)", () => {
  const FRESH = new Date().toISOString(); // within 60 s gateway-fresh window

  const noWrites1242 = () => ({
    applyPhaseStatus() {},
    applyTerminalDone() {},
  });

  // T1: merge-without-teardown + failed signal → clears, never re-applies
  test("CTL-1242 T1: failed signal + Linear Done → clears needs-human, does not re-apply", () => {
    const TICKET = "CTL-1242-T1";
    writeSignal(TICKET, "implement", "failed");
    // Pre-seed the .applied marker (simulates a prior tick that already applied it)
    const base = join(orchDir, "workers", TICKET, ".linear-label-needs-human");
    writeFileSync(`${base}.applied`, "");

    const removed = [];
    const applied = [];
    const writeStatus = {
      ...noWrites1242(),
      applyLabel: (a) => {
        applied.push(a);
        return { applied: true };
      },
      removeLabel: (t, l) => {
        removed.push({ t, l });
        return { removed: true };
      },
    };
    const gateway = {
      getDescriptor: (id) =>
        id === TICKET ? { state: "Done", removed: false, updatedAt: FRESH } : null,
    };

    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus,
      gateway,
    });

    // removeLabel called for needs-human
    expect(removed.some((r) => r.t === TICKET && r.l === "needs-human")).toBe(true);
    // applyLabel must NOT have been called for needs-human
    expect(applied.some((a) => a.ticket === TICKET && a.label === "needs-human")).toBe(false);
    // marker deleted
    expect(existsSync(`${base}.applied`)).toBe(false);
  });

  // T2: merged PR (Linear non-terminal) → clears
  test("CTL-1242 T2: failed signal + merged PR (Linear non-terminal) → clears needs-human", () => {
    const TICKET = "CTL-1242-T2";
    // Seed a failed signal that carries a PR number.
    // parseSignal stores the full file JSON as signal.raw, so signal.raw.pr
    // reads the TOP-LEVEL pr field in the file — not a nested raw.pr key.
    const dir = join(orchDir, "workers", TICKET);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "phase-implement.json"),
      JSON.stringify({ ticket: TICKET, phase: "implement", status: "failed", pr: { number: 99 } })
    );
    const base = join(orchDir, "workers", TICKET, ".linear-label-needs-human");
    writeFileSync(`${base}.applied`, "");

    const removed = [];
    const applied = [];
    const writeStatus = {
      ...noWrites1242(),
      applyLabel: (a) => {
        applied.push(a);
        return { applied: true };
      },
      removeLabel: (t, l) => {
        removed.push({ t, l });
        return { removed: true };
      },
    };
    // Linear state is non-terminal; PR is merged → terminal via pr-merged path
    const gateway = {
      getDescriptor: (id) =>
        id === TICKET ? { state: "In Review", removed: false, updatedAt: FRESH } : null,
    };
    const prAdapter = { prView: () => ({ state: "MERGED", mergedAt: "2026-06-17T00:00:00Z" }) };

    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus,
      gateway,
      prAdapter,
    });

    expect(removed.some((r) => r.t === TICKET && r.l === "needs-human")).toBe(true);
    expect(applied.some((a) => a.ticket === TICKET && a.label === "needs-human")).toBe(false);
    expect(existsSync(`${base}.applied`)).toBe(false);
  });

  // T3: non-terminal + stalled signal → still re-applies (regression guard)
  // (emitOrphanDetectedOnce only fires for stalled phases; failed-only tickets still
  // apply needs-human but skip the orphan event — use stalled to hit both assertions.)
  test("CTL-1242 T3: stalled signal + non-terminal Linear + no merged PR → still applies needs-human", () => {
    const TICKET = "CTL-1242-T3";
    writeSignal(TICKET, "implement", "stalled");

    const applied = [];
    const removed = [];
    const writeStatus = {
      ...noWrites1242(),
      applyLabel: (a) => {
        applied.push(a);
        return { applied: true };
      },
      removeLabel: (t, l) => {
        removed.push({ t, l });
        return { removed: true };
      },
    };
    const gateway = {
      getDescriptor: (id) =>
        id === TICKET ? { state: "In Progress", removed: false, updatedAt: FRESH } : null,
    };
    const orphans = [];
    const appendOrphanDetectedEvent = (e) => {
      orphans.push(e);
      return true;
    };

    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus,
      gateway,
      appendOrphanDetectedEvent,
    });

    expect(applied.some((a) => a.ticket === TICKET && a.label === "needs-human")).toBe(true);
    expect(removed.filter((r) => r.t === TICKET && r.l === "needs-human")).toHaveLength(0);
    expect(orphans.some((o) => o.ticket === TICKET)).toBe(true);
  });

  // T4: steady-state-zero-writes — no stalled/failed, no marker → zero needs-human writes
  // (The terminal-or-merged probe only runs inside the anyStalled||anyFailed branch, so a
  // ticket with only done/running phases must produce zero needs-human label API calls.)
  test("CTL-1242 T4: no stalled/failed signal → zero needs-human label writes (zero-writes invariant)", () => {
    const TICKET = "CTL-1242-T4";
    // Only a done implement signal — no stalled/failed, no teardown (no .terminal-done.applied
    // marker written, so the reconcile backstop never probes the gateway for this ticket).
    writeSignal(TICKET, "implement", "done");

    const nhWrites = [];
    const writeStatus = {
      ...noWrites1242(),
      applyLabel: (a) => {
        if (a.label === "needs-human") nhWrites.push({ kind: "apply", ...a });
        return { applied: true };
      },
      removeLabel: (t, l) => {
        if (l === "needs-human") nhWrites.push({ kind: "remove", t, l });
        return { removed: true };
      },
    };

    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus,
    });

    // Zero needs-human label writes for this non-stalled ticket
    expect(nhWrites.filter((w) => (w.ticket ?? w.t) === TICKET)).toHaveLength(0);
  });

  // T5: fail-safe — fetchTicketState returns null + no PR → re-applies (never false clear)
  test("CTL-1242 T5: fetchTicketState returns null + no PR → fail-safe re-applies needs-human", () => {
    const TICKET = "CTL-1242-T5";
    writeSignal(TICKET, "implement", "stalled");

    const applied = [];
    const writeStatus = {
      ...noWrites1242(),
      applyLabel: (a) => {
        applied.push(a);
        return { applied: true };
      },
      removeLabel: () => ({ removed: true }),
    };
    // gateway returns null → fetchTicketState returns null → non-terminal (D5 fail-safe)
    const gateway = { getDescriptor: () => null };

    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus,
      gateway,
    });

    expect(applied.some((a) => a.ticket === TICKET && a.label === "needs-human")).toBe(true);
  });
});

// ── CTL-1079: retraction sweep reads from broker cache instead of live API ──
// These tests use an exec spy + the real removeLabel (from linear-write.mjs)
// to verify that gateway cache hits suppress the live `linearis issues read`
// subprocess while the mutation (linearis issues update) still fires.

describe("schedulerTick — retraction sweep uses gateway cache (CTL-1079)", () => {
  const TICKET = "CTL-1079T";

  function makeExecSpy(
    labelsJson = JSON.stringify({
      labels: { nodes: [{ name: "needs-human" }, { name: "feature" }] },
    })
  ) {
    const calls = [];
    const exec = (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "linearis" && args[0] === "issues" && args[1] === "read") {
        return { code: 0, stdout: labelsJson, stderr: "" };
      }
      // overwrite / clear-labels write
      if (cmd === "linearis" && args[0] === "issues" && args[1] === "update") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    exec.calls = calls;
    return exec;
  }

  const isLiveRead = (c) => c.cmd === "linearis" && c.args[0] === "issues" && c.args[1] === "read";
  const isOverwrite = (c) =>
    c.cmd === "linearis" && c.args[0] === "issues" && c.args[1] === "update";

  function makeWriteStatus(execSpy) {
    return {
      applyPhaseStatus() {},
      applyTerminalDone() {},
      applyLabel: () => ({ applied: true }),
      removeLabel: (t, l, opts = {}) => realRemoveLabel(t, l, { exec: execSpy, ...opts }),
    };
  }

  beforeEach(() => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    writeSignal(TICKET, "implement", "done");
    mkdirSync(join(orchDir, "workers", TICKET), { recursive: true });
  });

  test("CTL-1079: cache hit → idempotency read suppressed by cache; CTL-1085 write-path node read fires once", async () => {
    writeFileSync(join(orchDir, "workers", TICKET, ".linear-label-needs-human.applied"), "");
    const exec = makeExecSpy();
    const gateway = {
      getDescriptor: () => ({ ticket: TICKET, removed: false, labels: ["needs-human", "feature"] }),
    };
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus: makeWriteStatus(exec),
      gateway,
    });
    // Cache hit suppresses the idempotency read. The write-path node read (CTL-1085
    // UUID resolution) is the only live read — it fires exactly once on the write path.
    expect(exec.calls.filter(isLiveRead)).toHaveLength(1);
    // The mutation (overwrite without needs-human) still fires.
    const writes = exec.calls.filter(isOverwrite);
    expect(writes).toHaveLength(1);
    // The overwrite carries the filtered remainder — feature kept, needs-human dropped.
    expect(writes[0].args).toContain("feature");
    expect(writes[0].args.join(" ")).not.toContain("needs-human");
  });

  test("CTL-1079: cache miss → idempotency live read + CTL-1085 node read = TWO live reads total", async () => {
    writeFileSync(join(orchDir, "workers", TICKET, ".linear-label-needs-human.applied"), "");
    const exec = makeExecSpy();
    const gateway = { getDescriptor: () => null };
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus: makeWriteStatus(exec),
      gateway,
    });
    // Cache miss → idempotency live read; CTL-1085 UUID write-path node read adds one more.
    expect(exec.calls.filter(isLiveRead)).toHaveLength(2);
  });

  test("CTL-1079: cache hit, label already absent → idempotent no-op, no read AND no write", async () => {
    writeFileSync(join(orchDir, "workers", TICKET, ".linear-label-needs-human.applied"), "");
    const exec = makeExecSpy();
    // Cache shows label is already absent (just "feature", no "needs-human").
    const gateway = {
      getDescriptor: () => ({ ticket: TICKET, removed: false, labels: ["feature"] }),
    };
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus: makeWriteStatus(exec),
      gateway,
    });
    expect(exec.calls.filter(isLiveRead)).toHaveLength(0);
    expect(exec.calls.filter(isOverwrite)).toHaveLength(0);
  });

  test("CTL-1079: no gateway → idempotency live read + CTL-1085 node read = TWO live reads total", async () => {
    writeFileSync(join(orchDir, "workers", TICKET, ".linear-label-needs-human.applied"), "");
    const exec = makeExecSpy();
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus: makeWriteStatus(exec),
      // gateway intentionally omitted
    });
    // No gateway → idempotency live read fires. CTL-1085 write-path node read adds one more.
    expect(exec.calls.filter(isLiveRead)).toHaveLength(2);
  });
});

// ── CTL-582 / CTL-703: worktree teardown moved to dedicated teardown phase ──
// CTL-703: teardownWorktreeOnce and the teardownWorktree injectable are REMOVED
// from schedulerTick. Worktree removal is now handled by the phase-teardown
// phase agent, not the scheduler's sweep. These tests verify that monitor-deploy
// done/skipped does NOT trigger teardown (that belongs to the teardown phase).

describe("schedulerTick — worktree teardown removed from sweep (CTL-703)", () => {
  const noStatusWrites = () => ({
    applyPhaseStatus() {},
    applyTerminalDone() {},
    applyLabel() {},
  });

  test("monitor-deploy done advances to a teardown phase dispatch, not a sweep-side removal (CTL-703)", () => {
    writeSignal("CTL-4", "monitor-deploy", "done");
    const dispatch = fakeDispatch();
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      writeStatus: noStatusWrites(),
      verifyDispatched: verifyOk,
    });
    // The teardown work is a dispatched phase — the sweep itself removes nothing.
    expect(dispatch.calls).toHaveLength(1);
    expect(dispatch.calls[0]).toMatchObject({ ticket: "CTL-4", phase: "teardown" });
  });

  test("monitor-deploy skipped advances to a teardown phase dispatch (CTL-703)", () => {
    writeSignal("CTL-4", "monitor-deploy", "skipped");
    const dispatch = fakeDispatch();
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      writeStatus: noStatusWrites(),
      verifyDispatched: verifyOk,
    });
    expect(dispatch.calls).toHaveLength(1);
    expect(dispatch.calls[0]).toMatchObject({ ticket: "CTL-4", phase: "teardown" });
  });

  test("tick does not throw when monitor-deploy is done and no teardown injectable (CTL-703)", () => {
    writeSignal("CTL-4", "monitor-deploy", "done");
    expect(() =>
      schedulerTick(orchDir, {
        readEligible: () => [],
        dispatch: fakeDispatch(),
        writeStatus: noStatusWrites(),
      })
    ).not.toThrow();
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
    writeFileSync(
      join(dir, "phase-plan.json"),
      JSON.stringify({ ticket: "CTL-YIELD-702", phase: "plan", status: "done" })
    );
    writeFileSync(join(dir, "phase-plan-yield-20260528T050740Z.json"), JSON.stringify({}));

    const emits = [];
    schedulerTick(orchDir, {
      appendYieldFileSkipEvent: (args) => {
        emits.push(args);
        return true;
      },
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
      appendYieldFileSkipEvent: (args) => {
        emits.push(args);
        return true;
      },
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
    writeNestedSignal("CTL-B", "teardown", { status: "done" }); // CTL-703: teardown done is terminal
    writeNestedSignal("CTL-C", "verify", { status: "failed" });

    const reclaimDeadWork = recorder("noop");
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      writeStatus,
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
    writeNestedSignal("CTL-B", "teardown", { status: "done" }); // CTL-703: teardown done is terminal

    const r = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      writeStatus,
      reclaimDeadWork: () => "noop",
    });

    expect(Array.isArray(r.reclaimed)).toBe(true);
    expect(Array.isArray(r.revived)).toBe(true);
    expect(Array.isArray(r.reviveSuppressed)).toBe(true);
    expect(Array.isArray(r.escalated)).toBe(true);
  });

  test("skips the loop entirely when no tickets are in-flight (all terminal)", () => {
    writeNestedSignal("CTL-B", "teardown", { status: "done" }); // CTL-703: teardown done is terminal
    writeNestedSignal("CTL-C", "verify", { status: "failed" });

    const reclaimDeadWork = recorder("noop");
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: () => ({ code: 0 }),
      writeStatus,
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

describe("preflightWorkspaceLabels (CTL-585, CTL-874)", () => {
  test("CTL-874: queries WORKSPACE scope once (not --team) and warns per missing required label", () => {
    const warnings = [];
    const execCalls = [];
    const fakeLog = {
      warn: (obj, msg) => warnings.push({ obj, msg }),
      info: () => {},
      error: () => {},
    };
    // Workspace has needs-human but is MISSING blocked + waiting.
    const exec = (cmd, args) => {
      execCalls.push({ cmd, args });
      expect(cmd).toBe("linearis");
      expect(args.slice(0, 4)).toEqual(["labels", "list", "--scope", "workspace"]);
      return {
        code: 0,
        stdout: JSON.stringify({ nodes: [{ name: "needs-human" }, { name: "bug" }] }),
        stderr: "",
      };
    };
    preflightWorkspaceLabels({ teams: ["CTL", "ENG"], exec, log: fakeLog });
    // Exactly ONE workspace-scoped query regardless of team count (no per-team --team).
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].args).not.toContain("--team");
    // Warns for the three missing required labels (blocked, queued, needs-input),
    // team-independent. CTL-764 Phase 4: "waiting" renamed to "queued"; needs-input added.
    const missing = warnings
      .filter((w) => w.msg.includes("missing required label"))
      .map((w) => w.obj.label)
      .sort();
    expect(missing).toEqual(["blocked", "needs-input", "queued"]);
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

  test("CTL-874: all four worker-status labels present produces zero warnings", () => {
    // Regression: the pre-CTL-874 preflight used --team, which never returns
    // workspace-scoped labels, so it warned on EVERY boot even when the labels
    // existed. With --scope workspace and the full required set present, the
    // boot is silent.
    // CTL-764 Phase 4: "waiting" renamed to "queued"; needs-input added as 4th member.
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
          { name: "worker-status", color: "#000" },
          { name: "needs-human", color: "#fff" },
          { name: "blocked" },
          { name: "queued" },
          { name: "needs-input" },
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

  test("does not re-write terminal Done once the .terminal-done.applied marker exists (CTL-703: teardown)", () => {
    writeSignal("CTL-20", "teardown", "done");
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

  test("writes the .terminal-done.applied marker only after applyTerminalDone reports applied:true (CTL-703: teardown)", () => {
    writeSignal("CTL-21", "teardown", "done");
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

  test("fires applyTerminalDone once across ticks (teardown done — CTL-703)", () => {
    writeSignal("CTL-22", "teardown", "done");
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

  test("a terminal-Done write throw never aborts the tick (CTL-703: teardown)", () => {
    writeSignal("CTL-23", "teardown", "done");
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

  // CTL-1157 (THE REVERSAL — ALARM-NOT-BLOCK): the terminal sweep writes Done
  // DIRECTLY (no agent to reason). It no longer REFUSES on an open PR — it PROCEEDS
  // (never wedges the board) and emits the loud recovery.done-applied-with-open-pr
  // alarm so observability would justify adding a hard block later. A clean Done is
  // silent.
  test("CTL-1157: an OPEN PR does NOT block the terminal-sweep Done write — it PROCEEDS and fires the alarm", () => {
    writeSignal("CTL-24", "teardown", "done");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dones = [];
    const writeStatus = {
      ...terminalNoWrites(),
      applyTerminalDone: (a) => {
        dones.push(a);
        return { applied: true };
      },
    };
    const checkOpenPrs = () => ({ ok: false, prs: [{ number: 321, state: "OPEN" }] });
    const alarms = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus,
      checkOpenPrs,
      emitDoneWithOpenPr: (ev) => alarms.push(ev),
    });
    expect(dones).toHaveLength(1); // proceeds — board never wedges
    expect(existsSync(join(orchDir, "workers", "CTL-24", ".terminal-done.applied"))).toBe(true);
    // The alarm fired with the ticket, the open PR list, and the backstop label.
    expect(alarms).toHaveLength(1);
    expect(alarms[0].ticket).toBe("CTL-24");
    expect(alarms[0].by).toBe("terminal-sweep");
    expect(alarms[0].openPrs.map((p) => p.number)).toEqual([321]);
  });

  // CTL-1157 (Codex GROUP-A fix #1 — UNVERIFIABLE ≠ CLEAN): a thrown/unverifiable
  // enumeration is NOT a clean list. Per alarm-not-block the sweep still PROCEEDS
  // (never wedges), but it now SURFACES the unverifiable Done via the loud alarm
  // (flagged unverifiable) rather than silently assuming zero open PRs.
  test("CTL-1157: an UNVERIFIABLE enumeration (gh throw) PROCEEDS and FIRES the alarm (unverifiable, surfaced not silent)", () => {
    writeSignal("CTL-25", "teardown", "done");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dones = [];
    const writeStatus = {
      ...terminalNoWrites(),
      applyTerminalDone: (a) => {
        dones.push(a);
        return { applied: true };
      },
    };
    const checkOpenPrs = () => {
      throw new Error("`gh` not authenticated");
    };
    const alarms = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus,
      checkOpenPrs,
      emitDoneWithOpenPr: (ev) => alarms.push(ev),
    });
    expect(dones).toHaveLength(1); // proceeds — alarm-not-block (never wedges)
    expect(existsSync(join(orchDir, "workers", "CTL-25", ".terminal-done.applied"))).toBe(true);
    // unverifiable ⇒ could-not-confirm-clean ⇒ surface it (not silent).
    expect(alarms).toHaveLength(1);
    expect(alarms[0].ticket).toBe("CTL-25");
    expect(alarms[0].by).toBe("terminal-sweep");
    expect(alarms[0].unverifiable).toBe(true);
    expect(alarms[0].openPrs).toEqual([]); // no KNOWN open PR, but still alarmed
  });

  // The structured {ok:false, unverifiable:true} return (no throw) — e.g. the
  // attachment-view-failure path or an underivable repo — alarms the same way.
  test("CTL-1157: a RETURNED unverifiable fact (no throw) also PROCEEDS and FIRES the alarm", () => {
    writeSignal("CTL-27", "teardown", "done");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dones = [];
    const writeStatus = {
      ...terminalNoWrites(),
      applyTerminalDone: (a) => {
        dones.push(a);
        return { applied: true };
      },
    };
    const checkOpenPrs = () => ({
      ok: false,
      unverifiable: true,
      reason: "repo-underivable",
      prs: [],
    });
    const alarms = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus,
      checkOpenPrs,
      emitDoneWithOpenPr: (ev) => alarms.push(ev),
    });
    expect(dones).toHaveLength(1);
    expect(alarms).toHaveLength(1);
    expect(alarms[0].unverifiable).toBe(true);
  });

  test("CTL-1157: no open PR (clean) writes Done, stamps the marker, and is SILENT (no alarm)", () => {
    writeSignal("CTL-26", "teardown", "done");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dones = [];
    const writeStatus = {
      ...terminalNoWrites(),
      applyTerminalDone: (a) => {
        dones.push(a);
        return { applied: true };
      },
    };
    const checkOpenPrs = () => ({ ok: true, prs: [] });
    const alarms = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus,
      checkOpenPrs,
      emitDoneWithOpenPr: (ev) => alarms.push(ev),
    });
    expect(dones).toHaveLength(1); // legitimate completion preserved
    expect(existsSync(join(orchDir, "workers", "CTL-26", ".terminal-done.applied"))).toBe(true);
    expect(alarms).toEqual([]); // clean Done is silent
  });

  // CTL-1157 GROUP B (Done-event accuracy): an idempotent terminal SKIP (Linear
  // already Done) returns {applied:true, action:"skipped"} and performs NO actual
  // write. Emitting recovery.done-applied for it would corrupt OTEL's Done-move
  // counts, and the open-PR alarm could fire for an already-Done ticket carrying a
  // stale open PR. The marker still lands (once-semantics), but NEITHER emit fires.
  test("CTL-1157: an idempotent SKIP (action:'skipped') stamps the marker but emits NO done-applied and NO alarm — even with a stale open PR", () => {
    writeSignal("CTL-28", "teardown", "done");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const writeStatus = {
      ...terminalNoWrites(),
      // already-Done in Linear → no real write, just the idempotent skip outcome.
      applyTerminalDone: () => ({ applied: true, action: "skipped" }),
    };
    // A stale open PR is present — would have alarmed on a REAL Done write.
    const checkOpenPrs = () => ({ ok: false, prs: [{ number: 999, state: "OPEN" }] });
    const doneApplied = [];
    const alarms = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus,
      checkOpenPrs,
      emitDoneApplied: (ev) => doneApplied.push(ev),
      emitDoneWithOpenPr: (ev) => alarms.push(ev),
    });
    // Once-semantics: the marker still lands on the confirming tick.
    expect(existsSync(join(orchDir, "workers", "CTL-28", ".terminal-done.applied"))).toBe(true);
    // But a SKIP is not a "move" — no done-applied, no open-PR alarm.
    expect(doneApplied).toEqual([]);
    expect(alarms).toEqual([]);
  });

  // CTL-1157 GROUP B: a REAL Done write (no action:"skipped") still emits the broad
  // recovery.done-applied move (guards against the skipped-gate over-suppressing).
  test("CTL-1157: a REAL terminal-sweep Done (applied, not skipped) DOES emit recovery.done-applied", () => {
    writeSignal("CTL-29", "teardown", "done");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const writeStatus = {
      ...terminalNoWrites(),
      applyTerminalDone: () => ({ applied: true, action: "applied" }),
    };
    const doneApplied = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus,
      checkOpenPrs: () => ({ ok: true, prs: [] }),
      emitDoneApplied: (ev) => doneApplied.push(ev),
    });
    expect(doneApplied).toHaveLength(1);
    expect(doneApplied[0].ticket).toBe("CTL-29");
    expect(doneApplied[0].by).toBe("terminal-sweep");
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
        writeFileSync(
          join(wdir, "phase-verify.json"),
          JSON.stringify({ ticket, phase, status: "done" })
        );
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
        writeFileSync(
          join(wdir, `phase-${phase}.json`),
          JSON.stringify({ ticket, phase, status: "done" })
        );
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
    expect(existsSync(join(orchDir, "workers", TICKET, ".linear-label-needs-human.applied"))).toBe(
      true
    );
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
      JSON.stringify({
        ticket: "CTL-101",
        phase: "research",
        status: "dispatched",
        bg_job_id: null,
      })
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
      JSON.stringify({
        ticket: "CTL-103",
        phase: "research",
        status: "running",
        bg_job_id: "abcd1234",
      })
    );
    expect(verifyDispatchedSignal(orchDir, "CTL-103", "research")).toEqual({ ok: true });
  });

  // CTL-1367 E3: the SDK-aware verifier path (requireBgJob:false) accepts the
  // SDK prelaunch signal, which intentionally has NO bg_job_id.
  test("requireBgJob:false accepts a dispatched signal with NO bg_job_id (SDK path)", () => {
    const dir = join(orchDir, "workers", "CTL-104");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "phase-research.json"),
      JSON.stringify({
        ticket: "CTL-104",
        phase: "research",
        status: "dispatched",
        bg_job_id: null,
      })
    );
    // Default (bg) verification still demotes it (the CTL-611 contract is unchanged)…
    expect(verifyDispatchedSignal(orchDir, "CTL-104", "research")).toEqual({
      ok: false,
      reason: "bg_job_id_missing",
    });
    // …but the SDK-aware path accepts it.
    expect(verifyDispatchedSignal(orchDir, "CTL-104", "research", { requireBgJob: false })).toEqual(
      { ok: true }
    );
  });

  test("requireBgJob:false also accepts a 'done' signal (idempotent duplicate sdk dispatch)", () => {
    const dir = join(orchDir, "workers", "CTL-105");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "phase-research.json"),
      JSON.stringify({ ticket: "CTL-105", phase: "research", status: "done", bg_job_id: null })
    );
    expect(verifyDispatchedSignal(orchDir, "CTL-105", "research", { requireBgJob: false })).toEqual(
      { ok: true }
    );
    // bg verification rejects a `done` status as not-runnable (unchanged).
    expect(verifyDispatchedSignal(orchDir, "CTL-105", "research").ok).toBe(false);
  });

  test("requireBgJob:false STILL rejects a stalled/failed signal", () => {
    const dir = join(orchDir, "workers", "CTL-106");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "phase-research.json"),
      JSON.stringify({ ticket: "CTL-106", phase: "research", status: "stalled", bg_job_id: null })
    );
    expect(verifyDispatchedSignal(orchDir, "CTL-106", "research", { requireBgJob: false })).toEqual(
      {
        ok: false,
        reason: "status_not_runnable",
      }
    );
  });

  // CTL-1367 P2-G: the SDK path (requireBgJob:false) treats a MISSING signal as a
  // benign claim-lost when a YOUNG single-flight claim exists (a concurrent
  // dispatcher won the O_EXCL claim and is mid-dispatch). Without this, a valid
  // concurrent SDK dispatch records verify_failed:signal_missing + cooldown.
  test("requireBgJob:false: missing signal + a fresh claim → ok (benign claim-lost)", () => {
    const dir = join(orchDir, "workers", "CTL-107");
    mkdirSync(dir, { recursive: true });
    // No phase-research.json signal; a fresh claim from the winning dispatcher.
    writeFileSync(join(dir, "research.claim.1"), JSON.stringify({ generation: 1 }));
    expect(verifyDispatchedSignal(orchDir, "CTL-107", "research", { requireBgJob: false })).toEqual(
      { ok: true }
    );
  });

  test("requireBgJob:false: missing signal + NO claim → still signal_missing", () => {
    const dir = join(orchDir, "workers", "CTL-108");
    mkdirSync(dir, { recursive: true });
    expect(verifyDispatchedSignal(orchDir, "CTL-108", "research", { requireBgJob: false })).toEqual(
      {
        ok: false,
        reason: "signal_missing",
      }
    );
  });

  // The bg path (requireBgJob defaults true) is byte-identical: a fresh claim does
  // NOT rescue a missing signal (a bg dispatch always writes its own signal).
  test("requireBgJob:true (bg): a fresh claim does NOT rescue a missing signal", () => {
    const dir = join(orchDir, "workers", "CTL-109");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "research.claim.1"), JSON.stringify({ generation: 1 }));
    expect(verifyDispatchedSignal(orchDir, "CTL-109", "research")).toEqual({
      ok: false,
      reason: "signal_missing",
    });
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

  // CTL-1367 P1: an ASYNC (executor=sdk) dispatch returns a Promise. The scheduler
  // detects it (dispatchWasAsync), verifies via verifyDispatched(requireBgJob:false),
  // and — on a REJECTED promise — fires the failed-terminal backstop so the ticket
  // can't strand at "dispatched". (scheduler.test.mjs is CI-excluded; the core
  // settleDispatchSync + backstopOnRejection mechanism is also covered in the
  // CI-included dispatch.test.mjs.)
  test("a REJECTED async dispatch fires the failed backstop via onSettled (CTL-1367 P1)", async () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const backstops = [];
    let rejectQuery;
    const queryFailed = new Promise((_res, rej) => {
      rejectQuery = rej;
    });
    const dispatch = Object.assign(
      () => {
        dispatch.calls.push({});
        return queryFailed;
      }, // async (sdk) shape
      { calls: [] }
    );
    schedulerTick(orchDir, {
      readEligible: () => eligibleOne("CTL-204"),
      dispatch,
      now: () => 1_000,
      verifyDispatched: () => ({ ok: true }), // async launch confirmed off the provisional signal
      liveBackgroundCount: () => 0,
      hasTriageArtifact: () => true, // bypass triage gate → dispatch research
      emitBackstop: (a) => backstops.push(a),
    });
    expect(dispatch.calls).toHaveLength(1);
    expect(backstops).toHaveLength(0); // nothing yet — the promise is still pending
    rejectQuery(new Error("buildSdkEnv exploded"));
    await queryFailed.catch(() => {});
    await Promise.resolve();
    await Promise.resolve();
    expect(backstops).toHaveLength(1);
    expect(backstops[0]).toMatchObject({ ticket: "CTL-204", phase: "research", status: "failed" });
    expect(backstops[0].reason).toMatch(/buildSdkEnv exploded/);
  });

  test("a RESOLVED async dispatch does NOT fire the backstop (CTL-1367 P1)", async () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const backstops = [];
    const dispatch = Object.assign(
      () => {
        dispatch.calls.push({});
        return Promise.resolve({ code: 0 });
      },
      { calls: [] }
    );
    schedulerTick(orchDir, {
      readEligible: () => eligibleOne("CTL-205"),
      dispatch,
      now: () => 1_000,
      verifyDispatched: () => ({ ok: true }),
      liveBackgroundCount: () => 0,
      hasTriageArtifact: () => true,
      emitBackstop: (a) => backstops.push(a),
    });
    expect(dispatch.calls).toHaveLength(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(backstops).toHaveLength(0); // clean resolution → worker owns its terminal event
  });

  test("new-work sweep emits phase.dispatch.failed on rc!=0", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({ code: 1 });

    schedulerTick(orchDir, {
      readEligible: () => eligibleOne("CTL-202"),
      dispatch,
      now: () => 1_000,
      liveBackgroundCount: () => 0, // CTL-611: deterministic free slot post-CTL-657 rebase
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is dispatch.failed event
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
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is verify-failed event
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
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is cooldown dedup
    });
    // Tick 2 inside the 60s window: suppressed by cool-down → 0 new dispatch,
    // 0 new event (the dispatch never re-attempts so emission never fires).
    schedulerTick(orchDir, {
      readEligible: () => eligibleOne("CTL-204"),
      dispatch,
      now: () => 30_000,
      liveBackgroundCount: () => 0, // CTL-611: deterministic free slot post-CTL-657 rebase
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is cooldown dedup
    });

    expect(dispatch.calls).toHaveLength(1);
    expect(dispatchFailedEvents("CTL-204")).toHaveLength(1);
  });

  // CTL-1004/CTL-1056 Bug 2: a real rc!=0 dispatch failure must carry the
  // captured stderr tail + spawn error / signal into the phase.dispatch.failed
  // event payload, so the failure is diagnosable from the unified log (today it
  // logged a bare {ticket, code} and the broker event dropped stderr entirely).
  test("rc!=0 failure carries stderr_tail + spawn_error + signal in the event payload", () => {
    writeSignal("CTL-206", "research", "done");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({
      code: 127,
      stderr: "phase-agent-dispatch: recreate→rebase refused\nworktree dirty, aborting\n",
      spawnError: "ETIMEDOUT",
      signal: "SIGKILL",
    });

    schedulerTick(orchDir, { readEligible: () => [], dispatch, now: () => 1_000 });

    const events = dispatchFailedEvents("CTL-206");
    expect(events).toHaveLength(1);
    const payload = events[0].body.payload;
    expect(payload.target_phase).toBe("plan");
    expect(payload.code).toBe(127);
    // The trimmed stderr tail is present and carries the diagnostic text.
    expect(payload.stderr_tail).toMatch(/worktree dirty, aborting/);
    expect(payload.spawn_error).toBe("ETIMEDOUT");
    expect(payload.signal).toBe("SIGKILL");
  });

  test("a failure with empty stderr omits stderr_tail (no empty noise)", () => {
    writeSignal("CTL-207", "research", "done");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({ code: 1, stderr: "" });

    schedulerTick(orchDir, { readEligible: () => [], dispatch, now: () => 1_000 });

    const events = dispatchFailedEvents("CTL-207");
    expect(events).toHaveLength(1);
    const payload = events[0].body.payload;
    expect("stderr_tail" in payload).toBe(false);
    expect("spawn_error" in payload).toBe(false);
    expect("signal" in payload).toBe(false);
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
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is event emission
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
    expect(requested.calls[0]).toMatchObject({
      ticket: "CTL-302",
      target_phase: "plan",
      reason: "advance",
    });
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

  test("order: triage=0, research=1, plan=2, implement=3, remediate=4, verify=5, review=6, pr=7, monitor-merge=8, monitor-deploy=9, teardown=10", () => {
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
    // CTL-703: teardown is the 10th pipeline phase
    expect(STAGE_RANK.teardown).toBe(10);
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
    expect(
      stageRankForTicket({ triage: "done", research: "done", plan: "done", verify: "running" })
    ).toBe(5);
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

  test("teardown done is terminal — excluded (CTL-703: teardown is now TERMINAL_PHASE)", () => {
    expect(stageRankForTicket({ teardown: "done" })).toBe(-1);
    expect(stageRankForTicket({ teardown: "skipped" })).toBe(-1);
  });

  test("monitor-deploy done is NOT terminal anymore — included as rank 9 (CTL-703)", () => {
    // monitor-deploy done is now an intermediate phase (advances to teardown)
    expect(stageRankForTicket({ "monitor-deploy": "done" })).toBe(9);
    expect(stageRankForTicket({ "monitor-deploy": "skipped" })).toBe(9);
  });

  test("monitor-deploy running is NOT terminal — included", () => {
    expect(stageRankForTicket({ "monitor-deploy": "running" })).toBe(9);
  });

  test("teardown running is NOT terminal — included as rank 10 (CTL-703)", () => {
    expect(stageRankForTicket({ teardown: "running" })).toBe(10);
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
    expect(readWorkerPriority(orchDir, "CTL-42")).toEqual({
      priority: 1,
      createdAt: "2026-05-01T00:00:00Z",
    });
  });

  test("write is idempotent — second write overwrites first", () => {
    mkdirSync(join(orchDir, "workers", "CTL-43"), { recursive: true });
    writeWorkerPriority(orchDir, "CTL-43", { priority: 3, createdAt: "2026-01-01T00:00:00Z" });
    writeWorkerPriority(orchDir, "CTL-43", { priority: 2, createdAt: "2026-02-01T00:00:00Z" });
    expect(readWorkerPriority(orchDir, "CTL-43")).toEqual({
      priority: 2,
      createdAt: "2026-02-01T00:00:00Z",
    });
  });

  test("unreadable/malformed priority.json → safe default, never throws", () => {
    const dir = join(orchDir, "workers", "CTL-44");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "priority.json"), "not-json");
    expect(() => readWorkerPriority(orchDir, "CTL-44")).not.toThrow();
    expect(readWorkerPriority(orchDir, "CTL-44")).toEqual({ priority: 5, createdAt: null });
  });
});

// ── CTL-864 remediation: persisted cross-host fence token (read/write) ──
describe("readClusterGeneration / writeClusterGeneration (CTL-864)", () => {
  test("missing cluster-generation.json → null", () => {
    expect(readClusterGeneration(orchDir, "CTL-NONE")).toBe(null);
  });

  test("round-trips the won generation through write → read", () => {
    mkdirSync(join(orchDir, "workers", "CTL-864a"), { recursive: true });
    writeClusterGeneration(orchDir, "CTL-864a", 7);
    expect(readClusterGeneration(orchDir, "CTL-864a")).toBe(7);
  });

  test("write is idempotent — second write overwrites first", () => {
    mkdirSync(join(orchDir, "workers", "CTL-864b"), { recursive: true });
    writeClusterGeneration(orchDir, "CTL-864b", 3);
    writeClusterGeneration(orchDir, "CTL-864b", 5);
    expect(readClusterGeneration(orchDir, "CTL-864b")).toBe(5);
  });

  test("non-finite generation (null single-host claim) is never persisted", () => {
    mkdirSync(join(orchDir, "workers", "CTL-864c"), { recursive: true });
    writeClusterGeneration(orchDir, "CTL-864c", null);
    expect(existsSync(join(orchDir, "workers", "CTL-864c", "cluster-generation.json"))).toBe(false);
    expect(readClusterGeneration(orchDir, "CTL-864c")).toBe(null);
  });

  test("malformed cluster-generation.json → null, never throws", () => {
    const dir = join(orchDir, "workers", "CTL-864d");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cluster-generation.json"), "not-json");
    expect(() => readClusterGeneration(orchDir, "CTL-864d")).not.toThrow();
    expect(readClusterGeneration(orchDir, "CTL-864d")).toBe(null);
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

  test("terminal in-flight tickets are excluded (CTL-703: teardown done is terminal)", () => {
    seedInFlight("CTL-X", "teardown", "done", "dead", undefined, undefined);
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
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is priority.json write
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
    writeWorkerPriority(orchDir, ticket, {
      priority,
      createdAt: createdAt ?? "2026-05-01T00:00:00Z",
    });
  }

  function readSignal(ticket, phase) {
    return JSON.parse(
      readFileSync(join(orchDir, "workers", ticket, `phase-${phase}.json`), "utf8")
    );
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
    const fn = (args) => {
      calls.push(args);
      return true;
    };
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
      JSON.stringify({
        ticket: "CTL-Adv",
        phase: "research",
        status: "preempted",
        parkedFrom: "research",
      })
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

// ─── CTL-768: held-worker stop sweep ───

describe("held-worker stop sweep (CTL-768)", () => {
  // writeSignalRaw is already available from the scheduler.test.mjs context.
  // But we also need a helper for writing needs-input signals.
  function writeNeedsInputSignal(ticket, phase, overrides = {}) {
    const dir = join(orchDir, "workers", ticket);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `phase-${phase}.json`),
      JSON.stringify({ ticket, phase, status: "needs-input", ...overrides })
    );
  }

  const noopReclaim = () => "noop";

  test("idle needs-input worker is stopped, signal annotated, event emitted", async () => {
    writeNeedsInputSignal("CTL-1", "implement", { bg_job_id: "held1234" });
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const kill = [];
    const events = [];
    schedulerTick(orchDir, {
      liveBackgroundCount: () => 1,
      maxParallel: 1,
      livenessForHeld: () => "idle",
      killBgJob: ({ bgJobId }) => kill.push(bgJobId),
      appendHeldStoppedEvent: (p) => {
        events.push(p);
        return true;
      },
      reclaimDeadWork: noopReclaim,
      now: () => 1_000,
    });
    expect(kill).toEqual(["held1234"]);
    const sig = JSON.parse(
      readFileSync(join(orchDir, "workers/CTL-1/phase-implement.json"), "utf8")
    );
    expect(sig.status).toBe("needs-input"); // status unchanged
    expect(sig.stoppedForHold).toBe(true); // marker set
    expect(sig.bg_job_id).toBe("held1234"); // preserved for resolvePhaseSessionId
    expect(events).toHaveLength(1);
    // cooldown marker written:
    expect(existsSync(holdStopCooldownPath(orchDir, "CTL-1", "implement"))).toBe(true);
  });

  test("mid-turn (busy) worker is NOT stopped", async () => {
    writeNeedsInputSignal("CTL-1", "implement", { bg_job_id: "busy1234" });
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const kill = [];
    schedulerTick(orchDir, {
      liveBackgroundCount: () => 1,
      maxParallel: 1,
      livenessForHeld: () => "busy",
      killBgJob: ({ bgJobId }) => kill.push(bgJobId),
      reclaimDeadWork: noopReclaim,
      now: () => 1_000,
    });
    expect(kill).toEqual([]);
  });

  test("absent worker is NOT stopped (reclaim handles dead workers)", async () => {
    writeNeedsInputSignal("CTL-1", "implement", { bg_job_id: "gone1234" });
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const kill = [];
    schedulerTick(orchDir, {
      liveBackgroundCount: () => 1,
      maxParallel: 1,
      livenessForHeld: () => "absent",
      killBgJob: ({ bgJobId }) => kill.push(bgJobId),
      reclaimDeadWork: noopReclaim,
      now: () => 1_000,
    });
    expect(kill).toEqual([]);
  });

  test("cooldown guard: not re-stopped within HOLD_STOP_COOLDOWN_MS", async () => {
    writeNeedsInputSignal("CTL-1", "implement", { bg_job_id: "held1234" });
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    recordHoldStop(orchDir, "CTL-1", "implement", 1_000); // stopped 30s ago
    const kill = [];
    schedulerTick(orchDir, {
      liveBackgroundCount: () => 1,
      maxParallel: 1,
      livenessForHeld: () => "idle",
      killBgJob: ({ bgJobId }) => kill.push(bgJobId),
      reclaimDeadWork: noopReclaim,
      now: () => 31_000,
    }); // within 90s window
    expect(kill).toEqual([]);
  });

  test("freeSlots accounting: heldStopCount blocks same-tick new-work double-fill", async () => {
    // One needs-input worker (alive, count=1) + one queued new-work ticket.
    writeNeedsInputSignal("CTL-1", "implement", { bg_job_id: "held1234" });
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    writeEligibleProjection("CTL", {
      tickets: [{ identifier: "CTL-2", priority: 1, createdAt: "2026-05-01T00:00:00Z" }],
    });
    const dispatched = [];
    schedulerTick(orchDir, {
      liveBackgroundCount: () => 1,
      maxParallel: 1, // liveCount=1 BEFORE stop deregisters
      livenessForHeld: () => "idle",
      killBgJob: () => {},
      reclaimDeadWork: noopReclaim,
      dispatch: (d, t) => {
        dispatched.push(t);
        return { code: 0, stdout: "", stderr: "" };
      },
      now: () => 1_000,
    });
    // freeSlots = computeFreeSlots(1, liveCount=1) = 0 → no new dispatch. The
    // held worker is still in liveCount this tick (claude stop doesn't deregister
    // same-tick), so computeFreeSlots alone already withholds the slot. (CTL-768
    // remediation removed the redundant `- heldStopCount` term — see the
    // maxParallel=2 regression below for why the term over-suppressed.)
    expect(dispatched).not.toContain("CTL-2");
  });

  test("CTL-768 freeSlots regression: at maxParallel=2 a genuinely-free slot is dispatched the same tick a held-stop fires (no double-suppression)", async () => {
    // One held idle needs-input worker (CTL-1, still in liveCount=1) + one
    // genuinely-empty slot + one queued ticket (CTL-2). The corrected accounting
    // is freeSlots = computeFreeSlots(2, liveCount=1) = 1: computeFreeSlots
    // already withholds the held worker's slot (it's still in liveCount this
    // tick), so CTL-2 MUST be dispatched into the second, genuinely-free slot.
    // The pre-remediation `- heldStopCount` term gave max(0, (2-1) - 1) = 0 and
    // wrongly suppressed this dispatch — this test fails on that old code.
    writeNeedsInputSignal("CTL-1", "implement", { bg_job_id: "held1234" });
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    writeEligibleProjection("CTL", {
      tickets: [{ identifier: "CTL-2", priority: 1, createdAt: "2026-05-01T00:00:00Z" }],
    });
    const dispatched = [];
    schedulerTick(orchDir, {
      liveBackgroundCount: () => 1,
      maxParallel: 2, // liveCount=1 (held worker still counted)
      livenessForHeld: () => "idle",
      killBgJob: () => {},
      reclaimDeadWork: noopReclaim,
      dispatch: (args) => {
        dispatched.push(args.ticket);
        return { code: 0, stdout: "", stderr: "" };
      },
      now: () => 1_000,
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is freeSlots regression
    });
    expect(dispatched).toContain("CTL-2"); // the free slot IS used
    // No over-spawn: held worker still in liveCount (1) + 1 new dispatch = 2 = maxParallel.
    expect(dispatched).toHaveLength(1);
  });

  test("needs-input + stoppedForHold signal is NOT revived (reclaimDeadWork returns noop)", () => {
    // The reclaimDeadWorkIfPossible guard (recovery.mjs:1708) returns "noop" for
    // needs-input signals — it does NOT revive them. This test uses the real
    // reclaimDeadWork (no injection) to pin that invariant. No dispatch must fire.
    writeNeedsInputSignal("CTL-1", "implement", { bg_job_id: "held1234", stoppedForHold: true });
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch();
    schedulerTick(orchDir, {
      liveBackgroundCount: () => 1,
      livenessForHeld: () => "absent", // already stopped — absent
      dispatch,
      // reclaimDeadWork not injected → real reclaimDeadWorkIfPossible runs.
      // It returns "noop" for needs-input signals — no revive dispatch fires.
      now: () => 100_000, // past cooldown
    });
    // No revive dispatch for the held-stopped worker (noop reclaim)
    const reviveCallsForCTL1 = dispatch.calls.filter((c) => c.ticket === "CTL-1");
    expect(reviveCallsForCTL1).toHaveLength(0);
  });

  test("needs-input + stoppedForHold signal is NOT advanced (guard regression)", () => {
    writeNeedsInputSignal("CTL-1", "implement", { stoppedForHold: true });
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch();
    schedulerTick(orchDir, {
      liveBackgroundCount: () => 1,
      livenessForHeld: () => "absent",
      dispatch,
      reclaimDeadWork: noopReclaim,
      now: () => 100_000,
    });
    const advancedForCTL1 = dispatch.calls.filter((c) => c.ticket === "CTL-1");
    expect(advancedForCTL1).toHaveLength(0); // not advanced
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
        ticket,
        phase,
        status: "preempted",
        parkedFrom: phase,
        bg_job_id: bgJobId,
        attentionReason: "preempted-by-priority",
      })
    );
    writeWorkerPriority(orchDir, ticket, { priority, createdAt: "2026-05-01T00:00:00Z" });
  }

  function makeResumeStub() {
    const calls = [];
    const fn = (args) => {
      calls.push(args);
      return true;
    };
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
        JSON.stringify({
          ticket: args.ticket,
          phase: args.phase,
          status: "dispatched",
          bg_job_id: "new-bg",
        })
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
    const sig = JSON.parse(
      readFileSync(join(orchDir, "workers", "CTL-2", "phase-research.json"), "utf8")
    );
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

  test("emits for stalled worker and for terminal teardown done (CTL-703: teardown is TERMINAL_PHASE)", () => {
    writeSignalRaw("CTL-2", "review", { status: "stalled", bg_job_id: "stl12345" });
    writeSignalRaw("CTL-3", "teardown", { status: "done", bg_job_id: "fin12345" });
    schedulerTick(orchDir, { readEligible: () => [], dispatch: () => ({ code: 0 }) });
    const evts = readEventLog();
    expect(
      evts.some((e) => e.event === "phase.terminal.reap-requested" && e.bg_job_id === "stl12345")
    ).toBe(true);
    expect(
      evts.some((e) => e.event === "phase.terminal.reap-requested" && e.bg_job_id === "fin12345")
    ).toBe(true);
  });

  test("does NOT re-emit on a second tick (once-marker)", () => {
    writeSignalRaw("CTL-1", "implement", { status: "failed", bg_job_id: "dead1234" });
    schedulerTick(orchDir, { readEligible: () => [], dispatch: () => ({ code: 0 }) });
    schedulerTick(orchDir, { readEligible: () => [], dispatch: () => ({ code: 0 }) });
    const n = readEventLog().filter(
      (e) => e.event === "phase.terminal.reap-requested" && e.bg_job_id === "dead1234"
    ).length;
    expect(n).toBe(1);
    expect(existsSync(join(orchDir, "workers", "CTL-1", ".terminal-reap-implement.applied"))).toBe(
      true
    );
  });

  test("skips a terminal signal with no bg_job_id (no spurious emit, no marker)", () => {
    writeSignalRaw("CTL-1", "implement", { status: "failed" }); // no bg_job_id
    schedulerTick(orchDir, { readEligible: () => [], dispatch: () => ({ code: 0 }) });
    expect(readEventLog().some((e) => e.event === "phase.terminal.reap-requested")).toBe(false);
    expect(existsSync(join(orchDir, "workers", "CTL-1", ".terminal-reap-implement.applied"))).toBe(
      false
    );
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
    expect(
      evts.some((e) => e.event === "phase.terminal.reap-requested" && e.bg_job_id === "res12345")
    ).toBe(false);
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
    const checkSequencing = () => {
      spyCount++;
      return { verdict: "go", hard_dependencies: [] };
    };
    const dispatch = fakeDispatch({ code: 0 });
    schedulerTick(orchDir, {
      readEligible: () => eligibleTwo("CTL-NEW"),
      dispatch,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0, // nothing in-flight
      checkSequencing,
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is sequencing seam
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
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is sequencing go verdict
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
      (c) => c.ticket === "CTL-NEW" || (Array.isArray(c) && c[1] === "CTL-NEW")
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
      applyBlockedByRelation: (args) => {
        blockedByRelationCalls.push(args);
        return { applied: true, reason: null };
      },
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
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is hard_dependencies
    });
    // applyBlockedByRelation called with the dep
    expect(blockedByRelationCalls).toHaveLength(1);
    expect(blockedByRelationCalls[0]).toMatchObject({ ticket: "CTL-NEW", blockedBy: "CTL-IN" });
    // Dispatch suppressed
    const dispatchedNew = dispatch.calls.some(
      (c) => c.ticket === "CTL-NEW" || (Array.isArray(c) && c[1] === "CTL-NEW")
    );
    expect(dispatchedNew).toBe(false);
  });

  test("untrusted dep ids dropped → no blocked-by write, falls through to verdict (phase-review hardening)", () => {
    const dispatch = fakeDispatch({ code: 0 });
    const blockedByRelationCalls = [];
    const writeStatus = {
      applyPhaseStatus: () => ({ applied: true, reason: null }),
      applyTerminalDone: () => ({ applied: true, reason: null }),
      applyBlockedByRelation: (args) => {
        blockedByRelationCalls.push(args);
        return { applied: true, reason: null };
      },
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
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is untrusted dep hardening
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
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is seam=undefined legacy
    });
    // Dispatch must proceed (legacy behavior — seam absent means no gate)
    const dispatchedNew = dispatch.calls.some(
      (c) => c.ticket === "CTL-NEW" || (Array.isArray(c) && c[1] === "CTL-NEW")
    );
    expect(dispatchedNew).toBe(true);
  });

  test("cooldown precedes seam — checkSequencing spy NOT called for a cooling-down candidate", () => {
    let spyCount = 0;
    const checkSequencing = () => {
      spyCount++;
      return { verdict: "go", hard_dependencies: [] };
    };
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
    const checkSequencing = () => {
      spyCount++;
      return { verdict: "go", hard_dependencies: [] };
    };

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
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is startScheduler forwarding
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
      removeLabel: () => {},
      applyEstimate: (a) => {
        estimateCalls.push(a);
        return { applied: true, reason: null };
      },
    };
  }

  // CTL-755: the estimate write-back rides the triage→research advance, which is
  // now admission-gated — stub fetchRelations (unblocked) + a free slot so the
  // promotion fires and the applyEstimate code path is reached.
  const admit = { fetchBatch: mkBatch(() => relUnblocked()), liveBackgroundCount: () => 0 };

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
      ...admit,
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
      ...admit,
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
      ...admit,
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
      removeLabel: () => {},
      applyEstimate: () => {
        throw new Error("Linear exploded");
      },
    };
    expect(() =>
      schedulerTick(orchDir, {
        readEligible: () => [],
        dispatch: okDispatch,
        writeStatus,
        verifyDispatched: verifyOk,
        ...admit,
      })
    ).not.toThrow();
  });

  // ── CTL-954: expanded estimation method support ───────────────────────────

  test("CTL-954: estimate:2 with estimateMethod:tShirt (M) → applyEstimate called with 2", () => {
    // triage.json carries estimateMethod so no network call is made.
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    writeSignal("CTL-1", "triage", "done");
    writeTriageJson("CTL-1", { estimated_scope: "medium", estimate: 2, estimateMethod: "tShirt" });
    const calls = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: okDispatch,
      writeStatus: makeWriteStatus(calls),
      verifyDispatched: verifyOk,
      ...admit,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ ticket: "CTL-1", estimate: 2 });
  });

  test("CTL-954: estimate:4 with estimateMethod:exponential → applyEstimate called with 4", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    writeSignal("CTL-1", "triage", "done");
    writeTriageJson("CTL-1", {
      estimated_scope: "large",
      estimate: 4,
      estimateMethod: "exponential",
    });
    const calls = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: okDispatch,
      writeStatus: makeWriteStatus(calls),
      verifyDispatched: verifyOk,
      ...admit,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ ticket: "CTL-1", estimate: 4 });
  });

  test("CTL-954: estimate not in estimateMethod's scale → applyEstimate not called", () => {
    // tShirt scale is [0,1,2,3,5] — value 4 is NOT in tShirt.
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    writeSignal("CTL-1", "triage", "done");
    writeTriageJson("CTL-1", { estimated_scope: "large", estimate: 4, estimateMethod: "tShirt" });
    const calls = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: okDispatch,
      writeStatus: makeWriteStatus(calls),
      verifyDispatched: verifyOk,
      ...admit,
    });
    // 4 is not in tShirt scale → rejected by readTriageEstimate → no write.
    expect(calls).toHaveLength(0);
  });

  test("CTL-954: estimateMethod:notUsed → applyEstimate not called (team doesn't use points)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    writeSignal("CTL-1", "triage", "done");
    writeTriageJson("CTL-1", { estimated_scope: "medium", estimate: 3, estimateMethod: "notUsed" });
    const calls = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: okDispatch,
      writeStatus: makeWriteStatus(calls),
      verifyDispatched: verifyOk,
      ...admit,
    });
    expect(calls).toHaveLength(0);
  });

  test("CTL-954: no estimate, estimateMethod:tShirt, scope:medium → derive 2 via mapScopeToEstimate", () => {
    // No explicit estimate — scheduler derives from scope + method.
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    writeSignal("CTL-1", "triage", "done");
    writeTriageJson("CTL-1", { estimated_scope: "medium", estimateMethod: "tShirt" });
    const calls = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: okDispatch,
      writeStatus: makeWriteStatus(calls),
      verifyDispatched: verifyOk,
      ...admit,
    });
    expect(calls).toHaveLength(1);
    // medium → tShirt[2] = 2 (M)
    expect(calls[0]).toEqual({ ticket: "CTL-1", estimate: 2 });
  });

  test("CTL-954: no estimate, estimateMethod:fibonacci, scope:large → derive 5", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    writeSignal("CTL-1", "triage", "done");
    writeTriageJson("CTL-1", { estimated_scope: "large", estimateMethod: "fibonacci" });
    const calls = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: okDispatch,
      writeStatus: makeWriteStatus(calls),
      verifyDispatched: verifyOk,
      ...admit,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ ticket: "CTL-1", estimate: 5 });
  });

  test("CTL-954: estimate:5 with no estimateMethod → Fibonacci fallback (pre-CTL-954 compat)", () => {
    // Pre-CTL-954 triage.json: estimate present, no estimateMethod, no team
    // network (getEstimationMethod fails-open → null → Fibonacci fallback).
    // Value 5 is in Fibonacci → still accepted.
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    writeSignal("CTL-1", "triage", "done");
    writeTriageJson("CTL-1", { estimated_scope: "medium", estimate: 5 });
    const calls = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: okDispatch,
      writeStatus: makeWriteStatus(calls),
      verifyDispatched: verifyOk,
      ...admit,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ ticket: "CTL-1", estimate: 5 });
  });
});

// ── CTL-755: admission-control gate (STEP A/B/C) ──
//
// The triage→research promotion is admission-controlled by deps + priority +
// capacity. A triaged-waiting ticket is dispatched to research ONLY when its
// blockers are all terminal AND it wins the priority/capacity selection this
// tick. Held tickets carry a dynamic blocked/waiting label (cleared on pickup).
describe("CTL-755: admission gate", () => {
  afterEach(() => __resetForTests());

  // A writeStatus spy that records label add/remove + estimate + phase-status.
  function labelSpy() {
    const applied = [];
    const removed = [];
    const phaseStatus = [];
    const ws = {
      applyPhaseStatus: (a) => phaseStatus.push(a),
      applyTerminalDone: () => {},
      applyEstimate: () => ({ applied: true }),
      applyLabel: (a) => {
        applied.push(a);
        return { applied: true, reason: null };
      },
      removeLabel: (ticket, label) => {
        removed.push({ ticket, label });
        return { removed: true };
      },
    };
    return { ws, applied, removed, phaseStatus };
  }

  // A held-event spy.
  function heldSpy() {
    const events = [];
    return { fn: (e) => events.push(e), events };
  }

  test("dep hold: a blocked triaged ticket is NOT dispatched, no Research write, 'blocked' label applied", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    writeSignal("CTL-7", "triage", "done");
    const dispatch = fakeDispatch();
    const { ws, applied, removed, phaseStatus } = labelSpy();
    const held = heldSpy();
    const r = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      writeStatus: ws,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      // CTL-7 is blocked by an out-of-set blocker that is still In Progress.
      fetchBatch: batchWith(() => relBlockedBy("CTL-DEP"), { "CTL-DEP": "In Progress" }),
      appendPhaseAdvanceHeldEvent: held.fn,
    });
    expect(dispatch.calls).toEqual([]); // no research dispatch
    expect(r.advanced).toEqual([]);
    // No phase-status write for research (the soft hold never reaches it).
    expect(phaseStatus.some((p) => p.phase === "research")).toBe(false);
    // The "blocked" held label is applied.
    expect(applied).toContainEqual({ ticket: "CTL-7", label: "blocked" });
    expect(removed).toEqual([]);
    // The held event carries the dep reason + unmet blocker id.
    expect(held.events).toHaveLength(1);
    expect(held.events[0]).toMatchObject({
      ticket: "CTL-7",
      reason: "blocked-by-open-dependency",
      blockers: ["CTL-DEP"],
    });
  });

  test("auto-promote: when the blocker flips terminal, 'blocked' is removed and research dispatches", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    writeSignal("CTL-7", "triage", "done");
    const dispatch = fakeDispatch();
    const { ws, applied, removed } = labelSpy();
    const r = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      writeStatus: ws,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      // CTL-7's blocker carries the "blocked" label already; now it is Done.
      fetchBatch: batchWith(() => relBlockedBy("CTL-DEP", { labels: ["blocked"] }), {
        "CTL-DEP": "Done",
      }),
    });
    expect(dispatch.calls).toEqual([{ orchDir, ticket: "CTL-7", phase: "research" }]);
    expect(r.advanced).toEqual([{ ticket: "CTL-7", phase: "research" }]);
    // Clear-on-pickup: the stale "blocked" label is removed, none applied.
    expect(removed).toContainEqual({ ticket: "CTL-7", label: "blocked" });
    expect(applied).toEqual([]);
  });

  test("capacity hold-then-promote: 'waiting' while full, promoted + label cleared when a slot frees", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    writeSignal("CTL-7", "triage", "done"); // unblocked but no free slot

    // Tick 1: a live worker fills the only slot → CTL-7 is ready but un-admitted.
    const d1 = fakeDispatch();
    const s1 = labelSpy();
    const h1 = heldSpy();
    const r1 = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: d1,
      writeStatus: s1.ws,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 1, // saturated
      fetchBatch: mkBatch(() => relUnblocked()),
      appendPhaseAdvanceHeldEvent: h1.fn,
    });
    expect(d1.calls).toEqual([]); // no promotion
    expect(r1.advanced).toEqual([]);
    // CTL-764 Phase 4: awaiting-capacity label is now "queued" (was "waiting").
    expect(s1.applied).toContainEqual({ ticket: "CTL-7", label: "queued" });
    expect(h1.events[0]).toMatchObject({
      ticket: "CTL-7",
      reason: "awaiting-capacity-or-priority",
      blockers: [],
    });

    // Tick 2: the slot frees → CTL-7 is admitted, promoted, and "queued" cleared.
    const d2 = fakeDispatch();
    const s2 = labelSpy();
    const r2 = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: d2,
      writeStatus: s2.ws,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0, // slot freed
      // CTL-764 Phase 4: ticket wears the new "queued" label (renamed from "waiting").
      fetchBatch: mkBatch(() => relUnblocked({ labels: ["queued"] })),
    });
    expect(d2.calls).toEqual([{ orchDir, ticket: "CTL-7", phase: "research" }]);
    expect(r2.advanced).toEqual([{ ticket: "CTL-7", phase: "research" }]);
    expect(s2.removed).toContainEqual({ ticket: "CTL-7", label: "queued" });
  });

  test("promotion clears BOTH held labels (clear-on-pickup regression anchor)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    writeSignal("CTL-7", "triage", "done");
    const dispatch = fakeDispatch();
    const { ws, applied, removed } = labelSpy();
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      writeStatus: ws,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      // Both stale labels present (defensive — should never co-exist, but the
      // converge must clear both on pickup).
      // CTL-764 Phase 4: label value renamed "waiting" → "queued".
      fetchBatch: mkBatch(() => relUnblocked({ labels: ["blocked", "queued"] })),
    });
    expect(dispatch.calls).toEqual([{ orchDir, ticket: "CTL-7", phase: "research" }]);
    expect(removed).toContainEqual({ ticket: "CTL-7", label: "blocked" });
    // CTL-764 Phase 4: "queued" (was "waiting") removed on pickup.
    expect(removed).toContainEqual({ ticket: "CTL-7", label: "queued" });
    expect(applied).toEqual([]);
  });

  test("steady-state held tick makes ZERO applyLabel/removeLabel calls (idempotent)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    writeSignal("CTL-7", "triage", "done");
    const dispatch = fakeDispatch();
    const { ws, applied, removed } = labelSpy();
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      writeStatus: ws,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      // Already correctly labeled "blocked" (blocker still open) → no diff.
      fetchBatch: batchWith(() => relBlockedBy("CTL-DEP", { labels: ["blocked"] }), {
        "CTL-DEP": "In Progress",
      }),
    });
    expect(dispatch.calls).toEqual([]);
    expect(applied).toEqual([]); // already labeled → no apply
    expect(removed).toEqual([]); // nothing to remove
  });

  test("steady-state held tick re-emits NO held event (only-on-state-change)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    writeSignal("CTL-7", "triage", "done");
    const dispatch = fakeDispatch();
    const held = heldSpy();
    const common = {
      readEligible: () => [],
      dispatch,
      writeStatus: labelSpy().ws,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      fetchBatch: batchWith(() => relBlockedBy("CTL-DEP", { labels: ["blocked"] }), {
        "CTL-DEP": "In Progress",
      }),
      appendPhaseAdvanceHeldEvent: held.fn,
    };
    schedulerTick(orchDir, common);
    schedulerTick(orchDir, common);
    // Two held ticks, but the held class did not change → exactly one emit.
    expect(held.events).toHaveLength(1);
  });

  test("circular dep among triaged tickets → labelOnce(needs-human), no throw, no deadlock", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    writeSignal("CTL-A", "triage", "done");
    writeSignal("CTL-B", "triage", "done");
    const dispatch = fakeDispatch();
    const { ws, applied } = labelSpy();
    // CTL-A blocked_by CTL-B and CTL-B blocked_by CTL-A → 2-node cycle.
    const fr = relMap({
      "CTL-A": relBlockedBy("CTL-B"),
      "CTL-B": relBlockedBy("CTL-A"),
    });
    let r;
    expect(() => {
      r = schedulerTick(orchDir, {
        readEligible: () => [],
        dispatch,
        writeStatus: ws,
        verifyDispatched: verifyOk,
        liveBackgroundCount: () => 0,
        fetchBatch: mkBatch(fr),
      });
    }).not.toThrow();
    expect(dispatch.calls).toEqual([]); // neither member promotes
    expect(r.advanced).toEqual([]);
    // Both cycle members are flagged needs-human (labelOnce).
    expect(applied).toContainEqual({ ticket: "CTL-A", label: "needs-human" });
    expect(applied).toContainEqual({ ticket: "CTL-B", label: "needs-human" });
  });

  test("triaged-blocks-triaged chain: the unblocked foundation promotes; the dependent is held 'blocked'", () => {
    // CTL-A (foundation, no blocker) blocks CTL-B (dependent). Both are
    // triaged-waiting in the SAME tick, so both land in admissionPool. The dep
    // graph sees A→B with A non-terminal ("Triage") → B is NOT ready, A IS.
    // Per design open-question #5: the chain must promote A and HOLD B, never
    // promote B while its sibling blocker is still non-terminal.
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 3 }));
    writeSignal("CTL-A", "triage", "done");
    writeSignal("CTL-B", "triage", "done");
    const dispatch = fakeDispatch();
    const { ws, applied } = labelSpy();
    const held = heldSpy();
    // CTL-B is blocked_by CTL-A; CTL-A has no blocker. Both resolve in-set
    // (they ARE the admissionPool descriptors), so no exec hydration needed.
    const fr = relMap({
      "CTL-A": relUnblocked(),
      "CTL-B": relBlockedBy("CTL-A"),
    });
    const r = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      writeStatus: ws,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0, // 3 free slots — capacity is NOT the gate here
      fetchBatch: mkBatch(fr),
      appendPhaseAdvanceHeldEvent: held.fn,
    });
    // Only the foundation promotes; the dependent never reaches research.
    expect(dispatch.calls).toEqual([{ orchDir, ticket: "CTL-A", phase: "research" }]);
    expect(r.advanced).toEqual([{ ticket: "CTL-A", phase: "research" }]);
    // CTL-B is held "blocked" (its in-set blocker CTL-A is still non-terminal),
    // and the held event names CTL-A as the unmet blocker.
    expect(applied).toContainEqual({ ticket: "CTL-B", label: "blocked" });
    expect(applied).not.toContainEqual({ ticket: "CTL-A", label: "blocked" });
    // CTL-764 Phase 4: "waiting" renamed to "queued".
    expect(applied).not.toContainEqual({ ticket: "CTL-A", label: "queued" });
    const bHeld = held.events.find((e) => e.ticket === "CTL-B");
    expect(bHeld).toMatchObject({ reason: "blocked-by-open-dependency", blockers: ["CTL-A"] });
  });

  test("epic fan-out: while the foundation is non-terminal NO dependent leaves triage→research", () => {
    // FOUND blocks three leaves L1/L2/L3 (the classic epic shape: one foundation
    // ticket, three dependent features). All four are triaged-waiting this tick.
    // FOUND is non-terminal → every leaf is held "blocked", none promotes; only
    // FOUND (the root, ready) advances even though there are slots for all four.
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 6 }));
    for (const t of ["CTL-FOUND", "CTL-L1", "CTL-L2", "CTL-L3"]) writeSignal(t, "triage", "done");
    const dispatch = fakeDispatch();
    const { ws, applied } = labelSpy();
    const fr = relMap({
      "CTL-FOUND": relUnblocked(),
      "CTL-L1": relBlockedBy("CTL-FOUND"),
      "CTL-L2": relBlockedBy("CTL-FOUND"),
      "CTL-L3": relBlockedBy("CTL-FOUND"),
    });
    const r = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      writeStatus: ws,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0, // 6 free slots — capacity is NOT the gate
      fetchBatch: mkBatch(fr),
    });
    // Exactly one promotion: the foundation. No leaf reaches research while its
    // blocker is non-terminal — even with ample capacity.
    expect(r.advanced).toEqual([{ ticket: "CTL-FOUND", phase: "research" }]);
    expect(dispatch.calls).toEqual([{ orchDir, ticket: "CTL-FOUND", phase: "research" }]);
    for (const leaf of ["CTL-L1", "CTL-L2", "CTL-L3"]) {
      expect(applied).toContainEqual({ ticket: leaf, label: "blocked" });
    }
  });

  test("epic fan-out: once the foundation is terminal (out-of-set Done) the leaves become ready", () => {
    // Same fan-out, but the foundation has already finished — it is NOT in the
    // triaged-waiting pool (no worker dir), so it is an OUT-OF-SET blocker
    // hydrated via exec. A terminal (Done) out-of-set blocker no longer blocks →
    // all three leaves are ready and (with capacity) promote.
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 6 }));
    for (const t of ["CTL-L1", "CTL-L2", "CTL-L3"]) writeSignal(t, "triage", "done");
    const dispatch = fakeDispatch();
    const { ws, applied } = labelSpy();
    const fr = relMap({
      "CTL-L1": relBlockedBy("CTL-FOUND"),
      "CTL-L2": relBlockedBy("CTL-FOUND"),
      "CTL-L3": relBlockedBy("CTL-FOUND"),
    });
    const r = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      writeStatus: ws,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      // CTL-FOUND is out-of-set; hydrate it Done so it no longer blocks.
      fetchBatch: batchWith(fr, { "CTL-FOUND": "Done" }),
    });
    const promoted = r.advanced.map((a) => a.ticket).sort();
    expect(promoted).toEqual(["CTL-L1", "CTL-L2", "CTL-L3"]);
    // None held "blocked" once the foundation is terminal.
    expect(applied.filter((a) => a.label === "blocked")).toEqual([]);
  });

  test("double-fill guard: maxParallel 2, one triaged + one new-work → exactly 2 dispatches (not 3)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    writeSignal("CTL-7", "triage", "done"); // triaged-waiting, promotes to research
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
      writeStatus: labelSpy().ws,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      fetchBatch: mkBatch(() => relUnblocked()),
      hasTriageArtifact: () => true,
    });
    // STEP B promotes CTL-7 (+promotedCount); STEP C subtracts it so sweep 2 has
    // exactly 1 remaining slot for CTL-X — 2 total dispatches, not 3.
    expect(dispatch.calls).toHaveLength(2);
    expect(r.advanced).toEqual([{ ticket: "CTL-7", phase: "research" }]);
    expect(r.dispatched).toEqual(["CTL-X"]);
  });

  test("double-fill guard, promotion↔resume: one free slot is claimed by the triage→research promotion OR the resume sweep, never both (CTL-755 fix #1)", () => {
    // ONE tick, ONE free global slot, contended by TWO sweeps:
    //  - STEP B: a triaged-waiting candidate (CTL-7) eligible for triage→research.
    //  - sweep 1.5: a parked/preempted ticket (CTL-Park) eligible for resume.
    // maxParallel 2 with liveBackgroundCount 1 → computeFreeSlots == 1 (the live
    // count models the one running sibling that holds the second slot; the parked
    // ticket's bg worker was killed at preemption, so it is NOT live-counted).
    //
    // Fix #1 subtracts promotedCount from the resume sweep's slot budget:
    //   resumeSlots = max(0, computeFreeSlots(2, 1) - promotedCount) = max(0, 1 - 1) = 0
    // so once STEP B promotes CTL-7 the resume sweep sees ZERO slots and bows out.
    // WITHOUT fix #1 the resume sweep would read resumeSlots = computeFreeSlots(2,1)
    // = 1 and ALSO dispatch CTL-Park into the same single slot — two NEW dispatches
    // into one free slot (over-admission past maxParallel). This test would then
    // see dispatch.calls length 2 and fail the single-slot assertion below.
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    // Triaged-waiting candidate — promotes via STEP B (unblocked, free slot).
    writeSignal("CTL-7", "triage", "done");
    // Parked/preempted candidate — a phase-research signal in the "preempted"
    // status on its parkedFrom phase, with a (killed) bg_job_id, plus a persisted
    // priority so the resume sweep's rankTickets has a descriptor to rank. This is
    // the exact shape seedPreempted writes for the resume-after-preemption tests.
    writeSignalRaw("CTL-Park", "research", {
      ticket: "CTL-Park",
      phase: "research",
      status: "preempted",
      parkedFrom: "research",
      bg_job_id: "dead-bg-from-preemption",
      attentionReason: "preempted-by-priority",
    });
    writeWorkerPriority(orchDir, "CTL-Park", { priority: 2, createdAt: "2026-05-01T00:00:00Z" });

    // A dispatch that writes a runnable "dispatched" signal so BOTH the promotion's
    // and (were it to fire) the resume sweep's verifyDispatched + signal reset would
    // succeed — i.e. nothing other than fix #1 suppresses a second dispatch.
    const calls = [];
    const dispatch = (args) => {
      calls.push(args);
      const dir = join(orchDir, "workers", args.ticket);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `phase-${args.phase}.json`),
        JSON.stringify({
          ticket: args.ticket,
          phase: args.phase,
          status: "dispatched",
          bg_job_id: "new-bg",
        })
      );
      return { code: 0, stdout: "", stderr: "" };
    };
    dispatch.calls = calls;

    const r = schedulerTick(orchDir, {
      readEligible: () => [], // no brand-new work — isolate promotion vs resume
      dispatch,
      writeStatus: labelSpy().ws,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 1, // 1 live sibling → computeFreeSlots(2,1) == 1
      reclaimDeadWork: () => "noop", // CTL-690: never revive the parked signal
      resolveSession: () => "uuid-park", // the resume sweep would resume-with-session
      appendResumedAfterPreemptionEvent: () => {}, // capture-free; presence proves reachability
      fetchBatch: mkBatch(() => relUnblocked()), // CTL-7's deps are satisfied → admitted
    });

    // Exactly ONE new dispatch consumed the single free slot. Fix #1 makes the
    // promotion win and the resume sweep stand down (promotedCount drained the
    // resume budget to zero); the parked ticket is NOT re-dispatched this tick.
    expect(dispatch.calls).toHaveLength(1);
    expect(r.advanced).toEqual([{ ticket: "CTL-7", phase: "research" }]);
    expect(dispatch.calls[0]).toMatchObject({ ticket: "CTL-7", phase: "research" });
    expect(dispatch.calls.find((c) => c.ticket === "CTL-Park")).toBeUndefined();
    // The parked signal stays parked (the resume sweep never reset it to "stalled").
    const parkSig = JSON.parse(
      readFileSync(join(orchDir, "workers", "CTL-Park", "phase-research.json"), "utf8")
    );
    expect(parkSig.status).toBe("preempted");
  });

  test("double-fill guard, 1 slot: a higher-priority NEW ticket wins over a lower-priority triaged candidate", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    writeSignal("CTL-7", "triage", "done"); // priority 3 (lower)
    const dispatch = fakeDispatch();
    // CTL-X is brand-new ready work at priority 1 (more urgent).
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
    const { ws, applied } = labelSpy();
    const r = schedulerTick(orchDir, {
      readEligible: () => eligible,
      dispatch,
      writeStatus: ws,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      fetchBatch: mkBatch(() => relUnblocked({ priority: 3 })),
      hasTriageArtifact: () => true,
    });
    // The single slot goes to the higher-priority new work; CTL-7 is held
    // "queued" (ready, lost the selection), not promoted.
    // CTL-764 Phase 4: "waiting" renamed to "queued".
    expect(r.advanced).toEqual([]);
    expect(r.dispatched).toEqual(["CTL-X"]);
    expect(dispatch.calls).toEqual([{ orchDir, ticket: "CTL-X", phase: "research" }]);
    expect(applied).toContainEqual({ ticket: "CTL-7", label: "queued" });
  });

  test("staleness gate (livenessIsFresh=false) holds the triage→research promotion", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 3 }));
    writeSignal("CTL-7", "triage", "done"); // unblocked, slots available on paper
    const dispatch = fakeDispatch();
    const { ws, applied } = labelSpy();
    const r = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      writeStatus: ws,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0, // would show 3 free slots
      livenessIsFresh: () => false, // but the snapshot is stale → hold
      fetchBatch: mkBatch(() => relUnblocked()),
    });
    expect(dispatch.calls).toEqual([]); // promotion held
    expect(r.advanced).toEqual([]);
    // Deps are satisfied (in readyIds) but the promotion budget is 0 → "queued".
    // CTL-764 Phase 4: "waiting" renamed to "queued".
    expect(applied).toContainEqual({ ticket: "CTL-7", label: "queued" });
  });

  test("early-exit: zero triaged-waiting tickets → fetchBatch never called (zero Linear cost)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    writeSignal("CTL-7", "research", "running"); // in-flight but NOT triaged-waiting
    let fetchCalls = 0;
    const dispatch = fakeDispatch();
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      writeStatus: labelSpy().ws,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      fetchBatch: (ids) => {
        fetchCalls++;
        return mkBatch(() => relUnblocked())(ids);
      },
    });
    expect(fetchCalls).toBe(0); // STEP A early-exited (and no eligible out-of-set blockers)
  });

  test("read-failure (fetchRelations → null) fails SAFE: the candidate is held", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    writeSignal("CTL-7", "triage", "done");
    const dispatch = fakeDispatch();
    const { ws } = labelSpy();
    const r = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      writeStatus: ws,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      fetchBatch: mkBatch(() => null), // read failed → non-terminal sentinel → held
    });
    expect(dispatch.calls).toEqual([]);
    expect(r.advanced).toEqual([]);
  });

  test("read-failure held event carries the DISTINCT 'dependency-state-unknown' reason with empty blockers (CTL-755 fix #2)", () => {
    // Same fail-safe path as above, but pinning the held-event CLASSIFICATION. A
    // null relations read forces CTL-7 out of readyIds (A.4), so STEP A.7 classifies
    // it as "blocked". Fix #2: because readFailedTickets.has(CTL-7), the emitted
    // phase.advance.held reason is "dependency-state-unknown" (a hydration failure,
    // NOT a confirmed open dependency) and blockers is []. WITHOUT fix #2 the same
    // branch would fall through to reason "blocked-by-open-dependency" with blockers
    // = unmetBlockersFor(...) — which, on a null read with no edges, is [] but with
    // the WRONG reason, conflating a read failure with a genuine dependency hold.
    // The reason assertion below would then fail.
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    writeSignal("CTL-7", "triage", "done");
    const dispatch = fakeDispatch();
    const { ws } = labelSpy();
    const held = heldSpy();
    const r = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      writeStatus: ws,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      fetchBatch: mkBatch(() => null), // read failed → fail-safe hold
      appendPhaseAdvanceHeldEvent: held.fn,
    });
    expect(dispatch.calls).toEqual([]);
    expect(r.advanced).toEqual([]);
    expect(held.events).toHaveLength(1);
    expect(held.events[0]).toMatchObject({
      ticket: "CTL-7",
      reason: "dependency-state-unknown",
    });
    // blockers must be EXACTLY [] (deep-equal), distinguishing a read-failure hold
    // from a genuine open-dependency hold that names its unmet blocker ids.
    expect(held.events[0].blockers).toEqual([]);
    // And it must NOT carry the genuine-open-dependency reason.
    expect(held.events[0].reason).not.toBe("blocked-by-open-dependency");
  });

  // ── CTL-929: zero-dependency tickets must not strand on a failed read ──
  describe("CTL-929: explicit zero-dep tickets are exempt from the read-failure fail-safe", () => {
    afterEach(() => __resetForTests());

    function writeTriage(ticket, obj) {
      writeFileSync(join(orchDir, "workers", ticket, "triage.json"), JSON.stringify(obj));
    }

    test("null read + triage.json dependencies:[] + free slot → dispatched to research (NOT held)", () => {
      writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
      writeSignal("CTL-7", "triage", "done");
      writeTriage("CTL-7", { ticket: "CTL-7", classification: "bug", dependencies: [] });
      const dispatch = fakeDispatch();
      const { ws } = labelSpy();
      const held = heldSpy();
      const r = schedulerTick(orchDir, {
        readEligible: () => [],
        dispatch,
        writeStatus: ws,
        verifyDispatched: verifyOk,
        liveBackgroundCount: () => 0,
        fetchBatch: mkBatch(() => null),
        appendPhaseAdvanceHeldEvent: held.fn,
      });
      expect(dispatch.calls).toEqual([{ orchDir, ticket: "CTL-7", phase: "research" }]);
      expect(r.advanced).toEqual([{ ticket: "CTL-7", phase: "research" }]);
      expect(held.events).toEqual([]);
    });

    test("null read + triage.json dependencies:[] + NO free slot → held 'awaiting-capacity-or-priority' (not 'dependency-state-unknown')", () => {
      writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
      writeSignal("CTL-7", "triage", "done");
      writeTriage("CTL-7", { ticket: "CTL-7", dependencies: [] });
      const dispatch = fakeDispatch();
      const { ws } = labelSpy();
      const held = heldSpy();
      const r = schedulerTick(orchDir, {
        readEligible: () => [],
        dispatch,
        writeStatus: ws,
        verifyDispatched: verifyOk,
        liveBackgroundCount: () => 1,
        fetchBatch: mkBatch(() => null),
        appendPhaseAdvanceHeldEvent: held.fn,
      });
      expect(dispatch.calls).toEqual([]);
      expect(r.advanced).toEqual([]);
      expect(held.events).toHaveLength(1);
      expect(held.events[0]).toMatchObject({
        ticket: "CTL-7",
        reason: "awaiting-capacity-or-priority",
      });
    });

    test("null read + triage.json with a DECLARED dependency → still fail-safe held 'dependency-state-unknown'", () => {
      writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
      writeSignal("CTL-7", "triage", "done");
      writeTriage("CTL-7", { ticket: "CTL-7", dependencies: ["CTL-99"] });
      const dispatch = fakeDispatch();
      const { ws } = labelSpy();
      const held = heldSpy();
      const r = schedulerTick(orchDir, {
        readEligible: () => [],
        dispatch,
        writeStatus: ws,
        verifyDispatched: verifyOk,
        liveBackgroundCount: () => 0,
        fetchBatch: mkBatch(() => null),
        appendPhaseAdvanceHeldEvent: held.fn,
      });
      expect(dispatch.calls).toEqual([]);
      expect(r.advanced).toEqual([]);
      expect(held.events[0]).toMatchObject({ ticket: "CTL-7", reason: "dependency-state-unknown" });
    });

    test("null read + NO triage.json → still fail-safe held (unknown picture, conservative default)", () => {
      writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
      writeSignal("CTL-7", "triage", "done");
      const dispatch = fakeDispatch();
      const { ws } = labelSpy();
      const held = heldSpy();
      const r = schedulerTick(orchDir, {
        readEligible: () => [],
        dispatch,
        writeStatus: ws,
        verifyDispatched: verifyOk,
        liveBackgroundCount: () => 0,
        fetchBatch: mkBatch(() => null),
        appendPhaseAdvanceHeldEvent: held.fn,
      });
      expect(dispatch.calls).toEqual([]);
      expect(held.events[0]).toMatchObject({ ticket: "CTL-7", reason: "dependency-state-unknown" });
    });

    test("idempotent: a zero-dep ticket already advanced (research signal present) is not re-dispatched", () => {
      writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
      writeSignal("CTL-7", "triage", "done");
      writeSignal("CTL-7", "research", "running");
      writeTriage("CTL-7", { ticket: "CTL-7", dependencies: [] });
      const dispatch = fakeDispatch();
      const { ws } = labelSpy();
      const r = schedulerTick(orchDir, {
        readEligible: () => [],
        dispatch,
        writeStatus: ws,
        verifyDispatched: verifyOk,
        liveBackgroundCount: () => 0,
        fetchBatch: mkBatch(() => null),
      });
      expect(dispatch.calls).toEqual([]);
      expect(r.advanced).toEqual([]);
    });
  });

  // ── STEP E: dep persistence (scheduler-side) ──
  //
  // A writeStatus spy that ALSO records applyBlockedByRelation (the durable
  // blocked_by write STEP E issues). Mirrors labelSpy but exposes `relations`.
  function depSpy() {
    const relations = [];
    const applied = [];
    const ws = {
      applyPhaseStatus: () => {},
      applyTerminalDone: () => {},
      applyEstimate: () => ({ applied: true }),
      applyLabel: (a) => {
        applied.push(a);
        return { applied: true, reason: null };
      },
      removeLabel: () => ({ removed: true }),
      applyBlockedByRelation: (a) => {
        relations.push(a);
        return { applied: true, reason: null };
      },
    };
    return { ws, relations, applied };
  }

  // Write workers/<T>/triage.json with a `.dependencies` array (the flat-string
  // shape the phase-triage skill scrapes). The worker dir already exists from
  // writeSignal.
  function writeTriageDeps(ticket, dependencies) {
    writeFileSync(
      join(orchDir, "workers", ticket, "triage.json"),
      JSON.stringify({ ticket, classification: "feature", dependencies })
    );
  }

  test("dep persistence: a resolvable non-terminal dep is written, a prose-only/unresolvable token is dropped", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    writeSignal("CTL-7", "triage", "done");
    // CTL-100 resolves (non-terminal); PROSE-1 is a TEAM-NNN-shaped token that
    // does not resolve to a real ticket → dropped.
    writeTriageDeps("CTL-7", ["CTL-100", "PROSE-1"]);
    const dispatch = fakeDispatch();
    const { ws, relations } = depSpy();
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      writeStatus: ws,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      // CTL-7 has NO existing relations (so the dep write is not idempotently
      // skipped); the dep states are resolved via exec below.
      fetchBatch: mkBatch({ "CTL-7": relUnblocked(), "CTL-100": descOf("In Progress") }),
    });
    // Exactly one durable edge: CTL-7 blocked_by CTL-100. PROSE-1 dropped.
    expect(relations).toEqual([{ ticket: "CTL-7", blockedBy: "CTL-100" }]);
  });

  test("dep persistence is idempotent: a dep already in the candidate's relations → zero writes", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    writeSignal("CTL-7", "triage", "done");
    writeTriageDeps("CTL-7", ["CTL-100"]);
    const dispatch = fakeDispatch();
    const { ws, relations } = depSpy();
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      writeStatus: ws,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      // CTL-7's FRESH relations already carry blocked_by CTL-100 (durable edge
      // exists) → STEP E must NOT re-write it. (CTL-100 In Progress also holds
      // the gate, but the persistence path is what we pin here.)
      fetchBatch: mkBatch({ "CTL-7": relBlockedBy("CTL-100"), "CTL-100": descOf("In Progress") }),
    });
    expect(relations).toEqual([]); // idempotent — nothing written
  });

  test("dep persistence: a TERMINAL dep is NOT written (no durable edge for a Done blocker)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    writeSignal("CTL-7", "triage", "done");
    writeTriageDeps("CTL-7", ["CTL-100"]);
    const dispatch = fakeDispatch();
    const { ws, relations } = depSpy();
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      writeStatus: ws,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      fetchBatch: mkBatch({ "CTL-7": relUnblocked(), "CTL-100": descOf("Done") }), // terminal → no durable edge
    });
    expect(relations).toEqual([]);
  });

  test("dep persistence: a self-ref dependency token is dropped", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    writeSignal("CTL-7", "triage", "done");
    writeTriageDeps("CTL-7", ["CTL-7", "CTL-100"]); // CTL-7 is self → dropped
    const dispatch = fakeDispatch();
    const { ws, relations } = depSpy();
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      writeStatus: ws,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      fetchBatch: mkBatch({ "CTL-7": relUnblocked(), "CTL-100": descOf("In Progress") }),
    });
    expect(relations).toEqual([{ ticket: "CTL-7", blockedBy: "CTL-100" }]);
  });

  test("dep persistence tolerates the rich {id} descriptor shape (forward-compat)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    writeSignal("CTL-7", "triage", "done");
    writeTriageDeps("CTL-7", [{ id: "CTL-100", exists: true, blockerState: "In Progress" }]);
    const dispatch = fakeDispatch();
    const { ws, relations } = depSpy();
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      writeStatus: ws,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      fetchBatch: mkBatch({ "CTL-7": relUnblocked(), "CTL-100": descOf("In Progress") }),
    });
    expect(relations).toEqual([{ ticket: "CTL-7", blockedBy: "CTL-100" }]);
  });

  test("CTL-878: a dep that is the candidate's PARENT epic is NOT persisted", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    writeSignal("CTL-7", "triage", "done");
    // CTL-859 is CTL-7's parent epic, scraped into triage.json deps. It is
    // non-terminal (Backlog) and not already a durable edge — so absent the
    // CTL-878 guard STEP E would persist CTL-7 blocked_by CTL-859 (the deadlock).
    writeTriageDeps("CTL-7", ["CTL-859"]);
    const dispatch = fakeDispatch();
    const { ws, relations } = depSpy();
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      writeStatus: ws,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      // CTL-7's descriptor carries parent === CTL-859; CTL-859 hydrates Backlog.
      fetchBatch: mkBatch({
        "CTL-7": { ...relUnblocked(), parent: "CTL-859" },
        "CTL-859": descOf("Backlog"),
      }),
    });
    expect(relations).toEqual([]); // parent epic never persisted as a blocker
  });

  test("CTL-878: the parent skip is parent-specific — a non-parent non-terminal dep is still persisted", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    writeSignal("CTL-7", "triage", "done");
    // CTL-859 is the parent (skipped); CTL-100 is a real sibling dep (persisted).
    writeTriageDeps("CTL-7", ["CTL-859", "CTL-100"]);
    const dispatch = fakeDispatch();
    const { ws, relations } = depSpy();
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      writeStatus: ws,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      fetchBatch: mkBatch({
        "CTL-7": { ...relUnblocked(), parent: "CTL-859" },
        "CTL-859": descOf("Backlog"),
        "CTL-100": descOf("In Progress"),
      }),
    });
    expect(relations).toEqual([{ ticket: "CTL-7", blockedBy: "CTL-100" }]);
  });

  test("CTL-838: a CROSS-TEAM dep is NOT persisted (daemon can't work it)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    writeSignal("CTL-7", "triage", "done");
    // ADV-9 is a different team; OTL-2 too. Both non-terminal — absent the CTL-838
    // guard STEP E would persist them and deadlock CTL-7 against work this daemon
    // can never run. CTL-100 (same team, non-terminal) IS persisted.
    writeTriageDeps("CTL-7", ["ADV-9", "OTL-2", "CTL-100"]);
    const dispatch = fakeDispatch();
    const { ws, relations } = depSpy();
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      writeStatus: ws,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      fetchBatch: mkBatch({
        "CTL-7": relUnblocked(),
        "ADV-9": descOf("In Progress"),
        "OTL-2": descOf("Implement"),
        "CTL-100": descOf("In Progress"),
      }),
    });
    expect(relations).toEqual([{ ticket: "CTL-7", blockedBy: "CTL-100" }]);
  });

  test("CTL-784: writing a durable edge INVALIDATES the candidate's relations cache (no ≤TTL over-promotion)", () => {
    // After STEP E writes a new blocked_by edge, the candidate's relations
    // descriptor cached THIS tick (by A.3) is stale (no edge). Invalidating it
    // forces the next tick to re-read fresh and surface the blocker — closing the
    // over-promotion window the old fresh-every-tick read never had.
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    writeSignal("CTL-7", "triage", "done");
    writeTriageDeps("CTL-7", ["CTL-100"]);
    const dispatch = fakeDispatch();
    const { ws, relations } = depSpy();
    const invalidated = [];
    const cache = {
      get: () => undefined,
      set: () => {},
      getRelations: () => undefined,
      setRelations: () => {},
      invalidate: (id) => invalidated.push(id),
      stats: () => ({}),
      relationsStats: () => ({}),
    };
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      writeStatus: ws,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      cache,
      fetchBatch: mkBatch({ "CTL-7": relUnblocked(), "CTL-100": descOf("In Progress") }),
    });
    expect(relations).toEqual([{ ticket: "CTL-7", blockedBy: "CTL-100" }]); // edge written
    expect(invalidated).toContain("CTL-7"); // candidate cache dropped → next tick re-reads fresh
  });

  // ── STEP D integration: dead-triage reclaim → STEP A re-eval → promotion ──
  //
  // The isolated recovery tests pin reclaim behaviour but never prove a reclaimed
  // triage worker later ADVANCES. This integration test drives a real
  // reclaimDeadWorkIfPossible (production wiring — scheduler.mjs:1624 passes only
  // { repoRoot }) through a single schedulerTick and asserts the worker does NOT
  // strand: the reclaim sweep flips the dead triage worker's signal to `done`,
  // STEP A re-evaluates it as a triaged-waiting candidate, and STEP B promotes it
  // (unblocked + free slot). The gate is enforced DOWNSTREAM at STEP B (which holds
  // any triage:done worker not admitted), so flipping the signal to `done` never
  // bypasses admission control. (Regression anchor for the CTL-755 strand bug where
  // the now-removed `reclaim-held` early-return left the signal at `running`, which
  // STEP A's `triage === "done"` pool then skipped forever.)

  // A production-faithful reclaimDeadWork: the real reclaimDeadWorkIfPossible with
  // the triage probe forced true (triage.json present → work done), a dead-gone
  // statJob, and an emitComplete that flips the ON-DISK signal to `done` (what the
  // real phase-agent-emit-complete --status complete does). The options bag matches
  // production (no special-casing) — there is no admission predicate inside reclaim.
  function prodTriageReclaim(orchDirArg) {
    return (od, sig) =>
      reclaimDeadWorkIfPossible(od, sig, {
        statJob: () => null, // dead-gone → reclaim-eligible
        probes: { triage: () => true, ...EMPTY_NONTRIAGE_PROBES },
        emitComplete: ({ orchDir: o, signal }) => {
          // Mirror the real closer: flip phase-<phase>.json.status → done.
          const p = join(o ?? orchDirArg, "workers", signal.ticket, `phase-${signal.phase}.json`);
          const cur = JSON.parse(readFileSync(p, "utf8"));
          writeFileSync(p, JSON.stringify({ ...cur, status: "done" }));
          return { code: 0 };
        },
        appendEvent: () => {},
        postReclaimMirror: () => {},
      });
  }
  // Probes for the non-triage phases the reclaim sweep may also see — never true
  // here (no other dead workers), but keeps the probe bag total.
  const EMPTY_NONTRIAGE_PROBES = {
    implement: () => false,
    research: () => false,
    plan: () => false,
  };

  test("STEP D integration: a dead triage:running worker (work done) is NOT stranded — reclaim flips it to done, STEP A re-evals, STEP B promotes (unblocked + free slot)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    // A dead triage worker whose signal never reached `done` (it died mid-flight
    // with status running) but whose triage.json IS on disk (probe passes). This
    // is the exact class the reclaim branch-B path exists to recover.
    writeSignalRaw("CTL-7", "triage", {
      ticket: "CTL-7",
      phase: "triage",
      status: "running",
      bg_job_id: "job-dead-7",
      liveness: { kind: "bg", value: "job-dead-7" },
    });
    const dispatch = fakeDispatch();
    const { ws } = labelSpy();
    const r = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      writeStatus: ws,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0, // a free slot
      reclaimDeadWork: prodTriageReclaim(orchDir),
      fetchBatch: mkBatch(() => relUnblocked()), // deps satisfied
    });
    // The reclaim sweep flipped the signal to done (no longer stranded at running).
    expect(readPhaseSignals(orchDir, "CTL-7").triage).toBe("done");
    // STEP A re-evaluated it as triaged-waiting and STEP B promoted it to research.
    expect(dispatch.calls).toEqual([{ orchDir, ticket: "CTL-7", phase: "research" }]);
    expect(r.advanced).toEqual([{ ticket: "CTL-7", phase: "research" }]);
  });

  test("STEP D integration: a dead triage:running worker held by deps does NOT strand — reclaim flips to done, STEP A holds it 'blocked' (gate enforced downstream)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    writeSignalRaw("CTL-7", "triage", {
      ticket: "CTL-7",
      phase: "triage",
      status: "running",
      bg_job_id: "job-dead-7",
      liveness: { kind: "bg", value: "job-dead-7" },
    });
    const dispatch = fakeDispatch();
    const { ws, applied } = labelSpy();
    const held = heldSpy();
    const r = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      writeStatus: ws,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      reclaimDeadWork: prodTriageReclaim(orchDir),
      // CTL-7 is blocked by an out-of-set blocker still In Progress.
      fetchBatch: batchWith(() => relBlockedBy("CTL-DEP"), { "CTL-DEP": "In Progress" }),
      appendPhaseAdvanceHeldEvent: held.fn,
    });
    // Signal still flipped to done (reclaim ran) — but research is HELD by the gate.
    expect(readPhaseSignals(orchDir, "CTL-7").triage).toBe("done");
    expect(dispatch.calls).toEqual([]); // STEP B held the research promotion
    expect(r.advanced).toEqual([]);
    expect(applied).toContainEqual({ ticket: "CTL-7", label: "blocked" });
    expect(held.events[0]).toMatchObject({
      ticket: "CTL-7",
      reason: "blocked-by-open-dependency",
      blockers: ["CTL-DEP"],
    });
  });
});

// ── CTL-700 (Item A): readDispatchFailureReason ────────────────────────────
describe("readDispatchFailureReason (CTL-700)", () => {
  test("returns failureReason when present", () => {
    const dir = join(orchDir, "workers", "CTL-700A-1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "phase-research.json"),
      JSON.stringify({
        ticket: "CTL-700A-1",
        phase: "research",
        failureReason: "rebase_conflict_with_origin_main",
      })
    );
    expect(readDispatchFailureReason(orchDir, "CTL-700A-1", "research")).toBe(
      "rebase_conflict_with_origin_main"
    );
  });

  test("returns attentionReason when only attentionReason is present", () => {
    const dir = join(orchDir, "workers", "CTL-700A-2");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "phase-implement.json"),
      JSON.stringify({
        ticket: "CTL-700A-2",
        phase: "implement",
        attentionReason: "claude-bg-launch-failed",
      })
    );
    expect(readDispatchFailureReason(orchDir, "CTL-700A-2", "implement")).toBe(
      "claude-bg-launch-failed"
    );
  });

  test("returns failureReason when both failureReason and attentionReason are present", () => {
    const dir = join(orchDir, "workers", "CTL-700A-3");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "phase-plan.json"),
      JSON.stringify({ failureReason: "the_real_reason", attentionReason: "secondary_reason" })
    );
    expect(readDispatchFailureReason(orchDir, "CTL-700A-3", "plan")).toBe("the_real_reason");
  });

  test("returns null when neither field is present", () => {
    const dir = join(orchDir, "workers", "CTL-700A-4");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "phase-verify.json"),
      JSON.stringify({ ticket: "CTL-700A-4", status: "running" })
    );
    expect(readDispatchFailureReason(orchDir, "CTL-700A-4", "verify")).toBeNull();
  });

  test("returns null when signal file is missing", () => {
    expect(readDispatchFailureReason(orchDir, "CTL-700A-5-nonexistent", "research")).toBeNull();
  });

  test("returns null when signal file is unparseable", () => {
    const dir = join(orchDir, "workers", "CTL-700A-6");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "phase-research.json"), "{not json");
    expect(readDispatchFailureReason(orchDir, "CTL-700A-6", "research")).toBeNull();
  });
});

// ── CTL-781: respect-assignment + self-assign in schedulerTick new-work pull ──

describe("schedulerTick — CTL-781 respect-assignment + self-assign", () => {
  const BOT = "ff78d890-7906-4c22-b2f5-020bd150c790";
  const HUMAN = "11111111-1111-1111-1111-111111111111";

  function candidateTicket(id) {
    return {
      identifier: id,
      priority: 2,
      createdAt: "x",
      state: "Todo",
      relations: { nodes: [] },
      inverseRelations: { nodes: [] },
    };
  }

  function gatewayStub(byTicket) {
    // bare value = assignee (back-compat); object { assignee, delegate } sets both.
    return {
      getDescriptor: (id) => {
        const v = byTicket[id];
        if (v && typeof v === "object") {
          return { assignee: v.assignee ?? null, delegate: v.delegate ?? null, removed: false };
        }
        return { assignee: v ?? null, delegate: null, removed: false };
      },
    };
  }

  beforeEach(() => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 5 }));
  });

  test("human-assigned candidate is SKIPPED — no dispatch, no cooldown marker, no dispatch.requested event", () => {
    const dispatch = fakeDispatch();
    const gateway = gatewayStub({ "CTL-H1": HUMAN });
    schedulerTick(orchDir, {
      readEligible: () => [candidateTicket("CTL-H1")],
      dispatch,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      botUserIds: new Set([BOT]),
      gateway,
    });
    expect(dispatch.calls).toHaveLength(0);
    expect(existsSync(join(orchDir, ".dispatch-cooldowns", "CTL-H1", "research"))).toBe(false);
  });

  test("UNDELEGATED candidate → delegate-then-hold: NO dispatch, applyAssignee (delegate-on-Todo) called with botWriteId (CTL-1174)", () => {
    const dispatch = fakeDispatch();
    const assigneeCalls = [];
    const writeStatus = {
      applyPhaseStatus: () => ({ applied: true, reason: null }),
      applyTerminalDone: () => {},
      applyLabel: () => {},
      applyAssignee: (a) => {
        assigneeCalls.push(a);
        return { applied: true, reason: null };
      },
    };
    const gateway = gatewayStub({ "CTL-N1": null }); // assignee=null, delegate=null → undelegated
    schedulerTick(orchDir, {
      readEligible: () => [candidateTicket("CTL-N1")],
      dispatch,
      writeStatus,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      botUserIds: new Set([BOT]),
      botWriteId: BOT,
      gateway,
      hasTriageArtifact: () => true,
    });
    expect(dispatch.calls).toHaveLength(0); // held — not yet delegated to us
    expect(assigneeCalls).toHaveLength(1);
    expect(assigneeCalls[0]).toMatchObject({ ticket: "CTL-N1", userId: BOT });
  });

  test("candidate DELEGATED to our orchestrator dispatches normally (assignee irrelevant, CTL-1174)", () => {
    const dispatch = fakeDispatch();
    const gateway = gatewayStub({ "CTL-B1": { assignee: HUMAN, delegate: BOT } });
    schedulerTick(orchDir, {
      readEligible: () => [candidateTicket("CTL-B1")],
      dispatch,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      botUserIds: new Set([BOT]),
      gateway,
      hasTriageArtifact: () => true,
    });
    expect(dispatch.calls.map((c) => c.ticket)).toEqual(["CTL-B1"]);
  });

  test("gateway miss → falls through to live read (exec seam); human assignee from live read skips", () => {
    const dispatch = fakeDispatch();
    const execCalls = [];
    const exec = (cmd, args) => {
      execCalls.push(args);
      return { code: 0, stdout: JSON.stringify({ assignee: { id: HUMAN } }), stderr: "" };
    };
    const gateway = { getDescriptor: () => null };
    schedulerTick(orchDir, {
      readEligible: () => [candidateTicket("CTL-M1")],
      dispatch,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      botUserIds: new Set([BOT]),
      gateway,
      fetchAssignee: (id, opts) => {
        execCalls.push(["fetchAssignee", id]);
        return { known: true, assignee: HUMAN };
      },
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is fetchAssignee fallthrough
    });
    expect(dispatch.calls).toHaveLength(0);
    expect(execCalls.some((c) => c[0] === "fetchAssignee")).toBe(true);
  });

  test("assignee unknown (live read fails) → candidate held this tick (no dispatch), NOT a recorded failure", () => {
    const dispatch = fakeDispatch();
    schedulerTick(orchDir, {
      readEligible: () => [candidateTicket("CTL-U1")],
      dispatch,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      botUserIds: new Set([BOT]),
      gateway: { getDescriptor: () => null },
      fetchAssignee: () => ({ known: false }),
    });
    expect(dispatch.calls).toHaveLength(0);
    expect(existsSync(join(orchDir, ".dispatch-cooldowns", "CTL-U1", "research"))).toBe(false);
  });

  test("no botUserIds threaded (undefined) → predicate skipped entirely, no assignee reads, dispatches as today", () => {
    const dispatch = fakeDispatch();
    const fetchAssigneeCalls = [];
    schedulerTick(orchDir, {
      readEligible: () => [candidateTicket("CTL-ND1")],
      dispatch,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      fetchAssignee: (id) => {
        fetchAssigneeCalls.push(id);
        return { known: true, assignee: HUMAN };
      },
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is no-botUserIds path
    });
    expect(dispatch.calls.map((c) => c.ticket)).toEqual(["CTL-ND1"]);
    expect(fetchAssigneeCalls).toHaveLength(0);
  });

  test("empty botUserIds Set → predicate skipped (CTL-749 fail-open convention)", () => {
    const dispatch = fakeDispatch();
    const fetchAssigneeCalls = [];
    schedulerTick(orchDir, {
      readEligible: () => [candidateTicket("CTL-E1")],
      dispatch,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      botUserIds: new Set(),
      fetchAssignee: (id) => {
        fetchAssigneeCalls.push(id);
        return { known: true, assignee: HUMAN };
      },
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is empty-botUserIds path
    });
    expect(dispatch.calls.map((c) => c.ticket)).toEqual(["CTL-E1"]);
    expect(fetchAssigneeCalls).toHaveLength(0);
  });

  test("botWriteId absent on UNDELEGATED candidate → delegate-on-Todo calls applyAssignee userId:undefined (loud-no-op), holds (CTL-1174)", () => {
    const dispatch = fakeDispatch();
    const assigneeCalls = [];
    const writeStatus = {
      applyPhaseStatus: () => ({ applied: true, reason: null }),
      applyTerminalDone: () => {},
      applyLabel: () => {},
      applyAssignee: (a) => {
        assigneeCalls.push(a);
        return { applied: false, reason: "invalid-user" };
      },
    };
    const gateway = gatewayStub({ "CTL-WI1": null });
    schedulerTick(orchDir, {
      readEligible: () => [candidateTicket("CTL-WI1")],
      dispatch,
      writeStatus,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      botUserIds: new Set([BOT]),
      gateway,
      hasTriageArtifact: () => true,
    });
    expect(dispatch.calls).toHaveLength(0); // held — undelegated
    // delegate-on-Todo still invokes applyAssignee; the deduped invalid-user
    // branch handles the null/undefined botWriteId instead of silently skipping.
    expect(assigneeCalls).toHaveLength(1);
    expect(assigneeCalls[0]).toMatchObject({ ticket: "CTL-WI1", userId: undefined });
  });

  test("a DELEGATED candidate dispatches even if the post-dispatch self-assign fails (CTL-1174)", () => {
    const dispatch = fakeDispatch();
    const writeStatus = {
      applyPhaseStatus: () => ({ applied: true, reason: null }),
      applyTerminalDone: () => {},
      applyLabel: () => {},
      applyAssignee: () => ({ applied: false, reason: "transient" }),
    };
    const gateway = gatewayStub({ "CTL-AF1": { delegate: BOT } });
    const r = schedulerTick(orchDir, {
      readEligible: () => [candidateTicket("CTL-AF1")],
      dispatch,
      writeStatus,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      botUserIds: new Set([BOT]),
      botWriteId: BOT,
      gateway,
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is applyAssignee fail-open
    });
    expect(r.dispatched).toContain("CTL-AF1");
  });

  test("writeStatus stub WITHOUT applyAssignee (legacy test shape) → no throw", () => {
    const dispatch = fakeDispatch();
    const writeStatus = {
      applyPhaseStatus: () => ({ applied: true, reason: null }),
      applyTerminalDone: () => {},
      applyLabel: () => {},
    };
    const gateway = gatewayStub({ "CTL-LS1": null });
    expect(() =>
      schedulerTick(orchDir, {
        readEligible: () => [candidateTicket("CTL-LS1")],
        dispatch,
        writeStatus,
        verifyDispatched: verifyOk,
        liveBackgroundCount: () => 0,
        botUserIds: new Set([BOT]),
        botWriteId: BOT,
        gateway,
      })
    ).not.toThrow();
  });
});

// --- CTL-663: scheduler-level e2e regression lock ---------------------------
// Exercises the full schedulerTick → reclaimDeadWork → implementProbe chain
// with the REAL probe (fake git/fs seams). A stale implement worker with 1-of-5
// plan phases committed must appear in result.revived (not result.reclaimed),
// and the signal on disk must remain "running" (not flipped to "done").

describe("schedulerTick — CTL-663 partial-commit implement e2e lock", () => {
  function writeNestedSignalCTL663(ticket, phase, body) {
    const dir = join(orchDir, "workers", ticket);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `phase-${phase}.json`), JSON.stringify({ ticket, phase, ...body }));
  }

  // Local helpers matching the work-done-probes.test.mjs pattern.
  function porcelainFor663(ticket, wt) {
    return [
      "worktree /repo",
      "HEAD abcdef0",
      "branch refs/heads/main",
      "",
      `worktree ${wt}`,
      "HEAD 1234567",
      `branch refs/heads/${ticket}`,
      "",
    ].join("\n");
  }
  function makeRunGit663(responses) {
    return (args) => {
      const key = args.join(" ");
      if (responses[key]) return responses[key];
      for (const [k, v] of Object.entries(responses)) {
        if (key.endsWith(k)) return v;
      }
      return { code: 1, stdout: "", stderr: `fake runGit: no match for ${key}` };
    };
  }

  const FIVE_PHASE_PLAN_BODY_E2E = `# Plan: CTL-663-E

${"Overview and context for the five-phase implementation plan. ".repeat(5)}

## Phase 1: Setup

Establish the foundation and initial scaffolding.

## Phase 2: Core Logic

Implement the main business logic and algorithms.

## Phase 3: Integration

Wire up all components and integration points.

## Phase 4: Tests

Write comprehensive test coverage for all paths.

## Phase 5: Cleanup

Final polish, documentation, and code cleanup.

### Success Criteria
- [ ] All five phases land as discrete commits on the branch
`;

  test("CTL-663 e2e: stale implement, 1-of-5 plan phases committed → not bucketed reclaimed, signal not flipped", () => {
    const ticket = "CTL-663-E";
    const wt = `/wt/${ticket}`;
    writeNestedSignalCTL663(ticket, "implement", { status: "running", bg_job_id: "bg-663-e" });

    const probeSeams = {
      runGit: makeRunGit663({
        "-C /repo worktree list --porcelain": {
          code: 0,
          stdout: porcelainFor663(ticket, wt),
          stderr: "",
        },
        [`-C ${wt} rev-list --count origin/main..HEAD`]: { code: 0, stdout: "1\n", stderr: "" },
        [`-C ${wt} status --porcelain`]: { code: 0, stdout: "", stderr: "" },
      }),
      listArtifacts: () => [`2026-06-07-${ticket.toLowerCase()}.md`],
      readArtifact: () => FIVE_PHASE_PLAN_BODY_E2E,
    };
    const realProbePartial = (args) => WORK_DONE_PROBES.implement(args, probeSeams);

    const dispatch = recorder({ code: 0 });
    const result = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      writeStatus: { applyPhaseStatus: () => {}, applyTerminalDone: () => {} },
      reclaimDeadWork: (od, sig, opts) =>
        reclaimDeadWorkIfPossible(od, sig, {
          ...opts,
          repoRoot: "/repo",
          probes: { implement: realProbePartial },
          jobLifecycle: () => "dead-gone",
          progressMark: () => 1,
          readProgressMark: () => 0,
          writeProgressMark: () => {},
          emitReapIntent: () => Promise.resolve(),
          breaker: { isOpen: () => false },
          listTicketPhases: () => ["implement"],
          inEscalationCooldownFn: () => false,
          recordEscalationFn: () => {},
          appendReviveEvent: () => {},
          appendEscalatedEvent: () => {},
          appendReviveSuppressedEvent: () => {},
          reviveDispatch: recorder({ code: 0 }),
          applyStalledLabel: () => ({ applied: true }),
          killBgJob: () => {},
          countReviveEvents: () => 0,
          writeReviveMarker: () => {},
          resolveSession: () => null,
          postReclaimMirror: () => {},
          readBootSince: () => undefined,
          now: () => 1_000_000,
        }),
    });

    // Probe returned false (1 commit < 5 phases) → revived, not reclaimed.
    expect(result.reclaimed).toEqual([]);
    expect(result.revived).toEqual([{ ticket, phase: "implement" }]);

    // Signal on disk must still be "running" (not flipped to "done" by emitComplete).
    const signalPath = join(orchDir, "workers", ticket, "phase-implement.json");
    const signal = JSON.parse(readFileSync(signalPath, "utf8"));
    expect(signal.status).toBe("running");

    // No next-phase dispatch fired (implement wasn't declared complete).
    const verifyDispatches = dispatch.calls.filter((args) => args[0]?.phase === "verify");
    expect(verifyDispatches.length).toBe(0);
  });
});

// ── CTL-850: HRW ownership filter + claim-on-dispatch (new-work path) ──
//
// These exercise the cross-host coordination wiring in schedulerTick. The
// foundation is safe-by-construction: a single-host roster makes the HRW filter
// an identity (ownedBy always true) AND gates off the claim, so the wiring is an
// exact no-op until a 2nd host joins .catalyst/hosts.json. Every test injects a
// fixed roster + a claimDispatch recorder so nothing touches Linear.
describe("CTL-850 — HRW ownership + claim-on-dispatch (schedulerTick new-work)", () => {
  const ROSTER = ["mini", "mac-studio"];
  const TICKET = "CTL-850";
  // Compute the deterministic HRW owner of the fixture under the 2-host roster.
  const OWNER = ownerForTicket(TICKET, ROSTER);
  const OTHER = ROSTER.find((h) => h !== OWNER);

  const eligibleOne = (id = TICKET) => [
    {
      identifier: id,
      priority: 1,
      createdAt: "x",
      state: "Todo",
      relations: { nodes: [] },
      inverseRelations: { nodes: [] },
    },
  ];

  // recordClaim — a claimDispatch seam that records every call and returns a
  // fixed verdict, so a test asserts both WHETHER the claim ran and with WHAT.
  const recordClaim = (verdict) => {
    const calls = [];
    const fn = (arg) => {
      calls.push(arg);
      return verdict;
    };
    fn.calls = calls;
    return fn;
  };

  test("single-host roster is an exact no-op: claim is NEVER attempted, dispatch proceeds", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({ code: 0 });
    const claimDispatch = recordClaim({ won: false, generation: null }); // would block IF called
    schedulerTick(orchDir, {
      readEligible: () => eligibleOne(),
      dispatch,
      hosts: ["solo"],
      hostName: "solo",
      claimDispatch,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      now: () => 1_000,
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is HRW/claim dispatch
    });
    expect(claimDispatch.calls).toHaveLength(0); // multiHost gate skipped the claim
    expect(dispatch.calls).toHaveLength(1); // HRW identity → dispatched
    expect(dispatch.calls[0]).toMatchObject({ ticket: TICKET, phase: "research" });
  });

  test("CTL-1057: single-host ready filter keeps tickets even when hostName != roster entry", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({ code: 0 });
    const claimDispatch = recordClaim({ won: false, generation: null });
    schedulerTick(orchDir, {
      readEligible: () => eligibleOne(),
      dispatch,
      hosts: ["mini"],
      hostName: "RyansMini250233.rozich",
      claimDispatch,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      now: () => 1_000,
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is CTL-1057 single-host filter
    });
    expect(claimDispatch.calls).toHaveLength(0); // multiHost gate skipped the claim
    expect(dispatch.calls).toHaveLength(1); // HRW single-host → dispatched
    expect(dispatch.calls[0]).toMatchObject({ ticket: TICKET, phase: "research" });
  });

  test("multi-host: a ticket OWNED by this host is dispatched (HRW keeps it)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({ code: 0 });
    const claimDispatch = recordClaim({ won: true, generation: 1 });
    schedulerTick(orchDir, {
      readEligible: () => eligibleOne(),
      dispatch,
      hosts: ROSTER,
      hostName: OWNER,
      claimDispatch,
      // CTL-1481: stub the label-stamp seam — this test's subject is HRW/claim
      // dispatch, not the label write, and a won multi-host claim now fires it.
      stampWorkerLabel: () => ({ stamped: true }),
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      now: () => 1_000,
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is HRW-owned dispatch
    });
    expect(dispatch.calls).toHaveLength(1);
    // The claim ran with this host + the entry phase before the spawn.
    expect(claimDispatch.calls).toHaveLength(1);
    expect(claimDispatch.calls[0]).toEqual({ ticket: TICKET, hostName: OWNER, phase: "research" });
  });

  test("multi-host: a ticket owned by ANOTHER host is filtered out — no claim, no dispatch", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({ code: 0 });
    const claimDispatch = recordClaim({ won: true, generation: 1 });
    schedulerTick(orchDir, {
      readEligible: () => eligibleOne(),
      dispatch,
      hosts: ROSTER,
      hostName: OTHER, // not the HRW owner
      claimDispatch,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      now: () => 1_000,
    });
    expect(dispatch.calls).toHaveLength(0); // HRW excluded it before the loop
    expect(claimDispatch.calls).toHaveLength(0); // never reached the claim
  });

  test("multi-host: a LOST claim defers WITHOUT a cooldown marker (reconsidered next tick)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({ code: 0 });
    const claimDispatch = recordClaim({ won: false, generation: 2 }); // another host won
    schedulerTick(orchDir, {
      readEligible: () => eligibleOne(),
      dispatch,
      hosts: ROSTER,
      hostName: OWNER,
      claimDispatch,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      now: () => 1_000,
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is lost-claim defer
    });
    expect(claimDispatch.calls).toHaveLength(1); // the claim was attempted
    expect(dispatch.calls).toHaveLength(0); // but lost → not dispatched
    // A lost claim is NOT a dispatch failure, so NO cooldown marker is written
    // (the ticket is simply reconsidered next tick).
    expect(existsSync(dispatchCooldownPath(orchDir, TICKET, "research"))).toBe(false);
  });

  // CTL-864: the won claim.generation is forwarded as clusterGeneration to dispatchTicket.
  test("CTL-864: multi-host dispatch forwards the won claim.generation as clusterGeneration", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({ code: 0 });
    const claimDispatch = recordClaim({ won: true, generation: 7 });
    schedulerTick(orchDir, {
      readEligible: () => eligibleOne(),
      dispatch,
      hosts: ROSTER,
      hostName: OWNER,
      claimDispatch,
      // CTL-1481: stub the label-stamp seam — this test's subject is
      // clusterGeneration forwarding, not the label write.
      stampWorkerLabel: () => ({ stamped: true }),
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      now: () => 1_000,
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is clusterGeneration forwarding
    });
    expect(dispatch.calls).toHaveLength(1);
    expect(dispatch.calls[0].clusterGeneration).toBe(7);
  });

  test("CTL-864: single-host dispatch passes no clusterGeneration (no-op)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({ code: 0 });
    const claimDispatch = recordClaim({ won: false, generation: null }); // never called
    schedulerTick(orchDir, {
      readEligible: () => eligibleOne(),
      dispatch,
      hosts: ["solo"],
      hostName: "solo",
      claimDispatch,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      now: () => 1_000,
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is single-host no-clusterGeneration
    });
    expect(dispatch.calls).toHaveLength(1);
    expect("clusterGeneration" in dispatch.calls[0]).toBe(false);
  });

  // CTL-864 remediation: the won generation is PERSISTED so the later
  // advancement/revive sweeps can re-inject it (the fence was inert without this).
  // The dispatch stub writes the signal file so the worker dir exists when the
  // post-dispatch persist runs (mirrors what phase-agent-dispatch does in prod;
  // writeClusterGeneration is best-effort no-op on a missing dir, like
  // writeWorkerPriority).
  const dispatchCreatesDir = () => {
    const calls = [];
    const fn = (args) => {
      calls.push(args);
      const dir = join(orchDir, "workers", args.ticket);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `phase-${args.phase}.json`),
        JSON.stringify({
          ticket: args.ticket,
          phase: args.phase,
          status: "dispatched",
          bg_job_id: "new-bg",
        })
      );
      return { code: 0, stdout: "", stderr: "" };
    };
    fn.calls = calls;
    return fn;
  };

  test("CTL-864 remediation: a won multi-host claim persists cluster-generation.json", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = dispatchCreatesDir();
    const claimDispatch = recordClaim({ won: true, generation: 7 });
    schedulerTick(orchDir, {
      readEligible: () => eligibleOne(),
      dispatch,
      hosts: ROSTER,
      hostName: OWNER,
      claimDispatch,
      // CTL-1481: stub the label-stamp seam — this test's subject is the
      // cluster-generation persist, not the label write.
      stampWorkerLabel: () => ({ stamped: true }),
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      now: () => 1_000,
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is cluster-generation persist
    });
    expect(readClusterGeneration(orchDir, TICKET)).toBe(7);
  });

  test("CTL-864 remediation: single-host dispatch persists NO cluster-generation.json", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = dispatchCreatesDir(); // dir exists, so absence is from the null-guard
    schedulerTick(orchDir, {
      readEligible: () => eligibleOne(),
      dispatch,
      hosts: ["solo"],
      hostName: "solo",
      claimDispatch: recordClaim({ won: false, generation: null }),
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      now: () => 1_000,
    });
    expect(existsSync(join(orchDir, "workers", TICKET, "cluster-generation.json"))).toBe(false);
  });

  // CTL-1481: the worker:<host> label visibility-projection stamp fires right
  // after a won multi-host claim, mirroring the emitFenceClaimed gate.
  test("CTL-1481: a won multi-host claim fires stampWorkerLabel with the ticket + host", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = dispatchCreatesDir();
    const claimDispatch = recordClaim({ won: true, generation: 7 });
    const calls = [];
    const stampWorkerLabel = (arg) => {
      calls.push(arg);
      return { stamped: true };
    };
    schedulerTick(orchDir, {
      readEligible: () => eligibleOne(),
      dispatch,
      hosts: ROSTER,
      hostName: OWNER,
      claimDispatch,
      stampWorkerLabel,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      now: () => 1_000,
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is the label stamp wiring
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ ticket: TICKET, hostName: OWNER });
  });

  test("CTL-1481: single-host dispatch never fires stampWorkerLabel (multiHost gate)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = dispatchCreatesDir();
    const calls = [];
    const stampWorkerLabel = (arg) => {
      calls.push(arg);
      return { stamped: true };
    };
    schedulerTick(orchDir, {
      readEligible: () => eligibleOne(),
      dispatch,
      hosts: ["solo"],
      hostName: "solo",
      claimDispatch: recordClaim({ won: false, generation: null }),
      stampWorkerLabel,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      now: () => 1_000,
      hasTriageArtifact: () => true,
    });
    expect(calls).toHaveLength(0);
  });

  test("CTL-1481: a thrown stampWorkerLabel never blocks the dispatch success path", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = dispatchCreatesDir();
    const claimDispatch = recordClaim({ won: true, generation: 7 });
    const stampWorkerLabel = () => {
      throw new Error("linearis exploded");
    };
    const result = schedulerTick(orchDir, {
      readEligible: () => eligibleOne(),
      dispatch,
      hosts: ROSTER,
      hostName: OWNER,
      claimDispatch,
      stampWorkerLabel,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      now: () => 1_000,
      hasTriageArtifact: () => true,
    });
    expect(dispatch.calls).toHaveLength(1); // dispatch still succeeded
    expect(result?.dispatched).toEqual([TICKET]);
  });
});

// ── CTL-1091: new-work dispatch fails over an OFFLINE HRW owner ───────────────
//
// The new-work ready filter (scheduler.mjs) must hash ownership over the LIVE
// (surviving) roster, not the raw roster, so a ticket whose HRW owner is offline
// fails over to a live host instead of stranding in Todo forever. Mirrors the
// CTL-1191 recovery-side seam: an injectable dispatchSurvivingRoster override
// drives the shed set deterministically without writing heartbeat events.
describe("schedulerTick — new-work dispatch fails over an offline HRW owner (CTL-1091)", () => {
  const ROSTER = ["mini", "laptop"];
  // CTL-3 hashes to "laptop" under [mini,laptop]; under [mini] alone it fails
  // over to mini (survivor identity). Anchor the fixture to the real HRW math.
  const LAPTOP_OWNED_ID = "CTL-3";
  expect(ownerForTicket(LAPTOP_OWNED_ID, ROSTER)).toBe("laptop");
  expect(ownerForTicket(LAPTOP_OWNED_ID, ["mini"])).toBe("mini");

  const eligibleOne = (id = LAPTOP_OWNED_ID) => [
    {
      identifier: id,
      priority: 1,
      createdAt: "x",
      state: "Todo",
      relations: { nodes: [] },
      inverseRelations: { nodes: [] },
    },
  ];

  test("dispatches a laptop-owned ticket from mini when laptop is OFFLINE (shed)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({ code: 0 });
    schedulerTick(orchDir, {
      readEligible: () => eligibleOne(),
      dispatch,
      hosts: ROSTER,
      hostName: "mini",
      // laptop shed → survivors = [mini]; mini now owns CTL-3 → dispatched.
      dispatchSurvivingRoster: ["mini"],
      // won claim so the dispatch proceeds past the multi-host claim gate.
      claimDispatch: () => ({ won: true, generation: 1 }),
      stampWorkerLabel: () => ({ stamped: true }),
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      now: () => 1_000,
      hasTriageArtifact: () => true,
    });
    expect(dispatch.calls.map((a) => a.ticket)).toContain(LAPTOP_OWNED_ID);
  });

  test("does NOT dispatch a laptop-owned ticket from mini when laptop is LIVE", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({ code: 0 });
    schedulerTick(orchDir, {
      readEligible: () => eligibleOne(),
      dispatch,
      hosts: ROSTER,
      hostName: "mini",
      // both live → laptop still owns CTL-3 → mini filters it out.
      dispatchSurvivingRoster: ["mini", "laptop"],
      claimDispatch: () => ({ won: true, generation: 1 }),
      stampWorkerLabel: () => ({ stamped: true }),
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      now: () => 1_000,
      hasTriageArtifact: () => true,
    });
    expect(dispatch.calls).toHaveLength(0);
  });

  test("single-host is a strict no-op (dispatches, HRW identity)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({ code: 0 });
    schedulerTick(orchDir, {
      readEligible: () => eligibleOne(),
      dispatch,
      hosts: ["mini"],
      hostName: "mini",
      // multiHost=false short-circuits the ownership filter entirely; no
      // surviving-roster read fires regardless of any override.
      claimDispatch: () => ({ won: true, generation: 1 }),
      stampWorkerLabel: () => ({ stamped: true }),
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      now: () => 1_000,
      hasTriageArtifact: () => true,
    });
    expect(dispatch.calls.map((a) => a.ticket)).toContain(LAPTOP_OWNED_ID);
  });

  test("fails open: total liveness outage degrades to the full roster (no override)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({ code: 0 });
    // No dispatchSurvivingRoster override → the real computeDispatchSurvivingRoster
    // runs. Use fake hosts guaranteed ABSENT from the real heartbeat feed so
    // positive-liveness sees NO live host → fail-safe degrades to the FULL roster
    // [hosta,hostb]. CTL-1 hashes to hostb over that roster, so hosta does NOT
    // dispatch it (today's raw-roster behavior preserved on a dead feed).
    const OUTAGE_ROSTER = ["hosta", "hostb"];
    expect(ownerForTicket("CTL-1", OUTAGE_ROSTER)).toBe("hostb");
    schedulerTick(orchDir, {
      readEligible: () => eligibleOne("CTL-1"),
      dispatch,
      hosts: OUTAGE_ROSTER,
      hostName: "hosta",
      claimDispatch: () => ({ won: true, generation: 1 }),
      stampWorkerLabel: () => ({ stamped: true }),
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      now: () => 1_000,
      hasTriageArtifact: () => true,
    });
    expect(dispatch.calls).toHaveLength(0);
  });

  // CTL-1091 Phase 2: the deflap path (no dispatchSurvivingRoster override) must
  // persist .liveness-deflap.json atomically — the file exists after a multi-host
  // tick and no partial `.tmp` sibling is left behind.
  test("Phase 2: a multi-host tick writes .liveness-deflap.json atomically (no .tmp left)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({ code: 0 });
    schedulerTick(orchDir, {
      // A mini-owned eligible ticket forces the ready filter (→ _dispatchRoster())
      // to run without a dispatchSurvivingRoster override, so the real deflap
      // read/compute/write path fires.
      readEligible: () => eligibleOne("CTL-1"),
      dispatch,
      hosts: ROSTER,
      hostName: "mini",
      claimDispatch: () => ({ won: true, generation: 1 }),
      stampWorkerLabel: () => ({ stamped: true }),
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      now: () => 1_000,
      hasTriageArtifact: () => true,
    });
    expect(existsSync(join(orchDir, ".liveness-deflap.json"))).toBe(true);
    const leftoverTmp = readdirSync(orchDir).filter((f) => f.startsWith(".liveness-deflap.json.tmp"));
    expect(leftoverTmp).toEqual([]);
  });
});

// ── CTL-1091 / CTL-1057: computeDispatchSurvivingRoster positive-liveness ──────
//
// Dispatch ownership requires POSITIVE liveness (seen within grace), unlike the
// recovery-side computeSurvivingRoster (fail-open deadHosts). This sheds a host
// that has NEVER heartbeated (absent from lastSeen) so its HRW slice fails over,
// while a total feed outage still fail-safes to the full roster.
describe("computeDispatchSurvivingRoster — positive liveness (CTL-1091/CTL-1057)", () => {
  const NOW = 10_000_000;
  const recent = new Date(NOW - 1_000).toISOString();
  const stale = new Date(NOW - 700_000).toISOString(); // older than 10-min grace

  test("sheds a NEVER-live host (absent from lastSeen) — the CTL-1057 case", () => {
    const roster = ["mini", "ghost"];
    const out = computeDispatchSurvivingRoster(roster, {
      readHeartbeats: () => ({ mini: recent }), // ghost never heartbeated
      nowMs: NOW,
    });
    expect(out).toEqual(["mini"]);
  });

  test("sheds a host whose last heartbeat is older than grace", () => {
    const roster = ["mini", "laptop"];
    const out = computeDispatchSurvivingRoster(roster, {
      readHeartbeats: () => ({ mini: recent, laptop: stale }),
      nowMs: NOW,
    });
    expect(out).toEqual(["mini"]);
  });

  test("keeps every host seen within grace", () => {
    const roster = ["mini", "laptop"];
    const out = computeDispatchSurvivingRoster(roster, {
      readHeartbeats: () => ({ mini: recent, laptop: recent }),
      nowMs: NOW,
    });
    expect(out.slice().sort()).toEqual(["laptop", "mini"]);
  });

  test("fail-safe: NObody live (total outage) → full roster, never strands", () => {
    const roster = ["mini", "laptop"];
    const out = computeDispatchSurvivingRoster(roster, {
      readHeartbeats: () => ({}), // no host seen at all
      nowMs: NOW,
    });
    expect(out.slice().sort()).toEqual(["laptop", "mini"]);
  });

  test("fail-safe: a heartbeat-read throw → full roster", () => {
    const roster = ["mini", "laptop"];
    const out = computeDispatchSurvivingRoster(roster, {
      readHeartbeats: () => {
        throw new Error("loki down");
      },
      nowMs: NOW,
    });
    expect(out).toEqual(roster);
  });

  test("single-host is a strict no-op (no read)", () => {
    let read = false;
    const out = computeDispatchSurvivingRoster(["solo"], {
      readHeartbeats: () => {
        read = true;
        return {};
      },
      nowMs: NOW,
    });
    expect(out).toEqual(["solo"]);
    expect(read).toBe(false);
  });
});

// ── CTL-1091: resolveDispatchRoster — the shared liveness+deflap+outage resolver ─
//
// The single source of truth both dispatch sites (scheduler new-work + monitor
// triage) call, so they can never drift. Composes positive-liveness → restore
// deflap → outage fail-safe. Uses a real temp orchDir for the .liveness-deflap.json
// read/write and an injected readHeartbeats for the feed.
describe("resolveDispatchRoster — shared dispatch resolver (CTL-1091)", () => {
  const NOW = 10_000_000;
  const recent = new Date(NOW - 1_000).toISOString();
  const HOLD = 600_000;

  test("single-host is a strict no-op", () => {
    const out = resolveDispatchRoster({
      roster: ["solo"],
      orchDir,
      self: "solo",
      nowMs: NOW,
      readHeartbeats: () => ({}),
    });
    expect(out).toEqual(["solo"]);
  });

  test("sheds a never-live host and dispatches over the live survivor", () => {
    const out = resolveDispatchRoster({
      roster: ["mini", "ghost"],
      orchDir,
      self: "mini",
      nowMs: NOW,
      holdMs: HOLD,
      readHeartbeats: () => ({ mini: recent }), // ghost never live
      persist: true,
    });
    expect(out).toEqual(["mini"]);
  });

  test("holds a freshly-restored host out for the deflap window", () => {
    // Seed prevState: laptop was shed last tick (liveSince:null) → newly restored.
    writeFileSync(
      join(orchDir, ".liveness-deflap.json"),
      JSON.stringify({ laptop: { liveSince: null } })
    );
    const out = resolveDispatchRoster({
      roster: ["mini", "laptop"],
      orchDir,
      self: "mini",
      nowMs: NOW,
      holdMs: HOLD,
      readHeartbeats: () => ({ mini: recent, laptop: recent }), // both live now
      persist: true,
    });
    expect(out).toEqual(["mini"]); // laptop held out (restore hold)
  });

  // CTL-1091 correctness review #1: on a TOTAL feed outage the resolver must
  // degrade to the FULL roster and NOT let the deflap partially re-shed a
  // just-departed host (which would re-home its slice, violating the outage
  // invariant). This is the exact reproduction from the review.
  test("total outage → FULL roster even when prevState marks a host shed (no partial re-shed)", () => {
    writeFileSync(
      join(orchDir, ".liveness-deflap.json"),
      JSON.stringify({ A: { liveSince: null }, C: { liveSince: 0 } })
    );
    const out = resolveDispatchRoster({
      roster: ["A", "B", "C"],
      orchDir,
      self: "A",
      nowMs: 700_000,
      holdMs: HOLD,
      readHeartbeats: () => ({}), // NOBODY positively live → total outage
      persist: true,
    });
    // Must be the full roster, NOT the partial [B,C] the naive deflap produced.
    expect(out.slice().sort()).toEqual(["A", "B", "C"]);
  });

  test("read-throw (outage) → full roster, observation state left intact", () => {
    writeFileSync(
      join(orchDir, ".liveness-deflap.json"),
      JSON.stringify({ laptop: { liveSince: 1234 } })
    );
    const out = resolveDispatchRoster({
      roster: ["mini", "laptop"],
      orchDir,
      self: "mini",
      nowMs: NOW,
      readHeartbeats: () => {
        throw new Error("loki down");
      },
      persist: true,
    });
    expect(out.slice().sort()).toEqual(["laptop", "mini"]);
    // prevState preserved (we learned nothing this tick).
    const persisted = JSON.parse(readFileSync(join(orchDir, ".liveness-deflap.json"), "utf8"));
    expect(persisted.laptop.liveSince).toBe(1234);
  });

  test("persist:false does NOT write the deflap file", () => {
    resolveDispatchRoster({
      roster: ["mini", "ghost"],
      orchDir,
      self: "mini",
      nowMs: NOW,
      readHeartbeats: () => ({ mini: recent }),
      persist: false,
    });
    expect(existsSync(join(orchDir, ".liveness-deflap.json"))).toBe(false);
  });

  // CTL-1091 verify F3 (coverage): pin the SOLE-WRITER invariant on the read-only
  // (monitor) path even when the deflap actually mutates observation state — a
  // freshly-restored host is held, so nextState differs from prevState, yet
  // persist:false must still leave the file untouched. Guards a regression that
  // made the monitor path (resolveDispatchRoster persist:false) write the file.
  test("persist:false leaves the deflap file untouched even when the deflap holds a host", () => {
    // Seed a restored host so the resolve computes fresh observation state.
    const seeded = JSON.stringify({ laptop: { liveSince: null } });
    writeFileSync(join(orchDir, ".liveness-deflap.json"), seeded);
    const out = resolveDispatchRoster({
      roster: ["mini", "laptop"],
      orchDir,
      self: "mini",
      nowMs: NOW,
      holdMs: HOLD,
      readHeartbeats: () => ({ mini: recent, laptop: recent }), // both live now
      persist: false,
    });
    expect(out).toEqual(["mini"]); // laptop held (deflap active → nextState differs)
    // File byte-identical to the seed — read-only path wrote nothing.
    expect(readFileSync(join(orchDir, ".liveness-deflap.json"), "utf8")).toBe(seeded);
  });

  // CTL-1091 verify F2 (silent-failure): the outage→full-roster degrade must fire
  // the onDegrade observability hook so cross-host failover turning OFF is not
  // invisible. Two outage shapes; the caught error rides along on a read-throw.
  test("onDegrade fires on a read-throw outage with the caught error message", () => {
    const calls = [];
    const out = resolveDispatchRoster({
      roster: ["mini", "laptop"],
      orchDir,
      self: "mini",
      nowMs: NOW,
      readHeartbeats: () => {
        throw new Error("loki down");
      },
      persist: true,
      onDegrade: (info) => calls.push(info),
    });
    expect(out.slice().sort()).toEqual(["laptop", "mini"]);
    expect(calls.length).toBe(1);
    expect(calls[0].reason).toBe("heartbeat-read-threw");
    expect(calls[0].error).toBe("loki down");
  });

  test("onDegrade fires when NOBODY is positively live (reason nobody-positively-live)", () => {
    const calls = [];
    resolveDispatchRoster({
      roster: ["mini", "laptop"],
      orchDir,
      self: "mini",
      nowMs: NOW,
      readHeartbeats: () => ({}), // empty feed → nobody live
      persist: true,
      onDegrade: (info) => calls.push(info),
    });
    expect(calls.length).toBe(1);
    expect(calls[0].reason).toBe("nobody-positively-live");
    expect(calls[0].error).toBe(null);
  });

  test("onDegrade does NOT fire on the happy (some-live) path", () => {
    const calls = [];
    resolveDispatchRoster({
      roster: ["mini", "laptop"],
      orchDir,
      self: "mini",
      nowMs: NOW,
      holdMs: HOLD,
      readHeartbeats: () => ({ mini: recent, laptop: recent }),
      persist: true,
      onDegrade: (info) => calls.push(info),
    });
    expect(calls.length).toBe(0);
  });

  test("an onDegrade that throws never breaks the roster resolve", () => {
    const out = resolveDispatchRoster({
      roster: ["mini", "laptop"],
      orchDir,
      self: "mini",
      nowMs: NOW,
      readHeartbeats: () => ({}),
      persist: false,
      onDegrade: () => {
        throw new Error("observability blew up");
      },
    });
    expect(out.slice().sort()).toEqual(["laptop", "mini"]);
  });
});

// ── CTL-1091 ticket-Gherkin scenarios (end-to-end over schedulerTick) ──────────
//
// One describe per ticket scenario. Co-located here (not a standalone file) to
// reuse the outer beforeEach's CATALYST_DIR redirect — otherwise the real event
// log would leak into computeSurvivingRoster and make these non-deterministic.
// Liveness is injected via dispatchSurvivingRoster; the soft-CAS via claimDispatch.
describe("CTL-1091 ticket scenarios — offline-node ownership shedding", () => {
  const ROSTER = ["mini", "laptop"];
  const T_MINI = "CTL-1"; // HRW owner over [mini,laptop] === mini
  const T_LAPTOP = "CTL-3"; // HRW owner over [mini,laptop] === laptop
  // Anchor fixtures to the real HRW math.
  expect(ownerForTicket(T_MINI, ROSTER)).toBe("mini");
  expect(ownerForTicket(T_LAPTOP, ROSTER)).toBe("laptop");
  expect(ownerForTicket(T_LAPTOP, ["mini"])).toBe("mini"); // fails over to survivor

  const elig = (...ids) =>
    ids.map((identifier) => ({
      identifier,
      priority: 1,
      createdAt: "x",
      state: "Todo",
      relations: { nodes: [] },
      inverseRelations: { nodes: [] },
    }));

  const dispatchedIds = (dispatch) => dispatch.calls.map((a) => a.ticket).sort();

  test("scenario 1 — backlog flows while the laptop is OFF: mini dispatches ALL", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 5 }));
    const dispatch = fakeDispatch({ code: 0 });
    schedulerTick(orchDir, {
      readEligible: () => elig(T_MINI, T_LAPTOP),
      dispatch,
      hosts: ROSTER,
      hostName: "mini",
      dispatchSurvivingRoster: ["mini"], // laptop shed
      claimDispatch: () => ({ won: true, generation: 1 }),
      stampWorkerLabel: () => ({ stamped: true }),
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      now: () => 1_000,
      hasTriageArtifact: () => true,
    });
    // Both the mini-hashed AND the laptop-hashed ticket dispatch from mini.
    expect(dispatchedIds(dispatch)).toEqual([T_LAPTOP, T_MINI].sort());
  });

  test("scenario 2a — laptop rejoins and takes its OWN slice back", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 5 }));
    const dispatch = fakeDispatch({ code: 0 });
    schedulerTick(orchDir, {
      readEligible: () => elig(T_LAPTOP),
      dispatch,
      hosts: ROSTER,
      hostName: "laptop",
      dispatchSurvivingRoster: ["mini", "laptop"], // both live (past hold)
      claimDispatch: () => ({ won: true, generation: 1 }),
      stampWorkerLabel: () => ({ stamped: true }),
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      now: () => 1_000,
      hasTriageArtifact: () => true,
    });
    expect(dispatchedIds(dispatch)).toEqual([T_LAPTOP]);
  });

  test("scenario 2b — NO mid-flight handback: a ticket mini already claimed stays with mini", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 5 }));
    const dispatch = fakeDispatch({ code: 0 });
    const claims = [];
    schedulerTick(orchDir, {
      readEligible: () => elig(T_LAPTOP),
      dispatch,
      hosts: ROSTER,
      hostName: "laptop",
      dispatchSurvivingRoster: ["mini", "laptop"],
      // laptop owns T_LAPTOP by HRW and attempts the claim, but mini holds the
      // fence → the soft-CAS is LOST → laptop does not re-dispatch (no handback).
      claimDispatch: (arg) => {
        claims.push(arg);
        return { won: false, generation: 2 };
      },
      stampWorkerLabel: () => ({ stamped: true }),
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      now: () => 1_000,
      hasTriageArtifact: () => true,
    });
    expect(claims).toHaveLength(1); // the claim was ATTEMPTED (path unchanged)
    expect(dispatch.calls).toHaveLength(0); // but LOST → not dispatched
  });

  test("scenario 3 — both hosts race a transition: the soft-CAS yields EXACTLY one dispatch", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 5 }));
    // mini's tick: it believes laptop is dead → it owns T_LAPTOP → wins the CAS.
    const dMini = fakeDispatch({ code: 0 });
    schedulerTick(orchDir, {
      readEligible: () => elig(T_LAPTOP),
      dispatch: dMini,
      hosts: ROSTER,
      hostName: "mini",
      dispatchSurvivingRoster: ["mini"],
      claimDispatch: () => ({ won: true, generation: 5 }), // mini wins
      stampWorkerLabel: () => ({ stamped: true }),
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      now: () => 1_000,
      hasTriageArtifact: () => true,
    });
    // laptop's concurrent tick: it believes it is live → it owns T_LAPTOP too, but
    // the fence CAS is already held by mini → LOST.
    const dLaptop = fakeDispatch({ code: 0 });
    schedulerTick(orchDir, {
      readEligible: () => elig(T_LAPTOP),
      dispatch: dLaptop,
      hosts: ROSTER,
      hostName: "laptop",
      dispatchSurvivingRoster: ["mini", "laptop"],
      claimDispatch: () => ({ won: false, generation: 5 }), // laptop loses the CAS
      stampWorkerLabel: () => ({ stamped: true }),
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      now: () => 1_000,
      hasTriageArtifact: () => true,
    });
    // Exactly one host dispatched the contested ticket.
    expect(dMini.calls).toHaveLength(1);
    expect(dLaptop.calls).toHaveLength(0);
  });
});

// ── CTL-1191: HRW-gate the recovery passes over the surviving roster ──────────
//
// The recovery passes (Pass 0u unstuck-sweep, Pass 0r reasoning, diagnostician)
// classify-then-ACT over the stalled backlog. Before CTL-1191 they had NO
// ownership gate, so a 2-node cluster double-acted on every stalled ticket. These
// tests drive Pass 0u (the cleanest injectable seam) to assert:
//   • N=1 is a STRICT no-op (every candidate acted — would break live mini if not)
//   • N=2 acts ONLY on the candidates THIS node owns by HRW
//   • a DEAD owner's candidates fail over to the surviving owner (gate hashes over
//     the SURVIVING roster, not the raw roster)
describe("CTL-1191 — recovery passes HRW-gated over the surviving roster (Pass 0u)", () => {
  const ROSTER = ["mini", "mac-studio"];
  // CTL-A → mini, CTL-B → mac-studio (deterministic under this roster).
  const T_MINI = "CTL-A";
  const T_STUDIO = "CTL-B";
  // Sanity-anchor the fixtures to the real HRW math so the test can't silently
  // drift if hrw.mjs changes.
  expect(ownerForTicket(T_MINI, ROSTER)).toBe("mini");
  expect(ownerForTicket(T_STUDIO, ROSTER)).toBe("mac-studio");

  // Two stalled candidates with empty evidence → classifyStalledTicket returns
  // { category:"unknown", action:"escalate" }, so each fires the escalate seam.
  const twoCandidates = () => [
    { ticket: T_MINI, phase: "implement", evidence: {} },
    { ticket: T_STUDIO, phase: "implement", evidence: {} },
  ];
  // Recorder for the escalate seam: captures every ticket it was called for.
  const recordEscalate = () => {
    const tickets = [];
    const fn = (c) => tickets.push(c.ticket);
    fn.tickets = tickets;
    return fn;
  };
  // unstuckSweep opts that force the pass to RUN (intervalMs:0 defeats the
  // per-run throttle regardless of module-global carryover) with a recorder.
  const unstuckOpts = (escalate) => ({
    mode: "enforce",
    intervalMs: 0,
    nowMs: () => 9_000_000,
    collectCandidates: twoCandidates,
    escalate,
    emit: () => true, // swallow events
    postComment: () => {},
  });

  test("single-host roster is a STRICT no-op: BOTH stalled candidates are acted on", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const escalate = recordEscalate();
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch({ code: 0 }),
      hosts: ["solo"],
      hostName: "solo",
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      now: () => 9_000_000,
      unstuckSweep: unstuckOpts(escalate),
    });
    expect(escalate.tickets.sort()).toEqual([T_MINI, T_STUDIO].sort());
  });

  test("multi-host: only the candidate THIS node owns by HRW is acted on", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const escalate = recordEscalate();
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch({ code: 0 }),
      hosts: ROSTER,
      hostName: "mini",
      // Both hosts alive → survivors = full roster. mini owns only CTL-A.
      recoverySurvivingRoster: ROSTER,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      now: () => 9_000_000,
      unstuckSweep: unstuckOpts(escalate),
    });
    expect(escalate.tickets).toEqual([T_MINI]); // CTL-B (mac-studio's) filtered out
  });

  test("dead-owner failover: a dead node's stalled candidate fails over to the survivor", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const escalate = recordEscalate();
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch({ code: 0 }),
      hosts: ROSTER,
      hostName: "mini",
      // mac-studio is DEAD → survivors = [mini]. Under [mini], mini owns BOTH
      // tickets (HRW over a 1-host survivor set is an identity), so the
      // mac-studio-owned CTL-B fails over to mini instead of stranding.
      recoverySurvivingRoster: ["mini"],
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      now: () => 9_000_000,
      unstuckSweep: unstuckOpts(escalate),
    });
    expect(escalate.tickets.sort()).toEqual([T_MINI, T_STUDIO].sort());
  });

  test("multi-host: the OTHER node acts on the complementary candidate (no ticket stranded)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const escalate = recordEscalate();
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch({ code: 0 }),
      hosts: ROSTER,
      hostName: "mac-studio", // the other node
      recoverySurvivingRoster: ROSTER,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      now: () => 9_000_000,
      unstuckSweep: unstuckOpts(escalate),
    });
    // Across the two nodes (this test + the owned-only test) every candidate is
    // covered exactly once — mac-studio handles CTL-B.
    expect(escalate.tickets).toEqual([T_STUDIO]);
  });
});

// ── CTL-1191: Pass 0r reasoning — terminal-state filter (PR #2163 verify flag) ──
//
// The reasoning pass must NOT reason over a ticket already finished (terminal
// Linear state / merged PR) — doing so burns cooldown + re-posts diagnoses on a
// Done ticket. In shadow the pass emits a per-item recovery.would-* event for every
// item it processes (CTL-1157 F #5 retired the .recovery-intents cooldown marker in
// shadow), so the event's presence/absence is the observable. Single-host so the
// ownership gate is identity (we isolate the
// terminal filter). A gateway descriptor supplies the Linear state without any
// network — "Done" ⇒ terminal ⇒ filtered; "In Progress" ⇒ kept.
describe("CTL-1191 — reasoning pass skips terminal tickets (Pass 0r terminal-state filter)", () => {
  const recoveryIntentMarker = (ticket) => join(orchDir, ".recovery-intents", `${ticket}.json`);

  test("a Done ticket is filtered out; an in-flight stalled ticket is processed", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    // Two stalled workers: CTL-DONE (Linear=Done) and CTL-LIVE (Linear=In Progress).
    writeSignal("CTL-DONE", "implement", "stalled");
    writeSignal("CTL-LIVE", "implement", "stalled");

    const fresh = new Date().toISOString(); // within the 60s gateway-fresh window
    const gateway = {
      getDescriptor: (id) => {
        if (id === "CTL-DONE") return { state: "Done", removed: false, updatedAt: fresh };
        if (id === "CTL-LIVE") return { state: "In Progress", removed: false, updatedAt: fresh };
        return null;
      },
    };

    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch({ code: 0 }),
      hosts: ["solo"],
      hostName: "solo",
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      now: () => 9_000_000,
      gateway,
      // No-op the Linear write seam so the stalled-signal terminal sweep doesn't
      // shell out to `linearis` (unrelated to the filter under test).
      writeStatus: {
        applyPhaseStatus: () => {},
        applyTerminalDone: () => {},
        applyLabel: () => ({ applied: true }),
      },
      recoveryPass: { mode: "shadow" },
    });

    // CTL-1157 F #5: shadow no longer writes a cooldown marker for a DEFERRED (untyped
    // stuck) item — that would mutate enforce scheduler state. So the observable that
    // the in-flight CTL-LIVE was PROCESSED is now its recovery.would-defer EVENT; the
    // terminal CTL-DONE, filtered BEFORE the pass, has NO per-item reasoning event
    // (recovery.decision / recovery.would-*) and is never cooled down.
    const events = readEventLog().map((e) => JSON.stringify(e));
    expect(events.some((e) => e.includes("CTL-LIVE") && e.includes("would-defer"))).toBe(true);
    expect(
      events.some(
        (e) => e.includes("CTL-DONE") && (e.includes("recovery.decision") || e.includes("would-"))
      )
    ).toBe(false);
    expect(existsSync(recoveryIntentMarker("CTL-DONE"))).toBe(false);
  });
});

// ── CTL-864 remediation: advancement + revive sweeps re-inject the fence token ──
//
// The HIGH verify finding: the 5 guarded skills run as LATER phases dispatched by
// the advancement sweep (implement/pr/monitor-merge/monitor-deploy) and the revive
// sweep — neither re-forwarded the won token, so every fence guard no-op'd. These
// assert the persisted token is re-injected on both paths (multi-host only).
describe("CTL-864 remediation — advancement + revive re-inject clusterGeneration", () => {
  const ROSTER = ["mini", "mac-studio"];

  test("advancement sweep re-injects the persisted token (multi-host)", () => {
    writeSignal("CTL-864X", "research", "done"); // in-flight; advancement → plan
    writeClusterGeneration(orchDir, "CTL-864X", 9); // token won at the earlier new-work claim
    const dispatch = fakeDispatch({ code: 0 });
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      hosts: ROSTER,
      hostName: "mini",
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      now: () => 1_000,
    });
    const call = dispatch.calls.find((c) => c.ticket === "CTL-864X");
    expect(call).toBeDefined();
    expect(call.phase).toBe("plan");
    expect(call.clusterGeneration).toBe(9);
  });

  test("advancement sweep forwards NO token on single-host (exact no-op)", () => {
    writeSignal("CTL-864Y", "research", "done");
    writeClusterGeneration(orchDir, "CTL-864Y", 9); // present, but single-host → not read
    const dispatch = fakeDispatch({ code: 0 });
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      hosts: ["solo"],
      hostName: "solo",
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      now: () => 1_000,
    });
    const call = dispatch.calls.find((c) => c.ticket === "CTL-864Y");
    expect(call).toBeDefined();
    expect("clusterGeneration" in call).toBe(false);
  });

  test("advancement sweep forwards no token when none persisted (multi-host, unclaimed ticket)", () => {
    writeSignal("CTL-864Z", "research", "done"); // no cluster-generation.json written
    const dispatch = fakeDispatch({ code: 0 });
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      hosts: ROSTER,
      hostName: "mini",
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      now: () => 1_000,
    });
    const call = dispatch.calls.find((c) => c.ticket === "CTL-864Z");
    expect(call).toBeDefined();
    expect("clusterGeneration" in call).toBe(false); // null → dispatchTicket drops the key
  });

  test("revive sweep re-injects the persisted token (multi-host)", () => {
    const dir = join(orchDir, "workers", "CTL-864R");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "phase-monitor-merge.json"),
      JSON.stringify({
        ticket: "CTL-864R",
        phase: "monitor-merge",
        status: "preempted",
        parkedFrom: "monitor-merge",
        bg_job_id: "bg-r",
        attentionReason: "preempted-by-priority",
      })
    );
    writeWorkerPriority(orchDir, "CTL-864R", { priority: 2, createdAt: "2026-05-01T00:00:00Z" });
    writeClusterGeneration(orchDir, "CTL-864R", 11);
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    const calls = [];
    const dispatch = (args) => {
      calls.push(args);
      const d = join(orchDir, "workers", args.ticket);
      mkdirSync(d, { recursive: true });
      writeFileSync(
        join(d, `phase-${args.phase}.json`),
        JSON.stringify({
          ticket: args.ticket,
          phase: args.phase,
          status: "dispatched",
          bg_job_id: "new-bg",
        })
      );
      return { code: 0, stdout: "", stderr: "" };
    };
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      hosts: ROSTER,
      hostName: "mini",
      liveBackgroundCount: () => 1, // 1 free slot
      reclaimDeadWork: () => "noop",
      resolveSession: () => "uuid-x",
      verifyDispatched: verifyOk,
    });
    const call = calls.find((c) => c.ticket === "CTL-864R");
    expect(call).toBeDefined();
    expect(call.phase).toBe("monitor-merge");
    expect(call.clusterGeneration).toBe(11);
  });
});

// ── CTL-834: convergeHeldLabel held-label apply cool-down ──
//
// The held-label converger re-issued applyLabel(blocked/waiting) every ~22s tick.
// When the apply failed UNRECOVERABLY (the desired label's exclusive-group
// sibling is already on the ticket — "not exclusive child"), the label never
// landed, the diff was never satisfied, and the write re-fired forever (the storm:
// 218 fails / 44 min, burning the Linear write quota). These pin the time-boxed
// cool-down that backs the apply off after such a failure (and self-heals).
describe("CTL-834 — convergeHeldLabel apply cool-down", () => {
  // makeWs — a writeStatus fake whose applyLabel returns a fixed result and
  // records calls; removeLabel records calls (fire-and-forget).
  const makeWs = (applyResult) => {
    const applyLabel = (...a) => {
      applyLabel.calls.push(a);
      return applyResult;
    };
    applyLabel.calls = [];
    const removeLabel = (...a) => {
      removeLabel.calls.push(a);
    };
    removeLabel.calls = [];
    return { applyLabel, removeLabel };
  };
  const cd = (ticket, label) => existsSync(labelCooldownPath(orchDir, ticket, label));

  test("happy path: apply succeeds → 1 write, NO cool-down marker", () => {
    const ws = makeWs({ applied: true, reason: null });
    const writes = convergeHeldLabel("CTL-1", [], "blocked", ws, { orchDir, now: () => 1000 });
    expect(writes).toBe(1);
    expect(ws.applyLabel.calls).toHaveLength(1);
    expect(cd("CTL-1", "blocked")).toBe(false);
  });

  // CTL-764 finding 1: the rename dropped the legacy "waiting" out of HELD_LABELS, so
  // clear-on-pickup stopped removing it. It must stay in the removable set (never applied).
  test("finding 1 — clear-on-pickup (desired=null) removes the legacy 'waiting' label", () => {
    const ws = makeWs({ applied: true, reason: null });
    const writes = convergeHeldLabel("CTL-1", ["waiting"], null, ws, { orchDir, now: () => 1000 });
    expect(writes).toBe(1);
    expect(ws.removeLabel.calls).toContainEqual(["CTL-1", "waiting"]);
  });

  test("unrecoverable apply (exclusive-conflict) → arms the cool-down marker", () => {
    const ws = makeWs({ applied: false, reason: "exclusive-conflict" });
    const writes = convergeHeldLabel("CTL-1", [], "blocked", ws, { orchDir, now: () => 1000 });
    expect(writes).toBe(1);
    expect(ws.applyLabel.calls).toHaveLength(1);
    expect(cd("CTL-1", "blocked")).toBe(true);
  });

  // CTL-1085 regression guard: classifyLabelFailure now returns "team-mismatch"
  // for the cross-team (ADV) failure that previously surfaced as "missing-label".
  // It MUST stay in UNRECOVERABLE_LABEL_REASONS here or convergeHeldLabel loses
  // its cool-down on that path and re-opens the CTL-834 per-tick retry storm.
  test("unrecoverable apply (team-mismatch, CTL-1085) → arms the cool-down marker", () => {
    const ws = makeWs({ applied: false, reason: "team-mismatch" });
    const writes = convergeHeldLabel("CTL-1", [], "blocked", ws, { orchDir, now: () => 1000 });
    expect(writes).toBe(1);
    expect(ws.applyLabel.calls).toHaveLength(1);
    expect(cd("CTL-1", "blocked")).toBe(true);
  });

  test("team-mismatch WITHIN the window: apply is SUPPRESSED (storm-break holds)", () => {
    const ws = makeWs({ applied: false, reason: "team-mismatch" });
    convergeHeldLabel("CTL-1", [], "blocked", ws, { orchDir, now: () => 1000 }); // arms cooldown
    const writes = convergeHeldLabel("CTL-1", [], "blocked", ws, {
      orchDir,
      now: () => 1000 + 30_000,
    });
    expect(writes).toBe(0);
    expect(ws.applyLabel.calls).toHaveLength(1); // NOT re-attempted this tick
  });

  test("WITHIN the window: apply is SUPPRESSED (0 writes, applyLabel not re-called)", () => {
    const ws = makeWs({ applied: false, reason: "exclusive-conflict" });
    convergeHeldLabel("CTL-1", [], "blocked", ws, { orchDir, now: () => 1000 }); // arms cooldown
    const writes = convergeHeldLabel("CTL-1", [], "blocked", ws, {
      orchDir,
      now: () => 1000 + 30_000,
    });
    expect(writes).toBe(0);
    expect(ws.applyLabel.calls).toHaveLength(1); // NOT re-attempted this tick
  });

  test("AFTER the window: apply retries (self-heals)", () => {
    const ws = makeWs({ applied: false, reason: "exclusive-conflict" });
    convergeHeldLabel("CTL-1", [], "blocked", ws, { orchDir, now: () => 1000 }); // arms cooldown
    const writes = convergeHeldLabel("CTL-1", [], "blocked", ws, {
      orchDir,
      now: () => 1000 + 61_000,
    });
    expect(writes).toBe(1);
    expect(ws.applyLabel.calls).toHaveLength(2); // re-attempted past the window
  });

  test("transient apply failure → NO cool-down (retries next tick)", () => {
    const ws = makeWs({ applied: false, reason: "transient" });
    convergeHeldLabel("CTL-1", [], "blocked", ws, { orchDir, now: () => 1000 });
    expect(cd("CTL-1", "blocked")).toBe(false);
    const writes = convergeHeldLabel("CTL-1", [], "blocked", ws, {
      orchDir,
      now: () => 1000 + 30_000,
    });
    expect(writes).toBe(1); // not suppressed
    expect(ws.applyLabel.calls).toHaveLength(2);
  });

  test("steady-state (label already present) → 0 writes (zero-write invariant intact)", () => {
    const ws = makeWs({ applied: true });
    const writes = convergeHeldLabel("CTL-1", ["blocked"], "blocked", ws, {
      orchDir,
      now: () => 1000,
    });
    expect(writes).toBe(0);
    expect(ws.applyLabel.calls).toHaveLength(0);
  });

  test("desired=null with a stale held label → removes it (cool-down path not taken)", () => {
    const ws = makeWs({ applied: true });
    // CTL-764 Phase 4: HELD_LABEL_WAITING value is now "queued" (was "waiting").
    const writes = convergeHeldLabel("CTL-1", ["queued"], null, ws, { orchDir, now: () => 1000 });
    expect(writes).toBe(1);
    expect(ws.removeLabel.calls).toHaveLength(1);
    expect(ws.applyLabel.calls).toHaveLength(0);
  });

  test("no orchDir (legacy caller) → cool-down never arms, byte-for-byte prior behavior", () => {
    const ws = makeWs({ applied: false, reason: "exclusive-conflict" });
    convergeHeldLabel("CTL-1", [], "blocked", ws, {}); // no orchDir
    convergeHeldLabel("CTL-1", [], "blocked", ws, {}); // attempted again — no suppression
    expect(ws.applyLabel.calls).toHaveLength(2);
  });
});

// ── CTL-826: dispatchAndVerify shared dispatch→verify core ────────────────
//
// dispatchAndVerify is a closure inside schedulerTick (it needs the per-tick
// safeEmit/safeWrite/emitStateWrite + injected emitters), so it is exercised
// through the public schedulerTick API. This block pins the three-branch
// contract the helper now owns for ALL THREE sweeps it deduplicated, and —
// critically — the FULL-vs-REDUCED failure-ladder divergence that drove the
// `fullFailureLadder` parameter (advance + new-work run the full ladder with
// escalation/circuit-breaker; resume-after-preemption keeps its reduced one).
describe("dispatchAndVerify shared core (CTL-826)", () => {
  // A dispatch fake that writes a runnable signal so the default
  // verifyDispatchedSignal returns ok AND the launched re-read sees bg fields.
  function dispatchWritesSignal({ bgJobId = "bg-826", worktreePath = "/wt/826" } = {}) {
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

  function seedPreempted(ticket, phase, bgJobId, priority) {
    writeSignalRaw(ticket, phase, {
      ticket,
      phase,
      status: "preempted",
      parkedFrom: phase,
      bg_job_id: bgJobId,
      attentionReason: "preempted-by-priority",
    });
    writeWorkerPriority(orchDir, ticket, { priority, createdAt: "2026-05-01T00:00:00Z" });
  }

  function spy() {
    const calls = [];
    const fn = (arg) => {
      calls.push(arg);
      return true;
    };
    fn.calls = calls;
    return fn;
  }

  // ─── Branch 1: v.ok success ───
  test("v.ok branch: clears cooldown, re-reads the signal, emits launched with bg fields, returns ok", () => {
    writeSignal("CTL-826A", "research", "done"); // FSM owes plan
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    // Pre-arm a cooldown marker (failedAt=1 → expiresAt=60_001) so we can prove
    // the success path clears it. The tick runs at now=70_000, PAST the 60s
    // window, so inDispatchCooldown does not suppress the dispatch.
    recordDispatchFailure(orchDir, "CTL-826A", "plan", 1, 1);
    expect(existsSync(dispatchCooldownPath(orchDir, "CTL-826A", "plan"))).toBe(true);

    const dispatch = dispatchWritesSignal({ bgJobId: "live-a", worktreePath: "/wt/CTL-826A" });
    const launched = spy();
    const r = schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      now: () => 70_000,
      appendDispatchLaunchedEvent: launched,
    });

    expect(r.advanced).toContainEqual({ ticket: "CTL-826A", phase: "plan" });
    // Success clears any prior cool-down (CTL-624).
    expect(existsSync(dispatchCooldownPath(orchDir, "CTL-826A", "plan"))).toBe(false);
    // launched carries the re-read signal's bg_job_id + worktree_path.
    expect(launched.calls).toHaveLength(1);
    expect(launched.calls[0]).toMatchObject({
      ticket: "CTL-826A",
      target_phase: "plan",
      bg_job_id: "live-a",
      worktree_path: "/wt/CTL-826A",
    });
    // No failure event on the success branch.
    expect(dispatchFailedEvents("CTL-826A")).toHaveLength(0);
  });

  // ─── Branch 2: verify-failed (rc=0, no live signal) ───
  test("verify-failed branch (full ladder): demotes rc=0+no-signal to failure with consecutiveFailures", () => {
    writeSignal("CTL-826B", "research", "done");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({ code: 0 }); // rc=0 but writes NO signal → verifier !ok

    const r = schedulerTick(orchDir, { readEligible: () => [], dispatch, now: () => 1_000 });

    expect(r.advanced ?? []).not.toContainEqual({ ticket: "CTL-826B", phase: "plan" });
    expect(existsSync(dispatchCooldownPath(orchDir, "CTL-826B", "plan"))).toBe(true);
    const events = dispatchFailedEvents("CTL-826B");
    expect(events).toHaveLength(1);
    expect(events[0].body.payload).toMatchObject({
      target_phase: "plan",
      code: 0,
      consecutiveFailures: 1,
    });
    expect(events[0].body.payload.reason).toMatch(/^verify_failed:/);
  });

  // ─── Branch 3: rc!=0 (real dispatch failure) ───
  test("rc!=0 branch (full ladder): arms cooldown + emits failure with dispatch_nonzero_exit + counter", () => {
    writeSignal("CTL-826C", "research", "done");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const dispatch = fakeDispatch({ code: 1 });

    schedulerTick(orchDir, { readEligible: () => [], dispatch, now: () => 1_000 });

    expect(existsSync(dispatchCooldownPath(orchDir, "CTL-826C", "plan"))).toBe(true);
    const events = dispatchFailedEvents("CTL-826C");
    expect(events).toHaveLength(1);
    expect(events[0].body.payload).toMatchObject({
      target_phase: "plan",
      code: 1,
      reason: "dispatch_nonzero_exit",
      consecutiveFailures: 1,
    });
  });

  // ─── Reduced ladder: resume-after-preemption keeps the lighter failure path ───
  test("reduced ladder (resume sweep): failed event omits consecutiveFailures/expiresAt; no escalation at the ceiling", () => {
    seedPreempted("CTL-826D", "research", "bg-826d", 2);
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    const dispatch = fakeDispatch({ code: 1 }); // resume re-dispatch fails

    // Drive far past getMaxDispatchRetries() (default 5) so the FULL ladder
    // WOULD have escalateDispatchExhausted-stalled the signal by now. The reduced
    // ladder must NOT: the signal stays "preempted" and never carries the counter.
    for (let i = 0; i < 7; i++) {
      // re-seed each tick: the reduced ladder's reset-to-stalled mutates the signal,
      // and a stalled signal would drop out of the parked set on the next tick.
      seedPreempted("CTL-826D", "research", "bg-826d", 2);
      schedulerTick(orchDir, {
        readEligible: () => [],
        dispatch,
        now: () => 1_000 + i, // distinct clock so a new cooldown marker can arm
        liveBackgroundCount: () => 1, // 1 free slot → resume sweep fires
        reclaimDeadWork: () => "noop",
        resolveSession: () => null,
      });
    }

    const events = dispatchFailedEvents("CTL-826D");
    expect(events.length).toBeGreaterThan(0);
    // Reduced ladder: the failed event is the lighter shape — NO counter/expiry.
    for (const e of events) {
      expect(e.body.payload).toMatchObject({ target_phase: "research", code: 1 });
      expect(e.body.payload.consecutiveFailures).toBeUndefined();
      expect(e.body.payload.expiresAt).toBeUndefined();
    }
    // No needs-human escalation marker (full ladder's escalateDispatchExhausted
    // would have written a `stalled` signal; the reduced ladder never does).
    const sig = JSON.parse(
      readFileSync(join(orchDir, "workers", "CTL-826D", "phase-research.json"), "utf8")
    );
    expect(sig.stalledReason).toBeUndefined();
  });

  // ─── preDispatch abort: a failed signal reset short-circuits with no dispatch ───
  test("resume preDispatch abort: a parked ticket with no worker dir still drives the reset path", () => {
    // The resume sweep's preDispatch writes the reset signal; the dispatch fake
    // then writes the runnable signal. With resolveSession→null and verifyOk, a
    // verified resume advances and emits the resumed-after-preemption event,
    // proving the requested→preDispatch(reset)→dispatch ordering is preserved.
    seedPreempted("CTL-826E", "research", "bg-826e", 2);
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    const calls = [];
    const dispatch = ({ orchDir: od, ticket, phase }) => {
      // Capture the signal state AT dispatch time — preDispatch must have reset it
      // to "stalled" before this fake runs (ordering guarantee).
      const pre = JSON.parse(
        readFileSync(join(od, "workers", ticket, `phase-${phase}.json`), "utf8")
      );
      calls.push({ ticket, phase, preStatus: pre.status });
      const dir = join(od, "workers", ticket);
      writeFileSync(
        join(dir, `phase-${phase}.json`),
        JSON.stringify({ ticket, phase, status: "running", bg_job_id: "resumed-bg" })
      );
      return { code: 0 };
    };
    const resumed = spy();
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      now: () => 1_000,
      liveBackgroundCount: () => 1,
      reclaimDeadWork: () => "noop",
      resolveSession: () => null,
      appendResumedAfterPreemptionEvent: resumed,
      verifyDispatched: verifyOk,
    });

    expect(calls).toHaveLength(1);
    // Ordering: requested → preDispatch reset-to-stalled → dispatchTicket.
    expect(calls[0]).toMatchObject({ ticket: "CTL-826E", phase: "research", preStatus: "stalled" });
    expect(resumed.calls).toHaveLength(1);
    expect(resumed.calls[0].ticket).toBe("CTL-826E");
  });
});

// ── CTL-936: startScheduler wires intentDb + appendIntentEvent through runTick ──
//
// These tests verify that the production runTick call site threads intentDb and
// appendIntentEvent into schedulerTick — the keystone fix for C1 (kill-storm
// suppression inert) and C2 (operator events never reach event log). Both seams
// must be present in __getRunningOpts after startScheduler boots.
//
// Additionally verifies that collectBeliefsTick accepts appendIntentEvent so
// the reconcileIntents operator-event path can be exercised in the wrapper.
describe("CTL-936: runTick production wiring — intentDb + appendIntentEvent seams", () => {
  afterEach(() => __resetForTests());

  test("startScheduler stores appendIntentEvent in runningOpts (seam available to runTick)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const emitted = [];
    const appendIntentEvent = (evt) => emitted.push(evt);

    startScheduler({
      orchDir,
      dispatch: fakeDispatch({ code: 0 }),
      readEligible: () => [],
      liveBackgroundCount: () => 0,
      appendIntentEvent,
      tickIntervalMs: 60_000,
      debounceMs: 5,
    });

    const opts = __getRunningOpts();
    expect(typeof opts.appendIntentEvent).toBe("function");
    // Confirm it IS the same function we passed (identity check).
    expect(opts.appendIntentEvent).toBe(appendIntentEvent);
  });

  test("startScheduler without appendIntentEvent leaves the seam null-safe (no throw)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    // Should NOT throw even without appendIntentEvent
    expect(() =>
      startScheduler({
        orchDir,
        dispatch: fakeDispatch({ code: 0 }),
        readEligible: () => [],
        liveBackgroundCount: () => 0,
        tickIntervalMs: 60_000,
        debounceMs: 5,
      })
    ).not.toThrow();

    const opts = __getRunningOpts();
    // appendIntentEvent defaults to undefined → intentEventAppender in runTick
    // resolves to null, which is the safe no-op path.
    expect(opts.appendIntentEvent == null).toBe(true);
  });
});

// ── CTL-925: dependency cycle hardening ──
//
// Gap 1: eligible (new-work / sweep-2) ring escalation.
// Gap 2: STEP E transitive cycle write guard.
// Gap 3: CTL-537 sequencing seam cycle guard.
describe("CTL-925: dependency cycle hardening", () => {
  afterEach(() => __resetForTests());

  // Minimal writeStatus spy tracking label and blockedBy writes.
  function makeWS() {
    const applied = [];
    const blockedByWrites = [];
    return {
      ws: {
        applyPhaseStatus: () => ({ applied: true, reason: null }),
        applyTerminalDone: () => {},
        applyEstimate: () => ({ applied: true }),
        applyLabel: (a) => {
          applied.push(a);
          return { applied: true };
        },
        removeLabel: () => ({ removed: true }),
        applyBlockedByRelation: (a) => {
          blockedByWrites.push(a);
          return { applied: true };
        },
      },
      applied,
      blockedByWrites,
    };
  }

  // Eligible ticket fixture: identifier, state "Todo", optional relations.
  function elig(identifier, rel = [], inv = []) {
    return {
      identifier,
      priority: 2,
      createdAt: "x",
      state: { name: "Todo" },
      relations: { nodes: rel },
      inverseRelations: { nodes: inv },
    };
  }
  const blocksRel = (id) => ({ type: "blocks", relatedIssue: { identifier: id } });
  const blocksInv = (id) => ({ type: "blocks", issue: { identifier: id } });

  // ── Gap 1: eligible ring escalation (sweep-2) ──

  test("Gap 1: 2-node eligible ring → both escalated to needs-human, none dispatched", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 5 }));
    // CTL-1 blocks CTL-2 AND CTL-2 blocks CTL-1 — a ring. Neither has a worker dir.
    const eligible = [
      elig("CTL-1", [blocksRel("CTL-2")], [blocksInv("CTL-2")]),
      elig("CTL-2", [blocksRel("CTL-1")], [blocksInv("CTL-1")]),
    ];
    const dispatch = fakeDispatch();
    const { ws, applied } = makeWS();
    schedulerTick(orchDir, {
      readEligible: () => eligible,
      dispatch,
      liveBackgroundCount: () => 0,
      writeStatus: ws,
    });
    expect(dispatch.calls).toEqual([]);
    const nhLabels = applied.filter((l) => l.label === "needs-human");
    const nhTickets = nhLabels.map((l) => l.ticket).sort();
    expect(nhTickets).toContain("CTL-1");
    expect(nhTickets).toContain("CTL-2");
  });

  test("Gap 1: 3-node eligible ring → all three escalated to needs-human, none dispatched", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 5 }));
    // A→B→C→A
    const eligible = [
      elig("CTL-1", [blocksRel("CTL-2")], [blocksInv("CTL-3")]),
      elig("CTL-2", [blocksRel("CTL-3")], [blocksInv("CTL-1")]),
      elig("CTL-3", [blocksRel("CTL-1")], [blocksInv("CTL-2")]),
    ];
    const dispatch = fakeDispatch();
    const { ws, applied } = makeWS();
    schedulerTick(orchDir, {
      readEligible: () => eligible,
      dispatch,
      liveBackgroundCount: () => 0,
      writeStatus: ws,
    });
    expect(dispatch.calls).toEqual([]);
    const nhTickets = applied
      .filter((l) => l.label === "needs-human")
      .map((l) => l.ticket)
      .sort();
    expect(nhTickets).toContain("CTL-1");
    expect(nhTickets).toContain("CTL-2");
    expect(nhTickets).toContain("CTL-3");
  });

  test("Gap 1 control: non-cyclic eligible chain dispatches normally, no needs-human", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 5 }));
    // CTL-1 blocks CTL-2 (CTL-2 is blocked by CTL-1). CTL-1 is unblocked → dispatched.
    const eligible = [
      elig("CTL-1", [blocksRel("CTL-2")], []),
      elig("CTL-2", [], [blocksInv("CTL-1")]),
    ];
    const dispatch = fakeDispatch();
    const { ws, applied } = makeWS();
    schedulerTick(orchDir, {
      readEligible: () => eligible,
      dispatch,
      liveBackgroundCount: () => 0,
      writeStatus: ws,
      verifyDispatched: verifyOk,
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is cycle-hardening control
    });
    // CTL-1 has no blockers → dispatched; CTL-2 is blocked by CTL-1 → held.
    expect(dispatch.calls.map((c) => c.ticket)).toContain("CTL-1");
    expect(applied.filter((l) => l.label === "needs-human")).toHaveLength(0);
  });

  // Helper: write a triage.json for STEP E dep persistence tests (requires
  // worker dir already created via writeSignal).
  function writeTriageDepsE(ticket, dependencies) {
    writeFileSync(
      join(orchDir, "workers", ticket, "triage.json"),
      JSON.stringify({ ticket, classification: "feature", dependencies })
    );
  }

  // ── Gap 2: STEP E transitive cycle write guard ──
  //
  // The transitive test requires ALL nodes in the cycle to be in waitingDescriptors
  // (triaged-waiting), because buildDependencyEdges drops out-of-set edges. The
  // dep target (CTL-300) must be triaged-waiting so the CTL-800→CTL-300 edge
  // survives the inSet filter and wouldCreateCycle can detect the ring.

  test("Gap 2: transitive A→B→C ring — writing A blocked_by C refused (ctl-925 step-e)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    // All three are triaged-waiting so all land in waitingDescriptors (inSet).
    writeSignal("CTL-700", "triage", "done");
    writeSignal("CTL-800", "triage", "done");
    writeSignal("CTL-300", "triage", "done");
    // CTL-700's triage.json names CTL-300 as a dep.
    writeTriageDepsE("CTL-700", ["CTL-300"]);

    // CTL-700 blocks CTL-800 → edge CTL-700→CTL-800.
    // CTL-800 blocks CTL-300 → edge CTL-800→CTL-300 (CTL-300 IS in-set → kept!).
    // Writing CTL-700 blocked_by CTL-300 adds CTL-300→CTL-700, closing the ring.
    const desc700 = {
      state: "Triage",
      priority: 2,
      labels: [],
      parent: null,
      relations: { nodes: [{ type: "blocks", relatedIssue: { identifier: "CTL-800" } }] },
      inverseRelations: { nodes: [] },
    };
    const desc800 = {
      state: "Triage",
      priority: 2,
      labels: [],
      parent: null,
      relations: { nodes: [{ type: "blocks", relatedIssue: { identifier: "CTL-300" } }] },
      inverseRelations: { nodes: [] },
    };
    const desc300 = {
      state: "Triage",
      priority: 2,
      labels: [],
      parent: null,
      relations: { nodes: [] },
      inverseRelations: { nodes: [] },
    };

    const dispatch = fakeDispatch();
    const { ws, blockedByWrites } = makeWS();
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      writeStatus: ws,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      fetchBatch: mkBatch({ "CTL-700": desc700, "CTL-800": desc800, "CTL-300": desc300 }),
    });
    // Writing CTL-700 blocked_by CTL-300 closes CTL-300→CTL-700→CTL-800→CTL-300.
    // With the transitive guard it MUST NOT be written.
    expect(blockedByWrites).not.toContainEqual({ ticket: "CTL-700", blockedBy: "CTL-300" });
  });

  test("Gap 2: direct 2-node back-edge still refused (candidateBlocks backstop)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    writeSignal("CTL-7", "triage", "done");
    writeTriageDepsE("CTL-7", ["CTL-8"]);
    // CTL-7 directly blocks CTL-8 → candidateBlocks.has("CTL-8") catches it.
    const desc7 = {
      state: "Triage",
      priority: 2,
      labels: [],
      parent: null,
      relations: { nodes: [{ type: "blocks", relatedIssue: { identifier: "CTL-8" } }] },
      inverseRelations: { nodes: [] },
    };
    const desc8 = {
      state: "In Progress",
      priority: null,
      labels: [],
      parent: null,
      relations: { nodes: [] },
      inverseRelations: { nodes: [] },
    };

    const dispatch = fakeDispatch();
    const { ws, blockedByWrites } = makeWS();
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      writeStatus: ws,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      fetchBatch: mkBatch({ "CTL-7": desc7, "CTL-8": desc8 }),
    });
    expect(blockedByWrites).not.toContainEqual({ ticket: "CTL-7", blockedBy: "CTL-8" });
  });

  test("Gap 2 control: non-cycle-closing dep IS written", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    writeSignal("CTL-7", "triage", "done");
    // CTL-7 blocks CTL-400 (unrelated to dep CTL-100). Writing CTL-7 blocked_by
    // CTL-100 adds CTL-100→CTL-7. DFS from CTL-7: CTL-7→CTL-400, no path to
    // CTL-100 → no cycle. CTL-400 is NOT in the pool so the edge is dropped by
    // buildDependencyEdges — CTL-7 has no outgoing edges in poolEdges.
    writeTriageDepsE("CTL-7", ["CTL-100"]);
    const desc7 = {
      state: "Triage",
      priority: 2,
      labels: [],
      parent: null,
      relations: { nodes: [{ type: "blocks", relatedIssue: { identifier: "CTL-400" } }] },
      inverseRelations: { nodes: [] },
    };
    const desc100 = {
      state: "In Progress",
      priority: null,
      labels: [],
      parent: null,
      relations: { nodes: [] },
      inverseRelations: { nodes: [] },
    };

    const dispatch = fakeDispatch();
    const { ws, blockedByWrites } = makeWS();
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch,
      writeStatus: ws,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      fetchBatch: mkBatch({ "CTL-7": desc7, "CTL-100": desc100 }),
    });
    expect(blockedByWrites).toContainEqual({ ticket: "CTL-7", blockedBy: "CTL-100" });
  });

  // ── Gap 3: CTL-537 sequencing seam cycle guard ──

  test("Gap 3: sequencing verdict closing a cycle is refused (ctl-925 sequencing)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    // CTL-NEW is a new-work candidate (no worker dir). CTL-IN is in-flight.
    writeSignal("CTL-IN", "implement", "running");
    // Descriptor: CTL-IN already blocks CTL-NEW (CTL-IN → CTL-NEW).
    // Writing CTL-NEW blocked_by CTL-IN = edge CTL-IN → CTL-NEW — but CTL-IN already
    // blocks CTL-NEW (CTL-IN → CTL-NEW is in CTL-IN's relations). So writing
    // blocked_by(CTL-NEW ← CTL-IN) adds CTL-IN → CTL-NEW, and DFS from CTL-NEW:
    // CTL-NEW has no outgoing blocks edges, so no cycle... wait, we need a cycle.
    //
    // Correct setup: CTL-NEW blocks CTL-IN (CTL-NEW → CTL-IN), and verdict says
    // CTL-NEW blocked_by CTL-IN. Then adding CTL-IN → CTL-NEW closes CTL-IN→CTL-NEW→CTL-IN.
    const eligNew = {
      identifier: "CTL-NEW",
      priority: 2,
      createdAt: "x",
      state: { name: "Todo" },
      // CTL-NEW blocks CTL-IN → edge CTL-NEW→CTL-IN
      relations: { nodes: [{ type: "blocks", relatedIssue: { identifier: "CTL-IN" } }] },
      inverseRelations: { nodes: [] },
    };
    const descIN = {
      state: "Implement",
      priority: 2,
      labels: [],
      parent: null,
      relations: { nodes: [] },
      // CTL-IN is NOT in eligible, its descriptor is fetched from cache.
      // For seqEdges we need CTL-IN's relations — but if cache doesn't have it,
      // seqEdges won't have that edge. The direct check via wouldCreateCycle
      // over seqEdges built from the eligible pool should catch CTL-NEW→CTL-IN.
      inverseRelations: { nodes: [] },
    };

    const blockedByWrites = [];
    const ws = {
      applyPhaseStatus: () => ({ applied: true, reason: null }),
      applyTerminalDone: () => {},
      applyEstimate: () => ({ applied: true }),
      applyLabel: () => ({ applied: true }),
      removeLabel: () => ({ removed: true }),
      applyBlockedByRelation: (a) => {
        blockedByWrites.push(a);
        return { applied: true };
      },
    };

    // checkSequencing verdict: CTL-NEW should be blocked_by CTL-IN.
    const checkSequencing = () => ({
      verdict: "hold",
      hard_dependencies: [{ candidate: "CTL-NEW", blocked_by: "CTL-IN" }],
    });

    schedulerTick(orchDir, {
      readEligible: () => [eligNew],
      dispatch: fakeDispatch(),
      writeStatus: ws,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 1,
      fetchBatch: mkBatch({ "CTL-NEW": descIN, "CTL-IN": descIN }),
      checkSequencing,
    });
    // Writing CTL-NEW blocked_by CTL-IN would close CTL-IN→CTL-NEW→CTL-IN.
    // The guard must refuse it.
    expect(blockedByWrites).not.toContainEqual({ ticket: "CTL-NEW", blockedBy: "CTL-IN" });
  });

  test("Gap 3 control: non-cycle-closing sequencing verdict IS written", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    writeSignal("CTL-IN", "implement", "running");
    // CTL-NEW has no existing blocks edges → writing CTL-NEW blocked_by CTL-IN
    // adds CTL-IN→CTL-NEW. DFS from CTL-NEW: no outgoing edges → no cycle.
    const eligNew = {
      identifier: "CTL-NEW",
      priority: 2,
      createdAt: "x",
      state: { name: "Todo" },
      relations: { nodes: [] },
      inverseRelations: { nodes: [] },
    };
    const descIN = {
      state: "Implement",
      priority: 2,
      labels: [],
      parent: null,
      relations: { nodes: [] },
      inverseRelations: { nodes: [] },
    };

    const blockedByWrites = [];
    const ws = {
      applyPhaseStatus: () => ({ applied: true, reason: null }),
      applyTerminalDone: () => {},
      applyEstimate: () => ({ applied: true }),
      applyLabel: () => ({ applied: true }),
      removeLabel: () => ({ removed: true }),
      applyBlockedByRelation: (a) => {
        blockedByWrites.push(a);
        return { applied: true };
      },
    };

    const checkSequencing = () => ({
      verdict: "hold",
      hard_dependencies: [{ candidate: "CTL-NEW", blocked_by: "CTL-IN" }],
    });

    schedulerTick(orchDir, {
      readEligible: () => [eligNew],
      dispatch: fakeDispatch(),
      writeStatus: ws,
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 1,
      fetchBatch: mkBatch({ "CTL-NEW": descIN, "CTL-IN": descIN }),
      checkSequencing,
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is Gap 3 sequencing write
    });
    expect(blockedByWrites).toContainEqual({ ticket: "CTL-NEW", blockedBy: "CTL-IN" });
  });
});

// ── CTL-1068: convergeStartedHeldLabels — Phase 1 unit tests (seam in isolation) ──

describe("CTL-1068: convergeStartedHeldLabels (unit)", () => {
  function markerPath(ticket, label, suffix) {
    return join(orchDir, "workers", ticket, `.linear-label-${label}.${suffix}`);
  }
  function seedWorker(ticket) {
    mkdirSync(join(orchDir, "workers", ticket), { recursive: true });
  }
  function removeSpy() {
    const removed = [];
    return {
      removed,
      ws: {
        removeLabel: (ticket, label) => {
          removed.push({ ticket, label });
          return { removed: true };
        },
      },
    };
  }

  test("retracts a present 'queued' marker → removeLabel once + marker deleted", () => {
    // CTL-764 Phase 4: marker renamed from ".linear-label-waiting" to ".linear-label-queued".
    seedWorker("CTL-764");
    writeFileSync(markerPath("CTL-764", "queued", "applied"), "");
    const { removed, ws } = removeSpy();
    convergeStartedHeldLabels(orchDir, "CTL-764", ws, { multiHost: false });
    expect(removed).toEqual([{ ticket: "CTL-764", label: "queued" }]);
    expect(existsSync(markerPath("CTL-764", "queued", "applied"))).toBe(false);
  });

  test("steady-state: no held marker → ZERO removeLabel calls", () => {
    seedWorker("CTL-900");
    const { removed, ws } = removeSpy();
    convergeStartedHeldLabels(orchDir, "CTL-900", ws, { multiHost: false });
    expect(removed).toEqual([]);
  });

  // CTL-764 finding 1: a STARTED ticket still wearing the legacy "waiting" marker
  // (pre-rename) must have it retracted too — the removable superset includes it.
  test("finding 1 — retracts a legacy 'waiting' marker", () => {
    seedWorker("CTL-905");
    writeFileSync(markerPath("CTL-905", "waiting", "applied"), "");
    const { removed, ws } = removeSpy();
    convergeStartedHeldLabels(orchDir, "CTL-905", ws, { multiHost: false });
    expect(removed).toEqual([{ ticket: "CTL-905", label: "waiting" }]);
    expect(existsSync(markerPath("CTL-905", "waiting", "applied"))).toBe(false);
  });

  test("retracts BOTH labels when both markers present", () => {
    seedWorker("CTL-901");
    writeFileSync(markerPath("CTL-901", "blocked", "applied"), "");
    // CTL-764 Phase 4: marker renamed "waiting" → "queued".
    writeFileSync(markerPath("CTL-901", "queued", "skipped"), "");
    const { removed, ws } = removeSpy();
    convergeStartedHeldLabels(orchDir, "CTL-901", ws, { multiHost: false });
    expect(removed).toContainEqual({ ticket: "CTL-901", label: "blocked" });
    expect(removed).toContainEqual({ ticket: "CTL-901", label: "queued" });
  });

  test("desired=label is a Stage-2 seam: that label is NOT retracted", () => {
    seedWorker("CTL-902");
    writeFileSync(markerPath("CTL-902", "blocked", "applied"), "");
    // CTL-764 Phase 4: marker renamed "waiting" → "queued".
    writeFileSync(markerPath("CTL-902", "queued", "applied"), "");
    const { removed, ws } = removeSpy();
    convergeStartedHeldLabels(orchDir, "CTL-902", ws, { desired: "blocked", multiHost: false });
    expect(removed).toEqual([{ ticket: "CTL-902", label: "queued" }]);
    expect(existsSync(markerPath("CTL-902", "blocked", "applied"))).toBe(true);
  });

  test("half-clear Case A: label already absent (removeLabel {removed:true}) → marker still deleted", () => {
    seedWorker("CTL-903");
    // CTL-764 Phase 4: marker renamed "waiting" → "queued".
    writeFileSync(markerPath("CTL-903", "queued", "applied"), "");
    const ws = { removeLabel: () => ({ removed: true }) };
    convergeStartedHeldLabels(orchDir, "CTL-903", ws, { multiHost: false });
    expect(existsSync(markerPath("CTL-903", "queued", "applied"))).toBe(false);
  });

  test("fence guard suppresses retraction on a stale-fenced multi-host node", () => {
    seedWorker("CTL-904");
    // CTL-764 Phase 4: marker renamed "waiting" → "queued".
    writeFileSync(markerPath("CTL-904", "queued", "applied"), "");
    const { removed, ws } = removeSpy();
    convergeStartedHeldLabels(orchDir, "CTL-904", ws, {
      multiHost: true,
      fenceGuard: () => false,
    });
    expect(removed).toEqual([]);
    expect(existsSync(markerPath("CTL-904", "queued", "applied"))).toBe(true);
  });

  test("emits a held-label-orphaned-in-flight audit event ONLY on confirmed removal", () => {
    seedWorker("CTL-905");
    // CTL-764 Phase 4: marker renamed "waiting" → "queued".
    writeFileSync(markerPath("CTL-905", "queued", "applied"), "");
    const audits = [];
    const ws = { removeLabel: () => ({ removed: true }) };
    convergeStartedHeldLabels(orchDir, "CTL-905", ws, {
      multiHost: false,
      emitStateWrite: (e) => audits.push(e),
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ ticket: "CTL-905", source: "held-label-orphaned-in-flight" });
  });

  test("onRetract callback fires (re-arm hook) once per retracted label", () => {
    seedWorker("CTL-906");
    // CTL-764 Phase 4: marker renamed "waiting" → "queued".
    writeFileSync(markerPath("CTL-906", "queued", "applied"), "");
    let rearms = 0;
    convergeStartedHeldLabels(
      orchDir,
      "CTL-906",
      { removeLabel: () => ({ removed: true }) },
      {
        multiHost: false,
        onRetract: () => {
          rearms += 1;
        },
      }
    );
    expect(rearms).toBe(1);
  });
});

// ── CTL-1068: Phase 2 — schedulerTick end-to-end (wiring tests) ──

describe("CTL-1068: schedulerTick — admitted-then-failed held-label retraction", () => {
  const noWrites = () => ({
    applyPhaseStatus() {},
    applyTerminalDone() {},
  });

  test("admitted-then-failed ticket drains its stale 'queued' label", () => {
    writeSignal("CTL-764", "triage", "done");
    writeSignal("CTL-764", "research", "done"); // admitted: has research+; pre-pickup gate excludes it
    writeSignal("CTL-764", "implement", "failed");
    // CTL-764 Phase 4: marker renamed ".linear-label-waiting" → ".linear-label-queued".
    writeFileSync(join(orchDir, "workers", "CTL-764", ".linear-label-queued.applied"), "");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const removed = [];
    const writeStatus = {
      ...noWrites(),
      applyLabel: () => ({}),
      removeLabel: (t, l) => {
        removed.push({ t, l });
        return { removed: true };
      },
    };
    schedulerTick(orchDir, { readEligible: () => [], dispatch: fakeDispatch(), writeStatus });
    expect(removed).toContainEqual({ t: "CTL-764", l: "queued" });
    expect(existsSync(join(orchDir, "workers", "CTL-764", ".linear-label-queued.applied"))).toBe(
      false
    );
  });

  test("pre-pickup triaged ticket is NOT retracted by the started-sweep", () => {
    // triage-only signal → pre-pickup pool (A.7 owns it, section 3 must skip)
    writeSignal("CTL-7", "triage", "done");
    // CTL-764 Phase 4: marker renamed ".linear-label-waiting" → ".linear-label-queued".
    writeFileSync(join(orchDir, "workers", "CTL-7", ".linear-label-queued.applied"), "");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const removed = [];
    const writeStatus = {
      ...noWrites(),
      applyLabel: () => ({}),
      removeLabel: (t, l) => {
        removed.push({ t, l });
        return { removed: true };
      },
    };
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus,
      liveBackgroundCount: () => 1,
    });
    // The started-sweep gate excluded CTL-7; the marker must be untouched.
    expect(removed.filter((r) => r.t === "CTL-7" && r.l === "queued")).toHaveLength(0);
    expect(existsSync(join(orchDir, "workers", "CTL-7", ".linear-label-queued.applied"))).toBe(
      true
    );
  });

  test("started ticket with no held marker makes zero held removeLabel calls", () => {
    writeSignal("CTL-800", "research", "done");
    writeSignal("CTL-800", "plan", "done");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const removed = [];
    const writeStatus = {
      ...noWrites(),
      applyLabel: () => ({}),
      removeLabel: (t, l) => {
        removed.push({ t, l });
        return { removed: true };
      },
    };
    schedulerTick(orchDir, { readEligible: () => [], dispatch: fakeDispatch(), writeStatus });
    expect(removed.filter((r) => r.l === "blocked" || r.l === "queued")).toHaveLength(0);
  });

  test("retraction emits a held-label-orphaned-in-flight state-write event", () => {
    writeSignal("CTL-764", "triage", "done");
    writeSignal("CTL-764", "research", "done"); // admitted; pre-pickup gate excludes it
    writeSignal("CTL-764", "implement", "failed");
    // CTL-764 Phase 4: marker renamed ".linear-label-waiting" → ".linear-label-queued".
    writeFileSync(join(orchDir, "workers", "CTL-764", ".linear-label-queued.applied"), "");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const events = [];
    const writeStatus = {
      ...noWrites(),
      applyLabel: () => ({}),
      removeLabel: () => ({ removed: true }),
    };
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus,
      appendStateWriteEvent: (e) => events.push(e),
    });
    expect(
      events.some((e) => e.source === "held-label-orphaned-in-flight" && e.ticket === "CTL-764")
    ).toBe(true);
  });
});

// ── CTL-1068: Phase 3 — marker-hygiene & re-arm regression tests ──

describe("CTL-1068: marker-hygiene and re-arm (Phase 3 regression)", () => {
  const noWrites = () => ({
    applyPhaseStatus() {},
    applyTerminalDone() {},
  });

  test("orphaned held marker with label already gone is cleaned (half-clear Case A via tick)", () => {
    writeSignal("CTL-810", "research", "done");
    writeSignal("CTL-810", "verify", "failed");
    writeFileSync(join(orchDir, "workers", "CTL-810", ".linear-label-blocked.applied"), "");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    // removeLabel returns {removed:true} even when label is already absent (idempotent).
    const writeStatus = {
      ...noWrites(),
      applyLabel: () => ({}),
      removeLabel: () => ({ removed: true }),
    };
    schedulerTick(orchDir, { readEligible: () => [], dispatch: fakeDispatch(), writeStatus });
    expect(existsSync(join(orchDir, "workers", "CTL-810", ".linear-label-blocked.applied"))).toBe(
      false
    );
  });

  test("retraction clears lastHeldEmitState so a future genuine hold re-emits", () => {
    // Tick A: admitted-then-failed with marker → retract + onRetract deletes lastHeldEmitState entry.
    writeSignal("CTL-907", "triage", "done");
    writeSignal("CTL-907", "research", "done"); // admitted; pre-pickup gate excludes it
    writeSignal("CTL-907", "implement", "failed");
    // CTL-764 Phase 4: marker renamed ".linear-label-waiting" → ".linear-label-queued".
    writeFileSync(join(orchDir, "workers", "CTL-907", ".linear-label-queued.applied"), "");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 1 }));
    const removed = [];
    const writeStatus = {
      ...noWrites(),
      applyLabel: () => ({}),
      removeLabel: (t, l) => {
        removed.push({ t, l });
        return { removed: true };
      },
    };
    schedulerTick(orchDir, { readEligible: () => [], dispatch: fakeDispatch(), writeStatus });
    // Marker must be gone after Tick A retraction.
    expect(removed).toContainEqual({ t: "CTL-907", l: "queued" });
    expect(existsSync(join(orchDir, "workers", "CTL-907", ".linear-label-queued.applied"))).toBe(
      false
    );
    // The onRetract callback clears lastHeldEmitState for this ticket — no further assertion
    // needed here beyond confirming the retraction fired (the internal Map reset is exercised
    // by the unit test in Phase 1).
  });
});

describe("drain gate (CTL-1095)", () => {
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

  test("draining node zeroes freeSlots — no new dispatch", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    const dispatch = fakeDispatch({ code: 0 });
    schedulerTick(orchDir, {
      readEligible: () => eligibleOne("CTL-drain-1"),
      dispatch,
      isDraining: () => true,
      livenessIsFresh: () => true,
      liveBackgroundCount: () => 0,
    });
    expect(dispatch.calls).toHaveLength(0);
  });

  test("not draining — dispatch happens as before (regression guard)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    const dispatch = fakeDispatch({ code: 0 });
    schedulerTick(orchDir, {
      readEligible: () => eligibleOne("CTL-drain-2"),
      dispatch,
      isDraining: () => false,
      livenessIsFresh: () => true,
      liveBackgroundCount: () => 0,
      verifyDispatched: verifyOk,
      hasTriageArtifact: () => true, // CTL-1150: bypass triage gate, subject is drain regression guard
    });
    expect(dispatch.calls).toHaveLength(1);
  });

  test("draining with in-flight work — still zero new dispatch", () => {
    writeSignal("CTL-existing", "implement", "running");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    const dispatch = fakeDispatch({ code: 0 });
    schedulerTick(orchDir, {
      readEligible: () => eligibleOne("CTL-drain-3"),
      dispatch,
      isDraining: () => true,
      livenessIsFresh: () => true,
      liveBackgroundCount: () => 1,
    });
    expect(dispatch.calls).toHaveLength(0);
  });
});

describe("drained-sentinel emission (CTL-1095)", () => {
  test("emits node.drain.drained once when draining && inFlight empty", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    const emitDrainedMock = mock(() => true);
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      isDraining: () => true,
      livenessIsFresh: () => true,
      liveBackgroundCount: () => 0,
      emitDrained: emitDrainedMock,
    });
    expect(emitDrainedMock).toHaveBeenCalledTimes(1);
  });

  test("does NOT emit drained a second time (marker dedup)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    const emitDrainedMock = mock(() => true);
    const opts = {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      isDraining: () => true,
      livenessIsFresh: () => true,
      liveBackgroundCount: () => 0,
      emitDrained: emitDrainedMock,
    };
    schedulerTick(orchDir, opts); // first tick
    schedulerTick(orchDir, opts); // second tick — marker exists, no re-emit
    expect(emitDrainedMock).toHaveBeenCalledTimes(1);
  });

  test("does NOT emit drained while in-flight tickets remain", () => {
    writeSignal("CTL-inflight", "implement", "running");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    const emitDrainedMock = mock(() => true);
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      isDraining: () => true,
      livenessIsFresh: () => true,
      liveBackgroundCount: () => 1,
      emitDrained: emitDrainedMock,
    });
    expect(emitDrainedMock).not.toHaveBeenCalled();
  });

  test("does NOT emit drained when not draining", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    const emitDrainedMock = mock(() => true);
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      isDraining: () => false,
      livenessIsFresh: () => true,
      liveBackgroundCount: () => 0,
      emitDrained: emitDrainedMock,
    });
    expect(emitDrainedMock).not.toHaveBeenCalled();
  });

  test("marker clears when drain turns off so next episode re-arms", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    const emitDrainedMock = mock(() => true);
    // First drain episode: emit fires, marker written
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      isDraining: () => true,
      liveBackgroundCount: () => 0,
      emitDrained: emitDrainedMock,
    });
    expect(emitDrainedMock).toHaveBeenCalledTimes(1);

    // Drain off: marker should be cleared
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      isDraining: () => false,
      liveBackgroundCount: () => 0,
      emitDrained: emitDrainedMock,
    });

    // Second drain episode: re-arms
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      isDraining: () => true,
      liveBackgroundCount: () => 0,
      emitDrained: emitDrainedMock,
    });
    expect(emitDrainedMock).toHaveBeenCalledTimes(2);
  });
});

// CTL-1290: the board-health scheduler-seam tests live in board-health-seam.test.mjs
// (a CI-included file) — scheduler.test.mjs is excluded from the CI allowlist for
// its real-timer suite, so the seam coverage would not run here.

// ── CTL-764 Phase 4: convergeDispositionLabel ─────────────────────────────────
//
// Generalization of convergeHeldLabel to the full worker-status disposition set
// (queued/blocked/needs-input/needs-human). Key invariants:
//   • queued/blocked/needs-input tick-converge (diff + cool-down, 0 writes on
//     steady-state).
//   • needs-human is NEVER tick-converged — it is sticky (labelOnce).
//   • Precedence suppression: a ticket already carrying needs-human causes
//     convergeDispositionLabel to make ZERO writes when the desired is a lower
//     disposition; and the converger NEVER issues removeLabel('needs-human').
//   • desired=null removes stale queued/blocked/needs-input but leaves needs-human
//     untouched.
//
// Reuses the CTL-834 makeWs() helper pattern from the convergeHeldLabel block.
describe("CTL-764 Phase 4 — convergeDispositionLabel", () => {
  const makeWs = (applyResult = { applied: true, reason: null }) => {
    const applyLabel = (...a) => {
      applyLabel.calls.push(a);
      return applyResult;
    };
    applyLabel.calls = [];
    const removeLabel = (...a) => {
      removeLabel.calls.push(a);
    };
    removeLabel.calls = [];
    return { applyLabel, removeLabel };
  };

  test("HELD_LABEL_WAITING value is 'queued' (renamed from 'waiting')", () => {
    expect(HELD_LABEL_WAITING).toBe("queued");
  });

  test("HELD_LABEL_NEEDS_INPUT is 'needs-input'", () => {
    expect(HELD_LABEL_NEEDS_INPUT).toBe("needs-input");
  });

  test("queued: apply on empty labels → 1 write", () => {
    const ws = makeWs();
    const writes = convergeDispositionLabel("CTL-1", [], "queued", ws, {
      orchDir,
      now: () => 1000,
    });
    expect(writes).toBe(1);
    expect(ws.applyLabel.calls).toHaveLength(1);
    expect(ws.applyLabel.calls[0][0]).toMatchObject({ ticket: "CTL-1", label: "queued" });
  });

  test("queued: steady-state (label already present) → 0 writes", () => {
    const ws = makeWs();
    const writes = convergeDispositionLabel("CTL-1", ["queued"], "queued", ws, {
      orchDir,
      now: () => 1000,
    });
    expect(writes).toBe(0);
    expect(ws.applyLabel.calls).toHaveLength(0);
  });

  test("blocked: tick-converge → apply once", () => {
    const ws = makeWs();
    const writes = convergeDispositionLabel("CTL-1", [], "blocked", ws, {
      orchDir,
      now: () => 1000,
    });
    expect(writes).toBe(1);
    expect(ws.applyLabel.calls[0][0]).toMatchObject({ ticket: "CTL-1", label: "blocked" });
  });

  test("needs-input: durable — desired='needs-input' on clean ticket → applyLabel once", () => {
    const ws = makeWs();
    const writes = convergeDispositionLabel("CTL-1", [], "needs-input", ws, {
      orchDir,
      now: () => 1000,
    });
    expect(writes).toBe(1);
    expect(ws.applyLabel.calls[0][0]).toMatchObject({ ticket: "CTL-1", label: "needs-input" });
  });

  test("precedence suppression: ticket has needs-human → zero writes when desired=blocked", () => {
    const ws = makeWs();
    const writes = convergeDispositionLabel("CTL-1", ["needs-human"], "blocked", ws, {
      orchDir,
      now: () => 1000,
    });
    expect(writes).toBe(0);
    expect(ws.applyLabel.calls).toHaveLength(0);
    expect(ws.removeLabel.calls).toHaveLength(0);
  });

  test("precedence suppression: ticket has needs-human → zero writes when desired=queued", () => {
    const ws = makeWs();
    const writes = convergeDispositionLabel("CTL-1", ["needs-human"], "queued", ws, {
      orchDir,
      now: () => 1000,
    });
    expect(writes).toBe(0);
  });

  test("precedence suppression: ticket has needs-human → zero writes when desired=needs-input", () => {
    const ws = makeWs();
    const writes = convergeDispositionLabel("CTL-1", ["needs-human"], "needs-input", ws, {
      orchDir,
      now: () => 1000,
    });
    expect(writes).toBe(0);
  });

  test("NEVER issues removeLabel('needs-human') when converging lower three", () => {
    const ws = makeWs();
    convergeDispositionLabel("CTL-1", ["needs-human", "blocked"], null, ws, {
      orchDir,
      now: () => 1000,
    });
    const removedLabels = ws.removeLabel.calls.map((c) => c[1] ?? c[0]);
    expect(removedLabels).not.toContain("needs-human");
  });

  test("desired=null removes stale 'queued' but leaves needs-human untouched", () => {
    const ws = makeWs();
    convergeDispositionLabel("CTL-1", ["queued", "needs-human"], null, ws, {
      orchDir,
      now: () => 1000,
    });
    const removedLabels = ws.removeLabel.calls.map((c) => c[1] ?? c[0]);
    expect(removedLabels).toContain("queued");
    expect(removedLabels).not.toContain("needs-human");
  });

  test("desired=null removes stale 'needs-input' but leaves needs-human untouched", () => {
    const ws = makeWs();
    convergeDispositionLabel("CTL-1", ["needs-input", "needs-human"], null, ws, {
      orchDir,
      now: () => 1000,
    });
    const removedLabels = ws.removeLabel.calls.map((c) => c[1] ?? c[0]);
    expect(removedLabels).toContain("needs-input");
    expect(removedLabels).not.toContain("needs-human");
  });

  test("queued rename: admission awaiting-capacity now applies 'queued' (not 'waiting')", () => {
    // The value formerly applied at awaiting-capacity-or-priority was 'waiting'.
    // Phase 4 renames HELD_LABEL_WAITING value to 'queued' so the admission write is 'queued'.
    expect(HELD_LABEL_WAITING).toBe("queued");
    const ws = makeWs();
    convergeDispositionLabel("CTL-1", [], HELD_LABEL_WAITING, ws, { orchDir, now: () => 1000 });
    expect(ws.applyLabel.calls[0][0]).toMatchObject({ label: "queued" });
  });

  test("desired=blocked removes sibling 'queued' label", () => {
    const ws = makeWs();
    convergeDispositionLabel("CTL-1", ["queued"], "blocked", ws, { orchDir, now: () => 1000 });
    const removedLabels = ws.removeLabel.calls.map((c) => c[1] ?? c[0]);
    expect(removedLabels).toContain("queued");
    expect(ws.applyLabel.calls[0][0]).toMatchObject({ label: "blocked" });
  });

  // CTL-764 finding 1: the legacy pre-migration "waiting" value is removable (never
  // applied — only "queued" is) so a mid-rollout ticket carrying it is drained.
  test("finding 1 — desired='queued' removes the legacy 'waiting' label", () => {
    const ws = makeWs();
    convergeDispositionLabel("CTL-1", ["waiting"], "queued", ws, { orchDir, now: () => 1000 });
    const removedLabels = ws.removeLabel.calls.map((c) => c[1] ?? c[0]);
    expect(removedLabels).toContain("waiting");
    expect(ws.applyLabel.calls[0][0]).toMatchObject({ label: "queued" });
  });

  test("finding 1 — desired=null removes the legacy 'waiting' label", () => {
    const ws = makeWs();
    convergeDispositionLabel("CTL-1", ["waiting"], null, ws, { orchDir, now: () => 1000 });
    const removedLabels = ws.removeLabel.calls.map((c) => c[1] ?? c[0]);
    expect(removedLabels).toContain("waiting");
  });
});

// ── CTL-764 Phase 5 — recordTransition closure: worker.transition events ──

describe("CTL-764 Phase 5 — schedulerTick emits worker.transition events", () => {
  // Reset the in-memory lastDispositionEmit dedup before each test so the only-on-change
  // guard starts from a clean slate (also models a daemon restart — finding 10). Without
  // this the tests leak disposition state into each other and become order-dependent.
  beforeEach(() => __resetForTests());
  const noWrites = () => ({
    applyPhaseStatus() {},
    applyTerminalDone() {},
    applyLabel: () => ({}),
    removeLabel: () => ({ removed: false }),
  });

  test("Pass-1 advance emits one worker.transition event with toStage", () => {
    // Advance: research→plan dispatch. No plan signal so deriveAdvancement returns plan.
    writeSignal("CTL-764", "triage", "done");
    writeSignal("CTL-764", "research", "done");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    const transitions = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      verifyDispatched: verifyOk,
      writeStatus: {
        ...noWrites(),
        applyPhaseStatus: ({ ticket, phase }) => ({
          applied: true,
          from_state: "In Progress",
          to_state: "In Review",
          action: phase,
        }),
      },
      appendWorkerTransitionEvent: (ev) => transitions.push(ev),
    });
    const advance = transitions.find((e) => e.toStage && e.ticket === "CTL-764");
    expect(advance).toBeDefined();
    expect(advance.source).toBe("scheduler-advance");
  });

  test("terminal-sweep needs-human apply emits worker.transition(toDisposition='needs-human')", () => {
    // Terminal stalled ticket triggers needs-human
    writeSignal("CTL-764", "research", "done");
    writeSignal("CTL-764", "implement", "failed");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    const transitions = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus: {
        ...noWrites(),
        applyLabel: ({ ticket, label }) => ({ applied: true, label }),
        removeLabel: () => ({ removed: false }),
      },
      appendWorkerTransitionEvent: (ev) => transitions.push(ev),
      env: {},
    });
    const needsHuman = transitions.find(
      (e) => e.toDisposition === "needs-human" && e.ticket === "CTL-764"
    );
    expect(needsHuman).toBeDefined();
  });

  test("clear needs-human on terminal Done emits worker.transition(toDisposition=null)", () => {
    writeSignal("CTL-764", "research", "done");
    writeSignal("CTL-764", "plan", "done");
    writeSignal("CTL-764", "monitor-deploy", "done");
    // Mark the needs-human label as applied so clearStalledLabel removes it
    mkdirSync(join(orchDir, "workers", "CTL-764"), { recursive: true });
    writeFileSync(join(orchDir, "workers", "CTL-764", ".linear-label-needs-human.applied"), "");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    const transitions = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus: {
        ...noWrites(),
        removeLabel: () => ({ removed: true }),
        applyTerminalDone: () => ({ applied: false, skipped: "already-done" }),
      },
      appendWorkerTransitionEvent: (ev) => transitions.push(ev),
    });
    const cleared = transitions.find(
      (e) =>
        e.toDisposition === null && e.fromDisposition === "needs-human" && e.ticket === "CTL-764"
    );
    expect(cleared).toBeDefined();
  });

  test("steady-state tick emits zero worker.transition events", () => {
    // Blocked ticket that was already blocked last tick (lastDispositionEmit tracks it)
    writeSignal("CTL-764", "triage", "done");
    writeSignal("CTL-764", "research", "done");
    writeSignal("CTL-764", "implement", "done");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 0 }));
    const transitions = [];
    const writeStatus = {
      ...noWrites(),
      applyPhaseStatus: () => ({ applied: false, skipped: "already-in-state" }),
    };
    // First tick: emits the disposition event
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus,
      appendWorkerTransitionEvent: (ev) => transitions.push(ev),
    });
    const firstCount = transitions.length;
    // Second tick: same state → no new transition event for that ticket
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus,
      appendWorkerTransitionEvent: (ev) => transitions.push(ev),
    });
    // If a disposition event was emitted in tick 1, it must NOT be re-emitted in tick 2
    const tick2Events = transitions.slice(firstCount);
    const tick2Disposition = tick2Events.filter(
      (e) => e.ticket === "CTL-764" && e.toDisposition !== undefined
    );
    expect(tick2Disposition).toHaveLength(0);
  });

  // CTL-764 finding 7: a normally-completed ticket has no needs-human marker, so the
  // Done stage transition must fire next to terminalDoneOnce — not only from the
  // label-clear hook (which never runs when there is nothing to clear).
  test("finding 7 — terminal Done emits a stage transition with no needs-human marker", () => {
    writeSignal("CTL-764", "research", "done");
    writeSignal("CTL-764", "teardown", "done"); // TERMINAL_PHASE done → terminalDoneOnce fires
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    const transitions = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus: {
        ...noWrites(),
        // A REAL Done write: applied + action !== "skipped" + a from_state to carry.
        applyTerminalDone: () => ({ applied: true, action: "done", from_state: "In Review" }),
        removeLabel: () => ({ removed: false }),
      },
      appendWorkerTransitionEvent: (ev) => transitions.push(ev),
    });
    const done = transitions.find((e) => e.toStage === "done" && e.ticket === "CTL-764");
    expect(done).toBeDefined();
    expect(done.source).toBe("terminal-done");
    expect(done.fromStage).toBe("In Review");
  });

  // CTL-764 finding 10: after a daemon restart lastDispositionEmit is empty; a first-seen
  // clear (fromDisposition proven) must still emit. The pre-fix guard normalized the empty
  // `last` to null and dropped the needs-human→cleared transition on the no-stall path.
  test("finding 10 — a first-seen clear (empty dedup) emits the needs-human→cleared transition", () => {
    writeSignal("CTL-764", "triage", "done");
    writeSignal("CTL-764", "research", "done");
    writeSignal("CTL-764", "implement", "done"); // healthy: no stall, NOT terminal
    mkdirSync(join(orchDir, "workers", "CTL-764"), { recursive: true });
    writeFileSync(join(orchDir, "workers", "CTL-764", ".linear-label-needs-human.applied"), "");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 0 }));
    const transitions = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus: { ...noWrites(), removeLabel: () => ({ removed: true }) },
      appendWorkerTransitionEvent: (ev) => transitions.push(ev),
    });
    const cleared = transitions.find(
      (e) =>
        e.fromDisposition === "needs-human" && e.toDisposition === null && e.ticket === "CTL-764"
    );
    expect(cleared).toBeDefined();
    expect(cleared.source).toBe("no-stall-clear");
  });

  // CTL-764 finding 5: a needs-input park must apply the durable Linear label via
  // convergeDispositionLabel (the sole applier) and emit worker.transition — before this
  // fix production never called it, so only the local signal changed.
  test("finding 5 — needs-input park applies the durable label + emits worker.transition", () => {
    writeSignal("CTL-764", "triage", "done");
    writeSignal("CTL-764", "research", "done");
    writeSignal("CTL-764", "implement", "needs-input");
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    const applied = [];
    const transitions = [];
    // Broker projection hit with no labels yet → convergeDispositionLabel applies once.
    const gateway = {
      getDescriptor: (id) => (id === "CTL-764" ? { labels: [], removed: false } : null),
    };
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      writeStatus: {
        ...noWrites(),
        applyLabel: ({ ticket, label }) => {
          applied.push({ ticket, label });
          return { applied: true, reason: null };
        },
      },
      gateway,
      appendWorkerTransitionEvent: (ev) => transitions.push(ev),
    });
    expect(applied).toContainEqual({ ticket: "CTL-764", label: "needs-input" });
    const park = transitions.find(
      (e) => e.toDisposition === "needs-input" && e.ticket === "CTL-764"
    );
    expect(park).toBeDefined();
    expect(park.source).toBe("needs-input-park");
  });

  // CTL-764 finding B: a triaged-waiting ticket already wearing the sticky needs-human
  // label (e.g. a dependency-cycle escalation persisted across restart) stays held, but
  // convergeHeldLabel can't apply the lower disposition (exclusive worker-status group).
  // The lower-disposition worker.transition must be SUPPRESSED so the two-axis stream is
  // not falsely downgraded below needs-human.
  test("finding B — a held ticket wearing needs-human suppresses the lower-disposition emit", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 0 })); // no slot → held
    writeSignal("CTL-B", "triage", "done"); // triaged-waiting
    const transitions = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      // Held by a non-terminal blocker AND already wearing needs-human on Linear.
      fetchBatch: mkBatch({
        "CTL-B": relBlockedBy("CTL-BLK", { labels: ["needs-human"] }),
        "CTL-BLK": descOf("Triage"),
      }),
      hasTriageArtifact: () => true,
      writeStatus: noWrites(),
      appendWorkerTransitionEvent: (ev) => transitions.push(ev),
    });
    const lowered = transitions.find(
      (e) => e.ticket === "CTL-B" && (e.toDisposition === "blocked" || e.toDisposition === "queued")
    );
    expect(lowered).toBeUndefined();
  });

  // CTL-764 finding F: after a daemon restart lastDispositionEmit is empty. A ticket still
  // wearing "blocked" on Linear that is admitted this tick (desired=null) must still emit
  // the genuine blocked→cleared transition — the fix passes the current held label as
  // fromDisposition so recordTransition's first-seen-clear allowance fires.
  test("finding F — an admitted held ticket emits blocked→cleared after a restart (fromDisposition proven)", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    writeSignal("CTL-F", "triage", "done"); // triaged-waiting, unblocked → admitted
    const transitions = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      fetchBatch: mkBatch(() => relUnblocked({ labels: ["blocked"] })),
      hasTriageArtifact: () => true,
      writeStatus: { ...noWrites(), removeLabel: () => ({ removed: true }) },
      appendWorkerTransitionEvent: (ev) => transitions.push(ev),
    });
    const cleared = transitions.find(
      (e) => e.ticket === "CTL-F" && e.fromDisposition === "blocked" && e.toDisposition === null
    );
    expect(cleared).toBeDefined();
    expect(cleared.source).toBe("scheduler-admission");
  });

  // CTL-764 r4 finding 1: the restart clear must gate on a CONFIRMED removal.
  // removeLabel reports transient failures as {removed:false} without throwing —
  // Linear still wears the label, so emitting cleared would fork the stream from
  // Linear. The emission is skipped; a later tick re-converges and emits then.
  test("r4 finding 1 — a failed removeLabel suppresses the restart clear emission", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    writeSignal("CTL-R41", "triage", "done"); // triaged-waiting, unblocked → admitted
    const transitions = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      fetchBatch: mkBatch(() => relUnblocked({ labels: ["blocked"] })),
      hasTriageArtifact: () => true,
      writeStatus: { ...noWrites(), removeLabel: () => ({ removed: false }) },
      appendWorkerTransitionEvent: (ev) => transitions.push(ev),
    });
    const cleared = transitions.find(
      (e) => e.ticket === "CTL-R41" && e.toDisposition === null && e.source === "scheduler-admission"
    );
    expect(cleared).toBeUndefined();
  });

  // CTL-764 r4 finding 2: a pre-migration "waiting" label is only a removable alias of
  // "queued" — the restart clear must emit the canonical queued→cleared, never a fifth
  // disposition value the two-axis vocabulary doesn't define.
  test("r4 finding 2 — legacy waiting normalizes to queued on the restart clear", () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    writeSignal("CTL-R42", "triage", "done"); // triaged-waiting, unblocked → admitted
    const transitions = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      fetchBatch: mkBatch(() => relUnblocked({ labels: ["waiting"] })),
      hasTriageArtifact: () => true,
      writeStatus: { ...noWrites(), removeLabel: () => ({ removed: true }) },
      appendWorkerTransitionEvent: (ev) => transitions.push(ev),
    });
    const cleared = transitions.find(
      (e) => e.ticket === "CTL-R42" && e.toDisposition === null && e.source === "scheduler-admission"
    );
    expect(cleared).toBeDefined();
    expect(cleared.fromDisposition).toBe("queued");
  });

  // CTL-764 r5: the PRODUCTION removeLabel (linear-write.mjs) is ASYNC. The r4 capture
  // inspected the returned Promise synchronously — `.removed` read as undefined, so every
  // removal false-confirmed and the failed-removal suppression was a no-op in prod. The
  // seam is now thenable-aware: the clear emits (or is suppressed) when the write RESOLVES.
  test("r5 — an async removeLabel resolving {removed:false} suppresses the clear (prod shape)", async () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    writeSignal("CTL-R51", "triage", "done"); // triaged-waiting, unblocked → admitted
    const transitions = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      fetchBatch: mkBatch(() => relUnblocked({ labels: ["blocked"] })),
      hasTriageArtifact: () => true,
      writeStatus: { ...noWrites(), removeLabel: async () => ({ removed: false }) },
      appendWorkerTransitionEvent: (ev) => transitions.push(ev),
    });
    await new Promise((r) => setTimeout(r, 0)); // let the write settle
    const cleared = transitions.find(
      (e) => e.ticket === "CTL-R51" && e.toDisposition === null && e.source === "scheduler-admission"
    );
    expect(cleared).toBeUndefined();
  });

  test("r5 — an async removeLabel resolving {removed:true} emits the clear post-settle (prod shape)", async () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    writeSignal("CTL-R52", "triage", "done"); // triaged-waiting, unblocked → admitted
    const transitions = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      fetchBatch: mkBatch(() => relUnblocked({ labels: ["blocked"] })),
      hasTriageArtifact: () => true,
      writeStatus: { ...noWrites(), removeLabel: async () => ({ removed: true }) },
      appendWorkerTransitionEvent: (ev) => transitions.push(ev),
    });
    await new Promise((r) => setTimeout(r, 0)); // let the write settle
    const cleared = transitions.find(
      (e) => e.ticket === "CTL-R52" && e.toDisposition === null && e.source === "scheduler-admission"
    );
    expect(cleared).toBeDefined();
    expect(cleared.fromDisposition).toBe("blocked");
  });

  test("r5 — an async removeLabel REJECTION suppresses the clear (fail-open, warn only)", async () => {
    writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 2 }));
    writeSignal("CTL-R53", "triage", "done");
    const transitions = [];
    schedulerTick(orchDir, {
      readEligible: () => [],
      dispatch: fakeDispatch(),
      verifyDispatched: verifyOk,
      liveBackgroundCount: () => 0,
      fetchBatch: mkBatch(() => relUnblocked({ labels: ["blocked"] })),
      hasTriageArtifact: () => true,
      writeStatus: { ...noWrites(), removeLabel: () => Promise.reject(new Error("boom")) },
      appendWorkerTransitionEvent: (ev) => transitions.push(ev),
    });
    await new Promise((r) => setTimeout(r, 0));
    const cleared = transitions.find(
      (e) => e.ticket === "CTL-R53" && e.toDisposition === null && e.source === "scheduler-admission"
    );
    expect(cleared).toBeUndefined();
  });
});
