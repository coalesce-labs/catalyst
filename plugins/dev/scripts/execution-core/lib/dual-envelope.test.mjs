// dual-envelope.test.mjs — CTL-1795 phase 1. Every v1 emit site also emits the v2 shape, as
// ONE SUPERSET LINE carrying both the top-level `event` and an `attributes` block.
//
// Run: cd plugins/dev/scripts/execution-core && bun test lib/dual-envelope.test.mjs
//
// WHY ONE LINE AND NOT TWO. A v1 line and a v2 twin of the SAME event would BOTH resolve to
// the same name and BOTH be routed; handleAgentCheckin/handleAgentCheckout run upsertAgent and
// _autoRegisterPrLifecycle on each, so two lines would double-apply them. A superset line is
// processed exactly once by every existing consumer while being visible to an attributes-only
// reader for the first time.
//
// CTL-1834: the "safe because getEventName reads event.event FIRST" wording this comment used
// to carry was imprecise. What makes it safe is that it is ONE line — one line resolves to one
// name and routes once under ANY key ordering. Order only matters if the two keys disagree, and
// across every log file ever written all 322 dual lines carry identical values in both.
// The single boundary is now lib/event-name.mjs (three keys: event, attributes["event.name"],
// name); broker/projection.mjs's byte-identical copy and broker/router.mjs's inline ladder are
// gone.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildDualEnvelopeLine, FLAT_ATTRIBUTE_MAP } from "./canonical-event.mjs";
import { getEventName } from "../../lib/event-name.mjs"; // CTL-1834: moved out of broker/
import { isFlatEvent, isPinoRecord } from "../../otel-forward/lib/normalize.ts";

const parse = (line) => JSON.parse(line.trimEnd());

const det = {
  now: () => new Date("2026-08-13T10:00:00.000Z"),
  newId: () => "id00",
  newTrace: () => "trace0",
  newSpan: () => "span0",
};

// A representative live v1 line: the single most common v1 event name in 2026-08
// (138,425 of 159,009 measured v1 events on mini).
const LIVE_V1 = Object.freeze({
  ts: "2026-08-13T09:59:58Z",
  event: "phase.terminal.reap-requested",
  ticket: "CTL-1795",
  phase: "implement",
  bg_job_id: "abc12345",
  worktree_path: "/Users/ryan/catalyst/wt/x",
  reason: "terminal-signal",
});

