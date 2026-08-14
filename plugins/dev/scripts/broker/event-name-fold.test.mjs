// event-name-fold.test.mjs — CTL-1834 per-call-site coverage for the BROKER half.
//
// Run: cd plugins/dev/scripts/broker && bun test event-name-fold.test.mjs
//
// Separate from lib/event-name.test.mjs for the same reason as the execution-core
// twin: a boundary test proves the boundary reads three keys, not that a given
// site calls it. Separate from the execution-core file because these modules need
// the BROKER package's own node_modules (pino, bun:sqlite) — the exact constraint
// documented on the "Broker tests" step in execution-core-tests.yml.
//
// Two folded sites here, both of which used to spell their own ladder:
//   • broker/router.mjs   summarizeEvent      — an inline `event.event ?? attrs[...]`
//                                                in the very file that imports
//                                                getEventName one screen above.
//   • broker/projection.mjs localEventName    — a BYTE-IDENTICAL copy of the old
//                                                boundary, so it inherited the
//                                                same v3 blind spot. Deleted.
//
// Fixtures are hand-built. No test here reads ~/catalyst/events/*.jsonl.

import { describe, test, expect } from "bun:test";
import { summarizeEvent } from "./router.mjs";
import { reduceWorkerStateEvent } from "./projection.mjs";

describe("router.mjs summarizeEvent resolves through the boundary (CTL-1834)", () => {
  test("a v3-shaped line is NAMED, not summarized as an anonymous ''", () => {
    const s = summarizeEvent({
      ts: "2026-08-07T04:12:03.221Z",
      name: "phase.rescue.escalated.CTC-310",
    });
    expect(s.name).toBe("phase.rescue.escalated.CTC-310");
  });

  test("positive control: v1 and v2 still resolve, dual resolves once", () => {
    expect(summarizeEvent({ ts: "t", event: "phase.terminal.reap-requested" }).name).toBe(
      "phase.terminal.reap-requested",
    );
    expect(
      summarizeEvent({ ts: "t", attributes: { "event.name": "github.pr.merged" } }).name,
    ).toBe("github.pr.merged");
    expect(
      summarizeEvent({
        ts: "t",
        event: "worktree.cleanup-deferred",
        attributes: { "event.name": "worktree.cleanup-deferred" },
      }).name,
    ).toBe("worktree.cleanup-deferred");
  });

  test("a nameless line still summarizes to '' rather than throwing", () => {
    expect(summarizeEvent({ ts: "t" }).name).toBe("");
  });
});

describe("projection.mjs folds v3 lines (CTL-1834)", () => {
  // localEventName was a byte-identical copy of the two-key boundary, so the
  // worker-state projection silently dropped every v3-shaped phase terminal.
  test("a v3-shaped phase terminal folds to a worker-state row", () => {
    const row = reduceWorkerStateEvent({
      ts: "2026-08-07T00:00:00.000Z",
      name: "phase.implement.complete.CTL-9",
      orchestrator: "orch-1",
      detail: { ticket: "CTL-9" },
    });
    expect(row).not.toBeNull();
    expect(row.ticket).toBe("CTL-9");
    expect(row.kind).toBe("phase");
    expect(row.patch.phase).toBe("implement");
  });

  test("positive control: the same terminal in v1 and v2 folds identically", () => {
    const base = { ts: "2026-08-07T00:00:00.000Z", orchestrator: "orch-1" };
    const v1 = reduceWorkerStateEvent({
      ...base,
      event: "phase.implement.complete.CTL-9",
      detail: { ticket: "CTL-9" },
    });
    const v2 = reduceWorkerStateEvent({
      ...base,
      attributes: { "event.name": "phase.implement.complete.CTL-9" },
      body: { payload: { ticket: "CTL-9" } },
    });
    expect(v1).not.toBeNull();
    expect(v2).not.toBeNull();
    expect(v1.ticket).toBe("CTL-9");
    expect(v2.ticket).toBe("CTL-9");
    expect(v1.patch).toEqual(v2.patch);
  });

  test("a nameless / non-object event is still rejected", () => {
    expect(reduceWorkerStateEvent({ ts: "t" })).toBeNull();
    expect(reduceWorkerStateEvent(null)).toBeNull();
    expect(reduceWorkerStateEvent("not an object")).toBeNull();
  });

  test("localEventName is GONE — nothing exports a second name reader", async () => {
    // Fails closed if someone re-adds a local copy: the whole point of the fold
    // is that this module has no name reader of its own.
    const mod = await import("./projection.mjs");
    expect(Object.keys(mod)).not.toContain("localEventName");
  });
});
