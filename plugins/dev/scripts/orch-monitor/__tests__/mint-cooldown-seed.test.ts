import { describe, it, expect } from "bun:test";
import { shouldSeedFreshMintCooldown, parsePositiveFiniteDurationMs } from "../server";

// CTL-1612 round 7 (Codex P2 follow-up): shouldSeedFreshMintCooldown decides
// whether the monitor's async reminter should treat
// CATALYST_MONITOR_APP_ACTOR_TOKEN as freshly minted at construction time —
// only a "minted" provenance may seed the long success cooldown; an
// "inherited" fallback token (lib/linear-app-actor.sh, round 6) must not,
// since it could already be near its own expiry.
describe("shouldSeedFreshMintCooldown", () => {
  it("returns true when the token is present and source is 'minted'", () => {
    expect(shouldSeedFreshMintCooldown("tok-abc", "minted")).toBe(true);
  });

  it("returns false when source is 'inherited', even with a token present", () => {
    expect(shouldSeedFreshMintCooldown("tok-abc", "inherited")).toBe(false);
  });

  it("returns false when the token is absent, regardless of source", () => {
    expect(shouldSeedFreshMintCooldown(undefined, "minted")).toBe(false);
    expect(shouldSeedFreshMintCooldown("", "minted")).toBe(false);
  });

  it("returns false when the token is present but source is unset/unrecognized", () => {
    expect(shouldSeedFreshMintCooldown("tok-abc", undefined)).toBe(false);
    expect(shouldSeedFreshMintCooldown("tok-abc", "")).toBe(false);
    expect(shouldSeedFreshMintCooldown("tok-abc", "bogus-value")).toBe(false);
  });

  it("treats a whitespace-only token as absent", () => {
    expect(shouldSeedFreshMintCooldown("   ", "minted")).toBe(false);
  });

  it("both absent (fresh env, no shell-level mint ever ran) returns false", () => {
    expect(shouldSeedFreshMintCooldown(undefined, undefined)).toBe(false);
  });
});

// CTL-1612 round 12 (Codex P2 follow-up): parsePositiveFiniteDurationMs
// guards the two remint cooldown env overrides
// (CATALYST_MONITOR_APP_ACTOR_REMINT_COOLDOWN_MS /
// ..._FAILURE_COOLDOWN_MS). The prior `Number(value) || fallback` form
// accepted a negative override (only 0/NaN are falsy in JS) — re-minting a
// production OAuth token on every anchor poll — and accepted Infinity
// (no finiteness check), which permanently suppresses re-mint.
describe("parsePositiveFiniteDurationMs", () => {
  it("returns the parsed value for a valid positive finite override", () => {
    expect(parsePositiveFiniteDurationMs("120000", 45 * 60_000)).toBe(120000);
  });

  it("falls back for a negative override (the exact production-spam bug)", () => {
    expect(parsePositiveFiniteDurationMs("-1", 45 * 60_000)).toBe(45 * 60_000);
    expect(parsePositiveFiniteDurationMs("-45", 60_000)).toBe(60_000);
  });

  it("falls back for Infinity/-Infinity (the exact permanent-suppression bug)", () => {
    expect(parsePositiveFiniteDurationMs("Infinity", 45 * 60_000)).toBe(45 * 60_000);
    expect(parsePositiveFiniteDurationMs("-Infinity", 45 * 60_000)).toBe(45 * 60_000);
  });

  it("falls back for zero", () => {
    expect(parsePositiveFiniteDurationMs("0", 60_000)).toBe(60_000);
  });

  it("falls back for non-numeric or unset input", () => {
    expect(parsePositiveFiniteDurationMs(undefined, 60_000)).toBe(60_000);
    expect(parsePositiveFiniteDurationMs("", 60_000)).toBe(60_000);
    expect(parsePositiveFiniteDurationMs("not-a-number", 60_000)).toBe(60_000);
    expect(parsePositiveFiniteDurationMs("NaN", 60_000)).toBe(60_000);
  });
});
