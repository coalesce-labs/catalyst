// Unit tests for terminal-needs-human-reconcile.mjs (CTL-1242 corrected scope).
// Pure decision helpers + the mode reader + the seam-injected runtime sweep.
// Run: bun test plugins/dev/scripts/broker/terminal-needs-human-reconcile.test.mjs

import { describe, test, expect } from "bun:test";
import {
  TERMINAL_STATES,
  isTerminalState,
  STALE_TERMINAL_LABEL,
  decideTerminalNeedsHumanStrip,
  readReconcileMode,
  reconcileTerminalNeedsHuman,
} from "./terminal-needs-human-reconcile.mjs";

const silentLog = { info: () => {}, warn: () => {} };

describe("isTerminalState", () => {
  test("TERMINAL_STATES = done/canceled/cancelled/duplicate", () => {
    expect([...TERMINAL_STATES].sort()).toEqual(
      ["canceled", "cancelled", "done", "duplicate"].sort()
    );
  });
  test("case-insensitive match on the terminal set", () => {
    expect(isTerminalState("Done")).toBe(true);
    expect(isTerminalState("DONE")).toBe(true);
    expect(isTerminalState("Canceled")).toBe(true);
    expect(isTerminalState("Duplicate")).toBe(true);
  });
  test("non-terminal states are false", () => {
    expect(isTerminalState("In Progress")).toBe(false);
    expect(isTerminalState("Triage")).toBe(false);
    expect(isTerminalState("In Review")).toBe(false);
  });
  test("null / non-string → false", () => {
    expect(isTerminalState(null)).toBe(false);
    expect(isTerminalState(undefined)).toBe(false);
    expect(isTerminalState(42)).toBe(false);
  });
});

describe("decideTerminalNeedsHumanStrip", () => {
  test("the stale label is needs-human", () => {
    expect(STALE_TERMINAL_LABEL).toBe("needs-human");
  });

  test("terminal + needs-human present → strip, label removed, others kept", () => {
    const d = { ticket: "CTL-1248", state: "Done", labels: ["monitor", "feature", "needs-human"] };
    const out = decideTerminalNeedsHumanStrip(d);
    expect(out.strip).toBe(true);
    expect(out.labels).toEqual(["monitor", "feature"]);
    expect(out.reason).toContain("strip needs-human");
  });

  test("terminal but no needs-human → no strip (labels untouched)", () => {
    const d = { ticket: "CTL-1", state: "Done", labels: ["monitor", "feature"] };
    const out = decideTerminalNeedsHumanStrip(d);
    expect(out.strip).toBe(false);
    expect(out.labels).toEqual(["monitor", "feature"]);
  });

  test("non-terminal WITH needs-human → no strip (a live escalation is preserved)", () => {
    const d = { ticket: "CTL-1204", state: "In Progress", labels: ["needs-human"] };
    const out = decideTerminalNeedsHumanStrip(d);
    expect(out.strip).toBe(false);
    expect(out.labels).toEqual(["needs-human"]);
  });

  test("canceled / duplicate are terminal too", () => {
    expect(decideTerminalNeedsHumanStrip({ state: "Canceled", labels: ["needs-human"] }).strip).toBe(true);
    expect(decideTerminalNeedsHumanStrip({ state: "Duplicate", labels: ["needs-human"] }).strip).toBe(true);
  });

  test("idempotent: re-running on an already-stripped row is a no-op", () => {
    const first = decideTerminalNeedsHumanStrip({ state: "Done", labels: ["x", "needs-human"] });
    expect(first.strip).toBe(true);
    const second = decideTerminalNeedsHumanStrip({ state: "Done", labels: first.labels });
    expect(second.strip).toBe(false);
  });

  test("null / missing labels → no strip, no throw", () => {
    expect(decideTerminalNeedsHumanStrip({ state: "Done", labels: null }).strip).toBe(false);
    expect(decideTerminalNeedsHumanStrip({ state: "Done" }).strip).toBe(false);
    expect(decideTerminalNeedsHumanStrip(null).strip).toBe(false);
  });

  test("stripping the only label yields an empty array (not null)", () => {
    const out = decideTerminalNeedsHumanStrip({ state: "Done", labels: ["needs-human"] });
    expect(out.strip).toBe(true);
    expect(out.labels).toEqual([]);
  });
});

