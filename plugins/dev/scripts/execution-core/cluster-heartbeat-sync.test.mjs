// cluster-heartbeat-sync.test.mjs — synchronous bridge over cluster-heartbeat CLI
// (CTL-1090). Every test injects a fake `spawn` so nothing forks a process.
// Mirrors cluster-claim-sync.test.mjs in structure and fail-open contract.
import { describe, test, expect, beforeEach } from "bun:test";
import {
  publishHeartbeatSync,
  readPeerHeartbeatsSync,
  resolveAnchorIssueIdSync,
  resolveAnchorIssueIdSyncCached,
  clearAnchorUuidCache,
  readPeerHeartbeatsSyncCached,
  clearHeartbeatReadCache,
} from "./cluster-heartbeat-sync.mjs";

describe("publishHeartbeatSync — argv + fail-open contract", () => {
  test("returns ok:true and forwards anchor/host/tickets to the CLI", () => {
    let captured;
    const spawn = (bin, args) => {
      captured = args;
      return {
        status: 0,
        stdout: JSON.stringify({ host: "mini", last_seen: "t", in_flight_tickets: [] }) + "\n",
      };
    };
    const result = publishHeartbeatSync(
      { anchorIssue: "CTL-9", host: "mini", inFlightTickets: [] },
      { spawn },
    );
    expect(result.ok).toBe(true);
    expect(captured).toContain("publish");
    expect(captured).toContain("CTL-9");
    expect(captured).toContain("mini");
  });

  test("passes tickets as a comma-separated string", () => {
    let captured;
    const spawn = (bin, args) => {
      captured = args;
      return {
        status: 0,
        stdout:
          JSON.stringify({ host: "mini", last_seen: "t", in_flight_tickets: ["CTL-1", "CTL-2"] }) +
          "\n",
      };
    };
    publishHeartbeatSync(
      { anchorIssue: "CTL-9", host: "mini", inFlightTickets: ["CTL-1", "CTL-2"] },
      { spawn },
    );
    expect(captured).toContain("CTL-1,CTL-2");
  });

  test("builds the right argv: <node> <cli> publish <anchor> <host> <tickets>", () => {
    let capturedBin, capturedArgs;
    const spawn = (bin, args) => {
      capturedBin = bin;
      capturedArgs = args;
      return { status: 0, stdout: '{"host":"mini","last_seen":"t","in_flight_tickets":[]}\n' };
    };
    publishHeartbeatSync(
      { anchorIssue: "CTL-9", host: "mini", inFlightTickets: [] },
      { spawn, nodeBin: "/usr/bin/node", cli: "/x/cluster-heartbeat.mjs" },
    );
    expect(capturedBin).toBe("/usr/bin/node");
    expect(capturedArgs[0]).toBe("/x/cluster-heartbeat.mjs");
    expect(capturedArgs[1]).toBe("publish");
    expect(capturedArgs[2]).toBe("CTL-9");
    expect(capturedArgs[3]).toBe("mini");
  });

  test("CTL-1092: appends maxParallel as the 4th positional arg when it is a positive int", () => {
    let capturedArgs;
    const spawn = (_bin, args) => {
      capturedArgs = args;
      return { status: 0, stdout: '{"host":"mini","last_seen":"t","in_flight_tickets":[],"max_parallel":3}\n' };
    };
    publishHeartbeatSync(
      { anchorIssue: "CTL-9", host: "mini", inFlightTickets: ["CTL-1"], maxParallel: 3 },
      { spawn },
    );
    // argv: [cli, "publish", anchor, host, ticketsCsv, maxParallel]
    expect(capturedArgs[4]).toBe("CTL-1");
    expect(capturedArgs[5]).toBe("3");
  });

  test("CTL-1092: omits maxParallel (back-compat 3-arg form) when null/absent/non-positive", () => {
    const grab = (args) => {
      let captured;
      const spawn = (_bin, a) => {
        captured = a;
        return { status: 0, stdout: '{"host":"mini","last_seen":"t","in_flight_tickets":[]}\n' };
      };
      publishHeartbeatSync({ anchorIssue: "CTL-9", host: "mini", inFlightTickets: [], ...args }, { spawn });
      return captured;
    };
    // ticketsCsv is "" here, so a present maxParallel would be argv[5]; none must be appended.
    expect(grab({}).length).toBe(5); // no maxParallel
    expect(grab({ maxParallel: null }).length).toBe(5);
    expect(grab({ maxParallel: 0 }).length).toBe(5);
    expect(grab({ maxParallel: -1 }).length).toBe(5);
    expect(grab({ maxParallel: 2.5 }).length).toBe(5);
    expect(grab({ maxParallel: 4 }).length).toBe(6); // positive int → appended
  });

  test("fail-open: non-zero exit → ok:false (never throws)", () => {
    const spawn = () => ({ status: 1, stdout: "" });
    expect(publishHeartbeatSync({ anchorIssue: "CTL-9", host: "mini" }, { spawn }).ok).toBe(false);
  });

  test("fail-open: spawn throws → ok:false (never throws)", () => {
    const spawn = () => {
      throw new Error("EACCES");
    };
    expect(publishHeartbeatSync({ anchorIssue: "CTL-9", host: "mini" }, { spawn }).ok).toBe(false);
  });

  test("fail-open: unparseable stdout → ok:false", () => {
    const spawn = () => ({ status: 0, stdout: "not json" });
    expect(publishHeartbeatSync({ anchorIssue: "CTL-9", host: "mini" }, { spawn }).ok).toBe(false);
  });

  test("fail-open: timeout (status null) → ok:false", () => {
    const spawn = () => ({ status: null, error: new Error("ETIMEDOUT"), stdout: null });
    expect(publishHeartbeatSync({ anchorIssue: "CTL-9", host: "mini" }, { spawn }).ok).toBe(false);
  });

  test("defaults inFlightTickets to [] when omitted", () => {
    let capturedArgs;
    const spawn = (bin, args) => {
      capturedArgs = args;
      return { status: 0, stdout: '{"host":"mini","last_seen":"t","in_flight_tickets":[]}\n' };
    };
    publishHeartbeatSync({ anchorIssue: "CTL-9", host: "mini" }, { spawn });
    // the CSV arg should be an empty string for no tickets
    const csvArg = capturedArgs[capturedArgs.length - 1];
    expect(csvArg).toBe("");
  });

  // CTL-1251: failures now carry a diagnostic `error` reason (still fail-open).
  test("non-zero exit surfaces exit code + stderr tail in error", () => {
    const spawn = () => ({ status: 2, stdout: "", stderr: "Linear 401 Unauthorized\n" });
    const r = publishHeartbeatSync({ anchorIssue: "CTL-9", host: "mini" }, { spawn });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("exit 2");
    expect(r.error).toContain("401 Unauthorized");
  });

  test("timeout (status null, res.error set) surfaces the spawn error", () => {
    const spawn = () => ({ status: null, error: new Error("ETIMEDOUT"), stdout: null });
    const r = publishHeartbeatSync({ anchorIssue: "CTL-9", host: "mini" }, { spawn });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("ETIMEDOUT");
  });

  test("spawn throw surfaces the thrown message in error", () => {
    const spawn = () => { throw new Error("EACCES"); };
    const r = publishHeartbeatSync({ anchorIssue: "CTL-9", host: "mini" }, { spawn });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("EACCES");
  });

  test("unparseable stdout → ok:false with an error reason", () => {
    const spawn = () => ({ status: 0, stdout: "not json" });
    const r = publishHeartbeatSync({ anchorIssue: "CTL-9", host: "mini" }, { spawn });
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe("string");
  });

  test("stderr is truncated so a noisy subprocess can't bloat the log line", () => {
    const spawn = () => ({ status: 1, stdout: "", stderr: "x".repeat(5000) });
    const r = publishHeartbeatSync({ anchorIssue: "CTL-9", host: "mini" }, { spawn });
    expect(r.error.length).toBeLessThan(260); // ~200 stderr tail + "exit 1: " prefix
  });
});

