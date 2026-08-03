// linear-comment.test.mjs — CTL-1569 §4 + the 2026-08-02 multi-candidate
// identity-walk fix. All collaborators (resolveIdentity/resolveIssue/fetchImpl)
// are injected so every branch runs with zero network.

import { describe, it, expect } from "bun:test";
import {
  linearTokenCandidates,
  resolveLinearToken,
  postOperatorComment,
} from "./linear-comment.mjs";

describe("linearTokenCandidates", () => {
  it("returns [] with no env and no config", () => {
    expect(linearTokenCandidates({}, {})).toEqual([]);
  });

  it("reads LINEAR_API_TOKEN", () => {
    expect(linearTokenCandidates({ LINEAR_API_TOKEN: "tok-a" }, {})).toEqual(["tok-a"]);
  });

  it("reads LINEAR_API_KEY when LINEAR_API_TOKEN is absent", () => {
    expect(linearTokenCandidates({ LINEAR_API_KEY: "tok-b" }, {})).toEqual(["tok-b"]);
  });

  it("LINEAR_API_TOKEN and LINEAR_API_KEY both present and DIFFERENT: token first, both kept", () => {
    expect(
      linearTokenCandidates({ LINEAR_API_TOKEN: "tok-a", LINEAR_API_KEY: "tok-b" }, {}),
    ).toEqual(["tok-a", "tok-b"]);
  });

  it("LINEAR_API_TOKEN and LINEAR_API_KEY both present and IDENTICAL: deduplicated to one entry", () => {
    expect(
      linearTokenCandidates({ LINEAR_API_TOKEN: "tok-a", LINEAR_API_KEY: "tok-a" }, {}),
    ).toEqual(["tok-a"]);
  });

  it("includes Layer-2 linear.apiToken after env", () => {
    expect(
      linearTokenCandidates(
        { LINEAR_API_TOKEN: "tok-a" },
        { projectConfig: { linear: { apiToken: "tok-personal" } } },
      ),
    ).toEqual(["tok-a", "tok-personal"]);
  });

  it("includes the nested catalyst.linear.apiToken shape too", () => {
    expect(
      linearTokenCandidates(
        {},
        { projectConfig: { catalyst: { linear: { apiToken: "tok-nested" } } } },
      ),
    ).toEqual(["tok-nested"]);
  });

  it("BOTH linear.apiToken and catalyst.linear.apiToken present and different: both kept", () => {
    expect(
      linearTokenCandidates(
        {},
        {
          projectConfig: {
            linear: { apiToken: "tok-flat" },
            catalyst: { linear: { apiToken: "tok-nested" } },
          },
        },
      ),
    ).toEqual(["tok-flat", "tok-nested"]);
  });

  it("a config candidate identical to an env candidate is deduplicated", () => {
    expect(
      linearTokenCandidates(
        { LINEAR_API_TOKEN: "tok-a" },
        { projectConfig: { linear: { apiToken: "tok-a" } } },
      ),
    ).toEqual(["tok-a"]);
  });

  it("whitespace-only / empty-string values are ignored, not treated as present", () => {
    expect(
      linearTokenCandidates(
        { LINEAR_API_TOKEN: "   ", LINEAR_API_KEY: "" },
        { projectConfig: { linear: { apiToken: "tok-real" } } },
      ),
    ).toEqual(["tok-real"]);
  });

  it("trims surrounding whitespace on an otherwise-valid candidate", () => {
    expect(linearTokenCandidates({ LINEAR_API_TOKEN: "  tok-a  " }, {})).toEqual(["tok-a"]);
  });
});

describe("resolveLinearToken (single highest-priority candidate)", () => {
  it("returns the first candidate", () => {
    expect(
      resolveLinearToken(
        { LINEAR_API_TOKEN: "tok-a" },
        { projectConfig: { linear: { apiToken: "tok-personal" } } },
      ),
    ).toBe("tok-a");
  });

  it("returns null when there are no candidates", () => {
    expect(resolveLinearToken({}, {})).toBeNull();
  });
});

// ── postOperatorComment ───────────────────────────────────────────────────────

