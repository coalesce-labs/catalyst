import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { writeMergedSignalFile } from "../lib/signal-writer";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "signal-writer-test-"));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function writeSignal(content: Record<string, unknown>): string {
  const path = join(tmpDir, "CTL-1.json");
  writeFileSync(path, JSON.stringify(content, null, 2));
  return path;
}

function readSignal(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("writeMergedSignalFile", () => {
  it("writes status=done, phase=6, pr.ciStatus=merged, pr.mergedAt on first observation", () => {
    const path = writeSignal({
      ticket: "CTL-1",
      orchestrator: "orch-test",
      workerName: "orch-test-CTL-1",
      status: "pr-created",
      phase: 5,
      startedAt: "2026-04-16T10:00:00Z",
      updatedAt: "2026-04-16T10:05:00Z",
      pr: {
        number: 99,
        url: "https://github.com/owner/repo/pull/99",
        ciStatus: "pending",
        prOpenedAt: "2026-04-16T10:05:00Z",
      },
    });

    const changed = writeMergedSignalFile(path, "2026-04-16T10:30:00Z");
    expect(changed).toBe(true);

    const after = readSignal(path);
    expect(after.status).toBe("done");
    expect(after.phase).toBe(6);
    const pr = after.pr as Record<string, unknown>;
    expect(pr.ciStatus).toBe("merged");
    expect(pr.mergedAt).toBe("2026-04-16T10:30:00Z");
    // Preserves existing PR fields
    expect(pr.number).toBe(99);
    expect(pr.url).toBe("https://github.com/owner/repo/pull/99");
    expect(pr.prOpenedAt).toBe("2026-04-16T10:05:00Z");
    // Sets completedAt to mergedAt when not already present
    expect(after.completedAt).toBe("2026-04-16T10:30:00Z");
    // Records phase timestamp
    const phaseTimestamps = after.phaseTimestamps as Record<string, string>;
    expect(typeof phaseTimestamps.done).toBe("string");
  });

  it("preserves all non-targeted top-level fields", () => {
    const path = writeSignal({
      ticket: "CTL-2",
      orchestrator: "orch-test",
      workerName: "orch-test-CTL-2",
      label: "oneshot CTL-2",
      status: "pr-created",
      phase: 5,
      startedAt: "2026-04-16T10:00:00Z",
      updatedAt: "2026-04-16T10:05:00Z",
      worktreePath: "/tmp/wt/CTL-2",
      pid: 12345,
      definitionOfDone: { typeCheck: { passed: true } },
      pr: { number: 1, url: "https://github.com/o/r/pull/1" },
    });

    writeMergedSignalFile(path, "2026-04-16T11:00:00Z");
    const after = readSignal(path);
    expect(after.ticket).toBe("CTL-2");
    expect(after.orchestrator).toBe("orch-test");
    expect(after.workerName).toBe("orch-test-CTL-2");
    expect(after.label).toBe("oneshot CTL-2");
    expect(after.worktreePath).toBe("/tmp/wt/CTL-2");
    expect(after.pid).toBe(12345);
    expect(after.definitionOfDone).toEqual({ typeCheck: { passed: true } });
  });

  it("is idempotent: no write when already done+merged with same mergedAt", () => {
    const path = writeSignal({
      ticket: "CTL-3",
      orchestrator: "orch-test",
      workerName: "orch-test-CTL-3",
      status: "done",
      phase: 6,
      startedAt: "2026-04-16T10:00:00Z",
      updatedAt: "2026-04-16T10:30:00Z",
      pr: {
        number: 3,
        url: "https://github.com/o/r/pull/3",
        ciStatus: "merged",
        mergedAt: "2026-04-16T10:30:00Z",
      },
    });

    const beforeRaw = readFileSync(path, "utf8");
    const changed = writeMergedSignalFile(path, "2026-04-16T10:30:00Z");
    expect(changed).toBe(false);
    const afterRaw = readFileSync(path, "utf8");
    expect(afterRaw).toBe(beforeRaw);
  });

  it("rewrites when mergedAt in file differs from upstream truth", () => {
    const path = writeSignal({
      ticket: "CTL-4",
      orchestrator: "orch-test",
      workerName: "orch-test-CTL-4",
      status: "done",
      phase: 6,
      startedAt: "2026-04-16T10:00:00Z",
      updatedAt: "2026-04-16T10:30:00Z",
      pr: {
        number: 4,
        url: "https://github.com/o/r/pull/4",
        ciStatus: "merged",
        mergedAt: "2026-04-16T10:30:00Z",
      },
    });

    const changed = writeMergedSignalFile(path, "2026-04-16T11:00:00Z");
    expect(changed).toBe(true);
    const after = readSignal(path);
    const pr = after.pr as Record<string, unknown>;
    expect(pr.mergedAt).toBe("2026-04-16T11:00:00Z");
  });

  it("does not overwrite an existing completedAt", () => {
    const path = writeSignal({
      ticket: "CTL-5",
      orchestrator: "orch-test",
      workerName: "orch-test-CTL-5",
      status: "pr-created",
      phase: 5,
      startedAt: "2026-04-16T10:00:00Z",
      updatedAt: "2026-04-16T10:05:00Z",
      completedAt: "2026-04-16T09:00:00Z",
      pr: { number: 5, url: "https://github.com/o/r/pull/5" },
    });

    writeMergedSignalFile(path, null);
    const after = readSignal(path);
    expect(after.completedAt).toBe("2026-04-16T09:00:00Z");
  });

  it("handles missing pr field gracefully", () => {
    const path = writeSignal({
      ticket: "CTL-6",
      orchestrator: "orch-test",
      workerName: "orch-test-CTL-6",
      status: "pr-created",
      phase: 5,
      startedAt: "2026-04-16T10:00:00Z",
      updatedAt: "2026-04-16T10:05:00Z",
      pr: null,
    });

    const changed = writeMergedSignalFile(path, "2026-04-16T11:00:00Z");
    expect(changed).toBe(true);
    const after = readSignal(path);
    expect(after.status).toBe("done");
    const pr = after.pr as Record<string, unknown>;
    expect(pr.ciStatus).toBe("merged");
    expect(pr.mergedAt).toBe("2026-04-16T11:00:00Z");
  });

  it("returns false when signal file does not exist", () => {
    const missing = join(tmpDir, "does-not-exist.json");
    const changed = writeMergedSignalFile(missing, "2026-04-16T11:00:00Z");
    expect(changed).toBe(false);
  });

  it("returns false and leaves file untouched on parse failure", () => {
    const path = join(tmpDir, "corrupt.json");
    writeFileSync(path, "{not valid json");
    const beforeRaw = readFileSync(path, "utf8");
    const changed = writeMergedSignalFile(path, "2026-04-16T11:00:00Z");
    expect(changed).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(beforeRaw);
  });

  it("writes atomically (no leftover .tmp)", () => {
    const path = writeSignal({
      ticket: "CTL-7",
      orchestrator: "orch-test",
      workerName: "orch-test-CTL-7",
      status: "pr-created",
      phase: 5,
      startedAt: "2026-04-16T10:00:00Z",
      updatedAt: "2026-04-16T10:05:00Z",
      pr: { number: 7, url: "https://github.com/o/r/pull/7" },
    });
    writeMergedSignalFile(path, "2026-04-16T12:00:00Z");
    const files = readdirSync(tmpDir);
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
  });
});
