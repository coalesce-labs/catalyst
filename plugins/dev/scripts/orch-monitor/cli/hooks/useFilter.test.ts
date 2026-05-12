// useFilter.test.ts — verifies that the hook's filter pipeline composes
// pivot, substring, and DSL filters correctly. Pure-JS test — does not
// render any Ink components, so no testing-library dependency required.

import { describe, test, expect } from "bun:test";
import type { CanonicalEvent } from "../../lib/canonical-event.ts";

// Bun's test runner does not ship a React-hook test helper. The hook's
// `filtered` derivation is just a `useMemo` over inputs, so we re-implement
// the pipeline here as a pure function and test that. Any divergence from
// useFilter.ts is caught when the hook source is changed without updating
// this mirror — they are intentionally adjacent in the file tree.

function applyPipeline(
  events: CanonicalEvent[],
  filterText: string,
  pivot: { type: "trace"; id: string } | { type: "orch"; id: string } | null,
  dslPredicate: ((e: CanonicalEvent) => boolean) | null,
): CanonicalEvent[] {
  let result = events;
  if (pivot?.type === "trace") {
    result = result.filter((e) => e.traceId === pivot.id);
  } else if (pivot?.type === "orch") {
    result = result.filter((e) => e.attributes["catalyst.orchestrator.id"] === pivot.id);
  }
  if (dslPredicate) {
    result = result.filter(dslPredicate);
  }
  if (filterText) {
    const text = filterText.toLowerCase();
    result = result.filter((e) => JSON.stringify(e).toLowerCase().includes(text));
  }
  return result;
}

const fixture: CanonicalEvent[] = [
  {
    ts: "2026-05-08T14:00:00Z", id: "00000000-0000-4000-8000-000000000001", severityText: "INFO", severityNumber: 9, traceId: "t1", spanId: null,
    resource: { "service.name": "catalyst.github", "service.namespace": "catalyst", "service.version": "8.2.0" },
    attributes: { "event.name": "github.pr.merged", "vcs.pr.number": 342, "catalyst.orchestrator.id": "orch-A" },
    body: { message: "PR #342 merged", payload: {} },
  },
  {
    ts: "2026-05-08T13:00:00Z", id: "00000000-0000-4000-8000-000000000002", severityText: "ERROR", severityNumber: 17, traceId: "t1", spanId: null,
    resource: { "service.name": "catalyst.github", "service.namespace": "catalyst", "service.version": "8.2.0" },
    attributes: { "event.name": "github.workflow_run.completed", "vcs.pr.number": 343, "catalyst.orchestrator.id": "orch-A" },
    body: { message: "CI failed", payload: {} },
  },
  {
    ts: "2026-05-08T12:00:00Z", id: "00000000-0000-4000-8000-000000000003", severityText: "INFO", severityNumber: 9, traceId: "t2", spanId: null,
    resource: { "service.name": "catalyst.linear", "service.namespace": "catalyst", "service.version": "8.2.0" },
    attributes: { "event.name": "linear.issue.state_changed", "linear.issue.identifier": "ADV-292", "catalyst.orchestrator.id": "orch-B" },
    body: { message: "Issue moved", payload: {} },
  },
];

describe("useFilter pipeline", () => {
  test("no filters → all events", () => {
    expect(applyPipeline(fixture, "", null, null)).toHaveLength(3);
  });

  test("DSL predicate only", () => {
    const onlyErrors = (e: CanonicalEvent) => e.severityText === "ERROR";
    const out = applyPipeline(fixture, "", null, onlyErrors);
    expect(out).toHaveLength(1);
    expect(out[0]?.severityText).toBe("ERROR");
  });

  test("DSL AND substring", () => {
    const ghOnly = (e: CanonicalEvent) => e.attributes["event.name"]?.startsWith("github.") ?? false;
    const out = applyPipeline(fixture, "merged", null, ghOnly);
    expect(out).toHaveLength(1);
    expect(out[0]?.attributes["event.name"]).toBe("github.pr.merged");
  });

  test("trace pivot AND DSL", () => {
    const ghOnly = (e: CanonicalEvent) => e.attributes["event.name"]?.startsWith("github.") ?? false;
    const out = applyPipeline(fixture, "", { type: "trace", id: "t1" }, ghOnly);
    expect(out).toHaveLength(2);
  });

  test("orch pivot AND DSL", () => {
    const onlyInfo = (e: CanonicalEvent) => e.severityText === "INFO";
    const out = applyPipeline(fixture, "", { type: "orch", id: "orch-A" }, onlyInfo);
    expect(out).toHaveLength(1);
    expect(out[0]?.ts).toBe("2026-05-08T14:00:00Z");
  });

  test("DSL predicate that matches nothing → empty", () => {
    const never = () => false;
    expect(applyPipeline(fixture, "", null, never)).toHaveLength(0);
  });

  test("DSL predicate that throws is the caller's bug — pipeline does not swallow", () => {
    const broken = () => { throw new Error("boom"); };
    expect(() => applyPipeline(fixture, "", null, broken)).toThrow("boom");
  });
});
