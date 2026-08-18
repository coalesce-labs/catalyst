// clear-stall-nothing-to-clear.test.mjs — CTL-1936.
//
// `defaultClearStall` used to issue a needs-human REMOVAL unconditionally, so a ticket
// with no stalled signal and no needs-human sent one to Linear on every tick, forever.
// That is the measured runaway: CTL-1805 — Done in Linear, carrying only `orchestrator`,
// holding a worker directory untouched since Aug 15 — spent 302 of one host's 307 daily
// cloud writes in ~13 minutes, and every unrelated ticket on that host lost its writes.
//
// The gate is a CONJUNCTION, and the two controls below are why: a previous clear can
// delete the signal and then FAIL to remove the label, and that ticket must still retry
// or the label is stranded forever.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultClearStall } from "./scheduler.mjs";

let orchDir;
let workerDir;
let removals;

beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "ctl1936-clear-"));
  workerDir = join(orchDir, "workers", "CTL-1805");
  mkdirSync(workerDir, { recursive: true });
  removals = [];
});

afterEach(() => rmSync(orchDir, { recursive: true, force: true }));

const writeStatus = {
  removeLabel: (...args) => {
    removals.push(args);
    return { removed: true };
  },
};

const clear = () =>
  defaultClearStall(orchDir, writeStatus)({ ticket: "CTL-1805", phase: "recovery-pass" });

describe("nothing to clear is not a clear", () => {
  test("⛔ no stalled signal and no label marker → no Linear write at all", () => {
    // The exact CTL-1805 state: a worker dir whose phase signals are gone, on a ticket
    // that carries no needs-human. Before the gate this issued a removal every tick.
    writeFileSync(join(workerDir, ".some-unrelated-marker"), "");
    expect(clear()).toBe(false);
    expect(removals.length).toBe(0);
  });

  test("⛔ CONTROL: a stalled signal present → the clear proceeds and DOES write", () => {
    // Proves the gate is not simply refusing everything — the same instrument,
    // the same call, one differing precondition.
    writeFileSync(
      join(workerDir, "phase-recovery-pass.json"),
      JSON.stringify({ status: "stalled" })
    );
    expect(clear()).toBe(true);
    expect(removals.length).toBe(1);
  });

  test("⛔ CONTROL: signal gone but a label WAS applied → still retries the removal", () => {
    // A previous clear deleted the signal and then failed to remove the label. Gating on
    // the signal alone would strand that label on the ticket permanently.
    writeFileSync(join(workerDir, ".linear-label-needs-human.applied"), "");
    expect(clear()).toBe(true);
    expect(removals.length).toBe(1);
  });

  test("⛔ CONTROL: a `.skipped` marker also counts as a reason to proceed", () => {
    writeFileSync(join(workerDir, ".linear-label-needs-human.skipped"), "");
    expect(clear()).toBe(true);
    expect(removals.length).toBe(1);
  });

  test("an absent worker dir is nothing to clear, and does not throw", () => {
    rmSync(workerDir, { recursive: true, force: true });
    expect(clear()).toBe(false);
    expect(removals.length).toBe(0);
  });
});
