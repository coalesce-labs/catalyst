// inbox-summary-data.test.ts — unit tests for pure mapping helpers (CTL-1042 Phase 4).
import { test, expect, describe } from "bun:test";
import {
  inboxSummaryUrl,
  mergeSummaryIntoTicket,
  summaryIsUsable,
  type InboxSummaryResponse,
} from "./inbox-summary-data";
import type { BoardTicket } from "../../board/types";

// Minimal BoardTicket stub with only fields we care about.
function makeTicket(overrides: Partial<BoardTicket> = {}): BoardTicket {
  return {
    id: "CTL-1042",
    title: "Stub ticket",
    type: "feature",
    repo: null,
    team: null,
    phase: "implement",
    status: "running",
    model: null,
    linearState: null,
    workerStatus: null,
    activeState: "active",
    working: false,
    lastActiveMs: 0,
    priority: null,
    estimate: null,
    scope: null,
    project: null,
    costUSD: null,
    tokens: null,
    turns: null,
    phaseCosts: null,
    phaseSummary: null,
    pr: null,
    updatedAt: null,
    ...overrides,
  } as BoardTicket;
}

const BASE_TICKET = makeTicket();

describe("inboxSummaryUrl", () => {
  test("builds the endpoint URL without phase", () => {
    expect(inboxSummaryUrl("CTL-1042")).toBe("/api/inbox/CTL-1042/summary");
  });

  test("appends ?phase= when provided", () => {
    expect(inboxSummaryUrl("CTL-1042", "implement")).toBe(
      "/api/inbox/CTL-1042/summary?phase=implement",
    );
  });

  test("percent-encodes special chars in ticket", () => {
    expect(inboxSummaryUrl("CTL/1042")).toContain("CTL%2F1042");
  });
});

describe("summaryIsUsable", () => {
  test("false when resp is null", () => {
    expect(summaryIsUsable(null)).toBe(false);
  });

  test("false when enabled:false", () => {
    expect(summaryIsUsable({ enabled: false })).toBe(false);
  });

  test("false when enabled:true but ask and summary both null", () => {
    expect(summaryIsUsable({ enabled: true, ask: null, summary: null })).toBe(false);
  });

  test("true when enabled:true and ask is set", () => {
    expect(summaryIsUsable({ enabled: true, ask: "Pick A or B?" })).toBe(true);
  });

  test("true when enabled:true and summary is set, ask is absent", () => {
    expect(summaryIsUsable({ enabled: true, summary: "Worker was implementing cache." })).toBe(
      true,
    );
  });
});

describe("mergeSummaryIntoTicket", () => {
  test("returns ticket unchanged when resp is null", () => {
    const result = mergeSummaryIntoTicket(BASE_TICKET, null);
    expect(result).toBe(BASE_TICKET);
  });

  test("returns ticket unchanged when enabled:false", () => {
    const result = mergeSummaryIntoTicket(BASE_TICKET, { enabled: false });
    expect(result).toBe(BASE_TICKET);
  });

  test("merges ask onto ticket when present (Scenario 1)", () => {
    const merged = mergeSummaryIntoTicket(BASE_TICKET, {
      enabled: true,
      ask: "Pick A or B?",
      summary: "Worker was implementing the AI cache.",
    });
    expect(merged.ask).toBe("Pick A or B?");
    expect(merged.summary).toBe("Worker was implementing the AI cache.");
  });

  test("maps options.tradeoffs → DecisionOption.detail", () => {
    const resp: InboxSummaryResponse = {
      enabled: true,
      ask: "Which approach?",
      options: [
        { label: "Path A", tradeoffs: "faster, more cache misses" },
        { label: "Path B" },
      ],
    };
    const merged = mergeSummaryIntoTicket(BASE_TICKET, resp);
    expect(merged.options).toHaveLength(2);
    expect(merged.options![0]).toEqual({ label: "Path A", detail: "faster, more cache misses" });
    expect(merged.options![1]).toEqual({ label: "Path B", detail: "" });
  });

  test("degrades: enabled:true ask:null leaves ticket.ask unchanged (Scenario 3)", () => {
    const ticket = makeTicket({ ask: "original ask" });
    const merged = mergeSummaryIntoTicket(ticket, { enabled: true, ask: null, summary: null });
    expect(merged.ask).toBe("original ask");
  });

  test("does not overwrite ticket.summary when resp.summary is null", () => {
    const ticket = makeTicket({ summary: "original summary" });
    const merged = mergeSummaryIntoTicket(ticket, { enabled: true, ask: "new ask", summary: null });
    expect(merged.summary).toBe("original summary");
    expect(merged.ask).toBe("new ask");
  });

  test("merges blocker when present", () => {
    const merged = mergeSummaryIntoTicket(BASE_TICKET, {
      enabled: true,
      ask: "unblock this",
      blocker: "missing API key",
    });
    expect(merged.blocker).toBe("missing API key");
  });

  test("returns a NEW object (shallow copy, not mutation)", () => {
    const merged = mergeSummaryIntoTicket(BASE_TICKET, {
      enabled: true,
      ask: "new ask",
    });
    expect(merged).not.toBe(BASE_TICKET);
    expect(BASE_TICKET.ask).toBeUndefined();
  });

  test("CTL-1110: preserves the explanation field across the summary merge", () => {
    const expl = { call_to_action: "Decide.", outcome: null, problem: "X.",
                   why_you: null, why_not_auto: null, what_to_do: null };
    const ticket = makeTicket({ attention: "needs-human" as const, explanation: expl });
    const merged = mergeSummaryIntoTicket(ticket, { enabled: true, ask: "new ask", summary: null });
    expect(merged.explanation).toEqual(expl);
    expect(merged.ask).toBe("new ask");
  });
});
