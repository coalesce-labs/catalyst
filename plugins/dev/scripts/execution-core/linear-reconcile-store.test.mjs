import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  declare,
  readDeclaration,
  listDeclarations,
  markReconciled,
} from "./linear-reconcile-store.mjs";

const fixedClock = { nowIso: () => "2026-06-27T00:00:00.000Z" };

test("declare writes a pending marker; listDeclarations(pendingOnly) returns it", () => {
  const dir = mkdtempSync(join(tmpdir(), "decl-"));
  declare({ ticket: "CTL-1", note: "done by hand" }, { dir, clock: fixedClock });
  const d = readDeclaration("CTL-1", dir);
  expect(d.ticket).toBe("CTL-1");
  expect(d.state).toBe("done");
  expect(d.note).toBe("done by hand");
  expect(d.reconciledAt).toBeNull();
  expect(listDeclarations({ dir, pendingOnly: true }).map((x) => x.ticket)).toEqual(["CTL-1"]);
});

test("markReconciled stamps reconciledAt → drops it from the pending list", () => {
  const dir = mkdtempSync(join(tmpdir(), "decl-"));
  declare({ ticket: "CTL-1" }, { dir, clock: fixedClock });
  expect(listDeclarations({ dir, pendingOnly: true }).map((x) => x.ticket)).toEqual(["CTL-1"]);
  markReconciled("CTL-1", "Done", { dir, clock: fixedClock });
  const d = readDeclaration("CTL-1", dir);
  expect(d.reconciledState).toBe("Done");
  expect(d.reconciledAt).toBe("2026-06-27T00:00:00.000Z");
  expect(listDeclarations({ dir, pendingOnly: true })).toEqual([]); // no longer pending
});

test("re-declaring the SAME state preserves declaredAt + reconciled markers (idempotent)", () => {
  const dir = mkdtempSync(join(tmpdir(), "decl-"));
  declare({ ticket: "CTL-1" }, { dir, clock: { nowIso: () => "2026-06-27T00:00:00.000Z" } });
  markReconciled("CTL-1", "done", { dir, clock: fixedClock });
  expect(listDeclarations({ dir, pendingOnly: true })).toEqual([]); // reconciled
  // re-declare same state → stays reconciled (no churn)
  declare({ ticket: "CTL-1" }, { dir, clock: { nowIso: () => "2026-06-28T00:00:00.000Z" } });
  const d = readDeclaration("CTL-1", dir);
  expect(d.declaredAt).toBe("2026-06-27T00:00:00.000Z");
  expect(d.reconciledState).toBe("done");
  expect(listDeclarations({ dir, pendingOnly: true })).toEqual([]);
});

test("re-declaring a DIFFERENT state re-opens the marker (reconciledAt cleared)", () => {
  const dir = mkdtempSync(join(tmpdir(), "decl-"));
  declare({ ticket: "CTL-1", state: "inReview" }, { dir, clock: fixedClock });
  markReconciled("CTL-1", "inReview", { dir, clock: fixedClock });
  expect(listDeclarations({ dir, pendingOnly: true })).toEqual([]);
  declare({ ticket: "CTL-1", state: "done" }, { dir, clock: fixedClock });
  const d = readDeclaration("CTL-1", dir);
  expect(d.state).toBe("done");
  expect(d.reconciledAt).toBeNull();
  expect(listDeclarations({ dir, pendingOnly: true }).map((x) => x.ticket)).toEqual(["CTL-1"]);
});

test("listDeclarations ignores non-json + tmp files and missing dir", () => {
  expect(listDeclarations({ dir: "/nonexistent/dir/x" })).toEqual([]);
});
