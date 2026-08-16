// linear-feed-diff.test.mjs — CTL-1847.
//
// Run: cd plugins/dev/scripts/execution-core && bun test linear-feed-diff.test.mjs

import { describe, expect, test } from "bun:test";
import { TRACKED_FIELDS, diffSnapshots, diffToHistoryRow, snapshotOf } from "./linear-feed-diff.mjs";
import { buildIssueEvent, edgeDelta, edgeEventName } from "./linear-feed-event.mjs";
import { parseIssueUpdatedEvent, parseStateChangedEvent } from "./monitor.mjs";

const SEAMS = { now: () => new Date("2026-08-16T00:00:00.000Z"), newId: () => "i", newTrace: () => "t", newSpan: () => "s" };

const issue = (over = {}) => ({
  id: "i1",
  identifier: "CTL-1",
  team_key: "CTL",
  state: "Todo",
  assignee_id: null,
  priority: null,
  estimate: null,
  project_id: null,
  cycle_id: null,
  parent_id: null,
  team_id: "t1",
  title: "a ticket",
  due_date: null,
  delegate_id: null,
  description: "body",
  updated_at: 1_000,
  ...over,
});

describe("snapshotOf", () => {
  test("captures every tracked field", () => {
    const s = snapshotOf(issue(), ["worker:mini"]);
    for (const f of TRACKED_FIELDS) expect(s).toHaveProperty(f.key);
    expect(s.labels).toEqual(["worker:mini"]);
  });

  test("labels are SORTED, so reordering is not a false edge", () => {
    const a = snapshotOf(issue(), ["b", "a"]);
    const b = snapshotOf(issue(), ["a", "b"]);
    expect(diffSnapshots(a, b)).toBeNull();
  });

  test("description is stored as a LENGTH, not the body", () => {
    // The envelope only reports descriptionChanged as a boolean; keeping every
    // issue's full text in the baseline would bloat the store for data the envelope
    // discards. Documented tradeoff: a same-length edit is a miss.
    const s = snapshotOf(issue({ description: "hello" }));
    expect(s.description).toBe(5);
    const same = snapshotOf(issue({ description: "world" })); // same length
    expect(diffSnapshots(s, same)).toBeNull(); // the accepted miss, asserted
  });

  test("NULL and empty string do not differ", () => {
    expect(diffSnapshots(snapshotOf(issue({ assignee_id: null })), snapshotOf(issue({ assignee_id: "" })))).toBeNull();
  });

  test("junk in yields null, not a half snapshot", () => {
    for (const bad of [null, undefined, 42, "row"]) expect(snapshotOf(bad)).toBeNull();
  });
});

describe("diffSnapshots", () => {
  test("an unchanged row produces NO edge — mirror rewrites are not events", () => {
    // `issues.updated_at` moves whenever the mirror rewrites a row, with no field we
    // track differing. Emitting for that would be pure noise in the parity diff.
    expect(diffSnapshots(snapshotOf(issue()), snapshotOf(issue()))).toBeNull();
  });

  test("a state change is a state edge", () => {
    const d = diffSnapshots(snapshotOf(issue({ state: "Backlog" })), snapshotOf(issue({ state: "Todo" })));
    expect(d.isStateEdge).toBe(true);
    expect(d.fromState).toBe("Backlog");
    expect(d.toState).toBe("Todo");
    expect(d.updatedFromKeys).toContain("state");
  });

  test("a non-state change is NOT a state edge", () => {
    const d = diffSnapshots(snapshotOf(issue({ priority: 1 })), snapshotOf(issue({ priority: 2 })));
    expect(d.isStateEdge).toBe(false);
    expect(d.updatedFromKeys).toEqual(["priority"]);
    expect(d.previousFromValues.priority).toBe(1);
  });

  test("⭐ several fields moving at once are ALL reported", () => {
    // The webhook collapses this to ONE topic via a first-match ladder; the diff
    // reports every field. That asymmetry is expected and pre-documented.
    const d = diffSnapshots(
      snapshotOf(issue({ state: "Backlog", priority: 1, assignee_id: null })),
      snapshotOf(issue({ state: "Todo", priority: 2, assignee_id: "u2" })),
    );
    expect(d.updatedFromKeys).toEqual(expect.arrayContaining(["state", "priority", "assigneeId"]));
  });

  test("label add and remove are edges", () => {
    expect(diffSnapshots(snapshotOf(issue(), []), snapshotOf(issue(), ["x"])).updatedFromKeys).toContain("labels");
    expect(diffSnapshots(snapshotOf(issue(), ["x"]), snapshotOf(issue(), [])).updatedFromKeys).toContain("labels");
  });

  test("⭐ NET-EDGE COLLAPSE is a stated property, not a surprise", () => {
    // Backlog → Todo → Implement inside one tick is observed ONCE, as
    // Backlog → Implement. Acceptable because dispatch keys on the eligible
    // projection of NET state — but it genuinely differs from the webhook stream,
    // which sees each hop, so the harness must expect it.
    const before = snapshotOf(issue({ state: "Backlog" }));
    const after = snapshotOf(issue({ state: "Implement" })); // Todo never observed
    const d = diffSnapshots(before, after);
    expect(d.fromState).toBe("Backlog");
    expect(d.toState).toBe("Implement");
    expect(d.updatedFromKeys).toEqual(["state"]);
  });

  test("no baseline reports every field — which is why cold start SEEDS instead of emitting", () => {
    // diffSnapshots(null, x) is correct for a genuinely new issue. It is also why a
    // cold start must seed the baseline silently: otherwise the first tick invents an
    // edge for all ~4,000 replica issues.
    const d = diffSnapshots(null, snapshotOf(issue()));
    expect(d.updatedFromKeys.length).toBeGreaterThan(1);
    expect(d.fromState).toBeNull();
  });
});

