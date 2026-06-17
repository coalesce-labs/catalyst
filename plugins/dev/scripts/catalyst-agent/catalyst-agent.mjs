#!/usr/bin/env node
// catalyst-agent.mjs — CTL-812. Standalone host-telemetry agent entrypoint.
//
// A SELF-CONTAINED process (zero npm deps, node:* builtins only; runs under both
// node>=18 and bun) that, once per launchd StartInterval tick, samples three
// domains and emits OTel envelopes via the configured transport:
//   1. account.ratelimit.sampled  (CATALYST_AGENT_USAGE)
//   2. host.metrics.sampled       (CATALYST_AGENT_HOST)
//   3. host.process.sampled       (CATALYST_AGENT_PROCESS, one event per top-N proc)
//   4. catalyst.build.info + catalyst.vcs.commits_behind  (CATALYST_AGENT_VERSION)
//
// Modes:
//   --once     run one tick of each enabled domain, then exit 0 (launchd path)
//   --loop     run on an internal setInterval at config.intervalMs
//   --install  print the launchd install instructions
//   --help     usage
//
// The three per-domain samplers live in sibling modules (usage.mjs + accounts.mjs,
// host.mjs, processes.mjs) and are imported LAZILY through `importers` — each one
// adapted to a uniform `{ runOnce(config) }` shape. The lazy import means a
// missing / unparseable domain module is logged and skipped, never a crash, and
// it keeps `importers` injectable so tests drive runDomain/runOnce with stubs and
// touch no real network, ps, or keychain.

import { readAgentConfig, log } from "./config.mjs";
import { makeBuilderEmit, drainPending } from "./emit.mjs";

const HELP = `catalyst-agent — standalone host telemetry agent (CTL-812)

Usage:
  catalyst-agent.mjs --once       Run one tick of each enabled domain, then exit
  catalyst-agent.mjs --loop       Run continuously on the configured interval
  catalyst-agent.mjs --install    Print launchd install instructions
  catalyst-agent.mjs --help       Show this help

Domains (each emits OTel envelopes; toggle with env, default on):
  account.ratelimit.sampled   CATALYST_AGENT_USAGE=0    to disable
  host.metrics.sampled        CATALYST_AGENT_HOST=0     to disable
  host.process.sampled        CATALYST_AGENT_PROCESS=0  to disable
  catalyst.build.info/vcs     CATALYST_AGENT_VERSION=0  to disable

Emit (CATALYST_AGENT_EMIT, default eventlog):
  eventlog   append JSONL to ~/catalyst/events/<YYYY-MM>.jsonl
  otlp       POST OTLP/HTTP JSON logs to <CATALYST_AGENT_OTLP_ENDPOINT>/v1/logs
  both       do both

Other env knobs:
  CATALYST_AGENT_INTERVAL_MS  tick cadence (default 300000, floor 180000)
  CATALYST_AGENT_TOP_N        top-N processes by RSS (default 10)
  CATALYST_AGENT_OTLP_HEADERS extra OTLP headers, "k=v,k=v"
  CATALYST_DIR                override the catalyst dir (event-log root)
`;

const INSTALL = `catalyst-agent launchd install (macOS)

  1. Copy the plist into LaunchAgents:
       cp com.catalyst.agent.plist ~/Library/LaunchAgents/com.catalyst.agent.plist
     (or run ./install.sh from this directory — it does this idempotently)

  2. Edit the copied plist: replace REPLACE_WITH_NODE with the absolute path to
     your node binary (e.g. $(which node)) and REPLACE_WITH_AGENT with the
     absolute path to catalyst-agent.mjs.

  3. Load it:
       launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.catalyst.agent.plist

  4. Verify:
       launchctl list | grep com.catalyst.agent
       tail -f ~/catalyst/catalyst-agent.log

  To stop/unload:
       launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.catalyst.agent.plist
`;

/**
 * runDomain — lazily import a domain sampler module and invoke its tick. The
 * import + tick are both wrapped so a domain whose module fails to load OR whose
 * tick throws is skipped with a warning instead of crashing the whole agent —
 * this is the per-domain failure isolation: one domain throwing never stops the
 * others.
 *
 * Each (adapted) sampler module exports `runOnce(config)`. `importer` is
 * injectable for tests so a test can supply a stub module without a real file on
 * disk and without any real network / ps / keychain I/O.
 *
 * @param {object} spec
 * @param {string}   spec.name      human label for logs
 * @param {Function} spec.importer  async () => module (lazy import)
 * @param {object}   spec.config    the resolved agent config
 * @returns {Promise<boolean>} true if the domain ran, false if skipped/failed
 */