describe("readPeerHeartbeatsSync — parsing + fail-open contract", () => {
  test("parses and returns the CLI map", () => {
    const map = {
      mini: { host: "mini", last_seen: "2026-06-13T01:00:00Z", in_flight_tickets: [] },
    };
    const spawn = () => ({ status: 0, stdout: JSON.stringify(map) + "\n" });
    expect(readPeerHeartbeatsSync({ anchorIssue: "CTL-9" }, { spawn })).toEqual(map);
  });

  test("builds the right argv: <node> <cli> read <anchor>", () => {
    let capturedBin, capturedArgs;
    const spawn = (bin, args) => {
      capturedBin = bin;
      capturedArgs = args;
      return { status: 0, stdout: "{}\n" };
    };
    readPeerHeartbeatsSync(
      { anchorIssue: "CTL-9" },
      { spawn, nodeBin: "/usr/bin/node", cli: "/x/cluster-heartbeat.mjs" },
    );
    expect(capturedBin).toBe("/usr/bin/node");
    expect(capturedArgs).toEqual(["/x/cluster-heartbeat.mjs", "read", "CTL-9"]);
  });

  test("unparseable stdout → {}", () => {
    expect(
      readPeerHeartbeatsSync({ anchorIssue: "CTL-9" }, { spawn: () => ({ status: 0, stdout: "not json" }) }),
    ).toEqual({});
  });

  test("empty stdout → {}", () => {
    expect(
      readPeerHeartbeatsSync({ anchorIssue: "CTL-9" }, { spawn: () => ({ status: 0, stdout: "" }) }),
    ).toEqual({});
  });

  test("non-zero exit → {}", () => {
    expect(
      readPeerHeartbeatsSync({ anchorIssue: "CTL-9" }, { spawn: () => ({ status: 1, stdout: "" }) }),
    ).toEqual({});
  });

  test("spawn throws → {}", () => {
    expect(
      readPeerHeartbeatsSync(
        { anchorIssue: "CTL-9" },
        {
          spawn: () => {
            throw new Error("ENOENT");
          },
        },
      ),
    ).toEqual({});
  });

  test("timeout / status null → {}", () => {
    expect(
      readPeerHeartbeatsSync(
        { anchorIssue: "CTL-9" },
        { spawn: () => ({ status: null, error: new Error("ETIMEDOUT"), stdout: null }) },
      ),
    ).toEqual({});
  });

  test("array stdout (non-object) → {}", () => {
    expect(
      readPeerHeartbeatsSync(
        { anchorIssue: "CTL-9" },
        { spawn: () => ({ status: 0, stdout: "[]\n" }) },
      ),
    ).toEqual({});
  });

  // CTL-1091 (Codex P1 follow-up): strict mode must THROW on a determinate read
  // FAILURE (so the dispatch liveness path degrades to the full roster) but still
  // return {} on a genuinely-EMPTY successful read (so legitimate all-peers-absent
  // failover is preserved). The default (non-strict) fail-open above is unchanged.
  describe("strict mode (CTL-1091 P1 follow-up)", () => {
    test("strict + non-zero exit → THROWS", () => {
      expect(() =>
        readPeerHeartbeatsSync({ anchorIssue: "CTL-9" }, { spawn: () => ({ status: 1, stdout: "" }), strict: true }),
      ).toThrow(/indeterminate peer view/i);
    });

    test("strict + timeout (status null) → THROWS", () => {
      expect(() =>
        readPeerHeartbeatsSync(
          { anchorIssue: "CTL-9" },
          { spawn: () => ({ status: null, error: new Error("ETIMEDOUT"), stdout: null }), strict: true },
        ),
      ).toThrow(/indeterminate peer view/i);
    });

    test("strict + spawn throws → THROWS (original error preserved)", () => {
      expect(() =>
        readPeerHeartbeatsSync(
          { anchorIssue: "CTL-9" },
          { spawn: () => { throw new Error("ENOENT"); }, strict: true },
        ),
      ).toThrow(/ENOENT/);
    });

    test("strict + unparseable stdout → THROWS", () => {
      expect(() =>
        readPeerHeartbeatsSync({ anchorIssue: "CTL-9" }, { spawn: () => ({ status: 0, stdout: "not json" }), strict: true }),
      ).toThrow();
    });

    test("strict + non-object payload → THROWS", () => {
      expect(() =>
        readPeerHeartbeatsSync({ anchorIssue: "CTL-9" }, { spawn: () => ({ status: 0, stdout: "[]\n" }), strict: true }),
      ).toThrow(/malformed payload/i);
    });

    test("strict + status 0 empty stdout → {} (genuine empty, NOT a failure)", () => {
      expect(
        readPeerHeartbeatsSync({ anchorIssue: "CTL-9" }, { spawn: () => ({ status: 0, stdout: "" }), strict: true }),
      ).toEqual({});
    });

    test("strict + status 0 valid peers → returns peers (happy path unaffected)", () => {
      const map = { mini: { host: "mini", last_seen: "t", in_flight_tickets: [] } };
      expect(
        readPeerHeartbeatsSync(
          { anchorIssue: "CTL-9" },
          { spawn: () => ({ status: 0, stdout: JSON.stringify(map) + "\n" }), strict: true },
        ),
      ).toEqual(map);
    });
  });
});

