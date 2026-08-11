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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DELEGATE_CLAIMS_DIR,
  delegateClaimPath,
  recordDelegateClaim,
  clearDelegateClaim,
  readDelegateClaims,
} from "./delegate-claims.mjs";

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

  test("re-claiming overwrites with the newer timestamp", () => {
    recordDelegateClaim(orchDir, "CTL-1", { now: () => 1000 });
    recordDelegateClaim(orchDir, "CTL-1", { now: () => 2000 });
    expect(readDelegateClaims(orchDir).get("CTL-1")).toBe(2000);
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

  test("a FUTURE-dated marker is returned as-is — the age check, not the reader, rejects it", () => {
    // Deliberate: the reader must not silently drop clock-skewed evidence, or the
    // invariant could not distinguish "skew" from "no evidence" in its census.
    const future = Date.now() + 60_000;
    writeRaw("CTL-FUTURE", JSON.stringify({ claimedAt: future }));
    expect(readDelegateClaims(orchDir).get("CTL-FUTURE")).toBe(future);
  });
});
