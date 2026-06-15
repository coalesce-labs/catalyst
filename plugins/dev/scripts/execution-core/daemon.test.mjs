// Unit tests for the execution-core composing daemon (CTL-554 Phase 3).
// Run: cd plugins/dev/scripts/execution-core && bun test daemon.test.mjs
//
// startDaemon takes dependency-injected recover/monitor/scheduler/reconcile
// functions so no real timers, Linear polls, or child processes run — the
// composition logic is exercised deterministically.

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  startDaemon,
  stopDaemon,
  consumeEventTail,
  parseEventTailChunk,
  resolveBootConcurrency,
  handleCommentWake,
  __resetEventTailCursorForTest,
  __getEventTailLeftoverForTest,
  __getEventPollTimerForTest,
  createCommentInboxWriter,
  createUpdateInboxWriter,
  readLinearBotUserIds,
  readLinearBotWriteId,
  _isBotId,
} from "./daemon.mjs";
import { getEventLogPath, log } from "./config.mjs";
import { upsertProjectEntry } from "./registry.mjs";
import {
  recordHoldStop,
  holdStopCooldownPath,
  inHoldStopCooldown,
  clearHoldStopCooldown,
} from "./scheduler.mjs";

// CATALYST_DIR temp-dir harness — identical shape to enrollment.test.mjs:14-19.
let catalystDir;
let prevCatalystDir;

beforeEach(() => {
  prevCatalystDir = process.env.CATALYST_DIR;
  catalystDir = mkdtempSync(join(tmpdir(), "exec-core-daemon-"));
  process.env.CATALYST_DIR = catalystDir;
  mkdirSync(join(catalystDir, "execution-core"), { recursive: true });
});

afterEach(() => {
  try {
    stopDaemon();
  } catch {
    /* nothing running */
  }
  if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
  else process.env.CATALYST_DIR = prevCatalystDir;
  rmSync(catalystDir, { recursive: true, force: true });
});