describe("resolveAnchorIssueIdSync — argv + parsing (CTL-863 entourage follow-up)", () => {
  test("builds the right argv: <node> <cli> resolve-anchor <anchor>", () => {
    let capturedBin, capturedArgs;
    const spawn = (bin, args) => {
      capturedBin = bin;
      capturedArgs = args;
      return { status: 0, stdout: '{"issueId":"uuid-anchor"}\n' };
    };
    resolveAnchorIssueIdSync(
      { anchorIssue: "CTL-9999" },
      { spawn, nodeBin: "/usr/bin/node", cli: "/x/cluster-heartbeat.mjs" },
    );
    expect(capturedBin).toBe("/usr/bin/node");
    expect(capturedArgs).toEqual(["/x/cluster-heartbeat.mjs", "resolve-anchor", "CTL-9999"]);
  });

  test("parses the resolved UUID from stdout", () => {
    const spawn = () => ({ status: 0, stdout: '{"issueId":"uuid-anchor"}\n' });
    expect(resolveAnchorIssueIdSync({ anchorIssue: "CTL-9999" }, { spawn })).toBe("uuid-anchor");
  });

  test("a null issueId (unresolvable anchor) → null", () => {
    const spawn = () => ({ status: 0, stdout: '{"issueId":null}\n' });
    expect(resolveAnchorIssueIdSync({ anchorIssue: "CTL-9999" }, { spawn })).toBeNull();
  });

  test("non-zero exit / spawn error / unparseable stdout / throw → null (fail-open)", () => {
    expect(resolveAnchorIssueIdSync({ anchorIssue: "CTL-9999" }, { spawn: () => ({ status: 1, stdout: "" }) })).toBeNull();
    expect(
      resolveAnchorIssueIdSync({ anchorIssue: "CTL-9999" }, { spawn: () => ({ status: null, error: new Error("ETIMEDOUT") }) }),
    ).toBeNull();
    expect(
      resolveAnchorIssueIdSync({ anchorIssue: "CTL-9999" }, { spawn: () => ({ status: 0, stdout: "not json" }) }),
    ).toBeNull();
    expect(
      resolveAnchorIssueIdSync({ anchorIssue: "CTL-9999" }, { spawn: () => { throw new Error("EACCES"); } }),
    ).toBeNull();
  });
});

