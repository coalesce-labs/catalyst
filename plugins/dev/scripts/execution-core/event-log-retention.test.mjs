// event-log-retention.test.mjs — CTL-2189.
//
// ⛔ METHOD RULE OBSERVED THROUGHOUT: every "nothing was removed" claim is paired
// with a planted control proving the instrument CAN remove. A retention test that
// only ever asserts emptiness is indistinguishable from a retention job that is
// broken, which is the exact failure AC4 exists to catch.
//
//   cd plugins/dev/scripts/execution-core && bun test event-log-retention.test.mjs

import { describe, test, expect } from "bun:test";
import {
  COVERAGE_REQUIREMENTS,
  RETENTION_MARGIN_MS,
  DEFAULT_MIN_FREE_BYTES,
  assertRequirementsResolvable,
  maxCoverageRequirementMs,
  retentionWindowMs,
  parsePartition,
  planRetention,
  runRetention,
} from "./event-log-retention.mjs";

const DAY = 24 * 60 * 60_000;
// A fixed clock so a partition's inside/outside status is a property of the
// fixture, not of the day the suite happens to run.
const NOW = Date.UTC(2026, 7, 23, 4, 0, 0); // 2026-08-23T04:00:00Z

describe("CTL-2189 AC1 — the window is derived, not declared", () => {
  test("retention window = max(coverage requirement) + margin", () => {
    expect(retentionWindowMs()).toBe(maxCoverageRequirementMs() + RETENTION_MARGIN_MS);
  });

  test("every shipped requirement is attributed to the reader that holds it", () => {
    expect(COVERAGE_REQUIREMENTS.length).toBeGreaterThan(0);
    for (const r of COVERAGE_REQUIREMENTS) {
      expect(typeof r.reader).toBe("string");
      expect(r.reader.length).toBeGreaterThan(0);
      expect(typeof r.why).toBe("string");
      expect(r.why.length).toBeGreaterThan(0);
    }
  });

  test("a reader needing MORE history raises the window with it", () => {
    const base = retentionWindowMs();
    const hungrier = retentionWindowMs({
      requirements: [
        ...COVERAGE_REQUIREMENTS,
        { reader: "future", ms: maxCoverageRequirementMs() + 90 * DAY },
      ],
    });
    expect(hungrier).toBe(base + 90 * DAY);
  });

  test("a registered reader with no stated window THROWS — it is never treated as zero", () => {
    const withUnstated = [...COVERAGE_REQUIREMENTS, { reader: "not-yet-measured", ms: null }];
    expect(() => assertRequirementsResolvable(withUnstated)).toThrow(/not stated/);
    expect(() => retentionWindowMs({ requirements: withUnstated })).toThrow(/not-yet-measured/);
  });

  test("a negative or non-finite margin is refused rather than silently clamped", () => {
    expect(() => retentionWindowMs({ marginMs: -1 })).toThrow(/margin/);
    expect(() => retentionWindowMs({ marginMs: Number.NaN })).toThrow(/margin/);
  });
});

describe("partition layout", () => {
  test("monthly partitions bound the whole UTC month", () => {
    const p = parsePartition("2026-08.jsonl");
    expect(p.kind).toBe("month");
    expect(p.startMs).toBe(Date.UTC(2026, 7, 1));
    expect(p.endMs).toBe(Date.UTC(2026, 8, 1));
  });

  test("weekly partitions start on the ISO Monday and run seven days", () => {
    // ISO week 34 of 2026 begins Monday 2026-08-17.
    const p = parsePartition("2026-W34.jsonl");
    expect(p.kind).toBe("week");
    expect(new Date(p.startMs).toISOString()).toBe("2026-08-17T00:00:00.000Z");
    expect(p.endMs - p.startMs).toBe(7 * DAY);
  });

  test(".legacy partitions are recognized, not treated as foreign files", () => {
    const p = parsePartition("2026-05.jsonl.legacy");
    expect(p.kind).toBe("month");
    expect(p.legacy).toBe(true);
  });

  test("out-of-range and unknown names do not parse", () => {
    expect(parsePartition("2026-13.jsonl")).toBeNull();
    expect(parsePartition("2026-W54.jsonl")).toBeNull();
    expect(parsePartition("events.jsonl")).toBeNull();
    expect(parsePartition("2026-08.jsonl.gz")).toBeNull();
    expect(parsePartition("README.md")).toBeNull();
  });
});