describe("startDaemon", () => {
  test("calls recover, boot, startMonitor, startScheduler exactly once each in order", () => {
    const calls = [];
    startDaemon({
      recover: (o) => calls.push(["recover", o.orchDir]),
      // CTL-654: the boot-resume pass runs after recover, before the monitor.
      reconcileBoot: (o) => calls.push(["boot", o.orchDir]),
      startMonitor: () => calls.push(["monitor"]),
      startScheduler: (o) => calls.push(["scheduler", o.orchDir]),
      watchRegistry: false,
    });
    expect(calls.map((c) => c[0])).toEqual(["recover", "boot", "monitor", "scheduler"]);
    // recover + boot + scheduler all got the machine-level orchDir
    expect(calls[0][1]).toBe(calls[1][1]);
    expect(calls[0][1]).toBe(calls[3][1]);
  });

  // CTL-654: the boot-resume pass consumes the object recover() RETURNS as its
  // `report` — the recover RecoveryReport was previously discarded.
  test("threads recover()'s return value into reconcileBoot as report", () => {
    const fakeReport = { coldStart: true, workers: { dead: ["CTL-1"] } };
    let seenReport;
    let bootCallCount = 0;
    startDaemon({
      recover: () => fakeReport,
      reconcileBoot: (o) => {
        bootCallCount++;
        seenReport = o.report;
      },
      startMonitor: () => {},
      startScheduler: () => {},
      watchRegistry: false,
    });
    expect(bootCallCount).toBe(1);
    expect(seenReport).toBe(fakeReport);
  });

  // CTL-654: a throw from the boot-resume pass must not leave a stale PID file —
  // it runs inside the same try/catch as recover/monitor/scheduler.
  test("removes the PID file if reconcileBoot throws synchronously", () => {
    const pidFile = join(process.env.CATALYST_DIR, "daemon.pid");
    expect(() =>
      startDaemon({
        recover: () => ({ coldStart: true }),
        reconcileBoot: () => {
          throw new Error("simulated boot-resume failure");
        },
        startMonitor: () => {},
        startScheduler: () => {},
        watchRegistry: false,
        pidFile,
      })
    ).toThrow("simulated boot-resume failure");
    expect(existsSync(pidFile)).toBe(false);
  });

  // CTL-654: the default no-arg-reconcileBoot path wires the real
  // reconcileBootResume. A coldStart:false report must make it a safe no-op
  // (no agent shell-out, no dispatch) and not throw.
  test("default reconcileBoot is wired to reconcileBootResume and no-ops on a warm restart", () => {
    expect(() =>
      startDaemon({
        recover: () => ({ coldStart: false, workers: {} }),
        startMonitor: () => {},
        startScheduler: () => {},
        watchRegistry: false,
      })
    ).not.toThrow();
  });

  // CTL-665: the committed executionCore concurrency knobs resolved in main()
  // thread through startDaemon into BOTH the boot-resume pass and the scheduler,
  // so a config-set maxParallel drives the slot ceiling end-to-end. An absent
  // config yields {} (the default), preserving the legacy state.json path.
  test("threads the concurrency knobs into both reconcileBoot and startScheduler (CTL-665)", () => {
    const concurrency = { maxParallel: 4, minParallel: 1, maxParallelCeiling: 10 };
    let bootConcurrency;
    let schedulerConcurrency;
    startDaemon({
      recover: () => ({ coldStart: true, workers: {} }),
      reconcileBoot: (o) => {
        bootConcurrency = o.concurrency;
      },
      startMonitor: () => {},
      startScheduler: (o) => {
        schedulerConcurrency = o.concurrency;
      },
      watchRegistry: false,
      concurrency,
    });
    expect(bootConcurrency).toEqual(concurrency);
    expect(schedulerConcurrency).toEqual(concurrency);
  });

  // CTL-716: the daemon also forwards concurrency into startMonitor so the
  // monitor's triage slot gate uses the same ceiling as the scheduler.
  test("CTL-716: threads concurrency into startMonitor", () => {
    const concurrency = { maxParallel: 4, minParallel: 1, maxParallelCeiling: 10 };
    let monitorConcurrency = "unset";
    startDaemon({
      recover: () => ({ coldStart: false, workers: {} }),
      startMonitor: (o) => {
        monitorConcurrency = o.concurrency;
      },
      startScheduler: () => {},
      watchRegistry: false,
      concurrency,
    });
    expect(monitorConcurrency).toEqual(concurrency);
  });

  // CTL-665: default concurrency is {} when not passed (main() supplies it from
  // config; the no-arg test path must keep the legacy state.json ceiling).
  test("defaults concurrency to {} when not passed (CTL-665)", () => {
    let schedulerConcurrency = "unset";
    startDaemon({
      recover: () => ({ coldStart: false, workers: {} }),
      startMonitor: () => {},
      startScheduler: (o) => {
        schedulerConcurrency = o.concurrency;
      },
      watchRegistry: false,
    });
    expect(schedulerConcurrency).toEqual({});
  });

  // CTL-676: `configPath` resolved in main() threads into startScheduler so
  // the scheduler can re-read the concurrency knobs per tick (boot-resume
  // continues to use the boot-captured `concurrency` object). Default is
  // null when not passed — every existing test path keeps the back-compat
  // shape (scheduler re-passes the boot-captured concurrency).
  test("threads configPath into startScheduler (CTL-676)", () => {
    const configPath = "/tmp/CTL-676/config.json";
    let schedulerConfigPath = "unset";
    startDaemon({
      recover: () => ({ coldStart: false, workers: {} }),
      startMonitor: () => {},
      startScheduler: (o) => {
        schedulerConfigPath = o.configPath;
      },
      watchRegistry: false,
      configPath,
    });
    expect(schedulerConfigPath).toBe(configPath);
  });

  test("defaults configPath to null when not passed (CTL-676)", () => {
    let schedulerConfigPath = "unset";
    startDaemon({
      recover: () => ({ coldStart: false, workers: {} }),
      startMonitor: () => {},
      startScheduler: (o) => {
        schedulerConfigPath = o.configPath;
      },
      watchRegistry: false,
    });
    expect(schedulerConfigPath).toBeNull();
  });

  // CTL-1044: the daemon MUST pass an `appendIntentEvent` appender into the
  // scheduler. Without it, runningOpts.appendIntentEvent is undefined and the
  // advance-shadow comparator / CTL-936 intent.ineffective / executeEscalations
  // emitters silently no-op (the bug: zero beliefs.* events ever reached the log
  // on mini despite the shadow flags being live). This wiring test mirrors the
  // gateway/configPath wiring tests above: capture the scheduler's opts and
  // assert the appender is a function that actually lands a line in the unified
  // event log carrying event.name verbatim + payload intact.
  test("CTL-1044: passes appendIntentEvent into startScheduler — and it writes to the event log", () => {
    let captured;
    startDaemon({
      recover: () => ({ coldStart: false, workers: {} }),
      reconcileBoot: () => {},
      startMonitor: () => {},
      startScheduler: (o) => {
        captured = o;
      },
      watchRegistry: false,
    });
    // The seam the advance-shadow comparator (and intent/escalation emitters)
    // consume must be a real function in production — not null/undefined.
    expect(typeof captured.appendIntentEvent).toBe("function");

    // Drive exactly the object advance-shadow.mjs:177-180 hands `appendEvent`
    // and prove it reaches the log (CATALYST_DIR is pinned to this test's tmp
    // dir by the suite's beforeEach, so getEventLogPath resolves there).
    const ok = captured.appendIntentEvent({
      "event.name": "beliefs.advance_shadow.disagree",
      payload: { ticket: "CTL-1044-IT", procedural: "research", belief: null },
    });
    expect(ok).toBe(true);

    const lines = readFileSync(getEventLogPath(), "utf8").split("\n").filter(Boolean);
    const env = JSON.parse(lines[lines.length - 1]);
    expect(env.attributes["event.name"]).toBe("beliefs.advance_shadow.disagree");
    expect(env.body.payload.ticket).toBe("CTL-1044-IT");
    expect(env.body.payload.procedural).toBe("research");
    expect(env.resource["service.name"]).toBe("catalyst.execution-core");
  });

  // CTL-634: one cache instance is created in startDaemon and threaded into
  // BOTH composed boots, so the monitor's write-through and the scheduler's
  // read path share state. Capture each boot's `cache` arg and assert identity.
  test("constructs one cache and passes the SAME instance to monitor and scheduler", () => {
    let monitorCache;
    let schedulerCache;
    startDaemon({
      recover: () => {},
      startMonitor: (o) => {
        monitorCache = o.cache;
      },
      startScheduler: (o) => {
        schedulerCache = o.cache;
      },
      watchRegistry: false,
    });
    expect(monitorCache).toBeDefined();
    expect(typeof monitorCache.get).toBe("function"); // it's a cache instance
    expect(schedulerCache).toBe(monitorCache); // same instance, not two
  });

  test("ensures a machine-level state.json with a default maxParallel", () => {
    startDaemon({
      recover: () => {},
      startMonitor: () => {},
      startScheduler: () => {},
      watchRegistry: false,
    });
    const statePath = join(process.env.CATALYST_DIR, "execution-core", "state.json");
    expect(existsSync(statePath)).toBe(true);
    expect(JSON.parse(readFileSync(statePath, "utf8")).maxParallel).toBeGreaterThan(0);
  });

  test("does not overwrite an existing state.json", () => {
    const statePath = join(process.env.CATALYST_DIR, "execution-core", "state.json");
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ maxParallel: 9 }));
    startDaemon({
      recover: () => {},
      startMonitor: () => {},
      startScheduler: () => {},
      watchRegistry: false,
    });
    expect(JSON.parse(readFileSync(statePath, "utf8")).maxParallel).toBe(9);
  });

  // CTL-655: the daemon records its boot time so reclaimDeadWorkIfPossible can
  // window the per-ticket revive budget to the current run.
  test("writes a daemon-boot.json with a parseable ISO bootedAt", () => {
    startDaemon({
      recover: () => {},
      startMonitor: () => {},
      startScheduler: () => {},
      watchRegistry: false,
    });
    const markerPath = join(process.env.CATALYST_DIR, "execution-core", "daemon-boot.json");
    expect(existsSync(markerPath)).toBe(true);
    const { bootedAt } = JSON.parse(readFileSync(markerPath, "utf8"));
    expect(typeof bootedAt).toBe("string");
    expect(Number.isFinite(Date.parse(bootedAt))).toBe(true);
  });

  test("a fresh boot overwrites bootedAt (restart resets the window)", () => {
    const markerPath = join(process.env.CATALYST_DIR, "execution-core", "daemon-boot.json");
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, JSON.stringify({ bootedAt: "2000-01-01T00:00:00.000Z" }));
    const startedAtMs = Date.now();
    startDaemon({
      recover: () => {},
      startMonitor: () => {},
      startScheduler: () => {},
      watchRegistry: false,
    });
    const { bootedAt } = JSON.parse(readFileSync(markerPath, "utf8"));
    // Rewritten (not appended/ignored): the stale marker is gone and the new
    // timestamp is at/after this test's start.
    expect(bootedAt).not.toBe("2000-01-01T00:00:00.000Z");
    expect(Date.parse(bootedAt)).toBeGreaterThanOrEqual(startedAtMs);
  });

  test("writes its PID to the given pidFile", () => {
    const pidFile = join(process.env.CATALYST_DIR, "daemon.pid");
    startDaemon({
      recover: () => {},
      startMonitor: () => {},
      startScheduler: () => {},
      watchRegistry: false,
      pidFile,
    });
    expect(Number(readFileSync(pidFile, "utf8").trim())).toBe(process.pid);
  });

  // CTL-586: the wrapper's 2s PID-file poll otherwise times out against a
  // daemon doing N × spawnSync("linearis") inside recover/monitor/scheduler.
  // The write must land BEFORE any composed boot step runs.
  test("writes the PID file BEFORE invoking recover (so the wrapper's poll sees it)", () => {
    const pidFile = join(process.env.CATALYST_DIR, "daemon.pid");
    let pidFileExistedBeforeRecover = false;
    startDaemon({
      recover: () => {
        pidFileExistedBeforeRecover = existsSync(pidFile);
      },
      startMonitor: () => {},
      startScheduler: () => {},
      watchRegistry: false,
      pidFile,
    });
    expect(pidFileExistedBeforeRecover).toBe(true);
    expect(Number(readFileSync(pidFile, "utf8").trim())).toBe(process.pid);
  });

  // CTL-586: a synchronous throw from any composed boot step must trigger
  // stopDaemon's PID-file unlink — otherwise the moved-up write leaves a
  // stale PID file pointing at a dead pid.
  test("removes the PID file if recover throws synchronously", () => {
    const pidFile = join(process.env.CATALYST_DIR, "daemon.pid");
    const boom = new Error("simulated recover failure");
    expect(() =>
      startDaemon({
        recover: () => {
          throw boom;
        },
        startMonitor: () => {},
        startScheduler: () => {},
        watchRegistry: false,
        pidFile,
      })
    ).toThrow("simulated recover failure");
    expect(existsSync(pidFile)).toBe(false);
  });

  test("removes the PID file if startMonitor throws synchronously", () => {
    const pidFile = join(process.env.CATALYST_DIR, "daemon.pid");
    expect(() =>
      startDaemon({
        recover: () => {},
        startMonitor: () => {
          throw new Error("simulated monitor failure");
        },
        startScheduler: () => {},
        watchRegistry: false,
        pidFile,
      })
    ).toThrow("simulated monitor failure");
    expect(existsSync(pidFile)).toBe(false);
  });

  test("removes the PID file if startScheduler throws synchronously", () => {
    const pidFile = join(process.env.CATALYST_DIR, "daemon.pid");
    expect(() =>
      startDaemon({
        recover: () => {},
        startMonitor: () => {},
        startScheduler: () => {
          throw new Error("simulated scheduler failure");
        },
        watchRegistry: false,
        pidFile,
      })
    ).toThrow("simulated scheduler failure");
    expect(existsSync(pidFile)).toBe(false);
  });

  // CTL-854: boot-warn when registry is empty — exactly once, names recovery verb
  test("WARNs once when the registry is empty at boot (CTL-854)", () => {
    const warn = spyOn(log, "warn");
    startDaemon({
      recover: () => ({}),
      reconcileBoot: () => {},
      startMonitor: () => {},
      startScheduler: () => {},
      stopMonitor: () => {},
      stopScheduler: () => {},
      reconcile: () => {},
      startAutoTuner: () => () => {},
      watchRegistry: false,
      listProjects: () => [],
    });
    const emptyWarns = warn.mock.calls.filter(
      (c) => JSON.stringify(c).includes("registry") && JSON.stringify(c).includes("register"),
    );
    expect(emptyWarns.length).toBe(1);
    warn.mockRestore();
  });

  test("does NOT warn when projects are registered at boot (CTL-854)", () => {
    const warn = spyOn(log, "warn");
    startDaemon({
      recover: () => ({}),
      reconcileBoot: () => {},
      startMonitor: () => {},
      startScheduler: () => {},
      stopMonitor: () => {},
      stopScheduler: () => {},
      reconcile: () => {},
      startAutoTuner: () => () => {},
      watchRegistry: false,
      listProjects: () => [{ team: "CTL", repoRoot: catalystDir, eligibleQuery: null }],
    });
    const emptyWarns = warn.mock.calls.filter((c) => JSON.stringify(c).includes("register"));
    expect(emptyWarns.length).toBe(0);
    warn.mockRestore();
  });

  test("reconciles when the registry changes (debounced)", async () => {
    let reconciled = 0;
    startDaemon({
      recover: () => {},
      startMonitor: () => {},
      startScheduler: () => {},
      reconcile: () => {
        reconciled++;
      },
      watchRegistry: true,
      debounceMs: 20,
    });
    upsertProjectEntry({ team: "DEMO", repoRoot: "/r/d", eligibleQuery: { status: "Todo" } });
    // Poll up to 2s rather than a fixed wait — fs.watch delivery latency plus
    // the debounce timer varies under concurrent full-suite load, so a fixed
    // 60ms wait is flaky. The reconcile only has to fire once.
    const deadline = Date.now() + 2000;
    while (reconciled === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(reconciled).toBeGreaterThan(0);
  });

  // CTL-650: the push-based session wait-state watcher is started from
  // startDaemon (default-on), gated by enableWaitWatcher, and stopped in
  // stopDaemon — mirroring the reaper's enableReaper wiring.
  test("starts the wait-watcher when enabled (CTL-650)", () => {
    let started = 0;
    startDaemon({
      recover: () => {},
      startMonitor: () => {},
      startScheduler: () => {},
      watchRegistry: false,
      startWaitWatcher: () => {
        started++;
        return { stop: () => {} };
      },
      enableWaitWatcher: true,
    });
    expect(started).toBe(1);
  });

  test("skips the wait-watcher when disabled (CTL-650)", () => {
    let started = 0;
    startDaemon({
      recover: () => {},
      startMonitor: () => {},
      startScheduler: () => {},
      watchRegistry: false,
      startWaitWatcher: () => {
        started++;
        return { stop: () => {} };
      },
      enableWaitWatcher: false,
    });
    expect(started).toBe(0);
  });

  test("stopDaemon stops the wait-watcher (CTL-650)", () => {
    let stopped = 0;
    startDaemon({
      recover: () => {},
      startMonitor: () => {},
      startScheduler: () => {},
      watchRegistry: false,
      startWaitWatcher: () => ({
        stop: () => {
          stopped++;
        },
      }),
      enableWaitWatcher: true,
    });
    stopDaemon();
    expect(stopped).toBe(1);
  });

  // CTL-685: the per-worker memory sampler is started from startDaemon
  // (default-on), gated by enableMemorySampler, and stopped in stopDaemon —
  // mirroring the CTL-650 wait-watcher wiring.
  test("starts the memory-sampler when enabled (CTL-685)", () => {
    let started = 0;
    startDaemon({
      recover: () => {},
      startMonitor: () => {},
      startScheduler: () => {},
      watchRegistry: false,
      startMemorySampler: () => {
        started++;
        return { stop: () => {} };
      },
      enableMemorySampler: true,
    });
    expect(started).toBe(1);
  });

  test("skips the memory-sampler when disabled (CTL-685)", () => {
    let started = 0;
    startDaemon({
      recover: () => {},
      startMonitor: () => {},
      startScheduler: () => {},
      watchRegistry: false,
      startMemorySampler: () => {
        started++;
        return { stop: () => {} };
      },
      enableMemorySampler: false,
    });
    expect(started).toBe(0);
  });

  test("stopDaemon stops the memory-sampler and swallows a throwing stop() (CTL-685)", () => {
    let stopped = 0;
    startDaemon({
      recover: () => {},
      startMonitor: () => {},
      startScheduler: () => {},
      watchRegistry: false,
      startMemorySampler: () => ({
        stop: () => {
          stopped++;
          throw new Error("simulated sampler stop failure");
        },
      }),
      enableMemorySampler: true,
    });
    // Must not throw even though stop() throws
    expect(() => stopDaemon()).not.toThrow();
    expect(stopped).toBe(1);
  });

  // CTL-787: the account-level rate-limit poller is started from startDaemon
  // (default-on), gated by enableRatelimitPoller, and stopped in stopDaemon —
  // mirroring the CTL-685 memory-sampler wiring.
  test("starts the ratelimit-poller when enabled (CTL-787)", () => {
    let started = 0;
    startDaemon({
      recover: () => {},
      startMonitor: () => {},
      startScheduler: () => {},
      watchRegistry: false,
      startRatelimitPoller: () => {
        started++;
        return { stop: () => {} };
      },
      enableRatelimitPoller: true,
    });
    expect(started).toBe(1);
  });

  test("skips the ratelimit-poller when disabled (CTL-787)", () => {
    let started = 0;
    startDaemon({
      recover: () => {},
      startMonitor: () => {},
      startScheduler: () => {},
      watchRegistry: false,
      startRatelimitPoller: () => {
        started++;
        return { stop: () => {} };
      },
      enableRatelimitPoller: false,
    });
    expect(started).toBe(0);
  });

  test("stopDaemon stops the ratelimit-poller and swallows a throwing stop() (CTL-787)", () => {
    let stopped = 0;
    startDaemon({
      recover: () => {},
      startMonitor: () => {},
      startScheduler: () => {},
      watchRegistry: false,
      startRatelimitPoller: () => ({
        stop: () => {
          stopped++;
          throw new Error("simulated poller stop failure");
        },
      }),
      enableRatelimitPoller: true,
    });
    // Must not throw even though stop() throws
    expect(() => stopDaemon()).not.toThrow();
    expect(stopped).toBe(1);
  });

  // CTL-1165 D5: the pre-exhaustion fleet-health probe is started from
  // startDaemon (default-on), gated by enableFleetHealth, and stopped in
  // stopDaemon — mirroring the CTL-685 memory-sampler wiring exactly.
  test("starts the fleet-health probe when enabled (CTL-1165 D5)", () => {
    let started = 0;
    startDaemon({
      recover: () => {},
      startMonitor: () => {},
      startScheduler: () => {},
      watchRegistry: false,
      startFleetHealthProbe: () => {
        started++;
        return { stop: () => {} };
      },
      enableFleetHealth: true,
    });
    expect(started).toBe(1);
  });

  test("skips the fleet-health probe when disabled (CTL-1165 D5)", () => {
    let started = 0;
    startDaemon({
      recover: () => {},
      startMonitor: () => {},
      startScheduler: () => {},
      watchRegistry: false,
      startFleetHealthProbe: () => {
        started++;
        return { stop: () => {} };
      },
      enableFleetHealth: false,
    });
    expect(started).toBe(0);
  });

  test("stopDaemon stops the fleet-health probe and swallows a throwing stop() (CTL-1165 D5)", () => {
    let stopped = 0;
    startDaemon({
      recover: () => {},
      startMonitor: () => {},
      startScheduler: () => {},
      watchRegistry: false,
      startFleetHealthProbe: () => ({
        stop: () => {
          stopped++;
          throw new Error("simulated probe stop failure");
        },
      }),
      enableFleetHealth: true,
    });
    // Must not throw even though stop() throws
    expect(() => stopDaemon()).not.toThrow();
    expect(stopped).toBe(1);
  });
});

