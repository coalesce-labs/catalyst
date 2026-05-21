#!/usr/bin/env bun
// index.mjs — execution-core Todo-state monitor: thin standalone main()
// entrypoint plus a barrel of public re-exports (CTL-535 Phase 5).
//
// Runnable directly (`bun index.mjs`) for integration testing and operator
// use. CTL-554's execution-core daemon will instead `import { startMonitor }`
// from this barrel — main() runs only under direct invocation.

import { startMonitor, stopMonitor } from "./monitor.mjs";
import { log } from "./config.mjs";
import { runScan } from "./scan.mjs";
import { makeScanAdapters } from "./scan-adapters.mjs";
import { writeEnrollmentRecord, removeEnrollmentRecord } from "./enrollment.mjs";

// --- Barrel re-exports (every public symbol of the monitor) -------------
export * from "./config.mjs";
export * from "./enrollment.mjs";
export * from "./linear-query.mjs";
export * from "./eligible-set.mjs";
// CTL-565: the shared worker-dispatch adapter (D9 executor seam).
export * from "./dispatch.mjs";
// monitor.mjs is re-exported explicitly so the test-only __resetForTests
// helper stays out of the public barrel.
export {
  parseStateChangedEvent,
  reconcileProject,
  reconcileAll,
  handleStateChangedEvent,
  seedTailerAtEof,
  seedTailerFromCursor,
  startTailing,
  startMonitor,
  stopMonitor,
} from "./monitor.mjs";
// scheduler.mjs (CTL-536) — re-exported explicitly so the test-only
// __resetForTests helper stays out of the public barrel.
export {
  schedulerTick,
  startScheduler,
  stopScheduler,
  computeReadyTickets,
  selectDispatchable,
  deriveAdvancement,
  readAllEligibleTickets,
  hydrateOutOfSetBlockers,
} from "./scheduler.mjs";

// --- CTL-539: crash-recovery & startup reconstruction --------------------
export * from "./event-cursor.mjs";
export {
  defaultStatJob,
  classifyWorker,
  reconstructWorkerState,
  recoverStartup,
} from "./recovery.mjs";

// --- CTL-533: deterministic per-event scan module -----------------------
export * from "./signal-reader.mjs";
export * from "./merge-state.mjs";
export * from "./stalled-detector.mjs";
export * from "./comms-drain.mjs";
export * from "./deploy-state.mjs";
export { runScan } from "./scan.mjs";

// --- CLI arg parsing ----------------------------------------------------
// parseFlags — minimal `--key value` parser for the scan subcommand.
function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (typeof key === "string" && key.startsWith("--")) {
      flags[key.slice(2)] = argv[i + 1];
    }
  }
  return flags;
}

// runScanCli — `bun index.mjs scan --orch-dir <dir> --orch-id <id> [...]`.
// Builds real git/gh/deploy/comms adapters, runs one deterministic scan, and
// prints the result JSON to stdout. Apply-nothing dry run (CTL-533 Phase 4):
// the integration ticket wires the patches back to disk.
function runScanCli(argv) {
  const flags = parseFlags(argv);
  const orchDir = flags["orch-dir"];
  const orchId = flags["orch-id"];
  if (!orchDir || !orchId) {
    log.error("scan requires --orch-dir <dir> and --orch-id <id>");
    process.exit(2);
  }
  const adapters = makeScanAdapters({
    orchId,
    worktreeBase: flags["worktree-base"] ?? `${orchDir}/../worktrees`,
    configPath: flags["config"] ?? null,
    channelFile: flags["channel-file"] ?? null,
  });
  const result = runScan({
    orchDir,
    orchId,
    event: null,
    nowMs: Date.now(),
    commsCursor: Number(flags["comms-cursor"]) || 0,
    adapters,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
}

// --- Standalone entrypoint ----------------------------------------------
function main() {
  const argv = process.argv.slice(2);
  // CTL-533: `scan` subcommand — one-shot deterministic scan dry run.
  if (argv[0] === "scan") {
    runScanCli(argv.slice(1));
    return;
  }

  // CTL-554: `enroll` / `unenroll` subcommands — the enrollment-record
  // lifecycle /orchestrate drives in execution-core dispatchMode. parseFlags
  // is the shared `--key value` parser already used by the scan subcommand.
  if (argv[0] === "enroll") {
    const opts = parseFlags(argv.slice(1)); // --project-key, --repo-root
    const rec = writeEnrollmentRecord({
      projectKey: opts["project-key"],
      repoRoot: opts["repo-root"],
    });
    log.info(
      { projectKey: rec.projectKey, repoRoot: rec.repoRoot },
      "execution-core: enrolled project"
    );
    return;
  }
  if (argv[0] === "unenroll") {
    const opts = parseFlags(argv.slice(1));
    removeEnrollmentRecord(opts["project-key"]);
    log.info({ projectKey: opts["project-key"] }, "execution-core: unenrolled project");
    return;
  }

  // Default: the CTL-535 Todo-state monitor.
  log.info("execution-core Todo-state monitor starting");
  startMonitor();
  const shutdown = (sig) => {
    log.info({ sig }, "execution-core monitor shutting down");
    stopMonitor();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Run main() only on direct invocation, never when imported as a module
// (CTL-554's daemon imports the barrel above without triggering main()).
if (import.meta.main) main();
