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

const clear = (options, writeStatus = { removeLabel: () => ({ removed: true }) }) =>
  defaultClearStall(
    orchDir,
    writeStatus,
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

// ─── CAT-24 (Codex P1): the removal waits for label settlement ───

test("an ASYNC label removal still leaves no marker-only residue", async () => {
  signal("recovery-pass");
  let resolveRemoval;
  const pending = new Promise((r) => {
    resolveRemoval = r;
  });
  expect(clear(undefined, { removeLabel: () => pending })).toBe(true);
  // Production's removeLabel is async: the dir must still be here while the
  // removal is in flight, because onRemoved is about to re-create it to write
  // .janitor-cleared-<phase>.applied.
  expect(existsSync(workerDir)).toBe(true);
  resolveRemoval({ removed: true });
  await pending;
  await new Promise((r) => setTimeout(r, 0)); // let the .then chain settle
  expect(existsSync(join(workerDir, ".janitor-cleared-recovery-pass.applied"))).toBe(false);
  expect(existsSync(workerDir)).toBe(false);
});

test("a FAILED label removal keeps the dir (Linear still carries the label)", () => {
  signal("recovery-pass");
  writeFileSync(join(workerDir, ".linear-label-needs-human.applied"), "");
  expect(clear(undefined, { removeLabel: () => ({ removed: false, reason: "api-500" }) })).toBe(
    true
  );
  // Deleting here would drop the once-marker and re-arm an escalation that was
  // never actually cleared. worker-dir-gc reclaims it later if it stays dead.
  expect(existsSync(workerDir)).toBe(true);
  expect(existsSync(join(workerDir, ".linear-label-needs-human.applied"))).toBe(true);
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