describe("buildDualEnvelopeLine — the superset wire shape", () => {
  test("emits exactly ONE line, not two", () => {
    const out = buildDualEnvelopeLine(LIVE_V1, {}, det);
    expect(out.endsWith("\n")).toBe(true);
    expect(out.split("\n").filter((l) => l !== "")).toHaveLength(1);
  });

  test("carries BOTH top-level `event` and attributes['event.name'], and they AGREE", () => {
    const e = parse(buildDualEnvelopeLine(LIVE_V1, {}, det));
    expect(e.event).toBe("phase.terminal.reap-requested");
    expect(e.attributes["event.name"]).toBe("phase.terminal.reap-requested");
    // The anti-double-processing invariant: the v1-first extractor and an attributes-only
    // reader must resolve the SAME name from the SAME line.
    expect(getEventName(e)).toBe(e.attributes["event.name"]);
  });

  test("every v1 top-level field survives byte-identically", () => {
    const e = parse(buildDualEnvelopeLine(LIVE_V1, {}, det));
    for (const [k, v] of Object.entries(LIVE_V1)) expect(e[k]).toEqual(v);
  });

  test("attribute promotion matches otel-forward's normalizeFlatEvent ATTR_MAP", () => {
    const e = parse(buildDualEnvelopeLine(LIVE_V1, {}, det));
    // Mapped keys become first-class OTel attributes …
    expect(e.attributes["catalyst.worker.ticket"]).toBe("CTL-1795");
    expect(e.attributes["catalyst.worker.phase"]).toBe("implement");
    expect(e.attributes["catalyst.worker.bg_job_id"]).toBe("abc12345");
    // … and everything else lands in body.payload, so nothing is dropped.
    expect(e.body.payload).toEqual({
      worktree_path: "/Users/ryan/catalyst/wt/x",
      reason: "terminal-signal",
    });
    // `ts` and `event` are envelope fields, never payload.
    expect(e.body.payload.ts).toBeUndefined();
    expect(e.body.payload.event).toBeUndefined();
  });

  test("FLAT_ATTRIBUTE_MAP is exactly otel-forward's ATTR_MAP", () => {
    expect({ ...FLAT_ATTRIBUTE_MAP }).toEqual({
      ticket: "catalyst.worker.ticket",
      phase: "catalyst.worker.phase",
      bg_job_id: "catalyst.worker.bg_job_id",
      branch: "catalyst.worker.branch",
      orch_id: "catalyst.orchestrator.id",
      dominant_phase: "catalyst.worker.dominant_phase",
    });
  });

  test("one timestamp, not two — the canonical half adopts the v1 ts verbatim", () => {
    const e = parse(buildDualEnvelopeLine(LIVE_V1, {}, det));
    expect(e.ts).toBe(LIVE_V1.ts);
    expect(e.observedTs).toBe(LIVE_V1.ts);
  });

  test("body.message is non-empty, and the v2 half is otherwise complete", () => {
    const e = parse(buildDualEnvelopeLine(LIVE_V1, {}, det));
    expect(e.body.message).toBe("phase.terminal.reap-requested");
    expect(e.resource["service.name"]).toBe("catalyst.execution-core");
    expect(e.resource["service.namespace"]).toBe("catalyst");
    expect(e.severityText).toBe("INFO");
  });

  test("serviceName and severity are overridable", () => {
    const e = parse(
      buildDualEnvelopeLine(LIVE_V1, { serviceName: "catalyst.session", severityText: "WARN", severityNumber: 13 },
        det),
    );
    expect(e.resource["service.name"]).toBe("catalyst.session");
    expect(e.severityText).toBe("WARN");
    expect(e.severityNumber).toBe(13);
  });

  test("body.payload is omitted entirely when the v1 line carries no unmapped fields", () => {
    const e = parse(buildDualEnvelopeLine({ ts: "2026-08-13T10:00:00Z", event: "orphans.reap-requested" }, {}, det));
    expect("payload" in e.body).toBe(false);
    expect(e.body.message).toBe("orphans.reap-requested");
  });

  test("fails CLOSED on a nameless v1 line — that IS the degenerate record", () => {
    expect(() => buildDualEnvelopeLine({ ts: "x" }, {}, det)).toThrow(/event is required/);
    expect(() => buildDualEnvelopeLine({ ts: "x", event: "" }, {}, det)).toThrow(/event is required/);
    expect(() => buildDualEnvelopeLine({ ts: "x", event: 42 }, {}, det)).toThrow(/event is required/);
    expect(() => buildDualEnvelopeLine(undefined, {}, det)).toThrow(/event is required/);
  });

  test("fails CLOSED on an input that is ALREADY canonical — never double-wrap", () => {
    expect(() =>
      buildDualEnvelopeLine({ ts: "x", event: "e.v", attributes: { "event.name": "e.v" } }, {}, det),
    ).toThrow(/already canonical/);
  });
});

describe("the superset line against the shape discriminators that read the log", () => {
  test("otel-forward: NOT flat, NOT pino — so it forwards as already-canonical", () => {
    const e = parse(buildDualEnvelopeLine(LIVE_V1, {}, det));
    // isFlatEvent requires !("attributes" in o) (normalize.ts:20). If the superset line were
    // claimed by it, normalizeFlatEvent would REBUILD the envelope and discard the attributes
    // the producer just guaranteed.
    expect(isFlatEvent(e)).toBe(false);
    expect(isPinoRecord(e)).toBe(false);
  });

  test("otel-forward: survives processLine's no-attributes drop", () => {
    const e = parse(buildDualEnvelopeLine(LIVE_V1, {}, det));
    expect(Boolean(e.attributes)).toBe(true);
  });

  test("broker: getEventName is unchanged from the pure-v1 line", () => {
    const v1Only = { ...LIVE_V1 };
    const superset = parse(buildDualEnvelopeLine(LIVE_V1, {}, det));
    expect(getEventName(superset)).toBe(getEventName(v1Only));
  });
});