// CTL-678 — main()-side resolver: pre-merge Layer-1 (committed seed) under
// Layer-2 (machine-canonical override) into the same concurrency object
// CTL-665 threads into startDaemon. Pure helper, exercised in isolation;
// the existing CTL-665 startDaemon tests above remain unchanged.
describe("resolveBootConcurrency (CTL-678)", () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "boot-concurrency-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeJson(name, obj) {
    const p = join(tmpDir, name);
    writeFileSync(p, JSON.stringify(obj));
    return p;
  }

  test("merges Layer-2 over Layer-1 per field", () => {
    const layer1Path = writeJson("layer1.json", {
      catalyst: {
        orchestration: {
          executionCore: { maxParallel: 4, minParallel: 1, maxParallelCeiling: 10 },
        },
      },
    });
    const layer2Path = writeJson("layer2.json", {
      catalyst: { orchestration: { executionCore: { maxParallel: 6 } } },
    });
    expect(resolveBootConcurrency({ layer1Path, layer2Path })).toEqual({
      maxParallel: 6,
      minParallel: 1,
      maxParallelCeiling: 10,
    });
  });

  test("Layer-2 absent → result equals Layer-1", () => {
    const layer1Path = writeJson("layer1.json", {
      catalyst: {
        orchestration: {
          executionCore: { maxParallel: 4, minParallel: 1, maxParallelCeiling: 10 },
        },
      },
    });
    const layer2Path = join(tmpDir, "missing.json");
    expect(resolveBootConcurrency({ layer1Path, layer2Path })).toEqual({
      maxParallel: 4,
      minParallel: 1,
      maxParallelCeiling: 10,
    });
  });

  test("both absent → {} (legacy empty-concurrency path)", () => {
    const layer1Path = join(tmpDir, "missing1.json");
    const layer2Path = join(tmpDir, "missing2.json");
    expect(resolveBootConcurrency({ layer1Path, layer2Path })).toEqual({});
  });

  test("eligibleQuery on Layer-1 survives the merge unchanged", () => {
    const layer1Path = writeJson("layer1.json", {
      catalyst: {
        orchestration: {
          executionCore: {
            maxParallel: 4,
            eligibleQuery: { status: "Todo" },
          },
        },
      },
    });
    const layer2Path = writeJson("layer2.json", {
      catalyst: { orchestration: { executionCore: { maxParallel: 6 } } },
    });
    expect(resolveBootConcurrency({ layer1Path, layer2Path })).toEqual({
      maxParallel: 6,
      eligibleQuery: { status: "Todo" },
    });
  });
});

