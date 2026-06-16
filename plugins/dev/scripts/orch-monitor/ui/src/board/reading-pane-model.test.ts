import { describe, it, expect } from "bun:test";
import { escalationAccentFor } from "./reading-pane-model";
import type { InboxRow } from "./home-inbox";
import type { BoardTicket } from "./types";

function makeTicket(overrides: Partial<BoardTicket> = {}): BoardTicket {
  return {
    id: "CTL-TEST",
    title: "Test ticket",
    type: "feature",
    repo: "catalyst",
    team: "dev",
    phase: "implement",
    status: "running",
    model: null,
    linearState: "In Progress",
    workerStatus: null,
    activeState: "active",
    working: true,
    lastActiveMs: null,
    priority: 0,
    estimate: null,
    scope: null,
    project: null,
    costUSD: null,
    tokens: null,
    turns: null,
    phaseCosts: null,
    phaseSummary: [],
    pr: null,
    updatedAt: "2026-06-14T00:00:00Z",
    attention: "needs-human",
    ...overrides,
  };
}

function makeRow(section: InboxRow["section"]): InboxRow {
  return {
    id: "CTL-TEST",
    title: "Test ticket",
    section,
    subLabel: "test",
    verb: null,
    blockers: [],
    ticket: makeTicket(),
  };
}

describe("escalationAccentFor", () => {
  it("blocked-section escalation → red", () =>
    expect(escalationAccentFor(makeRow("blocked"))).toBe("red"));
  it("attention-section escalation → amber", () =>
    expect(escalationAccentFor(makeRow("attention"))).toBe("amber"));
  it("waiting-section escalation → amber", () =>
    expect(escalationAccentFor(makeRow("waiting"))).toBe("amber"));
  it("neutral section floors to amber (never none for an escalation)", () =>
    expect(escalationAccentFor(makeRow("running"))).toBe("amber"));
});
