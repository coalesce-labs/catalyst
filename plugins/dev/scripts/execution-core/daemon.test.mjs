// Unit tests for the execution-core composing daemon (CTL-554 Phase 3).
// Run: cd plugins/dev/scripts/execution-core && bun test daemon.test.mjs
//
// startDaemon takes dependency-injected recover/monitor/scheduler/reconcile
// functions so no real timers, Linear polls, or child processes run — the
// composition logic is exercised deterministically.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
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
  __resetEventTailCursorForTest,
  __getEventTailLeftoverForTest,
} from "./daemon.mjs";
import { upsertProjectEntry } from "./registry.mjs";

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
    upsertProjectEntry({ team: "DEMO", repoRoot: "/r/d", eligibleQuery: { status: "Ready" } });
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
            eligibleQuery: { status: "Ready" },
          },
        },
      },
    });
    const layer2Path = writeJson("layer2.json", {
      catalyst: { orchestration: { executionCore: { maxParallel: 6 } } },
    });
    expect(resolveBootConcurrency({ layer1Path, layer2Path })).toEqual({
      maxParallel: 6,
      eligibleQuery: { status: "Ready" },
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
