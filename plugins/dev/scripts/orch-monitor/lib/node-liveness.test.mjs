// node-liveness.test.mjs — CTL-1255. mergeHeartbeatsNewestWins coverage.
//
// Run: cd plugins/dev/scripts/orch-monitor && bun test lib/node-liveness.test.mjs

import { describe, test, expect } from "bun:test";
import { mergeHeartbeatsNewestWins } from "./node-liveness.mjs";

describe("mergeHeartbeatsNewestWins (CTL-1255)", () => {
  test("self host keeps the FRESHER local timestamp over a stale anchor one", () => {
    const local = { mini: "2026-06-13T00:01:00Z" };  // fresh local log
    const anchor = { mini: "2026-06-13T00:00:00Z" };  // older anchor publish
    expect(mergeHeartbeatsNewestWins(local, anchor).mini).toBe("2026-06-13T00:01:00Z");
  });

  test("anchor wins when it is newer than local", () => {
    const local = { mini: "2026-06-13T00:00:00Z" };
    const anchor = { mini: "2026-06-13T00:05:00Z" };
    expect(mergeHeartbeatsNewestWins(local, anchor).mini).toBe("2026-06-13T00:05:00Z");
  });

  test("peer present only in the anchor is surfaced", () => {
    const out = mergeHeartbeatsNewestWins({ mini: "2026-06-13T00:00:00Z" }, { "mini-2": "2026-06-13T00:00:05Z" });
    expect(Object.keys(out).sort()).toEqual(["mini", "mini-2"]);
  });

  test("ignores empty / non-string timestamps and bad maps", () => {
    const out = mergeHeartbeatsNewestWins({ a: "" }, null, { b: 42 }, { c: "2026-06-13T00:00:00Z" });
    expect(out).toEqual({ c: "2026-06-13T00:00:00Z" });
  });

  test("a parseable timestamp beats an unparseable earlier one", () => {
    const out = mergeHeartbeatsNewestWins({ x: "not-a-date" }, { x: "2026-06-13T00:00:00Z" });
    expect(out.x).toBe("2026-06-13T00:00:00Z");
  });
});
