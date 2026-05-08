// Unit tests for catalyst-broker core logic (CTL-303).
// Covers new functionality: agent.checkin/checkout, ticket_lifecycle routing,
// auto-correlation, and updated [broker] log prefix.
// Run: bun test plugins/dev/scripts/broker/index.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleRegister,
  handleAgentCheckin,
  handleAgentCheckout,
  handleAgentHeartbeat,
  shouldSkipEvent,
  buildGroqPrompt,
  getInterests,
  clearInterests,
  getLastHeartbeat,
  clearLastHeartbeat,
  processEvent,
  tryDeterministicRoute,
  tryTicketLifecycleRoute,
} from "./index.mjs";
import {
  openBrokerStateDb,
  closeBrokerStateDb,
  getAgentBySession,
  getAgentsByTicket,
  getTicketState,
} from "./broker-state.mjs";

// ─── Shared DB setup ─────────────────────────────────────────────────────────

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "broker-test-"));
  openBrokerStateDb(join(tmpDir, "test.db"));
  clearInterests();
  clearLastHeartbeat();
});

afterEach(() => {
  closeBrokerStateDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── ticket_lifecycle interest registration ───────────────────────────────────

describe("ticket_lifecycle registration", () => {
  test("handleRegister stores ticket_lifecycle interest with tickets and wake_on", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-1",
      detail: {
        interest_id: "watcher-1",
        notify_event: "filter.wake.watcher-1",
        interest_type: "ticket_lifecycle",
        tickets: ["CTL-275", "CTL-300"],
        wake_on: ["status_done", "pr_merged"],
        persistent: true,
      },
    });
    const reg = getInterests().get("watcher-1");
    expect(reg).toBeDefined();
    expect(reg.interest_type).toBe("ticket_lifecycle");
    expect(reg.tickets).toEqual(["CTL-275", "CTL-300"]);
    expect(reg.wake_on).toEqual(["status_done", "pr_merged"]);
    expect(reg.pr_numbers).toBeNull();
  });

  test("ticket_lifecycle interest is excluded from Groq prompt", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-1",
      detail: {
        interest_id: "tl-1",
        interest_type: "ticket_lifecycle",
        tickets: ["CTL-100"],
        wake_on: null,
        persistent: true,
      },
    });
    const prompt = buildGroqPrompt([{ event: "linear.issue.state_changed" }]);
    expect(prompt).toBeNull();
  });
});

// ─── tryTicketLifecycleRoute ─────────────────────────────────────────────────

describe("tryTicketLifecycleRoute — Linear state changes", () => {
  beforeEach(() => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-1",
      detail: {
        interest_id: "watch-ctl-275",
        notify_event: "filter.wake.watch-ctl-275",
        interest_type: "ticket_lifecycle",
        tickets: ["CTL-275"],
        wake_on: ["status_done", "status_in_review", "status_changed", "comment_added"],
        persistent: true,
      },
    });
  });

  test("fires status_done on linear.issue.state_changed with 'Done' state", () => {
    const matches = tryTicketLifecycleRoute({
      event: "linear.issue.state_changed",
      attributes: { "linear.issue.identifier": "CTL-275" },
      detail: { state: "Done" },
    }, getInterests());
    expect(matches).toHaveLength(1);
    expect(matches[0].interestId).toBe("watch-ctl-275");
    expect(matches[0].reason).toContain("marked Done");
  });

  test("fires status_in_review on 'In Review' state", () => {
    const matches = tryTicketLifecycleRoute({
      event: "linear.issue.state_changed",
      attributes: { "linear.issue.identifier": "CTL-275" },
      detail: { state: "In Review" },
    }, getInterests());
    expect(matches).toHaveLength(1);
    expect(matches[0].reason).toContain("In Review");
  });

  test("fires status_changed for non-terminal state changes", () => {
    const matches = tryTicketLifecycleRoute({
      event: "linear.issue.state_changed",
      attributes: { "linear.issue.identifier": "CTL-275" },
      detail: { state: "In Progress" },
    }, getInterests());
    expect(matches).toHaveLength(1);
    expect(matches[0].reason).toContain("In Progress");
  });

  test("does not fire for unregistered ticket", () => {
    const matches = tryTicketLifecycleRoute({
      event: "linear.issue.state_changed",
      attributes: { "linear.issue.identifier": "CTL-999" },
      detail: { state: "Done" },
    }, getInterests());
    expect(matches).toHaveLength(0);
  });

  test("respects wake_on filter — does not fire when kind not in wake_on", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-1",
      detail: {
        interest_id: "narrow-watch",
        notify_event: "filter.wake.narrow-watch",
        interest_type: "ticket_lifecycle",
        tickets: ["CTL-275"],
        wake_on: ["pr_merged"],
        persistent: true,
      },
    });
    const matches = tryTicketLifecycleRoute({
      event: "linear.issue.state_changed",
      attributes: { "linear.issue.identifier": "CTL-275" },
      detail: { state: "Done" },
    }, getInterests());
    const narrowMatch = matches.find((m) => m.interestId === "narrow-watch");
    expect(narrowMatch).toBeUndefined();
  });
});

