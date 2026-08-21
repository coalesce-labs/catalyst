// Run: cd plugins/dev/scripts/execution-core && bun test github-feed-ready.test.mjs

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MIN_STALE_MS,
  STALE_TICKS,
  defaultReadyPath,
  readReadyState,
  staleWindowMs,
  writeReadyState,
} from "./github-feed-ready.mjs";

const tmp = mkdtempSync(join(tmpdir(), "gh-feed-ready-"));
afterAll(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* never fail in cleanup */ } });

const NOW = 1_700_000_000_000;
const p = (name) => join(tmp, name);

describe("⛔ the staleness bound is what stops a FILE from becoming a latch", () => {
  test("a fresh ready stamp arms", () => {
    const f = p("fresh.json");
    writeReadyState(f, { ready: true, at: NOW });
    expect(readReadyState(f, { now: NOW + 1000, intervalSec: 30 })).toMatchObject({ ready: true, reason: "producer-ready" });
  });

  test("⛔ a stamp older than the window does NOT arm — the daemon-died case", () => {
    // Without this, the last thing a dying daemon wrote was `ready: true`, and the
    // broker would keep suppressing smee on the authority of a process that no
    // longer exists: the exact failure the readiness lever exists to prevent, made
    // permanent by the mechanism meant to prevent it.
    const f = p("stale.json");
    writeReadyState(f, { ready: true, at: NOW });
    const v = readReadyState(f, { now: NOW + staleWindowMs(30) + 1, intervalSec: 30 });
    expect(v.ready).toBe(false);
    expect(v.reason).toMatch(/^ready-file-stale:/);
  });

  test("⚠️ a stamp from the FUTURE is stale, not fresh — clock skew must not grant authority", () => {
    const f = p("future.json");
    writeReadyState(f, { ready: true, at: NOW + staleWindowMs(30) + 60_000 });
    const v = readReadyState(f, { now: NOW, intervalSec: 30 });
    expect(v.ready).toBe(false);
    expect(v.reason).toMatch(/^ready-file-stale:/);
  });

  test("the window scales with the configured interval, and never below the floor", () => {
    expect(staleWindowMs(30)).toBe(30 * 1000 * STALE_TICKS);
    expect(staleWindowMs(120)).toBe(120 * 1000 * STALE_TICKS);
    // An interval below 5 is not a slow host, it is an invalid config — the same
    // reading config.mjs's own knob takes (`>= 5 ? parsed : 30`). It falls back to
    // the default rather than to the floor, so the two readers cannot disagree.
    expect(staleWindowMs(1)).toBe(30 * 1000 * STALE_TICKS);
    expect(staleWindowMs(undefined)).toBe(30 * 1000 * STALE_TICKS);
    expect(staleWindowMs("nonsense")).toBe(30 * 1000 * STALE_TICKS);
    // The floor binds at the smallest VALID interval, where 3 ticks would otherwise
    // be 15 s — short enough that one blocked tick (CTL-1524) reads as a dead producer.
    expect(staleWindowMs(5)).toBe(MIN_STALE_MS);
  });

  test("⚠️ a host on a SLOW interval is not permanently stale — the writer/reader agree by construction", () => {
    // The one genuinely dangerous bug in a heartbeat is a writer and a reader with
    // different ideas of "recent". Both sides call staleWindowMs, so this drives the
    // slow-host case that a hard-coded constant would break.
    const f = p("slow.json");
    writeReadyState(f, { ready: true, at: NOW });
    expect(readReadyState(f, { now: NOW + 200_000, intervalSec: 120 }).ready).toBe(true);
    // and the same age against the DEFAULT interval is stale
    expect(readReadyState(f, { now: NOW + 200_000, intervalSec: 30 }).ready).toBe(false);
  });
});

describe("every failure mode resolves to not-ready, with a reason the capture record can use", () => {
  test("absent file", () => {
    expect(readReadyState(p("nope.json"), { now: NOW })).toMatchObject({ ready: false, reason: "ready-file-absent" });
  });

  test("unparseable file", () => {
    const f = p("bad.json");
    writeFileSync(f, "{not json");
    expect(readReadyState(f, { now: NOW })).toMatchObject({ ready: false, reason: "ready-file-unparseable" });
  });

  test("missing stamp", () => {
    const f = p("unstamped.json");
    writeFileSync(f, JSON.stringify({ ready: true }));
    expect(readReadyState(f, { now: NOW })).toMatchObject({ ready: false, reason: "ready-file-unstamped" });
  });

  test("the producer's own not-ready verdict carries its reason through", () => {
    const f = p("unready.json");
    writeReadyState(f, { ready: false, at: NOW, unready: "feed-unhealthy" });
    const v = readReadyState(f, { now: NOW + 1000, intervalSec: 30 });
    expect(v.ready).toBe(false);
    expect(v.reason).toBe("producer-unready:feed-unhealthy");
  });

  test("⛔ `ready` must be exactly true — a truthy value is not a verdict", () => {
    const f = p("truthy.json");
    writeFileSync(f, JSON.stringify({ ready: "yes", at: NOW }));
    expect(readReadyState(f, { now: NOW + 1000, intervalSec: 30 }).ready).toBe(false);
  });
});

describe("the writer fails OPEN — evidence must never be load-bearing for what it observes", () => {
  test("a throwing write returns false rather than propagating", () => {
    const thrower = () => { throw new Error("EROFS"); };
    let warned = null;
    const ok = writeReadyState(p("x.json"), { ready: true, at: NOW }, {
      writeFn: thrower,
      logger: { warn: (o) => { warned = o; } },
    });
    expect(ok).toBe(false);
    expect(warned).not.toBeNull();
  });

  test("⚠️ and a failed write AGES OUT rather than latching — the safe direction", () => {
    // The consequence of failing open on the write side: the previous stamp simply
    // gets old, and the staleness bound un-arms enforce. This asserts the two
    // behaviours COMPOSE, which neither test above does on its own.
    const f = p("ages-out.json");
    writeReadyState(f, { ready: true, at: NOW });
    writeReadyState(f, { ready: true, at: NOW + 30_000 }, { writeFn: () => { throw new Error("EROFS"); } });
    expect(readReadyState(f, { now: NOW + staleWindowMs(30) + 1, intervalSec: 30 }).ready).toBe(false);
  });
});

describe("the path is per account, so two accounts cannot read each other's readiness", () => {
  test("defaultReadyPath includes the account", () => {
    expect(defaultReadyPath("/orch", "tenant-0")).toContain("tenant-0");
    expect(defaultReadyPath("/orch", "tenant-0")).not.toBe(defaultReadyPath("/orch", "tenant-9"));
  });
});
