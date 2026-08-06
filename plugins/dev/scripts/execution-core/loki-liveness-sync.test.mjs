// loki-liveness-sync.test.mjs — CTL-1420 (#17). The synchronous spawnSync bridge
// over the loki-liveness CLI, with an injected `spawn` (no real subprocess).
//
// Run: cd plugins/dev/scripts/execution-core && bun test loki-liveness-sync.test.mjs

import { describe, test, expect, beforeEach } from "bun:test";
import {
  readClusterLivenessFromLokiSync,
  readClusterLivenessFromLokiSyncCached,
  clearLokiLivenessCache,
} from "./loki-liveness-sync.mjs";

const okSpawn = (map) => () => ({ status: 0, stdout: JSON.stringify(map) + "\n", stderr: "" });

describe("readClusterLivenessFromLokiSync (CTL-1420 #17) — fail-open", () => {
  test("no lokiUrl → {} with ZERO spawn", () => {
    let spawned = false;
    const spawn = () => { spawned = true; return { status: 0, stdout: "{}" }; };
    expect(readClusterLivenessFromLokiSync({ lokiUrl: "" }, { spawn })).toEqual({});
    expect(spawned).toBe(false);
  });

  test("successful subprocess → parsed peer map", () => {
    const map = { mini: { last_seen: "2026-07-07T19:04:50.000Z", in_flight_tickets: ["CTL-1"] } };
    const out = readClusterLivenessFromLokiSync({ lokiUrl: "http://loki:3100" }, { spawn: okSpawn(map) });
    expect(out).toEqual(map);
  });

  test("non-zero exit → {}", () => {
    const spawn = () => ({ status: 1, stdout: "", stderr: "boom" });
    expect(readClusterLivenessFromLokiSync({ lokiUrl: "http://loki:3100" }, { spawn })).toEqual({});
  });

  test("unparseable stdout → {}", () => {
    const spawn = () => ({ status: 0, stdout: "not json\n" });
    expect(readClusterLivenessFromLokiSync({ lokiUrl: "http://loki:3100" }, { spawn })).toEqual({});
  });

  test("array stdout (not an object map) → {}", () => {
    const spawn = () => ({ status: 0, stdout: "[1,2,3]\n" });
    expect(readClusterLivenessFromLokiSync({ lokiUrl: "http://loki:3100" }, { spawn })).toEqual({});
  });

  test("spawn throws (e.g. ENOENT) → {}", () => {
    const spawn = () => { throw new Error("ENOENT"); };
    expect(readClusterLivenessFromLokiSync({ lokiUrl: "http://loki:3100" }, { spawn })).toEqual({});
  });

  // CTL-1091 (Codex P1 follow-up): strict mode surfaces a determinate FAILURE as a
  // throw (dispatch → full-roster outage fallback) while still returning {} on a
  // genuinely-empty successful read. Default (non-strict) fail-open above unchanged.
  describe("strict mode (CTL-1091 P1 follow-up)", () => {
    test("strict + missing lokiUrl → THROWS", () => {
      expect(() => readClusterLivenessFromLokiSync({ lokiUrl: "" }, { spawn: () => ({}), strict: true })).toThrow(
        /indeterminate peer view/i,
      );
    });

    test("strict + non-zero exit → THROWS", () => {
      const spawn = () => ({ status: 1, stdout: "", stderr: "boom" });
      expect(() => readClusterLivenessFromLokiSync({ lokiUrl: "http://loki:3100" }, { spawn, strict: true })).toThrow(
        /indeterminate peer view/i,
      );
    });

    test("strict + spawn throws → THROWS (original error preserved)", () => {
      const spawn = () => { throw new Error("ENOENT"); };
      expect(() => readClusterLivenessFromLokiSync({ lokiUrl: "http://loki:3100" }, { spawn, strict: true })).toThrow(
        /ENOENT/,
      );
    });

    test("strict + array/non-object payload → THROWS", () => {
      const spawn = () => ({ status: 0, stdout: "[1,2,3]\n" });
      expect(() => readClusterLivenessFromLokiSync({ lokiUrl: "http://loki:3100" }, { spawn, strict: true })).toThrow(
        /malformed payload/i,
      );
    });

    test("strict + status 0 empty stdout → {} (genuine empty, NOT a failure)", () => {
      const spawn = () => ({ status: 0, stdout: "" });
      expect(readClusterLivenessFromLokiSync({ lokiUrl: "http://loki:3100" }, { spawn, strict: true })).toEqual({});
    });

    test("strict + valid peers → returns peers (happy path unaffected)", () => {
      const map = { mini: { last_seen: "2026-07-07T19:04:50.000Z", in_flight_tickets: [] } };
      expect(
        readClusterLivenessFromLokiSync({ lokiUrl: "http://loki:3100" }, { spawn: okSpawn(map), strict: true }),
      ).toEqual(map);
    });
  });
});

describe("readClusterLivenessFromLokiSyncCached (CTL-1420 #17)", () => {
  beforeEach(() => clearLokiLivenessCache());

  test("caches a non-empty result within the TTL (second call does not spawn)", () => {
    let spawnCount = 0;
    const map = { mini: { last_seen: "2026-07-07T19:04:50.000Z", in_flight_tickets: [] } };
    const spawn = () => { spawnCount += 1; return { status: 0, stdout: JSON.stringify(map) + "\n" }; };
    const t = 1_000_000;
    const a = readClusterLivenessFromLokiSyncCached({ lokiUrl: "u" }, { spawn, now: () => t });
    const b = readClusterLivenessFromLokiSyncCached({ lokiUrl: "u" }, { spawn, now: () => t + 5_000 });
    expect(a).toEqual(map);
    expect(b).toEqual(map);
    expect(spawnCount).toBe(1); // second call served from cache
  });

  test("does NOT cache an empty {} (a failed read must retry, not latch)", () => {
    let spawnCount = 0;
    const spawn = () => { spawnCount += 1; return { status: 1, stdout: "" }; };
    readClusterLivenessFromLokiSyncCached({ lokiUrl: "u" }, { spawn, now: () => 1 });
    readClusterLivenessFromLokiSyncCached({ lokiUrl: "u" }, { spawn, now: () => 2 });
    expect(spawnCount).toBe(2); // no latch — each call retries
  });

  test("cache disabled (EXECUTION_CORE_LOKI_LIVENESS_CACHE_MS=0) always spawns", () => {
    let spawnCount = 0;
    const map = { mini: { last_seen: "x", in_flight_tickets: [] } };
    const spawn = () => { spawnCount += 1; return { status: 0, stdout: JSON.stringify(map) + "\n" }; };
    const env = { EXECUTION_CORE_LOKI_LIVENESS_CACHE_MS: "0" };
    readClusterLivenessFromLokiSyncCached({ lokiUrl: "u" }, { spawn, env, now: () => 1 });
    readClusterLivenessFromLokiSyncCached({ lokiUrl: "u" }, { spawn, env, now: () => 1 });
    expect(spawnCount).toBe(2);
  });
});