describe("readReconcileMode — CTL-1242 ships ENFORCE by default with a kill-switch", () => {
  test("unset → enforce (the default-on differentiator)", () => {
    expect(readReconcileMode({})).toBe("enforce");
  });
  test('"0" and "off" → off (kill-switch)', () => {
    expect(readReconcileMode({ CATALYST_TERMINAL_NEEDS_HUMAN_RECONCILE: "0" })).toBe("off");
    expect(readReconcileMode({ CATALYST_TERMINAL_NEEDS_HUMAN_RECONCILE: "off" })).toBe("off");
  });
  test('"shadow" → shadow, "enforce" → enforce', () => {
    expect(readReconcileMode({ CATALYST_TERMINAL_NEEDS_HUMAN_RECONCILE: "shadow" })).toBe("shadow");
    expect(readReconcileMode({ CATALYST_TERMINAL_NEEDS_HUMAN_RECONCILE: "enforce" })).toBe("enforce");
  });
  test("unrecognized value → enforce (fail toward the default)", () => {
    expect(readReconcileMode({ CATALYST_TERMINAL_NEEDS_HUMAN_RECONCILE: "garbage" })).toBe("enforce");
  });
});

describe("reconcileTerminalNeedsHuman — runtime sweep", () => {
  const cache = () => [
    { ticket: "CTL-1248", state: "Done", labels: ["monitor", "feature", "needs-human"] }, // strip
    { ticket: "CTL-1186", state: "Done", labels: ["needs-human"] }, // strip → []
    { ticket: "CTL-1204", state: "In Progress", labels: ["needs-human"] }, // KEEP (live)
    { ticket: "CTL-2", state: "Done", labels: ["chore"] }, // nothing to strip
  ];

  test("enforce: writes the stripped set only for terminal+labelled rows", () => {
    const writes = [];
    const summary = reconcileTerminalNeedsHuman({
      getAll: cache,
      upsert: (input) => writes.push(input),
      mode: "enforce",
      log: silentLog,
    });
    expect(summary.scanned).toBe(4);
    expect(summary.stripped).toBe(2);
    expect(writes).toEqual([
      { ticket: "CTL-1248", labels: ["monitor", "feature"] },
      { ticket: "CTL-1186", labels: [] },
    ]);
    // The live (non-terminal) escalation is NOT touched.
    expect(writes.find((w) => w.ticket === "CTL-1204")).toBeUndefined();
  });

  test("shadow: counts what it WOULD strip, writes nothing", () => {
    const writes = [];
    const summary = reconcileTerminalNeedsHuman({
      getAll: cache,
      upsert: (input) => writes.push(input),
      mode: "shadow",
      log: silentLog,
    });
    expect(summary.stripped).toBe(2);
    expect(writes).toEqual([]);
  });

  test("off: scans nothing, writes nothing", () => {
    const writes = [];
    const summary = reconcileTerminalNeedsHuman({
      getAll: cache,
      upsert: (input) => writes.push(input),
      mode: "off",
      log: silentLog,
    });
    expect(summary.scanned).toBe(0);
    expect(summary.stripped).toBe(0);
    expect(writes).toEqual([]);
  });

  test("emit fires once with the stripped tickets when anything changed", () => {
    const emitted = [];
    reconcileTerminalNeedsHuman({
      getAll: cache,
      upsert: () => {},
      emit: (s) => emitted.push(s),
      mode: "enforce",
      log: silentLog,
    });
    expect(emitted.length).toBe(1);
    expect(emitted[0].tickets ?? emitted[0].items.map((i) => i.ticket)).toEqual([
      "CTL-1248",
      "CTL-1186",
    ]);
  });

  test("emit does NOT fire when nothing was stripped", () => {
    const emitted = [];
    reconcileTerminalNeedsHuman({
      getAll: () => [{ ticket: "CTL-2", state: "Done", labels: ["chore"] }],
      upsert: () => {},
      emit: (s) => emitted.push(s),
      mode: "enforce",
      log: silentLog,
    });
    expect(emitted).toEqual([]);
  });

  test("a per-row upsert throw is rolled back out of the summary, others still applied", () => {
    const writes = [];
    const summary = reconcileTerminalNeedsHuman({
      getAll: cache,
      upsert: (input) => {
        if (input.ticket === "CTL-1248") throw new Error("db locked");
        writes.push(input);
      },
      mode: "enforce",
      log: silentLog,
    });
    expect(summary.stripped).toBe(1); // only CTL-1186 succeeded
    expect(writes).toEqual([{ ticket: "CTL-1186", labels: [] }]);
  });

  test("getAll throw → empty summary, never throws to caller", () => {
    const summary = reconcileTerminalNeedsHuman({
      getAll: () => {
        throw new Error("db unavailable");
      },
      upsert: () => {},
      mode: "enforce",
      log: silentLog,
    });
    expect(summary.scanned).toBe(0);
    expect(summary.stripped).toBe(0);
  });
});
