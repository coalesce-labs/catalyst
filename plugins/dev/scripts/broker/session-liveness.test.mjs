// session-liveness.test.mjs — CTL-672. Exercises the sess_ → claude-UUID →
// `claude agents` liveness bridge against injected fixtures (no real db, no
// shell-out).

import { describe, test, expect, beforeEach } from "bun:test";
import {
  sessionLiveness,
  resolveClaudeSessionId,
  resetSessionLivenessCaches,
} from "./session-liveness.mjs";

const UUID_A = "aaaaaaaa-1111-2222-3333-444444444444";
const UUID_B = "bbbbbbbb-1111-2222-3333-444444444444";

const agents = [
  { sessionId: UUID_A, status: "busy", kind: "background" },
  // UUID_B intentionally absent (crashed/exited).
];

describe("sessionLiveness (CTL-672 bridge)", () => {
  beforeEach(() => resetSessionLivenessCaches());

  test("resolves to a present claude UUID → 'alive'", () => {
    const lookup = (s) => (s === "sess-a" ? UUID_A : null);
    expect(sessionLiveness("sess-a", { agents, lookupClaudeSessionId: lookup })).toBe("alive");
  });

  test("resolves to an ABSENT claude UUID → 'dead'", () => {
    const lookup = (s) => (s === "sess-b" ? UUID_B : null);
    expect(sessionLiveness("sess-b", { agents, lookupClaudeSessionId: lookup })).toBe("dead");
  });

  test("does not resolve (no claude_session_id yet) → 'unknown' (caller falls back)", () => {
    const lookup = () => null;
    expect(sessionLiveness("sess-interactive", { agents, lookupClaudeSessionId: lookup })).toBe(
      "unknown",
    );
  });

  test("a malformed claude id → 'unknown' rather than throwing", () => {
    const lookup = () => "not-a-uuid-or-shortid-$$$";
    // shortIdFromSessionId throws on a non-uuid → swallowed to "unknown".
    const got = sessionLiveness("sess-bad", { agents, lookupClaudeSessionId: lookup });
    expect(["unknown", "dead"]).toContain(got); // never throws; either is non-fatal
  });

  test("accepts the full UUID form (matches on the 8-char prefix)", () => {
    const lookup = () => UUID_A;
    expect(sessionLiveness("sess-a", { agents, lookupClaudeSessionId: lookup })).toBe("alive");
  });
});

describe("resolveClaudeSessionId", () => {
  beforeEach(() => resetSessionLivenessCaches());

  test("returns the claude_session_id from the sessions row", () => {
    const db = { prepare: () => ({ get: () => ({ claude_session_id: UUID_A }) }) };
    expect(resolveClaudeSessionId("sess-a", { db })).toBe(UUID_A);
  });

  test("null when the row has no claude_session_id (not yet dispatched-stamped)", () => {
    const db = { prepare: () => ({ get: () => ({ claude_session_id: null }) }) };
    expect(resolveClaudeSessionId("sess-x", { db })).toBeNull();
  });

  test("null when there is no row", () => {
    const db = { prepare: () => ({ get: () => undefined }) };
    expect(resolveClaudeSessionId("sess-missing", { db })).toBeNull();
  });

  test("null (never throws) when the db handle is unavailable", () => {
    expect(resolveClaudeSessionId("sess-a", { db: null })).toBeNull();
  });

  test("memoizes a hit (immutable mapping) but re-queries a miss", () => {
    let calls = 0;
    const mkDb = (val) => ({
      prepare: () => ({
        get: () => {
          calls += 1;
          return { claude_session_id: val };
        },
      }),
    });
    // First: miss → not cached → re-query allowed.
    expect(resolveClaudeSessionId("sess-late", { db: mkDb(null) })).toBeNull();
    expect(calls).toBe(1);
    // Later it appears → hit, now cached.
    expect(resolveClaudeSessionId("sess-late", { db: mkDb(UUID_B) })).toBe(UUID_B);
    expect(calls).toBe(2);
    // Subsequent calls served from cache (no further db hit).
    expect(resolveClaudeSessionId("sess-late", { db: mkDb(UUID_A) })).toBe(UUID_B);
    expect(calls).toBe(2);
  });
});
