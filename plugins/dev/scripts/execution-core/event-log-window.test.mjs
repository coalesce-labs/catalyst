// event-log-window.test.mjs — CTL-1529: every read of the monthly event log is
// bounded, and the heartbeat read's liveness semantics survive the bounding.
//
// Two layers under test:
//
//   1. scanEventsSince (event-tail.mjs) — the TIME-COVERING tail primitive. It
//      walks a window backwards from EOF (geometric doubling) until the OLDEST
//      record in the window predates a target instant, with a named byte cap and
//      an explicit `covered` verdict. Peak transient is ONE chunk, never a
//      whole-file buffer.
//
//   2. scanLocalHeartbeats / readClusterHeartbeats (recovery.mjs) — the ticket's
//      target read. THE CRUX: tail-bounding is not a pure optimization. With a
//      whole-file read a host last seen 6h ago is PRESENT-BUT-STALE (=> proven
//      dead => its work is reclaimed); with a naive N-megabyte tail it becomes
//      ABSENT (=> "not proven dead" => work strands forever). These tests pin
//      both directions, plus the documented conservative behavior when the byte
//      cap is reached before the grace window is covered.
//
// Run: cd plugins/dev/scripts/execution-core && bun test event-log-window.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { scanEventsSince } from "./event-tail.mjs";
import {
  scanLocalHeartbeats,
  makeHeartbeatScanMemo,
  makeTickHeartbeatReader,
  readClusterHeartbeats,
  readClusterAdmission,
  deadHosts,
  HeartbeatWindowError,
} from "./recovery.mjs";
import { computeSurvivingRoster, computeDeadHosts, computeDispatchSurvivingRoster } from "./scheduler.mjs";

// ─── fixtures ────────────────────────────────────────────────────────────────

const PAD = "p".repeat(160); // pads every line to ~250 bytes so byte↔time math is predictable
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const noise = (ts) =>
  JSON.stringify({ ts, attributes: { "event.name": "noise" }, body: { payload: { pad: PAD } } });
const hb = (host, ts, payload = {}) =>
  JSON.stringify({
    ts,
    attributes: { "event.name": "node.heartbeat" },
    body: { payload: { "host.name": host, pad: PAD, ...payload } },
  });

const MIN = 60_000;
const HOUR = 60 * MIN;

// buildFixture — a log whose timestamps span 24h with a dense burst in the last
// 30 seconds. Layout (oldest → newest):
//   • 300 noise lines stepping from now-24h to now-30min
//   • hb("ancient", now-20h)  — outside the default 12h window
//   • hb("stale",   now-6h)   — inside the window, older than the 10-min grace
//   • 60 noise lines all inside the last 30s (the dense burst — this is what
//     makes a FIXED BYTE BUDGET span only seconds instead of the grace window)
//   • hb("self", now-5s)
function buildFixture(dir, nowMs) {
  const path = join(dir, "events.jsonl");
  const lines = [];
  const start = nowMs - 24 * HOUR;
  const step = (24 * HOUR - 30 * MIN) / 300;
  const ancientAt = nowMs - 20 * HOUR;
  const staleAt = nowMs - 6 * HOUR;
  let wroteAncient = false;
  let wroteStale = false;
  for (let i = 0; i < 300; i++) {
    const ts = start + i * step;
    if (!wroteAncient && ts >= ancientAt) {
      lines.push(hb("ancient", iso(ancientAt)));
      wroteAncient = true;
    }
    if (!wroteStale && ts >= staleAt) {
      lines.push(hb("stale", iso(staleAt)));
      wroteStale = true;
    }
    lines.push(noise(iso(ts)));
  }
  for (let i = 60; i >= 1; i--) lines.push(noise(iso(nowMs - i * 500)));
  lines.push(hb("self", iso(nowMs - 5_000)));
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

// trueHeartbeats — the ORACLE: the whole-file reduce this ticket replaces.
// Whenever the bounded reader reports covered:true over a window that reaches
// BOF, its output must equal this exactly.
function trueHeartbeats(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line || !line.includes("node.heartbeat")) continue;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    if (evt?.attributes?.["event.name"] !== "node.heartbeat") continue;
    const host = evt?.body?.payload?.["host.name"] ?? evt?.resource?.["host.name"];
    const ts = evt?.ts;
    if (typeof host !== "string" || !host) continue;
    if (typeof ts !== "string" || !ts) continue;
    if (!out[host] || ts > out[host]) out[host] = ts;
  }
  return out;
}

