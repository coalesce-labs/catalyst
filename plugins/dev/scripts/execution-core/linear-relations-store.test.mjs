// Unit tests for the on-disk relations cache store (CAT-168).
// Run: cd plugins/dev/scripts/execution-core && bun test linear-relations-store.test.mjs
//
// This is the L2 persistence layer behind linear-cache.mjs's in-memory
// relationsEntries Map — a SEPARATE SQLite file from catalyst-replica.db (no
// coupling to the CAT-152 replica writer; see CAT-168's technical notes).

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createRelationsStore, closeRelationsStoreDb } from "./linear-relations-store.mjs";

let tmpDir;
let dbPath;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "linear-relations-store-test-"));
  dbPath = join(tmpDir, "relations-cache.db");
});

afterEach(() => {
  closeRelationsStoreDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const desc = (state, extra = {}) => ({
  state,
  relations: { nodes: [] },
  inverseRelations: { nodes: [] },
  priority: 2,
  labels: [],
  ...extra,
});

describe("createRelationsStore", () => {
  it("returns undefined on a cold miss", () => {
    const store = createRelationsStore(dbPath);
    expect(store.get("CTL-1")).toBeUndefined();
  });

  it("set then get round-trips the descriptor and expiresAt", () => {
    const store = createRelationsStore(dbPath);
    store.set("CTL-1", desc("Triage", { priority: 3 }), 60_000);
    const got = store.get("CTL-1");
    expect(got.desc.state).toBe("Triage");
    expect(got.desc.priority).toBe(3);
    expect(got.desc.relations).toEqual({ nodes: [] });
    expect(got.expiresAt).toBe(60_000);
  });

  it("set overwrites an existing entry for the same identifier", () => {
    const store = createRelationsStore(dbPath);
    store.set("CTL-1", desc("Triage"), 1000);
    store.set("CTL-1", desc("Done"), 2000);
    const got = store.get("CTL-1");
    expect(got.desc.state).toBe("Done");
    expect(got.expiresAt).toBe(2000);
  });

  it("invalidate drops the entry", () => {
    const store = createRelationsStore(dbPath);
    store.set("CTL-1", desc("Triage"), 60_000);
    store.invalidate("CTL-1");
    expect(store.get("CTL-1")).toBeUndefined();
  });

  it("survives a reopen against the same db file (simulated daemon restart)", () => {
    const store1 = createRelationsStore(dbPath);
    store1.set("CTL-1", desc("Triage", { priority: 4 }), 60_000);
    closeRelationsStoreDb();

    const store2 = createRelationsStore(dbPath);
    const got = store2.get("CTL-1");
    expect(got.desc.state).toBe("Triage");
    expect(got.desc.priority).toBe(4);
    expect(got.expiresAt).toBe(60_000);
  });

  it("get fails open (returns undefined) on a corrupt row instead of throwing", () => {
    const store = createRelationsStore(dbPath);
    store.set("CTL-1", desc("Triage"), 60_000); // ensure the table exists first
    closeRelationsStoreDb();

    // Write an unparseable JSON payload directly via a raw connection,
    // simulating on-disk corruption — the facade must never throw into the
    // scheduler tick, it must degrade to a miss.
    const raw = new Database(dbPath);
    raw.run(`UPDATE relations_cache SET desc_json = '{not-json' WHERE identifier = 'CTL-1'`);
    raw.close();

    const store2 = createRelationsStore(dbPath);
    expect(() => store2.get("CTL-1")).not.toThrow();
    expect(store2.get("CTL-1")).toBeUndefined();
  });

  it("does not throw when the db directory cannot be created (fail-open)", () => {
    // A path under a file (not a directory) can never be mkdir'd into.
    const blockerFile = join(tmpDir, "not-a-dir");
    writeFileSync(blockerFile, "x");
    const badPath = join(blockerFile, "relations-cache.db");
    expect(() => createRelationsStore(badPath)).not.toThrow();
  });
});
