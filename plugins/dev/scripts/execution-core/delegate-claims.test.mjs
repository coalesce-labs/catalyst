// delegate-claims.test.mjs — CTL-1744.
//
// The load-bearing property here is the FAILURE BIAS: grace suppresses a
// recovery signal, so every ambiguous input must yield NO entry (⇒ no grace ⇒
// pre-CTL-1744 behavior). These tests assert that direction explicitly for every
// way a marker can be unusable, because a reader that "helpfully" coerced a bad
// timestamp would silently mask real wedges.
//
// Run: cd plugins/dev/scripts/execution-core && bun test delegate-claims.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DELEGATE_CLAIMS_DIR,
  delegateClaimPath,
  recordDelegateClaim,
  clearDelegateClaim,
  readDelegateClaims,
} from "./delegate-claims.mjs";
// MIGRATION turn 119: the integrated bound test drives the REAL invariant off the
// REAL reader, so the wiring is proven end-to-end rather than the arithmetic alone.
import { assembleBoardState, evaluateInvariants } from "./board-health.mjs";

let orchDir;
const claimsDir = () => join(orchDir, DELEGATE_CLAIMS_DIR);
const writeRaw = (ticket, body) => {
  mkdirSync(claimsDir(), { recursive: true });
  writeFileSync(join(claimsDir(), `${ticket}.json`), body);
};

beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "ctl1744-"));
});
afterEach(() => {
  rmSync(orchDir, { recursive: true, force: true });
});

