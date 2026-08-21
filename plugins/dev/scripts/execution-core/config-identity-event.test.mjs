// config-identity-event.test.mjs — CTL-2076.
// Unit matrix for the pure buildTeamIdentityMismatchEvents builder + the
// exported event-name constant. Covers empty, all-match, unknown (matches ===
// null), single proven mismatch (exact payload shape), two mismatches
// (order-preserving), and a malformed/null entry mixed in (skipped, no throw).
//
// Run: bun test plugins/dev/scripts/execution-core/config-identity-event.test.mjs

import { describe, test, expect } from "bun:test";
import {
  CONFIG_TEAM_IDENTITY_MISMATCH,
  buildTeamIdentityMismatchEvents,
} from "./config-identity-event.mjs";

describe("CONFIG_TEAM_IDENTITY_MISMATCH constant", () => {
  test("is the literal event name", () => {
    expect(CONFIG_TEAM_IDENTITY_MISMATCH).toBe("config.registry-team-identity.mismatch");
  });
});

describe("buildTeamIdentityMismatchEvents", () => {
  test("empty input → []", () => {
    expect(buildTeamIdentityMismatchEvents([])).toEqual([]);
  });

  test("null / undefined input → [] (no throw)", () => {
    expect(buildTeamIdentityMismatchEvents(null)).toEqual([]);
    expect(buildTeamIdentityMismatchEvents(undefined)).toEqual([]);
  });

  test("all entries matches === true → []", () => {
    const projects = [
      { team: "CTL", repoRoot: "/a", identity: { declared: "CTL", matches: true } },
      { team: "CAT", repoRoot: "/b", identity: { declared: "CAT", matches: true } },
    ];
    expect(buildTeamIdentityMismatchEvents(projects)).toEqual([]);
  });

  test("matches === null (unverifiable) → [] — unknown is not a mismatch", () => {
    const projects = [
      { team: "CTL", repoRoot: "/a", identity: { declared: null, matches: null } },
      { team: "CAT", repoRoot: "/b", identity: { declared: null, matches: null } },
    ];
    expect(buildTeamIdentityMismatchEvents(projects)).toEqual([]);
  });

  test("a single proven mismatch → exactly one event with the exact payload shape", () => {
    const projects = [
      { team: "CTL", repoRoot: "/x", identity: { declared: "PROJ", matches: false } },
    ];
    expect(buildTeamIdentityMismatchEvents(projects)).toEqual([
      {
        "event.name": CONFIG_TEAM_IDENTITY_MISMATCH,
        payload: { team: "CTL", repoRoot: "/x", declared: "PROJ" },
      },
    ]);
  });

  test("two mismatches → two events, order-preserving", () => {
    const projects = [
      { team: "CTL", repoRoot: "/x", identity: { declared: "PROJ", matches: false } },
      { team: "CAT", repoRoot: "/y", identity: { declared: "OTHER", matches: false } },
    ];
    expect(buildTeamIdentityMismatchEvents(projects)).toEqual([
      {
        "event.name": CONFIG_TEAM_IDENTITY_MISMATCH,
        payload: { team: "CTL", repoRoot: "/x", declared: "PROJ" },
      },
      {
        "event.name": CONFIG_TEAM_IDENTITY_MISMATCH,
        payload: { team: "CAT", repoRoot: "/y", declared: "OTHER" },
      },
    ]);
  });

  test("a null / malformed entry mixed in is skipped without throwing", () => {
    const projects = [
      null,
      { team: "CTL", repoRoot: "/x", identity: { declared: "PROJ", matches: false } },
      { team: "NOID", repoRoot: "/z" }, // no identity object at all
      { identity: { matches: true } }, // matching, missing team/repoRoot
    ];
    expect(buildTeamIdentityMismatchEvents(projects)).toEqual([
      {
        "event.name": CONFIG_TEAM_IDENTITY_MISMATCH,
        payload: { team: "CTL", repoRoot: "/x", declared: "PROJ" },
      },
    ]);
  });

  test("a mismatch entry missing team/repoRoot/declared coerces those to null", () => {
    const projects = [{ identity: { matches: false } }];
    expect(buildTeamIdentityMismatchEvents(projects)).toEqual([
      {
        "event.name": CONFIG_TEAM_IDENTITY_MISMATCH,
        payload: { team: null, repoRoot: null, declared: null },
      },
    ]);
  });
});
