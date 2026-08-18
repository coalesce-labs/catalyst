// github-feed-suppressible-parity.test.mjs — CTL-2018.
//
// Run: cd plugins/dev/scripts/execution-core && bun test github-feed-suppressible-parity.test.mjs
//
// ⛔ WHY THIS FILE EXISTS. Two processes answer one question — "which `github.*` names
// may smee be suppressed for?" — and until 2026-08-18 they answered it differently
// while every log line on both read healthy:
//
//   • the broker's dispatch gate (`github-feed-gate-install.mjs`) resolved it at
//     RUNTIME from the replica, re-probed every COVERAGE_CACHE_MS → 12 names;
//   • the producer (`github-feed-timer.mjs`) read the STATIC constant of the same
//     stem, frozen at import → 10 names.
//
// The producer's own header asserted they could not disagree ("Both sides read
// `GITHUB_SUPPRESSIBLE_NAMES`, so they cannot disagree"). That sentence was the only
// thing holding the invariant, it was false, and the cost was 153 dropped dispatch
// edges on mini-2 in 46 minutes (125 `check_suite.completed` + 28 `push`).
//
// A comment cannot hold an invariant that spans two files. This does: both sides are
// driven off ONE coverage fixture and compared to EACH OTHER — never each to its own
// constant, which is exactly how the pre-existing test stayed green through the
// divergence. Same discipline as `assertion-evidence-parity.test.mjs`.

import { describe, expect, test } from "bun:test";
import { resolveSuppressibleForTick } from "./github-feed-timer.mjs";
import { readGithubCoverage } from "./github-feed-gate-install.mjs";
import {
  GITHUB_CONSUMED_NAMES,
  GITHUB_SUPPRESSIBLE_NAMES,
  githubSuppressibleNames,
} from "./github-feed-gate.mjs";

/** A replica handle that reports a chosen coverage. */
const replica = ({ pushIsLossy, checkSuiteHasPrAssociation }) => ({
  close() {},
  pushIsLossy: () => pushIsLossy,
  checkSuiteHasPrAssociation: () => checkSuiteHasPrAssociation,
});

/** The gate's answer, through its own production entry point. */
const gateSide = (sourceFactory) =>
  [...githubSuppressibleNames(readGithubCoverage({ sourceFactory }))].sort();

/** The producer's answer, through its own production entry point. */
const producerSide = (sourceFactory) => [...resolveSuppressibleForTick(sourceFactory()).names].sort();

// Every combination, so the parity claim is exhaustive over the input space rather
// than anecdotal on today's fleet.
const COVERAGES = [
  { label: "migrated (0.1.18) — both capabilities", pushIsLossy: false, checkSuiteHasPrAssociation: true },
  { label: "pre-CTC-712 — push covered, no PR association", pushIsLossy: false, checkSuiteHasPrAssociation: false },
  { label: "pre-CTC-704 — PR association, push still lossy", pushIsLossy: true, checkSuiteHasPrAssociation: true },
  { label: "pre-capability — neither", pushIsLossy: true, checkSuiteHasPrAssociation: false },
];

describe("⛔ the producer and the gate resolve ONE suppressible set", () => {
  for (const c of COVERAGES) {
    test(`they agree on: ${c.label}`, () => {
      const factory = () => replica(c);
      expect(producerSide(factory)).toEqual(gateSide(factory));
    });
  }

  test("⭐ and the four coverages are not all the same answer — the comparison has range", () => {
    // Without this, "they agree" could hold because the fixture space is degenerate.
    const sizes = new Set(COVERAGES.map((c) => producerSide(() => replica(c)).length));
    expect(sizes.size).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBe(GITHUB_CONSUMED_NAMES.length);
  });
});

