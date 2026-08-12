import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDoneUnmergedEvidence } from "./done-unmerged-evidence.mjs";

test("implement done without a PR produces host-local evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "cat45-"));
  const dir = join(root, "workers", "CAT-1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "phase-implement.json"), JSON.stringify({ status: "done" }));
  const rows = buildDoneUnmergedEvidence(root);
  expect(rows.get("CAT-1")?.hasUnmergedWork).toBe(true);
  expect(rows.get("CAT-1")?.reachedPr).toBe(false);
});

test("missing worker directory is silent", () => {
  expect(buildDoneUnmergedEvidence("/definitely/missing").size).toBe(0);
});
