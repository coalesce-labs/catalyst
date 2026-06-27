import { test, expect } from "bun:test";
import {
  stateNameForKind,
  decideCorrection,
  reconcileDeclarations,
  summarize,
  orderedStatesForMap,
  teamPrefixOf,
} from "./linear-reconcile.mjs";

const CTL_MAP = {
  backlog: "Backlog",
  todo: "Todo",
  triage: "Triage",
  research: "Research",
  planning: "Plan",
  inProgress: "Implement",
  verifying: "Validate",
  reviewing: "Validate",
  remediating: "Remediate",
  inReview: "PR",
  done: "Done",
  canceled: "Canceled",
};
const TERMINAL = ["Done", "Canceled"];
const ORDER = orderedStatesForMap(CTL_MAP); // Backlog…PR

// ── stateNameForKind ─────────────────────────────────────────────────────────

test("stateNameForKind resolves any stateMap key; 'done' has a literal fallback", () => {
  expect(stateNameForKind("done", CTL_MAP)).toBe("Done");
  expect(stateNameForKind("inReview", CTL_MAP)).toBe("PR");
  expect(stateNameForKind("inProgress", CTL_MAP)).toBe("Implement");
  expect(stateNameForKind("done", {})).toBe("Done");
  expect(stateNameForKind("inReview", {})).toBeNull();
});

test("teamPrefixOf strips the numeric suffix", () => {
  expect(teamPrefixOf("ctc-102")).toBe("CTC");
});

test("orderedStatesForMap returns pipeline-ordered names, deduped, dropping absent keys", () => {
  expect(orderedStatesForMap(CTL_MAP)).toEqual([
    "Backlog",
    "Todo",
    "Triage",
    "Research",
    "Plan",
    "Implement",
    "Validate",
    "Remediate",
    "PR",
  ]);
  expect(orderedStatesForMap({ done: "Done" })).toEqual([]);
});

// ── decideCorrection ─────────────────────────────────────────────────────────

test("in-sync when current already equals the declared target", () => {
  const d = decideCorrection({
    ticket: "CTL-1",
    kind: "done",
    currentState: "Done",
    stateMap: CTL_MAP,
    terminalStates: TERMINAL,
  });
  expect(d.action).toBe("in-sync");
});

test("drift when current differs from the declared target", () => {
  const d = decideCorrection({
    ticket: "CTL-1",
    kind: "done",
    currentState: "Implement",
    stateMap: CTL_MAP,
    terminalStates: TERMINAL,
  });
  expect(d.action).toBe("correct");
  expect(d.target).toBe("Done");
});

test("never completes a deliberately-Canceled ticket, even on a 'done' declaration", () => {
  const d = decideCorrection({
    ticket: "CTL-1",
    kind: "done",
    currentState: "Canceled",
    stateMap: CTL_MAP,
    terminalStates: TERMINAL,
  });
  expect(d.action).toBe("skip");
  expect(d.reason).toBe("terminal-not-target");
});

test("never drags a terminal ticket backward to a non-terminal target", () => {
  const d = decideCorrection({
    ticket: "CTL-1",
    kind: "inReview",
    currentState: "Done",
    stateMap: CTL_MAP,
    terminalStates: TERMINAL,
  });
  expect(d.action).toBe("skip");
  expect(d.reason).toBe("terminal-no-backward");
});

test("a 'done' write is REFUSED on unknown current (no guard-exempt resurrection)", () => {
  const d = decideCorrection({
    ticket: "CTL-1",
    kind: "done",
    currentState: null,
    stateMap: CTL_MAP,
    terminalStates: TERMINAL,
  });
  expect(d.action).toBe("skip");
  expect(d.reason).toBe("unknown-current-unsafe");
});

test("non-terminal target is forward-only: skip when current is at/after target or unknown to the pipeline", () => {
  // Implement (before PR) → forward correction
  expect(
    decideCorrection({
      ticket: "CTL-1",
      kind: "inReview",
      currentState: "Implement",
      stateMap: CTL_MAP,
      terminalStates: TERMINAL,
      orderedStates: ORDER,
    }).action
  ).toBe("correct");
  // A custom non-terminal state after PR → skip (don't regress)
  const after = decideCorrection({
    ticket: "CTL-1",
    kind: "inReview",
    currentState: "In QA",
    stateMap: CTL_MAP,
    terminalStates: TERMINAL,
    orderedStates: ORDER,
  });
  expect(after.action).toBe("skip");
  expect(after.reason).toBe("not-forward");
  // ordering omitted → guard off (back-compat)
  expect(
    decideCorrection({
      ticket: "CTL-1",
      kind: "inReview",
      currentState: "In QA",
      stateMap: CTL_MAP,
      terminalStates: TERMINAL,
    }).action
  ).toBe("correct");
});

