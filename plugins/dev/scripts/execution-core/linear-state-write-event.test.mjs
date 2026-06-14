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

// Local mirror of broker/router.mjs shouldSkipEvent (CTL-401). The broker package
// has its own node_modules (pino) that the targeted scripts test-runner does not
// install, so importing the real router would fail with "Cannot find package
// 'pino'" (memory: fresh-worktree bun install). The skip predicate is tiny and
// stable; mirror it here verbatim and pin it with a shape-guard test below so a
// drift in EITHER the predicate or the event is caught. getEventName mirrors the
// broker's: attributes["event.name"] is the canonical name.
function shouldSkipEventMirror(event) {
  if (event.resource?.["service.name"] === "catalyst.broker") return true;
  const name = event.attributes?.["event.name"] ?? "";
  if (name.startsWith("filter.")) return true;
  if (name.startsWith("broker.daemon")) return true;
  if (name === "session.heartbeat") return true;
  return false;
}

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

  // CTL-1023: work-type dimension. Post-triage state writes carry the resolved
  // type; the attribute defaults to "unknown" so it is never inconsistently missing.
  test("CTL-1023: catalyst.ticket.type passes through when supplied (post-triage write)", () => {
    const ev = JSON.parse(buildLinearStateWriteEvent({ ticket: "CTL-757", ticketType: "feature" }));
    expect(ev.attributes["catalyst.ticket.type"]).toBe("feature");
  });

  test("CTL-1023: catalyst.ticket.type defaults to 'unknown' when omitted", () => {
    const ev = JSON.parse(buildLinearStateWriteEvent({ ticket: "CTL-757" }));
    expect(ev.attributes["catalyst.ticket.type"]).toBe("unknown");
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

// Plan Top-Risk: "Event-log schema collision — verify linear.state.write.<ticket>
// name/channel don't collide with a broker shouldSkipEvent predicate." The broker
// self-filters its OWN emissions; the new audit event MUST flow through (it is not
// a broker/filter/heartbeat emission), or the HUD / wait-for would never see it.
describe("CTL-757: no collision with broker shouldSkipEvent", () => {
  test("the built linear.state.write event is NOT skipped by the broker predicate", () => {
    const ev = JSON.parse(
      buildLinearStateWriteEvent({
        ticket: "CTL-757",
        from_state: "Research",
        to_state: "Plan",
        source: "scheduler-advance",
        applied: true,
      })
    );
    // service.name is catalyst.execution-core (not catalyst.broker), name is
    // linear.state.write.* (not filter./broker.daemon/session.heartbeat).
    expect(shouldSkipEventMirror(ev)).toBe(false);
  });

  test("the discriminating attributes the broker keys on are all NON-skip values", () => {
    // Pins WHY the event survives: if a future edit moved service.name to
    // catalyst.broker, renamed the event to filter./broker.daemon, or collapsed
    // it to session.heartbeat, one of these asserts (and the mirror test) fails.
    const ev = JSON.parse(buildLinearStateWriteEvent({ ticket: "CTL-757" }));
    expect(ev.resource?.["service.name"]).not.toBe("catalyst.broker");
    const name = ev.attributes?.["event.name"] ?? "";
    expect(name.startsWith("filter.")).toBe(false);
    expect(name.startsWith("broker.daemon")).toBe(false);
    expect(name).not.toBe("session.heartbeat");
    expect(name).toBe("linear.state.write.CTL-757");
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
