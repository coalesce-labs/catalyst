// autotune-writeback.test.mjs — Phase 2 TDD for Layer-2 write-back (CTL-684).
// Run: cd plugins/dev/scripts/execution-core && bun test autotune-writeback.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeLayer2MaxParallel } from "./autotune.mjs";

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "autotune-writeback-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writeLayer2MaxParallel", () => {
  test("writes maxParallel into the nested path in an existing file", () => {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({
      catalyst: { orchestration: { executionCore: { maxParallel: 5 } } },
    }));
    const ok = writeLayer2MaxParallel(p, 10);
    expect(ok).toBe(true);
    const out = JSON.parse(readFileSync(p, "utf8"));
    expect(out.catalyst.orchestration.executionCore.maxParallel).toBe(10);
  });

  test("preserves sibling keys at every nesting level", () => {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({
      catalyst: {
        orchestration: {
          eligibleQuery: { status: ["Ready"] },
          executionCore: { maxParallel: 3, minParallel: 1 },
        },
      },
      anotherTopKey: "preserved",
    }, null, 2));
    writeLayer2MaxParallel(p, 7);
    const out = JSON.parse(readFileSync(p, "utf8"));
    expect(out.catalyst.orchestration.executionCore.maxParallel).toBe(7);
    expect(out.catalyst.orchestration.executionCore.minParallel).toBe(1);
    expect(out.catalyst.orchestration.eligibleQuery.status).toEqual(["Ready"]);
    expect(out.anotherTopKey).toBe("preserved");
  });

  test("creates the full nested path when file does not exist", () => {
    const p = join(dir, "new-config.json");
    const ok = writeLayer2MaxParallel(p, 12);
    expect(ok).toBe(true);
    const out = JSON.parse(readFileSync(p, "utf8"));
    expect(out.catalyst.orchestration.executionCore.maxParallel).toBe(12);
  });

  test("does not throw and does not clobber on malformed JSON", () => {
    const p = join(dir, "bad.json");
    writeFileSync(p, "{ not valid json }{{{");
    const ok = writeLayer2MaxParallel(p, 5);
    expect(ok).toBe(false);
    // file should be unchanged (still malformed)
    const content = readFileSync(p, "utf8");
    expect(content).toBe("{ not valid json }{{{");
  });

  test("write is atomic — no .tmp residue on success", () => {
    const p = join(dir, "config.json");
    const ok = writeLayer2MaxParallel(p, 8);
    expect(ok).toBe(true);
    // No .tmp file should remain
    const files = require("node:fs").readdirSync(dir);
    const hasTmp = files.some((f) => f.includes(".tmp."));
    expect(hasTmp).toBe(false);
  });

  test("uses injected readFileSync / writeFileSync / renameSync seams", () => {
    const reads = [];
    const writes = [];
    const renames = [];
    const p = join(dir, "config.json");
    writeLayer2MaxParallel(p, 6, {
      readFileSync: (path, enc) => { reads.push(path); throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
      writeFileSync: (path, data) => { writes.push(path); writeFileSync(path, data); },
      renameSync: (src, dst) => { renames.push([src, dst]); require("node:fs").renameSync(src, dst); },
    });
    expect(reads).toHaveLength(1);
    expect(writes).toHaveLength(1);
    expect(renames).toHaveLength(1);
  });
});