test("unmapped target → skip", () => {
  const d = decideCorrection({
    ticket: "CTL-1",
    kind: "inReview",
    currentState: "Backlog",
    stateMap: {},
    terminalStates: TERMINAL,
  });
  expect(d.action).toBe("skip");
  expect(d.reason).toBe("unmapped-target");
});

// ── reconcileDeclarations (with injected seams) ──────────────────────────────

const fakeStates = (map) => async (t) => map[t] ?? null;
const decls = (...pairs) => pairs.map(([ticket, state = "done"]) => ({ ticket, state }));

test("dry-run records intended corrections and never calls applyCorrection", async () => {
  let writes = 0;
  const { rows, summary } = await reconcileDeclarations({
    declarations: decls(["CTL-1"], ["CTL-2"]),
    stateMap: CTL_MAP,
    terminalStates: TERMINAL,
    readState: fakeStates({ "CTL-1": "Implement", "CTL-2": "Implement" }),
    applyCorrection: async () => {
      writes += 1;
      return { applied: true };
    },
    dryRun: true,
  });
  expect(writes).toBe(0);
  expect(rows.every((r) => r.decision === "correct" && r.dryRun)).toBe(true);
  expect(summary.drift).toBe(2);
});

test("write path corrects only drift; idempotent in-sync makes no write", async () => {
  const calls = [];
  const { summary } = await reconcileDeclarations({
    declarations: decls(["CTL-1"], ["CTL-2"]),
    stateMap: CTL_MAP,
    terminalStates: TERMINAL,
    readState: fakeStates({ "CTL-1": "Done", "CTL-2": "Implement" }), // CTL-1 already Done
    applyCorrection: async ({ ticket }) => {
      calls.push(ticket);
      return { applied: true, action: "transitioned", from_state: "Implement", to_state: "Done" };
    },
    dryRun: false,
  });
  expect(calls).toEqual(["CTL-2"]);
  expect(summary.corrected).toBe(1);
  expect(summary.inSync).toBe(1);
});

test("a readState failure is a visible skip, never a write", async () => {
  let writes = 0;
  const { rows } = await reconcileDeclarations({
    declarations: decls(["CTL-9"]),
    stateMap: CTL_MAP,
    terminalStates: TERMINAL,
    readState: async () => {
      throw new Error("Linear API 429");
    },
    applyCorrection: async () => {
      writes += 1;
      return { applied: true };
    },
    dryRun: false,
  });
  expect(writes).toBe(0);
  expect(rows[0].decision).toBe("skip");
  expect(rows[0].reason).toBe("read-failed");
});

test("unconfirmed: a 'done' declaration with no readable current state is counted, not silently dropped", async () => {
  const { summary } = await reconcileDeclarations({
    declarations: decls(["CTL-9"]),
    stateMap: CTL_MAP,
    terminalStates: TERMINAL,
    readState: fakeStates({}), // null → unknown-current-unsafe
    applyCorrection: async () => ({ applied: true }),
    dryRun: false,
  });
  expect(summary.unconfirmed).toBe(1);
  expect(summary.corrected).toBe(0);
});

test("an idempotent landed write (writeAction 'skipped') is counted noop, not corrected", async () => {
  const { summary } = await reconcileDeclarations({
    declarations: decls(["CTL-5", "inReview"]),
    stateMap: CTL_MAP,
    terminalStates: TERMINAL,
    readState: fakeStates({ "CTL-5": "Implement" }),
    applyCorrection: async () => ({
      applied: true,
      action: "skipped",
      from_state: "PR",
      to_state: "PR",
    }),
    dryRun: false,
  });
  expect(summary.noop).toBe(1);
  expect(summary.corrected).toBe(0);
});

// ── summarize ────────────────────────────────────────────────────────────────

test("summarize tallies corrected/noop/inSync/drift/skipped/unconfirmed/failed/errors", () => {
  const rows = [
    { decision: "correct", applied: true, writeAction: "transitioned" },
    { decision: "correct", applied: true, writeAction: "skipped" },
    { decision: "correct", applied: false },
    { decision: "in-sync" },
    { decision: "skip", reason: "not-forward" },
    { decision: "skip", reason: "unknown-current-unsafe" },
    { decision: "correct", applied: false, error: "x" },
    { decision: "correct", applied: false, dryRun: true },
    { decision: "correct", applied: false, writeReason: "terminal-no-backward" },
  ];
  expect(summarize(rows)).toEqual({
    tickets: 9,
    corrected: 1,
    noop: 1,
    inSync: 1,
    drift: 6,
    skipped: 2,
    unconfirmed: 1,
    failed: 1,
    errors: 1,
  });
});
