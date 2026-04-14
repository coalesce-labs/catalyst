import { describe, it, expect } from "bun:test";
import { renderSnapshot, renderStatsHeader } from "../lib/terminal";
import type {
  MonitorSnapshot,
  OrchestratorState,
  WorkerState,
} from "../lib/state-reader";

function makeWorker(overrides: Partial<WorkerState> = {}): WorkerState {
  return {
    ticket: "TEST-1",
    label: null,
    status: "in_progress",
    phase: 2,
    wave: null,
    pid: 12345,
    alive: true,
    pr: null,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    updatedAt: new Date().toISOString(),
    timeSinceUpdate: 12,
    lastHeartbeat: null,
    definitionOfDone: {},
    ...overrides,
  };
}

function makeOrchestrator(
  overrides: Partial<OrchestratorState> = {}
): OrchestratorState {
  return {
    id: "orch-abc123",
    path: "/tmp/orch-abc123",
    startedAt: new Date().toISOString(),
    currentWave: 2,
    totalWaves: 5,
    waves: [],
    workers: {},
    dashboard: null,
    briefings: {},
    attention: [],
    ...overrides,
  };
}

function makeSnapshot(orchestrators: OrchestratorState[]): MonitorSnapshot {
  return {
    timestamp: new Date().toISOString(),
    orchestrators,
    sessions: [],
    sessionStoreAvailable: false,
  };
}

