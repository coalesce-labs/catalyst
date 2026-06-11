import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendToDlq, drainDlq } from "./dlq.ts";

describe("dlq", () => {
  test("appends and drains batches", () => {
    const dir = mkdtempSync(join(tmpdir(), "dlq-"));
    const path = join(dir, "dlq.jsonl");
    appendToDlq(path, [{ ts: "a" }, { ts: "b" }] as any);
    appendToDlq(path, [{ ts: "c" }] as any);
    const batches = drainDlq(path);
    expect(batches.length).toBe(2);
    expect((batches[0][0] as { ts: string }).ts).toBe("a");
    expect((batches[1][0] as { ts: string }).ts).toBe("c");
    rmSync(dir, { recursive: true });
  });

  test("drainDlq returns empty and does not crash when file absent", () => {
    expect(drainDlq("/nonexistent/dlq.jsonl")).toEqual([]);
  });
});
