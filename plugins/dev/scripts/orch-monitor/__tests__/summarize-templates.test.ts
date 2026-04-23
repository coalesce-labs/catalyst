import { describe, it, expect } from "bun:test";
import {
  renderTemplate,
  TEMPLATE_NAMES,
} from "../lib/summarize/templates";
import type { SummarizeSnapshot } from "../lib/summarize/snapshot";
import type { OrchestratorState, WorkerState } from "../lib/state-reader";

function makeWorker(overrides: Partial<WorkerState> = {}): WorkerState {
  return {
    ticket: "CTL-1",
    label: null,
    status: "researching",
    phase: 1,
    wave: 1,
    pid: 1234,
    alive: true,
    pr: null,
    startedAt: "2026-04-22T12:00:00Z",
    updatedAt: "2026-04-22T12:01:00Z",
    timeSinceUpdate: 60,
    lastHeartbeat: "2026-04-22T12:01:00Z",
    definitionOfDone: {},
    ...overrides,
  };
}

function makeSnapshot(
  overrides: Partial<SummarizeSnapshot> = {},
): SummarizeSnapshot {
  const state: OrchestratorState = {
    id: "orch-test",
    path: "/tmp/orch-test",
    workspace: "default",
    startedAt: "2026-04-22T12:00:00Z",
    currentWave: 1,
    totalWaves: 1,
    waves: [{ wave: 1, status: "in_progress", tickets: ["CTL-1"] }],
    workers: { "CTL-1": makeWorker() },
    dashboard: null,
    briefings: {},
    attention: [
      {
        type: "waiting-for-user",
        ticket: "CTL-1",
        message: "Worker failed: test errors",
      },
    ],
  };
  return {
    orchId: "orch-test",
    state,
    workers: state.workers,
    briefings: state.briefings,
    summaryMd: null,
    snapshotHash: "abc123",
    ...overrides,
  };
}

describe("TEMPLATE_NAMES", () => {
  it("exports the known templates", () => {
    expect(TEMPLATE_NAMES).toContain("run-summary");
    expect(TEMPLATE_NAMES).toContain("attention-digest");
    expect(TEMPLATE_NAMES).toContain("worker-status");
  });
});

describe("renderTemplate", () => {
  it("renders run-summary with orchId and worker info", () => {
    const out = renderTemplate("run-summary", makeSnapshot());
    expect(out).toContain("orch-test");
    expect(out).toContain("CTL-1");
  });

  it("renders attention-digest with attention items", () => {
    const out = renderTemplate("attention-digest", makeSnapshot());
    expect(out).toContain("CTL-1");
    expect(out).toContain("Worker failed: test errors");
  });

  it("renders worker-status", () => {
    const out = renderTemplate("worker-status", makeSnapshot());
    expect(out).toContain("orch-test");
    expect(out).toContain("CTL-1");
    expect(out).toContain("researching");
  });

  it("throws on unknown template", () => {
    expect(() => renderTemplate("not-a-template", makeSnapshot())).toThrow(
      /unknown template/,
    );
  });

  it("substitutes {{summaryMd}} when present", () => {
    const out = renderTemplate(
      "run-summary",
      makeSnapshot({ summaryMd: "A concise run recap." }),
    );
    expect(out).toContain("A concise run recap.");
  });

  it("substitutes {{briefings}} when briefings present", () => {
    const out = renderTemplate(
      "run-summary",
      makeSnapshot({ briefings: { 1: "Wave 1 brief content." } }),
    );
    expect(out).toContain("Wave 1 brief content.");
  });

  it("replaces missing sections with '(none)' instead of leaving braces", () => {
    const out = renderTemplate("run-summary", makeSnapshot());
    expect(out).not.toContain("{{");
    expect(out).toContain("(none)");
  });
});