describe("recordDelegateClaim", () => {
  test("writes a usable marker and readDelegateClaims returns it", () => {
    expect(recordDelegateClaim(orchDir, "CTL-1", { now: () => 1000 })).toBe(true);
    expect(existsSync(delegateClaimPath(orchDir, "CTL-1"))).toBe(true);
    expect(readDelegateClaims(orchDir).get("CTL-1")).toBe(1000);
  });

  test("NEVER manufactures the orch dir (hermetic/mocked context → no-op)", () => {
    const missing = join(orchDir, "does", "not", "exist");
    expect(recordDelegateClaim(missing, "CTL-1")).toBe(false);
    expect(existsSync(missing)).toBe(false);
  });

  test("missing orchDir/ticket are no-ops rather than throws", () => {
    expect(recordDelegateClaim(null, "CTL-1")).toBe(false);
    expect(recordDelegateClaim(orchDir, "")).toBe(false);
    expect(recordDelegateClaim(orchDir, null)).toBe(false);
  });

  // CTC review (turn 113): FIRST-CLAIM-WINS. This test previously asserted the
  // OPPOSITE (overwrite) and was therefore encoding the defect — an unconditional
  // overwrite makes the grace window RENEWABLE, so `graceMs` stops being a bound
  // on suppression and instead lasts as long as a re-claim loop does.
  test("re-claiming does NOT extend the window — first claim wins", () => {
    expect(recordDelegateClaim(orchDir, "CTL-1", { now: () => 1000 })).toBe(true);
    expect(recordDelegateClaim(orchDir, "CTL-1", { now: () => 2000 })).toBe(false);
    expect(recordDelegateClaim(orchDir, "CTL-1", { now: () => 9_999_999 })).toBe(false);
    expect(readDelegateClaims(orchDir).get("CTL-1")).toBe(1000); // the REAL wait start
  });

  test("suppression stays bounded across an unbounded re-claim loop", () => {
    // The invariant that actually constrains blast radius: no number of re-claims
    // can slide the window forward, so a genuinely stuck ticket always exits grace
    // graceMs after its FIRST claim regardless of tick rate or cache lag.
    let clock = 1000;
    recordDelegateClaim(orchDir, "CTL-STUCK", { now: () => clock });
    for (let i = 0; i < 500; i++) {
      clock += 2000; // 2s ticks, ~16 minutes of re-claiming
      recordDelegateClaim(orchDir, "CTL-STUCK", { now: () => clock });
    }
    expect(readDelegateClaims(orchDir).get("CTL-STUCK")).toBe(1000);
    // age is now the FULL elapsed span, not ~0 — so the grace check will reject it
    expect(clock - readDelegateClaims(orchDir).get("CTL-STUCK")).toBe(1_000_000);
  });

  test("after clearDelegateClaim, the NEXT legitimate claim writes fresh", () => {
    // first-claim-wins must not permanently pin a ticket to its first-ever claim:
    // the dispatch path clears the marker, so a later cycle starts a new window.
    recordDelegateClaim(orchDir, "CTL-1", { now: () => 1000 });
    clearDelegateClaim(orchDir, "CTL-1");
    expect(recordDelegateClaim(orchDir, "CTL-1", { now: () => 5000 })).toBe(true);
    expect(readDelegateClaims(orchDir).get("CTL-1")).toBe(5000);
  });

  test("an existing MALFORMED marker is left alone (bounding beats refreshing)", () => {
    // A malformed marker grants no grace anyway, so overwriting it would only
    // reintroduce the sliding window for no benefit.
    writeRaw("CTL-BADEXIST", "}{");
    expect(recordDelegateClaim(orchDir, "CTL-BADEXIST", { now: () => 1000 })).toBe(false);
    expect(readDelegateClaims(orchDir).has("CTL-BADEXIST")).toBe(false);
  });

  // MIGRATION turn 119: assert the file is BYTE-FOR-BYTE untouched, not merely that
  // the parsed claim is unchanged. A re-claim that rewrote equivalent-but-different
  // bytes would still prove the write path ran, which is what must not happen.
  test("a colliding re-claim preserves the existing file BYTE-FOR-BYTE (valid / malformed / zero-byte)", () => {
    const cases = [
      ["CTL-VALID", JSON.stringify({ ticket: "CTL-VALID", claimedAt: 1000 })],
      ["CTL-MALFORMED", "}{ not json at all"],
      ["CTL-ZEROBYTE", ""],
    ];
    for (const [ticket, original] of cases) {
      writeRaw(ticket, original);
      const before = readFileSync(join(claimsDir(), `${ticket}.json`));
      const beforeStat = statSync(join(claimsDir(), `${ticket}.json`));

      // Attempt several re-claims with clocks that would obviously change the bytes.
      expect(recordDelegateClaim(orchDir, ticket, { now: () => 777777 })).toBe(false);
      expect(recordDelegateClaim(orchDir, ticket, { now: () => 888888 })).toBe(false);

      const after = readFileSync(join(claimsDir(), `${ticket}.json`));
      const afterStat = statSync(join(claimsDir(), `${ticket}.json`));
      expect(`${ticket}: ${after.equals(before)}`).toBe(`${ticket}: true`);
      expect(`${ticket}: ${afterStat.size}`).toBe(`${ticket}: ${beforeStat.size}`);
      expect(after.toString()).toBe(original);
    }
  });

  test("a ZERO-BYTE existing marker collides and is NOT replaced (explicit)", () => {
    // The interesting case on its own: an empty file is falsy-looking but must
    // still win the collision, or a crashed write would hand back a fresh window.
    writeRaw("CTL-EMPTY0", "");
    expect(statSync(join(claimsDir(), "CTL-EMPTY0.json")).size).toBe(0);
    expect(recordDelegateClaim(orchDir, "CTL-EMPTY0", { now: () => 424242 })).toBe(false);
    expect(statSync(join(claimsDir(), "CTL-EMPTY0.json")).size).toBe(0);
    expect(readFileSync(join(claimsDir(), "CTL-EMPTY0.json")).length).toBe(0);
    expect(readDelegateClaims(orchDir).has("CTL-EMPTY0")).toBe(false); // still no grace
  });
});

