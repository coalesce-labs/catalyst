// worker-transition-event.test.mjs — CTL-764 Phase 3: worker.transition canonical event.
// Run: cd plugins/dev/scripts/execution-core && bun test worker-transition-event.test.mjs
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildWorkerTransitionEvent,
  appendWorkerTransitionEvent,
} from "./worker-transition-event.mjs";

// Local mirror of broker/router.mjs shouldSkipEvent — same as linear-state-write-event.test.mjs.
// The broker package needs its own bun install (pino) which tests here don't have.
function shouldSkipEventMirror(event) {
  if (event.resource?.["service.name"] === "catalyst.broker") return true;
  const name = event.attributes?.["event.name"] ?? "";
  if (name.startsWith("filter.")) return true;
  if (name.startsWith("broker.daemon")) return true;
  if (name === "session.heartbeat") return true;
  return false;
}

describe("buildWorkerTransitionEvent", () => {
  test("envelope shape — event.name, channel, severityText, resource, payload axes", () => {
    const line = buildWorkerTransitionEvent({
      ticket: "CTL-764",
      orchId: "CTL-764",
      fromStage: "Research",
      toStage: "Plan",
      fromDisposition: "queued",
      toDisposition: null,
      reason: "scheduler-advance",
      attempt: 1,
      reviveCount: 0,
    });
    expect(typeof line).toBe("string");
    expect(line.endsWith("\n")).toBe(true);
    const ev = JSON.parse(line);
    expect(ev.attributes["event.name"]).toBe("worker.transition.CTL-764");
    expect(ev.severityText).toBe("INFO");
    expect(ev.severityNumber).toBe(9);
    expect(ev.channel).toBe("execution-core");
    expect(ev.resource["service.name"]).toBe("catalyst.execution-core");
    expect(ev.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test("channel is execution-core, NOT webhook", () => {
    const ev = JSON.parse(buildWorkerTransitionEvent({ ticket: "CTL-764" }));
    expect(ev.channel).toBe("execution-core");
    expect(ev.channel).not.toBe("webhook");
    expect(ev.attributes["event.channel"]).toBe("execution-core");
  });

  // CTL-1488 Phase 2: caused_by + event.stream_class parity.
  test("caused_by threads through when provided, null by default (ADR-022 parity)", () => {
    const line = buildWorkerTransitionEvent({
      ticket: "CTL-1",
      orchId: "CTL-1",
      fromStage: "Research",
      toStage: "Plan",
      fromDisposition: "queued",
      toDisposition: "queued",
    });
    expect(JSON.parse(line).caused_by).toBeNull();
    const withCause = buildWorkerTransitionEvent({ ticket: "CTL-1", causedBy: "evt-xyz" });
    expect(JSON.parse(withCause).caused_by).toBe("evt-xyz");
  });
  test("stamps attributes['event.stream_class'] = 'coordination' (worker.transition is unconditionally coordination)", () => {
    const line = buildWorkerTransitionEvent({
      ticket: "CTL-1",
      orchId: "CTL-1",
      fromStage: "Research",
      toStage: "Plan",
      fromDisposition: "queued",
      toDisposition: "queued",
    });
    expect(JSON.parse(line).attributes["event.stream_class"]).toBe("coordination");
  });

  test("both axes round-trip in body.payload", () => {
    const ev = JSON.parse(
      buildWorkerTransitionEvent({
        ticket: "CTL-764",
        orchId: "CTL-764",
        fromStage: "Research",
        toStage: "Implement",
        fromDisposition: "blocked",
        toDisposition: "needs-human",
        reason: "stuck",
        attempt: 2,
        reviveCount: 1,
        source: "recovery-escalation",
        project: "catalyst",
        linearKey: "CTL-764",
        branch: "ryan/ctl-764-worker-state",
        taskType: "feature",
      })
    );
    const p = ev.body.payload;
    expect(p.ticket).toBe("CTL-764");
    expect(p.from_stage).toBe("Research");
    expect(p.to_stage).toBe("Implement");
    expect(p.from_disposition).toBe("blocked");
    expect(p.to_disposition).toBe("needs-human");
    expect(p.reason).toBe("stuck");
    expect(p.attempt).toBe(2);
    expect(p.revive_count).toBe(1);
    expect(p.source).toBe("recovery-escalation");
    expect(p.project).toBe("catalyst");
    expect(p.linearKey).toBe("CTL-764");
    expect(p.branch).toBe("ryan/ctl-764-worker-state");
    expect(p.taskType).toBe("feature");
  });

  test("dims as OTLP attributes — string values", () => {
    const ev = JSON.parse(
      buildWorkerTransitionEvent({
        ticket: "CTL-764",
        fromDisposition: "queued",
        toDisposition: "needs-human",
        fromStage: "Plan",
        toStage: "Implement",
        reason: "scheduler-advance",
      })
    );
    expect(ev.attributes["catalyst.worker.from_disposition"]).toBe("queued");
    expect(ev.attributes["catalyst.worker.to_disposition"]).toBe("needs-human");
    expect(ev.attributes["catalyst.worker.from_state"]).toBe("Plan");
    expect(ev.attributes["catalyst.worker.to_state"]).toBe("Implement");
    expect(ev.attributes["catalyst.worker.reason"]).toBe("scheduler-advance");
  });

  test("dims as OTLP attributes — intValue for attempt and revive_count", () => {
    const ev = JSON.parse(
      buildWorkerTransitionEvent({
        ticket: "CTL-764",
        attempt: 2,
        reviveCount: 1,
      })
    );
    // intValue: stored as Number (not string) in the attributes object
    expect(typeof ev.attributes["phase.attempt"]).toBe("number");
    expect(ev.attributes["phase.attempt"]).toBe(2);
    expect(typeof ev.attributes["phase.revive_count"]).toBe("number");
    expect(ev.attributes["phase.revive_count"]).toBe(1);
  });

  test("to_disposition is a scalar string (not JSON-array string)", () => {
    const ev = JSON.parse(
      buildWorkerTransitionEvent({
        ticket: "CTL-764",
        toDisposition: "blocked",
      })
    );
    const val = ev.attributes["catalyst.worker.to_disposition"];
    // Must be a plain string, not '["blocked"]'
    expect(typeof val).toBe("string");
    expect(val).toBe("blocked");
  });

  test("null toDisposition/toStage still produces a valid JSONL line", () => {
    const line = buildWorkerTransitionEvent({
      ticket: "CTL-764",
      toDisposition: null,
      toStage: null,
    });
    expect(() => JSON.parse(line)).not.toThrow();
    const ev = JSON.parse(line);
    expect(ev.attributes["catalyst.worker.to_disposition"]).toBeNull();
    expect(ev.attributes["catalyst.worker.to_state"]).toBeNull();
    expect(ev.body.payload.to_disposition).toBeNull();
    expect(ev.body.payload.to_stage).toBeNull();
  });

  // CTL-764 finding 6: the documented schema keys must be stamped on attributes so
  // off-machine filters (otel-forward drops body.payload) can scope by ticket / stage.
  test("finding 6 — documented keys (ticket + from_stage/to_stage) stamped; legacy from_state/to_state kept", () => {
    const ev = JSON.parse(
      buildWorkerTransitionEvent({
        ticket: "CTL-764",
        fromStage: "Research",
        toStage: "Plan",
      })
    );
    expect(ev.attributes["catalyst.worker.ticket"]).toBe("CTL-764");
    expect(ev.attributes["catalyst.worker.from_stage"]).toBe("Research");
    expect(ev.attributes["catalyst.worker.to_stage"]).toBe("Plan");
    // Legacy keys retained for on-machine consumers wired before the rename.
    expect(ev.attributes["catalyst.worker.from_state"]).toBe("Research");
    expect(ev.attributes["catalyst.worker.to_state"]).toBe("Plan");
  });

  // CTL-764 finding 12: a clear (from set → to null) is encoded as the "cleared"
  // sentinel on the attribute (otel-forward serializes a null attribute to "" and
  // drops body.payload). body.payload keeps the raw null for the on-machine reducer.
  test("finding 12 — a cleared disposition is the 'cleared' sentinel on the attribute", () => {
    const ev = JSON.parse(
      buildWorkerTransitionEvent({
        ticket: "CTL-764",
        fromDisposition: "needs-human",
        toDisposition: null,
        source: "terminal-done-clear",
      })
    );
    expect(ev.attributes["catalyst.worker.to_disposition"]).toBe("cleared");
    expect(ev.attributes["catalyst.worker.from_disposition"]).toBe("needs-human");
    // Raw null preserved in the body for the broker reducer (reads raw JSONL).
    expect(ev.body.payload.to_disposition).toBeNull();
  });

  test("finding 12 — a both-null disposition axis stays null (stage-only, not a clear)", () => {
    const ev = JSON.parse(
      buildWorkerTransitionEvent({
        ticket: "CTL-764",
        toStage: "plan", // stage transition; disposition axis unchanged
      })
    );
    expect(ev.attributes["catalyst.worker.to_disposition"]).toBeNull();
  });

  test("broker shouldSkipEvent mirror passes worker.transition (not a broker event)", () => {
    const ev = JSON.parse(buildWorkerTransitionEvent({ ticket: "CTL-764" }));
    expect(shouldSkipEventMirror(ev)).toBe(false);
  });

  test("resource has catalyst.orchestration attribute", () => {
    const ev = JSON.parse(buildWorkerTransitionEvent({ ticket: "CTL-764", orchId: "CTL-764" }));
    expect(ev.attributes["catalyst.orchestration"]).toBe("CTL-764");
    expect(ev.attributes["linear.issue.identifier"]).toBe("CTL-764");
  });
});

describe("appendWorkerTransitionEvent", () => {
  test("happy path — appends the line and returns true", () => {
    const lines = [];
    const result = appendWorkerTransitionEvent({
      ticket: "CTL-764",
      append: (line) => lines.push(line),
    });
    expect(result).toBe(true);
    expect(lines.length).toBe(1);
    const ev = JSON.parse(lines[0]);
    expect(ev.attributes["event.name"]).toBe("worker.transition.CTL-764");
  });

  test("swallows an append-throw and returns false", () => {
    const result = appendWorkerTransitionEvent({
      ticket: "CTL-764",
      append: () => {
        throw new Error("disk full");
      },
    });
    expect(result).toBe(false);
  });
});

// CTL-764 (verify CTL764-VER-1): production-wiring guard. The bug this catches:
// scheduler.mjs imported the emitter (as defaultAppendWorkerTransitionEvent) but
// runTick NEVER threaded it into the per-tick schedulerTick opts, so every
// recordTransition() early-returned on the `null` default and worker.transition
// (Sink-3, feeding OTLP Sink-4) was DARK in production — green only because the
// unit tests inject the seam directly. schedulerTick is a closure inside runTick
// (not exported), so this asserts the wiring at the source level: the imported
// default must be REFERENCED outside its import (not dead) AND wired into the
// schedulerTick opts with the runningOpts-override fallback.
describe("scheduler production wiring (CTL764-VER-1 regression guard)", () => {
  const schedulerSrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "scheduler.mjs"),
    "utf8"
  );
  const normalized = schedulerSrc.replace(/\s+/g, " ");

  test("defaultAppendWorkerTransitionEvent is threaded, not just imported", () => {
    const refs = schedulerSrc
      .split("\n")
      .filter((l) => l.includes("defaultAppendWorkerTransitionEvent"));
    const nonImport = refs.filter((l) => !l.trimStart().startsWith("import"));
    // At least one wiring reference beyond the import alias line.
    expect(nonImport.length).toBeGreaterThan(0);
  });

  test("runTick wires appendWorkerTransitionEvent into schedulerTick opts with a default fallback", () => {
    expect(normalized).toContain(
      "appendWorkerTransitionEvent: runningOpts.appendWorkerTransitionEvent ?? defaultAppendWorkerTransitionEvent"
    );
  });
});

// CTL-764 finding 5: convergeDispositionLabel is the only runtime code that applies
// the durable needs-input disposition label — but before this fix production never
// CALLED it (only its declaration + unit tests referenced it), so a needs-input park
// changed only the local signal. schedulerTick's needs-input convergence is a closure
// (not exported), so this guards the wiring at the source level: the converger must be
// INVOKED somewhere beyond its own declaration.
describe("CTL-764 finding 5 — convergeDispositionLabel production wiring", () => {
  const schedulerSrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "scheduler.mjs"),
    "utf8"
  );

  test("convergeDispositionLabel is invoked in the scheduler (not only declared)", () => {
    const callLines = schedulerSrc
      .split("\n")
      .filter(
        (l) =>
          l.includes("convergeDispositionLabel(") &&
          !l.trimStart().startsWith("//") &&
          !l.trimStart().startsWith("*") &&
          !l.includes("export function convergeDispositionLabel")
      );
    expect(callLines.length).toBeGreaterThan(0);
  });
});
