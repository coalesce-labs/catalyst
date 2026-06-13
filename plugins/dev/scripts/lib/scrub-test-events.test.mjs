// scrub-test-events.test.mjs — CTL-1086 one-time remediation scrubber tests.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubFile } from "./scrub-test-events.mjs";

const REAL_LINE = JSON.stringify({ resource: { "catalyst.orchestration": "orch-CTL-1086" }, name: "phase.real" });
const SENTINEL_LINE = JSON.stringify({ resource: { "catalyst.orchestration": "orch-test" }, name: "phase.sentinel" });
const MALFORMED_LINE = "this is not json {";

let tmpDir;
let logFile;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "scrub-test-"));
  logFile = join(tmpDir, "2026-06.jsonl");
});

afterEach(() => {
  const { rmSync } = require("node:fs");
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe("CTL-1086 scrub-test-events", () => {
  test("dry-run: reports sentinel count, writes nothing", async () => {
    const content = [REAL_LINE, SENTINEL_LINE, REAL_LINE, SENTINEL_LINE].join("\n") + "\n";
    writeFileSync(logFile, content);
    const result = await scrubFile(logFile, { apply: false });
    expect(result.sentinelCount).toBe(2);
    expect(result.realCount).toBe(2);
    expect(result.applied).toBe(false);
    // file unchanged
    expect(readFileSync(logFile, "utf8")).toBe(content);
  });

  test("apply: removes sentinel lines, keeps real lines in order", async () => {
    const lines = [REAL_LINE, SENTINEL_LINE, REAL_LINE, SENTINEL_LINE, MALFORMED_LINE];
    writeFileSync(logFile, lines.join("\n") + "\n");
    const result = await scrubFile(logFile, { apply: true });
    expect(result.sentinelCount).toBe(2);
    expect(result.applied).toBe(true);
    const after = readFileSync(logFile, "utf8");
    const afterLines = after.split("\n").filter(Boolean);
    expect(afterLines).toHaveLength(3);
    expect(afterLines[0]).toBe(REAL_LINE);
    expect(afterLines[1]).toBe(REAL_LINE);
    expect(afterLines[2]).toBe(MALFORMED_LINE);
  });

  test("apply: creates a .pre-scrub-<ts> backup", async () => {
    const content = [REAL_LINE, SENTINEL_LINE].join("\n") + "\n";
    writeFileSync(logFile, content);
    await scrubFile(logFile, { apply: true });
    const dir = tmpDir;
    const files = readdirSync(dir);
    const backup = files.find((f) => f.includes(".pre-scrub-"));
    expect(backup).toBeDefined();
    expect(readFileSync(join(dir, backup), "utf8")).toBe(content);
  });

  test("idempotent: second apply removes 0 lines", async () => {
    writeFileSync(logFile, [REAL_LINE, SENTINEL_LINE].join("\n") + "\n");
    await scrubFile(logFile, { apply: true });
    const result2 = await scrubFile(logFile, { apply: true });
    expect(result2.sentinelCount).toBe(0);
  });

  test("malformed/non-JSON lines are preserved", async () => {
    const content = [REAL_LINE, MALFORMED_LINE, SENTINEL_LINE].join("\n") + "\n";
    writeFileSync(logFile, content);
    await scrubFile(logFile, { apply: true });
    const after = readFileSync(logFile, "utf8");
    expect(after).toContain(MALFORMED_LINE);
  });
});
