// conversation-client.test.ts — CTL-1569: the inbox conversation surface's web
// clients. Both branches of every IO path, with an injected fetch (no server).
//
// The read fails SOFT (the pane just renders nothing); the write fails LOUD and
// specifically, because §4 requires a failed post to restore the row and tell the
// operator what happened to their words.
import { describe, expect, it } from "bun:test";

import {
  conversationUrl,
  fetchConversation,
  postReply,
  replyUrl,
  type ConversationResponse,
} from "../ui/src/board/conversation-client";
import {
  askPresentation,
  inferredNote,
  isInferredAsk,
} from "../ui/src/board/inbox-ask-model";

/** Wrap an impl(url, init) → Response as a typed fetch.
 *  Mirrors the existing convention in inbox-read-client.test.ts: the `as typeof
 *  fetch` cast satisfies Bun's static `fetch.preconnect` member (a bare
 *  `async () => Response` does not, TS2741), and returning a resolved promise
 *  instead of an async arrow keeps `@typescript-eslint/require-await` quiet. */
function mockFetch(impl: (url: string, init?: RequestInit) => Response): typeof fetch {
  return ((input: string | URL, init?: RequestInit) =>
    Promise.resolve(impl(String(input), init))) as typeof fetch;
}

/** A throwing fetch — simulates a network failure (offline / DNS). */
function boomFetch(message: string): typeof fetch {
  return ((_input: string | URL, _init?: RequestInit) =>
    Promise.reject(new Error(message))) as typeof fetch;
}

function jsonRes(body: unknown, ok = true, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status: ok ? status : status >= 400 ? status : 500,
    headers: { "Content-Type": "application/json" },
  });
}

const CONVERSATION: ConversationResponse = {
  ticket: "PROJ-1",
  url: "https://linear.app/x/PROJ-1",
  title: "A title",
  thread: { available: true, comments: [], reason: null },
  ask: {
    kind: "approve",
    summary: "Reply approve to publish.",
    suggestedReplies: ["approve", "no"],
    canResolveByReply: true,
    source: "structured",
  },
  canReply: true,
};

describe("conversationUrl / replyUrl", () => {
  it("builds the replica-read URL, with an optional bound", () => {
    expect(conversationUrl("PROJ-1")).toBe("/api/ticket/PROJ-1/thread");
    expect(conversationUrl("PROJ-1", 4)).toBe("/api/ticket/PROJ-1/thread?limit=4");
  });
  it("encodes the ticket", () => {
    expect(replyUrl("PROJ 1")).toBe("/api/ticket/PROJ%201/reply");
  });
});

describe("fetchConversation — fails SOFT", () => {
  it("returns the parsed conversation on success", async () => {
    const out = await fetchConversation("PROJ-1", {
      fetchImpl: mockFetch(() => jsonRes(CONVERSATION)),
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.conversation.ask?.kind).toBe("approve");
  });

  it("returns ok:false on a non-ok status (no error card)", async () => {
    const out = await fetchConversation("PROJ-1", {
      fetchImpl: mockFetch(() => jsonRes({}, false, 500)),
    });
    expect(out.ok).toBe(false);
  });

  it("returns ok:false on a network throw rather than propagating", async () => {
    const out = await fetchConversation("PROJ-1", {
      fetchImpl: boomFetch("offline"),
    });
    expect(out.ok).toBe(false);
  });
});

describe("postReply — fails LOUD and specifically", () => {
  it("maps a confirmed post to `replied`", async () => {
    const out = await postReply(
      { ticket: "PROJ-1", body: "approve" },
      {
        fetchImpl: mockFetch(() =>
          jsonRes({
            status: "replied",
            ticket: "PROJ-1",
            commentId: "c1",
            author: { id: "h", name: "Ryan" },
          }),
        ),
      },
    );
    expect(out.status).toBe("replied");
    if (out.status === "replied") expect(out.commentId).toBe("c1");
  });

  it("REFUSES to treat a post with no comment id as success", async () => {
    // Without a comment id the post is unverified — clearing the row would risk
    // losing the item, so this is an error, not a success.
    const out = await postReply(
      { ticket: "PROJ-1", body: "approve" },
      { fetchImpl: mockFetch(() => jsonRes({ status: "replied", ticket: "PROJ-1" })) },
    );
    expect(out.status).toBe("error");
  });

  it("explains the app-actor refusal in operator language", async () => {
    // The failure that would otherwise ship the feature silently inert.
    const out = await postReply(
      { ticket: "PROJ-1", body: "approve" },
      { fetchImpl: mockFetch(() => jsonRes({ status: "bot_identity" }, false, 502)) },
    );
    expect(out.status).toBe("bot_identity");
    if (out.status === "bot_identity") {
      expect(out.message).toContain("Catalyst app");
      expect(out.message).toContain("kept");
    }
  });

  it("maps no_token to an error that says the reply was kept", async () => {
    const out = await postReply(
      { ticket: "PROJ-1", body: "hi" },
      { fetchImpl: mockFetch(() => jsonRes({ status: "no_token" }, false, 502)) },
    );
    expect(out.status).toBe("error");
    if (out.status === "error") expect(out.message).toContain("kept");
  });

  it("maps a missing ticket to not_found", async () => {
    const out = await postReply(
      { ticket: "PROJ-404", body: "hi" },
      { fetchImpl: mockFetch(() => jsonRes({ status: "not_found" }, false, 404)) },
    );
    expect(out.status).toBe("not_found");
  });

  it("maps an empty body to `empty` (not an error)", async () => {
    const out = await postReply(
      { ticket: "PROJ-1", body: "" },
      { fetchImpl: mockFetch(() => jsonRes({ status: "empty_body" }, false, 400)) },
    );
    expect(out.status).toBe("empty");
  });

  it("never reports success on a network throw", async () => {
    const out = await postReply(
      { ticket: "PROJ-1", body: "hi" },
      {
        fetchImpl: boomFetch("ECONNRESET"),
      },
    );
    expect(out.status).toBe("error");
    if (out.status === "error") expect(out.message).toContain("ECONNRESET");
  });

  it("treats an unrecognized status as an error (conservative for a write)", async () => {
    const out = await postReply(
      { ticket: "PROJ-1", body: "hi" },
      { fetchImpl: mockFetch(() => jsonRes({ status: "who_knows" })) },
    );
    expect(out.status).toBe("error");
  });
});

describe("inbox-ask-model — the presentation of the ask", () => {
  it("makes 'you must act first' unmistakable, not just a tint", () => {
    const p = askPresentation("act-then-confirm");
    expect(p.requiresAction).toBe(true);
    expect(p.accent).toBe("red");
    expect(p.resolutionHint).toContain("NOT");
  });

  it("tells the operator a reply alone is enough for the reply-alone kinds", () => {
    for (const kind of ["approve", "decide", "clarify"]) {
      expect(askPresentation(kind).requiresAction).toBe(false);
    }
  });

  it("labels each kind distinctly", () => {
    const labels = ["approve", "decide", "act-then-confirm", "clarify"].map(
      (k) => askPresentation(k).label,
    );
    expect(new Set(labels).size).toBe(4);
  });

  it("degrades an unknown kind to clarify rather than throwing", () => {
    expect(askPresentation("nonsense").label).toBe(askPresentation("clarify").label);
  });

  it("marks a derived ask as inferred, and a producer-authored one as not", () => {
    expect(isInferredAsk("structured")).toBe(false);
    expect(inferredNote("structured")).toBeNull();
    expect(inferredNote("comment")).toContain("last comment");
    expect(inferredNote("explanation")).toContain("escalation");
  });
});
