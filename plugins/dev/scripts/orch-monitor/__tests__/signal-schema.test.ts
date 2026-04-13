import { describe, it, expect } from "bun:test";
import { validateSignalFile } from "../lib/signal-schema";

describe("signal file validation", () => {
  it("should accept signal file with pid field", () => {
    const signal = {
      ticket: "ADV-216",
      orchestrator: "orch-test",
      workerName: "orch-test-ADV-216",
      status: "in_progress",
      phase: 1,
      startedAt: "2026-04-13T18:00:00Z",
      updatedAt: "2026-04-13T18:15:00Z",
      pid: 12345,
      lastHeartbeat: "2026-04-13T18:15:00Z",
    };
    expect(validateSignalFile(signal)).toBe(true);
  });

  it("should accept signal file without pid (backwards compat)", () => {
    const signal = {
      ticket: "ADV-216",
      orchestrator: "orch-test",
      workerName: "orch-test-ADV-216",
      status: "dispatched",
      phase: 0,
      startedAt: "2026-04-13T18:00:00Z",
      updatedAt: "2026-04-13T18:00:00Z",
    };
    expect(validateSignalFile(signal)).toBe(true);
  });
});
