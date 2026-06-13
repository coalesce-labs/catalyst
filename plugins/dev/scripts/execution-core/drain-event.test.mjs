// drain-event.test.mjs — CTL-1095. node.drain.changed + node.drain.drained
// envelope builders and best-effort emitters.
//
// Run: cd plugins/dev/scripts/execution-core && bun test drain-event.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import {
  buildDrainChangedEnvelope,
  emitDrainChangedEvent,
  buildDrainedEnvelope,
  emitDrainedEvent,
  DRAIN_CHANGED_EVENT,
  DRAINED_EVENT,
} from "./drain-event.mjs";

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

describe("buildDrainChangedEnvelope (CTL-1095)", () => {
  test("drain.changed envelope: name/entity/action + draining + inFlightCount payload", () => {
    const env = buildDrainChangedEnvelope({ draining: true, inFlightCount: 3 });
    expect(env.attributes["event.name"]).toBe("node.drain.changed");
    expect(DRAIN_CHANGED_EVENT).toBe("node.drain.changed");
    expect(env.attributes["event.entity"]).toBe("node");
    expect(env.attributes["event.action"]).toBe("drain.changed");
    expect(env.body.payload.draining).toBe(true);
    expect(env.body.payload.inFlightCount).toBe(3);
    expect(env.body.payload["host.name"]).toBeDefined();
  });

  test("draining:false is reflected in payload", () => {
    const env = buildDrainChangedEnvelope({ draining: false, inFlightCount: 0 });
    expect(env.body.payload.draining).toBe(false);
    expect(env.body.payload.inFlightCount).toBe(0);
  });

  test("stamps host.name + host.id on the resource block", () => {
    process.env.CATALYST_HOST_NAME = "mini";
    const env = buildDrainChangedEnvelope({ draining: true, inFlightCount: 1 });
    expect(env.resource["service.name"]).toBe("catalyst.execution-core");
    expect(env.resource["service.namespace"]).toBe("catalyst");
    expect(env.resource["host.name"]).toBe("mini");
    expect(typeof env.resource["host.id"]).toBe("string");
    expect(env.resource["host.id"]).toHaveLength(16);
  });

  test("host.name is a non-empty string (resolved via config chain)", () => {
    const env = buildDrainChangedEnvelope({ draining: true, inFlightCount: 0 });
    expect(typeof env.body.payload["host.name"]).toBe("string");
    expect(env.body.payload["host.name"].length).toBeGreaterThan(0);
  });

  test("ts is a no-millisecond ISO string by default", () => {
    const env = buildDrainChangedEnvelope({ draining: true, inFlightCount: 0 });
    expect(env.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test("severityText INFO, severityNumber 9", () => {
    const env = buildDrainChangedEnvelope({ draining: true, inFlightCount: 0 });
    expect(env.severityText).toBe("INFO");
    expect(env.severityNumber).toBe(9);
  });
});

describe("buildDrainedEnvelope (CTL-1095)", () => {
  test("drained envelope: name/entity/action + draining:true + inFlightCount:0", () => {
    const env = buildDrainedEnvelope();
    expect(env.attributes["event.name"]).toBe("node.drain.drained");
    expect(DRAINED_EVENT).toBe("node.drain.drained");
    expect(env.attributes["event.entity"]).toBe("node");
    expect(env.attributes["event.action"]).toBe("drain.drained");
    expect(env.body.payload.draining).toBe(true);
    expect(env.body.payload.inFlightCount).toBe(0);
  });
});

describe("emitDrainChangedEvent (CTL-1095)", () => {
  let tmp;
  let logPath;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ctl1095-dc-"));
    logPath = join(tmp, "events.jsonl");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("appends one parseable node.drain.changed line to the event log", () => {
    process.env.CATALYST_HOST_NAME = "mini";
    expect(emitDrainChangedEvent({ draining: true, inFlightCount: 2, logPath })).toBe(true);
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const evt = JSON.parse(lines[0]);
    expect(evt.attributes["event.name"]).toBe("node.drain.changed");
    expect(evt.body.payload.draining).toBe(true);
    expect(evt.body.payload.inFlightCount).toBe(2);
    expect(evt.body.payload["host.name"]).toBe("mini");
  });

  test("returns false (never throws) when the log path is unwriteable", () => {
    const fileAsDir = join(tmp, "afile");
    appendFileSync(fileAsDir, "x");
    const bad = join(fileAsDir, "events.jsonl");
    expect(emitDrainChangedEvent({ draining: false, inFlightCount: 0, logPath: bad })).toBe(false);
  });
});

describe("emitDrainedEvent (CTL-1095)", () => {
  let tmp;
  let logPath;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ctl1095-dd-"));
    logPath = join(tmp, "events.jsonl");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("appends one parseable node.drain.drained line", () => {
    process.env.CATALYST_HOST_NAME = "mini";
    expect(emitDrainedEvent({ logPath })).toBe(true);
    const line = JSON.parse(readFileSync(logPath, "utf8").trim());
    expect(line.attributes["event.name"]).toBe("node.drain.drained");
    expect(line.body.payload.draining).toBe(true);
    expect(line.body.payload.inFlightCount).toBe(0);
  });

  test("returns false (never throws) when the log path is unwriteable", () => {
    const fileAsDir = join(tmp, "afile");
    appendFileSync(fileAsDir, "x");
    const bad = join(fileAsDir, "events.jsonl");
    expect(emitDrainedEvent({ logPath: bad })).toBe(false);
  });
});
