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

  it("should accept signal file with fixupCommit (fix-up worker pushed to an open PR)", () => {
    const signal = {
      ticket: "ADV-219",
      orchestrator: "orch-test",
      workerName: "orch-test-ADV-219-fixup",
      status: "pr-created",
      phase: 5,
      startedAt: "2026-04-13T18:00:00Z",
      updatedAt: "2026-04-13T18:15:00Z",
      fixupCommit: "3704e82f9f7f0d0a9e1c2b3a4f5e6d7c8b9a0f1e",
    };
    expect(validateSignalFile(signal)).toBe(true);
  });

  it("should accept signal file with followUpTo (follow-up ticket linked to parent)", () => {
    const signal = {
      ticket: "ADV-222",
      orchestrator: "orch-test",
      workerName: "orch-test-ADV-222",
      status: "implementing",
      phase: 3,
      startedAt: "2026-04-13T18:00:00Z",
      updatedAt: "2026-04-13T18:15:00Z",
      followUpTo: "ADV-221",
    };
    expect(validateSignalFile(signal)).toBe(true);
  });

  it("should reject signal file with non-string fixupCommit", () => {
    const signal = {
      ticket: "ADV-219",
      orchestrator: "orch-test",
      workerName: "orch-test-ADV-219",
      status: "pr-created",
      phase: 5,
      startedAt: "2026-04-13T18:00:00Z",
      updatedAt: "2026-04-13T18:15:00Z",
      fixupCommit: 12345,
    };
    expect(validateSignalFile(signal)).toBe(false);
  });

  it("should reject signal file with non-string followUpTo", () => {
    const signal = {
      ticket: "ADV-222",
      orchestrator: "orch-test",
      workerName: "orch-test-ADV-222",
      status: "implementing",
      phase: 3,
      startedAt: "2026-04-13T18:00:00Z",
      updatedAt: "2026-04-13T18:15:00Z",
      followUpTo: ["ADV-221"],
    };
    expect(validateSignalFile(signal)).toBe(false);
  });
});
