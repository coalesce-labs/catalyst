// event-mirror/index.test.ts — CTL-1654 Phase 4.
// Unit tests for the fan-in/dedup core of the event-mirror daemon.
// Tests inject a fake fetchFn so no real ssh runs.
// Run: cd plugins/dev/scripts/event-mirror && bun test

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { pickRemoteFile, mirrorTick, resolveHosts, type FetchFn } from "./index.ts";
import { newMirrorState, filterNewLines, extractEventId, migrateHostState } from "./lib/state.ts";
import type { MirrorState } from "./lib/state.ts";

// CTL-1216: cursors are keyed by remote FILENAME now. These tests inject no
// listFn, so every host resolves to the one locally-computed name — assert that
// there is exactly ONE cursor as well as its value, since "the cursor is right"
// would also be satisfied by a map that quietly grew a second entry per tick.
function soleCursor(state: MirrorState, host: string): number {
  const cursors = state.byHost[host].cursors;
  const keys = Object.keys(cursors);
  expect(keys.length).toBe(1);
  return cursors[keys[0]];
}


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
  // CTL-1812: this USED to return the `${ts}:${name}` composite. That is not an
  // identity — two distinct events sharing a timestamp and a name collided, and the
  // second was silently dropped as a duplicate. Measured: 35,931 real events suppressed
  // across the two worker logs, 100% via this path. There is now no fallback id, and the
  // caller's conservative path includes the line instead.
  test("an event with no real id has NO fallback id — it must not be synthesised", () => {
    const line = JSON.stringify({ ts: "2026-08", attributes: { "event.name": "foo" } });
    expect(extractEventId(line)).toBeNull();
  });

  test("two DISTINCT events sharing ts and name are not collapsed", () => {
    const a = JSON.stringify({ ts: "2026-08", attributes: { "event.name": "foo" }, body: { n: 1 } });
    const b = JSON.stringify({ ts: "2026-08", attributes: { "event.name": "foo" }, body: { n: 2 } });
    const state = newMirrorState();
    const out = filterNewLines(state, [a, b], "2026-08.jsonl");
    expect(out).toHaveLength(2);
  });

  // POSITIVE CONTROL — a real id still dedups, so the test above is proving the fallback
  // was removed rather than that dedup stopped working altogether.
  test("a real event id still dedups", () => {
    const line = JSON.stringify({ id: "real-1", ts: "2026-08" });
    const state = newMirrorState();
    expect(filterNewLines(state, [line], "2026-08.jsonl")).toHaveLength(1);
    expect(filterNewLines(state, [line], "2026-08.jsonl")).toHaveLength(0);
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
    expect(soleCursor(state, "mini")).toBe(bytes);
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
    "CATALYST_CLUSTER_DIR",
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

  test("CATALYST_CLUSTER_DIR is honored for the roster fallback (Codex P2 F1)", () => {
    // Regression guard for the CTL-1654 remediation: the fallback used to hardcode
    // ~/catalyst/catalyst-cluster/cluster.json, so a relocated CATALYST_CLUSTER_DIR
    // resolved no hosts. It must now read <CATALYST_CLUSTER_DIR>/cluster.json.
    const clusterDir = join(tmp, "relocated-cluster");
    mkdirSync(clusterDir, { recursive: true });
    writeFileSync(join(clusterDir, "cluster.json"), JSON.stringify({ roster: ["peer-a", "peer-b"] }));
    withEnv({ CATALYST_CLUSTER_DIR: clusterDir, CATALYST_HOST_NAME: "self-not-in-roster" }, () => {
      expect(resolveHosts()).toEqual(["peer-a", "peer-b"]);
    });
  });

  test("no env hosts and no cluster.json → empty", () => {
    withEnv({ CATALYST_CLUSTER_JSON: join(tmp, "does-not-exist.json") }, () => {
      expect(resolveHosts()).toEqual([]);
    });
  });
});