// CTL-649: consumeEventTail must read by BYTE offset, not JS-string code units,
// and must carry a trailing partial line across reads. Driven deterministically
// against a temp file (never the real fs.watch — see the known fs.watch debounce
// flaky-test hazard in this repo).
describe("consumeEventTail (byte-offset + partial-line tail)", () => {
  let dir;
  let logPath;
  let handled;
  let reaper;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "exec-core-tail-"));
    logPath = join(dir, "events.jsonl");
    handled = [];
    // Fake reaper: record every dispatched event; .handle returns a resolved
    // promise so the production .catch(...) chain is exercised without throwing.
    reaper = {
      handle: (event) => {
        handled.push(event);
        return Promise.resolve();
      },
    };
    __resetEventTailCursorForTest(0, "");
  });

  afterEach(() => {
    __resetEventTailCursorForTest(0, "");
    rmSync(dir, { recursive: true, force: true });
  });

  // pure helper: stitches leftover, returns complete events + new partial line.
  test("parseEventTailChunk stitches leftover and holds back the trailing partial line", () => {
    const first = parseEventTailChunk('{"event":"a"}\n{"event":"b', "");
    expect(first.events).toEqual([{ event: "a" }]);
    expect(first.leftover).toBe('{"event":"b');

    const second = parseEventTailChunk('"}\n', first.leftover);
    expect(second.events).toEqual([{ event: "b" }]);
    expect(second.leftover).toBe("");
  });

  test("parseEventTailChunk skips malformed complete lines but keeps the rest", () => {
    const { events } = parseEventTailChunk('not json\n{"event":"ok"}\n', "");
    expect(events).toEqual([{ event: "ok" }]);
  });

  // Case 1: a multi-byte UTF-8 char in a line BEFORE the cursor must not shift
  // byte indexing for subsequent appended lines. With the old String.slice the
  // cursor (a byte offset) would land mid-line on the next read and the
  // reap-requested line would fail JSON.parse and be silently dropped.
  test("a multi-byte char before the cursor does not corrupt later parsing", () => {
    // Pre-existing line with a multi-byte char ("✅" = 3 bytes, 1 UTF-16 unit).
    const preLine = JSON.stringify({ event: "phase.note", body: "done ✅ café" }) + "\n";
    writeFileSync(logPath, preLine);
    // Initialize the cursor to the current tail (as the daemon does post-replay),
    // measured in BYTES.
    __resetEventTailCursorForTest(statSync(logPath).size, "");

    // Now a live reap-requested line is appended.
    const reapLine =
      JSON.stringify({ event: "phase.yield.reap-requested", bg_job_id: "abc" }) + "\n";
    appendFileSync(logPath, reapLine);

    consumeEventTail({ path: logPath, reaper });

    const reaps = handled.filter((e) => e.event === "phase.yield.reap-requested");
    expect(reaps).toHaveLength(1);
    expect(reaps[0].bg_job_id).toBe("abc");
    // The pre-cursor note line must NOT have been re-read.
    expect(handled.filter((e) => e.event === "phase.note")).toHaveLength(0);
  });

  // Case 2: a line written in two appends across two tail reads is parsed
  // exactly once after the second write — never dropped, never duplicated.
  test("a line appended in two writes is parsed exactly once after completion", () => {
    writeFileSync(logPath, "");
    __resetEventTailCursorForTest(0, "");

    // First half — no newline yet.
    appendFileSync(logPath, '{"event":"phase.yield.reap-re');
    consumeEventTail({ path: logPath, reaper });
    expect(handled).toHaveLength(0); // nothing complete yet
    expect(__getEventTailLeftoverForTest()).toBe('{"event":"phase.yield.reap-re');

    // Second half completes the line.
    appendFileSync(logPath, 'quested","bg_job_id":"abc"}\n');
    consumeEventTail({ path: logPath, reaper });

    expect(handled).toHaveLength(1);
    expect(handled[0]).toEqual({ event: "phase.yield.reap-requested", bg_job_id: "abc" });
    expect(__getEventTailLeftoverForTest()).toBe("");

    // A third read with no new bytes is a no-op (no re-dispatch).
    consumeEventTail({ path: logPath, reaper });
    expect(handled).toHaveLength(1);
  });

  // Case 3: file shrinks below the cursor (rotation/truncation) → cursor resets
  // to 0, leftover is cleared, and a fresh line is parsed from the new file.
  test("rotation: file shrinks below cursor, cursor + leftover reset, fresh line parsed", () => {
    // Establish a large cursor and a stale leftover, as if mid-line on a big file.
    const big = JSON.stringify({ event: "phase.old", n: 1 }) + "\n";
    writeFileSync(logPath, big.repeat(20));
    __resetEventTailCursorForTest(statSync(logPath).size, '{"event":"stale-partial');

    // Rotation: the file is replaced with a much smaller one.
    const freshLine =
      JSON.stringify({ event: "phase.yield.reap-requested", bg_job_id: "fresh" }) + "\n";
    writeFileSync(logPath, freshLine);

    consumeEventTail({ path: logPath, reaper });

    const reaps = handled.filter((e) => e.event === "phase.yield.reap-requested");
    expect(reaps).toHaveLength(1);
    expect(reaps[0].bg_job_id).toBe("fresh");
    // The stale partial line must have been discarded, not stitched onto the
    // fresh file's first line.
    expect(__getEventTailLeftoverForTest()).toBe("");
  });

  test("no-op when reaper is null", () => {
    writeFileSync(logPath, JSON.stringify({ event: "x" }) + "\n");
    __resetEventTailCursorForTest(0, "");
    expect(() => consumeEventTail({ path: logPath, reaper: null })).not.toThrow();
    expect(handled).toHaveLength(0);
  });

  test("missing log file is a best-effort no-op", () => {
    expect(() =>
      consumeEventTail({ path: join(dir, "does-not-exist.jsonl"), reaper })
    ).not.toThrow();
    expect(handled).toHaveLength(0);
  });
});