describe("tryTicketLifecycleRoute — Linear comments", () => {
  beforeEach(() => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-1",
      detail: {
        interest_id: "comment-watch",
        notify_event: "filter.wake.comment-watch",
        interest_type: "ticket_lifecycle",
        tickets: ["CTL-275"],
        wake_on: ["comment_added"],
        persistent: true,
      },
    });
  });

  test("fires on linear.comment.created for watched ticket", () => {
    const matches = tryTicketLifecycleRoute({
      event: "linear.comment.created",
      attributes: { "linear.issue.identifier": "CTL-275" },
      detail: { author: "ryan" },
    }, getInterests());
    expect(matches).toHaveLength(1);
    expect(matches[0].reason).toContain("ryan");
    expect(matches[0].reason).toContain("CTL-275");
  });

  test("does not fire for unwatched ticket", () => {
    const matches = tryTicketLifecycleRoute({
      event: "linear.comment.created",
      attributes: { "linear.issue.identifier": "CTL-999" },
      detail: { author: "ryan" },
    }, getInterests());
    expect(matches).toHaveLength(0);
  });
});

describe("tryTicketLifecycleRoute — GitHub PR events with ticket link", () => {
  beforeEach(() => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-1",
      detail: {
        interest_id: "pr-watch",
        notify_event: "filter.wake.pr-watch",
        interest_type: "ticket_lifecycle",
        tickets: ["CTL-275"],
        wake_on: ["pr_opened", "pr_merged"],
        persistent: true,
      },
    });
  });

  test("fires pr_opened when PR body references watched ticket", () => {
    const matches = tryTicketLifecycleRoute({
      event: "github.pr.opened",
      scope: { pr: 501 },
      detail: { body: "Implements CTL-275\n\nThis PR does stuff", title: "fix thing", headRef: "ryan/ctl-275" },
    }, getInterests());
    expect(matches).toHaveLength(1);
    expect(matches[0].reason).toContain("501");
    expect(matches[0].reason).toContain("CTL-275");
  });

  test("fires pr_merged when PR body references watched ticket", () => {
    const matches = tryTicketLifecycleRoute({
      event: "github.pr.merged",
      scope: { pr: 501 },
      detail: { body: "Fixes CTL-275", title: "", headRef: "" },
    }, getInterests());
    expect(matches).toHaveLength(1);
    expect(matches[0].reason).toContain("merged");
    expect(matches[0].ticket).toBe("CTL-275");
  });

  test("does not fire when PR body has no ticket reference", () => {
    const matches = tryTicketLifecycleRoute({
      event: "github.pr.opened",
      scope: { pr: 502 },
      detail: { body: "General cleanup PR", title: "cleanup", headRef: "ryan/cleanup" },
    }, getInterests());
    expect(matches).toHaveLength(0);
  });

  test("includes ticket field in match result", () => {
    const matches = tryTicketLifecycleRoute({
      event: "github.pr.opened",
      scope: { pr: 505 },
      detail: { body: "CTL-275 implementation", title: "", headRef: "" },
    }, getInterests());
    expect(matches[0].ticket).toBe("CTL-275");
  });
});

