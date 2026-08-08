import { test, expect } from "bun:test";
import {
  USAGE_LIMIT_TEXT_RE,
  USAGE_LIMIT_FALLBACK_MS,
  parseResetFromDetail,
  readJobTimelineBlock,
  detectUsageLimitBlock,
  buildUsageLimitExplanation,
} from "./usage-limit.mjs";

test("vocabulary covers account usage-limit phrasings without matching unrelated limits", () => {
  for (const text of [
    "You've hit your weekly limit",
    "You've hit your session limit",
    "You've hit your usage limit",
    "You've hit your 5-hour limit",
    "you have hit your Opus weekly limit",
  ]) {
    expect(USAGE_LIMIT_TEXT_RE.test(text)).toBe(true);
  }
  for (const text of [
    "the rate limit on the GitHub API",
    "I hit your test's assertion limit of 3",
    "turn cap exhausted",
    "You have hit your context window limit",
    "You hit your maximum output token limit",
    "Prompt is too long: you hit your token limit",
  ]) {
    expect(USAGE_LIMIT_TEXT_RE.test(text)).toBe(false);
  }
});

test("timeline recognition returns the latest relevant block and fails closed", () => {
  const raw = [
    JSON.stringify({ at: "old", state: "blocked", detail: "You've hit your session limit" }),
    JSON.stringify({ at: "noise", state: "blocked", detail: "stuck on a startup dialog" }),
    JSON.stringify({ at: "new", state: "blocked", detail: "You've hit your weekly limit" }),
  ].join("\n");
  expect(readJobTimelineBlock("job", { readFileFn: () => raw })).toEqual({
    blocked: true,
    at: "new",
    detail: "You've hit your weekly limit",
  });
  expect(readJobTimelineBlock("job", { readFileFn: () => "not json\n{" }).blocked).toBe(false);
  expect(
    readJobTimelineBlock("job", {
      readFileFn: () => {
        throw new Error("ENOENT");
      },
    }).blocked
  ).toBe(false);
});

test("reset selection prefers poller, then prose, then bounded default", () => {
  const now = () => Date.parse("2026-08-08T20:29:57Z");
  expect(
    parseResetFromDetail("resets Aug 10 at 1pm", { pollerResetsAt: "2026-08-10T17:59:59Z", now })
      .resetSource
  ).toBe("poller");
  expect(parseResetFromDetail("resets Aug 10 at 1pm (America/Chicago)", { now }).resetSource).toBe(
    "detail"
  );
  expect(
    parseResetFromDetail("You've hit your weekly limit · resets Aug 10 at 1pm (America/Chicago)", {
      now,
    }).resetsAt
  ).toBe("2026-08-10T18:00:00.000Z");
  expect(Date.parse(parseResetFromDetail("weekly limit", { now }).resetsAt)).toBe(
    now() + USAGE_LIMIT_FALLBACK_MS
  );
});

test("detector uses timeline detail only and never throws", () => {
  expect(
    detectUsageLimitBlock("job", {
      readTimelineFn: () => ({ blocked: false }),
      detectTranscriptFn: () => true,
      now: () => 1000,
    }).blocked
  ).toBe(false);
  expect(detectUsageLimitBlock(null, {}).blocked).toBe(false);
  expect(
    detectUsageLimitBlock("job", {
      readTimelineFn: () => {
        throw new Error("boom");
      },
    }).blocked
  ).toBe(false);
});

test("usage-limit explanation names reset and fallback availability", () => {
  const withFallback = buildUsageLimitExplanation({
    ticket: "CAT-58",
    phase: "research",
    resetsAt: "2026-08-10T17:59:59Z",
    fallbackLane: "codex-exec",
  });
  expect(withFallback.problem).toMatch(/usage limit/i);
  expect(withFallback.call_to_action).toMatch(/codex-exec/);
  expect(withFallback.call_to_action).toContain("2026-08-10");
  expect(
    buildUsageLimitExplanation({ ticket: "CAT-58", phase: "research", fallbackLane: null })
      .call_to_action
  ).toMatch(/no healthy/i);
});
