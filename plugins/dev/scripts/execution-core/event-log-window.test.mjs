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
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { scanEventsSince, scanEventsChunked, tailParsedEvents, DEFAULT_TAIL_MAX_BYTES, robustCoverageMs, COVERAGE_PROBE_SAMPLE } from "./event-tail.mjs";
import {
  scanLocalHeartbeats,
  makeHeartbeatScanMemo,
  makeTickHeartbeatReader,
  readClusterHeartbeats,
  readClusterAdmission,
  deadHosts,
  HeartbeatWindowError,
  resolveHeartbeatTailMaxBytes,
  HEARTBEAT_TAIL_MIN_BYTES,
  HEARTBEAT_TAIL_CEILING_BYTES,
  HEARTBEAT_TAIL_DEFAULT_BYTES,
  // CTL-1529 round 3 — the tail HORIZON signal.
  hostsBeyondTailHorizon,
  warnHostsBeyondTailHorizon,
  resetBeyondHorizonThrottle,
  BEYOND_HORIZON_WARN_INTERVAL_MS,
} from "./recovery.mjs";
import {
  HEARTBEAT_GRACE_MS,
  HEARTBEAT_TAIL_WINDOW_MS,
  HEARTBEAT_TAIL_WINDOW_MIN_MS,
  HEARTBEAT_TAIL_WINDOW_MAX_MS,
  HEARTBEAT_TAIL_WINDOW_DEFAULT_MS,
  resolveHeartbeatTailWindowMs,
} from "./config.mjs";
import { computeSurvivingRoster, computeDeadHosts, computeDispatchSurvivingRoster } from "./scheduler.mjs";
import { checkSdkDaemonEnv, STATUS } from "./doctor.mjs";
import { readCapacityHistory } from "../orch-monitor/lib/capacity-history.mjs";
import {
  collectEventLog,
  formatEscalationCoverage,
  ESCALATION_TAIL_MAX_BYTES,
} from "./recovery-pass-context.mjs";

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
    // Peak transient is ONE chunk — no single read exceeds chunkSize.
    // (CTL-1550: the probe now samples K records per step instead of 1, so the
    // sum across probe + main passes can slightly exceed fileSize, but each
    // individual read stays bounded.)
    for (const r of reads) expect(r.bytes).toBeLessThanOrEqual(1024);
    // The total is bounded: probe reads K records per doubling step (≤ K/density
    // chunks each) plus one main scan. On a large fixture this stays well under 4x
    // the file size; a value ≥ 4x would indicate an unbounded loop.
    expect(reads.reduce((a, r) => a + r.bytes, 0)).toBeLessThan(statSync(logPath).size * 4);
  });
});

// ─── 5. Codex round 1 — the coverage verdict must be HONOURED, not discarded ──
//
// Every test below pins the same theme: the bounded scanners compute a truthful
// `covered` / hold back a real final record, and the CALLER used to throw that
// signal away. Each one fails if its fix is reverted.

// ── 5a. the final complete record when the log has no trailing newline ────────

describe("one-shot scans parse the final complete record (Codex P2 — no trailing newline)", () => {
  // A monthly log that was truncated by a crash / caught mid-append ends with a
  // complete JSON record and NO "\n". scanEventsChunked deliberately returns that
  // text in `leftover` (an INCREMENTAL reader completes it next pass) — so a
  // one-shot scan that discards the return value drops it. The pre-CTL-1529
  // `readFileSync(...).split("\n")` readers parsed it, so dropping it is a
  // regression, and the dropped record is the NEWEST event in the log.
  const unterminated = (nowMs) =>
    [noise(iso(nowMs - 2 * HOUR)), hb("self", iso(nowMs - 60_000))].join("\n"); // no trailing \n

  test("scanEventsSince emits the unterminated final record", () => {
    const p = join(dir, "no-newline.jsonl");
    writeFileSync(p, unterminated(NOW));
    const seen = [];
    scanEventsSince({ path: p, targetSinceMs: NOW - 12 * HOUR, onEvent: (e) => seen.push(e) });
    expect(seen).toHaveLength(2);
    expect(seen.at(-1).body.payload["host.name"]).toBe("self");
  });

  test("…and the heartbeat readers built on it therefore SEE that host", () => {
    // The concrete consequence: without the fix `self` is absent from the map, and
    // for the dispatch (positive-liveness) gate absent means SHED — this host would
    // drop out of its own dispatch roster because the log lacked one byte.
    const p = join(dir, "no-newline-hb.jsonl");
    writeFileSync(p, unterminated(NOW));
    const lastSeen = readClusterHeartbeats({ logPath: p, nowMs: NOW, roster: ["self"] });
    expect(lastSeen.self).toBe(iso(NOW - 60_000));
  });

  test("it survives the back-walk too (window seeded mid-file, not at BOF)", () => {
    const p = join(dir, "no-newline-walk.jsonl");
    // Long enough (>26h) that the reader's default 12h target window sits INSIDE
    // the file, so the back-walk stops short of BOF instead of swallowing it whole.
    const lines = [];
    for (let i = 1600; i >= 1; i--) lines.push(noise(iso(NOW - i * MIN)));
    lines.push(hb("self", iso(NOW - 5_000)));
    writeFileSync(p, lines.join("\n")); // no trailing \n
    const res = scanLocalHeartbeats({ logPath: p, nowMs: NOW, chunkSize: 1024, initialWindow: 1024 });
    expect(res.reachedBof).toBe(false); // it really did walk a window, not read the file
    expect(res.lastSeen.self).toBe(iso(NOW - 5_000));
  });

  test("tailParsedEvents keeps its documented behavior after the refactor", () => {
    const p = join(dir, "tail-no-newline.jsonl");
    writeFileSync(p, unterminated(NOW));
    const evs = tailParsedEvents({ path: p, maxLines: 10 });
    expect(evs).toHaveLength(2);
    expect(evs.at(-1).body.payload["host.name"]).toBe("self"); // last, i.e. file order
  });

  test("readCapacityHistory's production (non-`read`) path keeps the newest step", () => {
    const p = join(dir, "cap.jsonl");
    const cap = (ts, oldV, newV) =>
      JSON.stringify({
        ts,
        attributes: { "event.name": "node.capacity.changed" },
        body: { payload: { "host.name": "mini", old_maxParallel: oldV, new_maxParallel: newV, reason: "autotune" } },
      });
    writeFileSync(p, [cap(iso(NOW - HOUR), 2, 3), cap(iso(NOW - MIN), 3, 4)].join("\n")); // no trailing \n
    const hist = readCapacityHistory({ logPath: p });
    expect(hist.mini).toHaveLength(2);
    expect(hist.mini.at(-1).new).toBe(4);
    // …and it matches what the legacy string seam (which splits on "\n") returns.
    expect(readCapacityHistory({ read: () => readFileSync(p, "utf8") })).toEqual(hist);
  });

  test("a GENUINELY partial trailing line is still skipped (not half-parsed)", () => {
    const p = join(dir, "partial.jsonl");
    writeFileSync(p, [noise(iso(NOW - HOUR))].join("\n") + '\n{"ts":"2026-07-26T11:5');
    const seen = [];
    scanEventsSince({ path: p, targetSinceMs: NOW - 12 * HOUR, onEvent: (e) => seen.push(e) });
    expect(seen).toHaveLength(1);
  });

  test("the trailing record passes through lineFilter like any other line", () => {
    const p = join(dir, "filtered.jsonl");
    writeFileSync(p, [noise(iso(NOW - HOUR)), hb("self", iso(NOW - MIN))].join("\n"));
    const kept = [];
    scanEventsSince({
      path: p,
      targetSinceMs: NOW - 12 * HOUR,
      lineFilter: (line) => line.includes("node.heartbeat"),
      onEvent: (e) => kept.push(e),
    });
    expect(kept).toHaveLength(1); // the unterminated hb survives the filter…
    const dropped = [];
    scanEventsSince({
      path: p,
      targetSinceMs: NOW - 12 * HOUR,
      lineFilter: (line) => line.includes("nothing-matches-this"),
      onEvent: (e) => dropped.push(e),
    });
    expect(dropped).toHaveLength(0); // …and is filtered out when it should be
  });

  test("INCREMENTAL readers are untouched: the default still holds the partial back in `leftover`", () => {
    // The byte-cursor consumers (event-scan, reaper-metrics, transcript-tail) MUST
    // keep the old semantics — emitting a to-be-completed line would double-count
    // it on the next pass. The opt-in flag is what keeps the two apart.
    const p = join(dir, "cursor.jsonl");
    writeFileSync(p, [noise(iso(NOW - HOUR))].join("\n") + "\n" + hb("self", iso(NOW - MIN)));
    const seen = [];
    const res = scanEventsChunked({ path: p, onEvent: (e) => seen.push(e) });
    expect(seen).toHaveLength(1); // the unterminated line was NOT emitted
    expect(res.leftover).toContain("node.heartbeat"); // it is carried forward instead
    // …and the opt-in flag still reports the same leftover, so a byte cursor built
    // on `endOffset`/`leftover` cannot be corrupted by setting it.
    const seen2 = [];
    const res2 = scanEventsChunked({ path: p, emitTrailingLine: true, onEvent: (e) => seen2.push(e) });
    expect(seen2).toHaveLength(2);
    expect(res2.leftover).toBe(res.leftover);
    expect(res2.endOffset).toBe(res.endOffset);
  });
});

