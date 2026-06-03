// linear-state-write-event.test.mjs — CTL-757: canonical linear.state.write event.
// Run: cd plugins/dev/scripts/execution-core && bun test linear-state-write-event.test.mjs
//
// Mirrors triage-transition-event.test.mjs: envelope shape, channel!=webhook,
// payload round-trip, append-swallow.
import { describe, test, expect } from "bun:test";
import {
  buildLinearStateWriteEvent,
  appendLinearStateWriteEvent,
} from "./linear-state-write-event.mjs";

describe("buildLinearStateWriteEvent", () => {
  test("envelope shape — required attributes, resource, severityText, payload", () => {
    const line = buildLinearStateWriteEvent({
      ticket: "CTL-757",
      orchId: "CTL-757",
      from_state: "Research",
      to_state: "Plan",
      transition_key: "planning",
      phase: "plan",
      source: "scheduler-advance",
      applied: true,
    });
    expect(typeof line).toBe("string");
    expect(line.endsWith("\n")).toBe(true);
    const ev = JSON.parse(line);
    expect(ev.attributes["event.name"]).toBe("linear.state.write.CTL-757");
    expect(ev.attributes["event.entity"]).toBe("linear");
    expect(ev.attributes["event.action"]).toBe("state-write");
    expect(ev.attributes["linear.issue.identifier"]).toBe("CTL-757");
    expect(ev.resource["service.name"]).toBe("catalyst.execution-core");
    expect(ev.severityText).toBe("INFO");
    expect(ev.severityNumber).toBe(9);
    expect(ev.body.payload).toMatchObject({
      ticket: "CTL-757",
      actor: "catalyst.execution-core",
      source: "scheduler-advance",
      phase: "plan",
      transition_key: "planning",
      from_state: "Research",
      to_state: "Plan",
      applied: true,
      verified: false,
      reason: null,
    });
    expect(ev.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test("channel is execution-core, NOT webhook (distinguishes daemon-write from inbound echo)", () => {
    const ev = JSON.parse(buildLinearStateWriteEvent({ ticket: "CTL-757" }));
    expect(ev.channel).toBe("execution-core");
    expect(ev.channel).not.toBe("webhook");
    expect(ev.attributes["event.channel"]).toBe("execution-core");
    expect(ev.attributes["event.channel"]).not.toBe("webhook");
  });

  test("actor defaults to catalyst.execution-core (human-vs-daemon discriminator)", () => {
    const ev = JSON.parse(buildLinearStateWriteEvent({ ticket: "CTL-757" }));
    expect(ev.body.payload.actor).toBe("catalyst.execution-core");
    expect(ev.resource["service.name"]).toBe("catalyst.execution-core");
  });

  test("payload round-trip — all caller-supplied fields survive serialization", () => {
    const ev = JSON.parse(
      buildLinearStateWriteEvent({
        ticket: "CTL-758",
        orchId: "ORCH-1",
        from_state: "Done",
        to_state: "Done",
        transition_key: "done",
        phase: "monitor-deploy",
        source: "terminal-sweep",
        reason: "skipped-terminal-no-backward",
        applied: false,
        verified: true,
      })
    );
    expect(ev.attributes["catalyst.orchestration"]).toBe("ORCH-1");
    expect(ev.body.payload).toEqual({
      ticket: "CTL-758",
      actor: "catalyst.execution-core",
      source: "terminal-sweep",
      phase: "monitor-deploy",
      transition_key: "done",
      from_state: "Done",
      to_state: "Done",
      applied: false,
      verified: true,
      reason: "skipped-terminal-no-backward",
    });
  });

  test("orchId defaults to ticket when omitted", () => {
    const ev = JSON.parse(buildLinearStateWriteEvent({ ticket: "CTL-1" }));
    expect(ev.attributes["catalyst.orchestration"]).toBe("CTL-1");
  });

  test("reason field defaults to null when omitted", () => {
    const ev = JSON.parse(buildLinearStateWriteEvent({ ticket: "CTL-1" }));
    expect(ev.body.payload.reason).toBeNull();
  });
});

describe("appendLinearStateWriteEvent", () => {
  test("best-effort: injected appendFn that throws returns false and does not throw", () => {
    const result = appendLinearStateWriteEvent({
      ticket: "CTL-757",
      append: () => {
        throw new Error("disk full");
      },
    });
    expect(result).toBe(false);
  });

  test("best-effort: injected appendFn is called with valid JSONL, returns true", () => {
    const appended = [];
    const result = appendLinearStateWriteEvent({
      ticket: "CTL-757",
      orchId: "CTL-757",
      from_state: "Research",
      to_state: "Plan",
      source: "scheduler-advance",
      applied: true,
      append: (line) => appended.push(line),
    });
    expect(result).toBe(true);
    expect(appended).toHaveLength(1);
    const ev = JSON.parse(appended[0]);
    expect(ev.attributes["event.name"]).toBe("linear.state.write.CTL-757");
    expect(ev.channel).toBe("execution-core");
    expect(ev.body.payload.source).toBe("scheduler-advance");
  });
});
