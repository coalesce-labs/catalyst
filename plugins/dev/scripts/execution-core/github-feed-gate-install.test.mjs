// Run: cd plugins/dev/scripts/execution-core && bun test github-feed-gate-install.test.mjs

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COVERAGE_CACHE_MS,
  READY_CACHE_MS,
  createGithubFeedGate,
  defaultGithubCapturePath,
  readGithubCoverage,
} from "./github-feed-gate-install.mjs";
import { staleWindowMs } from "./github-feed-ready.mjs";
import { startGithubFeedTimer } from "./github-feed-timer.mjs"; // CTL-1976
import { getExecutionCoreDir } from "./config.mjs"; // CTL-1976
import { decideDispatch } from "./github-feed-gate.mjs";

const tmp = mkdtempSync(join(tmpdir(), "gh-gate-install-"));
afterAll(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* never fail in cleanup */ } });

const stubCapture = () => ({ path: "/dev/null", append() {}, stats: () => ({}) });

describe("⛔ off constructs NOTHING — routing stays byte-identical to pre-CTL-1929", () => {
  test("mode off returns null", () => {
    expect(createGithubFeedGate({ orchDir: tmp, config: { mode: "off", intervalSec: 30 }, captureFactory: stubCapture })).toBeNull();
  });

  test("shadow and enforce construct a gate", () => {
    for (const mode of ["shadow", "enforce"]) {
      const g = createGithubFeedGate({ orchDir: tmp, config: { mode, intervalSec: 30 }, captureFactory: stubCapture });
      expect(g?.mode).toBe(mode);
    }
  });
});

describe("⚠️ the readiness cache spares the broker's hot path without becoming a second latch", () => {
  const mkGate = (states, { clock }) => {
    let i = 0;
    const reads = [];
    const g = createGithubFeedGate({
      orchDir: tmp,
      config: { mode: "enforce", intervalSec: 30 },
      captureFactory: stubCapture,
      now: () => clock.t,
      readState: () => { reads.push(clock.t); return states[Math.min(i++, states.length - 1)]; },
    });
    return { g, reads };
  };

  test("repeated probes inside the window read the file ONCE", () => {
    // The broker routes every event this fleet appends (687 per 5 min on mini-2,
    // into an 883 MB log). A readFileSync per event is the thing this exists to stop.
    const clock = { t: 1000 };
    const { g, reads } = mkGate([{ ready: true, reason: "producer-ready" }], { clock });
    for (let n = 0; n < 500; n += 1) g.isReady();
    expect(reads).toHaveLength(1);
  });

  test("⛔ the cache expires, so an un-arm is delayed by at most READY_CACHE_MS", () => {
    const clock = { t: 1000 };
    const { g, reads } = mkGate(
      [{ ready: true, reason: "producer-ready" }, { ready: false, reason: "ready-file-stale:95s" }],
      { clock },
    );
    expect(g.isReady().ready).toBe(true);
    clock.t += READY_CACHE_MS - 1;
    expect(g.isReady().ready).toBe(true); // still cached
    clock.t += 2;
    expect(g.isReady().ready).toBe(false); // re-read
    expect(reads).toHaveLength(2);
  });

  test("⛔ the cache window stays FAR below the staleness window it feeds", () => {
    // If the cache ever grew past the staleness bound it would become a second,
    // longer latch on top of the one that bound exists to break. Asserted as a
    // relation rather than as two constants, so tuning either cannot invert it.
    expect(READY_CACHE_MS).toBeLessThan(staleWindowMs(30) / 10);
    expect(READY_CACHE_MS).toBeLessThan(staleWindowMs(5) / 10);
  });

  test("⚠️ a failing read REPLACES the cached verdict rather than preserving the last good one", () => {
    // Keeping the last good verdict on error would make an unreadable file behave
    // like a fresh one — the latch again, arriving through the error path.
    const clock = { t: 1000 };
    const { g } = mkGate(
      [{ ready: true, reason: "producer-ready" }, { ready: false, reason: "ready-file-absent" }],
      { clock },
    );
    expect(g.isReady().ready).toBe(true);
    clock.t += READY_CACHE_MS + 1;
    expect(g.isReady()).toMatchObject({ ready: false, reason: "ready-file-absent" });
  });

  test("⛔ the FIRST probe reads the file — it never answers from a construction-time default", () => {
    // ⚠️ I first wrote this as "before any read, the gate is NOT ready" and the
    //    mutation (seeding the cache `ready: true`) PASSED — because the first
    //    isReady() always re-reads, the seed value is unreachable and asserting on it
    //    asserts nothing. The real property is that no event can be decided before a
    //    read has happened, which is what makes the seed unreachable in the first place.
    const clock = { t: 0 };
    let reads = 0;
    const g = createGithubFeedGate({
      orchDir: tmp,
      config: { mode: "enforce", intervalSec: 30 },
      captureFactory: stubCapture,
      now: () => clock.t,
      readState: () => { reads += 1; return { ready: false, reason: "ready-file-absent" }; },
    });
    expect(reads).toBe(0); // construction does not probe
    expect(g.isReady()).toMatchObject({ ready: false, reason: "ready-file-absent" });
    expect(reads).toBe(1); // ...the first probe does
  });
});