// ── MIGRATION turn 119: INTEGRATED post-grace evaluation ─────────────────────
//
// The 500-reclaim test above proves timestamp arithmetic. This proves the thing
// that actually matters: that the immutable claim map, read by the REAL reader off
// REAL files, drives the REAL invariant to flag the ticket once the window elapses.
// Arithmetic could be right while the wiring silently dropped the map.
describe("CTL-1744 integrated: repeated re-claims still expire into a wedge", () => {
  // Production default: RECONCILE_INTERVAL_MS (10m) + 60s slack.
  const GRACE_MS = 10 * 60_000 + 60_000;
  const T0 = 1_700_000_000_000;
  const TICKET = "CTL-STUCK";

  const boardAt = (nowMs) =>
    assembleBoardState({
      orchDir,
      getEligible: () => [{ id: TICKET }],
      capacity: { maxParallel: 4, liveCount: 0, freeSlots: 4 },
      // No dispatch events → ring.recentDispatchTs === null → "no recent dispatch
      // seen", i.e. the wedge precondition. Grace is then the ONLY thing that can
      // hold the invariant green.
      readEventRing: () => [],
      getDelegateClaims: () => readDelegateClaims(orchDir),
      now: () => nowMs,
    });

  test("inside grace → green; at graceMs+1 after 500 re-claims → wedge flagged", () => {
    let clock = T0;
    recordDelegateClaim(orchDir, TICKET, { now: () => clock });
    for (let i = 0; i < 500; i++) {
      clock += 2000; // 2s ticks — ~16 minutes of re-claiming, far beyond graceMs
      recordDelegateClaim(orchDir, TICKET, { now: () => clock });
    }
    // The claim map really is immutable, read back off disk by the real reader.
    expect(readDelegateClaims(orchDir).get(TICKET)).toBe(T0);

    // Inside the window the invariant is suppressed...
    const inside = evaluateInvariants(boardAt(T0 + GRACE_MS - 1));
    expect(inside.dispatchLiveness.ok).toBe(true);
    expect(inside.dispatchLiveness.queuedOwnedInDelegateGrace).toBe(1);

    // ...and one millisecond past it, the ticket IS wedge evidence — despite 500
    // re-claims that, pre-fix, would have kept sliding the window forward.
    const past = evaluateInvariants(boardAt(T0 + GRACE_MS + 1));
    expect(past.dispatchLiveness.ok).toBe(false);
    expect(past.dispatchLiveness.failed).toBe(1);
    expect(past.dispatchLiveness.flagged).toContain(TICKET);
    expect(past.dispatchLiveness.queuedOwnedInDelegateGrace).toBe(0);
    expect(past.dispatchLiveness.queuedOwnedEvidence).toBe(1);
  });
});

describe("clearDelegateClaim", () => {
  test("removes the marker; absent marker is not an error (idempotent)", () => {
    recordDelegateClaim(orchDir, "CTL-1", { now: () => 1000 });
    expect(clearDelegateClaim(orchDir, "CTL-1")).toBe(true);
    expect(readDelegateClaims(orchDir).has("CTL-1")).toBe(false);
    expect(clearDelegateClaim(orchDir, "CTL-1")).toBe(true); // already gone
    expect(clearDelegateClaim(null, "CTL-1")).toBe(false);
  });
});