// The producers, exercised through their REAL emit adapter — the adapter is what has to
// change, so a test against the builder alone could never observe the wiring.
describe("every live JS v1 emit site now writes the superset line", () => {
  let dir;
  let priorCatalystDir;

  const readSoleEvent = () => {
    const now = new Date();
    const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const path = join(dir, "events", `${ym}.jsonl`);
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    // ONE line per emit — the two-line design would show up here as 2.
    expect(lines).toHaveLength(1);
    return parse(lines[0]);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ctl1795-"));
    mkdirSync(join(dir, "events"), { recursive: true });
    priorCatalystDir = process.env.CATALYST_DIR;
    process.env.CATALYST_DIR = dir;
  });

  afterEach(() => {
    if (priorCatalystDir === undefined) delete process.env.CATALYST_DIR;
    else process.env.CATALYST_DIR = priorCatalystDir;
    rmSync(dir, { recursive: true, force: true });
  });

  test("reap-intent.mjs emitReapIntent (the 138k/month producer)", async () => {
    const { emitReapIntent } = await import(`../reap-intent.mjs?cb=${Date.now()}-${Math.random()}`);
    const ok = await emitReapIntent("phase.terminal.reap-requested", {
      ticket: "CTL-1795",
      phase: "implement",
      bgJobId: "abc12345",
      reason: "terminal-signal",
    });
    expect(ok).toBe(true);

    const e = readSoleEvent();
    // v1 half — the reaper reads e.event / e.bg_job_id / e.reason directly (reaper.mjs:327,331).
    expect(e.event).toBe("phase.terminal.reap-requested");
    expect(e.ticket).toBe("CTL-1795");
    expect(e.bg_job_id).toBe("abc12345");
    expect(e.reason).toBe("terminal-signal");
    // v2 half — newly visible to an attributes-only reader.
    expect(e.attributes["event.name"]).toBe("phase.terminal.reap-requested");
    expect(e.attributes["catalyst.worker.ticket"]).toBe("CTL-1795");
    expect(e.attributes["catalyst.worker.bg_job_id"]).toBe("abc12345");
    expect(e.body.message).toBe("phase.terminal.reap-requested");
    expect(e.body.payload).toEqual({ reason: "terminal-signal" });
  });

  test("unstuck-sweep.mjs emitUnstuckEvent", async () => {
    const { emitUnstuckEvent } = await import(`../unstuck-sweep.mjs?cb=${Date.now()}-${Math.random()}`);
    const ok = await emitUnstuckEvent("unstuck.escalated", { ticket: "CTL-1795", category: "unknown" });
    expect(ok).toBe(true);

    const e = readSoleEvent();
    expect(e.event).toBe("unstuck.escalated");
    expect(e.ticket).toBe("CTL-1795");
    expect(e.attributes["event.name"]).toBe("unstuck.escalated");
    expect(e.attributes["catalyst.worker.ticket"]).toBe("CTL-1795");
    expect(e.body.payload).toEqual({ category: "unknown" });
  });

  test("reaper.mjs defaultEmit — the echo fallback for names OUTSIDE the closed vocabulary", async () => {
    // `pr.merged.cleanup-failed` is NOT in REAP_INTENT_TYPES (1,560 measured in 2026-08), so
    // emitReapIntent throws and defaultEmit falls through to its own direct append. That
    // fallback was a second, independent hand-rolled v1 envelope.
    const { defaultEmit } = await import(`../reaper.mjs?cb=${Date.now()}-${Math.random()}`);
    await defaultEmit("pr.merged.cleanup-failed", { ticket: "CTL-1795", reason: "worktree-dirty" });

    const e = readSoleEvent();
    expect(e.event).toBe("pr.merged.cleanup-failed");
    expect(e.ticket).toBe("CTL-1795");
    expect(e.reason).toBe("worktree-dirty");
    expect(e.attributes["event.name"]).toBe("pr.merged.cleanup-failed");
    expect(e.attributes["catalyst.worker.ticket"]).toBe("CTL-1795");
  });

  test("a builder failure degrades to the plain v1 line — an event is NEVER lost", async () => {
    // Emission is best-effort by contract (emitReapIntent returns false rather than throwing
    // on a write failure). Losing a *.reap-requested means a worker is never reaped, so the
    // dual-emit must degrade to v1 rather than drop. Exercised by feeding a flat record that
    // the superset builder rejects: `attributes` is a legal reap-intent field name.
    const { emitReapIntent } = await import(`../reap-intent.mjs?cb=${Date.now()}-${Math.random()}`);
    const ok = await emitReapIntent("orphans.reap-requested", { attributes: "not-a-canonical-block" });
    expect(ok).toBe(true);

    const e = readSoleEvent();
    expect(e.event).toBe("orphans.reap-requested");
  });
});
