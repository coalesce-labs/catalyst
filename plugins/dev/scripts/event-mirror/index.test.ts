// event-mirror/index.test.ts — CTL-1654 Phase 4.
// Unit tests for the fan-in/dedup core of the event-mirror daemon.
// Tests inject a fake fetchFn so no real ssh runs.
// Run: cd plugins/dev/scripts/event-mirror && bun test

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { mirrorTick, resolveHosts, type FetchFn } from "./index.ts";
import { newMirrorState, filterNewLines, extractEventId } from "./lib/state.ts";

// ── Helpers ────────────────────────────────────────────────────────────────────

function fakeEvent(id: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ id, ts: "2026-08-05T00:00:00Z", attributes: { "event.name": "test.evt" }, ...extra });
}

function makeFetch(byHost: Record<string, string[]>): FetchFn {
  return async (host, _cursor, _file) => {
    const lines = byHost[host] ?? [];
    const bytesRead = lines.reduce((acc, l) => acc + Buffer.byteLength(l + "\n", "utf8"), 0);
    return { lines, bytesRead };
  };
}

function makeCursorFetch(byHostOpts: Record<string, { lines: string[]; nextBytes: number }>): FetchFn {
  return async (host, _cursor, _file) => {
    const opts = byHostOpts[host] ?? { lines: [], nextBytes: 0 };
    return { lines: opts.lines, bytesRead: opts.nextBytes };
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("extractEventId", () => {
  test("reads .id field", () => {
    expect(extractEventId(JSON.stringify({ id: "abc" }))).toBe("abc");
  });
  test("reads .event_id field", () => {
    expect(extractEventId(JSON.stringify({ event_id: "xyz" }))).toBe("xyz");
  });
  test("reads attributes[event.id]", () => {
    expect(extractEventId(JSON.stringify({ attributes: { "event.id": "eid" } }))).toBe("eid");
  });
  test("falls back to ts:name composite", () => {
    const line = JSON.stringify({ ts: "2026-08", attributes: { "event.name": "foo" } });
    expect(extractEventId(line)).toBe("2026-08:foo");
  });
  test("returns null for unparseable line", () => {
    expect(extractEventId("not json")).toBeNull();
  });
});

describe("filterNewLines — dedup by event id", () => {
  test("appends each event id at most once", () => {
    const state = newMirrorState();
    const lineA = fakeEvent("A");
    const result = filterNewLines(state, [lineA, lineA], "2026-08.jsonl");
    expect(result).toHaveLength(1);
  });

  test("two calls with the same id — second call returns nothing", () => {
    const state = newMirrorState();
    const lineA = fakeEvent("A");
    filterNewLines(state, [lineA], "2026-08.jsonl");
    const second = filterNewLines(state, [lineA], "2026-08.jsonl");
    expect(second).toHaveLength(0);
  });

  test("resets dedup ring on file change (month rollover)", () => {
    const state = newMirrorState();
    const lineA = fakeEvent("A");
    filterNewLines(state, [lineA], "2026-07.jsonl");
    // Same id, new file → should pass through (ring reset).
    const result = filterNewLines(state, [lineA], "2026-08.jsonl");
    expect(result).toHaveLength(1);
  });

  test("lines without an id are always included", () => {
    const state = newMirrorState();
    // A line with no parseable id field.
    const noid = JSON.stringify({ ts: "x" });
    const r1 = filterNewLines(state, [noid], "2026-08.jsonl");
    const r2 = filterNewLines(state, [noid], "2026-08.jsonl");
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
  });
});

describe("mirrorTick — fan-in from multiple hosts", () => {
  function makeLocalFile(): string {
    return join(mkdtempSync(join(tmpdir(), "em-local-")), "2026-08.jsonl");
  }

  test("mirrors events from all fleet hosts", async () => {
    const state = newMirrorState();
    const localFile = makeLocalFile();
    const EV_A = fakeEvent("A");
    const EV_B = fakeEvent("B");
    const result = await mirrorTick({
      hosts: ["mini", "mini-2"],
      state,
      fetchFn: makeFetch({ mini: [EV_A], "mini-2": [EV_B] }),
      localFile,
    });
    expect(result.byHost["mini"].healthy).toBe(true);
    expect(result.byHost["mini-2"].healthy).toBe(true);
    const written = readFileSync(localFile, "utf8");
    expect(written).toContain('"A"');
    expect(written).toContain('"B"');
  });

  test("appends each event id at most once across two ticks", async () => {
    const state = newMirrorState();
    const localFile = makeLocalFile();
    const EV_A = fakeEvent("A");
    // Tick 1: append A.
    await mirrorTick({
      hosts: ["mini"],
      state,
      fetchFn: makeFetch({ mini: [EV_A] }),
      localFile,
    });
    // Tick 2: same line returned by remote (e.g. re-tail). Should NOT append again.
    await mirrorTick({
      hosts: ["mini"],
      state,
      fetchFn: makeFetch({ mini: [EV_A] }),
      localFile,
    });
    const lines = readFileSync(localFile, "utf8").split("\n").filter(Boolean);
    const aLines = lines.filter(l => l.includes('"A"'));
    expect(aLines).toHaveLength(1);
  });

  test("advances per-host cursor", async () => {
    const state = newMirrorState();
    const localFile = makeLocalFile();
    const EV_A = fakeEvent("A");
    const bytes = Buffer.byteLength(EV_A + "\n", "utf8");
    await mirrorTick({
      hosts: ["mini"],
      state,
      fetchFn: makeCursorFetch({ mini: { lines: [EV_A], nextBytes: bytes } }),
      localFile,
    });
    expect(state.byHost["mini"].cursor).toBe(bytes);
  });

  test("unreachable host degrades, does not crash mirror", async () => {
    const state = newMirrorState();
    const localFile = makeLocalFile();
    const EV_A = fakeEvent("A");
    const fetchFn: FetchFn = async (host, _cursor, _file) => {
      if (host === "dead") throw new Error("ssh: connect timeout");
      return { lines: [EV_A], bytesRead: Buffer.byteLength(EV_A + "\n", "utf8") };
    };
    const result = await mirrorTick({
      hosts: ["mini", "dead"],
      state,
      fetchFn,
      localFile,
    });
    expect(result.byHost["dead"].healthy).toBe(false);
    expect(result.byHost["mini"].healthy).toBe(true);
    // Events from mini still arrived.
    const written = readFileSync(localFile, "utf8");
    expect(written).toContain('"A"');
  });

  test("empty hosts list: no errors, no writes", async () => {
    const state = newMirrorState();
    const localFile = makeLocalFile();
    const result = await mirrorTick({
      hosts: [],
      state,
      fetchFn: makeFetch({}),
      localFile,
    });
    expect(result.appended).toBe(0);
    expect(existsSync(localFile)).toBe(false);
  });
});

describe("resolveHosts — roster resolution", () => {
  // Snapshot + restore the env keys resolveHosts reads, so these tests don't
  // leak into the rest of the suite.
  const ENV_KEYS = [
    "CATALYST_EVENT_MIRROR_HOSTS",
    "CATALYST_CLUSTER_JSON",
    "CATALYST_HOST_NAME",
  ] as const;
  let saved: Record<string, string | undefined>;
  let tmp: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "resolvehosts-"));
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const withEnv = (env: Record<string, string | undefined>, fn: () => void) => {
    saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try { fn(); }
    finally {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k]!;
      }
    }
  };

  test("CATALYST_EVENT_MIRROR_HOSTS wins, trimmed + empties dropped", () => {
    withEnv({ CATALYST_EVENT_MIRROR_HOSTS: " mini , mini-2 ,, " }, () => {
      expect(resolveHosts()).toEqual(["mini", "mini-2"]);
    });
  });

  test("cluster.json fallback returns roster minus self (CATALYST_HOST_NAME)", () => {
    const clusterPath = join(tmp, "cluster.json");
    writeFileSync(clusterPath, JSON.stringify({ roster: ["mini", "mini-2", "studio"] }));
    withEnv({ CATALYST_CLUSTER_JSON: clusterPath, CATALYST_HOST_NAME: "mini" }, () => {
      expect(resolveHosts()).toEqual(["mini-2", "studio"]);
    });
  });

  test("cluster.json fallback resolves self via os.hostname() when CATALYST_HOST_NAME unset", () => {
    // Regression guard for the CTL-1654 remediate fix: the fallback used the
    // non-existent Bun.hostname(), which threw and made resolveHosts() return [].
    // With os.hostname() the path stays live even without CATALYST_HOST_NAME.
    const self = hostname();
    const clusterPath = join(tmp, "cluster-self.json");
    writeFileSync(clusterPath, JSON.stringify({ roster: [self, "peer-a", "peer-b"] }));
    withEnv({ CATALYST_CLUSTER_JSON: clusterPath }, () => {
      expect(resolveHosts()).toEqual(["peer-a", "peer-b"]);
    });
  });

  test("no env hosts and no cluster.json → empty", () => {
    withEnv({ CATALYST_CLUSTER_JSON: join(tmp, "does-not-exist.json") }, () => {
      expect(resolveHosts()).toEqual([]);
    });
  });
});
