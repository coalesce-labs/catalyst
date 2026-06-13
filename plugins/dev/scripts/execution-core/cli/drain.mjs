// cli/drain.mjs — CTL-1095. `catalyst-execution-core drain [--off] [--json]`
//
// Toggles the drain flag file, emits node.drain.changed, and prints drain
// state with in-flight count. setDrain and readDrainStatus are pure business
// logic, exported for unit tests; main() is the CLI entry point.

import { writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getExecutionCoreDir, getDrainFlagPath, isDraining } from "../config.mjs";
import { listInFlightTickets } from "../scheduler.mjs";
import { emitDrainChangedEvent } from "../drain-event.mjs";

/**
 * readDrainStatus — pure read of current drain state + in-flight count.
 * @param {string} [orchDir]
 * @returns {{ draining: boolean, inFlightCount: number }}
 */
export function readDrainStatus(orchDir) {
  const dir = orchDir ?? getExecutionCoreDir();
  const draining = isDraining(dir);
  const inFlightCount = listInFlightTickets(dir).size;
  return { draining, inFlightCount };
}

/**
 * setDrain — toggle the drain flag, emit node.drain.changed.
 * @param {string} [orchDir]
 * @param {{ off?: boolean }} [opts]
 * @returns {{ draining: boolean, inFlightCount: number }}
 */
export function setDrain(orchDir, { off = false } = {}) {
  const dir = orchDir ?? getExecutionCoreDir();
  const flagPath = getDrainFlagPath(dir);
  if (off) {
    try { rmSync(flagPath, { force: true }); } catch { /* best-effort */ }
  } else {
    try { writeFileSync(flagPath, ""); } catch { /* best-effort */ }
  }
  const status = readDrainStatus(dir);
  emitDrainChangedEvent({ draining: status.draining, inFlightCount: status.inFlightCount });
  return status;
}

export function main(argv = process.argv.slice(2)) {
  const json = argv.includes("--json");
  const off = argv.includes("--off");
  const readOnly = argv.includes("--status-read");
  const orchDir = getExecutionCoreDir();
  const status = readOnly ? readDrainStatus(orchDir) : setDrain(orchDir, { off });

  if (json) {
    process.stdout.write(JSON.stringify(status) + "\n");
  } else if (status.draining) {
    process.stdout.write(
      `draining — ${status.inFlightCount} ticket${status.inFlightCount === 1 ? "" : "s"} to land\n`
    );
  } else {
    process.stdout.write("not draining\n");
  }
  process.exitCode = 0;
}

const isEntry =
  import.meta.main === true ||
  (typeof import.meta.url === "string" &&
    fileURLToPath(import.meta.url) === process.argv[1]);

if (isEntry) {
  main();
}