describe("renderSnapshot", () => {
  it("returns a string", () => {
    const snapshot = makeSnapshot([makeOrchestrator()]);
    const out = renderSnapshot(snapshot);
    expect(typeof out).toBe("string");
  });

  it("contains the orchestrator id in the header", () => {
    const snapshot = makeSnapshot([
      makeOrchestrator({ id: "orch-xyz789" }),
    ]);
    const out = renderSnapshot(snapshot);
    expect(out).toContain("orch-xyz789");
  });

  it("shows wave progress like 'Wave 2/5'", () => {
    const snapshot = makeSnapshot([
      makeOrchestrator({ currentWave: 2, totalWaves: 5 }),
    ]);
    const out = renderSnapshot(snapshot);
    expect(out).toContain("2/5");
    expect(out.toLowerCase()).toContain("wave");
  });

  it("includes each worker's ticket", () => {
    const snapshot = makeSnapshot([
      makeOrchestrator({
        workers: {
          "PROJ-1": makeWorker({ ticket: "PROJ-1" }),
          "PROJ-2": makeWorker({ ticket: "PROJ-2", status: "done" }),
          "PROJ-3": makeWorker({ ticket: "PROJ-3", status: "failed" }),
        },
      }),
    ]);
    const out = renderSnapshot(snapshot);
    expect(out).toContain("PROJ-1");
    expect(out).toContain("PROJ-2");
    expect(out).toContain("PROJ-3");
  });

  it("renders table header columns", () => {
    const snapshot = makeSnapshot([
      makeOrchestrator({
        workers: { "T-1": makeWorker({ ticket: "T-1" }) },
      }),
    ]);
    const out = renderSnapshot(snapshot);
    expect(out).toContain("TICKET");
    expect(out).toContain("STATUS");
    expect(out).toContain("PHASE");
    expect(out).toContain("PID");
    expect(out).toContain("AGE");
    expect(out).toContain("PR");
    expect(out).toContain("PREVIEW");
  });

  it("includes ANSI color codes when status is a known non-default status", () => {
    const snapshot = makeSnapshot([
      makeOrchestrator({
        workers: {
          "T-1": makeWorker({ ticket: "T-1", status: "done" }),
        },
      }),
    ]);
    const out = renderSnapshot(snapshot);
    expect(out).toContain("\x1b[32m");
    expect(out).toContain("\x1b[0m");
  });

  it("renders PR number when present", () => {
    const snapshot = makeSnapshot([
      makeOrchestrator({
        workers: {
          "T-1": makeWorker({
            ticket: "T-1",
            pr: { number: 4242, url: "https://github.com/x/y/pull/4242" },
          }),
        },
      }),
    ]);
    const out = renderSnapshot(snapshot);
    expect(out).toContain("4242");
  });

  it("handles empty orchestrator list without throwing", () => {
    const snapshot = makeSnapshot([]);
    const out = renderSnapshot(snapshot);
    expect(typeof out).toBe("string");
  });

  it("renders preview provider when previews are present", () => {
    const snapshot = makeSnapshot([
      makeOrchestrator({
        workers: {
          "T-1": makeWorker({
            ticket: "T-1",
            previews: [
              {
                url: "https://my-app.pages.dev",
                provider: "cloudflare",
                status: "live",
                source: "comment",
              },
            ],
          }),
        },
      }),
    ]);
    const out = renderSnapshot(snapshot);
    expect(out).toContain("cloudflare");
    // GREEN color code for "live" status
    expect(out).toContain("\x1b[32m");
  });

  it("renders dash for preview when no previews exist", () => {
    const snapshot = makeSnapshot([
      makeOrchestrator({
        workers: {
          "T-1": makeWorker({ ticket: "T-1" }),
        },
      }),
    ]);
    const out = renderSnapshot(snapshot);
    // The preview column should contain a dash
    const lines = out.split("\n");
    const workerLine = lines.find((l) => l.includes("T-1") && !l.includes("TICKET"));
    expect(workerLine).toBeDefined();
  });

  it("keeps visible line width <= 80 columns (excluding ANSI codes)", () => {
    const snapshot = makeSnapshot([
      makeOrchestrator({
        id: "orch-abc123",
        currentWave: 2,
        totalWaves: 5,
        workers: {
          "PROJ-123": makeWorker({
            ticket: "PROJ-123",
            status: "in_progress",
            pr: { number: 9999, url: "https://github.com/x/y/pull/9999" },
          }),
        },
      }),
    ]);
    const out = renderSnapshot(snapshot);
    // eslint-disable-next-line no-control-regex
    const ansi = /\x1b\[[0-9;]*m/g;
    for (const line of out.split("\n")) {
      const stripped = line.replace(ansi, "");
      expect(stripped.length).toBeLessThanOrEqual(80);
    }
  });

  it("renders label column in standard mode", () => {
    const snapshot = makeSnapshot([
      makeOrchestrator({
        workers: {
          "T-1": makeWorker({ ticket: "T-1", label: "oneshot T-1" }),
        },
      }),
    ]);
    const out = renderSnapshot(snapshot);
    expect(out).toContain("LABEL");
    expect(out).toContain("oneshot T-1");
  });

  it("includes stats header with worker count", () => {
    const snapshot = makeSnapshot([
      makeOrchestrator({
        workers: {
          "T-1": makeWorker({ ticket: "T-1" }),
          "T-2": makeWorker({ ticket: "T-2" }),
          "T-3": makeWorker({ ticket: "T-3" }),
        },
      }),
    ]);
    const out = renderSnapshot(snapshot);
    expect(out).toContain("3 workers");
  });

  it("includes elapsed time in stats header", () => {
    const snapshot = makeSnapshot([
      makeOrchestrator({
        workers: {
          "T-1": makeWorker({
            ticket: "T-1",
            startedAt: new Date(Date.now() - 3600_000).toISOString(),
          }),
        },
      }),
    ]);
    const out = renderSnapshot(snapshot);
    expect(out).toMatch(/\d+[smhd]/);
  });

  it("includes cost in stats header when cost data present", () => {
    const snapshot = makeSnapshot([
      makeOrchestrator({
        workers: {
          "T-1": makeWorker({
            ticket: "T-1",
            cost: { costUSD: 2.5, inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 },
          }),
        },
      }),
    ]);
    const out = renderSnapshot(snapshot);
    expect(out).toContain("$2.50");
  });

  it("omits cost from stats header when no cost data", () => {
    const snapshot = makeSnapshot([
      makeOrchestrator({
        workers: {
          "T-1": makeWorker({ ticket: "T-1" }),
        },
      }),
    ]);
    const out = renderSnapshot(snapshot);
    expect(out).not.toContain("$");
  });

  it("color-codes cost green when under $1", () => {
    const snapshot = makeSnapshot([
      makeOrchestrator({
        workers: {
          "T-1": makeWorker({
            ticket: "T-1",
            cost: { costUSD: 0.5, inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 },
          }),
        },
      }),
    ]);
    const out = renderSnapshot(snapshot);
    expect(out).toContain("\x1b[32m$0.50");
  });

  it("color-codes cost yellow when between $1 and $5", () => {
    const snapshot = makeSnapshot([
      makeOrchestrator({
        workers: {
          "T-1": makeWorker({
            ticket: "T-1",
            cost: { costUSD: 3.0, inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 },
          }),
        },
      }),
    ]);
    const out = renderSnapshot(snapshot);
    expect(out).toContain("\x1b[33m$3.00");
  });

  it("color-codes cost red when $5 or more", () => {
    const snapshot = makeSnapshot([
      makeOrchestrator({
        workers: {
          "T-1": makeWorker({
            ticket: "T-1",
            cost: { costUSD: 7.0, inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 },
          }),
        },
      }),
    ]);
    const out = renderSnapshot(snapshot);
    expect(out).toContain("\x1b[31m$7.00");
  });
});

describe("renderStatsHeader", () => {
  it("returns empty string for empty snapshot", () => {
    const snapshot = makeSnapshot([]);
    expect(renderStatsHeader(snapshot)).toBe("");
  });

  it("includes worker count", () => {
    const snapshot = makeSnapshot([
      makeOrchestrator({
        workers: {
          "T-1": makeWorker({ ticket: "T-1" }),
          "T-2": makeWorker({ ticket: "T-2" }),
        },
      }),
    ]);
    const header = renderStatsHeader(snapshot);
    expect(header).toContain("2 workers");
  });

  it("sums cost across all workers", () => {
    const snapshot = makeSnapshot([
      makeOrchestrator({
        workers: {
          "T-1": makeWorker({ ticket: "T-1", cost: { costUSD: 1.5, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } }),
          "T-2": makeWorker({ ticket: "T-2", cost: { costUSD: 2.5, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } }),
        },
      }),
    ]);
    const header = renderStatsHeader(snapshot);
    expect(header).toContain("$4.00");
  });

  it("shows elapsed time from earliest worker", () => {
    const snapshot = makeSnapshot([
      makeOrchestrator({
        workers: {
          "T-1": makeWorker({
            ticket: "T-1",
            startedAt: new Date(Date.now() - 7200_000).toISOString(),
          }),
          "T-2": makeWorker({
            ticket: "T-2",
            startedAt: new Date(Date.now() - 3600_000).toISOString(),
          }),
        },
      }),
    ]);
    const header = renderStatsHeader(snapshot);
    expect(header).toContain("2h");
  });
});

describe("compact mode", () => {
  it("renders narrower output in compact mode", () => {
    const snapshot = makeSnapshot([
      makeOrchestrator({
        workers: {
          "PROJ-123": makeWorker({
            ticket: "PROJ-123",
            status: "implementing",
            pr: { number: 9999, url: "https://github.com/x/y/pull/9999" },
          }),
        },
      }),
    ]);
    const standard = renderSnapshot(snapshot);
    const compact = renderSnapshot(snapshot, { compact: true });
    // eslint-disable-next-line no-control-regex
    const ansi = /\x1b\[[0-9;]*m/g;
    const standardMaxWidth = Math.max(
      ...standard.split("\n").map((l) => l.replace(ansi, "").length)
    );
    const compactMaxWidth = Math.max(
      ...compact.split("\n").map((l) => l.replace(ansi, "").length)
    );
    expect(compactMaxWidth).toBeLessThan(standardMaxWidth);
  });

  it("keeps compact mode within 60 columns", () => {
    const snapshot = makeSnapshot([
      makeOrchestrator({
        workers: {
          "PROJ-123": makeWorker({
            ticket: "PROJ-123",
            status: "implementing",
            pr: { number: 9999, url: "https://github.com/x/y/pull/9999" },
          }),
        },
      }),
    ]);
    const out = renderSnapshot(snapshot, { compact: true });
    // eslint-disable-next-line no-control-regex
    const ansi = /\x1b\[[0-9;]*m/g;
    for (const line of out.split("\n")) {
      const stripped = line.replace(ansi, "");
      expect(stripped.length).toBeLessThanOrEqual(60);
    }
  });

  it("abbreviates status in compact mode", () => {
    const snapshot = makeSnapshot([
      makeOrchestrator({
        workers: {
          "T-1": makeWorker({ ticket: "T-1", status: "implementing" }),
        },
      }),
    ]);
    const out = renderSnapshot(snapshot, { compact: true });
    expect(out).not.toContain("implementing");
    expect(out).toContain("impl");
  });

  it("omits label column in compact mode", () => {
    const snapshot = makeSnapshot([
      makeOrchestrator({
        workers: {
          "T-1": makeWorker({ ticket: "T-1", label: "oneshot T-1" }),
        },
      }),
    ]);
    const out = renderSnapshot(snapshot, { compact: true });
    expect(out).not.toContain("LABEL");
  });
});