describe("resolveAnchorIssueIdSyncCached — permanent identifier→UUID cache (CTL-863 entourage follow-up)", () => {
  beforeEach(() => {
    clearAnchorUuidCache();
  });

  test("(a) two resolves of the same anchor → ONE underlying spawn call", () => {
    let calls = 0;
    const spawn = () => {
      calls += 1;
      return { status: 0, stdout: '{"issueId":"uuid-anchor-1"}\n' };
    };
    const first = resolveAnchorIssueIdSyncCached({ anchorIssue: "CTL-1001" }, { spawn });
    const second = resolveAnchorIssueIdSyncCached({ anchorIssue: "CTL-1001" }, { spawn });
    expect(first).toBe("uuid-anchor-1");
    expect(second).toBe("uuid-anchor-1");
    expect(calls).toBe(1); // second call served from the permanent cache, no spawn
  });

  test("persists beyond any TTL window — no expiry, ever (permanent cache)", () => {
    let calls = 0;
    const spawn = () => {
      calls += 1;
      return { status: 0, stdout: '{"issueId":"uuid-anchor-2"}\n' };
    };
    let now = 1_000_000;
    resolveAnchorIssueIdSyncCached({ anchorIssue: "CTL-1002" }, { spawn, now: () => now });
    now += 10 * 24 * 60 * 60 * 1000; // 10 days later — far past any TTL a read cache would use
    resolveAnchorIssueIdSyncCached({ anchorIssue: "CTL-1002" }, { spawn, now: () => now });
    expect(calls).toBe(1); // still cached — this cache has no TTL at all
  });

  test("CATALYST_ANCHOR_UUID_CACHE=0 disables the cache — every resolve hits through", () => {
    let calls = 0;
    const spawn = () => {
      calls += 1;
      return { status: 0, stdout: '{"issueId":"uuid-anchor-3"}\n' };
    };
    const env = { CATALYST_ANCHOR_UUID_CACHE: "0" };
    resolveAnchorIssueIdSyncCached({ anchorIssue: "CTL-1003" }, { spawn, env });
    resolveAnchorIssueIdSyncCached({ anchorIssue: "CTL-1003" }, { spawn, env });
    expect(calls).toBe(2); // cache fully disabled — no memoization at all
  });

  test("a failed/null resolution is NEVER cached — the next call retries for real", () => {
    let calls = 0;
    const spawn = () => {
      calls += 1;
      return { status: 1, stdout: "" }; // non-zero exit → resolution failure
    };
    const first = resolveAnchorIssueIdSyncCached({ anchorIssue: "CTL-1004" }, { spawn });
    const second = resolveAnchorIssueIdSyncCached({ anchorIssue: "CTL-1004" }, { spawn });
    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(calls).toBe(2); // NOT cached — both calls spawned
  });
});

