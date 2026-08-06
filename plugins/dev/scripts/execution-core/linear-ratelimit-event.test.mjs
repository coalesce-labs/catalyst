// linear-ratelimit-event.test.mjs — CTL-1430 (WS-A A1). linear.ratelimit.breaker
// envelope builder + best-effort emitter.
//
// Run: cd plugins/dev/scripts/execution-core && bun test linear-ratelimit-event.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildLinearBreakerEnvelope,
  emitLinearBreakerEvent,
  LINEAR_BREAKER_EVENT,
} from "./linear-ratelimit-event.mjs";

const HOST_ENVS = ["CATALYST_HOST_NAME", "CATALYST_LAYER2_CONFIG_FILE"];
let savedEnv = {};

beforeEach(() => {
  for (const k of HOST_ENVS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of HOST_ENVS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  savedEnv = {};
});

describe("buildLinearBreakerEnvelope — OPEN (CTL-1430)", () => {
  test("open envelope: name/entity/action + reason/caller/cooldown/consecutive payload", () => {
    const env = buildLinearBreakerEnvelope({
      state: "open",
      reason: "timeout",
      caller: "linearis:issues-read",
      cooldownMs: 60000,
      consecutive: 1,
    });
    expect(env.attributes["event.name"]).toBe("linear.ratelimit.breaker");
    expect(LINEAR_BREAKER_EVENT).toBe("linear.ratelimit.breaker");
    expect(env.attributes["event.entity"]).toBe("linear");
    expect(env.attributes["event.action"]).toBe("ratelimit.breaker.open");
    expect(env.body.payload.state).toBe("open");
    expect(env.body.payload.reason).toBe("timeout");
    expect(env.body.payload.caller).toBe("linearis:issues-read");
    expect(env.body.payload.cooldownMs).toBe(60000);
    expect(env.body.payload.consecutive).toBe(1);
    expect(env.body.payload["host.name"]).toBeDefined();
  });

  test("promotes reason/caller/state to OTLP attributes (CTL-1430 F3 — survive otel-forward→Loki)", () => {
    const env = buildLinearBreakerEnvelope({
      state: "open",
      reason: "timeout",
      caller: "linearis:issues-read",
      cooldownMs: 60000,
      consecutive: 1,
    });
    expect(env.attributes["catalyst.linear.breaker.state"]).toBe("open");
    expect(env.attributes["catalyst.linear.breaker.reason"]).toBe("timeout");
    expect(env.attributes["catalyst.linear.breaker.caller"]).toBe("linearis:issues-read");
  });

  test("open is WARN severity (13)", () => {
    const env = buildLinearBreakerEnvelope({ state: "open", reason: "429", caller: "x" });
    expect(env.severityText).toBe("WARN");
    expect(env.severityNumber).toBe(13);
  });

  test("stamps host + service on the resource block", () => {
    process.env.CATALYST_HOST_NAME = "mini";
    const env = buildLinearBreakerEnvelope({ state: "open", reason: "429", caller: "x" });
    expect(env.resource["service.name"]).toBe("catalyst.execution-core");
    expect(env.resource["service.namespace"]).toBe("catalyst");
    expect(env.resource["host.name"]).toBe("mini");
    expect(env.body.payload["host.name"]).toBe("mini");
  });

  test("ts is a no-millisecond ISO string by default", () => {
    const env = buildLinearBreakerEnvelope({ state: "open", reason: "429", caller: "x" });
    expect(env.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});

describe("buildLinearBreakerEnvelope — CLOSED (CTL-1430)", () => {
  test("closed envelope: state closed, reason/caller null, recoveredAfter carried, INFO severity", () => {
    const env = buildLinearBreakerEnvelope({ state: "closed", recoveredAfter: 3 });
    expect(env.attributes["event.name"]).toBe("linear.ratelimit.breaker");
    expect(env.attributes["event.action"]).toBe("ratelimit.breaker.closed");
    expect(env.body.payload.state).toBe("closed");
    expect(env.body.payload.reason).toBeNull();
    expect(env.body.payload.caller).toBeNull();
    expect(env.body.payload.recoveredAfter).toBe(3);
    expect(env.body.payload.cooldownMs).toBe(0);
    expect(env.severityText).toBe("INFO");
    expect(env.severityNumber).toBe(9);
    // closed carries only state in attributes; reason/caller are open-only.
    expect(env.attributes["catalyst.linear.breaker.state"]).toBe("closed");
    expect(env.attributes["catalyst.linear.breaker.reason"]).toBeUndefined();
    expect(env.attributes["catalyst.linear.breaker.caller"]).toBeUndefined();
  });
});

describe("emitLinearBreakerEvent (CTL-1430)", () => {
  let tmp;
  let logPath;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ctl1430-lrb-"));
    logPath = join(tmp, "events.jsonl");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("appends one parseable open line to the event log", () => {
    process.env.CATALYST_HOST_NAME = "mini";
    expect(
      emitLinearBreakerEvent({
        state: "open",
        reason: "429",
        caller: "cluster-heartbeat-publisher",
        cooldownMs: 60000,
        consecutive: 1,
        logPath,
      }),
    ).toBe(true);
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const evt = JSON.parse(lines[0]);
    expect(evt.attributes["event.name"]).toBe("linear.ratelimit.breaker");
    expect(evt.body.payload.state).toBe("open");
    expect(evt.body.payload.reason).toBe("429");
    expect(evt.body.payload.caller).toBe("cluster-heartbeat-publisher");
    expect(evt.body.payload["host.name"]).toBe("mini");
  });

  test("appends a parseable closed line", () => {
    expect(emitLinearBreakerEvent({ state: "closed", recoveredAfter: 2, logPath })).toBe(true);
    const evt = JSON.parse(readFileSync(logPath, "utf8").trim());
    expect(evt.body.payload.state).toBe("closed");
    expect(evt.body.payload.recoveredAfter).toBe(2);
  });

  test("returns false (never throws) when the log path is unwriteable", () => {
    const fileAsDir = join(tmp, "afile");
    appendFileSync(fileAsDir, "x");
    const bad = join(fileAsDir, "events.jsonl");
    expect(emitLinearBreakerEvent({ state: "open", reason: "429", caller: "x", logPath: bad })).toBe(false);
  });
});
