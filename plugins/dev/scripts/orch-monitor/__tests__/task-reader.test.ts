import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getTaskDiagnostic } from "../lib/task-reader";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "task-reader-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("getTaskDiagnostic", () => {
  it("returns all nulls/zeroes when neither pid nor sessionId provided", () => {
    const d = getTaskDiagnostic({});
    expect(d.pid).toBeNull();
    expect(d.sessionId).toBeNull();
    expect(d.expectedPath).toBeNull();
    expect(d.pathExists).toBe(false);
    expect(d.fileCount).toBe(0);
  });

  it("reports sessionId + expected path + fileCount when directory has task files", () => {
    const sessionId = "sess-abc";
    const sessionDir = join(tmpRoot, sessionId);
    mkdirSync(sessionDir);
    writeFileSync(
      join(sessionDir, "1.json"),
      JSON.stringify({ id: "1", subject: "foo", status: "pending" }),
    );
    writeFileSync(
      join(sessionDir, "2.json"),
      JSON.stringify({ id: "2", subject: "bar", status: "completed" }),
    );
    writeFileSync(join(sessionDir, ".lock"), "");

    const d = getTaskDiagnostic({ sessionId, tasksRoot: tmpRoot });
    expect(d.sessionId).toBe(sessionId);
    expect(d.expectedPath).toBe(sessionDir);
    expect(d.pathExists).toBe(true);
    expect(d.fileCount).toBe(2);
  });

  it("reports pathExists=false when sessionId directory does not exist", () => {
    const d = getTaskDiagnostic({
      sessionId: "does-not-exist",
      tasksRoot: tmpRoot,
    });
    expect(d.sessionId).toBe("does-not-exist");
    expect(d.expectedPath).toBe(join(tmpRoot, "does-not-exist"));
    expect(d.pathExists).toBe(false);
    expect(d.fileCount).toBe(0);
  });

  it("reports fileCount=0 when directory exists but is empty", () => {
    const sessionId = "empty-sess";
    mkdirSync(join(tmpRoot, sessionId));
    const d = getTaskDiagnostic({ sessionId, tasksRoot: tmpRoot });
    expect(d.pathExists).toBe(true);
    expect(d.fileCount).toBe(0);
  });

  it("ignores non-json files and the .lock file when counting", () => {
    const sessionId = "mixed-sess";
    const dir = join(tmpRoot, sessionId);
    mkdirSync(dir);
    writeFileSync(join(dir, "1.json"), "{}");
    writeFileSync(join(dir, "readme.txt"), "not a task");
    writeFileSync(join(dir, ".lock"), "");
    const d = getTaskDiagnostic({ sessionId, tasksRoot: tmpRoot });
    expect(d.fileCount).toBe(1);
  });

  it("propagates pid in the result when provided", () => {
    const d = getTaskDiagnostic({ pid: 12345, tasksRoot: tmpRoot });
    expect(d.pid).toBe(12345);
    // No session resolvable without a real sessions file
    expect(d.sessionId).toBeNull();
    expect(d.expectedPath).toBeNull();
  });
});
