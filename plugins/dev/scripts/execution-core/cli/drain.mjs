//bin/true 2>/dev/null; exec 1>&2; echo "REFUSING: a SHELL is executing this JavaScript module — see CTL-1937."; exit 97
// cli/drain.mjs — CTL-1095. `catalyst-execution-core drain [--off] [--json]`
//
// Toggles the drain flag file, emits node.drain.changed, and prints drain
// state with in-flight count. setDrain and readDrainStatus are pure business
// logic, exported for unit tests; main() is the CLI entry point.

import { writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getExecutionCoreDir, getDrainFlagPath, resolveDrainStateForRead } from "../config.mjs";
import { listInFlightTickets } from "../scheduler.mjs";
import { emitDrainChangedEvent } from "../drain-event.mjs";

/**
 * readDrainStatus — pure read of current drain state + in-flight count.
 * CTL-1678: reads resolveDrainStateForRead so the three-state distinction
 * (flagPresent / disabled / draining) is surfaced additively — and (Codex round-3 P1)
 * the disabled/draining answer comes from the LIVE daemon's boot-time env snapshot
 * when one exists, falling back to this process's env (pre-sourced from
 * execution-core.env by the bash wrappers) only when no daemon is running.
 * @param {string} [orchDir]
 * @param {{ resolveState?: typeof resolveDrainStateForRead }} [deps]
 * @returns {{ draining: boolean, flagPresent: boolean, disabled: boolean, inFlightCount: number, source: string }}
 */
export function readDrainStatus(orchDir, { resolveState = resolveDrainStateForRead } = {}) {
  const dir = orchDir ?? getExecutionCoreDir();
  const { draining, flagPresent, disabled, source } = resolveState(dir);
  const inFlightCount = listInFlightTickets(dir).size;
  return { draining, flagPresent, disabled, inFlightCount, source };
}

/**
 * formatDrainStatus — CTL-1678. Pure human-readable one-liner for the non-JSON
 * CLI branch, covering the four states: draining / flag-present-but-IGNORED /
 * drain-disabled-no-flag / plain not-draining.
 * @param {{ draining: boolean, flagPresent: boolean, disabled: boolean, inFlightCount: number }} status
 * @returns {string} line WITHOUT a trailing newline
 */
export function formatDrainStatus(status) {
  const { draining, flagPresent, disabled, inFlightCount = 0 } = status;
  if (draining) {
    return `draining — ${inFlightCount} ticket${inFlightCount === 1 ? "" : "s"} to land`;
  }
  if (disabled && flagPresent) {
    return "drain flag present but IGNORED (CATALYST_DRAIN_DISABLED=1)";
  }
  if (disabled) {
    return "not draining (drain disabled — CATALYST_DRAIN_DISABLED=1)";
  }
  return "not draining";
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
  // CTL-1678: warn loudly when a just-written flag is being neutralized by the
  // per-node override — the operator's `drain` command "worked" but the node
  // ignores it, which is otherwise silent.
  if (status.disabled && status.flagPresent) {
    process.stderr.write(
      "warning: node has CATALYST_DRAIN_DISABLED=1 — the flag is set but IGNORED (CTL-1678)\n"
    );
  }
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
  } else {
    process.stdout.write(formatDrainStatus(status) + "\n");
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
