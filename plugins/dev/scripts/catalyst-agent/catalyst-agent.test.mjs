// catalyst-agent.test.mjs — CTL-812. Entrypoint wiring: runDomain's graceful
// skip when a sampler module is missing / malformed, and runOnce honoring the
// per-domain enable flags. All importers are injected so no real sampler files
// (which do not exist at the scaffold stage) are touched.
//
// Run: cd plugins/dev/scripts/catalyst-agent && bun test catalyst-agent.test.mjs

import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDomain, runOnce, main, defaultImporters } from "./catalyst-agent.mjs";
import { readAgentConfig } from "./config.mjs";

const ALL_ON = {
  usageEnabled: true,
  hostEnabled: true,
  processEnabled: true,
  emit: "eventlog",
  intervalMs: 300000,
  topN: 10,
};

describe("runDomain", () => {
  test("invokes runOnce(config) and returns true when the module is present", async () => {
    let seen = null;
    const importer = async () => ({ runOnce: (cfg) => { seen = cfg; } });
    const ok = await runDomain({ name: "usage", importer, config: { tag: "cfg" } });
    expect(ok).toBe(true);
    expect(seen).toEqual({ tag: "cfg" });
  });

  test("returns false (no throw) when the import rejects — the scaffold case", async () => {
    const importer = async () => {
      throw new Error("Cannot find module './usage-sampler.mjs'");
    };
    await expect(runDomain({ name: "usage", importer, config: {} })).resolves.toBe(false);
  });

  test("returns false when the module lacks a runOnce export", async () => {
    const importer = async () => ({ notRunOnce: () => {} });
    await expect(runDomain({ name: "host", importer, config: {} })).resolves.toBe(false);
  });

  test("returns false (no throw) when the sampler tick throws", async () => {
    const importer = async () => ({ runOnce: () => { throw new Error("boom"); } });
    await expect(runDomain({ name: "process", importer, config: {} })).resolves.toBe(false);
  });
});

describe("runOnce", () => {
  test("runs every enabled domain once", async () => {
    const ran = [];
    const importers = {
      usage: async () => ({ runOnce: () => ran.push("usage") }),
      host: async () => ({ runOnce: () => ran.push("host") }),
      process: async () => ({ runOnce: () => ran.push("process") }),
    };
    const results = await runOnce({ config: ALL_ON, importers });
    expect(ran.sort()).toEqual(["host", "process", "usage"]);
    expect(results).toEqual({ usage: true, host: true, process: true });
  });

  test("skips disabled domains", async () => {
    const ran = [];
    const importers = {
      usage: async () => ({ runOnce: () => ran.push("usage") }),
      host: async () => ({ runOnce: () => ran.push("host") }),
      process: async () => ({ runOnce: () => ran.push("process") }),
    };
    const config = { ...ALL_ON, hostEnabled: false, processEnabled: false };
    const results = await runOnce({ config, importers });
    expect(ran).toEqual(["usage"]);
    expect(results).toEqual({ usage: true });
  });

  test("a missing sampler module does not abort sibling domains", async () => {
    const ran = [];
    const importers = {
      usage: async () => { throw new Error("missing"); },
      host: async () => ({ runOnce: () => ran.push("host") }),
      process: async () => ({ runOnce: () => ran.push("process") }),
    };
    const results = await runOnce({ config: ALL_ON, importers });
    expect(ran.sort()).toEqual(["host", "process"]);
    expect(results).toEqual({ usage: false, host: true, process: true });
  });

  test("runOnce awaits in-flight OTLP POSTs before resolving (CTL-812: no drop)", async () => {
    // A domain whose runOnce kicks off a slow async emit. runOnce must not resolve
    // until that async work settles — otherwise --once would exit (and a real
    // process.exit would kill an in-flight OTLP POST). Here the domain's runOnce is
    // itself async and awaited, which is the contract runDomain relies on.
    let settled = false;
    const importers = {
      usage: async () => ({
        runOnce: async () => {
          await new Promise((r) => setTimeout(r, 5));
          settled = true;
        },
      }),
      host: async () => ({ runOnce: () => {} }),
      process: async () => ({ runOnce: () => {} }),
    };
    await runOnce({ config: ALL_ON, importers });
    expect(settled).toBe(true);
  });
});

