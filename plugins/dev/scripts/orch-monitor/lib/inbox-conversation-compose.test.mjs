// inbox-conversation-compose.test.mjs — CTL-1569: the COMPOSITION layer.
//
// The pure ask/thread/comment modules are covered in inbox-conversation.test.mjs.
// This file covers `getConversation` — the assembly, the source-preference wiring,
// and specifically the `canReply` gate, which is acceptance criterion #10 ("rows
// with no underlying ticket show no reply affordance"). All collaborators are
// injected: no replica, no worker dir, no config on disk.
//
// Fixtures use the PROJ prefix per AGENTS.md → Version Control.

import { describe, expect, it } from "bun:test";

import { getConversation, readPhaseSignals } from "./inbox-conversation.mjs";

/** A readThread double with the shape the real reader returns. */
function thread({
  available = true,
  comments = [],
  url = "https://linear.app/x/PROJ-1",
  title = "T",
  agentComments = [],
  reason = null,
} = {}) {
  return async () => ({
    ticket: "PROJ-1",
    available,
    comments,
    url,
    title,
    agentComments,
    lastAgentComment: agentComments[0] ?? null,
    reason,
  });
}

const noSignals = async () => [];

describe("getConversation — assembly", () => {
  it("passes the thread, url and title straight through", async () => {
    const out = await getConversation("PROJ-1", {
      readThread: thread({ comments: [{ id: "c1", body: "hi", isAgent: true }] }),
      readSignals: noSignals,
      config: null,
    });
    expect(out.ticket).toBe("PROJ-1");
    expect(out.url).toBe("https://linear.app/x/PROJ-1");
    expect(out.title).toBe("T");
    expect(out.thread.comments).toHaveLength(1);
    expect(out.thread.available).toBe(true);
  });

  it("prefers the phase-signal explanation over the comment fallback", async () => {
    const out = await getConversation("PROJ-1", {
      readThread: thread({ agentComments: ["a comment that should lose"] }),
      readSignals: async () => [
        { status: "stalled", explanation: { call_to_action: "the explanation wins" } },
      ],
      config: null,
    });
    expect(out.ask.summary).toBe("the explanation wins");
    expect(out.ask.source).toBe("explanation");
  });

  it("falls back to the agent comment when there is no worker dir", async () => {
    // The common parked case: no signals on disk at all.
    const out = await getConversation("PROJ-1", {
      readThread: thread({ agentComments: ["Approve the rollout?"] }),
      readSignals: noSignals,
      config: null,
    });
    expect(out.ask.source).toBe("comment");
    expect(out.ask.kind).toBe("approve");
  });

  it("reports a null ask when no source yields anything (renders absent)", async () => {
    const out = await getConversation("PROJ-1", {
      readThread: thread({ agentComments: [] }),
      readSignals: noSignals,
      config: null,
    });
    expect(out.ask).toBeNull();
  });

  it("survives a signal read that throws", async () => {
    const out = await getConversation("PROJ-1", {
      readThread: thread({ agentComments: ["Approve?"] }),
      readSignals: async () => {
        throw new Error("unreadable worker dir");
      },
      config: null,
    });
    expect(out.ask.source).toBe("comment"); // degraded to the fallback, no throw
  });

  it("threads configured app-actor ids into the thread read", async () => {
    // The agent/human split depends on these — a Catalyst app actor reports
    // is_bot=0, so without the ids every agent comment reads as the operator's.
    let sawIds = null;
    await getConversation("PROJ-1", {
      readThread: async (_t, opts) => {
        sawIds = opts.botUserIds;
        return (await thread()());
      },
      readSignals: noSignals,
      config: {
        catalyst: { linear: { bot: { worker: { botUserId: "bot-uuid" } } } },
      },
    });
    expect(sawIds.has("bot-uuid")).toBe(true);
  });
});

// ── acceptance criterion #10: no reply affordance without a ticket ────────────
describe("getConversation — the canReply gate (AC #10)", () => {
  it("allows a reply when the replica resolved the issue", async () => {
    const out = await getConversation("PROJ-1", {
      readThread: thread({ available: true, url: "https://linear.app/x/PROJ-1" }),
      readSignals: noSignals,
      config: null,
    });
    expect(out.canReply).toBe(true);
  });

  it("REFUSES a reply for a synthesized row with no Linear issue", async () => {
    // An orphan-PR card: the replica is readable and positively has no such issue,
    // so there is nothing to comment on → the UI shows no reply box.
    const out = await getConversation("ORPHAN-1", {
      readThread: thread({ available: true, url: null }),
      readSignals: noSignals,
      config: null,
    });
    expect(out.canReply).toBe(false);
  });

  it("ALLOWS a reply when the replica is unreadable (absence ≠ evidence)", async () => {
    // An unreadable local mirror is not proof the ticket doesn't exist. Refusing
    // here would block the operator from answering a genuinely parked ticket
    // because a cache was locked; the server-side post still 404s honestly.
    const out = await getConversation("PROJ-1", {
      readThread: thread({ available: false, url: null, reason: "replica-absent" }),
      readSignals: noSignals,
      config: null,
    });
    expect(out.canReply).toBe(true);
    expect(out.thread.available).toBe(false);
    expect(out.thread.reason).toBe("replica-absent");
  });
});

