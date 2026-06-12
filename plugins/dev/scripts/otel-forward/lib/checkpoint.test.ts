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

  test("round-trips lastForwardedTs when present", () => {
    const dir = mkdtempSync(join(tmpdir(), "ck-lag-"));
    const path = join(dir, "ck.json");
    const ts = "2026-06-12T10:00:00Z";
    writeCheckpoint(path, { path: "/events/2026-06.jsonl", offset: 100, lastForwardedTs: ts });
    const ck = readCheckpoint(path);
    expect(ck?.lastForwardedTs).toBe(ts);
    rmSync(dir, { recursive: true });
  });

  test("readCheckpoint returns undefined for lastForwardedTs on legacy files lacking it", () => {
    const dir = mkdtempSync(join(tmpdir(), "ck-legacy-"));
    const path = join(dir, "ck.json");
    // Write a legacy checkpoint without lastForwardedTs
    writeCheckpoint(path, { path: "/events/2026-06.jsonl", offset: 0 });
    const ck = readCheckpoint(path);
    expect(ck?.lastForwardedTs).toBeUndefined();
    rmSync(dir, { recursive: true });
  });
});