describe("publishHeartbeatSync — pre-resolved issueId threaded into the publish argv (CTL-863 entourage follow-up)", () => {
  beforeEach(() => {
    clearAnchorUuidCache();
  });

  test("a successful pre-resolve appends the UUID as the publish CLI's 5th arg", () => {
    let publishArgs;
    const spawn = (bin, args) => {
      if (args[1] === "resolve-anchor") {
        return { status: 0, stdout: '{"issueId":"uuid-anchor-5"}\n' };
      }
      publishArgs = args;
      return { status: 0, stdout: '{"host":"mini","last_seen":"t","in_flight_tickets":[]}\n' };
    };
    publishHeartbeatSync(
      { anchorIssue: "CTL-1005", host: "mini" },
      { spawn, nodeBin: "/usr/bin/node", cli: "/x/cluster-heartbeat.mjs" },
    );
    // argv: [cli, "publish", anchor, host, ticketsCsv, maxParallelPlaceholder, issueId] —
    // the maxParallel slot is kept as an empty-string placeholder ahead of issueId.
    expect(publishArgs).toEqual(["/x/cluster-heartbeat.mjs", "publish", "CTL-1005", "mini", "", "", "uuid-anchor-5"]);
  });

  test("a failed pre-resolve falls back to the plain 4-arg publish form (unchanged behavior)", () => {
    let publishArgs;
    const spawn = (bin, args) => {
      if (args[1] === "resolve-anchor") {
        return { status: 1, stdout: "" }; // resolution fails
      }
      publishArgs = args;
      return { status: 0, stdout: '{"host":"mini","last_seen":"t","in_flight_tickets":[]}\n' };
    };
    publishHeartbeatSync(
      { anchorIssue: "CTL-1006", host: "mini" },
      { spawn, nodeBin: "/usr/bin/node", cli: "/x/cluster-heartbeat.mjs" },
    );
    expect(publishArgs).toEqual(["/x/cluster-heartbeat.mjs", "publish", "CTL-1006", "mini", ""]);
  });
});

