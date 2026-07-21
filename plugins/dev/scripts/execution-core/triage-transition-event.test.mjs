// triage-transition-event.test.mjs — CTL-704: canonical phase.triage.linear-transition event.
// Run: cd plugins/dev/scripts/execution-core && bun test triage-transition-event.test.mjs
import { describe, test, expect } from "bun:test";
import {
  buildTriageTransitionEvent,
  appendTriageTransitionEvent,
} from "./triage-transition-event.mjs";

describe("buildTriageTransitionEvent", () => {
  test("envelope shape — required attributes, resource, severityText, payload", () => {
    const line = buildTriageTransitionEvent({
      ticket: "CTL-704",
      orchId: "CTL-704",
      from_state: "Todo",
      to_state: "Triage",
      verified: true,
      applied: true,
    });
    expect(typeof line).toBe("string");
    expect(line.endsWith("\n")).toBe(true);
    const ev = JSON.parse(line);
    expect(ev.attributes["event.name"]).toBe("phase.triage.linear-transition.CTL-704");
    // CTL-1488: coordination-stamped so coordination-publish's fail-closed tailer mirrors it.
    expect(ev.attributes["event.stream_class"]).toBe("coordination");
    expect(ev.attributes["event.entity"]).toBe("phase");
    expect(ev.attributes["event.action"]).toBe("linear-transition");
    expect(ev.attributes["linear.issue.identifier"]).toBe("CTL-704");
    expect(ev.resource["service.name"]).toBe("catalyst.execution-core");
    expect(ev.severityText).toBe("INFO");
    expect(ev.severityNumber).toBe(9);
    expect(ev.body.payload).toMatchObject({
      phase: "triage",
      ticket: "CTL-704",
      from_state: "Todo",
      to_state: "Triage",
      verified: true,
      applied: true,
      reason: null,
    });
    // ts follows the no-millis ISO shape used elsewhere
    expect(ev.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test("broker-ignored — action is linear-transition, not a pipeline lifecycle action", () => {
    const ev = JSON.parse(buildTriageTransitionEvent({ ticket: "CTL-704" }));
    // The broker's PHASE_EVENT_PATTERN matches complete/failed/turn-cap-exhausted/skipped.
    // linear-transition is an observability-only event and must NOT match those patterns.
    const action = ev.attributes["event.action"];
    expect(action).toBe("linear-transition");
    expect(["complete", "failed", "turn-cap-exhausted", "skipped"]).not.toContain(action);
  });

  test("reason field defaults to null when omitted", () => {
    const ev = JSON.parse(buildTriageTransitionEvent({ ticket: "CTL-1", verified: false }));
    expect(ev.body.payload.reason).toBeNull();
  });

  // CTL-1023: this IS the triage phase — classification is still being decided,
  // so the work-type dimension defaults to "unknown" here. The attribute must
  // still be present (never inconsistently missing).
  test("CTL-1023: catalyst.ticket.type defaults to 'unknown' on the triage event", () => {
    const ev = JSON.parse(buildTriageTransitionEvent({ ticket: "CTL-1023" }));
    expect(ev.attributes["catalyst.ticket.type"]).toBe("unknown");
  });

  test("CTL-1023: catalyst.ticket.type passes through when supplied", () => {
    const ev = JSON.parse(buildTriageTransitionEvent({ ticket: "CTL-1023", ticketType: "bug" }));
    expect(ev.attributes["catalyst.ticket.type"]).toBe("bug");
  });
});

describe("appendTriageTransitionEvent", () => {
  test("best-effort: injected appendFn that throws returns false and does not throw", () => {
    const result = appendTriageTransitionEvent({
      ticket: "CTL-704",
      append: () => { throw new Error("disk full"); },
    });
    expect(result).toBe(false);
  });

  test("best-effort: injected appendFn is called with valid JSONL, returns true", () => {
    const appended = [];
    const result = appendTriageTransitionEvent({
      ticket: "CTL-704",
      orchId: "CTL-704",
      from_state: "Todo",
      to_state: "Triage",
      verified: true,
      applied: true,
      append: (line) => appended.push(line),
    });
    expect(result).toBe(true);
    expect(appended).toHaveLength(1);
    const ev = JSON.parse(appended[0]);
    expect(ev.attributes["event.name"]).toBe("phase.triage.linear-transition.CTL-704");
    expect(ev.body.payload.verified).toBe(true);
  });
});
