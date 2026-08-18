// Run: cd plugins/dev/scripts/execution-core && bun test github-feed-timer.test.mjs

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EVENT_WOULD_DISPATCH,
  assertNotEventLog,
  buildWouldDispatchEvent,
  defaultShadowPath,
  resolveAccount,
  resolveEffectiveMode,
  runGithubFeedTick,
  startGithubFeedTimer,
} from "./github-feed-timer.mjs";
import { DEFAULT_ACCOUNT } from "./linear-feed-run.mjs";
import { defaultSeenPath } from "./github-feed-seen.mjs";
import { streamCursorPath } from "./github-feed-sweep.mjs";
import { readGithubFeedConfig } from "./config.mjs";

const tmp = mkdtempSync(join(tmpdir(), "gh-feed-timer-"));
afterAll(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* never fail in cleanup */ } });

describe("⛔ the knob is SEPARATE from the Linear leg's — a merge must not flip GitHub to enforce", () => {
  test("CATALYST_CLOUD_FEED=enforce leaves the GitHub leg OFF", () => {
    // Every worker already runs the Linear leg at enforce. If this read the same
    // value, merging the wiring would enforce the GitHub leg fleet-wide with no
    // operator action — while pr.merged and check_suite.completed are unproducible.
    const cfg = readGithubFeedConfig({ CATALYST_CLOUD_FEED: "enforce", HOME: tmp });
    expect(cfg.mode).toBe("off");
  });

  test("it ships OFF, and only its own env var moves it", () => {
    expect(readGithubFeedConfig({ HOME: tmp }).mode).toBe("off");
    expect(readGithubFeedConfig({ CATALYST_GITHUB_FEED: "shadow", HOME: tmp }).mode).toBe("shadow");
    expect(readGithubFeedConfig({ CATALYST_GITHUB_FEED: "0", HOME: tmp }).mode).toBe("off");
    expect(readGithubFeedConfig({ CATALYST_GITHUB_FEED: "nonsense", HOME: tmp }).mode).toBe("off");
  });

  test("a zero or empty interval cannot busy-spin the tick", () => {
    // Number("") and Number(null) are both 0 — a valid-looking "0 seconds".
    for (const v of ["", "0", "1", "abc"]) {
      expect(readGithubFeedConfig({ CATALYST_GITHUB_FEED_INTERVAL_SEC: v, HOME: tmp }).intervalSec).toBe(30);
    }
    expect(readGithubFeedConfig({ CATALYST_GITHUB_FEED_INTERVAL_SEC: "60", HOME: tmp }).intervalSec).toBe(60);
  });
});

describe("⛔ P2 (Codex #3524): the account is resolved, never hard-coded", () => {
  test("a host on another tenant labels its artifacts with THAT tenant", () => {
    // A hard-coded default does not fail here — it silently files this host's parity
    // evidence, suppression store and nine cursor files under `tenant-0` while the
    // artifacts still look complete. That is worse than an error.
    expect(resolveAccount({ CATALYST_CLOUD_ACCOUNT: "tenant-7" })).toBe("tenant-7");
    expect(defaultShadowPath("/o", resolveAccount({ CATALYST_CLOUD_ACCOUNT: "tenant-7" })))
      .toContain("github-feed-tenant-7.jsonl");
    expect(buildWouldDispatchEvent({ attributes: {} }, { account: "tenant-7" }).body.payload.account)
      .toBe("tenant-7");
  });

  test("it falls back to the SAME default the Linear leg uses, imported not re-typed", () => {
    expect(resolveAccount({})).toBe(DEFAULT_ACCOUNT);
    expect(DEFAULT_ACCOUNT).toBe("tenant-0");
  });

  test("⛔ per-tenant artifact builders REFUSE an absent account", () => {
    // Fail closed rather than defaulting: an unlabelled artifact is indistinguishable
    // from a correctly-labelled one after the fact.
    expect(() => defaultSeenPath("/o")).toThrow();
    expect(() => streamCursorPath("/o", "push")).toThrow();
  });
});

describe("⛔ enforce is refused BY NAME, not silently", () => {
  test("enforce degrades to shadow and carries a reason", () => {
    const r = resolveEffectiveMode("enforce");
    expect(r.effective).toBe("shadow");
    expect(r.degraded).toBe(true);
    expect(r.reason).toContain("CTC-691");
    // requested and effective stay distinct — a degraded node must not be
    // indistinguishable from a configured one.
    expect(r.requested).toBe("enforce");
  });

  test("shadow and off are not degraded", () => {
    expect(resolveEffectiveMode("shadow")).toEqual({ requested: "shadow", effective: "shadow", degraded: false, reason: null });
    expect(resolveEffectiveMode("off").effective).toBe("off");
  });

  test("nothing this producer emits is ever authoritative today", () => {
    const t = startGithubFeedTimer({
      mode: "enforce", orchDir: join(tmp, "auth"), dbPath: ":memory:",
      eventLogPath: join(tmp, "auth", "ev.jsonl"), appendFn: () => {},
      clock: { setInterval: () => ({ unref() {} }), clearInterval: () => {} },
    });
    expect(t.isReady()).toBe(false);
    t.stop();
  });
});

