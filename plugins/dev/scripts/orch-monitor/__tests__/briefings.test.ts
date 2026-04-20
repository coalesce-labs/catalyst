import { describe, it, expect } from "bun:test";
import {
  collectBriefings,
  hasAnyBriefings,
  renderBriefingHtml,
} from "../ui/src/lib/briefings";
import type { OrchestratorState } from "../ui/src/lib/types";

function makeOrch(
  overrides: Partial<OrchestratorState> = {},
): OrchestratorState {
  return {
    id: "orch-test",
    path: "/home/user/wt/myrepo/orch-test",
    workspace: "myrepo",
    startedAt: "2026-04-15T00:00:00Z",
    currentWave: 1,
    totalWaves: 2,
    waves: [],
    workers: {},
    dashboard: null,
    briefings: {},
    attention: [],
    ...overrides,
  };
}

describe("hasAnyBriefings", () => {
  it("returns false when briefings is empty", () => {
    expect(hasAnyBriefings(makeOrch())).toBe(false);
  });

  it("returns false when every briefing is an empty string", () => {
    expect(hasAnyBriefings(makeOrch({ briefings: { 1: "", 2: "" } }))).toBe(
      false,
    );
  });

  it("returns true when at least one briefing has content", () => {
    expect(
      hasAnyBriefings(makeOrch({ briefings: { 1: "", 2: "# body" } })),
    ).toBe(true);
  });
});

describe("collectBriefings", () => {
  it("returns [] when no briefings", () => {
    expect(collectBriefings(makeOrch())).toEqual([]);
  });

  it("filters out empty-string briefings", () => {
    expect(
      collectBriefings(makeOrch({ briefings: { 1: "a", 2: "", 3: "c" } })),
    ).toEqual([
      { wave: 1, body: "a" },
      { wave: 3, body: "c" },
    ]);
  });

  it("sorts entries ascending by wave number", () => {
    expect(
      collectBriefings(makeOrch({ briefings: { 3: "c", 1: "a", 2: "b" } })),
    ).toEqual([
      { wave: 1, body: "a" },
      { wave: 2, body: "b" },
      { wave: 3, body: "c" },
    ]);
  });
});

describe("renderBriefingHtml", () => {
  // Note: rendering-path assertions (heading emission, sanitization) require
  // a DOM for DOMPurify — the orch-monitor test env intentionally has none
  // (RTL/jest-axe harness is CTL-106's scope). These tests verify the
  // deterministic / total-function contract of the wrapper only. The visual
  // rendering path is exercised manually and in the production bundle.

  it("never throws on arbitrary string input", () => {
    expect(() => renderBriefingHtml("")).not.toThrow();
    expect(() => renderBriefingHtml("arbitrary")).not.toThrow();
    expect(() => renderBriefingHtml("# heading\n\ntext")).not.toThrow();
    expect(() => renderBriefingHtml("<script>x</script>")).not.toThrow();
  });

  it("returns a string", () => {
    expect(typeof renderBriefingHtml("hi")).toBe("string");
  });
});
