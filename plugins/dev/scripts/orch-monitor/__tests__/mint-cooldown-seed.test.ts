import { describe, it, expect } from "bun:test";
import { shouldSeedFreshMintCooldown } from "../server";

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
