import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultClearStall } from "./scheduler.mjs";

let orchDir;
let workerDir;

beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "cat24-clear-stall-"));
  workerDir = join(orchDir, "workers", "CAT-24");
  mkdirSync(workerDir, { recursive: true });
});

afterEach(() => rmSync(orchDir, { recursive: true, force: true }));

function signal(phase, status = "needs-human") {
  writeFileSync(join(workerDir, `phase-${phase}.json`), JSON.stringify({ status }));
}

const clear = (options) =>
  defaultClearStall(
    orchDir,
    { removeLabel: () => ({ removed: true }) },
    options
  )({
    ticket: "CAT-24",
    phase: "recovery-pass",
  });

test("clearing the LAST phase signal removes the whole worker dir", () => {
  signal("recovery-pass");
  expect(clear()).toBe(true);
  expect(existsSync(workerDir)).toBe(false);
});

test("clearing one of several signals leaves the dir and survivors intact", () => {
  signal("recovery-pass");
  signal("implement", "done");
  expect(clear()).toBe(true);
  expect(existsSync(workerDir)).toBe(true);
  expect(existsSync(join(workerDir, "phase-implement.json"))).toBe(true);
  expect(existsSync(join(workerDir, "phase-recovery-pass.json"))).toBe(false);
});

test("an operator inbox survives clearing the last phase signal", () => {
  signal("recovery-pass");
  writeFileSync(join(workerDir, "inbox.jsonl"), "{}\n");
  writeFileSync(join(workerDir, ".janitor-cleared-recovery-pass.applied"), "");
  expect(clear()).toBe(true);
  expect(existsSync(workerDir)).toBe(true);
  expect(existsSync(join(workerDir, "inbox.jsonl"))).toBe(true);
  expect(existsSync(join(workerDir, ".janitor-cleared-recovery-pass.applied"))).toBe(true);
});

test("a CTL-702 yield tombstone does not count as a surviving signal", () => {
  signal("recovery-pass");
  signal("implement-yield-1", "done");
  expect(clear()).toBe(true);
  expect(existsSync(workerDir)).toBe(false);
});

test("the seam returns true and never throws when dir removal fails", () => {
  signal("recovery-pass");
  expect(
    clear({
      rmDir: () => {
        throw new Error("denied");
      },
    })
  ).toBe(true);
  expect(existsSync(workerDir)).toBe(true);
});
