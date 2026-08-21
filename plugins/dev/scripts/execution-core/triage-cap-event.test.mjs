// triage-cap-event.test.mjs — CTL-2111: durable triage-cap re-arm / park events.
// Run: cd plugins/dev/scripts/execution-core && bun test triage-cap-event.test.mjs
import { describe, test, expect } from "bun:test";
import {
  buildTriageCapRearmedEvent,
  appendTriageCapRearmedEvent,
  buildTriageCapParkedEvent,
  appendTriageCapParkedEvent,
} from "./triage-cap-event.mjs";

describe("buildTriageCapRearmedEvent", () => {
  test("envelope shape — INFO, name, entity/action, payload", () => {
    const line = buildTriageCapRearmedEvent({
      ticket: "CTL-2111",
      orchId: "CTL-2111",
      eventTs: "2026-08-21T10:00:00Z",
      cappedAt: "2026-08-20T00:00:00Z",
    });
    expect(typeof line).toBe("string");
    expect(line.endsWith("\n")).toBe(true);
    const ev = JSON.parse(line);
    expect(ev.attributes["event.name"]).toBe("triage.cap.rearmed.CTL-2111");
    expect(ev.attributes["event.entity"]).toBe("triage");
    expect(ev.attributes["event.action"]).toBe("cap-rearmed");
    expect(ev.attributes["event.label"]).toBe("CTL-2111");
    expect(ev.attributes["linear.issue.identifier"]).toBe("CTL-2111");
    expect(ev.resource["service.name"]).toBe("catalyst.execution-core");
    expect(ev.severityText).toBe("INFO");
    expect(ev.severityNumber).toBe(9);
    expect(ev.body.payload).toMatchObject({
      ticket: "CTL-2111",
      eventTs: "2026-08-21T10:00:00Z",
      cappedAt: "2026-08-20T00:00:00Z",
    });
    expect(ev.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test("not a pipeline-lifecycle action (broker ignores it)", () => {
    const ev = JSON.parse(buildTriageCapRearmedEvent({ ticket: "CTL-1" }));
    expect(["complete", "failed", "turn-cap-exhausted", "skipped"]).not.toContain(
      ev.attributes["event.action"],
    );
    // no coordination stamp — triage.* is not a coordination-published prefix
    expect(ev.attributes["event.stream_class"]).toBeUndefined();
  });
});

describe("appendTriageCapRearmedEvent", () => {
  test("passes a canonical line to the injected append and returns true", () => {
    let captured = null;
    const ok = appendTriageCapRearmedEvent({
      ticket: "CTL-2111",
      orchId: "CTL-2111",
      eventTs: "2026-08-21T10:00:00Z",
      cappedAt: "2026-08-20T00:00:00Z",
      append: (line) => { captured = line; },
    });
    expect(ok).toBe(true);
    expect(JSON.parse(captured).attributes["event.name"]).toBe("triage.cap.rearmed.CTL-2111");
  });

  test("fail-open — swallows a throwing append and returns false", () => {
    const ok = appendTriageCapRearmedEvent({
      ticket: "CTL-2111",
      append: () => { throw new Error("disk full"); },
    });
    expect(ok).toBe(false);
  });
});

describe("buildTriageCapParkedEvent", () => {
  test("envelope shape — WARN, name, entity/action, payload", () => {
    const line = buildTriageCapParkedEvent({
      ticket: "CTL-2111",
      orchId: "CTL-2111",
      cap: 3,
      count: 3,
    });
    const ev = JSON.parse(line);
    expect(ev.attributes["event.name"]).toBe("escalation.triage-cap-parked.CTL-2111");
    expect(ev.attributes["event.entity"]).toBe("escalation");
    expect(ev.attributes["event.action"]).toBe("triage-cap-parked");
    expect(ev.attributes["event.label"]).toBe("CTL-2111");
    expect(ev.attributes["linear.issue.identifier"]).toBe("CTL-2111");
    expect(ev.resource["service.name"]).toBe("catalyst.execution-core");
    expect(ev.severityText).toBe("WARN");
    expect(ev.body.payload).toMatchObject({ ticket: "CTL-2111", cap: 3, count: 3 });
  });

  test("not a pipeline-lifecycle action, no coordination stamp", () => {
    const ev = JSON.parse(buildTriageCapParkedEvent({ ticket: "CTL-1" }));
    expect(["complete", "failed", "turn-cap-exhausted", "skipped"]).not.toContain(
      ev.attributes["event.action"],
    );
    expect(ev.attributes["event.stream_class"]).toBeUndefined();
  });
});

describe("appendTriageCapParkedEvent", () => {
  test("passes a canonical line to the injected append and returns true", () => {
    let captured = null;
    const ok = appendTriageCapParkedEvent({
      ticket: "CTL-2111",
      orchId: "CTL-2111",
      cap: 3,
      count: 4,
      append: (line) => { captured = line; },
    });
    expect(ok).toBe(true);
    expect(JSON.parse(captured).attributes["event.name"]).toBe(
      "escalation.triage-cap-parked.CTL-2111",
    );
  });

  test("fail-open — swallows a throwing append and returns false", () => {
    const ok = appendTriageCapParkedEvent({
      ticket: "CTL-2111",
      append: () => { throw new Error("disk full"); },
    });
    expect(ok).toBe(false);
  });
});