// ── CTL-1812: the cursor race that lost 341,356 events ────────────────────────
//
// `tail -c +N` always reads to EOF, so `bytesRead` is (EOF - cursor). The old code did
// `hs.cursor += bytesRead`, a read-modify-write on shared state — two overlapping ticks
// each added (EOF - cursor) to the SAME starting cursor and parked it at roughly
// 2*EOF - cursor, far past the end of the remote file. While parked, `tail -c +N`
// returns nothing and the mirror goes DARK: events are skipped with no fragment, no
// error, and no unhealthy host. Measured consequence on this node: 167,118 of mini's
// events (15.63%) and 174,238 of mini-2's (13.60%) simply absent.
describe("CTL-1812 — overlapping ticks must not park the cursor past remote EOF", () => {
  // A fake remote whose content grows, and which behaves exactly like `tail -c +N`:
  // reads from `cursor` to EOF, returning nothing once the cursor is past the end.
  const makeRemote = (content: string) => {
    const fetchFn: FetchFn = async (_host, cursor) => {
      const buf = Buffer.from(content, "utf8");
      if (cursor >= buf.length) return { lines: [], bytesRead: 0 };
      const slice = buf.subarray(cursor).toString("utf8");
      return { lines: slice.split("\n").filter((l) => l.trim()), bytesRead: Buffer.byteLength(slice, "utf8") };
    };
    return fetchFn;
  };

  const lines = (n: number, tag: string) =>
    Array.from({ length: n }, (_, i) => JSON.stringify({ id: `${tag}-${i}`, ts: "2026-08" })).join("\n") + "\n";

  test("two CONCURRENT ticks leave the cursor at EOF, not past it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mirror-race-"));
    try {
      const content = lines(50, "a");
      const fetchFn = makeRemote(content);
      const state = newMirrorState();
      const localFile = join(dir, "2026-08.jsonl");

      // Fire both ticks WITHOUT awaiting the first — the exact shape setInterval had.
      await Promise.all([
        mirrorTick({ hosts: ["h1"], state, fetchFn, localFile }),
        mirrorTick({ hosts: ["h1"], state, fetchFn, localFile }),
      ]);

      const eof = Buffer.byteLength(content, "utf8");
      // THE ASSERTION. With `cursor += bytesRead` this lands at ~2*eof and the mirror
      // goes dark for everything written before the remote catches up.
      expect(soleCursor(state, "h1")).toBeLessThanOrEqual(eof);
      expect(soleCursor(state, "h1")).toBe(eof);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("after concurrent ticks, subsequently-appended events are still mirrored", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mirror-race2-"));
    try {
      const first = lines(20, "a");
      const state = newMirrorState();
      const localFile = join(dir, "2026-08.jsonl");

      await Promise.all([
        mirrorTick({ hosts: ["h1"], state, fetchFn: makeRemote(first), localFile }),
        mirrorTick({ hosts: ["h1"], state, fetchFn: makeRemote(first), localFile }),
      ]);

      // The remote grows. A parked cursor would skip straight past these.
      const grown = first + lines(20, "b");
      await mirrorTick({ hosts: ["h1"], state, fetchFn: makeRemote(grown), localFile });

      const body = readFileSync(localFile, "utf8");
      // Every one of the later events must be present — this is the 341k-event property.
      for (let i = 0; i < 20; i++) {
        expect(body).toContain(`"b-${i}"`);
      }
      expect(soleCursor(state, "h1")).toBe(Buffer.byteLength(grown, "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── CTL-1216: mixed-fleet remote-file discovery + per-file cursors ───────────
//
// The hazard this closes: the basename used to be computed LOCALLY and applied
// to the REMOTE path. A peer writing 2026-W34.jsonl while this node is still on
// `month` was asked for 2026-08.jsonl — a file that exists, stopped growing, and
// returns an empty tail forever. The mirror reported the host HEALTHY and fanned
// in nothing. A silent zero.
describe("CTL-1216 — remote file discovery", () => {
  test("picks the NEWEST remote file by its encoded interval, not lexically", () => {
    // "2026-08.jsonl" > "2026-W34.jsonl" is FALSE as strings ("0" < "W"), so a
    // lexical max would pick the weekly file here by luck and the monthly one in
    // other months. Order must come from the interval the name encodes.
    expect(pickRemoteFile(["2026-07.jsonl", "2026-08.jsonl"], "fallback")).toBe("2026-08.jsonl");
    expect(pickRemoteFile(["2026-08.jsonl", "2026-W34.jsonl"], "fallback")).toBe("2026-W34.jsonl");
    expect(pickRemoteFile(["2026-W34.jsonl", "2026-W33.jsonl"], "fallback")).toBe("2026-W34.jsonl");
  });

  test("skips CTL-1813 quarantine files and other non-log names", () => {
    expect(
      pickRemoteFile(
        ["2026-08.jsonl.legacy.20260813T101010Z.512", "README.md", "2026-08.jsonl"],
        "fallback",
      ),
    ).toBe("2026-08.jsonl");
  });

  test("falls back to the locally-computed name when listing is unavailable", () => {
    // Fail direction: no worse than the pre-CTL-1216 behaviour, never worse.
    expect(pickRemoteFile(null, "2026-08.jsonl")).toBe("2026-08.jsonl");
    expect(pickRemoteFile([], "2026-08.jsonl")).toBe("2026-08.jsonl");
    expect(pickRemoteFile(["README.md", "notes.txt"], "2026-08.jsonl")).toBe("2026-08.jsonl");
  });

  test("a peer on a DIFFERENT scheme is tailed on ITS file, not ours", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mirror-mixed-"));
    try {
      const state = newMirrorState();
      const localFile = join(dir, "local.jsonl");
      const asked: string[] = [];
      const fetchFn: FetchFn = async (_host, _cursor, file) => {
        asked.push(file);
        return { lines: [], bytesRead: 0 };
      };
      // The peer has rotated to weekly; this node has not.
      const listFn = async () => ["2026-08.jsonl", "2026-W34.jsonl"];
      await mirrorTick({ hosts: ["peer"], state, fetchFn, listFn, localFile });
      expect(asked).toEqual(["2026-W34.jsonl"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a listFn that THROWS degrades to the local name, host stays healthy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mirror-listfail-"));
    try {
      const state = newMirrorState();
      const localFile = join(dir, "local.jsonl");
      const asked: string[] = [];
      const fetchFn: FetchFn = async (_host, _cursor, file) => {
        asked.push(file);
        return { lines: [], bytesRead: 0 };
      };
      const listFn = async () => {
        throw new Error("ssh exploded");
      };
      const res = await mirrorTick({ hosts: ["peer"], state, fetchFn, listFn, localFile });
      expect(asked.length).toBe(1);
      // A host we merely could not LIST is not an unhealthy host.
      expect(res.byHost["peer"].healthy).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cursors are per FILE — a rollover does not lose our place in the old one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mirror-percursor-"));
    try {
      const state = newMirrorState();
      const localFile = join(dir, "local.jsonl");
      const fetchFn: FetchFn = async (_host, _cursor, _file) => ({ lines: [], bytesRead: 10 });

      await mirrorTick({ hosts: ["h"], state, fetchFn, listFn: async () => ["2026-W33.jsonl"], localFile });
      await mirrorTick({ hosts: ["h"], state, fetchFn, listFn: async () => ["2026-W34.jsonl"], localFile });

      const cursors = state.byHost["h"].cursors;
      // The W33 cursor SURVIVES the move to W34 — the old code reset the single
      // cursor to 0 and lost it, while the remote was very likely still
      // appending to W33 across the boundary.
      expect(cursors["2026-W33.jsonl"]).toBe(10);
      expect(cursors["2026-W34.jsonl"]).toBe(10);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("CTL-1216 — HostState migration", () => {
  test("the pre-CTL-1216 scalar shape folds into the map exactly once", () => {
    const hs = { cursor: 4096, currentFile: "2026-08.jsonl", lastSeenTs: null, healthy: true } as never;
    const migrated = migrateHostState(hs);
    expect(migrated.cursors).toEqual({ "2026-08.jsonl": 4096 });
    // Dropping the old fields outright would silently restart every host from
    // byte 0 on the first tick after deploy, re-mirroring a whole file.
    expect(migrated.cursor).toBeUndefined();
    expect(migrated.currentFile).toBeUndefined();
  });

  test("migration is idempotent and never clobbers a live per-file cursor", () => {
    const hs = { cursors: { "2026-08.jsonl": 99 }, cursor: 1, currentFile: "2026-08.jsonl", lastSeenTs: null, healthy: true } as never;
    expect(migrateHostState(hs).cursors).toEqual({ "2026-08.jsonl": 99 });
  });

  test("a scalar with no currentFile is dropped, not filed under a guessed name", () => {
    const hs = { cursor: 500, currentFile: null, lastSeenTs: null, healthy: true } as never;
    expect(migrateHostState(hs).cursors).toEqual({});
  });
});
