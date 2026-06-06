#!/usr/bin/env node
// catalyst-agent.mjs — CTL-812. Standalone host-telemetry agent entrypoint.
//
// A SELF-CONTAINED process (zero npm deps, node:* builtins only; runs under both
// node>=18 and bun) that, once per launchd StartInterval tick, samples three
// domains and emits OTel envelopes via the configured transport:
//   1. account.ratelimit.sampled  (CATALYST_AGENT_USAGE)
//   2. host.metrics.sampled       (CATALYST_AGENT_HOST)
//   3. host.process.sampled       (CATALYST_AGENT_PROCESS, one event per top-N proc)
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
import { makeBuilderEmit } from "./emit.mjs";

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
// Resolved relative to this module via import.meta.url so the agent can launch
// from any cwd. The dynamic import is still lazy: a domain whose module fails to
// load is skipped by runDomain instead of crashing the whole agent.
function defaultImporters() {
  return {
    // Domain 1 — account.ratelimit.sampled. Enumerate every account (active +
    // refreshed swap backups), then sample usage for each, emitting one event per
    // account. emit is the builder-style (name, spec, {now}) seam tickUsage wants.
    usage: () =>
      import(new URL("./usage.mjs", import.meta.url).href).then((usage) =>
        import(new URL("./accounts.mjs", import.meta.url).href).then((accounts) => ({
          runOnce: async (config) => {
            const enumerated = await accounts.enumerateAccounts();
            await usage.tickUsage({ accounts: enumerated, emit: makeBuilderEmit(config) });
          },
        })),
      ),
    // Domain 2 — host.metrics.sampled. One event per tick.
    host: () =>
      import(new URL("./host.mjs", import.meta.url).href).then((host) => ({
        runOnce: async (config) => {
          await host.sampleHost({ emit: makeBuilderEmit(config) });
        },
      })),
    // Domain 3 — host.process.sampled. One event per top-N process by RSS.
    // sampleProcesses takes the envelope-style emit (already-built envelope), so
    // it routes through emitEnvelope via its own default — we pass topN from config.
    process: () =>
      import(new URL("./processes.mjs", import.meta.url).href).then((processes) => ({
        runOnce: (config) => {
          processes.sampleProcesses({ topN: config.topN });
        },
      })),
  };
}

/**
 * runOnce — run one tick of each ENABLED domain. Returns the per-domain outcome
 * map. `config` and `importers` are injectable for tests.
 */
export async function runOnce({ config = readAgentConfig(), importers = defaultImporters() } = {}) {
  const results = {};
  if (config.usageEnabled) {
    results.usage = await runDomain({ name: "usage", importer: importers.usage, config });
  }
  if (config.hostEnabled) {
    results.host = await runDomain({ name: "host", importer: importers.host, config });
  }
  if (config.processEnabled) {
    results.process = await runDomain({ name: "process", importer: importers.process, config });
  }
  return results;
}

// --- CLI ---
// Exported so a test can assert flag dispatch without spawning a process.
export async function main(argv = process.argv.slice(2)) {
  const flag = argv.find((a) => a.startsWith("--")) ?? "--help";

  if (flag === "--help" || flag === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  if (flag === "--install") {
    process.stdout.write(INSTALL);
    return 0;
  }
  if (flag === "--once") {
    await runOnce();
    return 0;
  }
  if (flag === "--loop") {
    const config = readAgentConfig();
    log.info({ intervalMs: config.intervalMs }, "catalyst-agent: starting loop");
    // Fire one tick immediately, then on the interval. unref() so a bare `node
    // catalyst-agent.mjs --loop` does not, by itself, keep the event loop alive
    // (launchd uses --once instead); the SIGINT/SIGTERM handlers below are what
    // keep the process running and give it a clean stop.
    await runOnce({ config });
    const handle = setInterval(() => {
      runOnce({ config }).catch((err) =>
        log.warn({ err: err?.message }, "catalyst-agent: loop tick failed"),
      );
    }, config.intervalMs);
    if (typeof handle?.unref === "function") handle.unref();
    // Clean stop on a termination signal: clear the interval and exit 0 so the
    // loop never leaves a dangling timer (and a launchd KeepAlive restart is a
    // clean handoff, not a kill -9).
    const stop = (signal) => {
      log.info({ signal }, "catalyst-agent: stopping loop");
      clearInterval(handle);
      process.exit(0);
    };
    process.on("SIGINT", () => stop("SIGINT"));
    process.on("SIGTERM", () => stop("SIGTERM"));
    return 0;
  }

  process.stderr.write(`catalyst-agent: unknown flag "${flag}"\n\n`);
  process.stdout.write(HELP);
  return 2;
}

// Only run when invoked directly (not when imported by a test). The
// import.meta.url vs process.argv[1] guard works under both node and bun.
const invokedPath = process.argv[1] ? new URL(`file://${process.argv[1]}`).href : "";
if (invokedPath && import.meta.url === invokedPath) {
  main().then((code) => process.exit(code));
}