describe("CTL-2189 AC3 — nothing still being read is deleted", () => {
  test("a partition whose END is inside the window survives, however old its START", () => {
    // A 31-day month whose first day is well outside the window but whose last
    // day is inside it. Comparing on startMs would delete this; comparing on
    // endMs keeps it. This is the case AC3 is actually about.
    const windowMs = 38 * DAY;
    const cutoff = NOW - windowMs; // 2026-07-16T04:00Z
    const july = parsePartition("2026-07.jsonl");
    expect(july.startMs).toBeLessThan(cutoff); // starts outside
    expect(july.endMs).toBeGreaterThan(cutoff); // ends inside

    const plan = planRetention({ names: ["2026-07.jsonl"], nowMs: NOW, windowMs });
    expect(plan.remove).toEqual([]);
    expect(plan.keep.map((p) => p.name)).toEqual(["2026-07.jsonl"]);
  });

  test("the shipped window covers every registered reader's requirement", () => {
    // The property in one line: no reader can need more history than retention keeps.
    for (const r of COVERAGE_REQUIREMENTS) {
      expect(retentionWindowMs()).toBeGreaterThanOrEqual(r.ms);
    }
  });
});

describe("CTL-2189 AC4 — the negative control fires", () => {
  // One fixture, two runs. Partitions from June through the current week.
  const MIXED = ["2026-06.jsonl", "2026-07.jsonl", "2026-08.jsonl", "2026-W34.jsonl"];

  test("a mixed fixture removes EXACTLY the outside-window partitions", () => {
    const plan = planRetention({ names: MIXED, nowMs: NOW, windowMs: 38 * DAY });
    // cutoff = 2026-07-16. June ends 2026-07-01 (outside). July ends 2026-08-01,
    // August ends 2026-09-01, W34 ends 2026-08-24 (all inside).
    expect(plan.remove.map((p) => p.name)).toEqual(["2026-06.jsonl"]);
    expect(plan.keep.map((p) => p.name).sort()).toEqual([
      "2026-07.jsonl",
      "2026-08.jsonl",
      "2026-W34.jsonl",
    ]);
  });

  test("an all-inside-window fixture removes NOTHING", () => {
    const plan = planRetention({
      names: ["2026-07.jsonl", "2026-08.jsonl", "2026-W34.jsonl"],
      nowMs: NOW,
      windowMs: 38 * DAY,
    });
    expect(plan.remove).toEqual([]);
  });

  test("PLANTED CONTROL: that same all-inside fixture DOES lose partitions under a shorter window", () => {
    // Proves the previous test's empty result is a decision about the window,
    // not an instrument that cannot fire. Without this, a retention job that
    // never removes anything would pass the test above.
    const plan = planRetention({
      names: ["2026-07.jsonl", "2026-08.jsonl", "2026-W34.jsonl"],
      nowMs: NOW,
      windowMs: 7 * DAY,
    });
    expect(plan.remove.map((p) => p.name)).toEqual(["2026-07.jsonl"]);
  });
});

describe("CTL-2189 AC2 — disk pressure reports, and may not override AC3", () => {
  test("pressure does NOT widen the removal set", () => {
    const names = ["2026-07.jsonl", "2026-08.jsonl"];
    const calm = planRetention({ names, nowMs: NOW, windowMs: 38 * DAY, freeBytes: 500e9 });
    const squeezed = planRetention({
      names,
      nowMs: NOW,
      windowMs: 38 * DAY,
      freeBytes: 1e9, // ~1 GB free: far below the threshold
    });
    expect(squeezed.pressure).toBe(true);
    expect(calm.pressure).toBe(false);
    // The whole point: same removal set under pressure as without it.
    expect(squeezed.remove.map((p) => p.name)).toEqual(calm.remove.map((p) => p.name));
  });

  test("pressure with nothing outside the window reports cannotHelp rather than deleting", () => {
    const plan = planRetention({
      names: ["2026-08.jsonl", "2026-W34.jsonl"],
      nowMs: NOW,
      windowMs: 38 * DAY,
      freeBytes: 1e9,
    });
    expect(plan.pressure).toBe(true);
    expect(plan.cannotHelp).toBe(true);
    expect(plan.remove).toEqual([]);
  });

  test("pressure with something outside the window is not cannotHelp", () => {
    const plan = planRetention({
      names: ["2026-06.jsonl", "2026-08.jsonl"],
      nowMs: NOW,
      windowMs: 38 * DAY,
      freeBytes: 1e9,
    });
    expect(plan.pressure).toBe(true);
    expect(plan.cannotHelp).toBe(false);
    expect(plan.remove.map((p) => p.name)).toEqual(["2026-06.jsonl"]);
  });

  test("the free-space threshold is sized for the constrained host", () => {
    // 18 GiB free (mini-2 when CTL-2189 was filed) must read as pressure.
    expect(18 * 1024 ** 3).toBeLessThan(DEFAULT_MIN_FREE_BYTES);
  });
});