describe("⭐ PARITY: a diff-derived edge builds the SAME envelope as a replicated one", () => {
  // This is what makes the harness comparison valid. If the two edge sources
  // produced different envelopes, every diff would be a shape difference and the
  // window would measure nothing.
  const buildFromDiff = (before, after, labels = []) => {
    const d = diffSnapshots(snapshotOf(before), snapshotOf(after, labels));
    const row = diffToHistoryRow(after, d);
    return buildIssueEvent({ history: row, issue: after, labels }, SEAMS);
  };

  test("a state edge parses through monitor.mjs's REAL parser", () => {
    const ev = buildFromDiff(issue({ state: "Backlog" }), issue({ state: "Todo" }), ["worker:mini"]);
    const parsed = parseStateChangedEvent(ev);
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({ identifier: "CTL-1", teamKey: "CTL", toState: "Todo", toLabels: ["worker:mini"] });
  });

  test("a non-state edge parses as issue.updated, not as the trigger", () => {
    const ev = buildFromDiff(issue({ priority: 1 }), issue({ priority: 2 }));
    expect(parseIssueUpdatedEvent(ev)).not.toBeNull();
    expect(parseStateChangedEvent(ev)).toBeNull();
  });

  test("⭐ the synthetic row is COMPLETE — every changed field survives into the envelope", () => {
    // A partial synthetic row would report only `state` and silently drop the rest;
    // the envelope would then disagree with the diff that produced it.
    const ev = buildFromDiff(
      issue({ state: "Backlog", priority: 1, estimate: 1, title: "old" }),
      issue({ state: "Todo", priority: 2, estimate: 5, title: "new" }),
    );
    const keys = ev.body.payload.updatedFromKeys;
    expect(keys).toEqual(expect.arrayContaining(["state", "priority", "estimate", "title"]));
  });

  test("an unchanged field does NOT appear in the envelope's changed set", () => {
    const ev = buildFromDiff(issue({ priority: 1, title: "same" }), issue({ priority: 2, title: "same" }));
    expect(ev.body.payload.updatedFromKeys).toEqual(["priority"]);
  });

  test("edgeDelta over the synthetic row agrees with the diff that made it", () => {
    const d = diffSnapshots(snapshotOf(issue({ state: "Backlog", estimate: 1 })), snapshotOf(issue({ state: "Todo", estimate: 5 })));
    const row = diffToHistoryRow(issue({ state: "Todo", estimate: 5 }), d);
    const viaRow = edgeDelta(row).updatedFromKeys.sort();
    expect(viaRow).toEqual([...d.updatedFromKeys].sort());
  });

  test("the synthetic row names its source, so a diff edge is never mistaken for a replicated one", () => {
    const d = diffSnapshots(snapshotOf(issue({ state: "Backlog" })), snapshotOf(issue({ state: "Todo" })));
    expect(diffToHistoryRow(issue({ state: "Todo" }), d).id).toStartWith("diff:");
  });

  test("actor is NULL rather than guessed — issues carries no actor column", () => {
    const d = diffSnapshots(snapshotOf(issue({ state: "Backlog" })), snapshotOf(issue({ state: "Todo" })));
    expect(diffToHistoryRow(issue({ state: "Todo" }), d).actor_id).toBeNull();
  });

  test("edgeEventName agrees with isStateEdge on both paths", () => {
    const state = diffSnapshots(snapshotOf(issue({ state: "Backlog" })), snapshotOf(issue({ state: "Todo" })));
    const other = diffSnapshots(snapshotOf(issue({ priority: 1 })), snapshotOf(issue({ priority: 2 })));
    expect(edgeEventName(diffToHistoryRow(issue({ state: "Todo" }), state))).toBe("linear.issue.state_changed");
    expect(edgeEventName(diffToHistoryRow(issue({ priority: 2 }), other))).toBe("linear.issue.updated");
  });

  test("diffToHistoryRow refuses junk rather than emitting a malformed row", () => {
    expect(diffToHistoryRow(null, { updatedFromKeys: ["state"] })).toBeNull();
    expect(diffToHistoryRow(issue(), null)).toBeNull();
  });
});