describe("tryTicketLifecycleRoute — ticket_state side effects", () => {
  test("upserts ticket_state on linear.issue.state_changed", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-1",
      detail: {
        interest_id: "ts-watch",
        interest_type: "ticket_lifecycle",
        tickets: ["CTL-280"],
        wake_on: ["status_changed"],
        persistent: true,
      },
    });
    tryTicketLifecycleRoute({
      event: "linear.issue.state_changed",
      attributes: { "linear.issue.identifier": "CTL-280" },
      detail: { state: "Done" },
    }, getInterests());
    const ts = getTicketState("CTL-280");
    expect(ts).not.toBeNull();
    expect(ts.linearState).toBe("Done");
  });
});

// ─── agent.checkin / agent.checkout ──────────────────────────────────────────

describe("agent.checkin", () => {
  test("stores agent identity in DB", () => {
    handleAgentCheckin({
      event: "agent.checkin",
      detail: {
        session_id: "sess-abc",
        agent_name: "ctl-275-worker",
        ticket: "CTL-275",
        orchestrator: "orch-2026",
        claimed_pr: null,
        cwd: "/some/path",
      },
    });
    const agent = getAgentBySession("sess-abc");
    expect(agent).not.toBeNull();
    expect(agent.agentName).toBe("ctl-275-worker");
    expect(agent.ticket).toBe("CTL-275");
    expect(agent.status).toBe("active");
  });

  test("updates heartbeat map on checkin", () => {
    handleAgentCheckin({
      event: "agent.checkin",
      detail: { session_id: "sess-hb", agent_name: "worker", ticket: null, claimed_pr: null },
    });
    expect(getLastHeartbeat().has("sess-hb")).toBe(true);
  });

  test("auto-registers pr_lifecycle interest when claimed_pr is set", () => {
    handleAgentCheckin({
      event: "agent.checkin",
      detail: {
        session_id: "sess-pr",
        agent_name: "worker",
        ticket: "CTL-275",
        orchestrator: "orch-1",
        claimed_pr: 501,
      },
    });
    const reg = getInterests().get("sess-pr");
    expect(reg).toBeDefined();
    expect(reg.interest_type).toBe("pr_lifecycle");
    expect(reg.pr_numbers).toEqual([501]);
    expect(reg.notify_event).toBe("filter.wake.sess-pr");
  });

  test("does not override explicit pr_lifecycle registration with auto-correlation", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-1",
      detail: {
        interest_id: "sess-explicit",
        notify_event: "filter.wake.explicit",
        interest_type: "pr_lifecycle",
        pr_numbers: [999],
        repo: "org/repo",
        base_branches: [{ pr: 999, base: "main" }],
        persistent: true,
      },
    });
    handleAgentCheckin({
      event: "agent.checkin",
      detail: { session_id: "sess-explicit", agent_name: "worker", claimed_pr: 501 },
    });
    const reg = getInterests().get("sess-explicit");
    expect(reg.pr_numbers).toEqual([999]);
    expect(reg.notify_event).toBe("filter.wake.explicit");
  });

  test("no-op when session_id missing", () => {
    expect(() => handleAgentCheckin({ event: "agent.checkin", detail: {} })).not.toThrow();
  });
});

describe("agent.checkout", () => {
  test("marks agent done in DB (getAgentBySession returns null for done agents)", () => {
    handleAgentCheckin({
      event: "agent.checkin",
      detail: { session_id: "sess-co", agent_name: "worker", claimed_pr: null },
    });
    handleAgentCheckout({
      event: "agent.checkout",
      detail: { session_id: "sess-co", status: "done" },
    });
    const agent = getAgentBySession("sess-co");
    expect(agent).toBeNull();
  });

  test("removes auto-correlated pr_lifecycle interest on checkout", () => {
    handleAgentCheckin({
      event: "agent.checkin",
      detail: { session_id: "sess-clean", agent_name: "worker", claimed_pr: 501 },
    });
    expect(getInterests().has("sess-clean")).toBe(true);
    handleAgentCheckout({
      event: "agent.checkout",
      detail: { session_id: "sess-clean", status: "done" },
    });
    expect(getInterests().has("sess-clean")).toBe(false);
  });

  test("preserves unrelated registrations on checkout", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-1",
      detail: {
        interest_id: "explicit-key",
        interest_type: "pr_lifecycle",
        pr_numbers: [501],
        repo: "org/repo",
        base_branches: [],
        persistent: true,
      },
    });
    handleAgentCheckout({
      event: "agent.checkout",
      detail: { session_id: "sess-other", status: "done" },
    });
    expect(getInterests().has("explicit-key")).toBe(true);
  });

  test("no-op when session_id missing", () => {
    expect(() => handleAgentCheckout({ event: "agent.checkout", detail: {} })).not.toThrow();
  });
});

