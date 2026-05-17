// Unit tests for catalyst-broker worker.state_changed projection (CTL-483).
// Run: bun test plugins/dev/scripts/broker/worker-state.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  handleWorkerStateChanged,
  getProjectedWorkerStatePath,
  writeProjectedWorkerState,
} from "./index.mjs";

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "broker-worker-state-test-"));
  process.env.CATALYST_DIR = tmpDir;
  process.env.CATALYST_RUNS_DIR = join(tmpDir, "runs");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.CATALYST_DIR;
  delete process.env.CATALYST_RUNS_DIR;
});

function makeCanonicalEvent({
  orchestrator = "orch-1",
  ticket = "CTL-100",
  writer = "orchestrate-auto-rebase",
  state = { ticket: "CTL-100", status: "pr-created", phase: 5, dirtySince: null },
  ts = "2026-05-17T18:00:00.000Z",
} = {}) {
  return {
    ts,
    id: "00000000-0000-4000-8000-000000000001",
    observedTs: ts,
    severityText: "INFO",
    severityNumber: 9,
    resource: { "service.name": "catalyst.orchestrator" },
    attributes: {
      "event.name": "worker.state_changed",
      "catalyst.orchestrator.id": orchestrator,
      "catalyst.worker.ticket": ticket,
      "catalyst.writer": writer,
    },
    body: {
      message: `worker ${ticket} state changed by ${writer}`,
      payload: { ticket, orchestrator, writer, state },
    },
  };
}

function makeLegacyEvent({
  orchestrator = "orch-1",
  ticket = "CTL-100",
  writer = "orchestrate-auto-rebase",
  state = { ticket: "CTL-100", status: "pr-created" },
  ts = "2026-05-17T18:00:00.000Z",
} = {}) {
  return {
    event: "worker.state_changed",
    ts,
    orchestrator,
    detail: { ticket, writer, state },
  };
}

describe("worker.state_changed projection (CTL-483)", () => {
  test("getProjectedWorkerStatePath honors CATALYST_RUNS_DIR", () => {
    const p = getProjectedWorkerStatePath("orch-A", "CTL-1");
    expect(p).toBe(join(tmpDir, "runs", "orch-A", "workers", "CTL-1.json.projected"));
  });

  test("getProjectedWorkerStatePath falls back to CATALYST_DIR/runs when CATALYST_RUNS_DIR unset", () => {
    delete process.env.CATALYST_RUNS_DIR;
    const p = getProjectedWorkerStatePath("orch-A", "CTL-1");
    expect(p).toBe(join(tmpDir, "runs", "orch-A", "workers", "CTL-1.json.projected"));
  });

  test("happy path: canonical event writes shadow file with state contents + _projected meta", () => {
    const event = makeCanonicalEvent({
      orchestrator: "orch-1",
      ticket: "CTL-100",
      state: { ticket: "CTL-100", status: "pr-created", phase: 5, dirtySince: null },
    });
    handleWorkerStateChanged(event);

    const target = getProjectedWorkerStatePath("orch-1", "CTL-100");
    expect(existsSync(target)).toBe(true);

    const written = JSON.parse(readFileSync(target, "utf8"));
    expect(written.ticket).toBe("CTL-100");
    expect(written.status).toBe("pr-created");
    expect(written.phase).toBe(5);
    expect(written.dirtySince).toBeNull();
    expect(written._projected).toEqual({
      writer: "orchestrate-auto-rebase",
      ts: "2026-05-17T18:00:00.000Z",
    });
  });

  test("legacy flat envelope (event/detail/orchestrator) is also accepted", () => {
    const event = makeLegacyEvent({
      orchestrator: "orch-2",
      ticket: "CTL-200",
      state: { ticket: "CTL-200", status: "implementing" },
    });
    handleWorkerStateChanged(event);

    const target = getProjectedWorkerStatePath("orch-2", "CTL-200");
    expect(existsSync(target)).toBe(true);
    const written = JSON.parse(readFileSync(target, "utf8"));
    expect(written.status).toBe("implementing");
    expect(written._projected.writer).toBe("orchestrate-auto-rebase");
  });

  test("missing orchestrator: drops event, no file written", () => {
    const event = makeCanonicalEvent();
    delete event.attributes["catalyst.orchestrator.id"];
    delete event.body.payload.orchestrator;
    handleWorkerStateChanged(event);

    const target = getProjectedWorkerStatePath("orch-1", "CTL-100");
    expect(existsSync(target)).toBe(false);
  });

  test("missing ticket: drops event, no file written", () => {
    const event = makeCanonicalEvent();
    delete event.attributes["catalyst.worker.ticket"];
    delete event.body.payload.ticket;
    handleWorkerStateChanged(event);

    // Path won't resolve cleanly anyway, but the key invariant is that the
    // runs/orch-1/workers/ dir contains no files for this run.
    const workersDir = join(tmpDir, "runs", "orch-1", "workers");
    if (existsSync(workersDir)) {
      const fs = require("node:fs");
      expect(fs.readdirSync(workersDir).length).toBe(0);
    }
  });

  test("missing state payload: drops event, no file written", () => {
    const event = makeCanonicalEvent();
    delete event.body.payload.state;
    handleWorkerStateChanged(event);

    const target = getProjectedWorkerStatePath("orch-1", "CTL-100");
    expect(existsSync(target)).toBe(false);
  });

  test("state is not an object: drops event, no file written", () => {
    const event = makeCanonicalEvent();
    event.body.payload.state = "not-an-object";
    handleWorkerStateChanged(event);

    const target = getProjectedWorkerStatePath("orch-1", "CTL-100");
    expect(existsSync(target)).toBe(false);
  });

  test("writeProjectedWorkerState: atomic write removes tmp on success", () => {
    const target = getProjectedWorkerStatePath("orch-3", "CTL-300");
    writeProjectedWorkerState(target, { ticket: "CTL-300", status: "done" }, {
      writer: "test",
      ts: "2026-05-17T19:00:00.000Z",
    });

    expect(existsSync(target)).toBe(true);
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  test("writeProjectedWorkerState: overwrites existing projected file", () => {
    const target = getProjectedWorkerStatePath("orch-4", "CTL-400");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify({ stale: true }));

    writeProjectedWorkerState(target, { ticket: "CTL-400", status: "implementing" }, {
      writer: "test",
      ts: "2026-05-17T19:00:00.000Z",
    });

    const written = JSON.parse(readFileSync(target, "utf8"));
    expect(written.stale).toBeUndefined();
    expect(written.status).toBe("implementing");
  });

  test("_projected meta is derived from attributes.catalyst.writer when present", () => {
    const event = makeCanonicalEvent({ writer: "orchestrate-dispatch-next" });
    handleWorkerStateChanged(event);

    const target = getProjectedWorkerStatePath("orch-1", "CTL-100");
    const written = JSON.parse(readFileSync(target, "utf8"));
    expect(written._projected.writer).toBe("orchestrate-dispatch-next");
  });

  test("_projected meta falls back to 'unknown' when writer is absent everywhere", () => {
    const event = makeCanonicalEvent();
    delete event.attributes["catalyst.writer"];
    delete event.body.payload.writer;
    handleWorkerStateChanged(event);

    const target = getProjectedWorkerStatePath("orch-1", "CTL-100");
    const written = JSON.parse(readFileSync(target, "utf8"));
    expect(written._projected.writer).toBe("unknown");
  });
});