describe("the installed gate composes with decideDispatch as one decision", () => {
  const smee = (name) => ({
    attributes: { "event.name": name, "webhook.delivery.id": "d1" },
    body: { payload: {} },
  });

  // ⛔ `readCoverage` IS INJECTED, and it must be. Without it the factory falls back
  // to the real `readGithubCoverage`, which opens THIS MACHINE's replica — so the
  // suite's verdict would depend on which schema the host running CI happens to be
  // pinned to, and every assertion below would silently change meaning the day
  // 0.1.18 rolled. The default path is exercised deliberately, once, further down.
  const COVERAGE_0117 = () => ({ pushIsLossy: false, checkSuiteHasPrAssociation: false, ok: true });
  const gateWith = (ready, readCoverage = COVERAGE_0117) =>
    createGithubFeedGate({
      orchDir: tmp,
      config: { mode: "enforce", intervalSec: 30 },
      captureFactory: stubCapture,
      readState: () => ready,
      readCoverage,
    });

  test("ready producer → a covered name is suppressed", () => {
    expect(decideDispatch(smee("github.pr.opened"), gateWith({ ready: true, reason: "producer-ready" })).suppress).toBe(true);
  });

  test("⛔ stale ready file → smee keeps authority, and the capture record says why", () => {
    const v = decideDispatch(smee("github.pr.opened"), gateWith({ ready: false, reason: "ready-file-stale:95s" }));
    expect(v.suppress).toBe(false);
    expect(v.reason).toBe("enforce-not-armed:ready-file-stale:95s");
  });

  test("⛔ ready producer still does NOT suppress an uncovered name", () => {
    // The whole-system statement of the per-name rule: a healthy producer cannot earn
    // the right to suppress a name whose consumer it cannot reach. ⚠️ The example
    // moved from pr.merged to check_suite when CTC-691 landed — pr.merged is covered
    // now; check_suite's TABLE landed but the PR association did not (CTC-712).
    const v = decideDispatch(smee("github.check_suite.completed"), gateWith({ ready: true, reason: "producer-ready" }));
    expect(v.suppress).toBe(false);
    expect(v.reason).toContain("CTC-712");
  });
});

describe("the capture path is per account and is not the event log", () => {
  test("account appears in the path", () => {
    expect(defaultGithubCapturePath("/orch", "tenant-0")).toContain("tenant-0");
    expect(defaultGithubCapturePath("/orch", "tenant-0")).toContain("github-suppressed");
  });

  test("⛔ construction refuses an event-log-shaped capture path", () => {
    // Inherited from createCaptureSink's structural refusal: if the capture file were
    // the event log, every suppressed event would be re-appended as a real one.
    expect(() =>
      createGithubFeedGate({
        orchDir: tmp,
        config: { mode: "enforce", intervalSec: 30 },
        capturePath: join(tmp, "events", "2026-08.jsonl"),
      }),
    ).toThrow();
  });
});

