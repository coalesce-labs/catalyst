// claude-ids.test.mjs — the mjs short-id + self-session guards (CTL-649).
// These back the prune self-protection and the `claude stop` short-id contract
// (full UUIDs are silently rejected, comment 9a3d0645), so their edge cases —
// short↔full cross-form match, unset env fail-open, malformed-throw — must be
// pinned directly, not just through callers.

import { describe, it, expect } from "bun:test";
import { shortIdFromSessionId, isSelfSession } from "./claude-ids.mjs";

describe("shortIdFromSessionId", () => {
  it("truncates a full UUID to its 8-char hex prefix", () => {
    expect(shortIdFromSessionId("90c9a8a7-4a61-4dd7-b46d-8a4735afc6c2")).toBe("90c9a8a7");
  });

  it("passes through an already-short 8-char id", () => {
    expect(shortIdFromSessionId("90c9a8a7")).toBe("90c9a8a7");
  });

  it("throws on empty input (so callers skip the row rather than emit a bad target)", () => {
    expect(() => shortIdFromSessionId("")).toThrow();
    expect(() => shortIdFromSessionId(null)).toThrow();
    expect(() => shortIdFromSessionId(undefined)).toThrow();
  });

  it("throws on a non-hex / too-short token (never silently returns a full UUID)", () => {
    expect(() => shortIdFromSessionId("abc")).toThrow();
    expect(() => shortIdFromSessionId("ZZZZZZZZ-1111-2222-3333-444444444444")).toThrow();
  });
});

describe("isSelfSession (prefix compare across short/full forms)", () => {
  it("matches when env is a full UUID and candidate is the short id", () => {
    const env = { CLAUDE_CODE_SESSION_ID: "11111111-aaaa-bbbb-cccc-dddddddddddd" };
    expect(isSelfSession("11111111", env)).toBe(true);
  });

  it("matches when env is the short id and candidate is a full UUID", () => {
    const env = { CLAUDE_CODE_SESSION_ID: "11111111" };
    expect(isSelfSession("11111111-aaaa-bbbb-cccc-dddddddddddd", env)).toBe(true);
  });

  it("matches full-vs-full and short-vs-short", () => {
    const env = { CLAUDE_CODE_SESSION_ID: "11111111-aaaa-bbbb-cccc-dddddddddddd" };
    expect(isSelfSession("11111111-aaaa-bbbb-cccc-dddddddddddd", env)).toBe(true);
    const env2 = { CLAUDE_CODE_SESSION_ID: "11111111" };
    expect(isSelfSession("11111111", env2)).toBe(true);
  });

  it("does NOT match a different session", () => {
    const env = { CLAUDE_CODE_SESSION_ID: "11111111-aaaa-bbbb-cccc-dddddddddddd" };
    expect(isSelfSession("22222222-aaaa-bbbb-cccc-dddddddddddd", env)).toBe(false);
    expect(isSelfSession("22222222", env)).toBe(false);
  });

  it("fails open (returns false) when CLAUDE_CODE_SESSION_ID is unset", () => {
    expect(isSelfSession("11111111", {})).toBe(false);
  });

  it("returns false (never throws) for a malformed candidate", () => {
    const env = { CLAUDE_CODE_SESSION_ID: "11111111-aaaa-bbbb-cccc-dddddddddddd" };
    expect(isSelfSession("not-an-id", env)).toBe(false);
    expect(isSelfSession("", env)).toBe(false);
  });
});
