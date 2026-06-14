// useFilter.test.ts — covers the pure filter helpers (buildHaystack,
// tokenize, matchesFilter) directly, plus a mirror test of the hook's
// pivot+DSL+substring composition.
//
// The hook itself is a thin useMemo wrapper around these helpers; bun's
// runner has no React-hook test helper, so the composition test re-runs
// the same pipeline inline. Any divergence is caught when useFilter.ts
// is edited without updating this mirror — the files are adjacent so the
// drift is obvious in review.

import { describe, test, expect } from "bun:test";
import type { CanonicalEvent } from "../../lib/canonical-event.ts";
import { buildHaystack, tokenize, matchesFilter } from "./useFilter.ts";

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
  const tokens = tokenize(filterText);
  if (tokens.length > 0) {
    result = result.filter((e) => matchesFilter(e, tokens));
  }
  return result;
}

const fixture: CanonicalEvent[] = [
  {
    ts: "2026-05-08T14:00:00Z", id: "00000000-0000-4000-8000-000000000001", severityText: "INFO", severityNumber: 9, traceId: "t1", spanId: null,
    resource: { "service.name": "catalyst.github", "service.namespace": "catalyst", "service.version": "8.2.0", "host.name": "test-host", "host.id": "0000000000000000" },
    attributes: {
      "event.name": "github.pr.merged",
      "vcs.pr.number": 342,
      "vcs.repository.name": "coalesce-labs/catalyst",
      "vcs.ref.name": "refs/heads/685",
      "catalyst.orchestrator.id": "orch-A",
      "catalyst.session.id": "sess_20260508T140000_abcd1234",
    },
    body: { message: "PR #342 merged", payload: { url: "https://github.com/coalesce-labs/catalyst/pull/342" } },
  },
  {
    ts: "2026-05-08T13:00:00Z", id: "00000000-0000-4000-8000-000000000002", severityText: "ERROR", severityNumber: 17, traceId: "t1", spanId: null,
    resource: { "service.name": "catalyst.github", "service.namespace": "catalyst", "service.version": "8.2.0", "host.name": "test-host", "host.id": "0000000000000000" },
    attributes: {
      "event.name": "github.workflow_run.completed",
      "vcs.pr.number": 343,
      "vcs.repository.name": "coalesce-labs/catalyst",
      "catalyst.orchestrator.id": "orch-A",
      "cicd.pipeline.run.conclusion": "failure",
    },
    body: { message: "CI failed", payload: {} },
  },
  {
    ts: "2026-05-08T12:00:00Z", id: "00000000-0000-4000-8000-000000000003", severityText: "INFO", severityNumber: 9, traceId: "t2", spanId: null,
    resource: { "service.name": "catalyst.linear", "service.namespace": "catalyst", "service.version": "8.2.0", "host.name": "test-host", "host.id": "0000000000000000" },
    attributes: {
      "event.name": "linear.issue.state_changed",
      "linear.issue.identifier": "ADV-292",
      "catalyst.orchestrator.id": "orch-B",
    },
    body: { message: "Issue moved", payload: {} },
  },
];

describe("tokenize", () => {
  test("empty string → empty tokens", () => {
    expect(tokenize("")).toEqual([]);
  });

  test("single token", () => {
    expect(tokenize("685")).toEqual(["685"]);
  });

  test("multiple tokens split on whitespace", () => {
    expect(tokenize("685 ci")).toEqual(["685", "ci"]);
  });

  test("collapses runs of whitespace, drops empties", () => {
    expect(tokenize("  685   ci  ")).toEqual(["685", "ci"]);
  });

  test("lowercases tokens", () => {
    expect(tokenize("MERGED Orch-A")).toEqual(["merged", "orch-a"]);
  });
});

describe("buildHaystack", () => {
  test("returns lowercase JSON serialization", () => {
    const h = buildHaystack(fixture[0]);
    expect(h).toContain("orch-a"); // lowercased "orch-A"
    expect(h).toContain("00000000-0000-4000-8000-000000000001");
    expect(h).toContain("coalesce-labs/catalyst"); // full owner/repo, not just suffix
  });

  test("returns identical reference on repeat call (WeakMap memoization)", () => {
    const first = buildHaystack(fixture[0]);
    const second = buildHaystack(fixture[0]);
    expect(second).toBe(first);
  });

  test("distinct events get distinct haystacks", () => {
    const a = buildHaystack(fixture[0]);
    const b = buildHaystack(fixture[1]);
    expect(a).not.toBe(b);
  });
});

describe("matchesFilter", () => {
  test("empty tokens → always matches", () => {
    expect(matchesFilter(fixture[0], [])).toBe(true);
  });

  test("single substring token (existing behavior)", () => {
    expect(matchesFilter(fixture[0], ["merged"])).toBe(true);
    expect(matchesFilter(fixture[1], ["merged"])).toBe(false);
  });

  test("AND across multiple tokens", () => {
    // both tokens present
    expect(matchesFilter(fixture[0], ["merged", "orch-a"])).toBe(true);
    // first present, second absent
    expect(matchesFilter(fixture[0], ["merged", "orch-b"])).toBe(false);
  });

  test("case-insensitive matching (via tokenize)", () => {
    // The public path lowercases at tokenize() time; matchesFilter itself
    // assumes pre-lowercased tokens to avoid double work per keystroke.
    expect(matchesFilter(fixture[0], tokenize("MERGED"))).toBe(true);
    expect(matchesFilter(fixture[0], tokenize("Orch-A"))).toBe(true);
  });

  // The acceptance-criteria coverage: fields that the v9.1.0 5-column row
  // haystack did NOT search.
  describe("CTL-367 acceptance: matches fields beyond the 5 rendered columns", () => {
    test("event.id (UUIDv4 prefix)", () => {
      expect(matchesFilter(fixture[0], ["00000000-0000-4000-8000-000000000001"])).toBe(true);
      // partial prefix also matches
      expect(matchesFilter(fixture[0], ["0000-4000-8000-000000000001"])).toBe(true);
    });

    test("full owner/repo form of vcs.repository.name", () => {
      // v9.1.0 formatRepo() stripped this to bare "catalyst"
      expect(matchesFilter(fixture[0], ["coalesce-labs/catalyst"])).toBe(true);
    });

    test("catalyst.session.id", () => {
      expect(matchesFilter(fixture[0], ["sess_20260508t140000_abcd1234"])).toBe(true);
    });

    test("catalyst.orchestrator.id on github events", () => {
      // formatSource only surfaced this for filter/orchestrator/comms events
      expect(matchesFilter(fixture[0], ["orch-a"])).toBe(true);
    });

    test("body.payload nested fields (url)", () => {
      expect(matchesFilter(fixture[0], ["pull/342"])).toBe(true);
    });

    test("vcs.ref.name like refs/heads/685", () => {
      expect(matchesFilter(fixture[0], ["refs/heads/685"])).toBe(true);
    });
  });
});

describe("useFilter pipeline (mirror)", () => {
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

  test("multi-token substring narrows further", () => {
    // "github" matches both github events; adding "failed" narrows to the CI failure row
    const out = applyPipeline(fixture, "github failed", null, null);
    expect(out).toHaveLength(1);
    expect(out[0]?.attributes["event.name"]).toBe("github.workflow_run.completed");
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
