// wait-event.test.mjs — CTL-650 Phase 3. The agent.* canonical-event builder
// and best-effort appender. buildWaitEnvelope is asserted without touching the
// FS; emitWaitEvent is exercised against a temp event log.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWaitEnvelope, emitWaitEvent } from "./wait-event.mjs";

const sessionId = "abcd1234-5555-6666-7777-888888888888";
const baseArgs = {
  a: { sessionId, status: "idle", cwd: "/wt/CTL-650" },
  state: "WAITING_USER",
  waitingText: "Should I proceed?",
  detail: "",
  meta: { ticket: "CTL-650", phase: "implement", orchestratorId: "CTL-650" },
};

describe("buildWaitEnvelope", () => {
  test("sets agent entity, INFO severity, and the given event name", () => {
    const env = buildWaitEnvelope("agent.waiting_on_user", baseArgs);
    expect(env.attributes["event.name"]).toBe("agent.waiting_on_user");
    expect(env.attributes["event.entity"]).toBe("agent");
    expect(env.severityText).toBe("INFO");
    expect(env.severityNumber).toBe(9);
    expect(env.resource["service.name"]).toBe("catalyst.execution-core");
  });

  test("payload carries sessionId/shortId/ticket/phase/waitState/waitingText/cwd", () => {
    const env = buildWaitEnvelope("agent.waiting_on_user", baseArgs);
    expect(env.body.payload).toMatchObject({
      sessionId,
      shortId: "abcd1234",
      ticket: "CTL-650",
      phase: "implement",
      waitState: "WAITING_USER",
      waitingText: "Should I proceed?",
      cwd: "/wt/CTL-650",
    });
  });

  test("sets the Linear identifier attribute when a ticket is present", () => {
    const env = buildWaitEnvelope("agent.waiting_on_user", baseArgs);
    expect(env.attributes["linear.issue.identifier"]).toBe("CTL-650");
    expect(env.attributes["event.label"]).toBe("CTL-650");
  });

  test("tolerates missing meta — null ticket/phase, no linear attribute", () => {
    const env = buildWaitEnvelope("agent.resumed", {
      a: { sessionId, status: "busy", cwd: "/wt" },
      state: "ACTIVE",
    });
    expect(env.body.payload.ticket).toBe(null);
    expect(env.body.payload.phase).toBe(null);
    expect(env.body.payload.waitState).toBe("ACTIVE");
    expect("linear.issue.identifier" in env.attributes).toBe(false);
  });

  test("ts is a Z-suffixed timestamp with no millisecond fraction", () => {
    const env = buildWaitEnvelope("agent.waiting_on_user", baseArgs);
    expect(env.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});

describe("emitWaitEvent", () => {
  test("appends exactly one valid JSON line to the event log", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl650-we-"));
    const logPath = join(dir, "2026-05.jsonl");
    const ok = emitWaitEvent("agent.waiting_on_user", baseArgs, { logPath });
    expect(ok).toBe(true);
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.attributes["event.name"]).toBe("agent.waiting_on_user");
    expect(parsed.body.payload.ticket).toBe("CTL-650");
  });

  test("creates the parent directory when missing (never throws)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl650-we-"));
    const logPath = join(dir, "nested", "deep", "2026-05.jsonl");
    expect(emitWaitEvent("agent.resumed", baseArgs, { logPath })).toBe(true);
    expect(readFileSync(logPath, "utf8").trim().split("\n").length).toBe(1);
  });
});
