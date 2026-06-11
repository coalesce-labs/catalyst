// otel-error-counts.test.ts — CTL-1039: apiErrorCounts returns the proportional
// error counts WITH EXPLICIT WINDOWS (last 15m + since local midnight) the hero
// reads to pick NOTED vs ERRORING. null only when Loki is unavailable; honest 0
// on an empty stream.

import { describe, it, expect } from "bun:test";
import { apiErrorCounts, startOfLocalDay } from "../lib/otel-queries";
import type { LokiFetcher, LokiQueryResult } from "../lib/loki";

/** A loki mock that returns N values when the query window is short (≤30m) and M
 *  values for the wider (today) window — distinguished by the start/end span. */
function windowedLoki(count15m: number, countToday: number): LokiFetcher {
  return {
    queryRange: (_logql, start, end) => {
      const spanMs = Date.parse(end) - Date.parse(start);
      const n = spanMs <= 30 * 60_000 ? count15m : countToday;
      const values: Array<[string, string]> = Array.from({ length: n }, (_, i) => [
        String(i),
        "claude_code.api_error",
      ]);
      const result: LokiQueryResult = {
        data: { resultType: "streams", result: [{ stream: {}, values }] },
      };
      return Promise.resolve(result);
    },
    isAvailable: () => true,
  };
}

describe("apiErrorCounts", () => {
  it("returns separate 15m and today counts", async () => {
    const loki = windowedLoki(2, 7);
    const counts = await apiErrorCounts(loki, new Date("2026-06-11T12:00:00"));
    expect(counts).not.toBeNull();
    expect(counts!.count15m).toBe(2);
    expect(counts!.countToday).toBe(7);
  });

  it("honest 0 on an empty stream (not null)", async () => {
    const loki = windowedLoki(0, 0);
    const counts = await apiErrorCounts(loki, new Date("2026-06-11T12:00:00"));
    expect(counts).toEqual({ count15m: 0, countToday: 0 });
  });

  it("null only when Loki is unavailable (queryRange null)", async () => {
    const loki: LokiFetcher = {
      queryRange: () => Promise.resolve(null),
      isAvailable: () => false,
    };
    expect(await apiErrorCounts(loki)).toBeNull();
  });
});

describe("startOfLocalDay", () => {
  it("returns local midnight of the given instant", () => {
    const midnight = startOfLocalDay(new Date("2026-06-11T15:32:00"));
    expect(midnight.getHours()).toBe(0);
    expect(midnight.getMinutes()).toBe(0);
    expect(midnight.getSeconds()).toBe(0);
    expect(midnight.getDate()).toBe(new Date("2026-06-11T15:32:00").getDate());
  });
});
