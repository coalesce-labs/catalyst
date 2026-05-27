// wait-state-classifier.test.mjs — CTL-650 Phase 1. Exhaustive branch coverage
// of the pure wait-state decision tree ported from
// ~/bin/claude-bg-waiting.sh:171-202, plus the extractWaitingText port
// (claude-bg-waiting.sh:53-79).

import { test, expect } from "bun:test";
import {
  classifyWaitState,
  isWaitingState,
  extractWaitingText,
  WAITING_STATES,
} from "./wait-state-classifier.mjs";

// input shape: { status, lastBlockType, lastTool, stopReason, lastText,
//                postUserOrResultCount, hasTranscript }

test("no transcript → NO_TRANSCRIPT", () => {
  expect(classifyWaitState({ hasTranscript: false }).state).toBe("NO_TRANSCRIPT");
});

test("busy + tool_use → MID_TURN", () => {
  expect(
    classifyWaitState({
      hasTranscript: true,
      status: "busy",
      lastBlockType: "tool_use",
      lastTool: "Bash",
    }).state,
  ).toBe("MID_TURN");
});

test("busy + text → ACTIVE", () => {
  expect(
    classifyWaitState({ hasTranscript: true, status: "busy", lastBlockType: "text" }).state,
  ).toBe("ACTIVE");
});

test("idle + unresolved AskUserQuestion → WAITING_TOOL_OK", () => {
  expect(
    classifyWaitState({
      hasTranscript: true,
      status: "idle",
      lastBlockType: "tool_use",
      lastTool: "AskUserQuestion",
      postUserOrResultCount: 0,
    }).state,
  ).toBe("WAITING_TOOL_OK");
});

test("idle + unresolved other tool → WAITING_PERM", () => {
  expect(
    classifyWaitState({
      hasTranscript: true,
      status: "idle",
      lastBlockType: "tool_use",
      lastTool: "Bash",
      postUserOrResultCount: 0,
    }).state,
  ).toBe("WAITING_PERM");
});

test("idle + end_turn → WAITING_USER with waitingText", () => {
  const r = classifyWaitState({
    hasTranscript: true,
    status: "idle",
    lastBlockType: "text",
    stopReason: "end_turn",
    lastText: "First. Should I proceed?",
  });
  expect(r.state).toBe("WAITING_USER");
  expect(r.waitingText).toContain("Should I proceed?");
});

test("idle + resolved tool_use → MID_TURN", () => {
  expect(
    classifyWaitState({
      hasTranscript: true,
      status: "idle",
      lastBlockType: "tool_use",
      lastTool: "Bash",
      postUserOrResultCount: 1,
    }).state,
  ).toBe("MID_TURN");
});

test("idle + unknown → UNKNOWN", () => {
  expect(
    classifyWaitState({
      hasTranscript: true,
      status: "idle",
      lastBlockType: "text",
      stopReason: "max_tokens",
    }).state,
  ).toBe("UNKNOWN");
});

test("null status treated as not-busy", () => {
  // claude agents --json returns status:null for some sessions (research §6)
  expect(
    classifyWaitState({
      hasTranscript: true,
      status: null,
      lastBlockType: "text",
      stopReason: "end_turn",
      lastText: "Done.",
    }).state,
  ).toBe("WAITING_USER");
});

test("ExitPlanMode and EnterPlanMode also map to WAITING_TOOL_OK", () => {
  for (const lastTool of ["ExitPlanMode", "EnterPlanMode"]) {
    expect(
      classifyWaitState({
        hasTranscript: true,
        status: "idle",
        lastBlockType: "tool_use",
        lastTool,
        postUserOrResultCount: 0,
      }).state,
    ).toBe("WAITING_TOOL_OK");
  }
});

test("isWaitingState true only for the three waiting states", () => {
  expect(isWaitingState("WAITING_USER")).toBe(true);
  expect(isWaitingState("WAITING_TOOL_OK")).toBe(true);
  expect(isWaitingState("WAITING_PERM")).toBe(true);
  expect(isWaitingState("MID_TURN")).toBe(false);
  expect(isWaitingState("ACTIVE")).toBe(false);
  expect(isWaitingState("NO_TRANSCRIPT")).toBe(false);
  expect(isWaitingState("UNKNOWN")).toBe(false);
  expect(isWaitingState("")).toBe(false);
  expect(isWaitingState(undefined)).toBe(false);
});

test("WAITING_STATES export contains exactly the three waiting states", () => {
  expect([...WAITING_STATES].sort()).toEqual(
    ["WAITING_PERM", "WAITING_TOOL_OK", "WAITING_USER"].sort(),
  );
});

// ─── extractWaitingText (port of last_sentences, :53-79) ──────────────────────

test("extractWaitingText keeps the trailing 1-2 sentences", () => {
  const out = extractWaitingText("I did the first thing. Then the second. Should I proceed?");
  expect(out).toContain("Should I proceed?");
  expect(out).toContain("Then the second.");
  expect(out).not.toContain("first thing");
});

test("extractWaitingText keeps an unpunctuated trailing fragment", () => {
  const out = extractWaitingText("All done. Now what next");
  expect(out).toContain("Now what next");
});

test("extractWaitingText collapses whitespace", () => {
  const out = extractWaitingText("Hello   world.   Ready?");
  expect(out).toBe("Hello world. Ready?");
});

test("extractWaitingText with no punctuation falls back to the whole text", () => {
  expect(extractWaitingText("just a phrase no terminator")).toBe(
    "just a phrase no terminator",
  );
});

test("extractWaitingText caps length keeping the END and prepends an ellipsis", () => {
  const long = "x".repeat(50) + " important tail";
  const out = extractWaitingText(long, 20);
  expect(out.length).toBe(20);
  expect(out.startsWith("…")).toBe(true);
  expect(out.endsWith("important tail")).toBe(true);
});

test("extractWaitingText returns empty string for empty/null input", () => {
  expect(extractWaitingText("")).toBe("");
  expect(extractWaitingText(null)).toBe("");
  expect(extractWaitingText(undefined)).toBe("");
  expect(extractWaitingText("   ")).toBe("");
});