/** A fake resolveIdentity keyed by token → identity result, so a test can give
 *  distinct candidates distinct (human/bot/error) outcomes and assert exactly
 *  which token wins. */
function identityMap(map) {
  const calls = [];
  const fn = async ({ token }) => {
    calls.push(token);
    const result = map[token];
    if (!result) throw new Error(`identityMap: no entry for token ${token}`);
    return result;
  };
  fn.calls = calls;
  return fn;
}

const HUMAN = { ok: true, id: "user-1", name: "Tony", email: "tony@hagale.net", isMe: true, isBot: false };
const BOT = { ok: true, id: "bot-1", name: "Catalyst App", email: null, isMe: false, isBot: true };
const HUMAN2 = { ok: true, id: "user-2", name: "Other Human", email: "other@example.com", isMe: false, isBot: false };

function fakeResolveIssue(result = { ok: true, id: "issue-uuid-1" }) {
  return async () => result;
}

function fakeFetchPostingComment() {
  return async () =>
    new Response(
      JSON.stringify({
        data: {
          commentCreate: {
            success: true,
            comment: { id: "comment-1", createdAt: "2026-08-03T00:00:00Z", user: { id: "user-1", name: "Tony", email: "tony@hagale.net" } },
          },
        },
      }),
      { status: 200 },
    );
}

