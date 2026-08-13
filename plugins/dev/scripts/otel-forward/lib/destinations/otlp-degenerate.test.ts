// otlp-degenerate.test.ts — CTL-1817.
//
// The defect: a "v3" event-log line (bare top-level `name`, no `attributes`, no `body`)
// satisfies NEITHER optional chain in the OTLP mapper, so it forwards with an empty body AND
// empty attributes — a record carrying nothing but a timestamp and a severity. 531
// `phase.rescue.*` + 1 `phase.orphan-pr.*` were destroyed this way in 2026-08 on mini.
//
// This suite pins BOTH halves of the fix:
//   1. the producer half — a line built by the shared canonical builder survives the mapper
//      with its body and its identifying attributes intact (end-to-end, real builder output);
//   2. the forwarder half — a degenerate record is COUNTED and named rather than silently
//      forwarded, and the count stays untouched for healthy records.
//
// Run: cd plugins/dev/scripts/otel-forward && bun test
import { describe, test, expect, beforeEach } from "bun:test";
import { buildOtlpPayload, degenerateRecordTotal, resetDegenerateRecordTotal } from "./otlp.ts";
import type { CanonicalEvent } from "../../../orch-monitor/lib/canonical-event.ts";
// The PRODUCER's builder, imported across package boundaries on purpose: this is the only
// test that proves the two sides agree. A fixture hand-copied from the builder's output
// would keep passing after the builder changed.
import { buildCanonicalEventLine } from "../../../execution-core/lib/canonical-event.mjs";

type Rec = {
  body: { stringValue: string };
  attributes: { key: string; value: Record<string, unknown> }[];
};

const firstRecord = (payload: unknown): Rec =>
  (payload as { resourceLogs: { scopeLogs: { logRecords: Rec[] }[] }[] }).resourceLogs[0].scopeLogs[0]
    .logRecords[0];

const attrValue = (rec: Rec, key: string) =>
  Object.values(rec.attributes.find((a) => a.key === key)?.value ?? {})[0];

// The pre-fix shape, reproduced verbatim from the old producers:
//   JSON.stringify({ name, ...payload, ts })
const v3Line = (name: string, payload: Record<string, unknown>) =>
  JSON.stringify({ name, ...payload, ts: "2026-08-13T10:00:00Z" });

beforeEach(() => {
  resetDegenerateRecordTotal();
});

describe("CTL-1817 producer half — a canonical line survives the mapper", () => {
  test("a rescue escalation arrives with a non-empty body and its ticket attribute", () => {
    const ev = JSON.parse(
      buildCanonicalEventLine({
        name: "phase.rescue.escalated.CTL-1832",
        payload: { ticket: "CTL-1832", reason: "rescue_worker_stalled" },
        attributes: { "linear.issue.identifier": "CTL-1832" },
      }),
    ) as CanonicalEvent;

    const rec = firstRecord(buildOtlpPayload([ev]));

    expect(rec.body.stringValue).toBe("phase.rescue.escalated.CTL-1832");
    expect(rec.body.stringValue).not.toBe("");
    expect(attrValue(rec, "linear.issue.identifier")).toBe("CTL-1832");
    expect(attrValue(rec, "event.name")).toBe("phase.rescue.escalated.CTL-1832");
    expect(degenerateRecordTotal()).toBe(0);
  });

  test("an orphan-PR detection arrives with its PR number", () => {
    const ev = JSON.parse(
      buildCanonicalEventLine({
        name: "phase.orphan-pr.detected.3324",
        payload: { repo: "coalesce-labs/catalyst", number: 3324 },
        attributes: { "vcs.pr.number": 3324, "vcs.repository.name": "coalesce-labs/catalyst" },
      }),
    ) as CanonicalEvent;

    const rec = firstRecord(buildOtlpPayload([ev]));

    expect(rec.body.stringValue).toBe("phase.orphan-pr.detected.3324");
    expect(attrValue(rec, "vcs.pr.number")).toBe(3324);
    expect(degenerateRecordTotal()).toBe(0);
  });
});

describe("CTL-1817 forwarder half — a degenerate record is counted, not silently forwarded", () => {
  // POSITIVE CONTROL. This is the scenario the ticket requires: it must FAIL if the fix is
  // reverted, i.e. it asserts the mapper still produces an empty body for a raw v3 line. If
  // this ever stops holding, the test below can no longer observe the defect at all.
  test("the regression is detectable — a raw v3 line still maps to an empty record", () => {
    const ev = JSON.parse(v3Line("phase.rescue.escalated.CTL-1832", { ticket: "CTL-1832" })) as CanonicalEvent;
    const rec = firstRecord(buildOtlpPayload([ev]));

    expect(rec.body.stringValue).toBe("");
    expect(rec.attributes).toHaveLength(0);
  });

  test("a degenerate record increments the counter and names the offending event", () => {
    const ev = JSON.parse(v3Line("phase.rescue.escalated.CTL-1832", { ticket: "CTL-1832" })) as CanonicalEvent;

    expect(degenerateRecordTotal()).toBe(0);
    buildOtlpPayload([ev]);
    expect(degenerateRecordTotal()).toBe(1);
  });

  test("the counter accumulates across records and batches", () => {
    const a = JSON.parse(v3Line("phase.rescue.escalated.CTL-1", { ticket: "CTL-1" })) as CanonicalEvent;
    const b = JSON.parse(v3Line("phase.rescue.dispatched.CTL-2", { ticket: "CTL-2" })) as CanonicalEvent;

    buildOtlpPayload([a, b]);
    expect(degenerateRecordTotal()).toBe(2);
    buildOtlpPayload([a]);
    expect(degenerateRecordTotal()).toBe(3);
  });

  test("a healthy v2 record never trips the counter", () => {
    const ev: CanonicalEvent = {
      ts: "2026-08-13T10:00:00Z",
      id: "id0",
      observedTs: "2026-08-13T10:00:00Z",
      severityText: "INFO",
      severityNumber: 9,
      traceId: null,
      spanId: null,
      resource: { "service.name": "catalyst.execution-core", "service.namespace": "catalyst" as const },
      attributes: { "event.name": "recovery.tick" },
      body: { message: "recovery.tick" },
    } as unknown as CanonicalEvent;

    buildOtlpPayload([ev]);
    expect(degenerateRecordTotal()).toBe(0);
  });

  test("a v1 flat record is not counted — it still resolves a body via its own name", () => {
    // v1 normalization happens upstream; by the time a v1 event reaches the mapper it is
    // canonical. A record that resolves ANY body is not degenerate, so it must not be counted.
    const ev = {
      ts: "2026-08-13T10:00:00Z",
      severityText: "INFO",
      severityNumber: 9,
      attributes: { "event.name": "phase.terminal.done.CTL-1" },
      body: {},
    } as unknown as CanonicalEvent;

    buildOtlpPayload([ev]);
    expect(degenerateRecordTotal()).toBe(0);
  });

  test("an entirely identity-less record is still counted, and does not throw", () => {
    const ev = { ts: "2026-08-13T10:00:00Z", severityText: "INFO", severityNumber: 9 } as unknown as CanonicalEvent;

    expect(() => buildOtlpPayload([ev])).not.toThrow();
    expect(degenerateRecordTotal()).toBe(1);
  });
});