describe("CTC-712 — the gate's coverage tracks the replica, and re-reads it", () => {
  const stubCapture2 = () => ({ path: join(tmp, "cap2.jsonl"), append: () => {} });
  const smee2 = (name) => ({
    attributes: { "event.name": name, "webhook.delivery.id": "d1" },
    body: { payload: {} },
  });

  const at = (checkSuiteHasPrAssociation, pushIsLossy = false) =>
    () => ({ pushIsLossy, checkSuiteHasPrAssociation, ok: true });

  const mk = (readCoverage, now = () => 0) =>
    createGithubFeedGate({
      orchDir: tmp,
      config: { mode: "enforce", intervalSec: 30 },
      captureFactory: stubCapture2,
      readState: () => ({ ready: true, reason: "producer-ready" }),
      readCoverage,
      now,
    });

  test("a 0.1.18 host suppresses check_suite; a 0.1.17 host does not", () => {
    expect(decideDispatch(smee2("github.check_suite.completed"), mk(at(true))).suppress).toBe(true);
    expect(decideDispatch(smee2("github.check_suite.completed"), mk(at(false))).suppress).toBe(false);
  });

  test("⛔ the coverage is RE-READ after the TTL — a writer restart is invisible to this process", () => {
    // Both capabilities appear when the cloud-sync writer restarts and migrates. This
    // process is never told. A boot-only read would leave a broker that started before
    // the 0.1.18 restart under-reporting its own coverage for the rest of its life,
    // and an operator would have to know to bounce a second daemon to collect it.
    let assoc = false;
    let t = 0;
    const gate = mk(() => ({ pushIsLossy: false, checkSuiteHasPrAssociation: assoc, ok: true }), () => t);

    expect(decideDispatch(smee2("github.check_suite.completed"), gate).suppress).toBe(false);
    assoc = true;                       // the migration lands
    t = COVERAGE_CACHE_MS - 1;          // still inside the cache window
    expect(decideDispatch(smee2("github.check_suite.completed"), gate).suppress).toBe(false);
    t = COVERAGE_CACHE_MS + 1;          // past it
    expect(decideDispatch(smee2("github.check_suite.completed"), gate).suppress).toBe(true);
  });

  test("⚠️ and it re-reads in the LOSING direction too — a rollback is picked up", () => {
    let assoc = true;
    let t = 0;
    const gate = mk(() => ({ pushIsLossy: false, checkSuiteHasPrAssociation: assoc, ok: true }), () => t);
    expect(decideDispatch(smee2("github.check_suite.completed"), gate).suppress).toBe(true);
    assoc = false;
    t = COVERAGE_CACHE_MS + 1;
    expect(decideDispatch(smee2("github.check_suite.completed"), gate).suppress).toBe(false);
  });

  test("⛔ a throwing coverage probe leaves smee authoritative for BOTH gated names", () => {
    const gate = mk(() => { throw new Error("replica locked"); });
    // The whole point of failing closed: an unreadable database must not license
    // suppression. It must also not take the gate down for names that are covered
    // regardless — pr.opened still suppresses.
    expect(() => decideDispatch(smee2("github.check_suite.completed"), gate)).not.toThrow();
    expect(decideDispatch(smee2("github.check_suite.completed"), gate).suppress).toBe(false);
    expect(decideDispatch(smee2("github.push"), gate).suppress).toBe(false);
    expect(decideDispatch(smee2("github.pr.opened"), gate).suppress).toBe(true);
  });

  test("⛔ readGithubCoverage FAILS CLOSED on an unusable replica — and says ok:false", () => {
    const bad = readGithubCoverage({ sourceFactory: () => { throw new Error("no replica"); } });
    expect(bad).toEqual({ pushIsLossy: true, checkSuiteHasPrAssociation: false, ok: false });
    // ⚠️ `ok` is what separates "measured as uncovered" from "could not look". Without
    // it the two are byte-identical to every caller, which is the defect class this
    // repo keeps re-learning.
    const good = readGithubCoverage({
      sourceFactory: () => ({
        pushIsLossy: () => false, checkSuiteHasPrAssociation: () => true, close: () => {},
      }),
    });
    expect(good).toEqual({ pushIsLossy: false, checkSuiteHasPrAssociation: true, ok: true });
  });

  test("⭐ THE DEFAULT PATH RUNS — readGithubCoverage() with no arguments at all", () => {
    // ⛔ Every test above injects `sourceFactory`, so none of them would notice if the
    // real default could not execute. It could not: the first cut reached for
    // `require("bun:sqlite")` inside an ESM module, which throws on every call and is
    // caught by the same handler that catches a missing replica — so the probe would
    // have returned ok:false forever, on every host, and the gate would have silently
    // refused to ever suppress either name. Nothing else here can see that.
    const r = readGithubCoverage();
    expect(typeof r.ok).toBe("boolean");
    expect(typeof r.pushIsLossy).toBe("boolean");
    expect(typeof r.checkSuiteHasPrAssociation).toBe("boolean");
    if (!r.ok) {
      console.log("INCONCLUSIVE: no readable replica on this host — the default path could not be proven to reach one.");
      return;
    }
    // A replica IS present and was opened by the default factory: that is the claim.
    expect(r.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CTL-1976 — the readiness file is written by the PRODUCER and read by the GATE,
// in two different processes. Every test above injects `readState`, so until this
// block the DEFAULT `readyPath` — the only one production uses — was never
// asserted, and it pointed at a file nothing writes.
// ─────────────────────────────────────────────────────────────────────────────
describe("⛔ CTL-1976: the gate reads the file the PRODUCER writes, not one under the caller's dir", () => {
  const withCatalystDir = (dir, fn) => {
    const prev = process.env.CATALYST_DIR;
    process.env.CATALYST_DIR = dir;
    try { return fn(); } finally {
      if (prev === undefined) delete process.env.CATALYST_DIR;
      else process.env.CATALYST_DIR = prev;
    }
  };

  test("⭐ the default readyPath is the producer's, and does NOT follow the installer's orchDir", () => {
    const root = mkdtempSync(join(tmpdir(), "gh-ready-path-"));
    try {
      withCatalystDir(root, () => {
        // The broker's REAL call shape (broker/tailer.mjs:52): orchDir = CATALYST_DIR.
        const g = createGithubFeedGate({
          orchDir: root,
          account: "tenant-0",
          config: { mode: "enforce", intervalSec: 30 },
          captureFactory: stubCapture,
        });
        // The producer writes under execution-core/, one level DOWN from CATALYST_DIR.
        expect(g.readyPath).toBe(join(root, "execution-core", "shadow", "github-feed-ready-tenant-0.json"));
        // ⛔ The mutation this block owns: the pre-CTL-1976 code produced exactly the
        // path below, which nothing ever writes. Asserted as a NON-match so the test
        // fails if the derivation is ever put back on the caller's dir.
        expect(g.readyPath).not.toBe(join(root, "shadow", "github-feed-ready-tenant-0.json"));
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("⭐ equal BY CONSTRUCTION to what the producer's own timer writes — not to a second string literal", () => {
    const root = mkdtempSync(join(tmpdir(), "gh-ready-parity-"));
    try {
      // ⚠️ SYNCHRONOUS ON PURPOSE. An `async` body here would return a promise to
      // withCatalystDir, whose `finally` then restores CATALYST_DIR *before* the body
      // runs — so both sides would resolve the ambient hermetic dir and agree for a
      // reason the test does not name. Caught by running this block under the mutation.
      withCatalystDir(root, () => {
        const noopClock = { setInterval: () => ({ unref() {} }), clearInterval: () => {} };
        // daemon.mjs's own argument shape: orchDir = getExecutionCoreDir().
        const timer = startGithubFeedTimer({
          mode: "shadow",
          orchDir: getExecutionCoreDir(),
          account: "tenant-0",
          eventLogPath: join(root, "events.jsonl"),
          appendFn: () => {},
          clock: noopClock,
        });
        const gate = createGithubFeedGate({
          orchDir: root, // the BROKER's dir — deliberately different from the producer's
          account: "tenant-0",
          config: { mode: "enforce", intervalSec: 30 },
          captureFactory: stubCapture,
        });
        // Positive control: the two dirs really are different, so an accidental
        // pass-because-both-are-the-same-root is not possible here.
        expect(getExecutionCoreDir()).not.toBe(root);
        expect(gate.readyPath).toBe(timer.readyPath);
        timer.stop();
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("the CAPTURE sink still follows the installer's orchDir — it is the broker's artifact, not the producer's", () => {
    const root = mkdtempSync(join(tmpdir(), "gh-capture-path-"));
    try {
      withCatalystDir(root, () => {
        let seen = null;
        createGithubFeedGate({
          orchDir: root,
          account: "tenant-0",
          config: { mode: "enforce", intervalSec: 30 },
          captureFactory: ({ path }) => { seen = path; return stubCapture(); },
        });
        expect(seen).toBe(defaultGithubCapturePath(root, "tenant-0"));
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("an explicit readyPath still wins — the seam the existing tests depend on is untouched", () => {
    const g = createGithubFeedGate({
      orchDir: tmp,
      readyPath: "/explicit/ready.json",
      config: { mode: "enforce", intervalSec: 30 },
      captureFactory: stubCapture,
    });
    expect(g.readyPath).toBe("/explicit/ready.json");
  });

  test("⛔ a missing ready file leaves smee AUTHORITATIVE — the failure mode this bug hid", () => {
    const root = mkdtempSync(join(tmpdir(), "gh-ready-absent-"));
    try {
      withCatalystDir(root, () => {
        const g = createGithubFeedGate({
          orchDir: root,
          account: "tenant-0",
          config: { mode: "enforce", intervalSec: 30 },
          captureFactory: stubCapture,
        });
        // Nothing has written the producer's file, so the probe must decline.
        const verdict = g.isReady();
        expect(verdict.ready).toBe(false);
        expect(verdict.reason).toBe("ready-file-absent");
        // …and the smee copy therefore keeps routing rather than being suppressed.
        const smee = { attributes: { "event.name": "github.pr.merged" }, resource: {} };
        const d = decideDispatch(smee, g);
        expect(d.suppress).toBe(false);
        expect(d.reason).toContain("enforce-not-armed");
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