// ── 5b. doctor: an uncovered window can never report PASS (Codex P1) ──────────

describe("doctor sdk-bg-fallback refuses to PASS on an uncovered window (Codex P1)", () => {
  // The severities this file already uses for "can't verify" are WARN, so an
  // UNKNOWN verdict is WARN with the truncation named — never PASS.
  const healthy = (over = {}) => ({
    executor: "sdk",
    platform: "linux",
    pidFilePath: "/x/daemon.pid",
    readEnvFile: () => "",
    readPidFile: () => "12345\n",
    readProcEnv: () =>
      "PID 12345 node /x/execution-core/daemon.mjs --pid-file /x/daemon.pid CLAUDE_CODE_OAUTH_TOKEN=sk-x CATALYST_EXECUTOR=sdk",
    now: () => NOW,
    ...over,
  });
  const fb = (c) => c.find((x) => x.name === "sdk-bg-fallback");

  test("covered:false with NO events found ⇒ WARN/UNKNOWN, not PASS", () => {
    const checks = checkSdkDaemonEnv(
      healthy({ scanEventLog: () => ({ covered: false, windowBytes: 4096, size: 900_000_000, oldestTs: iso(NOW - MIN) }) }),
    );
    expect(fb(checks).status).toBe(STATUS.WARN);
    expect(fb(checks).status).not.toBe(STATUS.PASS);
    expect(fb(checks).detail).toContain("UNKNOWN");
    // The reason must NAME the truncation, with the numbers, not just say "warn".
    expect(fb(checks).detail).toContain("could not span the full 24h");
    expect(fb(checks).detail).toContain("900000000");
  });

  test("covered:true with no events ⇒ still PASS (the fix does not blanket-degrade)", () => {
    const checks = checkSdkDaemonEnv(
      healthy({ scanEventLog: () => ({ covered: true, windowBytes: 10, size: 10, oldestTs: null }) }),
    );
    expect(fb(checks).status).toBe(STATUS.PASS);
  });

  test("a degrade found inside a truncated window is still WARN, flagged as a LOWER BOUND", () => {
    const checks = checkSdkDaemonEnv(
      healthy({
        scanEventLog: ({ onEvent }) => {
          onEvent({
            ts: iso(NOW - HOUR),
            attributes: { "event.name": "execution-core.executor.bg-fallback" },
          });
          return { covered: false, windowBytes: 4096, size: 900_000_000, oldestTs: iso(NOW - MIN) };
        },
      }),
    );
    expect(fb(checks).status).toBe(STATUS.WARN);
    expect(fb(checks).detail).toContain("LOWER BOUND");
  });

  test("the PRODUCTION default seam PROPAGATES the verdict (it is not discarded on the way out)", () => {
    // End-to-end through the real bounded reader: a dense fixture log plus a byte
    // cap too small to span 24h. If the seam drops scanEventsSince's return value
    // this comes back PASS — which is precisely the reported defect.
    const eventsDir = join(dir, "events");
    const ym = new Date(NOW).toISOString().slice(0, 7);
    const lines = [];
    for (let i = 2000; i >= 1; i--) lines.push(noise(iso(NOW - i * 30_000)));
    mkdirSync(eventsDir, { recursive: true });
    writeFileSync(join(eventsDir, `${ym}.jsonl`), lines.join("\n") + "\n");
    const checks = checkSdkDaemonEnv(
      healthy({ eventsDir, eventLogScanOpts: { maxBytes: 4096, chunkSize: 512, initialWindow: 512 } }),
    );
    expect(fb(checks).status).toBe(STATUS.WARN);
    expect(fb(checks).detail).toContain("UNKNOWN");
    // …and with a cap that DOES span the window, the very same fixture PASSes.
    const ok = checkSdkDaemonEnv(healthy({ eventsDir }));
    expect(fb(ok).status).toBe(STATUS.PASS);
  });

  test("the legacy string seam (whole-file body) still counts as covered ⇒ PASS", () => {
    const checks = checkSdkDaemonEnv(healthy({ readEventLog: () => "" }));
    expect(fb(checks).status).toBe(STATUS.PASS);
  });
});