// ─── main() flag dispatch + exit codes (CTL-812 review: was untested) ──────────

describe("main — flag dispatch & exit codes", () => {
  // A capturing write seam so help/usage text never hits the real streams and we
  // can assert WHICH stream each branch wrote to.
  function captureWrites() {
    const out = [];
    const err = [];
    const write = (stream, text) => {
      (stream === process.stderr ? err : out).push(text);
    };
    return { out, err, write };
  }

  test("--help returns 0 and writes usage to stdout", async () => {
    const { out, err, write } = captureWrites();
    const code = await main(["--help"], { write });
    expect(code).toBe(0);
    expect(out.join("")).toContain("catalyst-agent");
    expect(err.join("")).toBe("");
  });

  test("-h is an alias for --help (returns 0)", async () => {
    const { write } = captureWrites();
    expect(await main(["-h"], { write })).toBe(0);
  });

  test("no flag defaults to --help (returns 0)", async () => {
    const { out, write } = captureWrites();
    expect(await main([], { write })).toBe(0);
    expect(out.join("")).toContain("Usage:");
  });

  test("--install returns 0 and writes the launchd instructions to stdout", async () => {
    const { out, write } = captureWrites();
    expect(await main(["--install"], { write })).toBe(0);
    expect(out.join("")).toContain("launchd");
  });

  test("--once dispatches to the (injected) runOnce and returns 0", async () => {
    let called = 0;
    const { write } = captureWrites();
    const code = await main(["--once"], { write, runOnceImpl: async () => { called++; } });
    expect(code).toBe(0);
    expect(called).toBe(1);
  });

  test("--once awaits runOnce before returning (no early resolve)", async () => {
    // If main() did not await, `done` would still be false when it returns.
    let done = false;
    const { write } = captureWrites();
    await main(["--once"], {
      write,
      runOnceImpl: async () => {
        await new Promise((r) => setTimeout(r, 5));
        done = true;
      },
    });
    expect(done).toBe(true);
  });

  test("an unknown flag returns 2 and writes the error to stderr", async () => {
    const { out, err, write } = captureWrites();
    const code = await main(["--frobnicate"], { write });
    expect(code).toBe(2);
    expect(err.join("")).toContain('unknown flag "--frobnicate"');
    // …and still prints help to stdout so the operator sees the valid flags.
    expect(out.join("")).toContain("Usage:");
  });
});

// ─── main --loop lifecycle (CTL-812 review: the loop silently exited) ──────────

