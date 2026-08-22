// canonical-event.test.mjs — CTL-1817. The shared canonical ("v2") event-line builder, and
// the two producers that used to hand-roll the "v3" shape that otel-forward destroys.
// Run: cd plugins/dev/scripts/execution-core && bun test lib/canonical-event.test.mjs
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildCanonicalEventLine } from "./canonical-event.mjs";
// CTL-1216: resolve the event-log filename through the production leaf so this
// fixture follows the ACTIVE scheme. A pinned monthly name addresses a file the
// code under test never opens.
import { eventLogBasenameFor, resolveRotationScheme } from "../../lib/event-log-paths.mjs";

const parse = (line) => JSON.parse(line.trimEnd());

const det = {
  now: () => new Date("2026-08-13T10:00:00.000Z"),
  newId: () => "id00",
  newTrace: () => "trace0",
  newSpan: () => "span0",
};

describe("buildCanonicalEventLine — the two invariants that make a record survivable", () => {
  test("body.message is non-empty even with no payload and no attributes", () => {
    const e = parse(buildCanonicalEventLine({ name: "phase.rescue.escalated.CTL-1832" }, det));
    expect(e.body.message).toBe("phase.rescue.escalated.CTL-1832");
    expect(e.body.message).not.toBe("");
  });

  test("attributes always carry event.name", () => {
    const e = parse(buildCanonicalEventLine({ name: "phase.rescue.dispatched.CTL-1" }, det));
    expect(e.attributes["event.name"]).toBe("phase.rescue.dispatched.CTL-1");
  });

  test("a caller cannot displace event.name, and it stays first on the wire", () => {
    const e = parse(
      buildCanonicalEventLine({ name: "real.name", attributes: { "event.name": "spoofed" } }, det),
    );
    expect(e.attributes["event.name"]).toBe("real.name");
    expect(Object.keys(e.attributes)[0]).toBe("event.name");
  });

  test("caller attributes are merged alongside event.name", () => {
    const e = parse(
      buildCanonicalEventLine(
        { name: "phase.rescue.escalated.CTL-1832", attributes: { "linear.issue.identifier": "CTL-1832" } },
        det,
      ),
    );
    expect(e.attributes["linear.issue.identifier"]).toBe("CTL-1832");
  });

  test("payload lands under body.payload, and is omitted entirely when absent", () => {
    const withPayload = parse(buildCanonicalEventLine({ name: "e.v", payload: { ticket: "CTL-1" } }, det));
    expect(withPayload.body.payload).toEqual({ ticket: "CTL-1" });

    const without = parse(buildCanonicalEventLine({ name: "e.v" }, det));
    expect("payload" in without.body).toBe(false);

    const nulled = parse(buildCanonicalEventLine({ name: "e.v", payload: null }, det));
    expect("payload" in nulled.body).toBe(false);
  });

  test("the envelope is v2-shaped: resource + attributes + body, terminated with a newline", () => {
    const line = buildCanonicalEventLine({ name: "e.v" }, det);
    expect(line.endsWith("\n")).toBe(true);
    const e = parse(line);
    expect(e.resource["service.name"]).toBe("catalyst.execution-core");
    expect(e.resource["service.namespace"]).toBe("catalyst");
    expect(e.ts).toBe("2026-08-13T10:00:00Z");
    expect(e.observedTs).toBe(e.ts);
    expect(e.severityText).toBe("INFO");
    expect(e.severityNumber).toBe(9);
    // The discriminators the three-shape reader keys on: v2 has `attributes`, and must NOT
    // present the v1 `event` or v3 `name` top-level keys.
    expect(typeof e.attributes).toBe("object");
    expect("event" in e).toBe(false);
    expect("name" in e).toBe(false);
  });

  test("serviceName and severity are overridable", () => {
    const e = parse(
      buildCanonicalEventLine(
        { name: "e.v", serviceName: "catalyst.broker", severityText: "WARN", severityNumber: 13 },
        det,
      ),
    );
    expect(e.resource["service.name"]).toBe("catalyst.broker");
    expect(e.severityText).toBe("WARN");
    expect(e.severityNumber).toBe(13);
  });

  test("fails CLOSED on a missing name — a nameless event is the degenerate record itself", () => {
    expect(() => buildCanonicalEventLine({}, det)).toThrow(/name is required/);
    expect(() => buildCanonicalEventLine({ name: "" }, det)).toThrow(/name is required/);
    expect(() => buildCanonicalEventLine({ name: 42 }, det)).toThrow(/name is required/);
    expect(() => buildCanonicalEventLine(undefined, det)).toThrow(/name is required/);
  });
});

// The producers, exercised through their REAL emit adapter (not the injected test seam) —
// the adapter is what regressed, so the injected seam could never have caught it.
describe("the two former v3 producers now emit canonical envelopes", () => {
  let dir;
  let priorCatalystDir;

  const readSoleEvent = () => {
    const now = new Date();
    const ym = eventLogBasenameFor(now, resolveRotationScheme({ env: process.env })).replace(/\.jsonl$/, "");
    const path = join(dir, "events", `${ym}.jsonl`);
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    return parse(lines[0]);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ctl1817-"));
    mkdirSync(join(dir, "events"), { recursive: true });
    priorCatalystDir = process.env.CATALYST_DIR;
    process.env.CATALYST_DIR = dir;
  });

  afterEach(() => {
    if (priorCatalystDir === undefined) delete process.env.CATALYST_DIR;
    else process.env.CATALYST_DIR = priorCatalystDir;
    rmSync(dir, { recursive: true, force: true });
  });

  test("stale-pr-rescue: an escalation carries its ticket as an attribute", async () => {
    const { defaultEmit } = await import("../stale-pr-rescue-timer.mjs");
    defaultEmit("phase.rescue.escalated.CTL-1832", { ticket: "CTL-1832", reason: "rescue_worker_stalled" });

    const e = readSoleEvent();
    expect(e.attributes["event.name"]).toBe("phase.rescue.escalated.CTL-1832");
    expect(e.attributes["linear.issue.identifier"]).toBe("CTL-1832");
    expect(e.body.message).toBe("phase.rescue.escalated.CTL-1832");
    expect(e.body.payload).toEqual({ ticket: "CTL-1832", reason: "rescue_worker_stalled" });
    expect("name" in e).toBe(false); // the v3 discriminator is gone
  });

  test("orphan-pr-sweep: a detection carries its PR number as an attribute", async () => {
    const { defaultEmit } = await import("../orphan-pr-sweep-timer.mjs");
    defaultEmit("phase.orphan-pr.detected.3324", {
      repo: "coalesce-labs/catalyst",
      number: 3324,
      url: "https://github.com/coalesce-labs/catalyst/pull/3324",
      mergeStateStatus: "BEHIND",
    });

    const e = readSoleEvent();
    expect(e.attributes["event.name"]).toBe("phase.orphan-pr.detected.3324");
    expect(e.attributes["vcs.pr.number"]).toBe(3324);
    expect(e.attributes["vcs.repository.name"]).toBe("coalesce-labs/catalyst");
    expect(e.body.message).toBe("phase.orphan-pr.detected.3324");
    expect("name" in e).toBe(false);
  });

  test("emit stays best-effort — a nameless event is swallowed, never thrown at the tick", async () => {
    const { defaultEmit } = await import("../stale-pr-rescue-timer.mjs");
    expect(() => defaultEmit("", { ticket: "CTL-1" })).not.toThrow();
  });
});