describe("readDelegateClaims — FAIL-CLOSED on every unusable marker", () => {
  test("absent directory → empty map (nobody gets grace)", () => {
    expect(readDelegateClaims(orchDir).size).toBe(0);
    expect(readDelegateClaims(null).size).toBe(0);
    expect(readDelegateClaims("/nonexistent/path/xyz").size).toBe(0);
  });

  test("malformed / non-numeric / non-positive timestamps are DROPPED, not coerced", () => {
    writeRaw("CTL-GOOD", JSON.stringify({ ticket: "CTL-GOOD", claimedAt: 1234 }));
    writeRaw("CTL-NOTJSON", "{{{ not json");
    writeRaw("CTL-EMPTY", "");
    writeRaw("CTL-NULL", JSON.stringify({ claimedAt: null }));
    writeRaw("CTL-STR", JSON.stringify({ claimedAt: "1234" }));
    writeRaw("CTL-NAN", JSON.stringify({ claimedAt: "NaN" }));
    writeRaw("CTL-ZERO", JSON.stringify({ claimedAt: 0 }));
    writeRaw("CTL-NEG", JSON.stringify({ claimedAt: -5 }));
    writeRaw("CTL-MISSING", JSON.stringify({ ticket: "CTL-MISSING" }));
    writeRaw("CTL-ARRAY", JSON.stringify([1, 2, 3]));

    const claims = readDelegateClaims(orchDir);
    expect([...claims.keys()]).toEqual(["CTL-GOOD"]);
    expect(claims.get("CTL-GOOD")).toBe(1234);
  });

  test("one malformed marker never poisons the others", () => {
    writeRaw("CTL-A", JSON.stringify({ claimedAt: 1 }));
    writeRaw("CTL-BAD", "}{");
    writeRaw("CTL-B", JSON.stringify({ claimedAt: 2 }));
    const claims = readDelegateClaims(orchDir);
    expect(claims.get("CTL-A")).toBe(1);
    expect(claims.get("CTL-B")).toBe(2);
    expect(claims.has("CTL-BAD")).toBe(false);
  });

  test("non-.json files and stray entries are ignored", () => {
    mkdirSync(claimsDir(), { recursive: true });
    writeFileSync(join(claimsDir(), "README"), "not a claim");
    writeFileSync(join(claimsDir(), ".json"), JSON.stringify({ claimedAt: 1 })); // empty ticket name
    writeRaw("CTL-OK", JSON.stringify({ claimedAt: 7 }));
    expect([...readDelegateClaims(orchDir).keys()]).toEqual(["CTL-OK"]);
  });

  test("PARTIAL / truncated marker files (interrupted write, full disk, kill -9) are dropped", () => {
    // writeFileSync is not atomic, so a crash mid-write can leave a prefix of the
    // JSON on disk. Every truncation point must read as "no evidence" rather than
    // throwing or, worse, parsing into something that grants grace.
    const full = JSON.stringify({ ticket: "CTL-T", claimedAt: 1699999999999 });
    for (let cut = 1; cut < full.length; cut++) {
      rmSync(claimsDir(), { recursive: true, force: true });
      writeRaw("CTL-T", full.slice(0, cut));
      const claims = readDelegateClaims(orchDir);
      // A truncated prefix must never yield a usable claim. (The only way it could
      // is if a prefix happened to be valid JSON with a numeric claimedAt — assert
      // that never happens rather than assuming it.)
      expect(`cut@${cut}: ${claims.has("CTL-T")}`).toBe(`cut@${cut}: false`);
    }
    // ...and the untruncated original is still accepted, so the loop above is
    // proving truncation-rejection rather than a reader that rejects everything.
    rmSync(claimsDir(), { recursive: true, force: true });
    writeRaw("CTL-T", full);
    expect(readDelegateClaims(orchDir).get("CTL-T")).toBe(1699999999999);
  });

  test("a zero-byte marker (file created, write never landed) is dropped", () => {
    writeRaw("CTL-EMPTYFILE", "");
    expect(readDelegateClaims(orchDir).has("CTL-EMPTYFILE")).toBe(false);
  });

  test("a FUTURE-dated marker is returned as-is — the age check, not the reader, rejects it", () => {
    // Deliberate: the reader must not silently drop clock-skewed evidence, or the
    // invariant could not distinguish "skew" from "no evidence" in its census.
    const future = Date.now() + 60_000;
    writeRaw("CTL-FUTURE", JSON.stringify({ claimedAt: future }));
    expect(readDelegateClaims(orchDir).get("CTL-FUTURE")).toBe(future);
  });
});