describe("⛔ the shadow sink refuses the unified event log", () => {
  test("an events/YYYY-MM.jsonl path is refused", () => {
    // If the shadow file were ever the event log, every shadow event would become a
    // REAL one while every counter still read "shadow".
    expect(() => assertNotEventLog("/home/x/catalyst/events/2026-08.jsonl")).toThrow();
    expect(() => assertNotEventLog("/home/x/catalyst/events")).toThrow();
  });
  test("an ordinary shadow path is accepted", () => {
    expect(assertNotEventLog("/home/x/catalyst/shadow/github-feed-tenant-0.jsonl"))
      .toContain("github-feed");
  });
});

describe("the would-dispatch marker", () => {
  const src = {
    attributes: { "event.name": "github.pr.merged", "vcs.repository.name": "o/r", "vcs.pr.number": 7, "vcs.revision": "abc" },
    body: { message: "m", payload: { merged: true } },
  };
  test("⛔ it does NOT reuse the real github.* name", () => {
    // Re-emitting the real name with a shadow flag would fire every wait-for
    // subscriber, the PR-lifecycle router, and plugin-refresh's auto-pull. A shadow
    // that actuates is not a shadow.
    const m = buildWouldDispatchEvent(src, {});
    expect(m.attributes["event.name"]).toBe(EVENT_WOULD_DISPATCH);
    expect(m.attributes["event.name"].startsWith("github.")).toBe(false);
  });
  test("it carries the scoping a reader needs", () => {
    const m = buildWouldDispatchEvent(src, { account: "tenant-0" });
    expect(m.body.payload).toMatchObject({ eventName: "github.pr.merged", pr: 7, sha: "abc", account: "tenant-0" });
  });
});

describe("the tick", () => {
  const fakeSource = { close() {} };
  const fakeSeen = { close() {} };
  const okCounts = { emitted: 1, suppressed: 0, declined: 0, failed: 0, byReason: {}, byFailure: {}, byStream: {} };

  test("mode off creates no timer at all", () => {
    expect(startGithubFeedTimer({ mode: "off", orchDir: tmp, appendFn: () => {} })).toBeNull();
  });

  test("shadow writes the FULL envelope to the shadow file and a MARKER to the event log", () => {
    // The ledger reads the shadow file, so it must carry the exact envelope the
    // producer would have emitted — not the marker.
    const shadow = []; const events = [];
    const ev = { attributes: { "event.name": "github.push", "vcs.ref.name": "refs/heads/main" }, body: { payload: {} } };
    const r = runGithubFeedTick({
      mode: "shadow", orchDir: tmp, dbPath: ":memory:",
      appendShadowFn: (e) => shadow.push(e), appendEventFn: (e) => events.push(e),
      sourceFactory: () => fakeSource, seenFactory: () => fakeSeen,
      sweepFn: ({ sink }) => { sink(ev); return okCounts; },
    });
    expect(r.emitted).toBe(1);
    expect(shadow[0].attributes["event.name"]).toBe("github.push");
    expect(events[0].attributes["event.name"]).toBe(EVENT_WOULD_DISPATCH);
  });

  test("an unopenable input is an ERROR, never a quiet no-op", () => {
    const r = runGithubFeedTick({
      mode: "shadow", orchDir: tmp, dbPath: "/nope/nope.db",
      sourceFactory: () => { throw Object.assign(new Error("x"), { code: "SQLITE_CANTOPEN" }); },
      seenFactory: () => fakeSeen,
    });
    expect(r.error).toContain("SQLITE_CANTOPEN");
    expect(r.ready).toBe(false);
    expect(r.counts).toBeNull();
  });

  test("a failed sweep un-arms readiness", () => {
    const dirty = { ...okCounts, failed: 1, byFailure: { "stream-threw:push": 1 } };
    const r = runGithubFeedTick({
      mode: "shadow", orchDir: tmp, dbPath: ":memory:",
      appendShadowFn: () => {}, appendEventFn: () => {},
      sourceFactory: () => fakeSource, seenFactory: () => fakeSeen, sweepFn: () => dirty,
    });
    expect(r.ready).toBe(false);
    expect(r.unready).toContain("streams:");
  });

  test("an unhealthy feed un-arms readiness even on clean counts", () => {
    const r = runGithubFeedTick({
      mode: "shadow", orchDir: tmp, dbPath: ":memory:",
      appendShadowFn: () => {}, appendEventFn: () => {},
      sourceFactory: () => fakeSource, seenFactory: () => fakeSeen, sweepFn: () => okCounts,
      feedHealth: { healthy: false, reason: "record-stale" },
    });
    expect(r.ready).toBe(false);
    expect(r.unready).toBe("feed-unhealthy:record-stale");
  });

  test("⛔ a throwing tick cannot wedge the daemon", () => {
    let handle = null;
    const t = startGithubFeedTimer({
      mode: "shadow", orchDir: join(tmp, "wedge"), dbPath: "/nope/nope.db",
      eventLogPath: join(tmp, "wedge", "ev.jsonl"),
      appendFn: () => { throw new Error("disk full"); },
      clock: { setInterval: (fn) => { handle = fn; return { unref() {} }; }, clearInterval: () => {} },
    });
    expect(() => handle()).not.toThrow();
    expect(t.lastReport()).not.toBeNull();
    t.stop();
  });
});
