// lane-claim-write-ledger.test.mjs — CTL-2070.
// Run: cd plugins/dev/scripts/execution-core && bun test lane-claim-write-ledger.test.mjs
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLedger,
  loadLedger,
  readFleetWrite,
  recordFleetWrite,
} from "./lane-claim-write-ledger.mjs";

let tmpDir;
let ledgerPath;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "lane-claim-ledger-"));
  ledgerPath = join(tmpDir, "lane-claim-write-ledger.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("createLedger — the durable write-ledger, isolated instance", () => {
  test("1. readFleetWrite before any record → null (durable no-entry, NOT undefined)", () => {
    const l = createLedger({ path: ledgerPath }).load();
    const v = l.readFleetWrite("CTL-1");
    expect(v).toBeNull();
    expect(v).not.toBeUndefined();
  });

  test("2. record then read → { toState, atMs }", () => {
    const l = createLedger({ path: ledgerPath }).load();
    l.recordFleetWrite("CTL-1", "Implement", 1000);
    expect(l.readFleetWrite("CTL-1")).toEqual({ toState: "Implement", atMs: 1000 });
  });

  test("3. a later record overwrites (last-write-wins)", () => {
    const l = createLedger({ path: ledgerPath }).load();
    l.recordFleetWrite("CTL-1", "Implement", 1000);
    l.recordFleetWrite("CTL-1", "Research", 2000);
    expect(l.readFleetWrite("CTL-1")).toEqual({ toState: "Research", atMs: 2000 });
  });

  test("4. DURABILITY: a fresh instance reads the entry back from disk (atomic tmp+rename)", () => {
    createLedger({ path: ledgerPath }).load().recordFleetWrite("CTL-1", "Implement", 1000);
    const fresh = createLedger({ path: ledgerPath }).load();
    expect(fresh.readFleetWrite("CTL-1")).toEqual({ toState: "Implement", atMs: 1000 });
  });

  test("5. PRUNE: an entry older than maxAgeMs is dropped on load; a fresh entry survives", () => {
    // Seed a stale entry (atMs 1000) and a fresh one (atMs 9000) directly on disk.
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        "CTL-old": { toState: "Research", atMs: 1000 },
        "CTL-new": { toState: "Implement", atMs: 9000 },
      })
    );
    // now 10_000, maxAge 3_000 → CTL-old (age 9_000) dropped, CTL-new (age 1_000) kept.
    const l = createLedger({ path: ledgerPath, maxAgeMs: 3000 }).load({ nowMs: 10_000 });
    expect(l.readFleetWrite("CTL-old")).toBeNull();
    expect(l.readFleetWrite("CTL-new")).toEqual({ toState: "Implement", atMs: 9000 });
  });

  test("6. FAIL-OPEN: a corrupt/unparseable file → empty ledger, never throws", () => {
    writeFileSync(ledgerPath, "{ this is not json ]");
    let l;
    expect(() => {
      l = createLedger({ path: ledgerPath }).load();
    }).not.toThrow();
    expect(l.readFleetWrite("CTL-1")).toBeNull();
  });

  test("6b. a non-object JSON (array) → empty ledger", () => {
    writeFileSync(ledgerPath, JSON.stringify([1, 2, 3]));
    const l = createLedger({ path: ledgerPath }).load();
    expect(l.size).toBe(0);
  });

  test("7. THREE-VALUED CONTRACT: the module never returns undefined for a loaded ledger", () => {
    const l = createLedger({ path: ledgerPath }).load();
    l.recordFleetWrite("CTL-1", "Implement", 1000);
    expect(l.readFleetWrite("CTL-1")).not.toBeUndefined(); // an entry
    expect(l.readFleetWrite("CTL-404")).toBeNull(); // a miss → null, never undefined
    expect(l.readFleetWrite("")).toBeNull(); // empty id → null
  });

  test("8. atomic write leaves NO stray .tmp on success", () => {
    const l = createLedger({ path: ledgerPath }).load();
    l.recordFleetWrite("CTL-1", "Implement", 1000);
    expect(existsSync(`${ledgerPath}.tmp.${process.pid}`)).toBe(false);
    expect(l._tmpExists()).toBe(false);
  });

  test("8b. a rename failure leaves the prior durable file intact (swallowed, never thrown)", () => {
    // First a good write via real fs.
    createLedger({ path: ledgerPath }).load().recordFleetWrite("CTL-1", "Implement", 1000);
    const before = readFileSync(ledgerPath, "utf8");
    // Now an instance whose rename throws — the record must be swallowed, disk unchanged.
    const brokenFs = {
      renameSync: () => {
        throw new Error("simulated rename failure");
      },
    };
    const l = createLedger({ path: ledgerPath, fs: brokenFs }).load();
    expect(() => l.recordFleetWrite("CTL-2", "Research", 2000)).not.toThrow();
    expect(readFileSync(ledgerPath, "utf8")).toBe(before); // prior file intact
  });

  test("a malformed record (no ticket / non-numeric atMs) is ignored, never persisted", () => {
    const l = createLedger({ path: ledgerPath }).load();
    l.recordFleetWrite("", "Implement", 1000);
    l.recordFleetWrite("CTL-1", "Implement", "not-a-number");
    expect(l.size).toBe(0);
  });
});

describe("the process singleton — production wiring shape", () => {
  test("loadLedger binds the singleton to a path; record + read round-trip through it", () => {
    loadLedger(ledgerPath);
    expect(readFleetWrite("CTL-1")).toBeNull();
    recordFleetWrite("CTL-1", "Implement", 1000);
    expect(readFleetWrite("CTL-1")).toEqual({ toState: "Implement", atMs: 1000 });
    // durability through the singleton path
    const fresh = createLedger({ path: ledgerPath }).load();
    expect(fresh.readFleetWrite("CTL-1")).toEqual({ toState: "Implement", atMs: 1000 });
  });

  test("loadLedger RESETS the singleton to a fresh path (test isolation contract)", () => {
    loadLedger(ledgerPath);
    recordFleetWrite("CTL-1", "Implement", 1000);
    const other = join(tmpDir, "other.json");
    loadLedger(other);
    expect(readFleetWrite("CTL-1")).toBeNull(); // the fresh ledger has no entry
  });
});