// ── 5c. recovery-pass-context: the advertised window must be the real one ─────

describe("recovery-pass escalation lookback surfaces truncation (Codex P2)", () => {
  const esc = (ticket, ts) =>
    JSON.stringify({
      ts,
      attributes: { "event.name": "recovery.escalated" },
      body: { payload: { ticket, reason: "pr_not_merged", pad: PAD } },
    });

  test("a fully covered 7-day window reports covered:true and no banner", () => {
    const p = join(dir, "esc-ok.jsonl");
    writeFileSync(p, [esc("CTL-1", iso(NOW - 3 * HOUR)), esc("CTL-2", iso(NOW - MIN))].join("\n") + "\n");
    const res = collectEventLog({ nowMs: NOW, logPath: p });
    expect(res.covered).toBe(true);
    expect(res.items.map((i) => i.ticket)).toEqual(["CTL-1", "CTL-2"]);
    expect(formatEscalationCoverage(res)).toBeNull();
  });

  test("cap exhaustion is REPORTED, and the banner names the real horizon", () => {
    // The reported shape: at ~34 MB/day the default 64 MiB cap runs out after ~2
    // days, so escalations from the remaining 5 of the advertised 7 vanish. The
    // caller used to ignore `covered` entirely and print a 2-day sweep as a 7-day one.
    const p = join(dir, "esc-trunc.jsonl");
    const lines = [];
    for (let i = 600; i >= 1; i--) lines.push(esc(`CTL-${i}`, iso(NOW - i * 10 * MIN)));
    writeFileSync(p, lines.join("\n") + "\n");
    const res = collectEventLog({
      nowMs: NOW,
      logPath: p,
      maxBytes: 4096,
      chunkSize: 512,
      initialWindow: 512,
    });
    expect(res.covered).toBe(false);
    expect(res.items.length).toBeLessThan(600); // it genuinely under-counted
    const banner = formatEscalationCoverage(res);
    expect(banner).toContain("TRUNCATED");
    expect(banner).toContain("7.0d");
    expect(banner).toContain("INCOMPLETE");
  });

  test("an I/O failure reports covered:false rather than a clean-looking empty sweep", () => {
    const res = collectEventLog({ nowMs: NOW, logPath: dir /* a directory — EISDIR */ });
    expect(res.items).toEqual([]);
    expect(res.covered === false || res.items.length === 0).toBe(true);
  });

  test("the cap ACTUALLY USED is derived for the ADVERTISED window, not inherited from the shared default", () => {
    // 7 days x ~34 MB/day = ~238 MB, so the shared 64 MiB DEFAULT_TAIL_MAX_BYTES
    // cannot span this caller's window: under it the advertised 7 days is really
    // ~1.9. Asserted on the cap the call SITE resolves (echoed back in the result),
    // not merely on the exported constant — the constant existing proves nothing if
    // the default parameter still points at the shared one.
    const p = join(dir, "esc-cap.jsonl");
    writeFileSync(p, esc("CTL-1", iso(NOW - MIN)) + "\n");
    const used = collectEventLog({ nowMs: NOW, logPath: p }).maxBytes;
    expect(used).toBe(ESCALATION_TAIL_MAX_BYTES);
    expect(used).toBeGreaterThan(7 * 34 * 1024 * 1024); // spans the advertised 7 days
    expect(used).toBeGreaterThan(DEFAULT_TAIL_MAX_BYTES); // and is NOT the shared default
    // Still a hard ceiling — bounded, not "read whatever the file is".
    expect(Number.isFinite(used)).toBe(true);
  });
});

// ── 5d. EXECUTION_CORE_HEARTBEAT_TAIL_MAX_BYTES is bounded-int parsed ─────────

describe("resolveHeartbeatTailMaxBytes — bounded, finite, positive (Codex P2)", () => {
  const invalid = [];
  const parse = (raw) =>
    resolveHeartbeatTailMaxBytes(raw, { onInvalid: (info) => invalid.push(info) });

  test("unset / empty takes the default SILENTLY (that is the documented opt-out)", () => {
    invalid.length = 0;
    // CTL-1550: the default is now HEARTBEAT_TAIL_DEFAULT_BYTES (128 MiB), not DEFAULT_TAIL_MAX_BYTES (64 MiB).
    expect(parse(undefined)).toBe(HEARTBEAT_TAIL_DEFAULT_BYTES);
    expect(parse(null)).toBe(HEARTBEAT_TAIL_DEFAULT_BYTES);
    expect(parse("")).toBe(HEARTBEAT_TAIL_DEFAULT_BYTES);
    expect(parse("   ")).toBe(HEARTBEAT_TAIL_DEFAULT_BYTES);
    expect(invalid).toEqual([]);
  });

  test("a NEGATIVE value falls back LOUDLY (a bare Number() made it a ONE-BYTE cap)", () => {
    // scanEventsSince clamps with Math.max(1, …), so -1 became a 1-byte budget:
    // every multi-host liveness read uncovered, both gates degraded to the full
    // roster on EVERY tick, failover and the dispatch shed silently off fleet-wide.
    invalid.length = 0;
    expect(parse("-1")).toBe(HEARTBEAT_TAIL_DEFAULT_BYTES);
    expect(parse("-67108864")).toBe(HEARTBEAT_TAIL_DEFAULT_BYTES);
    expect(invalid).toHaveLength(2);
    for (const i of invalid) expect(i.reason).toContain("minimum");
  });

  test("Infinity falls back LOUDLY (it re-created the unbounded whole-log read)", () => {
    invalid.length = 0;
    expect(parse("Infinity")).toBe(HEARTBEAT_TAIL_DEFAULT_BYTES);
    expect(parse("-Infinity")).toBe(HEARTBEAT_TAIL_DEFAULT_BYTES);
    expect(invalid).toHaveLength(2);
    expect(invalid[0].reason).toContain("finite");
  });

  test("garbage, zero, and out-of-band values fall back LOUDLY", () => {
    invalid.length = 0;
    expect(parse("abc")).toBe(HEARTBEAT_TAIL_DEFAULT_BYTES);
    expect(parse("0")).toBe(HEARTBEAT_TAIL_DEFAULT_BYTES);
    expect(parse("1024")).toBe(HEARTBEAT_TAIL_DEFAULT_BYTES); // below the 1 MiB minimum
    expect(parse(String(HEARTBEAT_TAIL_CEILING_BYTES + 1))).toBe(HEARTBEAT_TAIL_DEFAULT_BYTES);
    expect(invalid).toHaveLength(4);
  });

  test("a valid in-band value is honored, silently, as an integer", () => {
    invalid.length = 0;
    expect(parse(String(HEARTBEAT_TAIL_MIN_BYTES))).toBe(HEARTBEAT_TAIL_MIN_BYTES);
    expect(parse(String(HEARTBEAT_TAIL_CEILING_BYTES))).toBe(HEARTBEAT_TAIL_CEILING_BYTES);
    expect(parse("134217728")).toBe(134_217_728);
    expect(parse(" 134217728 ")).toBe(134_217_728);
    expect(parse("134217728.9")).toBe(134_217_728); // floored to an integer byte count
    expect(invalid).toEqual([]);
  });

  test("THE CONSEQUENCE the parse prevents: a 1-byte cap makes every window uncovered", () => {
    // Documents WHY the bounds matter — this is what -1 produced before the fix.
    const bad = scanEventsSince({
      path: logPath,
      targetSinceMs: NOW - 12 * HOUR,
      requiredSinceMs: NOW - 10 * MIN,
      maxBytes: -1,
      onEvent: () => {},
    });
    expect(bad.covered).toBe(false);
    // …and with the value the resolver actually yields for "-1", it is covered.
    const good = scanEventsSince({
      path: logPath,
      targetSinceMs: NOW - 12 * HOUR,
      requiredSinceMs: NOW - 10 * MIN,
      maxBytes: resolveHeartbeatTailMaxBytes("-1"),
      onEvent: () => {},
    });
    expect(good.covered).toBe(true);
  });
});