// CTL-769: the reaper must drain reap-intents via a setInterval POLL fallback,
// not solely via fs.watch + debounce. On the continuously-appended unified
// event log the debounce is perpetually reset, so consumeEventTail only ever
// fired during >5s idle gaps and the reaper starved exactly when workers were
// busy (~101k reap-requested vs ~216 reap-complete live). Mirrors the sibling
// new-work tailer's poll fallback (monitor.mjs:684-685 / TAILER_POLL_INTERVAL_MS).
describe("startReaperAndTimer — poll fallback drains reap-intents (CTL-769)", () => {
  test("a reap-requested line appended after boot is drained by the poll, NOT fs.watch", async () => {
    const handled = [];
    // Fake reaper: record every dispatched event. .handle returns a resolved
    // promise so the production .catch(...) chain is exercised without throwing
    // and without any `claude` shell-out.
    const fakeReaper = {
      handle: (event) => {
        handled.push(event);
        return Promise.resolve();
      },
      // bootReplay runs once at startReaperAndTimer; no-op for the test.
      bootReplay: () => Promise.resolve(),
    };

    startDaemon({
      recover: () => {},
      reconcileBoot: () => {},
      startMonitor: () => {},
      startScheduler: () => {},
      // No registry watcher — isolate the reaper event-log path.
      watchRegistry: false,
      enableReaper: true,
      makeReaper: () => fakeReaper,
      // Tiny poll so the drain is fast and deterministic.
      pollMs: 10,
      // A huge debounce makes the fs.watch path (if it ever fires) schedule a
      // consumeEventTail far beyond this test's deadline — so any drain we
      // observe within ~2s must have come from the poll interval, not fs.watch.
      debounceMs: 600_000,
    });

    // Append a reap-requested line to the REAL event log path the daemon polls.
    // startReaperAndTimer set the cursor to the current tail (0 here, since the
    // file does not exist yet), so this newly-appended line is "new" bytes.
    const logPath = getEventLogPath();
    mkdirSync(dirname(logPath), { recursive: true });
    const reapLine =
      JSON.stringify({ event: "phase.yield.reap-requested", bg_job_id: "poll-abc" }) + "\n";
    appendFileSync(logPath, reapLine);

    // Poll-wait (deadline loop) until the reaper handles it — proving the
    // setInterval drained the tail without any fs.watch event.
    const deadline = Date.now() + 3000;
    while (handled.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const reaps = handled.filter((e) => e.event === "phase.yield.reap-requested");
    expect(reaps).toHaveLength(1);
    expect(reaps[0].bg_job_id).toBe("poll-abc");
  });

  test("stopDaemon clears the poll interval — no further drains after stop", async () => {
    const handled = [];
    const fakeReaper = {
      handle: (event) => {
        handled.push(event);
        return Promise.resolve();
      },
      bootReplay: () => Promise.resolve(),
    };

    startDaemon({
      recover: () => {},
      reconcileBoot: () => {},
      startMonitor: () => {},
      startScheduler: () => {},
      watchRegistry: false,
      enableReaper: true,
      makeReaper: () => fakeReaper,
      pollMs: 10,
      debounceMs: 600_000,
    });

    const logPath = getEventLogPath();
    mkdirSync(dirname(logPath), { recursive: true });

    // The poll interval is live after boot. Assert the handle DIRECTLY so this
    // test pins stopDaemon's clearInterval — a behavioral "0 drains after stop"
    // check alone is masked by stopDaemon also nulling _reaper (consumeEventTail
    // short-circuits on a null reaper), so a leaked, un-cleared interval would
    // no-op and the behavioral assertion would still pass. Removing the
    // clearInterval block from stopDaemon must make THIS test red.
    expect(__getEventPollTimerForTest()).not.toBeNull();

    // Stop the daemon BEFORE appending — the interval must be cleared so the
    // newly-appended line is never drained.
    stopDaemon();

    // The handle is cleared (the real teardown pin, independent of the reaper).
    expect(__getEventPollTimerForTest()).toBeNull();

    appendFileSync(
      logPath,
      JSON.stringify({ event: "phase.yield.reap-requested", bg_job_id: "after-stop" }) + "\n"
    );

    // Belt-and-suspenders: give the (now-cleared) interval ample wall-clock time
    // to misfire and confirm no drain occurs.
    await new Promise((r) => setTimeout(r, 200));

    expect(handled.filter((e) => e.event === "phase.yield.reap-requested")).toHaveLength(0);
  });
});

// CTL-1165 D2: the daemon constructs the production orphan child-process reaper
// (ProcReaper, DEFAULT mode:"shadow") and injects it into the Reaper via the
// makeReaper opts, so reaper.mjs's procOrphans.reap-requested case has a real
// sweeper to drive (no-op until injected).
describe("startReaperAndTimer — injects a production ProcReaper (CTL-1165 D2)", () => {
  test("makeReaper receives a procReaper whose sweep is a function, defaulting to shadow mode", () => {
    let capturedOpts = null;
    const fakeReaper = {
      handle: () => Promise.resolve(),
      bootReplay: () => Promise.resolve(),
    };
    startDaemon({
      recover: () => {},
      reconcileBoot: () => {},
      startMonitor: () => {},
      startScheduler: () => {},
      watchRegistry: false,
      enableReaper: true,
      makeReaper: (opts) => {
        capturedOpts = opts;
        return fakeReaper;
      },
      pollMs: 0, // no poll interval needed for this assertion
      debounceMs: 600_000,
    });
    expect(capturedOpts).not.toBeNull();
    expect(capturedOpts.procReaper).toBeTruthy();
    expect(typeof capturedOpts.procReaper.sweep).toBe("function");
    // Default-safe: shadow mode emits would-reap, kills nothing.
    expect(capturedOpts.procReaper.mode).toBe("shadow");
    stopDaemon();
  });
});

// CTL-701 Phase 3: boot marker exists when recover() (detectColdStart) reads it
describe("startDaemon — writeBootMarker ordering (CTL-701)", () => {
  test("daemon-boot.json written BEFORE recover() runs", () => {
    const orchDir = join(process.env.CATALYST_DIR, "execution-core");
    let bootFileExistedAtRecover = false;
    let bootedAtAtRecover = null;
    startDaemon({
      recover: (o) => {
        const bootPath = join(o.orchDir, "daemon-boot.json");
        try {
          const raw = readFileSync(bootPath, "utf8");
          const parsed = JSON.parse(raw);
          bootFileExistedAtRecover = true;
          bootedAtAtRecover = parsed.bootedAt;
        } catch {
          /* file not yet written — test will fail */
        }
        return {};
      },
      reconcileBoot: () => {},
      startMonitor: () => {},
      startScheduler: () => {},
      watchRegistry: false,
    });
    expect(bootFileExistedAtRecover).toBe(true);
    expect(typeof bootedAtAtRecover).toBe("string");
    expect(Number.isNaN(Date.parse(bootedAtAtRecover))).toBe(false);
  });
});

describe("stopDaemon", () => {
  test("stops monitor + scheduler and removes the pidFile", () => {
    const pidFile = join(process.env.CATALYST_DIR, "daemon.pid");
    const stopped = [];
    startDaemon({
      recover: () => {},
      startMonitor: () => {},
      startScheduler: () => {},
      stopMonitor: () => stopped.push("monitor"),
      stopScheduler: () => stopped.push("scheduler"),
      watchRegistry: false,
      pidFile,
    });
    stopDaemon();
    expect(stopped.sort()).toEqual(["monitor", "scheduler"]);
    expect(existsSync(pidFile)).toBe(false);
  });
});

// CTL-684: auto-tuner wiring in startDaemon + stopDaemon.
describe("auto-tuner wiring (CTL-684)", () => {
  test("startDaemon invokes startAutoTuner once with configPath + layer2Path", () => {
    const calls = [];
    startDaemon({
      recover: () => {},
      startMonitor: () => {},
      startScheduler: () => {},
      watchRegistry: false,
      configPath: "/fake/config.json",
      layer2Path: "/fake/layer2.json",
      startAutoTuner: (opts) => {
        calls.push(opts);
        return () => {};
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].configPath).toBe("/fake/config.json");
    expect(calls[0].layer2Path).toBe("/fake/layer2.json");
    stopDaemon();
  });

  test("stopDaemon calls the stored _stopAutoTuner", () => {
    const stopped = [];
    startDaemon({
      recover: () => {},
      startMonitor: () => {},
      startScheduler: () => {},
      watchRegistry: false,
      startAutoTuner: () => () => stopped.push("autoTuner"),
    });
    stopDaemon();
    expect(stopped).toEqual(["autoTuner"]);
  });

  test("a throwing startAutoTuner triggers stopDaemon cleanup (daemon does not start half-up)", () => {
    let pidFile = null;
    try {
      pidFile = join(process.env.CATALYST_DIR, "daemon2.pid");
      startDaemon({
        recover: () => {},
        startMonitor: () => {},
        startScheduler: () => {},
        watchRegistry: false,
        pidFile,
        startAutoTuner: () => { throw new Error("tuner boot failed"); },
      });
    } catch {}
    // PID file must be removed by stopDaemon's cleanup path
    if (pidFile) expect(existsSync(pidFile)).toBe(false);
  });
});

// CTL-549: handleCommentWake — re-dispatch a parked (needs-input) ticket
describe("handleCommentWake (CTL-549)", () => {
  const tmpOrcDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl-549-orch-"));
    return dir;
  };
  const writeSignal = (orch, ticket, phase, data) => {
    const workerDir = join(orch, "workers", ticket);
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(
      join(workerDir, `phase-${phase}.json`),
      JSON.stringify({ ticket, phase, ...data }),
    );
  };

  test("re-dispatches ticket whose signal has status=needs-input", async () => {
    const orch = tmpOrcDir();
    writeSignal(orch, "CTL-1", "implement", {
      status: "needs-input",
      parkedFrom: "implement",
      handoffPath: "/path/handoff.md",
      bg_job_id: "job123",
    });
    const dispatched = [];
    await handleCommentWake(
      { ticket: "CTL-1", commentId: "c1", body: "Here is the answer" },
      {
        orchDir: orch,
        dispatch: (dir, ticket, phase, opts) => { dispatched.push({ ticket, phase, opts }); return { code: 0 }; },
        removeLabel: async () => {},
      },
    );
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].ticket).toBe("CTL-1");
    expect(dispatched[0].phase).toBe("implement");
    expect(dispatched[0].opts.handoffPath).toBe("/path/handoff.md");
  });

  test("no-ops for ticket with status=running (not parked)", async () => {
    const orch = tmpOrcDir();
    writeSignal(orch, "CTL-1", "implement", { status: "running" });
    const dispatched = [];
    await handleCommentWake(
      { ticket: "CTL-1", body: "reply" },
      {
        orchDir: orch,
        dispatch: (...a) => { dispatched.push(a); return { code: 0 }; },
        removeLabel: async () => {},
      },
    );
    expect(dispatched).toHaveLength(0);
  });

  test("calls removeLabel before dispatch on re-dispatch", async () => {
    const orch = tmpOrcDir();
    writeSignal(orch, "CTL-1", "implement", {
      status: "needs-input",
      parkedFrom: "implement",
    });
    const removed = [];
    const dispatchOrder = [];
    await handleCommentWake(
      { ticket: "CTL-1", body: "answer" },
      {
        orchDir: orch,
        dispatch: () => { dispatchOrder.push("dispatch"); return { code: 0 }; },
        removeLabel: async (ticket, label) => { removed.push({ ticket, label }); dispatchOrder.push("remove"); },
      },
    );
    expect(removed).toContainEqual({ ticket: "CTL-1", label: "needs-human" }); // CTL-1067 Bug 3
    expect(dispatchOrder.indexOf("remove")).toBeLessThan(dispatchOrder.indexOf("dispatch"));
  });

  test("no-ops when ticket has no worker dir", async () => {
    const orch = tmpOrcDir();
    const dispatched = [];
    await handleCommentWake(
      { ticket: "CTL-99", body: "hello" },
      {
        orchDir: orch,
        dispatch: (...a) => { dispatched.push(a); return { code: 0 }; },
        removeLabel: async () => {},
      },
    );
    expect(dispatched).toHaveLength(0);
  });

  test("no-ops when parsed event has no ticket", async () => {
    const orch = tmpOrcDir();
    const dispatched = [];
    await handleCommentWake(
      { body: "hello" },
      {
        orchDir: orch,
        dispatch: (...a) => { dispatched.push(a); return { code: 0 }; },
        removeLabel: async () => {},
      },
    );
    expect(dispatched).toHaveLength(0);
  });

  test("no-ops (self-echo) when comment authorId matches botUserId", async () => {
    const orch = tmpOrcDir();
    writeSignal(orch, "CTL-1", "implement", {
      status: "needs-input",
      parkedFrom: "implement",
      handoffPath: "/path/handoff.md",
    });
    const dispatched = [];
    const removed = [];
    await handleCommentWake(
      { ticket: "CTL-1", commentId: "c1", body: "I am the bot", authorId: "bot-user-id" },
      {
        orchDir: orch,
        dispatch: (dir, ticket, phase, opts) => { dispatched.push({ ticket, phase, opts }); return { code: 0 }; },
        removeLabel: async (t, l) => { removed.push({ ticket: t, label: l }); },
        botUserId: "bot-user-id",
      },
    );
    expect(dispatched).toHaveLength(0); // self-echo suppressed: no re-dispatch
    expect(removed).toHaveLength(0);    // and the human-attention label is preserved
  });

  test("re-dispatches when comment authorId does NOT match botUserId (human reply)", async () => {
    const orch = tmpOrcDir();
    writeSignal(orch, "CTL-1", "implement", {
      status: "needs-input",
      parkedFrom: "implement",
      handoffPath: "/path/handoff.md",
    });
    const dispatched = [];
    await handleCommentWake(
      { ticket: "CTL-1", commentId: "c2", body: "Here is the answer", authorId: "human-user-id" },
      {
        orchDir: orch,
        dispatch: (dir, ticket, phase, opts) => { dispatched.push({ ticket, phase, opts }); return { code: 0 }; },
        removeLabel: async () => {},
        botUserId: "bot-user-id",
      },
    );
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].ticket).toBe("CTL-1");
    expect(dispatched[0].phase).toBe("implement");
  });

  test("CTL-768: stoppedForHold → dispatch with resumeSession from resolveSession", async () => {
    const orch = tmpOrcDir();
    const workerDir = join(orch, "workers", "CTL-1");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(
      join(workerDir, "phase-implement.json"),
      JSON.stringify({ ticket: "CTL-1", phase: "implement", status: "needs-input",
        parkedFrom: "implement", bg_job_id: "held1234", stoppedForHold: true }),
    );
    const dispatched = [];
    await handleCommentWake({ ticket: "CTL-1" }, {
      orchDir: orch,
      dispatch: (d, t, p, opts) => dispatched.push({ p, opts }),
      removeLabel: async () => {},
      resolveSession: (bg) => (bg === "held1234" ? "uuid-resume" : null),
    });
    expect(dispatched[0].opts.resumeSession).toBe("uuid-resume");
    expect(dispatched[0].p).toBe("implement");
  });

  test("CTL-768: stoppedForHold → signal reset to stalled, marker cleared", async () => {
    const orch = tmpOrcDir();
    const workerDir = join(orch, "workers", "CTL-1");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(
      join(workerDir, "phase-implement.json"),
      JSON.stringify({ ticket: "CTL-1", phase: "implement", status: "needs-input",
        bg_job_id: "held1234", stoppedForHold: true }),
    );
    recordHoldStop(orch, "CTL-1", "implement", 1_000);
    await handleCommentWake({ ticket: "CTL-1" }, {
      orchDir: orch,
      dispatch: () => {},
      removeLabel: async () => {},
      resolveSession: () => "uuid",
    });
    const sig = JSON.parse(readFileSync(join(workerDir, "phase-implement.json"), "utf8"));
    expect(sig.status).toBe("stalled");
    expect(sig.stoppedForHold).toBe(false);     // cleared
    expect(inHoldStopCooldown(orch, "CTL-1", "implement", 2_000)).toBe(false); // cooldown cleared
  });

  test("CTL-768: stoppedForHold but resolveSession null → dispatch WITHOUT resume (cold fallback)", async () => {
    const orch = tmpOrcDir();
    const workerDir = join(orch, "workers", "CTL-1");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(
      join(workerDir, "phase-implement.json"),
      JSON.stringify({ ticket: "CTL-1", phase: "implement", status: "needs-input",
        bg_job_id: "held1234", stoppedForHold: true }),
    );
    const dispatched = [];
    await handleCommentWake({ ticket: "CTL-1" }, {
      orchDir: orch,
      dispatch: (d, t, p, opts) => dispatched.push(opts),
      removeLabel: async () => {},
      resolveSession: () => null,
    });
    expect(dispatched[0].resumeSession).toBeUndefined();
  });

  test("CTL-768: no stoppedForHold → backward-compat (no resume, signal unchanged)", async () => {
    const orch = tmpOrcDir();
    const workerDir = join(orch, "workers", "CTL-1");
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(
      join(workerDir, "phase-implement.json"),
      JSON.stringify({ ticket: "CTL-1", phase: "implement", status: "needs-input",
        parkedFrom: "implement", bg_job_id: "x" }),
    );
    const dispatched = [];
    const resolveSpy = [];
    await handleCommentWake({ ticket: "CTL-1" }, {
      orchDir: orch,
      dispatch: (d, t, p, opts) => dispatched.push(opts),
      removeLabel: async () => {},
      resolveSession: (bg) => { resolveSpy.push(bg); return "x"; },
    });
    expect(dispatched[0].resumeSession).toBeUndefined();
    expect(resolveSpy).toEqual([]);             // resolveSession never called
    const sig = JSON.parse(readFileSync(join(workerDir, "phase-implement.json"), "utf8"));
    expect(sig.status).toBe("needs-input");     // not reset
  });

  test("CTL-1067: a stalled signal is cleared via clearStall, not re-dispatched", async () => {
    const orch = tmpOrcDir();
    writeSignal(orch, "CTL-1", "implement", { status: "stalled", phase: "implement", generation: 2 });
    const dispatched = [], clears = [], removed = [];
    await handleCommentWake(
      { ticket: "CTL-1" },
      {
        orchDir: orch,
        dispatch: (...a) => dispatched.push(a),
        removeLabel: async (t, l) => removed.push({ ticket: t, label: l }),
        clearStall: ({ ticket, phase }) => { clears.push({ ticket, phase }); return true; },
      },
    );
    expect(clears).toEqual([{ ticket: "CTL-1", phase: "implement" }]);
    expect(dispatched).toEqual([]);
  });

  test("CTL-1067: stalled signal is a no-op when clearStall is not injected", async () => {
    const orch = tmpOrcDir();
    writeSignal(orch, "CTL-1", "implement", { status: "stalled", phase: "implement" });
    const dispatched = [];
    await handleCommentWake(
      { ticket: "CTL-1" },
      { orchDir: orch, dispatch: (...a) => dispatched.push(a), removeLabel: async () => {} },
    );
    expect(dispatched).toEqual([]);
  });
});

