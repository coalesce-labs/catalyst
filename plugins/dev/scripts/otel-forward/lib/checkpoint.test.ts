import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCheckpoint, writeCheckpoint } from "./checkpoint.ts";

describe("checkpoint", () => {
  test("readCheckpoint returns null when file absent", () => {
    expect(readCheckpoint("/nonexistent/ck.json")).toBeNull();
  });

  test("round-trips path and offset", () => {
    const dir = mkdtempSync(join(tmpdir(), "ck-"));
    const path = join(dir, "ck.json");
    writeCheckpoint(path, { path: "/events/2026-05.jsonl", offset: 42 });
    const ck = readCheckpoint(path);
    expect(ck?.offset).toBe(42);
    expect(ck?.path).toBe("/events/2026-05.jsonl");
    rmSync(dir, { recursive: true });
  });
});