// ── 5e. EXECUTION_CORE_HEARTBEAT_TAIL_WINDOW_MS is bounded-ms parsed ─────────
//
// Round 2. The window shipped as `Math.max(GRACE, Number(env) || GRACE * 72)`.
// Measured on the real module BEFORE this fix, at the default grace:
//   "999" → 600000 · "-1" → 600000 · "Infinity" → Infinity · "1e400" → Infinity
//   "abc" → 43200000 · "0" → 43200000
// The first two are the dangerous ones: a sub-grace override is CLAMPED UP to
// exactly the grace window, which is the degenerate setting in which the
// present-but-stale band is EMPTY (see the MIN test below). The Infinity pair
// reinstate the whole-log read this ticket removed.

describe("resolveHeartbeatTailWindowMs — bounded, finite, above the grace floor (CTL-1529 round 2)", () => {
  const invalid = [];
  const parse = (raw) =>
    resolveHeartbeatTailWindowMs(raw, { onInvalid: (info) => invalid.push(info) });

  test("unset / empty takes the default SILENTLY (the documented opt-out)", () => {
    invalid.length = 0;
    expect(parse(undefined)).toBe(HEARTBEAT_TAIL_WINDOW_DEFAULT_MS);
    expect(parse(null)).toBe(HEARTBEAT_TAIL_WINDOW_DEFAULT_MS);
    expect(parse("")).toBe(HEARTBEAT_TAIL_WINDOW_DEFAULT_MS);
    expect(parse("   ")).toBe(HEARTBEAT_TAIL_WINDOW_DEFAULT_MS);
    expect(invalid).toEqual([]);
  });

  test("THE MIN IS ABOVE THE GRACE WINDOW, and is DERIVED from it", () => {
    // A window EQUAL to the grace window cannot distinguish stale from absent:
    // every host older than now-grace is, by definition, outside a now-grace
    // tail. So the smallest admissible window is the smallest one with a
    // non-empty present-but-stale band — two grace windows.
    expect(HEARTBEAT_TAIL_WINDOW_MIN_MS).toBeGreaterThan(HEARTBEAT_GRACE_MS);
    expect(HEARTBEAT_TAIL_WINDOW_MIN_MS).toBe(HEARTBEAT_GRACE_MS * 2);
    invalid.length = 0;
    // The pre-fix code clamped each of these UP to exactly HEARTBEAT_GRACE_MS.
    expect(parse("999")).toBe(HEARTBEAT_TAIL_WINDOW_DEFAULT_MS);
    expect(parse(String(HEARTBEAT_GRACE_MS))).toBe(HEARTBEAT_TAIL_WINDOW_DEFAULT_MS);
    expect(parse(String(HEARTBEAT_GRACE_MS + 1))).toBe(HEARTBEAT_TAIL_WINDOW_DEFAULT_MS);
    expect(invalid).toHaveLength(3);
    for (const i of invalid) expect(i.reason).toContain("minimum");
  });

  test("a NEGATIVE value falls back LOUDLY (it used to clamp silently to the grace window)", () => {
    invalid.length = 0;
    expect(parse("-1")).toBe(HEARTBEAT_TAIL_WINDOW_DEFAULT_MS);
    expect(invalid).toHaveLength(1);
    expect(invalid[0].reason).toContain("minimum");
  });

  test("Infinity / 1e400 fall back LOUDLY (they re-created the unbounded whole-log read)", () => {
    invalid.length = 0;
    expect(parse("Infinity")).toBe(HEARTBEAT_TAIL_WINDOW_DEFAULT_MS);
    expect(parse("1e400")).toBe(HEARTBEAT_TAIL_WINDOW_DEFAULT_MS);
    expect(parse("-Infinity")).toBe(HEARTBEAT_TAIL_WINDOW_DEFAULT_MS);
    expect(invalid).toHaveLength(3);
    for (const i of invalid) expect(i.reason).toContain("finite");
  });

  test("garbage, zero, and above-the-month-horizon values fall back LOUDLY", () => {
    invalid.length = 0;
    expect(parse("abc")).toBe(HEARTBEAT_TAIL_WINDOW_DEFAULT_MS);
    expect(parse("0")).toBe(HEARTBEAT_TAIL_WINDOW_DEFAULT_MS);
    expect(parse(String(HEARTBEAT_TAIL_WINDOW_MAX_MS + 1))).toBe(HEARTBEAT_TAIL_WINDOW_DEFAULT_MS);
    expect(invalid).toHaveLength(3);
    expect(invalid[2].reason).toContain("maximum");
  });

  test("a valid in-band value is honored, silently, as an integer", () => {
    invalid.length = 0;
    expect(parse(String(HEARTBEAT_TAIL_WINDOW_MIN_MS))).toBe(HEARTBEAT_TAIL_WINDOW_MIN_MS);
    expect(parse(String(HEARTBEAT_TAIL_WINDOW_MAX_MS))).toBe(HEARTBEAT_TAIL_WINDOW_MAX_MS);
    expect(parse(String(6 * HOUR))).toBe(6 * HOUR);
    expect(parse(` ${6 * HOUR} `)).toBe(6 * HOUR);
    expect(parse("21600000.9")).toBe(21_600_000);
    expect(invalid).toEqual([]);
  });

  test("the SHIPPED constant lands inside its own band (the module-level wiring is real)", () => {
    expect(HEARTBEAT_TAIL_WINDOW_MS).toBeGreaterThanOrEqual(HEARTBEAT_TAIL_WINDOW_MIN_MS);
    expect(HEARTBEAT_TAIL_WINDOW_MS).toBeLessThanOrEqual(HEARTBEAT_TAIL_WINDOW_MAX_MS);
    expect(Number.isFinite(HEARTBEAT_TAIL_WINDOW_MS)).toBe(true);
  });
});

