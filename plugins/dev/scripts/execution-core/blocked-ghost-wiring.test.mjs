import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(DIR, name), "utf8");

test("only blocked-ghost.mjs constructs the raw wrapper", () => {
  const offenders = readdirSync(DIR)
    .filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"))
    .filter((name) => read(name).includes("makeBlockedGhostAwareIsBgJobAlive("))
    .filter((name) => basename(name) !== "blocked-ghost.mjs");
  expect(offenders).toEqual([]);
});

test("scheduler main does not arm the raw presence probe", () => {
  expect(read("scheduler.mjs")).not.toMatch(/isBgJobAlive:\s*defaultIsBgJobAlive/);
});

test("every entrypoint arms the configured probe", () => {
  for (const name of ["daemon.mjs", "scheduler.mjs", "delegate-runner-entry.mjs"]) {
    expect(read(name)).toContain("createConfiguredBlockedGhostProbe");
  }
});