export async function runDomain({ name, importer, config }) {
  let mod;
  try {
    mod = await importer();
  } catch (err) {
    log.warn({ domain: name, err: err?.message }, "catalyst-agent: sampler module unavailable; skipping");
    return false;
  }
  if (!mod || typeof mod.runOnce !== "function") {
    log.warn({ domain: name }, "catalyst-agent: sampler has no runOnce(); skipping");
    return false;
  }
  try {
    await mod.runOnce(config);
    return true;
  } catch (err) {
    log.warn({ domain: name, err: err?.message }, "catalyst-agent: sampler tick failed");
    return false;
  }
}

// Default lazy importers for the three domain samplers. Each returns a module
// shaped { runOnce(config) } so runDomain() can drive them uniformly; the real
// sampler modules (usage.mjs/accounts.mjs, host.mjs, processes.mjs) expose
// richer, fully-injectable APIs, so each importer adapts that API to runOnce and
// wires the config-aware emit seam (makeBuilderEmit → emit per CATALYST_AGENT_EMIT).
//
// `pending` is the shared array every OTLP POST promise is collected into; runOnce
// drains it AFTER all domains have ticked so a `--once` / launchd run never exits
// while a POST is still in flight (CTL-812 review — emit is not fire-and-forget).
// In the default eventlog mode nothing is pushed (appendFileSync is synchronous).
//
// Resolved relative to this module via import.meta.url so the agent can launch
// from any cwd. The dynamic import is still lazy: a domain whose module fails to
// load is skipped by runDomain instead of crashing the whole agent.
//
// Exported so a test can drive the REAL enumerate→tick→emit / sampleHost /
// sampleProcesses composition (the production --once wiring) end to end, not just
// injected stubs (CTL-812 review).
export function defaultImporters(pending = []) {
  return {
    // Domain 1 — account.ratelimit.sampled. Enumerate every account (active +
    // refreshed swap backups), then sample usage for each, emitting one event per
    // account. emit is the builder-style (name, spec, {now}) seam tickUsage wants;
    // it pushes each OTLP POST promise into `pending` for the drain.
    usage: () =>
      import(new URL("./usage.mjs", import.meta.url).href).then((usage) =>
        import(new URL("./accounts.mjs", import.meta.url).href).then((accounts) => ({
          runOnce: async (config) => {
            const enumerated = await accounts.enumerateAccounts();
            await usage.tickUsage({ accounts: enumerated, emit: makeBuilderEmit(config, { pending }) });
          },
        })),
      ),
    // Domain 2 — host.metrics.sampled. One event per tick.
    host: () =>
      import(new URL("./host.mjs", import.meta.url).href).then((host) => ({
        runOnce: async (config) => {
          await host.sampleHost({ emit: makeBuilderEmit(config, { pending }) });
        },
      })),
    // Domain 3 — host.process.sampled. One event per top-N process by RSS.
    // sampleProcesses takes the envelope-style emit (already-built envelope) and
    // routes it through emitEnvelope via its own default; it drains its OWN OTLP
    // POSTs internally (it is async), so there is nothing to collect here — we
    // just pass topN from config and await it.
    process: () =>
      import(new URL("./processes.mjs", import.meta.url).href).then((processes) => ({
        runOnce: async (config) => {
          await processes.sampleProcesses({ topN: config.topN });
        },
      })),
    // Domain 4 (CTL-1235) — catalyst.build.info + catalyst.vcs.commits_behind.
    // Emits the running version/commit + drift-from-main as OTLP gauges. Uses its
    // own config-aware metric emit (like host), so nothing is collected here.
    version: () =>
      import(new URL("./version.mjs", import.meta.url).href).then((version) => ({
        runOnce: async () => {
          await version.sampleVersion();
        },
      })),
  };
}

/**
 * runOnce — run one tick of each ENABLED domain, then DRAIN any in-flight OTLP
 * POSTs before returning, so the `--once` / launchd caller can exit without
 * dropping telemetry (CTL-812 review). Returns the per-domain outcome map.
 * `config` and `importers` are injectable for tests; when `importers` is
 * injected the caller owns its own emit/drain semantics, so the internal drain
 * is a no-op (its `pending` stays empty).
 */
export async function runOnce({ config = readAgentConfig(), importers } = {}) {
  const pending = [];
  const useImporters = importers ?? defaultImporters(pending);
  const results = {};
  if (config.usageEnabled) {
    results.usage = await runDomain({ name: "usage", importer: useImporters.usage, config });
  }
  if (config.hostEnabled) {
    results.host = await runDomain({ name: "host", importer: useImporters.host, config });
  }
  if (config.processEnabled) {
    results.process = await runDomain({ name: "process", importer: useImporters.process, config });
  }
  if (config.versionEnabled) {
    results.version = await runDomain({ name: "version", importer: useImporters.version, config });
  }
  // Await every OTLP POST kicked off this tick before resolving — the load-
  // bearing fix for the --once telemetry-drop. No-op in eventlog mode / when a
  // test injects its own importers (pending stays empty).
  await drainPending(pending);
  return results;
}