// CTL-749: inbox writer factory functions
describe("inbox writer — createCommentInboxWriter (CTL-749)", () => {
  let tmpDir;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "inbox-comment-test-")); });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  test("writes comment entry to inbox.jsonl when ticket is in-flight", () => {
    const ticket = "CTL-99";
    mkdirSync(join(tmpDir, "workers", ticket), { recursive: true });
    const writer = createCommentInboxWriter(tmpDir, "");
    writer({ ticket, commentId: "c1", body: "hello", authorId: "u1", authorName: "Ryan" });
    const lines = readFileSync(join(tmpDir, "workers", ticket, "inbox.jsonl"), "utf8")
      .trim().split("\n").map(JSON.parse);
    expect(lines[0]).toMatchObject({ kind: "comment", ticket, body: "hello" });
    expect(lines[0].receivedAt).toBeTruthy();
  });

  test("skips write when workers/<ticket>/ does not exist (ticket not in-flight)", () => {
    const writer = createCommentInboxWriter(tmpDir, "");
    writer({ ticket: "CTL-99", commentId: "c1", body: "hello", authorId: "u1", authorName: "Ryan" });
    expect(existsSync(join(tmpDir, "workers", "CTL-99", "inbox.jsonl"))).toBe(false);
  });

  test("skips write when authorId matches botUserId (self-echo filter)", () => {
    const ticket = "CTL-99";
    mkdirSync(join(tmpDir, "workers", ticket), { recursive: true });
    const writer = createCommentInboxWriter(tmpDir, "bot-user-id");
    writer({ ticket, commentId: "c1", body: "mirror", authorId: "bot-user-id", authorName: "Bot" });
    expect(existsSync(join(tmpDir, "workers", ticket, "inbox.jsonl"))).toBe(false);
  });

  test("writes when authorId does NOT match botUserId", () => {
    const ticket = "CTL-99";
    mkdirSync(join(tmpDir, "workers", ticket), { recursive: true });
    const writer = createCommentInboxWriter(tmpDir, "bot-user-id");
    writer({ ticket, commentId: "c2", body: "human reply", authorId: "human-user", authorName: "Alice" });
    expect(existsSync(join(tmpDir, "workers", ticket, "inbox.jsonl"))).toBe(true);
  });

  test("appends multiple entries sequentially", () => {
    const ticket = "CTL-99";
    mkdirSync(join(tmpDir, "workers", ticket), { recursive: true });
    const writer = createCommentInboxWriter(tmpDir, "");
    writer({ ticket, commentId: "c1", body: "first", authorId: "u1", authorName: "A" });
    writer({ ticket, commentId: "c2", body: "second", authorId: "u2", authorName: "B" });
    const lines = readFileSync(join(tmpDir, "workers", ticket, "inbox.jsonl"), "utf8")
      .trim().split("\n").map(JSON.parse);
    expect(lines).toHaveLength(2);
    expect(lines[1].body).toBe("second");
  });
});

