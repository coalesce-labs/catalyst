// config.test.mjs — CTL-1086 broker config unit tests.
import { describe, expect, test } from "bun:test";
import { getEventLogPath } from "./config.mjs";

describe("CTL-1086: broker config", () => {
  test("getEventLogPath uses UTC year-month (parity with execution-core/config.mjs)", () => {
    const prev = process.env.CATALYST_DIR;
    process.env.CATALYST_DIR = "/tmp/ctl1086-utc";
    try {
      const now = new Date();
      const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
      expect(getEventLogPath()).toBe(`/tmp/ctl1086-utc/events/${ym}.jsonl`);
    } finally {
      process.env.CATALYST_DIR = prev;
    }
  });
});
