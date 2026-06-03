// Unit tests for the SHARED Linear terminal-state predicate (CTL-642 + CTL-758).
// Run: cd plugins/dev/scripts && bun test execution-core/terminal-state.test.mjs

import { describe, test, expect } from "bun:test";
import {
  isLinearTerminal,
  LINEAR_TERMINAL_STATES,
  isTicketTerminalOrMerged,
} from "./terminal-state.mjs";
import { TERMINAL as SIGNAL_TERMINAL } from "./signal-reader.mjs";
import { TERMINAL_STATES as FSM_TERMINAL } from "../lib/phase-fsm.mjs";

describe("isLinearTerminal — its OWN set {Done, Canceled}", () => {
  test("Done and Canceled are terminal", () => {
    expect(isLinearTerminal("Done")).toBe(true);
    expect(isLinearTerminal("Canceled")).toBe(true);
  });

  test("non-terminal Linear states are NOT terminal", () => {
    for (const name of ["Triage", "Todo", "In Progress", "Research", "Plan", "PR", "Backlog"]) {
      expect(isLinearTerminal(name)).toBe(false);
    }
  });

  test("null/undefined/unknown is NOT terminal (D5 fail-safe)", () => {
    expect(isLinearTerminal(null)).toBe(false);
    expect(isLinearTerminal(undefined)).toBe(false);
    expect(isLinearTerminal("")).toBe(false);
    expect(isLinearTerminal("Some Custom State")).toBe(false);
  });

  test("NO conflation with the signal-reader or phase-fsm terminal sets", () => {
    // signal-reader.TERMINAL = {done, failed, stalled, skipped} (signal statuses)
    // phase-fsm.TERMINAL_STATES = {done, stalled} (FSM states)
    // These are LOWERCASE statuses/states; the Linear set is TitleCase state NAMES.
    for (const status of SIGNAL_TERMINAL) {
      expect(isLinearTerminal(status)).toBe(false); // "done"/"failed"/... are NOT Linear-terminal NAMES
      expect(LINEAR_TERMINAL_STATES.has(status)).toBe(false);
    }
    for (const state of FSM_TERMINAL) {
      expect(isLinearTerminal(state)).toBe(false);
      expect(LINEAR_TERMINAL_STATES.has(state)).toBe(false);
    }
    // And the Linear set's members are NOT in the other two sets.
    for (const name of LINEAR_TERMINAL_STATES) {
      expect(SIGNAL_TERMINAL.has(name)).toBe(false);
      expect(FSM_TERMINAL.has(name)).toBe(false);
    }
  });

  test("the set is frozen (no caller can mutate the shared predicate)", () => {
    expect(Object.isFrozen(LINEAR_TERMINAL_STATES)).toBe(true);
  });
});

describe("isTicketTerminalOrMerged — cheap-first", () => {
  const sigWithPr = { raw: { pr: { number: 42, repo: "owner/repo" } } };
  const sigNoPr = { raw: {} };

  function spyPrView(view) {
    const calls = [];
    return {
      prView: (...args) => {
        calls.push(args);
        return view;
      },
      calls,
    };
  }

  test("terminal Linear state short-circuits — prView NOT called (cheap-first, spy 0)", () => {
    const pr = spyPrView({ state: "MERGED", mergedAt: "2026-06-04T00:00:00Z" });
    const r = isTicketTerminalOrMerged({
      ticket: "CTL-1",
      signal: sigWithPr,
      fetchState: () => "Done",
      cache: undefined,
      prAdapter: pr,
    });
    expect(r.terminal).toBe(true);
    expect(r.reason).toBe("linear-terminal");
    expect(pr.calls.length).toBe(0); // expensive PR view never ran
  });

  test("non-terminal Linear + merged PR ⇒ terminal via pr-merged (prView IS consulted)", () => {
    const pr = spyPrView({ state: "MERGED", mergedAt: null });
    const r = isTicketTerminalOrMerged({
      ticket: "CTL-2",
      signal: sigWithPr,
      fetchState: () => "PR",
      prAdapter: pr,
    });
    expect(r.terminal).toBe(true);
    expect(r.reason).toBe("pr-merged");
    expect(pr.calls.length).toBe(1);
  });

  test("non-terminal Linear + open PR ⇒ NOT terminal", () => {
    const pr = spyPrView({ state: "OPEN", mergedAt: null });
    const r = isTicketTerminalOrMerged({
      ticket: "CTL-3",
      signal: sigWithPr,
      fetchState: () => "PR",
      prAdapter: pr,
    });
    expect(r.terminal).toBe(false);
  });

  test("non-terminal Linear + NO pr number ⇒ prView NOT called (spy 0), NOT terminal", () => {
    const pr = spyPrView({ state: "MERGED", mergedAt: "x" });
    const r = isTicketTerminalOrMerged({
      ticket: "CTL-4",
      signal: sigNoPr,
      fetchState: () => "PR",
      prAdapter: pr,
    });
    expect(r.terminal).toBe(false);
    expect(pr.calls.length).toBe(0);
  });

  test("null Linear read ⇒ NOT terminal (D5 fail-safe), even with merged PR absent", () => {
    const pr = spyPrView({ state: "OPEN", mergedAt: null });
    const r = isTicketTerminalOrMerged({
      ticket: "CTL-5",
      signal: sigWithPr,
      fetchState: () => null,
      prAdapter: pr,
    });
    expect(r.terminal).toBe(false);
  });

  test("a thrown read fails safe to NOT terminal", () => {
    const r = isTicketTerminalOrMerged({
      ticket: "CTL-6",
      signal: sigWithPr,
      fetchState: () => {
        throw new Error("linearis exploded");
      },
      prAdapter: spyPrView(null),
    });
    expect(r.terminal).toBe(false);
  });

  test("mergedAt non-null with state UNKNOWN still counts as merged", () => {
    const pr = spyPrView({ state: "UNKNOWN", mergedAt: "2026-06-04T00:00:00Z" });
    const r = isTicketTerminalOrMerged({
      ticket: "CTL-7",
      signal: sigWithPr,
      fetchState: () => "PR",
      prAdapter: pr,
    });
    expect(r.terminal).toBe(true);
    expect(r.reason).toBe("pr-merged");
  });
});
