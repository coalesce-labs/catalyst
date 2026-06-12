// heartbeat-event.test.mjs — CTL-859. node.heartbeat builder + best-effort
// appender + the dormant readClusterHeartbeats reader. buildHeartbeatEnvelope is
// asserted without touching the FS; emit/start/read are exercised against a temp
// event log.
//
// Run: cd plugins/dev/scripts/execution-core && bun test heartbeat-event.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import {
  buildHeartbeatEnvelope,
  emitHeartbeatEvent,
  startHeartbeat,
  HEARTBEAT_EVENT,
} from "./heartbeat-event.mjs";
import { readClusterHeartbeats } from "./recovery.mjs";

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

describe("buildHeartbeatEnvelope (CTL-859)", () => {
  test("emits the node.heartbeat event name with INFO severity", () => {
    const env = buildHeartbeatEnvelope();
    expect(env.attributes["event.name"]).toBe("node.heartbeat");
    expect(HEARTBEAT_EVENT).toBe("node.heartbeat");
    expect(env.severityText).toBe("INFO");
    expect(env.severityNumber).toBe(9);
    expect(env.attributes["event.entity"]).toBe("node");
    expect(env.attributes["event.action"]).toBe("heartbeat");
  });

  test("carries host.name and an epoch in the payload", () => {
    process.env.CATALYST_HOST_NAME = "mini";
    const env = buildHeartbeatEnvelope({ epochFn: () => 1700000000000 });
    expect(env.body.payload["host.name"]).toBe("mini");
    expect(env.body.payload.epoch).toBe(1700000000000);
    expect(env.attributes["event.label"]).toBe("mini");
  });

  test("stamps host.name + host.id on the resource block", () => {
    process.env.CATALYST_HOST_NAME = "mac-studio";
    const env = buildHeartbeatEnvelope();
    expect(env.resource["service.name"]).toBe("catalyst.execution-core");
    expect(env.resource["service.namespace"]).toBe("catalyst");
    expect(env.resource["host.name"]).toBe("mac-studio");
    expect(typeof env.resource["host.id"]).toBe("string");
    expect(env.resource["host.id"]).toHaveLength(16);
  });

  test("host.name defaults to os.hostname() minus .local", () => {
    const env = buildHeartbeatEnvelope();
    const expected = hostname().replace(/\.local$/, "");
    expect(env.body.payload["host.name"]).toBe(expected);
  });

  test("ts is a no-millisecond ISO string by default", () => {
    const env = buildHeartbeatEnvelope();
    expect(env.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});

describe("emitHeartbeatEvent (CTL-859)", () => {
  let tmp;
  let logPath;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ctl859-hb-"));
    logPath = join(tmp, "events.jsonl");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("appends one parseable node.heartbeat line to the event log", () => {
    process.env.CATALYST_HOST_NAME = "mini";
    expect(emitHeartbeatEvent({ logPath })).toBe(true);
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const evt = JSON.parse(lines[0]);
    expect(evt.attributes["event.name"]).toBe("node.heartbeat");
    expect(evt.body.payload["host.name"]).toBe("mini");
  });

  test("returns false (never throws) when the log path is unwriteable", () => {
    // A path whose parent is a file, not a dir → mkdirSync/appendFileSync fail.
    const fileAsDir = join(tmp, "afile");
    appendFileSync(fileAsDir, "x");
    const bad = join(fileAsDir, "events.jsonl");
    expect(emitHeartbeatEvent({ logPath: bad })).toBe(false);
  });
});

describe("startHeartbeat (CTL-859)", () => {
  let tmp;
  let logPath;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ctl859-hbtimer-"));
    logPath = join(tmp, "events.jsonl");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("emits once immediately and returns a stop handle", () => {
    process.env.CATALYST_HOST_NAME = "mini";
    const h = startHeartbeat({ intervalMs: 1_000_000, logPath });
    try {
      const lines = readFileSync(logPath, "utf8").trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]).attributes["event.name"]).toBe("node.heartbeat");
      expect(typeof h.stop).toBe("function");
    } finally {
      h.stop();
    }
  });
});