describe("⛔ they fail closed IDENTICALLY — agreement must survive the error path too", () => {
  // The dangerous asymmetry is not two different happy answers; it is one side
  // degrading and the other not. A gate that fails closed while the producer keeps
  // emitting is a double dispatch; the reverse is a dropped edge.
  const broken = [
    { label: "a handle with no capability methods", factory: () => ({ close() {} }) },
    {
      label: "a handle whose probes throw",
      factory: () => ({
        close() {},
        pushIsLossy: () => { throw new Error("locked"); },
        checkSuiteHasPrAssociation: () => { throw new Error("locked"); },
      }),
    },
  ];
  for (const b of broken) {
    test(`both degrade to the pre-capability set: ${b.label}`, () => {
      expect(producerSide(b.factory)).toEqual(gateSide(b.factory));
      // And it really is the SMALLEST set, not merely a matching one.
      expect(producerSide(b.factory)).toEqual([...GITHUB_SUPPRESSIBLE_NAMES].sort());
    });
  }
});

describe("⛔ the static constant is NOT the runtime answer on the fleet's own replica", () => {
  test("a migrated replica yields strictly MORE names than the frozen constant", () => {
    // The assertion that would have failed before the flip. If this ever stops being
    // true because the constant caught up, the parity tests above still hold and this
    // one becomes trivially true — so it is pinned to the NAMES, which is the claim.
    const migrated = () => replica({ pushIsLossy: false, checkSuiteHasPrAssociation: true });
    const runtime = producerSide(migrated);
    const gap = GITHUB_CONSUMED_NAMES.filter((n) => !GITHUB_SUPPRESSIBLE_NAMES.includes(n));
    expect(gap.sort()).toEqual(["github.check_suite.completed", "github.push"]);
    for (const n of gap) expect(runtime).toContain(n);
  });
});

describe("⛔ a degraded enforce reports UNREADY, which un-suppresses smee at the broker", () => {
  // `decideDispatch`'s `isReady` gates the SMEE side only, so `ready: false` is what
  // makes the broker stop suppressing smee's copies. On a gapped host that is the
  // correct outcome — the producer emits markers and smee keeps carrying the edges.
  test("a pre-capability replica yields ready:false with a named reason", async () => {
    const { runGithubFeedTick } = await import("./github-feed-timer.mjs");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const r = runGithubFeedTick({
      mode: "enforce",
      orchDir: mkdtempSync(join(tmpdir(), "gh-degraded-")),
      dbPath: ":memory:",
      authorityAtEntry: true,
      appendEventFn: () => {},
      appendShadowFn: () => {},
      sourceFactory: () => replica({ pushIsLossy: true, checkSuiteHasPrAssociation: false }),
      seenFactory: () => ({ close() {} }),
      // `countsClean` reads `failed` + `byFailure` (NOT `failures`/`byReason`), and an
      // absent census reads as dirty — so a sloppy fixture would make `ready:false` for
      // the wrong reason and the control below would prove nothing.
      sweepFn: () => ({ emitted: 0, failed: 0, byFailure: {} }),
    });
    expect(r.mode.effective).toBe("shadow");
    expect(r.mode.degraded).toBe(true);
    expect(r.ready).toBe(false);
    expect(r.unready).toBe("mode-degraded:shadow");
  });

  test("⭐ positive control — a migrated replica on the same path is READY", () => {
    // Without this, `ready:false` above could be an artefact of the fixture rather
    // than of the degradation.
    return import("./github-feed-timer.mjs").then(async ({ runGithubFeedTick }) => {
      const { mkdtempSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const r = runGithubFeedTick({
        mode: "enforce",
        orchDir: mkdtempSync(join(tmpdir(), "gh-ok-")),
        dbPath: ":memory:",
        authorityAtEntry: true,
        appendEventFn: () => {},
        appendShadowFn: () => {},
        sourceFactory: () => replica({ pushIsLossy: false, checkSuiteHasPrAssociation: true }),
        seenFactory: () => ({ close() {} }),
        // `countsClean` reads `failed` + `byFailure` (NOT `failures`/`byReason`), and an
      // absent census reads as dirty — so a sloppy fixture would make `ready:false` for
      // the wrong reason and the control below would prove nothing.
      sweepFn: () => ({ emitted: 0, failed: 0, byFailure: {} }),
      });
      expect(r.mode.effective).toBe("enforce");
      expect(r.mode.degraded).toBe(false);
      expect(r.ready).toBe(true);
    });
  });
});