describe("readPhaseSignals", () => {
  it("returns [] when the worker dir is absent (the common parked case)", async () => {
    const sigs = await readPhaseSignals("PROJ-1", {
      workersDir: "/nonexistent/path/for/test",
    });
    expect(sigs).toEqual([]);
  });

  it("skips corrupt signal files instead of throwing", async () => {
    const sigs = await readPhaseSignals("PROJ-1", {
      read: async (p) => (String(p).includes("implement") ? "{not json" : '{"status":"stalled"}'),
    });
    // Every readable phase parsed; the corrupt one dropped.
    expect(sigs.length).toBeGreaterThan(0);
    expect(sigs.every((s) => s.status === "stalled")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Codex review remediation (PR #2801) — each test pins a finding that a real
// installation would have hit.
// ═══════════════════════════════════════════════════════════════════════════

import {
  catalystDir,
  defaultWorkersDir,
  deriveRichExplanation,
  EXPLANATION_PHASES,
} from "./inbox-conversation.mjs";
import {
  knownBotUserIds as botIds,
  postBody,
  resolveLinearToken,
} from "./linear-comment.mjs";

describe("P1 #4 — the structured ask must survive to the derivation", () => {
  it("preserves `ask` and `options`, which board-data's projection discards", () => {
    // deriveExplanation keeps only the six legacy strings, so routing the ask
    // through it made the "structured" tier unreachable and killed option chips.
    const expl = deriveRichExplanation([
      { explanation: { ask: { kind: "approve", summary: "Ship it?" }, options: [{ label: "yes" }] } },
    ]);
    expect(expl.ask.kind).toBe("approve");
    expect(expl.options).toHaveLength(1);
  });

  it("end-to-end: a structured ask now reaches getConversation as source=structured", async () => {
    const out = await getConversation("PROJ-1", {
      readThread: thread({ agentComments: ["a comment that must lose"] }),
      readSignals: async () => [
        {
          explanation: {
            ask: { kind: "decide", summary: "A or B?", suggested_replies: ["A", "B"] },
          },
        },
      ],
      config: null,
    });
    expect(out.ask.source).toBe("structured");
    expect(out.ask.suggestedReplies).toEqual(["A", "B"]);
  });

  it("end-to-end: enumerated options become chips", async () => {
    const out = await getConversation("PROJ-1", {
      readThread: thread({ agentComments: [] }),
      readSignals: async () => [
        {
          explanation: {
            call_to_action: "Pick one.",
            options: [{ label: "close" }, { label: "keep" }],
          },
        },
      ],
      config: null,
    });
    expect(out.ask.suggestedReplies).toEqual(["close", "keep"]);
  });

  it("takes the NEWEST explanation when several phases carry one", () => {
    const expl = deriveRichExplanation([
      { explanation: { call_to_action: "old" } },
      { explanation: { call_to_action: "new" } },
    ]);
    expect(expl.call_to_action).toBe("new");
  });
});

describe("P2 #7 — recovery-pass is where rich escalations are authored", () => {
  it("scans the ancillary phases, not just PHASE_ORDER", () => {
    expect(EXPLANATION_PHASES).toContain("recovery-pass");
    expect(EXPLANATION_PHASES).toContain("remediate");
    // Ancillary last, so the newest-first scan prefers them.
    expect(EXPLANATION_PHASES.indexOf("recovery-pass")).toBeGreaterThan(
      EXPLANATION_PHASES.indexOf("teardown"),
    );
  });
});

describe("P2 #17 — honor the configured Catalyst data directory", () => {
  it("uses CATALYST_DIR rather than a hardcoded ~/catalyst", () => {
    expect(catalystDir({ CATALYST_DIR: "/data/cat" })).toBe("/data/cat");
    expect(defaultWorkersDir({ CATALYST_DIR: "/data/cat" })).toBe(
      "/data/cat/execution-core/workers",
    );
  });
  it("falls back to ~/catalyst when unset", () => {
    expect(catalystDir({})).toContain("catalyst");
  });
});

describe("P1 #2 — the reply credential must resolve on the launchd path", () => {
  it("prefers the env token", () => {
    expect(resolveLinearToken({ LINEAR_API_TOKEN: "env-tok" })).toBe("env-tok");
  });

  it("falls back to the Layer-2 personal token when the env carries none", () => {
    // catalyst-monitor.sh exports NO Linear token, so without this fallback every
    // inline reply on the normal persistent launch path returns `no_token`.
    expect(
      resolveLinearToken({}, { projectConfig: { linear: { apiToken: "lin_api_personal" } } }),
    ).toBe("lin_api_personal");
  });

  it("NEVER falls back to the app-actor OAuth token in the same file", () => {
    // Posting as the app is silently ignored by CTL-1567 — the inert failure.
    const projectConfig = {
      catalyst: { linear: { agent: { accessToken: "lin_oauth_app_actor" } } },
    };
    expect(resolveLinearToken({}, { projectConfig })).toBeNull();
  });
});

describe("P2 #8 — the legacy per-repo botUserId form", () => {
  it("reads catalyst.monitor.linear.botUserId as well as the global bot map", () => {
    const ids = botIds({
      config: { catalyst: { monitor: { linear: { botUserId: "legacy-id" } } } },
    });
    expect(ids.has("legacy-id")).toBe(true);
  });
  it("accepts it from the project config too", () => {
    const ids = botIds({
      projectConfig: { catalyst: { monitor: { linear: { botUserId: "proj-id" } } } },
    });
    expect(ids.has("proj-id")).toBe(true);
  });
});

describe("P2 #15 — the operator's reply is posted verbatim", () => {
  it("preserves leading indentation (an indented code block keeps its semantics)", () => {
    expect(postBody("    const x = 1;\nplain")).toBe("    const x = 1;\nplain");
  });
  it("still strips trailing whitespace (invisible, never load-bearing)", () => {
    expect(postBody("hello   \n\n")).toBe("hello");
  });
  it("returns empty string for a non-string", () => {
    expect(postBody(null)).toBe("");
  });
});
