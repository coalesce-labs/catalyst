// config.test.mjs — CTL-1086 broker config unit tests.
import { describe, expect, test } from "bun:test";
import { getEventLogPath, parseIntKnob } from "./config.mjs";
import { eventLogBasenameFor, resolveRotationScheme } from "../lib/event-log-paths.mjs";

describe("CTL-1086: broker config", () => {
  test("getEventLogPath uses UTC year-month (parity with execution-core/config.mjs)", () => {
    const prev = process.env.CATALYST_DIR;
    process.env.CATALYST_DIR = "/tmp/ctl1086-utc";
    try {
      const now = new Date();
      // CTL-1216: resolve through the production leaf rather than pinning the
      // monthly shape — otherwise this asserts the scheme, not the resolution.
      const ym = eventLogBasenameFor(now, resolveRotationScheme({ env: process.env })).replace(/\.jsonl$/, "");
      expect(getEventLogPath()).toBe(`/tmp/ctl1086-utc/events/${ym}.jsonl`);
    } finally {
      process.env.CATALYST_DIR = prev;
    }
  });
});

// CTL-1523 / Codex round 3 (T7). parseIntKnob is the SHARED validator behind every
// int env knob in this module (PILEUP_{THRESHOLD,PERSISTENCE_MS,COOLDOWN_MS} and
// BROKER_DEGRADED_{GRACE_MS,SUSTAINED_TICKS}). It used `parseInt`, which is
// PREFIX-lenient — "1.5" and "1garbage" both come back as 1 — so a partially-parsed
// value sailed past the warn-and-default path. For
// FILTER_BROKER_DEGRADED_SUSTAINED_TICKS that silently eliminated the debounce: the
// detector fired after a single anomalous tick instead of the documented 5.
describe("CTL-1523: parseIntKnob rejects partially-parsed values", () => {
  test("a well-formed integer parses (the happy path is unchanged)", () => {
    expect(parseIntKnob("7", 5, { min: 1 })).toBe(7);
    expect(parseIntKnob("300000", 1, { min: 0 })).toBe(300000);
    expect(parseIntKnob(" 7 ", 5, { min: 1 })).toBe(7); // surrounding whitespace is fine
    expect(parseIntKnob("+7", 5, { min: 1 })).toBe(7);
  });

  test("an UNSET knob is the default (not a malformed value)", () => {
    expect(parseIntKnob(undefined, 5, { min: 1 })).toBe(5);
  });

  for (const bad of ["1.5", "1garbage", "", "  ", "abc", "-1"]) {
    test(`${JSON.stringify(bad)} falls back to the default`, () => {
      expect(parseIntKnob(bad, 5, { min: 1 })).toBe(5);
    });
  }

  test("THE REGRESSION: SUSTAINED_TICKS='1.5' no longer collapses the debounce to 1", () => {
    // What parseInt did — the silent single-tick detector.
    expect(parseInt("1.5", 10)).toBe(1);
    expect(parseInt("1garbage", 10)).toBe(1);
    // What the knob now does: keep the documented 5-tick debounce.
    expect(parseIntKnob("1.5", 5, { min: 1 })).toBe(5);
    expect(parseIntKnob("1garbage", 5, { min: 1 })).toBe(5);
  });

  test("'-1' is rejected by the BOUND, not by its sign — a negative min accepts it", () => {
    expect(parseIntKnob("-1", 5, { min: 0 })).toBe(5);
    expect(parseIntKnob("-1", 5, { min: -5 })).toBe(-1);
  });
});