describe("an unexpected layout refuses the whole run", () => {
  test("one foreign file stops everything, and says why", () => {
    const plan = planRetention({
      names: ["2026-06.jsonl", "2026-08.jsonl", "something-else.txt"],
      nowMs: NOW,
      windowMs: 38 * DAY,
    });
    expect(plan.refused).toMatch(/unrecognized/);
    // Refusing means removing nothing — including the partition that WOULD have
    // been safe to remove. Deletion is irreversible; a layout this job does not
    // understand is a reason to stop, not to proceed with the part it recognizes.
    expect(plan.remove).toEqual([]);
  });

  test("a state DIRECTORY is ignored, not refused — measured on the real events dir", () => {
    // ~/catalyst/events/.catalyst is a real directory on the laptop. Treating it
    // as an unrecognized partition made the first dry run refuse, which would
    // have shipped a job that never ran anywhere.
    const plan = planRetention({
      names: ["2026-06.jsonl", "2026-08.jsonl", ".catalyst"],
      nowMs: NOW,
      windowMs: 38 * DAY,
      isFile: (n) => n !== ".catalyst",
    });
    expect(plan.refused).toBeNull();
    expect(plan.ignored).toEqual([".catalyst"]);
    expect(plan.remove.map((p) => p.name)).toEqual(["2026-06.jsonl"]);
  });

  test("a dotfile is ignored but still REPORTED, never silently dropped", () => {
    const plan = planRetention({
      names: ["2026-06.jsonl", ".DS_Store"],
      nowMs: NOW,
      windowMs: 38 * DAY,
    });
    expect(plan.refused).toBeNull();
    expect(plan.ignored).toEqual([".DS_Store"]);
  });

  test("PLANTED CONTROL: a plain non-dot file that does not parse STILL refuses", () => {
    // Proves the two tests above relaxed the rule for non-candidates only, and
    // did not quietly disable the refusal that protects an changed layout.
    const plan = planRetention({
      names: ["2026-06.jsonl", "events-archive.jsonl"],
      nowMs: NOW,
      windowMs: 38 * DAY,
    });
    expect(plan.refused).toMatch(/unrecognized/);
    expect(plan.remove).toEqual([]);
  });

  test("PLANTED CONTROL: the same listing minus the foreign file does remove", () => {
    const plan = planRetention({
      names: ["2026-06.jsonl", "2026-08.jsonl"],
      nowMs: NOW,
      windowMs: 38 * DAY,
    });
    expect(plan.refused).toBeNull();
    expect(plan.remove.map((p) => p.name)).toEqual(["2026-06.jsonl"]);
  });
});

describe("runRetention — the job", () => {
  function harness(names, sizes = {}) {
    const unlinked = [];
    return {
      unlinked,
      deps: {
        readdir: () => names,
        sizeOf: (_dir, name) => sizes[name] ?? 0,
        unlink: (_dir, name) => unlinked.push(name),
      },
    };
  }

  test("the default is a DRY RUN — it plans, and deletes nothing", () => {
    const h = harness(["2026-06.jsonl", "2026-08.jsonl"], { "2026-06.jsonl": 1024 });
    const res = runRetention({ dir: "/x", nowMs: NOW, windowMs: 38 * DAY, ...h.deps });
    expect(res.applied).toBe(false);
    expect(res.removed).toEqual(["2026-06.jsonl"]);
    expect(h.unlinked).toEqual([]); // ← nothing touched
  });

  test("apply:true deletes exactly the plan and reports what it reclaimed", () => {
    const h = harness(["2026-06.jsonl", "2026-08.jsonl"], { "2026-06.jsonl": 987_654_321 });
    const res = runRetention({ dir: "/x", nowMs: NOW, windowMs: 38 * DAY, apply: true, ...h.deps });
    expect(res.applied).toBe(true);
    expect(h.unlinked).toEqual(["2026-06.jsonl"]);
    expect(res.reclaimedBytes).toBe(987_654_321);
  });

  test("a refusing run deletes nothing even with apply:true", () => {
    const h = harness(["2026-06.jsonl", "stray.bin"]);
    const res = runRetention({ dir: "/x", nowMs: NOW, windowMs: 38 * DAY, apply: true, ...h.deps });
    expect(res.refused).toMatch(/unrecognized/);
    expect(res.applied).toBe(false);
    expect(h.unlinked).toEqual([]);
  });
});