describe("readClusterHeartbeats (CTL-859)", () => {
  let tmp;
  let logPath;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ctl859-hbread-"));
    logPath = join(tmp, "events.jsonl");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("returns {} when the event log is absent", () => {
    expect(readClusterHeartbeats({ logPath: join(tmp, "nope.jsonl") })).toEqual({});
  });

  test("returns the latest ts per host", () => {
    const hb = (host, ts) =>
      JSON.stringify({
        ts,
        attributes: { "event.name": "node.heartbeat" },
        resource: { "host.name": host },
        body: { payload: { "host.name": host, epoch: Date.parse(ts) } },
      }) + "\n";
    appendFileSync(logPath, hb("mini", "2026-06-08T00:00:00Z"));
    appendFileSync(logPath, hb("mini", "2026-06-08T00:01:00Z"));
    appendFileSync(logPath, hb("mac-studio", "2026-06-08T00:00:30Z"));
    const seen = readClusterHeartbeats({ logPath });
    expect(seen).toEqual({
      mini: "2026-06-08T00:01:00Z",
      "mac-studio": "2026-06-08T00:00:30Z",
    });
  });

  test("ignores non-heartbeat events and malformed lines", () => {
    appendFileSync(
      logPath,
      JSON.stringify({
        ts: "2026-06-08T00:00:00Z",
        attributes: { "event.name": "worker.memory.sampled" },
        resource: { "host.name": "mini" },
      }) + "\n",
    );
    appendFileSync(logPath, "{ not json\n");
    appendFileSync(
      logPath,
      JSON.stringify({
        ts: "2026-06-08T00:02:00Z",
        attributes: { "event.name": "node.heartbeat" },
        resource: { "host.name": "mini" },
        body: { payload: { "host.name": "mini", epoch: 1 } },
      }) + "\n",
    );
    expect(readClusterHeartbeats({ logPath })).toEqual({
      mini: "2026-06-08T00:02:00Z",
    });
  });

  test("round-trips an emitHeartbeatEvent-produced line", () => {
    process.env.CATALYST_HOST_NAME = "mini";
    emitHeartbeatEvent({ logPath });
    const seen = readClusterHeartbeats({ logPath });
    expect(Object.keys(seen)).toEqual(["mini"]);
    expect(typeof seen.mini).toBe("string");
  });
});

describe("heartbeat governance block (CTL-1062)", () => {
  test("payload carries a governance snapshot", () => {
    const env = buildHeartbeatEnvelope({
      governanceFn: () => ({ beliefsShadow: true, diagnostician: false, intentsEnforce: true,
        advanceShadowSummary: false, stallJanitor: { mode: "shadow" },
        watchdog: { mode: "shadow" }, unstuckSweep: { mode: "off" } }),
    });
    expect(env.body.payload.governance.beliefsShadow).toBe(true);
    expect(env.body.payload.governance.intentsEnforce).toBe(true);
    expect(env.body.payload.governance.stallJanitor.mode).toBe("shadow");
  });

  test("still carries host.name + epoch alongside governance (no regression)", () => {
    process.env.CATALYST_HOST_NAME = "mini";
    const env = buildHeartbeatEnvelope({ epochFn: () => 1700000000000, governanceFn: () => ({}) });
    expect(env.body.payload["host.name"]).toBe("mini");
    expect(env.body.payload.epoch).toBe(1700000000000);
    expect(env.body.payload.governance).toEqual({});
  });

  test("defaults to the real readGovernanceConfig when no governanceFn is injected", () => {
    const env = buildHeartbeatEnvelope();
    expect(typeof env.body.payload.governance).toBe("object");
    expect(env.body.payload.governance).toHaveProperty("beliefsShadow");
  });
});
