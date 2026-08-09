// Tests for the CTL-1606 (Codex #2878 P1) one-shot upgrade backfill.
// Run: cd plugins/dev/scripts/orch-monitor && bun test pr-status-backfill

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileBasedPrCache } from "../lib/pr-cache";
import { backfillPrStatuses, normalizePrState } from "../lib/pr-status-backfill";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pr-backfill-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const cache = () => createFileBasedPrCache(join(dir, "t.db"));
const okRunner = (rows: unknown) => async () => ({ ok: true, stdout: JSON.stringify(rows) });

test("normalizePrState maps GitHub states, preferring merged over closed", () => {
  expect(normalizePrState("MERGED", null)).toBe("merged");
  expect(normalizePrState("CLOSED", "2026-08-01T00:00:00Z")).toBe("merged"); // mergedAt wins
  expect(normalizePrState("CLOSED", null)).toBe("closed");
  expect(normalizePrState("OPEN", null)).toBe("open");
  expect(normalizePrState("WEIRD", null)).toBeNull(); // never guess a lifecycle state
});

test("seeds statuses for a repo when the store is empty (the upgrade case)", async () => {
  const c = cache();
  const n = await backfillPrStatuses({
    cache: c,
    repos: ["org/x"],
    runner: okRunner([
      { number: 1, state: "MERGED", mergedAt: "2026-08-01T00:00:00Z" },
      { number: 2, state: "OPEN", mergedAt: null },
      { number: 3, state: "CLOSED", mergedAt: null },
    ]),
  });
  expect(n).toBe(3);
  const rows = c.getAllStatuses();
  expect(rows.find((r) => r.pr_number === 1)?.status).toBe("merged");
  expect(rows.find((r) => r.pr_number === 2)?.status).toBe("open");
  expect(rows.find((r) => r.pr_number === 3)?.status).toBe("closed");
});

test("is ONE-SHOT — a non-empty store is left completely alone", async () => {
  const c = cache();
  c.putStatus("org/x", 1, "open");
  let called = false;
  const n = await backfillPrStatuses({
    cache: c,
    repos: ["org/x"],
    runner: async () => {
      called = true;
      return { ok: true, stdout: "[]" };
    },
  });
  expect(n).toBe(0);
  expect(called).toBe(false); // no gh invocation at all on a normal boot
  expect(c.getAllStatuses().find((r) => r.pr_number === 1)?.status).toBe("open");
});

test("a failing gh invocation is non-fatal and leaves the store unseeded", async () => {
  const c = cache();
  const n = await backfillPrStatuses({
    cache: c,
    repos: ["org/x"],
    runner: async () => ({ ok: false, stdout: "" }),
  });
  expect(n).toBe(0);
  expect(c.getAllStatuses()).toHaveLength(0);
});

test("a throwing runner is non-fatal (missing gh / spawn failure)", async () => {
  const c = cache();
  const n = await backfillPrStatuses({
    cache: c,
    repos: ["org/x"],
    runner: async () => {
      throw new Error("gh: not found");
    },
  });
  expect(n).toBe(0);
});

test("unparseable gh output is non-fatal", async () => {
  const c = cache();
  const n = await backfillPrStatuses({
    cache: c,
    repos: ["org/x"],
    runner: async () => ({ ok: true, stdout: "not json" }),
  });
  expect(n).toBe(0);
});

test("one bad repo does not abort the remaining repos", async () => {
  const c = cache();
  const n = await backfillPrStatuses({
    cache: c,
    repos: ["org/bad", "org/good"],
    runner: async (argv: string[]) =>
      argv.includes("org/bad")
        ? { ok: false, stdout: "" }
        : { ok: true, stdout: JSON.stringify([{ number: 5, state: "MERGED", mergedAt: null }]) },
  });
  expect(n).toBe(1);
  expect(c.getAllStatuses().find((r) => r.pr_number === 5)?.status).toBe("merged");
});

test("skips malformed rows rather than writing a guessed status", async () => {
  const c = cache();
  const n = await backfillPrStatuses({
    cache: c,
    repos: ["org/x"],
    runner: okRunner([
      { number: 0, state: "OPEN" },
      { number: "nope", state: "OPEN" },
      { number: 6, state: "MYSTERY" },
      { number: 7, state: "OPEN" },
    ]),
  });
  expect(n).toBe(1);
  expect(c.getAllStatuses()).toHaveLength(1);
  expect(c.getAllStatuses()[0].pr_number).toBe(7);
});

test("an empty repo list is a clean no-op", async () => {
  expect(await backfillPrStatuses({ cache: cache(), repos: [], runner: okRunner([]) })).toBe(0);
});
