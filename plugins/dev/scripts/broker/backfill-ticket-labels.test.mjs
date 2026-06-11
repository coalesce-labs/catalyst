// Unit tests for the PURE decision helpers of backfill-ticket-labels.mjs
// (CTL-1031). The CLI spawn (`linearis issues read`) and the bun:sqlite writes
// are NOT exercised here — only the label extraction + upsert/held-since
// decision logic.
// Run: bun test plugins/dev/scripts/broker/backfill-ticket-labels.test.mjs

import { describe, test, expect } from "bun:test";
import {
  extractLabelNames,
  decideLabelBackfill,
  hasHeldLabel,
  HELD_LABELS,
} from "./backfill-ticket-labels.mjs";

describe("extractLabelNames — linearis {nodes} shape", () => {
  test("extracts names from labels.nodes", () => {
    const json = {
      identifier: "CTL-1031",
      labels: {
        nodes: [
          { id: "a", name: "bug" },
          { id: "b", name: "monitor" },
          { id: "c", name: "broker" },
        ],
      },
    };
    expect(extractLabelNames(json)).toEqual(["bug", "monitor", "broker"]);
  });

  test("empty nodes → [] (genuine empty label set, distinct from null)", () => {
    expect(extractLabelNames({ labels: { nodes: [] } })).toEqual([]);
    expect(extractLabelNames({ labels: { nodes: [] } })).not.toBeNull();
  });

  test("labels absent → null (unknown — do not touch)", () => {
    expect(extractLabelNames({ identifier: "CTL-1" })).toBeNull();
  });

  test("labels not an object (e.g. flat array) → null", () => {
    // linearis read never returns a flat array, but guard it anyway.
    expect(extractLabelNames({ labels: [{ name: "bug" }] })).toBeNull();
  });

  test("nodes missing / not an array → null", () => {
    expect(extractLabelNames({ labels: {} })).toBeNull();
    expect(extractLabelNames({ labels: { nodes: "nope" } })).toBeNull();
  });

  test("non-object / blank / non-string names are dropped", () => {
    const json = {
      labels: {
        nodes: [{ name: "bug" }, "garbage", { id: "x" }, { name: "" }, { name: 7 }, { name: "p0" }],
      },
    };
    expect(extractLabelNames(json)).toEqual(["bug", "p0"]);
  });

  test("duplicate names are de-duplicated, order preserved", () => {
    const json = { labels: { nodes: [{ name: "bug" }, { name: "bug" }, { name: "p0" }] } };
    expect(extractLabelNames(json)).toEqual(["bug", "p0"]);
  });

  test("null / non-object input → null", () => {
    expect(extractLabelNames(null)).toBeNull();
    expect(extractLabelNames("CTL-1")).toBeNull();
    expect(extractLabelNames(42)).toBeNull();
  });
});

describe("hasHeldLabel", () => {
  test("HELD_LABELS is blocked + waiting (mirrors router.mjs)", () => {
    expect(HELD_LABELS).toEqual(["blocked", "waiting"]);
  });
  test("true when blocked present", () => {
    expect(hasHeldLabel(["bug", "blocked"])).toBe(true);
  });
  test("true when waiting present", () => {
    expect(hasHeldLabel(["waiting"])).toBe(true);
  });
  test("false for a non-held set", () => {
    expect(hasHeldLabel(["bug", "monitor"])).toBe(false);
  });
  test("false for [] and non-arrays", () => {
    expect(hasHeldLabel([])).toBe(false);
    expect(hasHeldLabel(null)).toBe(false);
    expect(hasHeldLabel("blocked")).toBe(false);
  });
});

describe("decideLabelBackfill", () => {
  test("fetched=null → touch nothing", () => {
    const d = decideLabelBackfill({ current: { labels: ["bug"], heldSince: null }, fetched: null });
    expect(d.writeLabels).toBe(false);
    expect(d.stampHeldSince).toBe(false);
    expect(d.clearHeldSince).toBe(false);
  });

  test("no cached labels, fetched names → write labels", () => {
    const d = decideLabelBackfill({
      current: { labels: null, heldSince: null },
      fetched: ["bug", "monitor"],
    });
    expect(d.writeLabels).toBe(true);
    expect(d.labels).toEqual(["bug", "monitor"]);
  });

  test("cached labels already match (set-equal) → no label write", () => {
    const d = decideLabelBackfill({
      current: { labels: ["monitor", "bug"], heldSince: null },
      fetched: ["bug", "monitor"],
    });
    expect(d.writeLabels).toBe(false);
  });

  test("cached labels differ → write fetched", () => {
    const d = decideLabelBackfill({
      current: { labels: ["bug"], heldSince: null },
      fetched: ["bug", "blocked"],
    });
    expect(d.writeLabels).toBe(true);
    expect(d.labels).toEqual(["bug", "blocked"]);
  });

  test("held label present + held_since empty → stamp held_since", () => {
    const d = decideLabelBackfill({
      current: { labels: null, heldSince: null },
      fetched: ["blocked"],
    });
    expect(d.stampHeldSince).toBe(true);
    expect(d.clearHeldSince).toBe(false);
  });

  test("held label present + held_since ALREADY set → do NOT re-stamp (sticky)", () => {
    const d = decideLabelBackfill({
      current: { labels: ["blocked"], heldSince: "2026-06-10T00:00:00.000Z" },
      fetched: ["blocked"],
    });
    expect(d.stampHeldSince).toBe(false);
    expect(d.clearHeldSince).toBe(false);
  });

  test("no held label but held_since set → clear held_since", () => {
    const d = decideLabelBackfill({
      current: { labels: ["blocked"], heldSince: "2026-06-10T00:00:00.000Z" },
      fetched: ["bug"],
    });
    expect(d.writeLabels).toBe(true);
    expect(d.clearHeldSince).toBe(true);
    expect(d.stampHeldSince).toBe(false);
  });

  test("empty fetched set clears held_since when one was set", () => {
    const d = decideLabelBackfill({
      current: { labels: ["blocked"], heldSince: "2026-06-10T00:00:00.000Z" },
      fetched: [],
    });
    expect(d.writeLabels).toBe(true);
    expect(d.labels).toEqual([]);
    expect(d.clearHeldSince).toBe(true);
  });

  test("current=null (ticket not yet cached) + held fetched → write + stamp", () => {
    const d = decideLabelBackfill({ current: null, fetched: ["waiting"] });
    expect(d.writeLabels).toBe(true);
    expect(d.stampHeldSince).toBe(true);
  });

  test("idempotent: matching labels + correct held_since → no-op", () => {
    const d = decideLabelBackfill({
      current: { labels: ["blocked"], heldSince: "2026-06-10T00:00:00.000Z" },
      fetched: ["blocked"],
    });
    expect(d.writeLabels).toBe(false);
    expect(d.stampHeldSince).toBe(false);
    expect(d.clearHeldSince).toBe(false);
  });
});