describe("main — --loop lifecycle", () => {
  test("fires the immediate tick AND keeps ticking on the interval (does NOT exit after one)", async () => {
    // The bug: the interval was unref'd and main() resolved `return 0`, so under
    // the real entrypoint `main().then(process.exit)` the process exited 0 right
    // after the first tick — exactly ZERO interval ticks ran. Here we inject a
    // synchronous setInterval seam that fires the registered callback N times, and
    // a resolvable waitForStop, and assert runOnce ran MORE than once (immediate +
    // interval ticks) — i.e. the loop actually loops.
    let ticks = 0;
    let intervalCb = null;
    let cleared = false;
    let stopResolve;
    const stopPromise = new Promise((r) => { stopResolve = r; });

    const code = await main(["--loop"], {
      runOnceImpl: async () => { ticks++; },
      // Capture the interval callback instead of scheduling a real timer.
      setIntervalImpl: (cb) => { intervalCb = cb; return { __fake: true }; },
      clearIntervalImpl: () => { cleared = true; },
      onSignal: () => {}, // do not touch real process signal handlers
      // Drive three interval ticks, then resolve the loop.
      waitForStop: async () => {
        await intervalCb(); // tick 2
        await intervalCb(); // tick 3
        await intervalCb(); // tick 4
        return stopResolveAndWait();
      },
    });

    function stopResolveAndWait() {
      stopResolve();
      return stopPromise;
    }

    expect(code).toBe(0);
    // 1 immediate tick + 3 interval ticks = 4 — proving the loop loops, not exits.
    expect(ticks).toBe(4);
    expect(intervalCb).toBeInstanceOf(Function);
    // The interval is cleared on stop so no timer leaks.
    expect(cleared).toBe(true);
  });

  test("registers SIGINT and SIGTERM handlers", async () => {
    const signals = [];
    let stopResolve;
    const stop = new Promise((r) => { stopResolve = r; });
    await main(["--loop"], {
      runOnceImpl: async () => {},
      setIntervalImpl: () => ({}),
      clearIntervalImpl: () => {},
      onSignal: (name) => signals.push(name),
      waitForStop: () => { stopResolve(); return stop; },
    });
    expect(signals.sort()).toEqual(["SIGINT", "SIGTERM"]);
  });

  test("the interval callback swallows a runOnce rejection (loop survives a bad tick)", async () => {
    // The interval body is `runOnce().catch(...)`; a rejected tick must NOT throw
    // out of the interval callback (which would crash the loop) and must NOT leave
    // an unhandled rejection. The callback is sync (returns undefined) and handles
    // the rejection internally, so calling it must not throw synchronously, and a
    // microtask flush must not surface an unhandled rejection.
    let intervalCb = null;
    let stopResolve;
    const stop = new Promise((r) => { stopResolve = r; });
    let firstTick = true;
    let unhandled = null;
    const onUnhandled = (err) => { unhandled = err; };
    process.on("unhandledRejection", onUnhandled);
    try {
      await main(["--loop"], {
        runOnceImpl: async () => {
          if (firstTick) { firstTick = false; return; } // immediate tick OK
          throw new Error("tick boom"); // interval ticks reject
        },
        setIntervalImpl: (cb) => { intervalCb = cb; return {}; },
        clearIntervalImpl: () => {},
        onSignal: () => {},
        waitForStop: async () => {
          // Calling the interval callback must not throw despite runOnce rejecting.
          expect(() => intervalCb()).not.toThrow();
          // Let the internal .catch() settle, then assert no unhandled rejection.
          await new Promise((r) => setTimeout(r, 5));
          stopResolve();
          return stop;
        },
      });
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(intervalCb).toBeInstanceOf(Function);
    expect(unhandled).toBeNull();
  });
});

// ─── defaultImporters / makeBuilderEmit — the REAL --once wiring (finding 9) ───

describe("defaultImporters — real sampler composition (event-log emit)", () => {
  const ENVS = ["CATALYST_DIR", "CATALYST_AGENT_EMIT", "CATALYST_AGENT_USAGE", "CATALYST_AGENT_HOST", "CATALYST_AGENT_PROCESS"];
  let saved = {};
  function setEnv(env) {
    for (const k of ENVS) { saved[k] = process.env[k]; delete process.env[k]; }
    Object.assign(process.env, env);
  }
  function restoreEnv() {
    for (const k of ENVS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    saved = {};
  }

  function eventLogFor(dir) {
    const now = new Date();
    const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    return join(dir, "events", `${ym}.jsonl`);
  }

  test("the process importer runs the REAL sampleProcesses → writes host.process.sampled to the event log", async () => {
    // Exercises the actual defaultImporters().process.runOnce composition against
    // the real ps + real emit (eventlog mode), proving sampleProcesses({topN}) is
    // wired with the right signature and the emit reaches the monthly log. ps is
    // fast and never-throws, so this is deterministic enough on macOS CI.
    const dir = mkdtempSync(join(tmpdir(), "ctl812-wire-"));
    setEnv({ CATALYST_DIR: dir, CATALYST_AGENT_EMIT: "eventlog" });
    try {
      const importers = defaultImporters();
      const mod = await importers.process();
      await mod.runOnce(readAgentConfig());
      const logPath = eventLogFor(dir);
      expect(existsSync(logPath)).toBe(true);
      const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);
      const first = JSON.parse(lines[0]);
      expect(first.attributes["event.name"]).toBe("host.process.sampled");
      expect(first.resource["service.name"]).toBe("catalyst.agent");
    } finally {
      restoreEnv();
    }
  });

  test("the host importer runs the REAL sampleHost → makeBuilderEmit → host.metrics.sampled (eventlog)", async () => {
    // Exercises defaultImporters().host.runOnce → sampleHost({ emit:
    // makeBuilderEmit(config) }) end to end against the real host probes (no
    // network), proving the makeBuilderEmit (name, spec, opts) seam matches the
    // sampler's expected emit signature and the contract envelope reaches the log.
    const dir = mkdtempSync(join(tmpdir(), "ctl812-wire-host-"));
    setEnv({ CATALYST_DIR: dir, CATALYST_AGENT_EMIT: "eventlog" });
    try {
      const importers = defaultImporters();
      const mod = await importers.host();
      await mod.runOnce(readAgentConfig());
      const logPath = eventLogFor(dir);
      expect(existsSync(logPath)).toBe(true);
      const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
      // Exactly one host.metrics.sampled event per host tick.
      expect(lines.length).toBe(1);
      const env = JSON.parse(lines[0]);
      expect(env.attributes["event.name"]).toBe("host.metrics.sampled");
      expect(env.attributes["event.entity"]).toBe("host");
      expect(env.resource["service.name"]).toBe("catalyst.agent");
    } finally {
      restoreEnv();
    }
  });

  test("OTLP mode: runOnce awaits the in-flight POST before resolving (CTL-812 drop fix, end to end)", async () => {
    // The load-bearing --once fix proven through the REAL path: emit=otlp, only the
    // host domain enabled (no other network), and globalThis.fetch monkeypatched to
    // a slow POST. After runOnce() resolves the POST MUST have finished — the bug
    // was process.exit() killing an abandoned fire-and-forget POST. We assert the
    // POST both STARTED and FINISHED by the time runOnce resolved.
    const dir = mkdtempSync(join(tmpdir(), "ctl812-otlp-"));
    setEnv({
      CATALYST_DIR: dir,
      CATALYST_AGENT_EMIT: "otlp",
      CATALYST_AGENT_USAGE: "0", // no keychain/usage network
      CATALYST_AGENT_PROCESS: "0", // host only
    });
    process.env.CATALYST_AGENT_OTLP_ENDPOINT = "http://127.0.0.1:4318";
    const realFetch = globalThis.fetch;
    let started = false;
    let finished = false;
    globalThis.fetch = async (url) => {
      started = true;
      await new Promise((r) => setTimeout(r, 40));
      finished = true;
      return { status: 200 };
    };
    try {
      // Real runOnce with the real defaultImporters + real makeBuilderEmit drain.
      const results = await runOnce();
      expect(results.host).toBe(true);
      expect(started).toBe(true);
      // The decisive assertion: the POST completed before runOnce returned, so a
      // subsequent process.exit(0) (the --once entrypoint) would NOT drop it.
      expect(finished).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.CATALYST_AGENT_OTLP_ENDPOINT;
      restoreEnv();
    }
  });

  test("every importer resolves to a module with an async runOnce (lazy import + adapter shape)", async () => {
    // Structural wiring check for ALL three domains, with NO network: the usage
    // importer's runOnce would hit the live keychain + usage API if executed on a
    // dev host, so we deliberately do NOT call it here — we assert the lazy import
    // resolves and yields the uniform { runOnce } adapter (the import.meta.url path
    // + two-level .then chain for usage). The deep enumerate→tick→emit and
    // sampleHost/sampleProcesses signatures are validated by the host & process
    // event-log tests above and by the per-module unit suites.
    const importers = defaultImporters();
    for (const key of ["usage", "host", "process"]) {
      const mod = await importers[key]();
      expect(typeof mod.runOnce).toBe("function");
      // Each adapter's runOnce is async (returns a promise) so runOnce/runDomain
      // can await it (the load-bearing property for the OTLP drain).
      expect(mod.runOnce.constructor.name).toBe("AsyncFunction");
    }
  });
});
