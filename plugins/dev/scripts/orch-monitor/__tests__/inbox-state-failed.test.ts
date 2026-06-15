// CTL-1180: inbox-state tests for findHeldSignal picking up failed phases.
// findHeldSignal previously matched needs-input (pass 1) and stalled/held (pass 2).
// Adding "failed" to pass 2 means the CLI inbox can surface a reaped failed
// signal's explanation.call_to_action via humanQuestion.

import { describe, it, expect } from "bun:test";
import { mkdirSync, writeFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { collectInboxItemState } from "../lib/inbox-state";

function makeWorkerDir(
  ticket: string,
  phases: Record<string, Record<string, unknown>>,
  triage?: Record<string, unknown>,
): string {
  const base = mkdtempSync(join(tmpdir(), "ctl-1180-inbox-"));
  const ticketDir = join(base, ticket);
  mkdirSync(ticketDir, { recursive: true });
  for (const [phase, signal] of Object.entries(phases)) {
    writeFileSync(
      join(ticketDir, `phase-${phase}.json`),
      JSON.stringify(signal),
    );
  }
  writeFileSync(
    join(ticketDir, "triage.json"),
    JSON.stringify(
      triage ?? {
        ticket,
        classification: "bug",
        summary: "test ticket summary",
        estimate: 1,
        estimateMethod: "fibonacci",
        dependencies: [],
        generated_at: "2026-06-15T00:00:00Z",
      },
    ),
  );
  return base;
}

const TICKET = "CTL-1180-INBOX";
const FAKE_PROJECTS = "/tmp/no-projects-here";

describe("findHeldSignal — failed phase (CTL-1180)", () => {
  it("returns the phase-pr.json signal when status is 'failed'", async () => {
    const workersDir = makeWorkerDir(TICKET, {
      triage: { ticket: TICKET, status: "done", phase: "triage" },
      pr: {
        ticket: TICKET,
        status: "failed",
        phase: "pr",
        explanation: {
          escalation_type: "manual",
          call_to_action: "Manually push the branch — scope exceeded",
          problem: "Branch protection blocks automated push",
        },
      },
    });
    const item = await collectInboxItemState(TICKET, {
      workersDir,
      projectsDir: FAKE_PROJECTS,
      title: "Test ticket",
    });
    expect(item).not.toBeNull();
    expect(item!.phase).toBe("pr");
    expect(item!.status).toBe("failed");
    expect(item!.humanQuestion).toBe(
      "Manually push the branch — scope exceeded",
    );
  });

  it("needs-input (pass 1) still wins over a later failed phase", async () => {
    const workersDir = makeWorkerDir(TICKET, {
      triage: {
        ticket: TICKET,
        status: "needs-input",
        phase: "triage",
        explanation: { call_to_action: "provide scope" },
      },
      pr: {
        ticket: TICKET,
        status: "failed",
        phase: "pr",
        explanation: { call_to_action: "push manually" },
      },
    });
    const item = await collectInboxItemState(TICKET, {
      workersDir,
      projectsDir: FAKE_PROJECTS,
      title: "Test ticket",
    });
    expect(item).not.toBeNull();
    // needs-input (pass 1) has higher priority than failed (pass 2)
    expect(item!.status).toBe("needs-input");
    expect(item!.humanQuestion).toBe("provide scope");
  });

  it("returns null when no phase is stalled/held/failed/needs-input", async () => {
    const workersDir = makeWorkerDir(TICKET, {
      triage: { ticket: TICKET, status: "done", phase: "triage" },
      research: { ticket: TICKET, status: "running", phase: "research" },
    });
    const item = await collectInboxItemState(TICKET, {
      workersDir,
      projectsDir: FAKE_PROJECTS,
      title: "Test ticket",
    });
    expect(item).toBeNull();
  });
});
