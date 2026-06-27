// install-telemetry.test.mjs — CTL-1369. Pins the catalyst.install.* EVENT contract: the
// canonical envelope (service.name + low-card label dims + high-card detail kept in the
// body), the file appender, and the InstallRun recorder's start → phase → complete / fail
// emission sequence. The per-run SPAN tree (emitInstallTrace) is tested in tracing.test.mjs
// alongside the other span emitters, against an in-memory exporter.
import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INSTALL_SERVICE_NAME,
  INSTALL_EVENT,
  INSTALL_PHASES,
  buildInstallEnvelope,
  makeInstallEmitFn,
  InstallRun,
} from "./install-telemetry.mjs";

let tmpCounter = 0;
const tmpFiles = [];
function tmpLog() {
  const p = join(tmpdir(), `install-telemetry-test-${process.pid}-${tmpCounter++}.jsonl`);
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  for (const f of tmpFiles.splice(0)) {
    try {
      rmSync(f, { force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("buildInstallEnvelope (the canonical catalyst.install.* event shape)", () => {
  test("stamps service.name=catalyst.install + namespace + host + node.class", () => {
    const env = buildInstallEnvelope({
      event: INSTALL_EVENT.started,
      operation: "install",
      nodeClass: "developer",
      hostNameVal: "mini",
      nowFn: () => 0,
    });
    expect(env.resource["service.name"]).toBe(INSTALL_SERVICE_NAME);
    expect(env.resource["service.namespace"]).toBe("catalyst");
    expect(env.resource["host.name"]).toBe("mini");
    expect(env.resource["host.id"]).toMatch(/^[0-9a-f]{16}$/);
    expect(env.resource["catalyst.node.class"]).toBe("developer");
  });

  test("event.entity is install; event.action is the trailing dot-segment", () => {
    expect(buildInstallEnvelope({ event: "catalyst.install.completed" }).attributes["event.entity"]).toBe("install");
    expect(buildInstallEnvelope({ event: "catalyst.install.completed" }).attributes["event.action"]).toBe("completed");
    expect(buildInstallEnvelope({ event: INSTALL_EVENT.rolledBack }).attributes["event.action"]).toBe("rolled_back");
  });

  test("low-card dims ride attributes; high-card detail rides the body payload", () => {
    const env = buildInstallEnvelope({
      event: INSTALL_EVENT.phase,
      operation: "reinstall",
      phase: "write-config",
      outcome: null,
      detail: { path: "/Users/x/.config/catalyst/config.json", duration_ms: 42 },
    });
    expect(env.attributes["catalyst.install.operation"]).toBe("reinstall");
    expect(env.attributes["catalyst.install.phase"]).toBe("write-config");
    expect(env.attributes["catalyst.install.outcome"]).toBeNull();
    // the path (high-card) must NOT leak onto an attribute/label — it stays in the body.
    expect(JSON.stringify(env.attributes)).not.toContain("/Users/x/");
    expect(env.body.payload.path).toBe("/Users/x/.config/catalyst/config.json");
  });

  test("severity maps to the OTel severityNumber", () => {
    expect(buildInstallEnvelope({ event: INSTALL_EVENT.failed, severity: "ERROR" }).severityNumber).toBe(17);
    expect(buildInstallEnvelope({ event: INSTALL_EVENT.started }).severityText).toBe("INFO");
  });

  test("carries trace context when seeded (the trace↔log join), null otherwise", () => {
    const seeded = buildInstallEnvelope({ event: INSTALL_EVENT.started, traceId: "abc", spanId: "def" });
    expect(seeded.traceId).toBe("abc");
    expect(seeded.spanId).toBe("def");
    const bare = buildInstallEnvelope({ event: INSTALL_EVENT.started });
    expect(bare.traceId).toBeNull();
    expect(bare.spanId).toBeNull();
  });
});

describe("makeInstallEmitFn (appends one JSONL envelope per call)", () => {
  test("writes a parseable catalyst.install.* line to the resolved log path", () => {
    const logPath = tmpLog();
    const emit = makeInstallEmitFn({ getLogPathFn: () => logPath, nowFn: () => 0, nodeClass: "worker", hostNameVal: "mini" });
    emit({ event: INSTALL_EVENT.started, operation: "install" });
    emit({ event: INSTALL_EVENT.phase, operation: "install", phase: "acquire", detail: { duration_ms: 5 } });
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    const first = JSON.parse(lines[0]);
    expect(first.attributes["event.name"]).toBe("catalyst.install.started");
    expect(first.resource["service.name"]).toBe(INSTALL_SERVICE_NAME);
    expect(JSON.parse(lines[1]).attributes["catalyst.install.phase"]).toBe("acquire");
  });

  test("an emit failure never throws (best-effort observability)", () => {
    const emit = makeInstallEmitFn({ getLogPathFn: () => "/nonexistent-dir/\0/x.jsonl", nodeClass: "worker", hostNameVal: "mini" });
    expect(() => emit({ event: INSTALL_EVENT.started, operation: "install" })).not.toThrow();
  });

  test("per-call nodeClass/traceId/spanId override the baked defaults", () => {
    const logPath = tmpLog();
    const emit = makeInstallEmitFn({ getLogPathFn: () => logPath, nowFn: () => 0, nodeClass: "worker", hostNameVal: "mini" });
    // a `reinstall --class developer` on a worker node must stamp the REQUESTED class + the trace
    emit({ event: INSTALL_EVENT.started, operation: "reinstall", nodeClass: "developer", traceId: "tid", spanId: "sid" });
    const env = JSON.parse(readFileSync(logPath, "utf8").trim());
    expect(env.resource["catalyst.node.class"]).toBe("developer"); // override, NOT the baked worker
    expect(env.traceId).toBe("tid");
    expect(env.spanId).toBe("sid");
  });
});

describe("InstallRun (the lifecycle recorder PR2 drives)", () => {
  test("start → phase → complete emits started, phase, completed in order", async () => {
    const events = [];
    const run = new InstallRun({
      operation: "install",
      nodeClass: "developer",
      emit: (e) => events.push(e),
      nowFn: (() => {
        let t = 0;
        return () => (t += 1);
      })(),
    });
    run.start();
    await run.phase("acquire", () => "ok");
    run.complete();
    expect(events.map((e) => e.event)).toEqual([
      INSTALL_EVENT.started,
      INSTALL_EVENT.phase,
      INSTALL_EVENT.completed,
    ]);
    expect(events[1].phase).toBe("acquire");
    expect(events[2].outcome).toBe("completed");
    expect(run.phases).toEqual([expect.objectContaining({ name: "acquire", ok: true })]);
  });

  test("a throwing phase records ok:false, emits a failed phase event, and re-throws", async () => {
    const events = [];
    const run = new InstallRun({ operation: "install", nodeClass: "worker", emit: (e) => events.push(e), nowFn: () => 0 });
    run.start();
    await expect(run.phase("backup", () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    const phaseEvent = events.find((e) => e.event === INSTALL_EVENT.phase);
    expect(phaseEvent.outcome).toBe("failed");
    expect(phaseEvent.severity).toBe("ERROR");
    expect(run.phases[0]).toEqual(expect.objectContaining({ name: "backup", ok: false, error: "boom" }));
  });

  test("fail({rolledBack:true}) emits catalyst.install.rolled_back", () => {
    const events = [];
    const run = new InstallRun({ operation: "reinstall", nodeClass: "worker", emit: (e) => events.push(e), nowFn: () => 0 });
    run.start();
    run.fail(new Error("nope"), { rolledBack: true });
    const terminal = events[events.length - 1];
    expect(terminal.event).toBe(INSTALL_EVENT.rolledBack);
    expect(terminal.outcome).toBe("rolled_back");
    expect(terminal.detail.error).toBe("nope");
  });

  test("every emitted event carries the run's operation + node class + trace context", () => {
    const events = [];
    // reinstall --class developer on a node whose config differs: events must stamp developer
    const run = new InstallRun({ operation: "reinstall", nodeClass: "developer", emit: (e) => events.push(e), traceId: "tid", spanId: "sid", nowFn: () => 0 });
    run.start();
    run.fail(new Error("x"));
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.operation).toBe("reinstall");
      expect(e.nodeClass).toBe("developer");
      expect(e.traceId).toBe("tid");
      expect(e.spanId).toBe("sid");
    }
  });

  test("INSTALL_PHASES is the locked, ordered phase enum", () => {
    expect(INSTALL_PHASES).toEqual(["acquire", "backup", "write-config", "install-agents", "start-daemons", "healthcheck"]);
  });
});
