// event-name.test.mjs — CTL-1834. The shared event-name boundary.
//
// Run: cd plugins/dev/scripts/lib && bun test event-name.test.mjs
//
// THE MANDATED POSITIVE CONTROL is the first describe block. It is written as a
// DIFFERENTIAL against a literal copy of the pre-fix two-key reader, not as a
// bare "getEventName reads a v3 line" assertion, because the two assertions are
// CONTRADICTORY on a degenerate fixture and therefore validate each other:
//
//   • if the v3 fixture were malformed (no `name`, a typo'd key, an empty string)
//     the pre-fix assertion still passes but the new-reader assertion FAILS;
//   • if the fixture accidentally carried an `event` or `attributes` key, the
//     pre-fix assertion FAILS.
//
// Only a genuine v3-shaped line with a real name satisfies both. A test asserting
// only the second half would pass on any fixture the new code happens to read; one
// asserting only the first half would pass on `{}`.
//
// Fixtures are HAND-BUILT and committed. No test here may read
// ~/catalyst/events/*.jsonl — it is 2.1 GB and readFileSync throws on it
// (execution-core/event-log-read-guard.test.mjs enforces that on non-test files;
// this note is so nobody "improves" these tests by pointing them at the real log).

import { describe, test, expect } from "bun:test";
import { getEventName, EVENT_NAME_KEYS } from "./event-name.mjs";
import { countEventsByName } from "./verified-checks.mjs";

// ─── fixtures, one per measured on-disk shape ───────────────────────────────
// Values copied from the full-corpus census in the module header.

// v3: `phase.rescue.escalated.*` — 532 lines in 2026-08, produced by
// execution-core/stale-pr-rescue-timer.mjs before CTL-1817 fixed it. 100% of the
// v3 population is shape `--N`: no `event` key, no `attributes` at all.
const V3_LINE = Object.freeze({
  ts: "2026-08-07T04:12:03.221Z",
  name: "phase.rescue.escalated.CTC-310",
  ticket: "CTC-310",
  pr: 3104,
});

// v1: `phase.terminal.reap-requested` — 140,017 lines in 2026-08. NOT legacy
// residue; the single largest v1-only family on the log today.
const V1_LINE = Object.freeze({
  ts: "2026-08-12T18:00:00.000Z",
  event: "phase.terminal.reap-requested",
  ticket: "CTL-9",
  bg_job_id: "bg_abc",
});

// v2: the canonical OTel envelope, 93.7% of 2026-08.
const V2_LINE = Object.freeze({
  ts: "2026-08-12T18:00:01.000Z",
  attributes: { "event.name": "phase.implement.complete.CTL-9" },
  body: { payload: { ticket: "CTL-9" } },
  resource: { "service.name": "catalyst.phase-agent" },
});

// CTL-1795 dual superset: BOTH keys on ONE line. All 322 measured dual lines
// carry identical values in both keys.
const DUAL_LINE = Object.freeze({
  ts: "2026-08-13T09:00:00.000Z",
  event: "worktree.cleanup-deferred",
  attributes: { "event.name": "worktree.cleanup-deferred" },
});

describe("MANDATED POSITIVE CONTROL — the fixture discriminates (CTL-1834)", () => {
  // The PRE-FIX boundary, verbatim from broker/event-name.mjs:16 @ 3f60190c6.
  // A LITERAL COPY, deliberately NOT an import: its job is to prove the fixture
  // discriminates, so it must not track edits to the shipped implementation.
  const twoKeyReaderPreFix = (e) => e.event ?? e.attributes?.["event.name"] ?? "";

  test("the pre-fix two-key reader CANNOT see a v3 name; the boundary CAN", () => {
    // (a) fails if the fixture accidentally carries `event` or `attributes`.
    expect(twoKeyReaderPreFix(V3_LINE)).toBe("");
    // (b) fails if the fixture's `name` is absent, empty, or misspelled.
    expect(getEventName(V3_LINE)).toBe("phase.rescue.escalated.CTC-310");
  });

  test("the pre-fix reader and the boundary AGREE on v1, v2 and dual lines", () => {
    // The measured zero-delta claim: over 4,034,067 parsed lines the ONLY
    // behavioural difference is the 1,007 v3 lines asserted above.
    for (const line of [V1_LINE, V2_LINE, DUAL_LINE]) {
      expect(getEventName(line)).toBe(twoKeyReaderPreFix(line));
      expect(getEventName(line)).not.toBe("");
    }
  });
});