describe("postOperatorComment — single-candidate behavior (regression guard)", () => {
  it("empty body short-circuits before ever resolving a token", async () => {
    const resolveIdentity = identityMap({});
    const result = await postOperatorComment(
      { ticket: "CTL-1", body: "   " },
      { env: { LINEAR_API_TOKEN: "tok-a" }, resolveIdentity },
    );
    expect(result).toEqual({ status: "empty_body" });
    expect(resolveIdentity.calls).toEqual([]);
  });

  it("no_token when there are zero candidates", async () => {
    const result = await postOperatorComment(
      { ticket: "CTL-1", body: "hello" },
      { env: {}, projectConfig: {} },
    );
    expect(result).toEqual({ status: "no_token" });
  });

  it("a single human candidate posts the comment", async () => {
    const resolveIdentity = identityMap({ "tok-a": HUMAN });
    const result = await postOperatorComment(
      { ticket: "CTL-1", body: "continue" },
      {
        env: { LINEAR_API_TOKEN: "tok-a" },
        resolveIdentity,
        resolveIssue: fakeResolveIssue(),
        fetchImpl: fakeFetchPostingComment(),
      },
    );
    expect(result.status).toBe("posted");
    expect(resolveIdentity.calls).toEqual(["tok-a"]);
  });

  it("a single bot candidate refuses with the ORIGINAL (non-plural) message", async () => {
    const resolveIdentity = identityMap({ "tok-a": BOT });
    const result = await postOperatorComment(
      { ticket: "CTL-1", body: "continue" },
      { env: { LINEAR_API_TOKEN: "tok-a" }, resolveIdentity },
    );
    expect(result.status).toBe("bot_identity");
    expect(result.author).toEqual({ id: "bot-1", name: "Catalyst App" });
    expect(result.message).not.toMatch(/all \d+ configured/);
    expect(result.message).toMatch(/this monitor's Linear token is an app actor/);
  });
});

describe("postOperatorComment — multi-candidate identity walk (2026-08-02 fix)", () => {
  it("env resolves to a BOT, config resolves to a HUMAN: skips the bot, posts with the config token", async () => {
    const resolveIdentity = identityMap({ "tok-bot": BOT, "tok-personal": HUMAN });
    const resolveIssue = fakeResolveIssue();
    let sawAuthToken = null;
    const fetchImpl = async (_url, init) => {
      sawAuthToken = init.headers.Authorization;
      return fakeFetchPostingComment()();
    };
    const result = await postOperatorComment(
      { ticket: "CTL-1", body: "continue" },
      {
        env: { LINEAR_API_TOKEN: "tok-bot" },
        projectConfig: { linear: { apiToken: "tok-personal" } },
        resolveIdentity,
        resolveIssue,
        fetchImpl,
      },
    );
    expect(result.status).toBe("posted");
    // BOTH candidates were identity-checked, in priority order — the bot was
    // tried first (env wins priority) and skipped, not treated as a hard fail.
    expect(resolveIdentity.calls).toEqual(["tok-bot", "tok-personal"]);
    // The comment was actually posted with the HUMAN token, not the bot's.
    expect(sawAuthToken).toBe("tok-personal");
  });

  it("both candidates are bots: refuses with the PLURAL message naming the count", async () => {
    const resolveIdentity = identityMap({ "tok-bot-1": BOT, "tok-bot-2": { ...BOT, id: "bot-2" } });
    const result = await postOperatorComment(
      { ticket: "CTL-1", body: "continue" },
      {
        env: { LINEAR_API_TOKEN: "tok-bot-1", LINEAR_API_KEY: "tok-bot-2" },
        resolveIdentity,
      },
    );
    expect(result.status).toBe("bot_identity");
    expect(result.message).toMatch(/all 2 configured Linear tokens/);
    // Reports the LAST bot identity checked (both tried).
    expect(resolveIdentity.calls).toEqual(["tok-bot-1", "tok-bot-2"]);
    expect(result.author.id).toBe("bot-2");
  });

  it("the first candidate errors (transport/auth failure), the second is human: falls through to it", async () => {
    const calls = [];
    const outcomes = { "tok-broken": { ok: false, error: "HTTP 401: bad token" }, "tok-personal": HUMAN };
    const resolveIdentity = async ({ token }) => {
      calls.push(token);
      return outcomes[token];
    };
    const result = await postOperatorComment(
      { ticket: "CTL-1", body: "continue" },
      {
        env: { LINEAR_API_TOKEN: "tok-broken" },
        projectConfig: { linear: { apiToken: "tok-personal" } },
        resolveIdentity,
        resolveIssue: fakeResolveIssue(),
        fetchImpl: fakeFetchPostingComment(),
      },
    );
    expect(result.status).toBe("posted");
    expect(calls).toEqual(["tok-broken", "tok-personal"]);
  });

  it("every candidate errors: status error, message carries the LAST error", async () => {
    const resolveIdentity = async ({ token }) => ({ ok: false, error: `boom for ${token}` });
    const result = await postOperatorComment(
      { ticket: "CTL-1", body: "continue" },
      {
        env: { LINEAR_API_TOKEN: "tok-a" },
        projectConfig: { linear: { apiToken: "tok-b" } },
        resolveIdentity,
      },
    );
    expect(result.status).toBe("error");
    expect(result.message).toMatch(/boom for tok-b/);
  });

  it("three candidates — first bot, second errors, third human: posts with the third", async () => {
    const calls = [];
    const outcomes = { "tok-bot": BOT, "tok-broken": { ok: false, error: "timeout" }, "tok-good": HUMAN2 };
    const resolveIdentity = async ({ token }) => {
      calls.push(token);
      return outcomes[token];
    };
    const result = await postOperatorComment(
      { ticket: "CTL-1", body: "continue" },
      {
        env: { LINEAR_API_TOKEN: "tok-bot", LINEAR_API_KEY: "tok-broken" },
        projectConfig: { linear: { apiToken: "tok-good" } },
        resolveIdentity,
        resolveIssue: fakeResolveIssue(),
        fetchImpl: fakeFetchPostingComment(),
      },
    );
    expect(result.status).toBe("posted");
    expect(calls).toEqual(["tok-bot", "tok-broken", "tok-good"]);
  });

  it("stops at the FIRST human candidate — never checks identity for candidates after it", async () => {
    const resolveIdentity = identityMap({ "tok-first-human": HUMAN, "tok-never-reached": HUMAN2 });
    const result = await postOperatorComment(
      { ticket: "CTL-1", body: "continue" },
      {
        env: { LINEAR_API_TOKEN: "tok-first-human" },
        projectConfig: { linear: { apiToken: "tok-never-reached" } },
        resolveIdentity,
        resolveIssue: fakeResolveIssue(),
        fetchImpl: fakeFetchPostingComment(),
      },
    );
    expect(result.status).toBe("posted");
    expect(resolveIdentity.calls).toEqual(["tok-first-human"]);
  });
});