describe("inbox writer — createUpdateInboxWriter (CTL-749)", () => {
  let tmpDir;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "inbox-update-test-")); });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  test("writes description_changed entry when descriptionChanged is true and ticket is in-flight", () => {
    const ticket = "CTL-99";
    mkdirSync(join(tmpDir, "workers", ticket), { recursive: true });
    const writer = createUpdateInboxWriter(tmpDir, "");
    writer({ ticket, description: "new text", descriptionChanged: true, actorId: "u1", actorName: "Ryan" });
    const lines = readFileSync(join(tmpDir, "workers", ticket, "inbox.jsonl"), "utf8")
      .trim().split("\n").map(JSON.parse);
    expect(lines[0]).toMatchObject({ kind: "description_changed", ticket, description: "new text" });
    expect(lines[0].receivedAt).toBeTruthy();
  });

  test("skips write when descriptionChanged is false", () => {
    const ticket = "CTL-99";
    mkdirSync(join(tmpDir, "workers", ticket), { recursive: true });
    const writer = createUpdateInboxWriter(tmpDir, "");
    writer({ ticket, description: null, descriptionChanged: false, actorId: "u1" });
    expect(existsSync(join(tmpDir, "workers", ticket, "inbox.jsonl"))).toBe(false);
  });

  test("skips write when workers/<ticket>/ does not exist (ticket not in-flight)", () => {
    const writer = createUpdateInboxWriter(tmpDir, "");
    writer({ ticket: "CTL-99", description: "x", descriptionChanged: true, actorId: "u1" });
    expect(existsSync(join(tmpDir, "workers", "CTL-99", "inbox.jsonl"))).toBe(false);
  });

  test("skips write when actorId matches botUserId (self-echo filter)", () => {
    const ticket = "CTL-99";
    mkdirSync(join(tmpDir, "workers", ticket), { recursive: true });
    const writer = createUpdateInboxWriter(tmpDir, "bot-id");
    writer({ ticket, description: "bot edit", descriptionChanged: true, actorId: "bot-id", actorName: "Bot" });
    expect(existsSync(join(tmpDir, "workers", ticket, "inbox.jsonl"))).toBe(false);
  });
});

// readLinearBotUserIds — collects bot UUIDs from Layer-2 new path + Layer-1 back-compat
describe("readLinearBotUserIds", () => {
  let tmpDir;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "bot-ids-test-")); });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  test("returns empty set when both paths are absent", () => {
    const ids = readLinearBotUserIds("/nonexistent/layer1.json", "/nonexistent/layer2.json");
    expect(ids.size).toBe(0);
  });

  test("reads worker botUserId from Layer-2 new global path", () => {
    const layer2 = join(tmpDir, "config.json");
    writeFileSync(layer2, JSON.stringify({
      catalyst: { linear: { bot: { worker: { botUserId: "worker-uuid-1" } } } }
    }));
    const ids = readLinearBotUserIds(null, layer2);
    expect(ids.has("worker-uuid-1")).toBe(true);
    expect(ids.size).toBe(1);
  });

  test("reads orchestrator botUserId from Layer-2 new global path", () => {
    const layer2 = join(tmpDir, "config.json");
    writeFileSync(layer2, JSON.stringify({
      catalyst: { linear: { bot: { orchestrator: { botUserId: "orch-uuid-1" } } } }
    }));
    const ids = readLinearBotUserIds(null, layer2);
    expect(ids.has("orch-uuid-1")).toBe(true);
    expect(ids.size).toBe(1);
  });

  test("reads both worker and orchestrator botUserIds from Layer-2", () => {
    const layer2 = join(tmpDir, "config.json");
    writeFileSync(layer2, JSON.stringify({
      catalyst: {
        linear: {
          bot: {
            worker: { botUserId: "worker-uuid" },
            orchestrator: { botUserId: "orch-uuid" },
          },
        },
      },
    }));
    const ids = readLinearBotUserIds(null, layer2);
    expect(ids.has("worker-uuid")).toBe(true);
    expect(ids.has("orch-uuid")).toBe(true);
    expect(ids.size).toBe(2);
  });

  test("reads Layer-1 back-compat path (catalyst.monitor.linear.botUserId)", () => {
    const layer1 = join(tmpDir, "layer1.json");
    writeFileSync(layer1, JSON.stringify({
      catalyst: { monitor: { linear: { botUserId: "legacy-uuid" } } }
    }));
    const ids = readLinearBotUserIds(layer1, null);
    expect(ids.has("legacy-uuid")).toBe(true);
    expect(ids.size).toBe(1);
  });

  test("merges IDs from both layers; deduplicates when same UUID appears in both", () => {
    const layer1 = join(tmpDir, "layer1.json");
    const layer2 = join(tmpDir, "config.json");
    writeFileSync(layer1, JSON.stringify({
      catalyst: { monitor: { linear: { botUserId: "shared-uuid" } } }
    }));
    writeFileSync(layer2, JSON.stringify({
      catalyst: {
        linear: {
          bot: {
            worker: { botUserId: "shared-uuid" },  // same as layer-1 — should dedup
            orchestrator: { botUserId: "orch-uuid" },
          },
        },
      },
    }));
    const ids = readLinearBotUserIds(layer1, layer2);
    expect(ids.has("shared-uuid")).toBe(true);
    expect(ids.has("orch-uuid")).toBe(true);
    expect(ids.size).toBe(2); // not 3 — deduped
  });

  test("returns empty set when layer2 has no bot section", () => {
    const layer2 = join(tmpDir, "config.json");
    writeFileSync(layer2, JSON.stringify({ catalyst: { linear: {} } }));
    const ids = readLinearBotUserIds(null, layer2);
    expect(ids.size).toBe(0);
  });
});

// _isBotId — normalises string vs Set so guard callers are consistent
describe("_isBotId", () => {
  test("returns false when botUserId is empty string", () => {
    expect(_isBotId("", "some-id")).toBe(false);
  });
  test("returns false when actorId is absent", () => {
    expect(_isBotId("bot-id", null)).toBe(false);
    expect(_isBotId("bot-id", undefined)).toBe(false);
    expect(_isBotId("bot-id", "")).toBe(false);
  });
  test("matches a plain string botUserId", () => {
    expect(_isBotId("bot-id", "bot-id")).toBe(true);
    expect(_isBotId("bot-id", "human-id")).toBe(false);
  });
  test("matches any member of a Set botUserId", () => {
    const ids = new Set(["worker-id", "orch-id"]);
    expect(_isBotId(ids, "worker-id")).toBe(true);
    expect(_isBotId(ids, "orch-id")).toBe(true);
    expect(_isBotId(ids, "human-id")).toBe(false);
  });
  test("returns false for an empty Set", () => {
    expect(_isBotId(new Set(), "some-id")).toBe(false);
  });
});

// inbox writers with Set botUserId
describe("createCommentInboxWriter — Set<string> botUserId", () => {
  let tmpDir;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "inbox-set-test-")); });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  test("skips write when authorId is in the bot Set (worker id)", () => {
    const ticket = "CTL-99";
    mkdirSync(join(tmpDir, "workers", ticket), { recursive: true });
    const ids = new Set(["worker-id", "orch-id"]);
    const writer = createCommentInboxWriter(tmpDir, ids);
    writer({ ticket, commentId: "c1", body: "bot mirror", authorId: "worker-id" });
    expect(existsSync(join(tmpDir, "workers", ticket, "inbox.jsonl"))).toBe(false);
  });

  test("skips write when authorId is in the bot Set (orchestrator id)", () => {
    const ticket = "CTL-99";
    mkdirSync(join(tmpDir, "workers", ticket), { recursive: true });
    const ids = new Set(["worker-id", "orch-id"]);
    const writer = createCommentInboxWriter(tmpDir, ids);
    writer({ ticket, commentId: "c2", body: "orch comment", authorId: "orch-id" });
    expect(existsSync(join(tmpDir, "workers", ticket, "inbox.jsonl"))).toBe(false);
  });

  test("writes when authorId is NOT in the bot Set (human reply)", () => {
    const ticket = "CTL-99";
    mkdirSync(join(tmpDir, "workers", ticket), { recursive: true });
    const ids = new Set(["worker-id", "orch-id"]);
    const writer = createCommentInboxWriter(tmpDir, ids);
    writer({ ticket, commentId: "c3", body: "human reply", authorId: "human-id" });
    expect(existsSync(join(tmpDir, "workers", ticket, "inbox.jsonl"))).toBe(true);
  });
});