describe("getEventName — the three envelope shapes", () => {
  test("v1 — top-level `event`", () => {
    expect(getEventName(V1_LINE)).toBe("phase.terminal.reap-requested");
  });

  test("v2 — attributes['event.name']", () => {
    expect(getEventName(V2_LINE)).toBe("phase.implement.complete.CTL-9");
  });

  test("v3 — top-level `name`", () => {
    expect(getEventName(V3_LINE)).toBe("phase.rescue.escalated.CTC-310");
  });

  test("dual (CTL-1795 superset) resolves once, to the v1 key", () => {
    expect(getEventName(DUAL_LINE)).toBe("worktree.cleanup-deferred");
  });
});

describe("getEventName — precedence is `event` -> attributes -> name", () => {
  // Precedence is unobservable on real data (322/322 dual lines agree and
  // disagreement is not constructible on the dual write path), so it is pinned
  // here with SYNTHETIC disagreeing lines. If someone reorders the ladder these
  // fail — which is the point: reordering re-points the broker's routing read.
  test("v1 wins over v2", () => {
    expect(getEventName({ event: "v1", attributes: { "event.name": "v2" } })).toBe("v1");
  });
  test("v1 wins over v3", () => {
    expect(getEventName({ event: "v1", name: "v3" })).toBe("v1");
  });
  test("v2 wins over v3", () => {
    expect(getEventName({ attributes: { "event.name": "v2" }, name: "v3" })).toBe("v2");
  });
  test("all three present -> v1", () => {
    expect(getEventName({ event: "v1", attributes: { "event.name": "v2" }, name: "v3" })).toBe("v1");
  });
});

describe("getEventName — first NON-EMPTY string wins (not `??`)", () => {
  // `??` only falls through on null/undefined, so an empty v1 key would SHADOW a
  // real name. It also has to match the bash mirror in lib/canonical-event.sh,
  // whose `_canonical_event_name_of` already tests `[[ -n "$n" ]]` at each rung.
  test("empty v1 falls through to v2", () => {
    expect(getEventName({ event: "", attributes: { "event.name": "real" } })).toBe("real");
  });
  test("empty v1 and empty v2 fall through to v3", () => {
    expect(getEventName({ event: "", attributes: { "event.name": "" }, name: "real" })).toBe("real");
  });
  test("the 10 measured lines with attributes['event.name'] === '' resolve to ''", () => {
    // Well-formed v2 envelopes carrying an EMPTY name (service.name
    // catalyst.broker, orch-test-tripwire-CTL-1086). They must not become a
    // spurious name, and they must not throw.
    expect(getEventName({ ts: "2026-08-01T00:00:00Z", attributes: { "event.name": "" } })).toBe("");
  });
});

describe("getEventName — never throws, never returns a non-string", () => {
  // ARMOR, not repair: a non-string `event` key has never occurred across all
  // 4,034,067 measured lines. The guard exists so a future one degrades to a miss
  // instead of throwing inside `name.startsWith(...)` on the broker's hot path.
  const hostile = [
    null,
    undefined,
    "a string",
    42,
    [],
    {},
    { event: 123 },
    { event: null },
    { event: {} },
    { attributes: null },
    { attributes: "not-an-object" },
    { attributes: { "event.name": 7 } },
    { name: 5 },
    { name: null },
    { event: 123, attributes: { "event.name": 7 }, name: 5 },
  ];
  for (const [i, input] of hostile.entries()) {
    test(`hostile input #${i} -> a string, no throw`, () => {
      let out;
      expect(() => {
        out = getEventName(input);
      }).not.toThrow();
      expect(typeof out).toBe("string");
    });
  }

  test("a non-string `event` falls through rather than shadowing a real name", () => {
    expect(getEventName({ event: 123, name: "real" })).toBe("real");
    expect(getEventName({ event: {}, attributes: { "event.name": "real" } })).toBe("real");
  });

  test("the pre-fix reader would have returned the non-string verbatim", () => {
    // Positive control for the paragraph above: this is what the old boundary did,
    // i.e. what `name.startsWith("filter.")` in router.mjs would have been handed.
    const twoKeyReaderPreFix = (e) => e.event ?? e.attributes?.["event.name"] ?? "";
    expect(twoKeyReaderPreFix({ event: 123, name: "real" })).toBe(123);
  });
});

