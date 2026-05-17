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

  it("should accept signal file with a label field", () => {
    const signal = {
      ticket: "ADV-216",
      orchestrator: "orch-test",
      workerName: "orch-test-ADV-216",
      status: "implementing",
      phase: 3,
      startedAt: "2026-04-13T18:00:00Z",
      updatedAt: "2026-04-13T18:15:00Z",
      label: "oneshot ADV-216",
    };
    expect(validateSignalFile(signal)).toBe(true);
  });

  it("should accept signal file without label (backwards compat)", () => {
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

  it("should reject signal file with non-string label", () => {
    const signal = {
      ticket: "ADV-216",
      orchestrator: "orch-test",
      workerName: "orch-test-ADV-216",
      status: "dispatched",
      phase: 0,
      startedAt: "2026-04-13T18:00:00Z",
      updatedAt: "2026-04-13T18:00:00Z",
      label: 12345,
    };
    expect(validateSignalFile(signal)).toBe(false);
  });

  it("should reject signal file with empty string label", () => {
    const signal = {
      ticket: "ADV-216",
      orchestrator: "orch-test",
      workerName: "orch-test-ADV-216",
      status: "dispatched",
      phase: 0,
      startedAt: "2026-04-13T18:00:00Z",
      updatedAt: "2026-04-13T18:00:00Z",
      label: "",
    };
    expect(validateSignalFile(signal)).toBe(false);
  });

  it("should accept signal file with null label", () => {
    const signal = {
      ticket: "ADV-216",
      orchestrator: "orch-test",
      workerName: "orch-test-ADV-216",
      status: "dispatched",
      phase: 0,
      startedAt: "2026-04-13T18:00:00Z",
      updatedAt: "2026-04-13T18:00:00Z",
      label: null,
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

  // CTL-211 — orchestrator-driven deploy lifecycle states. The worker exits at
  // `merging`; `merged`, `deploying`, `deploy-failed` are written by the
  // orchestrator's Phase 4 deploy state-machine.
  describe("CTL-211 deploy lifecycle states", () => {
    const baseSignal = {
      ticket: "CTL-211",
      orchestrator: "orch-test",
      workerName: "orch-test-CTL-211",
      phase: 5,
      startedAt: "2026-05-04T00:00:00Z",
      updatedAt: "2026-05-04T00:30:00Z",
    };

    it("accepts status: merged (PR merged, awaiting deploy start)", () => {
      expect(validateSignalFile({ ...baseSignal, status: "merged" })).toBe(true);
    });

    it("accepts status: deploying (deployment_status pending/in_progress observed)", () => {
      expect(validateSignalFile({ ...baseSignal, status: "deploying" })).toBe(true);
    });

    it("accepts status: deploy-failed (production deployment_status.failure)", () => {
      expect(validateSignalFile({ ...baseSignal, status: "deploy-failed" })).toBe(true);
    });

    it("rejects unknown deploy-like statuses", () => {
      expect(validateSignalFile({ ...baseSignal, status: "deployed-yay" })).toBe(false);
    });
  });

  // CTL-484 — turn-cap exhaustion is a distinct non-terminal status; the
  // continuation worker reads continuationCount + continuations[] to enforce
  // a separate budget from reviveCount.
  describe("CTL-484 turn-cap-exhausted lifecycle", () => {
    const baseSignal = {
      ticket: "CTL-484",
      orchestrator: "orch-test",
      workerName: "orch-test-CTL-484",
      phase: 3,
      startedAt: "2026-05-17T00:00:00Z",
      updatedAt: "2026-05-17T00:30:00Z",
    };

    it("accepts status: turn-cap-exhausted (worker self-stopped at /goal cap)", () => {
      expect(
        validateSignalFile({ ...baseSignal, status: "turn-cap-exhausted" }),
      ).toBe(true);
    });

    it("accepts continuationCount as a non-negative integer", () => {
      expect(
        validateSignalFile({
          ...baseSignal,
          status: "turn-cap-exhausted",
          continuationCount: 2,
        }),
      ).toBe(true);
      expect(
        validateSignalFile({
          ...baseSignal,
          status: "implementing",
          continuationCount: 0,
        }),
      ).toBe(true);
    });

    it("rejects negative continuationCount", () => {
      expect(
        validateSignalFile({
          ...baseSignal,
          status: "turn-cap-exhausted",
          continuationCount: -1,
        }),
      ).toBe(false);
    });

    it("rejects non-integer continuationCount", () => {
      expect(
        validateSignalFile({
          ...baseSignal,
          status: "turn-cap-exhausted",
          continuationCount: 1.5,
        }),
      ).toBe(false);
      expect(
        validateSignalFile({
          ...baseSignal,
          status: "turn-cap-exhausted",
          continuationCount: "two",
        }),
      ).toBe(false);
    });

    it("accepts continuations[] with valid audit entries", () => {
      expect(
        validateSignalFile({
          ...baseSignal,
          status: "turn-cap-exhausted",
          continuationCount: 2,
          continuations: [
            {
              ts: "2026-05-17T00:10:00Z",
              sessionId: "sess_abc",
              handoffPath: "thoughts/shared/handoffs/CTL-484/2026-05-17_00-10-00_turn-cap-continuation.md",
            },
            {
              ts: "2026-05-17T00:25:00Z",
              sessionId: "sess_def",
              handoffPath: "thoughts/shared/handoffs/CTL-484/2026-05-17_00-25-00_turn-cap-continuation.md",
            },
          ],
        }),
      ).toBe(true);
    });

    it("accepts empty continuations[] array", () => {
      expect(
        validateSignalFile({
          ...baseSignal,
          status: "implementing",
          continuations: [],
        }),
      ).toBe(true);
    });

    it("rejects continuations entry missing required keys", () => {
      expect(
        validateSignalFile({
          ...baseSignal,
          status: "turn-cap-exhausted",
          continuationCount: 1,
          continuations: [{ ts: "2026-05-17T00:10:00Z", sessionId: "sess_abc" }],
        }),
      ).toBe(false);
    });

    it("rejects continuations that is not an array", () => {
      expect(
        validateSignalFile({
          ...baseSignal,
          status: "turn-cap-exhausted",
          continuations: "not-an-array",
        }),
      ).toBe(false);
    });
  });
});
