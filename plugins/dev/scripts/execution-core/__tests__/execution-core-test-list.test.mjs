import { expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const EXEC_CORE = resolve(import.meta.dir, "..");
const WORKFLOW_PATH = resolve(import.meta.dir, "../../../../../.github/workflows/execution-core-tests.yml");
const WORKFLOW_SRC = readFileSync(WORKFLOW_PATH, "utf8");

export function parseStableTestList(src) {
  const stepStart = src.indexOf("- name: Run stable unit tests");
  expect(stepStart).toBeGreaterThanOrEqual(0);
  const nextStep = src.indexOf("\n      - name:", stepStart + 1);
  const step = src.slice(stepStart, nextStep === -1 ? src.length : nextStep);
  return [...step.matchAll(/\b(\S+\.test\.(?:mjs|ts))\b/g)].map((match) => match[1]);
}

it("every stable-list test filter resolves to an existing file", () => {
  const filters = parseStableTestList(WORKFLOW_SRC);
  const missing = filters.filter((filter) => !existsSync(join(EXEC_CORE, filter))).sort();
  expect(missing).toEqual([]);
});

it("lists the CAT-179 host-state guard", () => {
  expect(parseStableTestList(WORKFLOW_SRC)).toContain("doctor-host-state-registry.test.mjs");
});
