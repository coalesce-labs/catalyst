// capacity-event.test.mjs — CTL-1092. node.capacity.changed envelope builder + emitter.
//
// Run: cd plugins/dev/scripts/execution-core && bun test capacity-event.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAPACITY_CHANGED_EVENT,
  buildCapacityChangedEnvelope,
  emitCapacityChangedEvent,
} from "./capacity-event.mjs";

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

describe("CAPACITY_CHANGED_EVENT constant", () => {
  test("is 'node.capacity.changed'", () => {
    expect(CAPACITY_CHANGED_EVENT).toBe("node.capacity.changed");
  });
});

describe("buildCapacityChangedEnvelope (CTL-1092)", () => {
  test("event name, entity, action attributes", () => {
    const e = buildCapacityChangedEnvelope({ oldMaxParallel: 4, newMaxParallel: 6, reason: "saturated-scale-up" });
    expect(e.attributes["event.name"]).toBe("node.capacity.changed");
    expect(e.attributes["event.entity"]).toBe("node");
    expect(e.attributes["event.action"]).toBe("capacity.changed");
  });

  test("carries old/new maxParallel, reason, and host.name in payload", () => {
    const e = buildCapacityChangedEnvelope({ oldMaxParallel: 4, newMaxParallel: 6, reason: "saturated-scale-up" });
    expect(e.body.payload.old_maxParallel).toBe(4);
    expect(e.body.payload.new_maxParallel).toBe(6);
    expect(e.body.payload.reason).toBe("saturated-scale-up");
    expect(typeof e.body.payload["host.name"]).toBe("string");
    expect(e.body.payload["host.name"].length).toBeGreaterThan(0);
  });

  test("resource block has service.name, service.namespace, host.name, host.id", () => {
    process.env.CATALYST_HOST_NAME = "mini";
    const e = buildCapacityChangedEnvelope({ oldMaxParallel: 4, newMaxParallel: 6, reason: "x" });
    expect(e.resource["service.name"]).toBe("catalyst.execution-core");
    expect(e.resource["service.namespace"]).toBe("catalyst");
    expect(e.resource["host.name"]).toBe("mini");
    expect(typeof e.resource["host.id"]).toBe("string");
    expect(e.resource["host.id"]).toHaveLength(16);
  });

  test("ts is a no-millisecond ISO string", () => {
    const e = buildCapacityChangedEnvelope({ oldMaxParallel: 2, newMaxParallel: 4, reason: "x" });
    expect(e.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test("severityText INFO, severityNumber 9", () => {
    const e = buildCapacityChangedEnvelope({ oldMaxParallel: 2, newMaxParallel: 4, reason: "x" });
    expect(e.severityText).toBe("INFO");
    expect(e.severityNumber).toBe(9);
  });
});

describe("emitCapacityChangedEvent (CTL-1092)", () => {
  let tmp;
  let logPath;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ctl1092-ce-"));
    logPath = join(tmp, "events.jsonl");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("appends one parseable node.capacity.changed line to the event log", () => {
    process.env.CATALYST_HOST_NAME = "mini";
    expect(emitCapacityChangedEvent({ oldMaxParallel: 4, newMaxParallel: 6, reason: "saturated-scale-up", logPath })).toBe(true);
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const evt = JSON.parse(lines[0]);
    expect(evt.attributes["event.name"]).toBe("node.capacity.changed");
    expect(evt.body.payload.old_maxParallel).toBe(4);
    expect(evt.body.payload.new_maxParallel).toBe(6);
    expect(evt.body.payload.reason).toBe("saturated-scale-up");
    expect(evt.body.payload["host.name"]).toBe("mini");
  });

  test("returns false (never throws) when the log path is unwriteable", () => {
    const fileAsDir = join(tmp, "afile");
    appendFileSync(fileAsDir, "x");
    const bad = join(fileAsDir, "events.jsonl");
    expect(emitCapacityChangedEvent({ oldMaxParallel: 4, newMaxParallel: 6, reason: "x", logPath: bad })).toBe(false);
  });
});