describe("createUpdateInboxWriter — Set<string> botUserId", () => {
  let tmpDir;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "update-set-test-")); });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  test("skips write when actorId is in the bot Set", () => {
    const ticket = "CTL-99";
    mkdirSync(join(tmpDir, "workers", ticket), { recursive: true });
    const ids = new Set(["worker-id", "orch-id"]);
    const writer = createUpdateInboxWriter(tmpDir, ids);
    writer({ ticket, description: "updated", descriptionChanged: true, actorId: "orch-id" });
    expect(existsSync(join(tmpDir, "workers", ticket, "inbox.jsonl"))).toBe(false);
  });

  test("writes when actorId is NOT in the bot Set", () => {
    const ticket = "CTL-99";
    mkdirSync(join(tmpDir, "workers", ticket), { recursive: true });
    const ids = new Set(["worker-id", "orch-id"]);
    const writer = createUpdateInboxWriter(tmpDir, ids);
    writer({ ticket, description: "updated", descriptionChanged: true, actorId: "human-id" });
    expect(existsSync(join(tmpDir, "workers", ticket, "inbox.jsonl"))).toBe(true);
  });
});

// CTL-549 + CTL-749: daemon wires onComment (handleCommentWake + inbox writer) and onUpdate
describe("daemon wires onComment and onUpdate to monitorFn (CTL-549 + CTL-749)", () => {
  test("passes onComment and onUpdate callbacks to startMonitor", () => {
    let capturedOpts = null;
    startDaemon({
      recover: () => {},
      reconcileBoot: () => {},
      startMonitor: (opts) => { capturedOpts = opts; },
      startScheduler: () => {},
      watchRegistry: false,
    });
    stopDaemon();
    expect(typeof capturedOpts?.onComment).toBe("function");
    expect(typeof capturedOpts?.onUpdate).toBe("function");
  });
});

// ─── CTL-823: gateway wiring (the slice's whole point — pin it) ──────────────

describe("CTL-823 gateway wiring", () => {
  test("injected classifyResolution serves a fresh store hit with ZERO live reads", async () => {
    const { openBrokerStateDb, closeBrokerStateDb, upsertTicketDescriptor } = await import(
      "../broker/broker-state.mjs"
    );
    // Seed the descriptor store at the path the daemon's default reader
    // resolves (CATALYST_DIR/filter-state.db — pinned to this test's tmp dir).
    openBrokerStateDb(join(catalystDir, "filter-state.db"));
    upsertTicketDescriptor({ ticket: "CTL-GW", state: "Todo", uuid: "u-gw" });
    closeBrokerStateDb();

    let captured;
    startDaemon({
      recover: () => ({}),
      reconcileBoot: () => {},
      startMonitor: () => {},
      startScheduler: (o) => {
        captured = o;
      },
      watchRegistry: false,
    });

    // The reader is threaded for the scheduler's fetchState injections…
    expect(captured.gateway).toBeTruthy();
    // …and the classify wrapper serves the store WITHOUT touching linearis:
    // an exec that would return a definitive not-found must never be reached.
    const execCalls = [];
    const exec = (...args) => {
      execCalls.push(args);
      return { code: 0, stdout: JSON.stringify({ error: "Issue not found" }) };
    };
    expect(captured.classifyResolution("CTL-GW", { exec })).toBe("exists");
    expect(execCalls.length).toBe(0);

    // Store MISS falls through to the live read (fail-open) — and the
    // daemon's reader cannot be dropped by the caller's opts.
    expect(captured.classifyResolution("CTL-MISSING", { exec })).toBe("not-found");
    expect(execCalls.length).toBe(1);
  });
});

// readLinearBotWriteId — resolves the SINGLE bot UUID to write as assignee (CTL-781).
describe("readLinearBotWriteId (CTL-781)", () => {
  let tmpDir;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "bot-write-id-test-")); });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  test("returns catalyst.linear.bot.orchestrator.botUserId from Layer-2 when present", () => {
    const layer2 = join(tmpDir, "config.json");
    writeFileSync(layer2, JSON.stringify({
      catalyst: { linear: { bot: { orchestrator: { botUserId: "orch-uuid-1" } } } }
    }));
    expect(readLinearBotWriteId(null, layer2)).toBe("orch-uuid-1");
  });

  test("falls back to Layer-1 catalyst.monitor.linear.botUserId when Layer-2 absent", () => {
    const layer1 = join(tmpDir, "layer1.json");
    writeFileSync(layer1, JSON.stringify({
      catalyst: { monitor: { linear: { botUserId: "legacy-uuid-1" } } }
    }));
    expect(readLinearBotWriteId(layer1, null)).toBe("legacy-uuid-1");
  });

  test("returns null when neither layer configures an ID (self-assign disabled)", () => {
    expect(readLinearBotWriteId("/nonexistent/l1.json", "/nonexistent/l2.json")).toBeNull();
  });

  test("never throws on unreadable/malformed files", () => {
    const bad = join(tmpDir, "bad.json");
    writeFileSync(bad, "not-json{{");
    expect(() => readLinearBotWriteId(bad, bad)).not.toThrow();
  });
});

// ── CTL-862: daemon.mjs — CATALYST_CONFIG_FILE propagation + ownership boot-log ──
//
// Two independent daemon edits: propagate the resolved config path into process.env
// so getClusterHosts() resolves the right repo regardless of cwd, and replace the
// bare boot-log line with one reporting owned-vs-eligible ticket counts.
describe("CTL-862 — daemon CATALYST_CONFIG_FILE propagation", () => {
  const baseOpts = () => ({
    recover: () => ({}),
    reconcileBoot: () => {},
    startMonitor: () => {},
    startScheduler: () => {},
    stopMonitor: () => {},
    stopScheduler: () => {},
    reconcile: () => {},
    startAutoTuner: () => () => {},
    watchRegistry: false,
    listProjects: () => [],
  });

  test("propagates configPath into CATALYST_CONFIG_FILE when unset (CTL-862)", () => {
    const prev = process.env.CATALYST_CONFIG_FILE;
    delete process.env.CATALYST_CONFIG_FILE;
    const fakeConfigPath = join(catalystDir, "fake-config.json");
    try {
      startDaemon({ ...baseOpts(), configPath: fakeConfigPath });
      expect(process.env.CATALYST_CONFIG_FILE).toBe(fakeConfigPath);
    } finally {
      if (prev === undefined) delete process.env.CATALYST_CONFIG_FILE;
      else process.env.CATALYST_CONFIG_FILE = prev;
    }
  });

  test("does NOT overwrite CATALYST_CONFIG_FILE already set (||= semantics, CTL-862)", () => {
    const prev = process.env.CATALYST_CONFIG_FILE;
    const preExisting = "/pre-set/catalyst/config.json";
    process.env.CATALYST_CONFIG_FILE = preExisting;
    try {
      startDaemon({ ...baseOpts(), configPath: "/new/config.json" });
      expect(process.env.CATALYST_CONFIG_FILE).toBe(preExisting);
    } finally {
      if (prev === undefined) delete process.env.CATALYST_CONFIG_FILE;
      else process.env.CATALYST_CONFIG_FILE = prev;
    }
  });
});

describe("CTL-862 — daemon boot-log ownership context", () => {
  const baseOpts = () => ({
    recover: () => ({}),
    reconcileBoot: () => {},
    startMonitor: () => {},
    startScheduler: () => {},
    stopMonitor: () => {},
    stopScheduler: () => {},
    reconcile: () => {},
    startAutoTuner: () => () => {},
    watchRegistry: false,
    listProjects: () => [],
  });

  test("boot log carries host/owns/eligible/roster fields (CTL-862)", () => {
    const infoSpy = spyOn(log, "info");
    const ROSTER = ["mini", "mac-studio"];
    const SELF = "mini";
    const eligible = [{ identifier: "ENG-1" }, { identifier: "ENG-2" }];
    try {
      startDaemon({
        ...baseOpts(),
        readAllEligible: () => eligible,
        bootHosts: ROSTER,
        bootHostName: SELF,
      });
      const bootCall = infoSpy.mock.calls.find(
        (c) => typeof c[1] === "string" && c[1].includes("daemon started")
      );
      expect(bootCall).toBeDefined();
      const obj = bootCall[0];
      expect(obj.host).toBe(SELF);
      expect(Array.isArray(obj.roster)).toBe(true);
      expect(obj.eligible).toBe(eligible.length);
      expect(typeof obj.owns).toBe("number");
      expect(obj.owns).toBeGreaterThanOrEqual(0);
      expect(obj.owns).toBeLessThanOrEqual(eligible.length);
    } finally {
      infoSpy.mockRestore();
    }
  });
});
