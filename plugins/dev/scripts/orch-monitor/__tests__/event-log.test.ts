import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEventLogWriter } from "../lib/event-log";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "event-log-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function readMonth(catalystDir: string, ts: Date): string {
  const y = ts.getUTCFullYear();
  const m = String(ts.getUTCMonth() + 1).padStart(2, "0");
  const path = join(catalystDir, "events", `${y}-${m}.jsonl`);
  return readFileSync(path, "utf8");
}

describe("createEventLogWriter", () => {
  it("appends a single JSONL line per call", async () => {
    const fixed = new Date("2026-05-03T12:00:00Z");
    const writer = createEventLogWriter({
      catalystDir: workdir,
      now: () => fixed,
    });
    await writer.append({
      id: "evt_abc",
      source: "github.webhook",
      event: "github.pr.merged",
      scope: { repo: "o/r", pr: 322 },
      detail: { merged: true },
    });
    const contents = readMonth(workdir, fixed);
    const lines = contents.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0] ?? "");
    expect(parsed.ts).toBe("2026-05-03T12:00:00.000Z");
    expect(parsed.id).toBe("evt_abc");
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.source).toBe("github.webhook");
    expect(parsed.event).toBe("github.pr.merged");
    expect(parsed.scope).toEqual({ repo: "o/r", pr: 322 });
    expect(parsed.detail).toEqual({ merged: true });
  });

  it("preserves backward-compat orchestrator/worker top-level fields", async () => {
    const fixed = new Date("2026-05-03T00:00:00Z");
    const writer = createEventLogWriter({
      catalystDir: workdir,
      now: () => fixed,
    });
    await writer.append({
      id: "evt_1",
      source: "github.webhook",
      event: "github.pr.synchronize",
      scope: {
        repo: "o/r",
        pr: 1,
        orchestrator: "orch-test",
        worker: "TKT-1",
      },
      detail: {},
    });
    const parsed = JSON.parse(readMonth(workdir, fixed).trim());
    expect(parsed.orchestrator).toBe("orch-test");
    expect(parsed.worker).toBe("TKT-1");
    expect(parsed.scope.orchestrator).toBe("orch-test");
    expect(parsed.scope.worker).toBe("TKT-1");
  });

  it("creates the events/ directory if missing", async () => {
    const fixed = new Date("2026-05-03T00:00:00Z");
    const writer = createEventLogWriter({
      catalystDir: workdir,
      now: () => fixed,
    });
    expect(existsSync(join(workdir, "events"))).toBe(false);
    await writer.append({
      id: "x",
      source: "test",
      event: "test.boot",
      scope: {},
      detail: {},
    });
    expect(existsSync(join(workdir, "events"))).toBe(true);
  });

  it("appends to the same monthly file across multiple writes", async () => {
    const fixed = new Date("2026-05-03T00:00:00Z");
    const writer = createEventLogWriter({
      catalystDir: workdir,
      now: () => fixed,
    });
    for (let i = 0; i < 5; i++) {
      await writer.append({
        id: `evt_${i}`,
        source: "test",
        event: "test.x",
        scope: {},
        detail: { i },
      });
    }
    const lines = readMonth(workdir, fixed)
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines.length).toBe(5);
  });

  it("rolls over to a new file when the month changes", async () => {
    let now = new Date("2026-05-31T23:59:59Z");
    const writer = createEventLogWriter({
      catalystDir: workdir,
      now: () => now,
    });
    await writer.append({
      id: "may",
      source: "test",
      event: "test.x",
      scope: {},
      detail: {},
    });
    now = new Date("2026-06-01T00:00:00Z");
    await writer.append({
      id: "june",
      source: "test",
      event: "test.x",
      scope: {},
      detail: {},
    });
    expect(
      readFileSync(join(workdir, "events", "2026-05.jsonl"), "utf8"),
    ).toContain('"id":"may"');
    expect(
      readFileSync(join(workdir, "events", "2026-06.jsonl"), "utf8"),
    ).toContain('"id":"june"');
  });

  it("write failure is logged but does not throw", async () => {
    const errors: string[] = [];
    // Use an invalid path to force a write failure
    const writer = createEventLogWriter({
      catalystDir: "/proc/cannot/write/here",
      logger: { error: (m) => errors.push(m) },
    });
    let threw = false;
    try {
      await writer.append({
        id: "x",
        source: "test",
        event: "test.x",
        scope: {},
        detail: {},
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });
});
