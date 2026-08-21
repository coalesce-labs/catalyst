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
import {
  GITHUB_CONSUMED_NAMES,
  GITHUB_SUPPRESSIBLE_NAMES,
  githubSuppressibleNames,
} from "./github-feed-gate.mjs";

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

describe("⛔ enforce is REFUSED unless this host can emit every consumed name (CTL-2018)", () => {
  // ⚠️ THIS REVERSES A DELIBERATE EARLIER DECISION, and the reversal is the ticket.
  // The block this replaces said: "THIS REPLACES 'enforce degrades to shadow'. That
  // refusal was all-or-nothing: nine fully-covered names sat behind two uncovered
  // ones. github-feed-gate.mjs suppresses per NAME, so the gaps now hold back only
  // themselves." Every sentence of that is true ABOUT THE DISPATCH GATE, and it is
  // still the wrong conclusion, because there are TWO gates at different
  // granularities:
  //
  //   • the broker's DISPATCH gate is per NAME — it can leave smee authoritative
  //     for an uncovered one;
  //   • orch-monitor's TUNNEL gate is BINARY — `enforce` means the smee tunnel never
  //     starts, for every name at once.
  //
  // So "the gaps hold back only themselves" is false in production: at enforce the
  // gaps hold back nothing, because the transport they were relying on is gone while
  // the producer emits them as markers. Measured on mini-2, 2026-08-18: 153 dropped
  // edges in 46 minutes (125 check_suite.completed + 28 push) with BOTH sides in
  // perfect agreement about the gap. Agreement was never the safety property; full
  // coverage is.
  test("a coverage gap makes enforce degraded, effective SHADOW, and names the gaps", () => {
    const r = resolveEffectiveMode("enforce", {
      suppressible: ["github.pr.opened"],
      consumed: ["github.pr.opened", "github.check_suite.completed", "github.push"],
    });
    expect(r.requested).toBe("enforce");
    expect(r.effective).toBe("shadow");
    expect(r.degraded).toBe(true);
    // The gaps are NAMED, not counted — an operator has to know which transport just
    // became load-bearing again, and "2 names" does not say that.
    expect(r.reason).toContain("github.check_suite.completed");
    expect(r.reason).toContain("github.push");
  });

  test("FULL coverage is honoured — enforce, undegraded", () => {
    const r = resolveEffectiveMode("enforce", {
      suppressible: [...GITHUB_CONSUMED_NAMES],
      consumed: GITHUB_CONSUMED_NAMES,
    });
    expect(r.effective).toBe("enforce");
    expect(r.degraded).toBe(false);
    expect(r.reason).toContain(`all ${GITHUB_CONSUMED_NAMES.length}`);
  });

  test("⛔ the verdict is DERIVED from the inputs, not from the shipped constants", () => {
    // Inherited discipline from the block this replaces: comparing against the real
    // constants asserts a tautology, and the only way to observe a derivation is to
    // change its inputs. Two synthetic worlds, opposite verdicts, neither matching
    // today's real partition.
    const covered = resolveEffectiveMode("enforce", { suppressible: ["a", "b"], consumed: ["a", "b"] });
    const gapped = resolveEffectiveMode("enforce", { suppressible: ["a"], consumed: ["a", "b"] });
    expect(covered.effective).toBe("enforce");
    expect(gapped.effective).toBe("shadow");
    expect(gapped.reason).toContain("1 of 2");
    expect(gapped.reason).toContain("b");
  });

  test("⚠️ the SHIPPED default still refuses — the static constant is short by two", () => {
    // `GITHUB_SUPPRESSIBLE_NAMES` is the pre-capability partition, so the no-argument
    // call is the "host with an unmigrated replica" case and must refuse. This is the
    // assertion that would have failed on 2026-08-18 before the flip.
    const r = resolveEffectiveMode("enforce");
    expect(r.effective).toBe("shadow");
    expect(r.degraded).toBe(true);
    expect(GITHUB_SUPPRESSIBLE_NAMES.length).toBeLessThan(GITHUB_CONSUMED_NAMES.length);
  });

  test("shadow and off are not degraded", () => {
    expect(resolveEffectiveMode("shadow")).toEqual({ requested: "shadow", effective: "shadow", degraded: false, reason: null });
    expect(resolveEffectiveMode("off").effective).toBe("off");
  });

  test("a producer that has not completed a sweep is NOT ready", () => {
    const t = startGithubFeedTimer({
      mode: "enforce", orchDir: join(tmp, "auth"), dbPath: ":memory:",
      eventLogPath: join(tmp, "auth", "ev.jsonl"), appendFn: () => {},
      clock: { setInterval: () => ({ unref() {} }), clearInterval: () => {} },
    });
    // setInterval is stubbed, so no tick has run — readiness must be false rather
    // than defaulting to "armed because the mode says enforce".
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

describe("⛔ under enforce the producer emits a REAL name only for what the gate can suppress", () => {
  // The producer and the gate are the same invariant read from opposite ends. If
  // they disagree the result is a double dispatch (feed emits, gate does not
  // suppress smee) or a dropped edge (gate suppresses smee, feed declined). These
  // drive the sink directly through the injected sweep seam — no replica needed.
  const ghEvent = (name) => ({
    attributes: { "event.name": name, "vcs.repository.name": "r" },
    body: { payload: { source: "cloud-feed" } },
  });

  // ⛔ CTL-2018: THE FIXTURE SOURCE MUST ANSWER THE COVERAGE PROBES, because the
  // producer now resolves its suppressible set from the replica handle rather than
  // from a constant. `migrated` is a schema-0.1.18 replica (both capabilities), which
  // is what the fleet actually runs; `preCapability` is the older one. A fixture that
  // answers NEITHER (the old `{ close() {} }`) is a third, real case — a replica the
  // producer cannot probe — and it is covered on its own below.
  const migrated = () => ({
    close() {},
    pushIsLossy: () => false,
    checkSuiteHasPrAssociation: () => true,
  });
  const preCapability = () => ({
    close() {},
    pushIsLossy: () => true,
    checkSuiteHasPrAssociation: () => false,
  });

  const drive = (mode, names, { authorityAtEntry = true, sourceFactory = migrated } = {}) => {
    const log = [];
    runGithubFeedTick({
      mode,
      orchDir: join(tmp, "emit"),
      dbPath: ":memory:",
      authorityAtEntry,
      appendEventFn: (e) => log.push(e),
      appendShadowFn: () => {},
      sourceFactory,
      seenFactory: () => ({ close() {} }),
      sweepFn: ({ sink }) => {
        for (const n of names) sink(ghEvent(n));
        return { emitted: names.length, suppressed: 0, declined: 0, failures: 0, byReason: {} };
      },
    });
    return log.map((e) => e?.attributes?.["event.name"]);
  };

  test("a suppressible name goes out under its REAL name", () => {
    expect(drive("enforce", ["github.pr.opened"])).toEqual(["github.pr.opened"]);
  });

  test("⭐ ON A MIGRATED REPLICA check_suite and push go out under their REAL names", () => {
    // ⛔ THIS IS THE REGRESSION TEST FOR THE 2026-08-18 OUTAGE. Before CTL-2018 the
    // producer read the STATIC suppressible set, so these two were downgraded to
    // markers on a host whose replica covers them and whose broker gate was
    // suppressing smee for them — 153 dropped edges in 46 minutes on mini-2.
    for (const n of ["github.check_suite.completed", "github.push"]) {
      expect(drive("enforce", [n])).toEqual([n]);
    }
  });

  test("⛔ a PRE-CAPABILITY replica refuses enforce outright — every name becomes a marker", () => {
    // Not "these two stay markers while the rest go out". A gap means the whole mode
    // degrades to shadow, because the TUNNEL gate is binary: at enforce the smee
    // tunnel never starts, so a name the producer declines to emit has no transport
    // left at all. See the resolveEffectiveMode block above.
    const all = ["github.pr.opened", "github.check_suite.completed", "github.push"];
    expect(drive("enforce", all, { sourceFactory: preCapability })).toEqual(
      all.map(() => EVENT_WOULD_DISPATCH),
    );
  });

  test("⛔ a replica the producer CANNOT PROBE refuses enforce — absent is not covered", () => {
    // The probe throws (no such method). Failing closed to the pre-capability answer
    // is what makes "I could not look" behave like "not covered" rather than like
    // "fine" — the direction every other absent probe in this feature takes.
    const unprobeable = () => ({ close() {} });
    expect(drive("enforce", ["github.pr.opened"], { sourceFactory: unprobeable })).toEqual([
      EVENT_WOULD_DISPATCH,
    ]);
  });

  test("shadow emits would-dispatch for EVERYTHING, including suppressible names", () => {
    expect(drive("shadow", ["github.pr.opened", "github.pr.merged"]))
      .toEqual([EVENT_WOULD_DISPATCH, EVENT_WOULD_DISPATCH]);
  });

  test("⭐ the real-name set is exactly the GATE'S RUNTIME set for the same replica", () => {
    // The control that makes the tests above non-anecdotal — and the one whose
    // EXPECTED VALUE is the whole ticket. It used to compare against the static
    // `GITHUB_SUPPRESSIBLE_NAMES`, which is the very constant the producer was reading,
    // so it agreed by construction and stayed green while the producer and the gate
    // diverged by two names in production. The expectation is now computed from the
    // SAME function the broker's gate calls, on the SAME coverage the fixture reports,
    // so the two sides are compared against EACH OTHER rather than each against itself.
    const coverage = { pushIsLossy: false, checkSuiteHasPrAssociation: true };
    const gateWouldSuppress = githubSuppressibleNames(coverage);
    const emitted = drive("enforce", GITHUB_CONSUMED_NAMES);
    const real = emitted.filter((n) => n !== EVENT_WOULD_DISPATCH);
    expect(real.sort()).toEqual([...gateWouldSuppress].sort());
    expect(emitted.filter((n) => n === EVENT_WOULD_DISPATCH)).toHaveLength(
      GITHUB_CONSUMED_NAMES.length - gateWouldSuppress.length,
    );
    // ⚠️ Positive control on the instrument. On a migrated replica the marker count is
    // ZERO, so the assertions above would also pass for a producer that emitted
    // everything unconditionally. Pin the other end: the gate's runtime answer must
    // really be all twelve here, and it must really differ from the static constant —
    // otherwise this test is back to comparing the producer with itself.
    expect(gateWouldSuppress.length).toBe(GITHUB_CONSUMED_NAMES.length);
    expect(gateWouldSuppress.length).toBeGreaterThan(GITHUB_SUPPRESSIBLE_NAMES.length);
  });
});

describe("⛔ the emission-time authority stamp is what crosses the process boundary", () => {
  const ghEvent = (name) => ({
    attributes: { "event.name": name },
    body: { payload: { source: "cloud-feed" } },
  });
  const stampFor = (authorityAtEntry) => {
    const log = [];
    runGithubFeedTick({
      mode: "enforce",
      orchDir: join(tmp, "stamp"),
      dbPath: ":memory:",
      authorityAtEntry,
      appendEventFn: (e) => log.push(e),
      appendShadowFn: () => {},
      // CTL-2018: a migrated (0.1.18) replica, so enforce is honourable and these
      // tests keep measuring the STAMP rather than accidentally measuring the refusal.
      sourceFactory: () => ({
        close() {},
        pushIsLossy: () => false,
        checkSuiteHasPrAssociation: () => true,
      }),
      seenFactory: () => ({ close() {} }),
      sweepFn: ({ sink }) => {
        sink(ghEvent("github.pr.opened"));
        return { emitted: 1, suppressed: 0, declined: 0, failures: 0, byReason: {} };
      },
    });
    return log[0]?.body?.payload?.feedAuthority;
  };

  test("an armed tick stamps true", () => {
    expect(stampFor(true)).toBe(true);
  });

  test("⛔ an UN-armed tick stamps false, and the gate then refuses the line", () => {
    // The broker cannot see this timer's state, so the stamp is the only authority
    // signal that crosses. An unstamped/false line must not dispatch.
    expect(stampFor(false)).toBe(false);
  });

  test("⚠️ the stamp defaults to FALSE when a caller forgets to thread readiness", () => {
    // Same direction as every other absent probe in this feature: the non-dispatching
    // half. A default of `true` would make a wiring mistake authoritative.
    const log = [];
    runGithubFeedTick({
      mode: "enforce",
      orchDir: join(tmp, "stamp2"),
      dbPath: ":memory:",
      appendEventFn: (e) => log.push(e),
      appendShadowFn: () => {},
      // CTL-2018: a migrated (0.1.18) replica, so enforce is honourable and these
      // tests keep measuring the STAMP rather than accidentally measuring the refusal.
      sourceFactory: () => ({
        close() {},
        pushIsLossy: () => false,
        checkSuiteHasPrAssociation: () => true,
      }),
      seenFactory: () => ({ close() {} }),
      sweepFn: ({ sink }) => {
        sink(ghEvent("github.pr.opened"));
        return { emitted: 1, suppressed: 0, declined: 0, failures: 0, byReason: {} };
      },
    });
    expect(log[0]?.body?.payload?.feedAuthority).toBe(false);
  });
});