describe("agent.heartbeat", () => {
  test("updates heartbeat map via session field", () => {
    handleAgentHeartbeat({ event: "agent.heartbeat", session: "sess-hb", orchestrator: null });
    expect(getLastHeartbeat().has("sess-hb")).toBe(true);
  });

  test("falls back to worker field", () => {
    handleAgentHeartbeat({ event: "agent.heartbeat", worker: "CTL-275" });
    expect(getLastHeartbeat().has("CTL-275")).toBe(true);
  });
});

// ─── processEvent dispatching ────────────────────────────────────────────────

describe("processEvent dispatches agent identity events", () => {
  test("agent.checkin updates heartbeat map", () => {
    processEvent({
      event: "agent.checkin",
      detail: { session_id: "sess-proc", agent_name: "worker", claimed_pr: null },
    });
    expect(getLastHeartbeat().has("sess-proc")).toBe(true);
  });

  test("agent.checkout removes auto-correlated interest", () => {
    processEvent({
      event: "agent.checkin",
      detail: { session_id: "sess-out", agent_name: "w", claimed_pr: 1 },
    });
    processEvent({
      event: "agent.checkout",
      detail: { session_id: "sess-out", status: "done" },
    });
    expect(getInterests().has("sess-out")).toBe(false);
  });

  test("agent.heartbeat is handled", () => {
    processEvent({ event: "agent.heartbeat", session: "sess-hb2", orchestrator: null });
    expect(getLastHeartbeat().has("sess-hb2")).toBe(true);
  });

  test("ticket_lifecycle match does not throw", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-1",
      detail: {
        interest_id: "tl-pe",
        notify_event: "filter.wake.tl-pe",
        interest_type: "ticket_lifecycle",
        tickets: ["CTL-500"],
        wake_on: ["status_done"],
        persistent: true,
      },
    });
    expect(() =>
      processEvent({
        event: "linear.issue.state_changed",
        attributes: { "linear.issue.identifier": "CTL-500" },
        detail: { state: "Done" },
      })
    ).not.toThrow();
    expect(getInterests().has("tl-pe")).toBe(true);
  });

  test("one-shot ticket_lifecycle interest is auto-deregistered after wake", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-1",
      detail: {
        interest_id: "tl-oneshot",
        notify_event: "filter.wake.tl-oneshot",
        interest_type: "ticket_lifecycle",
        tickets: ["CTL-501"],
        wake_on: ["status_done"],
        persistent: false,
      },
    });
    processEvent({
      event: "linear.issue.state_changed",
      attributes: { "linear.issue.identifier": "CTL-501" },
      detail: { state: "Done" },
    });
    expect(getInterests().has("tl-oneshot")).toBe(false);
  });
});

// ─── Auto-correlation: ticket → PR ──────────────────────────────────────────

describe("auto-correlation: github.pr.opened triggers pr_lifecycle for ticket-watching agents", () => {
  test("agent checked in with ticket gets pr_lifecycle when PR opens", () => {
    handleAgentCheckin({
      event: "agent.checkin",
      detail: { session_id: "sess-auto", agent_name: "worker", ticket: "CTL-275", claimed_pr: null },
    });
    expect(getInterests().has("sess-auto")).toBe(false);

    handleRegister({
      event: "filter.register",
      orchestrator: "orch-1",
      detail: {
        interest_id: "tl-auto",
        notify_event: "filter.wake.tl-auto",
        interest_type: "ticket_lifecycle",
        tickets: ["CTL-275"],
        wake_on: ["pr_opened"],
        persistent: true,
      },
    });

    tryTicketLifecycleRoute({
      event: "github.pr.opened",
      scope: { pr: 601 },
      detail: { body: "Implements CTL-275", title: "", headRef: "" },
    }, getInterests());

    const reg = getInterests().get("sess-auto");
    expect(reg).toBeDefined();
    expect(reg.interest_type).toBe("pr_lifecycle");
    expect(reg.pr_numbers).toEqual([601]);
  });

  test("agents with existing claimed_pr are skipped during auto-correlation", () => {
    handleAgentCheckin({
      event: "agent.checkin",
      detail: { session_id: "sess-already", agent_name: "worker", ticket: "CTL-275", claimed_pr: 500 },
    });
    const prBefore = getInterests().get("sess-already")?.pr_numbers;

    handleRegister({
      event: "filter.register",
      orchestrator: "orch-1",
      detail: {
        interest_id: "tl-skip",
        interest_type: "ticket_lifecycle",
        tickets: ["CTL-275"],
        wake_on: ["pr_opened"],
        persistent: true,
      },
    });

    tryTicketLifecycleRoute({
      event: "github.pr.opened",
      scope: { pr: 601 },
      detail: { body: "CTL-275 implementation", title: "", headRef: "" },
    }, getInterests());

    expect(getInterests().get("sess-already")?.pr_numbers).toEqual(prBefore);
  });
});