describe("EVENT_NAME_KEYS is the declared ladder and matches the implementation", () => {
  test("exactly three keys, in ladder order", () => {
    expect([...EVENT_NAME_KEYS]).toEqual(["event", "attributes.event.name", "name"]);
    // Hard arity literal: a fourth key added to one side alone fails here.
    expect(EVENT_NAME_KEYS.length).toBe(3);
  });

  test("frozen (a consumer cannot mutate the shared ladder)", () => {
    expect(Object.isFrozen(EVENT_NAME_KEYS)).toBe(true);
  });

  test("every declared key actually resolves, and NOTHING outside the list does", () => {
    // Drives the implementation from the DECLARATION rather than re-typing the
    // three shapes: if a key is dropped from the implementation this fails, and if
    // the implementation grows a key not in the list the last assertion fails.
    const build = (path, value) => {
      const parts = path.split(".");
      if (parts.length === 1) return { [parts[0]]: value };
      // "attributes.event.name" -> { attributes: { "event.name": value } }
      return { [parts[0]]: { [parts.slice(1).join(".")]: value } };
    };
    for (const key of EVENT_NAME_KEYS) {
      expect(getEventName(build(key, `resolved-via-${key}`))).toBe(`resolved-via-${key}`);
    }
    for (const stray of ["eventName", "event_name", "type", "msg", "title"]) {
      expect(getEventName({ [stray]: "should-not-resolve" })).toBe("");
    }
  });
});

// ─── the fold: lib/verified-checks.mjs countEventsByName ─────────────────────
//
// This helper is the repo's OWN anti-false-clean instrument (AGENTS.md mandates
// it by name). It read only the v2 key, so a v1-only family came back as a
// CONCLUSIVE zero with its own positive control asserting it could look. Reverting
// the fold in verified-checks.mjs turns the first test below RED.
describe("countEventsByName counts v1 and v3 lines too (CTL-1834 fold)", () => {
  const mixed = [
    JSON.stringify(V2_LINE),
    JSON.stringify({ ...V1_LINE }),
    JSON.stringify({ ...V1_LINE, ts: "2026-08-12T18:00:02.000Z" }),
    JSON.stringify({ attributes: { "event.name": "github.pr.merged" } }),
    JSON.stringify({ name: "phase.terminal.reap-requested", ts: "2026-08-12T18:00:03.000Z" }),
  ];

  test("a v1-only family is COUNTED, not reported as a conclusive zero", async () => {
    const v = await countEventsByName("phase.terminal.reap-requested", { lines: mixed });
    expect(v.conclusive).toBe(true);
    // 2 v1-shaped + 1 v3-shaped. Pre-fix this returned 0 — conclusive, exit 0,
    // on a fixture where the event demonstrably appears three times.
    expect(v.value).toBe(3);
  });

  test("positive control: the v2 family it could always see still counts", async () => {
    const v = await countEventsByName("github.pr.merged", { lines: mixed });
    expect(v.conclusive).toBe(true);
    expect(v.value).toBe(1);
  });

  test("every line in the fixture now carries a resolvable name", async () => {
    const v = await countEventsByName("github.pr.merged", { lines: mixed });
    expect(v.evidence.parsedEvents).toBe(mixed.length);
  });

  test("a genuinely absent name is still a conclusive zero, not inconclusive", async () => {
    const v = await countEventsByName("linear.issue.state_changed", { lines: mixed });
    expect(v.conclusive).toBe(true);
    expect(v.value).toBe(0);
  });

  test("a corpus with NO resolvable names is INCONCLUSIVE, never a clean zero", async () => {
    const v = await countEventsByName("anything.at.all", {
      lines: [JSON.stringify({ ts: "x", level: 30, msg: "a pino line" })],
    });
    expect(v.conclusive).toBe(false);
  });
});