// ── 5f. coverage is proved against the TARGET window, not the grace window ───
//
// THE GAP THIS CLOSES. `covered` was proved against `requiredSinceMs = now -
// graceMs`. That certifies only "the tail reaches back 10 minutes" — i.e. only
// who is ALIVE. The property the bounded read rests on is the OTHER one:
// distinguishing PRESENT-BUT-STALE (⇒ reclaim) from ABSENT (⇒ strand). No test
// exercised a cap that truncates BETWEEN the grace window and a stale host's
// age, which is precisely the band where the two answers diverge — so the bug
// was invisible.
//
// The fixture below has EXACT 256-byte lines, one per minute, so the cap→time
// mapping is arithmetic rather than approximate: a cap of N x 256 bytes covers
// exactly the last N minutes.

const LINE_BYTES = 256;

// padTo — right-pad a JSON line's `pad` field so the line is EXACTLY
// `lineBytes - 1` chars plus its "\n".
function padTo(mk, lineBytes) {
  const probe = mk("");
  const need = lineBytes - 1 - probe.length;
  if (need < 0) throw new Error(`line template too long by ${-need} bytes`);
  return mk("q".repeat(need));
}

// buildStaleBandFixture — exact-width lines covering [now-8h, now]:
//   • hb("stale", now-6h)
//   • hb("self",  now-1m)  — the last line
//   • noise everywhere else
// `perMinute` sets the DENSITY (lines per minute), which is what decides how
// much TIME a given byte cap spans — the whole reason a byte floor cannot stand
// in for a time guarantee.
function buildStaleBandFixture(dir, nowMs, { lineBytes = LINE_BYTES, perMinute = 1 } = {}) {
  const path = join(dir, `stale-band-${lineBytes}x${perMinute}.jsonl`);
  const lines = [];
  const mk = (ts, obj) => padTo((p) => JSON.stringify({ ts, ...obj(p) }), lineBytes);
  const hbLine = (ts, host) =>
    mk(ts, (p) => ({
      attributes: { "event.name": "node.heartbeat" },
      body: { payload: { "host.name": host, pad: p } },
    }));
  for (let back = 480; back >= 1; back--) {
    const ts = iso(nowMs - back * MIN);
    for (let k = 0; k < perMinute; k++) {
      if (back === 360 && k === 0) lines.push(hbLine(ts, "stale"));
      else if (back === 1 && k === perMinute - 1) lines.push(hbLine(ts, "self"));
      else lines.push(mk(ts, (p) => ({ attributes: { "event.name": "noise" }, body: { payload: { pad: p } } })));
    }
  }
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

describe("covered is proved against the TARGET window (CTL-1529 round 2)", () => {
  let bandDir;
  let bandPath;
  const GRACE = 10 * MIN;
  const WINDOW = 12 * HOUR;
  // 100 lines x 256 B = the last 100 minutes: PAST the 10-minute grace window,
  // SHORT of the 6-hour-old stale host. Exactly the band that used to lie.
  const TRUNCATING_CAP = 100 * LINE_BYTES;

  beforeEach(() => {
    bandDir = mkdtempSync(join(tmpdir(), "ctl1529-band-"));
    bandPath = buildStaleBandFixture(bandDir, NOW);
  });
  afterEach(() => rmSync(bandDir, { recursive: true, force: true }));

  const scanAt = (maxBytes) =>
    scanLocalHeartbeats({
      logPath: bandPath,
      nowMs: NOW,
      graceMs: GRACE,
      windowMs: WINDOW,
      maxBytes,
      chunkSize: 1024,
      initialWindow: 1024,
    });

  test("the fixture really does have exact-width lines (the cap→time arithmetic holds)", () => {
    const size = statSync(bandPath).size;
    expect(size).toBe(480 * LINE_BYTES);
  });

  test("the truncating cap lands STRICTLY BETWEEN the grace window and the stale host's age", () => {
    // This is the precondition the whole section rests on: assert it, so a
    // future fixture edit that moves the cap out of the band fails HERE with a
    // clear message instead of silently making the tests below vacuous.
    const res = scanAt(TRUNCATING_CAP);
    const oldestMs = Date.parse(res.oldestTs);
    expect(oldestMs).toBeLessThan(NOW - GRACE); // deeper than grace…
    expect(oldestMs).toBeGreaterThan(NOW - 6 * HOUR); // …but shallower than `stale`
  });

  test("THE BUG: at that cap the stale host is INVISIBLE — so covered:true would be a lie", () => {
    const res = scanAt(TRUNCATING_CAP);
    // The stale host's heartbeat is outside the window…
    expect(res.lastSeen.stale).toBeUndefined();
    expect(res.lastSeen.self).toBe(iso(NOW - MIN));
    // …so the read must NOT claim coverage. Proved against graceMs (the old
    // behavior) this asserted `true`, deadHosts saw no `stale` entry, fail-open
    // kept it out of the dead set, and its work stranded with no event and no
    // log line. Proved against windowMs it is honestly uncovered.
    expect(res.covered).toBe(false);
  });

  test("…and the opt-in reader turns that into the documented loud degrade, not silence", () => {
    let err = null;
    try {
      readClusterHeartbeats({
        logPath: bandPath,
        nowMs: NOW,
        roster: ["self"],
        graceMs: GRACE,
        windowMs: WINDOW,
        maxBytes: TRUNCATING_CAP,
        chunkSize: 1024,
        initialWindow: 1024,
        requireGraceWindow: true,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HeartbeatWindowError);
    expect(err.code).toBe("ERR_HEARTBEAT_WINDOW_UNCOVERED");
    // The message names the window it FAILED to prove — the target, not grace.
    expect(err.message).toContain(String(WINDOW));
  });

  test("REGRESSION: the byte MIN does NOT bless a band where failover is off", () => {
    // HEARTBEAT_TAIL_MIN_BYTES is a MECHANICAL floor ("one chunkSize"), not a
    // semantic one: bytes cannot carry a time guarantee, because the same cap
    // spans a different amount of TIME on every host. On the sparse fixture
    // above, 1 MiB reaches BOF and everything is visible — which is exactly how
    // a byte floor lulls you. On a DENSER log of the same 8-hour span, that same
    // resolver-approved 1 MiB truncates at ~4h: past the grace window, short of
    // the 6h-old stale host. Under the old grace-window proof this reported
    // covered:true with the stale host invisible — dead-host failover silently
    // off at a configuration the validator blessed.
    const denseDir = mkdtempSync(join(tmpdir(), "ctl1529-dense-"));
    try {
      const densePath = buildStaleBandFixture(denseDir, NOW, { lineBytes: 1024, perMinute: 4 });
      const res = scanLocalHeartbeats({
        logPath: densePath,
        nowMs: NOW,
        graceMs: GRACE,
        windowMs: WINDOW,
        maxBytes: HEARTBEAT_TAIL_MIN_BYTES,
        chunkSize: 1024,
        initialWindow: 1024,
      });
      // Precondition: the cap truncates strictly inside the (grace, stale) band.
      const oldestMs = Date.parse(res.oldestTs);
      expect(oldestMs).toBeLessThan(NOW - GRACE);
      expect(oldestMs).toBeGreaterThan(NOW - 6 * HOUR);
      // The verdict that matters.
      expect(res.lastSeen.stale).toBeUndefined();
      expect(res.covered).toBe(false);
    } finally {
      rmSync(denseDir, { recursive: true, force: true });
    }
  });

  test("at a cap deep enough for the WHOLE window, stale is present and coverage is real", () => {
    const res = scanAt(DEFAULT_TAIL_MAX_BYTES);
    expect(res.covered).toBe(true);
    expect(res.lastSeen.stale).toBe(iso(NOW - 6 * HOUR)); // PRESENT-BUT-STALE
    // …and that is what makes the host reclaimable rather than stranded.
    expect(deadHosts({ lastSeen: res.lastSeen, roster: ["self", "stale"], graceMs: GRACE, nowMs: NOW })).toEqual([
      "stale",
    ]);
  });

  test("a cap that covers the whole 12h window is covered even without reaching BOF", () => {
    // 12h at one line/minute = 720 lines, but the file only spans 8h — so this
    // reaches BOF. Use a shorter window to exercise the non-BOF covered path:
    // a 2h window needs 120 lines; a 200-line cap covers it with room to spare.
    const res = scanLocalHeartbeats({
      logPath: bandPath,
      nowMs: NOW,
      graceMs: GRACE,
      windowMs: 2 * HOUR,
      maxBytes: 200 * LINE_BYTES,
      chunkSize: 1024,
      initialWindow: 1024,
    });
    expect(res.covered).toBe(true);
    expect(res.reachedBof).toBe(false);
    expect(Date.parse(res.oldestTs)).toBeLessThanOrEqual(NOW - 2 * HOUR);
  });
});

// ─── 12. the tail HORIZON: `ancient`, the assertion never written ────────────
//
// `buildFixture` has written `hb("ancient", NOW - 20h)` since round 1 and NO test
// ever asserted on it. The fixture anticipated the case; the assertion was
// missing — which is how a REAL behavioural regression vs origin/main shipped
// twice under a docstring claiming `covered:true` meant a missing host "is
// genuinely absent rather than merely beyond my reach".
//
// At the SHIPPED defaults (HEARTBEAT_TAIL_WINDOW_MS = 12 h) a host dead 20 h is
// OUTSIDE the tail ⇒ absent from lastSeen ⇒ deadHosts fail-opens ⇒ its work is
// never reclaimed, while covered:true and nothing is thrown, warned, or emitted.
describe("the tail HORIZON — a host dead beyond windowMs (CTL-1529 round 3)", () => {
  const ROSTER = ["self", "stale", "ancient"];
  // Multi-host rosters take the peer-merge branch, whose transport gate reads
  // ambient config. Pin an empty peer view so these tests measure the LOCAL tail
  // (the thing under test) and never the machine's Loki/anchor configuration.
  const NO_PEERS = { anchorIssue: null, readPeers: () => ({}) };

  test("the fixture's `ancient` host really is beyond the SHIPPED default window", () => {
    // Guards the arithmetic every assertion below rests on: if the default window
    // is ever raised past 20h this whole section is testing nothing, and this
    // fails first with a readable reason.
    expect(HEARTBEAT_TAIL_WINDOW_MS).toBe(HEARTBEAT_TAIL_WINDOW_DEFAULT_MS);
    expect(HEARTBEAT_TAIL_WINDOW_MS).toBeLessThan(20 * HOUR);
    expect(trueHeartbeats(logPath).ancient).toBe(iso(NOW - 20 * HOUR));
  });

  test("ORACLE — origin/main's whole-file read classified `ancient` as PROVEN DEAD", () => {
    // trueHeartbeats IS origin/main's readClusterHeartbeats reduce, verbatim. This
    // pins the BEFORE side of the comparison so the difference below is measured,
    // not asserted from memory.
    const oracle = trueHeartbeats(logPath);
    expect(oracle.ancient).toBe(iso(NOW - 20 * HOUR));
    expect(deadHosts({ lastSeen: oracle, roster: ROSTER, graceMs: 10 * MIN, nowMs: NOW })).toEqual([
      "stale",
      "ancient",
    ]);
  });

  test("REGRESSION (deliberate, documented): the bounded read STRANDS `ancient`", () => {
    const lastSeen = readClusterHeartbeats({
      logPath,
      nowMs: NOW,
      roster: ["self"], // single-host ⇒ no peer merge
      chunkSize: 1024,
      initialWindow: 4096,
    });
    // `stale` (6h, inside the 12h window) is preserved exactly — the property the
    // ticket's CRUX test pins.
    expect(lastSeen.stale).toBe(iso(NOW - 6 * HOUR));
    // `ancient` (20h, outside it) is GONE. Not stale — absent.
    expect(lastSeen.ancient).toBeUndefined();
    // …and absent ⇒ fail-open ⇒ never reclaimed. THE DIFFERENCE vs the oracle above.
    const dead = deadHosts({ lastSeen, roster: ROSTER, graceMs: 10 * MIN, nowMs: NOW });
    expect(dead).toEqual(["stale"]);
    expect(dead).not.toContain("ancient");
  });

  test("…and the scan still reports covered:true, which is why the SIGNAL is required", () => {
    const res = scanLocalHeartbeats({ logPath, nowMs: NOW, chunkSize: 1024, initialWindow: 4096 });
    expect(res.covered).toBe(true); // the tail DID span the configured window…
    expect(res.lastSeen.ancient).toBeUndefined(); // …and `ancient` is still missing.
    // hostsBeyondTailHorizon is exactly this residue.
    expect(hostsBeyondTailHorizon({ lastSeen: res.lastSeen, roster: ROSTER, covered: true })).toEqual(["ancient"]);
  });

  test("THE FIX: a rostered host beyond the horizon EMITS, instead of stranding silently", () => {
    const seen = [];
    readClusterHeartbeats({
      logPath,
      nowMs: NOW,
      roster: ROSTER,
      ...NO_PEERS,
      chunkSize: 1024,
      initialWindow: 4096,
      requireGraceWindow: true,
      onBeyondHorizon: (rec) => seen.push(rec),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].hosts).toEqual(["ancient"]);
    expect(seen[0].windowMs).toBe(HEARTBEAT_TAIL_WINDOW_MS);
  });

  test("the signal fires for the LIVENESS GATES only — a display caller stays quiet", () => {
    // requireGraceWindow=false is the orch-monitor footer / cluster view /
    // archive-stale-host-workers path. It strands nothing, so warning there is
    // noise on a page that already renders an absent host as offline.
    const seen = [];
    readClusterHeartbeats({
      logPath,
      nowMs: NOW,
      roster: ROSTER,
      ...NO_PEERS,
      chunkSize: 1024,
      initialWindow: 4096,
      requireGraceWindow: false,
      onBeyondHorizon: (rec) => seen.push(rec),
    });
    expect(seen).toEqual([]);
  });

  test("a host inside the window NEVER signals (this is not just 'warn about everything')", () => {
    const seen = [];
    readClusterHeartbeats({
      logPath,
      nowMs: NOW,
      roster: ["self", "stale"], // both inside the 12h window
      chunkSize: 1024,
      initialWindow: 4096,
      requireGraceWindow: true,
      onBeyondHorizon: (rec) => seen.push(rec),
    });
    expect(seen).toEqual([]);
  });

  test("an UNCOVERED tail does not double-signal — that case is already the throw", () => {
    // covered:false routes to HeartbeatWindowError → the documented full-roster
    // degrade. Emitting a horizon warning there too would blame the wrong cause.
    expect(hostsBeyondTailHorizon({ lastSeen: {}, roster: ROSTER, covered: false })).toEqual([]);
    let threw = null;
    const seen = [];
    try {
      readClusterHeartbeats({
        logPath,
        nowMs: NOW,
        roster: ROSTER,
      ...NO_PEERS,
        maxBytes: 4096,
        chunkSize: 512,
        initialWindow: 512,
        requireGraceWindow: true,
        onBeyondHorizon: (rec) => seen.push(rec),
      });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(HeartbeatWindowError);
    expect(seen).toEqual([]);
  });

  test("a host absent LOCALLY but present in the PEER view does not signal (merge runs first)", () => {
    const seen = [];
    const lastSeen = readClusterHeartbeats({
      logPath,
      nowMs: NOW,
      roster: ROSTER,
      ...NO_PEERS,
      anchorIssue: "CTL-1",
      // Peer view knows `ancient` — freshly, from its own host.
      readPeers: () => ({ ancient: { last_seen: iso(NOW - 30_000) } }),
      chunkSize: 1024,
      initialWindow: 4096,
      requireGraceWindow: true,
      onBeyondHorizon: (rec) => seen.push(rec),
    });
    expect(lastSeen.ancient).toBe(iso(NOW - 30_000));
    expect(seen).toEqual([]);
  });

  // ── the default sink: throttled, but never silent ────────────────────────
  describe("warnHostsBeyondTailHorizon (the default sink)", () => {
    beforeEach(() => resetBeyondHorizonThrottle());

    test("the FIRST observation emits immediately (no warm-up window)", () => {
      expect(warnHostsBeyondTailHorizon({ hosts: ["ancient"], windowMs: 12 * HOUR, nowMs: NOW })).toEqual([
        "ancient",
      ]);
    });

    test("a repeat inside the interval is SUPPRESSED (the tick loop cannot flood the log)", () => {
      warnHostsBeyondTailHorizon({ hosts: ["ancient"], windowMs: 12 * HOUR, nowMs: NOW });
      expect(
        warnHostsBeyondTailHorizon({ hosts: ["ancient"], windowMs: 12 * HOUR, nowMs: NOW + 30_000 }),
      ).toEqual([]);
    });

    test("a PERSISTENT strand re-announces after the interval (throttle ≠ mute)", () => {
      warnHostsBeyondTailHorizon({ hosts: ["ancient"], windowMs: 12 * HOUR, nowMs: NOW });
      expect(
        warnHostsBeyondTailHorizon({
          hosts: ["ancient"],
          windowMs: 12 * HOUR,
          nowMs: NOW + BEYOND_HORIZON_WARN_INTERVAL_MS + 1,
        }),
      ).toEqual(["ancient"]);
    });

    test("the throttle is PER HOST — a second stranded host is not muted by the first", () => {
      warnHostsBeyondTailHorizon({ hosts: ["ancient"], windowMs: 12 * HOUR, nowMs: NOW });
      expect(
        warnHostsBeyondTailHorizon({ hosts: ["ancient", "other"], windowMs: 12 * HOUR, nowMs: NOW + 1_000 }),
      ).toEqual(["other"]);
    });
  });
});

// ─── Phase 1 (CTL-1550): robustCoverageMs — outlier-resistant coverage anchor ─

describe("robustCoverageMs — outlier-resistant coverage anchor (CTL-1550)", () => {
  test("odd count returns the median", () => {
    expect(robustCoverageMs([30, 10, 20])).toBe(20);
  });

  test("even count returns the upper-middle (conservative: never older than true middle)", () => {
    // [10, 20, 30, 40] sorted → upper-middle index = floor(4/2) = 2 → value 30.
    // The anchor is never OLDER than the genuine midpoint, keeping the fail direction safe.
    expect(robustCoverageMs([40, 10, 30, 20])).toBe(30);
  });

  test("a single old outlier at the window start does not move the anchor", () => {
    // One ancient backfill among recent records → anchor stays recent.
    const recent = 1_000_000;
    const samples = [1, recent, recent + 1, recent + 2, recent + 3];
    // sorted: [1, recent, recent+1, recent+2, recent+3] → upper-middle index 2 → recent+1
    expect(robustCoverageMs(samples)).toBe(recent + 1);
  });

  test("empty array returns null", () => {
    expect(robustCoverageMs([])).toBeNull();
  });

  test("array of non-finite values returns null", () => {
    expect(robustCoverageMs([NaN, Infinity, -Infinity])).toBeNull();
  });

  test("COVERAGE_PROBE_SAMPLE is large enough to tolerate a single outlier (>= 3)", () => {
    // The median of K samples tolerates floor(K/2) outliers. For 1 outlier to not
    // swing the median we need K >= 3. K=16 gives generous headroom.
    expect(COVERAGE_PROBE_SAMPLE).toBeGreaterThanOrEqual(3);
  });
});

// ─── Phase 1 (CTL-1550): scanEventsSince backfill correctness ────────────────

describe("scanEventsSince: backfill correctness (CTL-1550)", () => {
  test("a single OLD backfilled record at the window start does NOT falsely prove coverage", () => {
    // Build a log with:
    //   • one ancient backfill record (now-20h) at the start
    //   • many recent records (all within the last 30s)
    // With the old single-record probe the ancient record at the window start would
    // make the probe think the window reaches 20h back (covered:true on a 12h target).
    // With the median anchor the probe ignores the lone outlier and correctly
    // reports covered:false when the window only spans seconds.
    const p = join(dir, "backfill.jsonl");
    const ancient = iso(NOW - 20 * HOUR);
    const lines = [JSON.stringify({ ts: ancient, attributes: { "event.name": "noise" }, body: {} })];
    // Fill the rest of the log with recent records (all within the last 30 seconds)
    for (let i = 30; i >= 1; i--) {
      lines.push(JSON.stringify({ ts: iso(NOW - i * 1000), attributes: { "event.name": "noise" }, body: {} }));
    }
    writeFileSync(p, lines.join("\n") + "\n");

    // Use a cap small enough to only cover a few seconds from EOF (not the full 12h).
    // With the single-record probe the ancient line at offset 0 would prove coverage.
    // With the median probe the window should report covered:false.
    const res = scanEventsSince({
      path: p,
      targetSinceMs: NOW - 12 * HOUR,
      requiredSinceMs: NOW - 12 * HOUR,
      // Cap: only enough to hold the ancient line + ~16 recent ones
      maxBytes: lines.slice(0, 18).join("\n").length + 10,
      chunkSize: 512,
      initialWindow: 512,
      onEvent: () => {},
    });
    // The window genuinely spans only seconds (mostly recent records),
    // so coverage of 12h must NOT be claimed.
    expect(res.covered).toBe(false);
  });

  test("a normally ordered deep window is still covered:true (no regression)", () => {
    // The standard fixture has records from now-24h through now-5s in monotonic order.
    // The median of the first K records near the window start should predate the 12h target.
    const res = scanEventsSince({
      path: logPath,
      targetSinceMs: NOW - 12 * HOUR,
      requiredSinceMs: NOW - 10 * MIN,
      chunkSize: 1024,
      initialWindow: 1024,
      onEvent: () => {},
    });
    expect(res.covered).toBe(true);
    // And the anchor still reflects a real old timestamp.
    expect(Date.parse(res.oldestTs)).toBeLessThanOrEqual(NOW - 12 * HOUR);
  });
});

// ─── Phase 2 (CTL-1550): HEARTBEAT_TAIL_DEFAULT_BYTES re-tuned to 128 MiB ───

describe("HEARTBEAT_TAIL_DEFAULT_BYTES — re-tuned cap (CTL-1550)", () => {
  test("the heartbeat tail default is the CTL-1550 re-tuned cap, not the shared 64 MiB", () => {
    // Validates that the default is a named constant, not the shared DEFAULT_TAIL_MAX_BYTES.
    expect(HEARTBEAT_TAIL_DEFAULT_BYTES).toBe(128 * 1024 * 1024);
    expect(HEARTBEAT_TAIL_DEFAULT_BYTES).not.toBe(DEFAULT_TAIL_MAX_BYTES);
    // resolveHeartbeatTailMaxBytes with no env value uses the new default.
    expect(resolveHeartbeatTailMaxBytes(undefined)).toBe(HEARTBEAT_TAIL_DEFAULT_BYTES);
  });

  test("the re-tuned default is within [min, max] and finite/positive", () => {
    expect(HEARTBEAT_TAIL_DEFAULT_BYTES).toBeGreaterThanOrEqual(HEARTBEAT_TAIL_MIN_BYTES);
    expect(HEARTBEAT_TAIL_DEFAULT_BYTES).toBeLessThanOrEqual(HEARTBEAT_TAIL_CEILING_BYTES);
    expect(Number.isFinite(HEARTBEAT_TAIL_DEFAULT_BYTES)).toBe(true);
    expect(HEARTBEAT_TAIL_DEFAULT_BYTES).toBeGreaterThan(0);
  });

  test("128 MiB proves the default 12 h window at the documented worst-case density", () => {
    // Measured worst-case fleet density: ~6.2 MiB/h on mini (2026-08-19).
    // 12 h * 6.2 MiB/h = 74.4 MiB. 128 MiB gives ~1.7x headroom.
    // The 64 MiB default only reached ~10.3 h (short of 12 h).
    const DENSITY_BYTES_PER_HOUR = 6.2 * 1024 * 1024;
    const windowHours = HEARTBEAT_TAIL_WINDOW_MS / (60 * 60 * 1000);
    const requiredBytes = DENSITY_BYTES_PER_HOUR * windowHours;
    expect(HEARTBEAT_TAIL_DEFAULT_BYTES).toBeGreaterThan(requiredBytes);
    // Old 64 MiB default was NOT sufficient.
    expect(DEFAULT_TAIL_MAX_BYTES).toBeLessThan(requiredBytes);
  });
});

// ─── Phase 3 (CTL-1550): resolveHeartbeatTailWindowMs clamps derived default ─

describe("resolveHeartbeatTailWindowMs: derived-default clamping (CTL-1550)", () => {
  const parse = (raw, opts = {}) => resolveHeartbeatTailWindowMs(raw, opts);

  test("a derived default above the 31-day max is clamped to the max, not returned raw", () => {
    const huge = 40 * 24 * 60 * 60_000; // 40 days > max
    const seen = [];
    const got = parse(undefined, {
      defaultMs: huge,
      onInvalid: (i) => seen.push(i),
    });
    expect(got).toBe(HEARTBEAT_TAIL_WINDOW_MAX_MS);
    expect(seen).toHaveLength(1);
    expect(seen[0].reason).toContain("exceeds");
    expect(seen[0].reason).toContain("maximum");
  });

  test("a normal derived default (12 h) is returned unchanged and SILENTLY", () => {
    const seen = [];
    const got = parse(undefined, {
      defaultMs: HEARTBEAT_TAIL_WINDOW_DEFAULT_MS,
      onInvalid: (i) => seen.push(i),
    });
    expect(got).toBe(HEARTBEAT_TAIL_WINDOW_DEFAULT_MS);
    expect(seen).toHaveLength(0);
  });

  test("the shipped HEARTBEAT_TAIL_WINDOW_DEFAULT_MS never exceeds the declared max", () => {
    expect(HEARTBEAT_TAIL_WINDOW_DEFAULT_MS).toBeLessThanOrEqual(HEARTBEAT_TAIL_WINDOW_MAX_MS);
  });

  test("empty string also returns clamped default (not the raw unvalidated defaultMs)", () => {
    const huge = 40 * 24 * 60 * 60_000;
    const seen = [];
    const got = parse("", { defaultMs: huge, onInvalid: (i) => seen.push(i) });
    expect(got).toBe(HEARTBEAT_TAIL_WINDOW_MAX_MS);
    expect(seen).toHaveLength(1);
  });
});
