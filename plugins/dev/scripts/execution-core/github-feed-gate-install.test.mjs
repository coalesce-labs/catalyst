// Run: cd plugins/dev/scripts/execution-core && bun test github-feed-gate-install.test.mjs

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { READY_CACHE_MS, createGithubFeedGate, defaultGithubCapturePath } from "./github-feed-gate-install.mjs";
import { staleWindowMs } from "./github-feed-ready.mjs";
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

  const gateWith = (ready) =>
    createGithubFeedGate({
      orchDir: tmp,
      config: { mode: "enforce", intervalSec: 30 },
      captureFactory: stubCapture,
      readState: () => ready,
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
    // The whole-system statement of the per-name rule: a healthy producer cannot
    // earn the right to suppress the merge→deploy join key.
    const v = decideDispatch(smee("github.pr.merged"), gateWith({ ready: true, reason: "producer-ready" }));
    expect(v.suppress).toBe(false);
    expect(v.reason).toContain("CTC-691");
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
