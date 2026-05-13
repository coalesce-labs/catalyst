// CTL-331: verify broker appendEvent emits OTel-shaped canonical envelopes
// so the HUD's shouldSkipEvent guard doesn't drop them.
//
// Run: bun test plugins/dev/scripts/broker/canonical-events.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir;
let originalCatalystDir;

// Re-import the broker fresh in each test so the CATALYST_DIR env var is
// picked up by the module's `getEventLogPath` (it reads process.env at call
// time, so a single import is fine — but we set/restore the env per test).

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "broker-canonical-test-"));
  originalCatalystDir = process.env.CATALYST_DIR;
  process.env.CATALYST_DIR = tmpDir;
});

afterEach(() => {
  if (originalCatalystDir === undefined) {
    delete process.env.CATALYST_DIR;
  } else {
    process.env.CATALYST_DIR = originalCatalystDir;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

function eventLogPath() {
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return join(tmpDir, "events", `${ym}.jsonl`);
}

function readEvents() {
  const path = eventLogPath();
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

describe("buildCanonicalEnvelope", () => {
  test("produces canonical shape with attributes wrapper", async () => {
    const { buildCanonicalEnvelope } = await import("./index.mjs");
    const envelope = buildCanonicalEnvelope({
      event: "filter.wake.sess_abc",
      orchestrator: "orch_1",
      worker: null,
      detail: { reason: "PR #1 merged", interest_id: "sess_abc" },
    });

    expect(envelope.attributes["event.name"]).toBe("filter.wake.sess_abc");
    expect(envelope.attributes["catalyst.orchestrator.id"]).toBe("orch_1");
    expect(envelope.severityText).toBe("INFO");
    expect(envelope.severityNumber).toBe(9);
    expect(envelope.resource["service.name"]).toBe("catalyst.broker");
    expect(envelope.resource["service.namespace"]).toBe("catalyst");
    expect(envelope.body.payload).toEqual({ reason: "PR #1 merged", interest_id: "sess_abc" });
    expect(envelope.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(envelope.spanId).toBeNull();
  });

  test("omits orchestrator/worker attributes when null", async () => {
    const { buildCanonicalEnvelope } = await import("./index.mjs");
    const envelope = buildCanonicalEnvelope({
      event: "broker.daemon.startup",
      orchestrator: null,
      worker: null,
      detail: { pid: 12345 },
    });

    expect(envelope.attributes["event.name"]).toBe("broker.daemon.startup");
    expect(envelope.attributes["catalyst.orchestrator.id"]).toBeUndefined();
    expect(envelope.attributes["catalyst.worker.ticket"]).toBeUndefined();
    expect(envelope.traceId).toBeNull();
    expect(envelope.spanId).toBeNull();
    expect(envelope.body.payload).toEqual({ pid: 12345 });
  });

  test("populates worker.ticket and spanId when worker is set", async () => {
    const { buildCanonicalEnvelope } = await import("./index.mjs");
    const envelope = buildCanonicalEnvelope({
      event: "filter.wake.sess_x",
      orchestrator: "orch_1",
      worker: "CTL-331",
      detail: null,
    });

    expect(envelope.attributes["catalyst.worker.ticket"]).toBe("CTL-331");
    expect(envelope.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  test("trace/span derivation is deterministic", async () => {
    const { buildCanonicalEnvelope } = await import("./index.mjs");
    const a = buildCanonicalEnvelope({ event: "x", orchestrator: "orch_1", worker: null });
    const b = buildCanonicalEnvelope({ event: "y", orchestrator: "orch_1", worker: null });
    expect(a.traceId).toBe(b.traceId);

    const c = buildCanonicalEnvelope({ event: "x", orchestrator: "orch_2", worker: null });
    expect(a.traceId).not.toBe(c.traceId);
  });

  test("emits a top-level id on every envelope (CTL-344)", async () => {
    const { buildCanonicalEnvelope } = await import("./index.mjs");
    const a = buildCanonicalEnvelope({ event: "x", orchestrator: "orch_1", worker: null });
    const b = buildCanonicalEnvelope({ event: "x", orchestrator: "orch_1", worker: null });
    expect(a.id).toBeString();
    expect(b.id).toBeString();
    expect(a.id.length).toBeGreaterThanOrEqual(16);
    // unique per emission
    expect(a.id).not.toBe(b.id);
    // trace/span stay deterministic — twin property preserved
    expect(a.traceId).toBe(b.traceId);
    expect(a.spanId).toBe(b.spanId);
  });

  test("body.payload is null when detail is null/undefined", async () => {
    const { buildCanonicalEnvelope } = await import("./index.mjs");
    const noDetail = buildCanonicalEnvelope({ event: "x", orchestrator: null, worker: null });
    expect(noDetail.body.payload).toBeNull();

    const nullDetail = buildCanonicalEnvelope({
      event: "x",
      orchestrator: null,
      worker: null,
      detail: null,
    });
    expect(nullDetail.body.payload).toBeNull();
  });

  // CTL-362: enrich filter.wake / broker.daemon envelopes with the
  // interest's repo so the HUD's REPO column populates.
  test("copies legacy.repo into vcs.repository.name", async () => {
    const { buildCanonicalEnvelope } = await import("./index.mjs");
    const envelope = buildCanonicalEnvelope({
      event: "filter.wake.sess_repo",
      orchestrator: "orch_1",
      worker: null,
      repo: "coalesce-labs/catalyst",
      detail: { reason: "PR #1 merged", interest_id: "sess_repo" },
    });
    expect(envelope.attributes["vcs.repository.name"]).toBe("coalesce-labs/catalyst");
  });

  test("accepts vcsRepo as an alias for repo", async () => {
    const { buildCanonicalEnvelope } = await import("./index.mjs");
    const envelope = buildCanonicalEnvelope({
      event: "filter.wake.sess_alias",
      orchestrator: "orch_1",
      worker: null,
      vcsRepo: "coalesce-labs/adva",
      detail: null,
    });
    expect(envelope.attributes["vcs.repository.name"]).toBe("coalesce-labs/adva");
  });

  test("omits vcs.repository.name when repo is null/undefined/empty", async () => {
    const { buildCanonicalEnvelope } = await import("./index.mjs");
    const noRepo = buildCanonicalEnvelope({
      event: "broker.daemon.startup",
      orchestrator: null,
      worker: null,
      detail: { pid: 12345 },
    });
    expect(noRepo.attributes["vcs.repository.name"]).toBeUndefined();

    const nullRepo = buildCanonicalEnvelope({
      event: "filter.wake.sess_empty",
      orchestrator: "orch_1",
      worker: null,
      repo: null,
      detail: null,
    });
    expect(nullRepo.attributes["vcs.repository.name"]).toBeUndefined();

    const emptyRepo = buildCanonicalEnvelope({
      event: "filter.wake.sess_empty_str",
      orchestrator: "orch_1",
      worker: null,
      repo: "",
      detail: null,
    });
    expect(emptyRepo.attributes["vcs.repository.name"]).toBeUndefined();
  });
});

describe("appendEvent — writes canonical envelopes to JSONL", () => {
  test("writes a canonical line that passes shouldSkipEvent shape check", async () => {
    const { appendEvent } = await import("./index.mjs");
    appendEvent({
      event: "filter.wake.sess_abc",
      orchestrator: "orch_1",
      worker: null,
      detail: { reason: "PR #1 merged" },
    });

    const events = readEvents();
    expect(events).toHaveLength(1);
    const e = events[0];

    // The exact shape requirement that broke before: attributes["event.name"]
    // must be set so HUD's shouldSkipEvent doesn't discard the event.
    expect(e.attributes).toBeDefined();
    expect(e.attributes["event.name"]).toBe("filter.wake.sess_abc");

    // Full canonical fields present.
    expect(e.ts).toBeString();
    expect(e.observedTs).toBeString();
    expect(e.severityText).toBe("INFO");
    expect(e.severityNumber).toBe(9);
    expect(e.resource["service.name"]).toBe("catalyst.broker");
    expect(e.body.payload.reason).toBe("PR #1 merged");
  });

  test("writes broker.daemon.startup as canonical", async () => {
    const { appendEvent } = await import("./index.mjs");
    appendEvent({
      event: "broker.daemon.startup",
      orchestrator: null,
      worker: null,
      detail: { pid: 99, recovered_interests: 0 },
    });

    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].attributes["event.name"]).toBe("broker.daemon.startup");
    expect(events[0].body.payload.pid).toBe(99);
  });

  test("appended line carries a non-empty id (CTL-344)", async () => {
    const { appendEvent } = await import("./index.mjs");
    appendEvent({
      event: "filter.wake.id-test",
      orchestrator: "orch_1",
      worker: null,
      detail: { reason: "x" },
    });
    appendEvent({
      event: "filter.wake.id-test",
      orchestrator: "orch_1",
      worker: null,
      detail: { reason: "x" },
    });
    const events = readEvents();
    expect(events).toHaveLength(2);
    expect(events[0].id).toBeString();
    expect(events[0].id.length).toBeGreaterThanOrEqual(16);
    expect(events[0].id).not.toBe(events[1].id);
  });

  test("appended lines are valid JSON with no legacy v1 fields at the top level", async () => {
    const { appendEvent } = await import("./index.mjs");
    appendEvent({
      event: "filter.wake.x",
      orchestrator: "orch_1",
      worker: null,
      detail: { reason: "x" },
    });

    const events = readEvents();
    const e = events[0];
    // Legacy v1 shape had `event` and `detail` at the top level — these must
    // NOT appear on the canonical envelope itself; they live inside
    // attributes/body now.
    expect(e.event).toBeUndefined();
    expect(e.detail).toBeUndefined();
    expect(e.orchestrator).toBeUndefined();
    expect(e.worker).toBeUndefined();
  });
});