// --- CLI ---
/**
 * main — parse the flag and dispatch. Exported (and fully seam-injected) so a
 * test can assert the flag-dispatch ladder, the --once exit code, AND the --loop
 * lifecycle WITHOUT spawning a process or blocking forever.
 *
 * Exit codes (the launchd contract): --help/--install/--once → 0, --loop runs
 * until a signal (the direct entrypoint never resolves it; on SIGINT/SIGTERM the
 * stop() handler exits 0 directly), an unknown flag → 2.
 *
 * `deps` are injectable seams; the defaults are the production wiring:
 * @param {string[]} [argv]
 * @param {object}   [deps]
 * @param {Function} [deps.runOnceImpl=runOnce]   the per-tick runner
 * @param {Function} [deps.setIntervalImpl=setInterval]   timer factory (returns a handle)
 * @param {Function} [deps.clearIntervalImpl=clearInterval]
 * @param {Function} [deps.onSignal]   (name, handler) registrar; defaults to process.on
 * @param {Function} [deps.waitForStop]  () => Promise that resolves when the loop should end;
 *                                        default never resolves (process-lifetime loop)
 * @param {Function} [deps.write]   (stream, text) writer; defaults to the real streams
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const {
    runOnceImpl = runOnce,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
    onSignal = (name, handler) => process.on(name, handler),
    // Default: a promise that never resolves so the loop runs for the life of the
    // process (the only exit is the signal handler calling process.exit). A test
    // injects a resolvable one to drive a finite number of ticks.
    waitForStop = () => new Promise(() => {}),
    write = (stream, text) => stream.write(text),
  } = deps;

  const flag = argv.find((a) => a.startsWith("--")) ?? "--help";

  if (flag === "--help" || flag === "-h") {
    write(process.stdout, HELP);
    return 0;
  }
  if (flag === "--install") {
    write(process.stdout, INSTALL);
    return 0;
  }
  if (flag === "--once") {
    await runOnceImpl();
    return 0;
  }
  if (flag === "--loop") {
    const config = readAgentConfig();
    log.info({ intervalMs: config.intervalMs }, "catalyst-agent: starting loop");
    // Fire one tick immediately, then keep ticking on the interval. The interval
    // is deliberately NOT unref()'d: a ref'd timer is what holds the event loop
    // open so the process actually loops (Node signal listeners and an unref'd
    // timer do NOT keep the loop alive — an earlier version unref'd this handle
    // AND resolved main() with `return 0`, so `main().then(process.exit)` killed
    // the process right after the first tick, CTL-812 review). launchd uses
    // --once instead, so this long-lived mode is the interactive/manual path.
    await runOnceImpl({ config });
    const handle = setIntervalImpl(() => {
      runOnceImpl({ config }).catch((err) =>
        log.warn({ err: err?.message }, "catalyst-agent: loop tick failed"),
      );
    }, config.intervalMs);
    // Clean stop on a termination signal: clear the interval (releasing the ref
    // keeping the loop alive) and exit 0 so the loop never leaves a dangling
    // timer (and a launchd KeepAlive restart is a clean handoff, not a kill -9).
    const stop = (signal) => {
      log.info({ signal }, "catalyst-agent: stopping loop");
      clearIntervalImpl(handle);
      process.exit(0);
    };
    onSignal("SIGINT", () => stop("SIGINT"));
    onSignal("SIGTERM", () => stop("SIGTERM"));
    // Block here until waitForStop resolves. In production it never resolves (the
    // loop runs on the ref'd interval until a signal exits the process), so
    // main()'s caller never reaches `process.exit(code)` and the loop survives.
    // A test injects a resolvable waitForStop to end deterministically and clears
    // the interval itself so no timer leaks past the test.
    await waitForStop();
    clearIntervalImpl(handle);
    return 0;
  }

  write(process.stderr, `catalyst-agent: unknown flag "${flag}"\n\n`);
  write(process.stdout, HELP);
  return 2;
}

// Only run when invoked directly (not when imported by a test). The
// import.meta.url vs process.argv[1] guard works under both node and bun.
const invokedPath = process.argv[1] ? new URL(`file://${process.argv[1]}`).href : "";
if (invokedPath && import.meta.url === invokedPath) {
  main().then((code) => process.exit(code));
}