describe("readPeerHeartbeatsSyncCached — 45s TTL cache around the peer-liveness read (CTL-863 entourage follow-up)", () => {
  beforeEach(() => {
    clearHeartbeatReadCache();
  });

  const peerMap = { mini: { host: "mini", last_seen: "2026-06-13T01:00:00Z", in_flight_tickets: [] } };

  test("(a) two reads within TTL for the same anchor → ONE underlying spawn call", () => {
    let calls = 0;
    const spawn = () => {
      calls += 1;
      return { status: 0, stdout: JSON.stringify(peerMap) + "\n" };
    };
    let now = 1_000_000;
    const first = readPeerHeartbeatsSyncCached({ anchorIssue: "CTL-2001" }, { spawn, now: () => now });
    now += 1_000; // 1s later — well within the 45s default TTL
    const second = readPeerHeartbeatsSyncCached({ anchorIssue: "CTL-2001" }, { spawn, now: () => now });
    expect(first).toEqual(peerMap);
    expect(second).toEqual(peerMap);
    expect(calls).toBe(1); // second call served from cache, no spawn
  });

  test("(b) after TTL expiry → a fresh read (spawn called again)", () => {
    let calls = 0;
    const spawn = () => {
      calls += 1;
      return { status: 0, stdout: JSON.stringify(peerMap) + "\n" };
    };
    let now = 1_000_000;
    readPeerHeartbeatsSyncCached({ anchorIssue: "CTL-2002" }, { spawn, now: () => now, env: { CATALYST_FENCE_READ_CACHE_MS: "45000" } });
    now += 45_001; // just past the 45s TTL
    readPeerHeartbeatsSyncCached({ anchorIssue: "CTL-2002" }, { spawn, now: () => now, env: { CATALYST_FENCE_READ_CACHE_MS: "45000" } });
    expect(calls).toBe(2); // TTL expired → the second call re-spawned
  });

  test("(c) CATALYST_FENCE_READ_CACHE_MS=0 disables the cache — every read hits through", () => {
    let calls = 0;
    const spawn = () => {
      calls += 1;
      return { status: 0, stdout: JSON.stringify(peerMap) + "\n" };
    };
    const env = { CATALYST_FENCE_READ_CACHE_MS: "0" };
    const now = () => 1_000_000; // frozen clock — proves it's the env flag, not elapsed time
    readPeerHeartbeatsSyncCached({ anchorIssue: "CTL-2003" }, { spawn, env, now });
    readPeerHeartbeatsSyncCached({ anchorIssue: "CTL-2003" }, { spawn, env, now });
    readPeerHeartbeatsSyncCached({ anchorIssue: "CTL-2003" }, { spawn, env, now });
    expect(calls).toBe(3); // cache fully disabled — no memoization at all
  });

  test("(d) an empty/error result is NEVER cached — the next call retries the real read", () => {
    let calls = 0;
    const spawn = () => {
      calls += 1;
      return { status: 1, stdout: "" }; // non-zero exit → the {} fail-open shape
    };
    const now = () => 1_000_000; // frozen clock — within TTL, so only caching (not expiry) explains a re-spawn
    const first = readPeerHeartbeatsSyncCached({ anchorIssue: "CTL-2004" }, { spawn, now });
    const second = readPeerHeartbeatsSyncCached({ anchorIssue: "CTL-2004" }, { spawn, now });
    expect(first).toEqual({});
    expect(second).toEqual({});
    expect(calls).toBe(2); // NOT cached — both calls spawned
  });

  test("different anchors are NOT interchangeable — each gets its own read + cache slot", () => {
    const seen = [];
    const spawn = (bin, args) => {
      seen.push(args[2]); // the anchor argv
      return { status: 0, stdout: JSON.stringify(peerMap) + "\n" };
    };
    const now = () => 1_000_000;
    readPeerHeartbeatsSyncCached({ anchorIssue: "CTL-2005" }, { spawn, now });
    readPeerHeartbeatsSyncCached({ anchorIssue: "CTL-2006" }, { spawn, now });
    expect(seen).toEqual(["CTL-2005", "CTL-2006"]); // both spawned — distinct cache keys
  });

  test("falls through to a real readPeerHeartbeatsSync on a cache miss (argv unchanged)", () => {
    let captured;
    const spawn = (bin, args) => {
      captured = { bin, args };
      return { status: 0, stdout: JSON.stringify(peerMap) + "\n" };
    };
    const now = () => 1_000_000;
    readPeerHeartbeatsSyncCached(
      { anchorIssue: "CTL-2007" },
      { spawn, now, nodeBin: "/usr/bin/node", cli: "/x/cluster-heartbeat.mjs" },
    );
    expect(captured.bin).toBe("/usr/bin/node");
    expect(captured.args).toEqual(["/x/cluster-heartbeat.mjs", "read", "CTL-2007"]);
  });
});