let dir;
let NOW;
let logPath;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ctl1529-"));
  NOW = Date.parse("2026-07-26T12:00:00Z");
  logPath = buildFixture(dir, NOW);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ─── 1. scanEventsSince — the bounded time-covering tail ─────────────────────

describe("scanEventsSince (CTL-1529)", () => {
  test("expands the window until its OLDEST record predates the target, then stops (does not read the whole file)", () => {
    const seen = [];
    const res = scanEventsSince({
      path: logPath,
      targetSinceMs: NOW - 12 * HOUR,
      requiredSinceMs: NOW - 10 * MIN,
      chunkSize: 1024,
      initialWindow: 1024,
      onEvent: (e) => seen.push(e),
    });
    expect(res.covered).toBe(true);
    expect(res.reachedBof).toBe(false);
    expect(res.fromOffset).toBeGreaterThan(0);
    // The scanned window is a strict fraction of the file — that is the whole point.
    expect(res.windowBytes).toBeLessThan(statSync(logPath).size);
    // …and it genuinely reaches back past the 12h target.
    expect(Date.parse(res.oldestTs)).toBeLessThanOrEqual(NOW - 12 * HOUR);
    expect(seen.length).toBeGreaterThan(0);
  });

  test("reaching byte 0 counts as COVERED even when the file is younger than the window (UTC month rollover)", () => {
    // A brand-new month's log holds only a few minutes of data. A whole-file read
    // is exactly what we do today, so BOF must NOT be reported as a coverage
    // failure — otherwise every host loses failover for the first 10 minutes of
    // every UTC month.
    const p = join(dir, "young.jsonl");
    writeFileSync(p, [noise(iso(NOW - 60_000)), hb("self", iso(NOW - 5_000))].join("\n") + "\n");
    const res = scanEventsSince({
      path: p,
      targetSinceMs: NOW - 12 * HOUR,
      requiredSinceMs: NOW - 10 * MIN,
      chunkSize: 128,
      initialWindow: 128,
      onEvent: () => {},
    });
    expect(res.reachedBof).toBe(true);
    expect(res.covered).toBe(true);
    expect(res.fromOffset).toBe(0);
  });

  test("byte cap reached before the REQUIRED window is spanned ⇒ covered:false (never a silent truncation)", () => {
    // 4 KiB of the dense tail burst spans only a few seconds — proof that a fixed
    // byte budget carries NO wall-clock guarantee.
    const res = scanEventsSince({
      path: logPath,
      targetSinceMs: NOW - 12 * HOUR,
      requiredSinceMs: NOW - 10 * MIN,
      chunkSize: 512,
      initialWindow: 512,
      maxBytes: 4096,
      onEvent: () => {},
    });
    expect(res.covered).toBe(false);
    expect(res.reachedBof).toBe(false);
    expect(res.windowBytes).toBeLessThanOrEqual(4096);
  });

  test("a truncated line at the window start is DISCARDED, never parsed", () => {
    // The classic hazard: the suffix of a cut line can independently parse as
    // valid JSON. Seed the window mid-line and assert the bogus event never
    // reaches onEvent.
    const p = join(dir, "trunc.jsonl");
    const head = JSON.stringify({ ts: iso(NOW - 20 * HOUR), junk: 'XX{"n":7}' });
    writeFileSync(p, [head, noise(iso(NOW - 30 * MIN)), hb("self", iso(NOW - 5_000))].join("\n") + "\n");
    const seen = [];
    scanEventsSince({
      path: p,
      targetSinceMs: NOW - 25 * MIN,
      requiredSinceMs: NOW - 10 * MIN,
      chunkSize: 64,
      initialWindow: 64,
      onEvent: (e) => seen.push(e),
    });
    expect(seen.some((e) => e?.n === 7)).toBe(false);
    for (const e of seen) expect(typeof e?.ts).toBe("string");
  });

  test("peak transient is ONE chunk: no single read exceeds chunkSize", () => {
    const reads = [];
    scanEventsSince({
      path: logPath,
      targetSinceMs: NOW - 12 * HOUR,
      requiredSinceMs: NOW - 10 * MIN,
      chunkSize: 4096,
      initialWindow: 4096,
      onEvent: () => {},
      onRead: (r) => reads.push(r),
    });
    expect(reads.length).toBeGreaterThan(1); // it really did chunk
    for (const r of reads) expect(r.bytes).toBeLessThanOrEqual(4096);
    expect(Math.max(...reads.map((r) => r.bytes))).toBeLessThanOrEqual(4096);
  });

  test("missing file ⇒ covered:true, no events, never throws", () => {
    const res = scanEventsSince({
      path: join(dir, "nope.jsonl"),
      targetSinceMs: NOW - HOUR,
      onEvent: () => {
        throw new Error("should not be called");
      },
    });
    expect(res.covered).toBe(true);
    expect(res.reachedBof).toBe(true);
  });

  test("a multibyte char split across a chunk boundary survives (no U+FFFD)", () => {
    const p = join(dir, "utf8.jsonl");
    writeFileSync(p, [JSON.stringify({ ts: iso(NOW - HOUR), e: "a🚀b" })].join("\n") + "\n");
    const seen = [];
    scanEventsSince({
      path: p,
      targetSinceMs: NOW - 2 * HOUR,
      chunkSize: 4,
      initialWindow: 4,
      onEvent: (e) => seen.push(e),
    });
    expect(seen).toEqual([{ ts: iso(NOW - HOUR), e: "a🚀b" }]);
  });

  test("lineFilter skips non-matching lines before JSON.parse (the cheap pre-filter is preserved)", () => {
    const seen = [];
    scanEventsSince({
      path: logPath,
      targetSinceMs: NOW - 12 * HOUR,
      chunkSize: 4096,
      initialWindow: 4096,
      lineFilter: (line) => line.includes("node.heartbeat"),
      onEvent: (e) => seen.push(e),
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const e of seen) expect(e.attributes["event.name"]).toBe("node.heartbeat");
  });
});

// ─── 2. readClusterHeartbeats — liveness semantics survive the bounding ──────

describe("readClusterHeartbeats — bounded tail preserves liveness semantics (CTL-1529)", () => {
  const ROSTER = ["self", "stale", "ghost"];
  const opts = () => ({ logPath, nowMs: NOW, roster: ["self"] /* single-host ⇒ no peer merge */ });

  test("a host seen 10s ago is ALIVE for BOTH consumers", () => {
    const lastSeen = readClusterHeartbeats(opts());
    expect(lastSeen.self).toBe(iso(NOW - 5_000));
    // recovery (fail-open): not dead
    expect(deadHosts({ lastSeen, roster: ROSTER, graceMs: 10 * MIN, nowMs: NOW })).not.toContain("self");
    // dispatch (positive liveness): seen within grace
    expect(Date.parse(lastSeen.self)).toBeGreaterThanOrEqual(NOW - 10 * MIN);
  });

  test("THE CRUX — a host last seen 6 HOURS ago is still PRESENT-BUT-STALE ⇒ proven dead for the recovery consumer", () => {
    // Force the back-walk explicitly. With the 1 MiB default initialWindow this
    // ~90 KB fixture is swallowed whole on iteration 1 — i.e. a whole-file read in
    // disguise, which passes even under a naive fixed-byte tail and so proves
    // nothing about the property this test is named for. Small window + small chunk
    // makes it genuinely walk backwards until the 6h-old record is covered.
    const lastSeen = readClusterHeartbeats({ ...opts(), chunkSize: 1024, initialWindow: 4096 });
    expect(lastSeen.stale).toBe(iso(NOW - 6 * HOUR)); // present, not absent
    expect(deadHosts({ lastSeen, roster: ROSTER, graceMs: 10 * MIN, nowMs: NOW })).toContain("stale");
  });

  test("a host never present at all preserves today's behavior for each consumer", () => {
    const lastSeen = readClusterHeartbeats(opts());
    expect(lastSeen.ghost).toBeUndefined();
    // recovery is fail-OPEN: unseen ⇒ NOT proven dead ⇒ never reclaimed
    expect(deadHosts({ lastSeen, roster: ROSTER, graceMs: 10 * MIN, nowMs: NOW })).not.toContain("ghost");
    // dispatch is POSITIVE-liveness: unseen ⇒ shed
    const live = ROSTER.filter((h) => {
      const s = lastSeen[h];
      return typeof s === "string" && s.length > 0 && Date.parse(s) >= NOW - 10 * MIN;
    });
    expect(live).not.toContain("ghost");
  });

  test("the window provably spans the grace window even on a dense log", () => {
    const res = scanLocalHeartbeats({ logPath, nowMs: NOW, chunkSize: 1024, initialWindow: 1024 });
    expect(res.covered).toBe(true);
    expect(Date.parse(res.oldestTs ?? iso(0))).toBeLessThanOrEqual(NOW - 10 * MIN);
  });

  test("byte-for-byte equivalence with the whole-file read on a fixture that fits in one chunk", () => {
    const small = join(dir, "small.jsonl");
    writeFileSync(
      small,
      [hb("a", iso(NOW - 3 * HOUR)), hb("b", iso(NOW - 20 * MIN)), hb("a", iso(NOW - MIN))].join("\n") + "\n"
    );
    expect(readClusterHeartbeats({ logPath: small, nowMs: NOW, roster: ["self"] })).toEqual(
      trueHeartbeats(small)
    );
  });

  // ── cap exhaustion: the ONE conservative behavior both consumers already catch ──

  test("cap reached before the grace window is covered ⇒ requireGraceWindow THROWS a tagged error", () => {
    let err = null;
    try {
      readClusterHeartbeats({
        logPath,
        nowMs: NOW,
        roster: ["self"],
        maxBytes: 4096,
        chunkSize: 512,
        initialWindow: 512,
        requireGraceWindow: true,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HeartbeatWindowError);
    // R7: distinguishable from the pre-existing requirePeerView throw.
    expect(err.code).toBe("ERR_HEARTBEAT_WINDOW_UNCOVERED");
  });

  test("cap exhaustion degrades RECOVERY to the FULL roster ⇒ empty dead set (no reclaim, never 'everyone is dead')", () => {
    const readHeartbeats = () => {
      throw new HeartbeatWindowError("uncovered");
    };
    expect(computeSurvivingRoster(ROSTER, { readHeartbeats, nowMs: NOW })).toEqual(ROSTER);
    expect(
      computeDeadHosts(ROSTER, {
        computeSurviving: (r) => computeSurvivingRoster(r, { readHeartbeats, nowMs: NOW }),
      })
    ).toEqual([]);
  });

  test("cap exhaustion degrades DISPATCH to the FULL roster (never 'everyone is alive' on one host)", () => {
    const readHeartbeats = () => {
      throw new HeartbeatWindowError("uncovered");
    };
    expect(computeDispatchSurvivingRoster(ROSTER, { readHeartbeats, nowMs: NOW })).toEqual(ROSTER);
  });

  test("a caller that does NOT opt in gets best-effort truncated data instead of a throw (display path)", () => {
    const lastSeen = readClusterHeartbeats({
      logPath,
      nowMs: NOW,
      roster: ["self"],
      maxBytes: 4096,
      chunkSize: 512,
      initialWindow: 512,
    });
    expect(lastSeen.self).toBe(iso(NOW - 5_000)); // the newest heartbeat is always in the tail
  });
});

// ─── 3. one shared read per tick ─────────────────────────────────────────────

describe("per-tick heartbeat scan memo (CTL-1529)", () => {
  test("N readers over one tick perform exactly ONE local scan", () => {
    let scans = 0;
    const memo = makeHeartbeatScanMemo({
      logPath,
      nowMs: NOW,
      scan: (o) => {
        scans += 1;
        return scanLocalHeartbeats({ ...o, logPath, nowMs: NOW });
      },
    });
    const read = makeTickHeartbeatReader({ scanLocal: memo, roster: ["self"] });
    read({ roster: ["self"] });
    read({ roster: ["self"] });
    read({ roster: ["self"] });
    expect(scans).toBe(1);
  });

  test("a fresh memo per tick cannot go stale across ticks", () => {
    let scans = 0;
    const mk = () =>
      makeHeartbeatScanMemo({
        logPath,
        nowMs: NOW,
        scan: (o) => {
          scans += 1;
          return scanLocalHeartbeats({ ...o, logPath, nowMs: NOW });
        },
      });
    makeTickHeartbeatReader({ scanLocal: mk() })({ roster: ["self"] });
    makeTickHeartbeatReader({ scanLocal: mk() })({ roster: ["self"] });
    expect(scans).toBe(2);
  });

  test("the shared map is COPIED per caller — a peer merge cannot poison the memo", () => {
    const memo = makeHeartbeatScanMemo({ logPath, nowMs: NOW });
    const a = readClusterHeartbeats({
      scanLocal: memo,
      nowMs: NOW,
      roster: ["self", "peer"],
      anchorIssue: "CTL-9999",
      readPeers: () => ({ peer: { last_seen: iso(NOW - MIN) } }),
    });
    const b = readClusterHeartbeats({ scanLocal: memo, nowMs: NOW, roster: ["self"] });
    expect(a.peer).toBe(iso(NOW - MIN));
    expect(b.peer).toBeUndefined(); // the memo was not mutated by caller a
  });
});

// ─── 3b. production wiring: both liveness gates over ONE real scan ───────────

describe("makeTickHeartbeatReader — real wiring, both gates, one file read (CTL-1529)", () => {
  test("recovery (fail-open) and dispatch (positive-liveness) share ONE scan and keep their own semantics", () => {
    let fileReads = 0;
    const memo = makeHeartbeatScanMemo({
      scan: (o) => {
        fileReads += 1;
        return scanLocalHeartbeats({ ...o, logPath, nowMs: NOW, chunkSize: 4096, initialWindow: 4096 });
      },
    });
    // A configured (and legitimately empty) peer transport, so the DISPATCH gate
    // exercises its positive-liveness filter rather than short-circuiting on the
    // separate CTL-1091 "no trustworthy cross-host view" throw.
    const base = makeTickHeartbeatReader({ scanLocal: memo });
    const tickRead = (o = {}) => base({ anchorIssue: "CTL-9999", readPeers: () => ({}), ...o });
    const roster = ["self", "stale", "ghost"];

    // Recovery gate: fail-OPEN. "stale" is present-but-stale ⇒ dead ⇒ shed;
    // "ghost" is absent ⇒ NOT proven dead ⇒ retained.
    const survivors = computeSurvivingRoster(roster, { readHeartbeats: tickRead, nowMs: NOW });
    expect(survivors).toEqual(["self", "ghost"]);

    // Dispatch gate: POSITIVE liveness. Only "self" was seen within grace, so
    // BOTH "stale" and "ghost" are shed — the deliberate asymmetry, intact.
    const dispatch = computeDispatchSurvivingRoster(roster, { readHeartbeats: tickRead, nowMs: NOW });
    expect(dispatch).toEqual(["self"]);

    // …and the expensive local scan happened exactly once for both.
    expect(fileReads).toBe(1);
  });

  test("the tick reader opts into the guarantee: an uncoverable window degrades BOTH gates to the full roster", () => {
    const memo = makeHeartbeatScanMemo({
      scan: (o) =>
        scanLocalHeartbeats({
          ...o,
          logPath,
          nowMs: NOW,
          maxBytes: 4096,
          chunkSize: 512,
          initialWindow: 512,
        }),
    });
    const tickRead = makeTickHeartbeatReader({ scanLocal: memo });
    const roster = ["self", "stale", "ghost"];
    expect(computeSurvivingRoster(roster, { readHeartbeats: tickRead, nowMs: NOW })).toEqual(roster);
    expect(computeDeadHosts(roster, { readHeartbeats: tickRead })).toEqual([]);
    expect(computeDispatchSurvivingRoster(roster, { readHeartbeats: tickRead, nowMs: NOW })).toEqual(roster);
  });

  test("R3 — a truncated map NEVER reaches the dispatch filter, so this host cannot shed ITSELF", () => {
    // The dangerous shape: the cap truncates below self's own newest heartbeat
    // while the peer transport still reports a live peer. If a truncated map were
    // allowed through, readPositiveLive would compute live=[peer] — non-empty, so
    // resolveDispatchRoster's outage guard never fires — and this host would drop
    // out of its OWN dispatch roster and silently stop dispatching any new work.
    // The guarantee check therefore runs BEFORE the peer merge and before the
    // filter: it must throw, not return.
    let err = null;
    try {
      readClusterHeartbeats({
        logPath,
        nowMs: NOW,
        roster: ["self", "peer"],
        anchorIssue: "CTL-9999",
        readPeers: () => ({ peer: { last_seen: iso(NOW - 1_000) } }),
        maxBytes: 4096,
        chunkSize: 512,
        initialWindow: 512,
        requireGraceWindow: true,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HeartbeatWindowError);
  });

  test("an unexpected I/O failure reports covered:false (never an empty-but-trusted map)", () => {
    const res = scanLocalHeartbeats({
      logPath,
      nowMs: NOW,
      scan: () => {
        throw new Error("EIO");
      },
    });
    expect(res.covered).toBe(false);
    expect(res.lastSeen).toEqual({});
  });

  test("the truncation throw is distinguishable from the pre-existing requirePeerView throw (R7)", () => {
    // requirePeerView with no configured transport throws the CTL-1091 error…
    let peerErr = null;
    try {
      readClusterHeartbeats({
        logPath,
        nowMs: NOW,
        roster: ["a", "b"],
        anchorIssue: null,
        requirePeerView: true,
      });
    } catch (e) {
      peerErr = e;
    }
    expect(peerErr).toBeTruthy();
    expect(peerErr instanceof HeartbeatWindowError).toBe(false);
    expect(peerErr.code).toBeUndefined();
    // …while cap exhaustion throws the tagged CTL-1529 one.
    let winErr = null;
    try {
      readClusterHeartbeats({
        logPath,
        nowMs: NOW,
        roster: ["self"],
        maxBytes: 4096,
        chunkSize: 512,
        initialWindow: 512,
        requireGraceWindow: true,
      });
    } catch (e) {
      winErr = e;
    }
    expect(winErr.code).toBe("ERR_HEARTBEAT_WINDOW_UNCOVERED");
  });
});

// ─── 4. the sibling read (readClusterAdmission) ──────────────────────────────

describe("readClusterAdmission — bounded, same records (CTL-1529)", () => {
  test("keeps the NEWEST heartbeat's admission per host and never throws", () => {
    const p = join(dir, "adm.jsonl");
    writeFileSync(
      p,
      [
        hb("mini", iso(NOW - 2 * HOUR), { admission: { accepting: false, holdReason: "drain" } }),
        hb("mini", iso(NOW - MIN), { admission: { accepting: true } }),
      ].join("\n") + "\n"
    );
    expect(readClusterAdmission({ logPath: p, nowMs: NOW })).toEqual({ mini: { accepting: true } });
  });

  test("does not read the whole file on a large log (bounded window)", () => {
    const reads = [];
    readClusterAdmission({
      logPath,
      nowMs: NOW,
      chunkSize: 1024,
      initialWindow: 1024,
      onRead: (r) => reads.push(r),
    });
    const total = reads.reduce((a, r) => a + r.bytes, 0);
    expect(total).toBeLessThan(statSync(logPath).size);
    for (const r of reads) expect(r.bytes).toBeLessThanOrEqual(1024);
  });
});
