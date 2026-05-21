#!/usr/bin/env bun
// index.mjs — execution-core Todo-state monitor: thin standalone main()
// entrypoint plus a barrel of public re-exports (CTL-535 Phase 5).
//
// Runnable directly (`bun index.mjs`) for integration testing and operator
// use. CTL-554's execution-core daemon will instead `import { startMonitor }`
// from this barrel — main() runs only under direct invocation.

import { startMonitor, stopMonitor } from "./monitor.mjs";
import { log } from "./config.mjs";

// --- Barrel re-exports (every public symbol of the monitor) -------------
export * from "./config.mjs";
export * from "./enrollment.mjs";
export * from "./linear-query.mjs";
export * from "./eligible-set.mjs";
// monitor.mjs is re-exported explicitly so the test-only __resetForTests
// helper stays out of the public barrel.
export {
  parseStateChangedEvent,
  reconcileProject,
  reconcileAll,
  handleStateChangedEvent,
  seedTailerAtEof,
  startTailing,
  startMonitor,
  stopMonitor,
} from "./monitor.mjs";

// --- Standalone entrypoint ----------------------------------------------
function main() {
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