// ─── getAgentsByTicket ───────────────────────────────────────────────────────

describe("getAgentsByTicket", () => {
  test("returns active agents for a ticket", () => {
    handleAgentCheckin({
      event: "agent.checkin",
      detail: { session_id: "sess-t1", agent_name: "w1", ticket: "CTL-400", claimed_pr: null },
    });
    handleAgentCheckin({
      event: "agent.checkin",
      detail: { session_id: "sess-t2", agent_name: "w2", ticket: "CTL-400", claimed_pr: null },
    });
    const agents = getAgentsByTicket("CTL-400");
    expect(agents).toHaveLength(2);
    expect(agents.map((a) => a.sessionId).sort()).toEqual(["sess-t1", "sess-t2"].sort());
  });

  test("returns empty array for unknown ticket", () => {
    expect(getAgentsByTicket("CTL-NOPE")).toHaveLength(0);
  });
});

// ─── Backward compat: pr_lifecycle routing unchanged ────────────────────────

describe("backward compat: pr_lifecycle routing unchanged in broker", () => {
  test("github.pr.merged fires pr_lifecycle interest", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-bc",
      detail: {
        interest_id: "sess-bc",
        notify_event: "filter.wake.sess-bc",
        interest_type: "pr_lifecycle",
        pr_numbers: [501],
        repo: "org/repo",
        base_branches: [{ pr: 501, base: "main" }],
        persistent: true,
        session_id: "sess-bc",
      },
    });
    const matches = tryDeterministicRoute({
      event: "github.pr.merged",
      scope: { pr: 501 },
      detail: { mergeCommitSha: "abc123", merged: true },
    }, getInterests());
    expect(matches).toHaveLength(1);
    expect(matches[0].interestId).toBe("sess-bc");
    expect(matches[0].reason).toContain("merged");
  });

  test("github.check_suite.completed fires pr_lifecycle interest", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-bc",
      detail: {
        interest_id: "ci-watch",
        notify_event: "filter.wake.ci-watch",
        interest_type: "pr_lifecycle",
        pr_numbers: [502],
        repo: "org/repo",
        base_branches: [],
        persistent: true,
      },
    });
    const matches = tryDeterministicRoute({
      event: "github.check_suite.completed",
      detail: { prNumbers: [502], conclusion: "success" },
    }, getInterests());
    expect(matches).toHaveLength(1);
    expect(matches[0].reason).toContain("CI checks passing");
  });
});

// ─── shouldSkipEvent (broker) ─────────────────────────────────────────────────

describe("shouldSkipEvent (broker)", () => {
  test("skips filter.* events", () => {
    expect(shouldSkipEvent({ event: "filter.wake.x" })).toBe(true);
    expect(shouldSkipEvent({ event: "filter.register" })).toBe(true);
  });

  test("does not skip agent.* events", () => {
    expect(shouldSkipEvent({ event: "agent.checkin" })).toBe(false);
    expect(shouldSkipEvent({ event: "agent.checkout" })).toBe(false);
  });

  test("does not skip linear.* events", () => {
    expect(shouldSkipEvent({ event: "linear.issue.state_changed" })).toBe(false);
    expect(shouldSkipEvent({ event: "linear.comment.created" })).toBe(false);
  });
});
