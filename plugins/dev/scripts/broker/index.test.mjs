// Unit tests for catalyst-broker core logic (CTL-303).
// Covers new functionality: agent.checkin/checkout, ticket_lifecycle routing,
// auto-correlation, and updated [broker] log prefix.
// Run: bun test plugins/dev/scripts/broker/index.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, rmSync as rmFile } from "node:fs";
import {
  handleRegister,
  handleDeregister,
  handleAgentCheckin,
  handleAgentCheckout,
  handleAgentHeartbeat,
  handleWorkerWaiting,
  handleWorkerResumed,
  getWaitingSessionsMap,
  clearWaitingSessionsMap,
  shouldSkipEvent,
  buildGroqPrompt,
  getInterests,
  clearInterests,
  getLastHeartbeat,
  getWorkerToOrchestrator,
  clearLastHeartbeat,
  loadPersistedInterests,
  processEvent,
  tryDeterministicRoute,
  tryTicketLifecycleRoute,
  classifyMatches,
  summarizeEvent,
  buildBrokerState,
  writeBrokerStateFile,
  __clearEmittedWakeCacheForTest,
} from "./index.mjs";
import {
  openBrokerStateDb,
  closeBrokerStateDb,
  getAgentBySession,
  getAgentsByTicket,
  getTicketState,
  getWaitingSession,
  getActiveWaitingSessions,
} from "./broker-state.mjs";

// ─── Shared DB setup ─────────────────────────────────────────────────────────

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "broker-test-"));
  // CTL-350: redirect CATALYST_DIR so tests never write to the production
  // ~/catalyst/broker-interests.json path during persistence operations.
  process.env.CATALYST_DIR = tmpDir;
  openBrokerStateDb(join(tmpDir, "test.db"));
  clearInterests();
  clearLastHeartbeat();
  __clearEmittedWakeCacheForTest();
  clearWaitingSessionsMap();
});

afterEach(() => {
  closeBrokerStateDb();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.CATALYST_DIR;
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

// CTL-401: canonical session.heartbeat routing ─────────────────────────────

describe("session.heartbeat (canonical OTel)", () => {
  test("handleAgentHeartbeat reads session ID from canonical attributes", () => {
    handleAgentHeartbeat({
      attributes: { "event.name": "session.heartbeat", "catalyst.session.id": "sess-canonical" },
    });
    expect(getLastHeartbeat().has("sess-canonical")).toBe(true);
  });

  test("handleAgentHeartbeat reads orchestrator ID from canonical attributes", () => {
    handleAgentHeartbeat({
      attributes: {
        "event.name": "session.heartbeat",
        "catalyst.session.id": "sess-w",
        "catalyst.orchestrator.id": "orch-x",
      },
    });
    expect(getWorkerToOrchestrator().get("sess-w")).toBe("orch-x");
  });

  test("flat session field still takes priority over canonical attribute", () => {
    handleAgentHeartbeat({
      session: "sess-flat",
      attributes: { "catalyst.session.id": "sess-attr" },
    });
    expect(getLastHeartbeat().has("sess-flat")).toBe(true);
    expect(getLastHeartbeat().has("sess-attr")).toBe(false);
  });

  test("processEvent routes session.heartbeat to lastHeartbeat", () => {
    processEvent({
      attributes: { "event.name": "session.heartbeat", "catalyst.session.id": "sess-proc-canonical" },
      resource: { "service.name": "catalyst.session" },
      body: { payload: null },
    });
    expect(getLastHeartbeat().has("sess-proc-canonical")).toBe(true);
  });

  test("shouldSkipEvent returns true for session.heartbeat canonical", () => {
    expect(
      shouldSkipEvent({
        attributes: { "event.name": "session.heartbeat" },
        resource: { "service.name": "catalyst.session" },
      }),
    ).toBe(true);
  });
});

// ─── CTL-403: worker.waiting / worker.resumed ────────────────────────────────

describe("worker.waiting", () => {
  test("stores session in in-memory map with computed timeoutAt", () => {
    const since = new Date().toISOString();
    handleWorkerWaiting({
      event: "worker.waiting",
      detail: {
        session_id: "sess-waiting",
        orchestrator: "orch-1",
        ticket: "CTL-403",
        wait_for: "github.pr.merged",
        timeout_ms: 3600000,
        since,
        reason: "phase 5 listen loop",
      },
    });
    const map = getWaitingSessionsMap();
    expect(map.has("sess-waiting")).toBe(true);
    const entry = map.get("sess-waiting");
    expect(entry.waitFor).toBe("github.pr.merged");
    expect(entry.ticket).toBe("CTL-403");
    expect(entry.timeoutAt).toBeGreaterThan(Date.now());
  });

  test("resets heartbeat timer for the session", () => {
    const since = new Date().toISOString();
    handleWorkerWaiting({
      event: "worker.waiting",
      detail: { session_id: "sess-hb-reset", timeout_ms: 3600000, since },
    });
    expect(getLastHeartbeat().has("sess-hb-reset")).toBe(true);
  });

  test("persists to waiting_sessions SQLite table", () => {
    const since = new Date().toISOString();
    handleWorkerWaiting({
      event: "worker.waiting",
      detail: {
        session_id: "sess-db",
        orchestrator: "orch-x",
        ticket: "CTL-403",
        wait_for: ".attributes.\"event.name\" == \"github.pr.merged\"",
        timeout_ms: 7200000,
        since,
        reason: "test",
      },
    });
    const row = getWaitingSession("sess-db");
    expect(row).not.toBeNull();
    expect(row.ticket).toBe("CTL-403");
    expect(row.waitFor).toBe(".attributes.\"event.name\" == \"github.pr.merged\"");
    expect(typeof row.timeoutAt).toBe("string");
  });

  test("no-op when session_id missing", () => {
    expect(() =>
      handleWorkerWaiting({ event: "worker.waiting", detail: { timeout_ms: 1000, since: new Date().toISOString() } })
    ).not.toThrow();
    expect(getWaitingSessionsMap().size).toBe(0);
  });

  test("getActiveWaitingSessions returns only non-expired sessions", () => {
    const future = new Date().toISOString();
    handleWorkerWaiting({ event: "worker.waiting", detail: { session_id: "sess-past", timeout_ms: 1, since: new Date(Date.now() - 10000).toISOString() } });
    handleWorkerWaiting({ event: "worker.waiting", detail: { session_id: "sess-future", timeout_ms: 3600000, since: future } });
    const active = getActiveWaitingSessions();
    const ids = active.map((s) => s.sessionId);
    expect(ids).not.toContain("sess-past");
    expect(ids).toContain("sess-future");
  });
});

describe("worker.resumed", () => {
  test("removes session from in-memory map", () => {
    const since = new Date().toISOString();
    handleWorkerWaiting({ event: "worker.waiting", detail: { session_id: "sess-r", timeout_ms: 3600000, since } });
    expect(getWaitingSessionsMap().has("sess-r")).toBe(true);
    handleWorkerResumed({ event: "worker.resumed", detail: { session_id: "sess-r", outcome: "matched" } });
    expect(getWaitingSessionsMap().has("sess-r")).toBe(false);
  });

  test("removes session from SQLite table", () => {
    const since = new Date().toISOString();
    handleWorkerWaiting({ event: "worker.waiting", detail: { session_id: "sess-db-r", timeout_ms: 3600000, since } });
    expect(getWaitingSession("sess-db-r")).not.toBeNull();
    handleWorkerResumed({ event: "worker.resumed", detail: { session_id: "sess-db-r", outcome: "timed_out" } });
    expect(getWaitingSession("sess-db-r")).toBeNull();
  });

  test("no-op when session_id missing", () => {
    expect(() =>
      handleWorkerResumed({ event: "worker.resumed", detail: {} })
    ).not.toThrow();
  });
});

describe("watchdog skips legitimately waiting sessions (CTL-403)", () => {
  test("session with active wait is not woken when heartbeat is stale", async () => {
    const { runWatchdogTick } = await import("./index.mjs");

    // Register an interest watching sess-wait
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-w",
      detail: {
        interest_id: "orch-w",
        notify_event: "filter.wake.orch-w",
        interest_type: "pr_lifecycle",
        pr_numbers: [42],
        repo: "org/repo",
        base_branches: [],
        persistent: true,
        context: { pr_numbers: [42], tickets: [], workers: ["sess-wait"] },
        session_id: null,
      },
    });

    // Simulate stale heartbeat by backdating the entry
    const staleTs = Date.now() - 300_000;
    getLastHeartbeat().set("sess-wait", { ts: staleTs, notified: false });

    // Mark as actively waiting with timeout in the future
    getWaitingSessionsMap().set("sess-wait", {
      timeoutAt: Date.now() + 3_600_000,
      waitFor: "github.pr.merged",
      ticket: "CTL-403",
      orchestrator: "orch-w",
      reason: "test",
    });

    const ym = new Date().toISOString().slice(0, 7);
    const logPath = join(tmpDir, "events", `${ym}.jsonl`);

    runWatchdogTick();

    // No filter.wake event should have been emitted for this session
    if (existsSync(logPath)) {
      const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
      const wakes = lines.filter((l) => {
        try {
          const evt = JSON.parse(l);
          const evtName = evt.event ?? evt.attributes?.["event.name"] ?? "";
          return evtName === "filter.wake.orch-w";
        } catch { return false; }
      });
      expect(wakes).toHaveLength(0);
    }
    // Heartbeat entry still present (not cleaned up)
    expect(getLastHeartbeat().has("sess-wait")).toBe(true);
  });

  test("session with EXPIRED wait IS woken as stale", async () => {
    const { runWatchdogTick } = await import("./index.mjs");

    handleRegister({
      event: "filter.register",
      orchestrator: "orch-exp",
      detail: {
        interest_id: "orch-exp",
        notify_event: "filter.wake.orch-exp",
        interest_type: "pr_lifecycle",
        pr_numbers: [99],
        repo: "org/repo",
        base_branches: [],
        persistent: true,
        context: { pr_numbers: [99], tickets: [], workers: ["sess-exp"] },
        session_id: null,
      },
    });

    const staleTs = Date.now() - 300_000;
    getLastHeartbeat().set("sess-exp", { ts: staleTs, notified: false });

    // Expired wait (timeoutAt in the past)
    getWaitingSessionsMap().set("sess-exp", {
      timeoutAt: Date.now() - 1000,
      waitFor: "github.pr.merged",
      ticket: "CTL-403",
      orchestrator: "orch-exp",
      reason: "test",
    });

    runWatchdogTick();

    // Expired wait should be cleaned up
    expect(getWaitingSessionsMap().has("sess-exp")).toBe(false);
  });
});

describe("buildBrokerState includes waitingSessions (CTL-403)", () => {
  test("empty when no active waits", () => {
    const state = buildBrokerState();
    expect(Array.isArray(state.waitingSessions)).toBe(true);
    expect(state.waitingSessions).toHaveLength(0);
  });

  test("includes active sessions with correct shape", () => {
    const since = new Date().toISOString();
    handleWorkerWaiting({
      event: "worker.waiting",
      detail: {
        session_id: "sess-bst",
        ticket: "CTL-403",
        orchestrator: "orch-bst",
        wait_for: "github.pr.merged",
        timeout_ms: 3600000,
        since,
        reason: "test",
      },
    });
    const state = buildBrokerState();
    expect(state.waitingSessions).toHaveLength(1);
    const ws = state.waitingSessions[0];
    expect(ws.sessionId).toBe("sess-bst");
    expect(ws.ticket).toBe("CTL-403");
    expect(ws.waitFor).toBe("github.pr.merged");
    expect(typeof ws.timeoutAt).toBe("string");
  });

  test("excludes expired sessions", () => {
    getWaitingSessionsMap().set("sess-expired", {
      timeoutAt: Date.now() - 5000,
      waitFor: "anything",
      ticket: "CTL-000",
      orchestrator: null,
      reason: null,
    });
    const state = buildBrokerState();
    const ids = state.waitingSessions.map((s) => s.sessionId);
    expect(ids).not.toContain("sess-expired");
  });
});

describe("processEvent routes worker.waiting and worker.resumed (CTL-403)", () => {
  test("worker.waiting is handled via processEvent", () => {
    const since = new Date().toISOString();
    processEvent({
      event: "worker.waiting",
      detail: { session_id: "sess-pe-w", timeout_ms: 3600000, since },
    });
    expect(getWaitingSessionsMap().has("sess-pe-w")).toBe(true);
  });

  test("worker.resumed is handled via processEvent", () => {
    const since = new Date().toISOString();
    processEvent({ event: "worker.waiting", detail: { session_id: "sess-pe-r", timeout_ms: 3600000, since } });
    processEvent({ event: "worker.resumed", detail: { session_id: "sess-pe-r", outcome: "matched" } });
    expect(getWaitingSessionsMap().has("sess-pe-r")).toBe(false);
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

// ─── CTL-406: filter.wake deduplication ─────────────────────────────────────

describe("filter.wake deduplication (CTL-406)", () => {
  function wakeLinesFromLog() {
    const ym = new Date().toISOString().slice(0, 7);
    const logPath = join(tmpDir, "events", `${ym}.jsonl`);
    if (!existsSync(logPath)) return [];
    return readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          const evt = JSON.parse(l);
          return evt.attributes?.["event.name"]?.startsWith("filter.wake") ? [evt] : [];
        } catch { return []; }
      });
  }

  test("same source event ingested twice emits at most one wake per interest", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-dedup",
      detail: {
        interest_id: "pr-dedup-1",
        notify_event: "filter.wake.orch-dedup",
        interest_type: "pr_lifecycle",
        pr_numbers: [999],
        repo: "org/repo",
        base_branches: [],
        persistent: true,
      },
    });

    const sourceEvent = {
      id: "src-dedup-abc123",
      attributes: { "event.name": "github.pr.merged" },
      scope: { pr: 999 },
      body: { payload: { action: "closed", merged: true } },
    };

    processEvent(sourceEvent);
    processEvent(sourceEvent); // same event ingested again

    const wakes = wakeLinesFromLog();
    const dedupWakes = wakes.filter((w) =>
      w.body?.payload?.interest_id === "pr-dedup-1"
    );
    expect(dedupWakes).toHaveLength(1);
  });

  test("different source events each produce their own wake", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-dedup2",
      detail: {
        interest_id: "pr-dedup-2",
        notify_event: "filter.wake.orch-dedup2",
        interest_type: "pr_lifecycle",
        pr_numbers: [998],
        repo: "org/repo",
        base_branches: [],
        persistent: true,
      },
    });

    processEvent({
      id: "src-event-aaa",
      attributes: { "event.name": "github.pr.merged" },
      scope: { pr: 998 },
      body: { payload: { action: "closed", merged: true } },
    });
    processEvent({
      id: "src-event-bbb",
      attributes: { "event.name": "github.pr.merged" },
      scope: { pr: 998 },
      body: { payload: { action: "closed", merged: true } },
    });

    const wakes = wakeLinesFromLog();
    const dedupWakes = wakes.filter((w) =>
      w.body?.payload?.interest_id === "pr-dedup-2"
    );
    expect(dedupWakes).toHaveLength(2);
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

  // CTL-341: orchestrator-level pr_lifecycle interest should also pick up new PRs.
  test("orchestrator pr_lifecycle interest gets PR appended when worker on its ticket opens PR", () => {
    handleAgentCheckin({
      event: "agent.checkin",
      detail: { session_id: "sess-w-A", agent_name: "worker", ticket: "CTL-275", orchestrator: "orch-A", claimed_pr: null },
    });

    // Orchestrator-level pr_lifecycle interest registered with empty pr_numbers
    // (this is the CTL-341 bug shape — registered before any PR opened).
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-A",
      detail: {
        interest_id: "orch-A-pr-lifecycle",
        interest_type: "pr_lifecycle",
        notify_event: "filter.wake.orch-A",
        pr_numbers: [],
        repo: "org/repo",
        base_branches: [],
        persistent: true,
      },
    });

    // Ticket_lifecycle interest is what triggers tryTicketLifecycleRoute on pr_opened.
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-A",
      detail: {
        interest_id: "tl-orch-A",
        interest_type: "ticket_lifecycle",
        tickets: ["CTL-275"],
        wake_on: ["pr_opened"],
        persistent: true,
      },
    });

    tryTicketLifecycleRoute({
      event: "github.pr.opened",
      scope: { pr: 610 },
      detail: { body: "Implements CTL-275", title: "", headRef: "" },
    }, getInterests());

    const orchReg = getInterests().get("orch-A-pr-lifecycle");
    expect(orchReg).toBeDefined();
    expect(orchReg.pr_numbers).toContain(610);
  });

  test("orchestrator pr_lifecycle interest is not duplicated if PR already present", () => {
    handleAgentCheckin({
      event: "agent.checkin",
      detail: { session_id: "sess-w-B", agent_name: "worker", ticket: "CTL-275", orchestrator: "orch-B", claimed_pr: null },
    });

    handleRegister({
      event: "filter.register",
      orchestrator: "orch-B",
      detail: {
        interest_id: "orch-B-pr-lifecycle",
        interest_type: "pr_lifecycle",
        notify_event: "filter.wake.orch-B",
        pr_numbers: [620],
        repo: "org/repo",
        base_branches: [],
        persistent: true,
      },
    });

    handleRegister({
      event: "filter.register",
      orchestrator: "orch-B",
      detail: {
        interest_id: "tl-orch-B",
        interest_type: "ticket_lifecycle",
        tickets: ["CTL-275"],
        wake_on: ["pr_opened"],
        persistent: true,
      },
    });

    tryTicketLifecycleRoute({
      event: "github.pr.opened",
      scope: { pr: 620 },
      detail: { body: "Implements CTL-275", title: "", headRef: "" },
    }, getInterests());

    const orchReg = getInterests().get("orch-B-pr-lifecycle");
    expect(orchReg.pr_numbers.filter((n) => n === 620)).toHaveLength(1);
  });

  test("orchestrator pr_lifecycle interest is NOT touched when no agent on watched ticket belongs to that orchestrator", () => {
    handleAgentCheckin({
      event: "agent.checkin",
      detail: { session_id: "sess-w-X", agent_name: "worker", ticket: "CTL-275", orchestrator: "orch-X", claimed_pr: null },
    });

    handleRegister({
      event: "filter.register",
      orchestrator: "orch-Y",
      detail: {
        interest_id: "orch-Y-pr-lifecycle",
        interest_type: "pr_lifecycle",
        notify_event: "filter.wake.orch-Y",
        pr_numbers: [],
        repo: "org/repo",
        base_branches: [],
        persistent: true,
      },
    });

    handleRegister({
      event: "filter.register",
      orchestrator: "orch-X",
      detail: {
        interest_id: "tl-orch-X",
        interest_type: "ticket_lifecycle",
        tickets: ["CTL-275"],
        wake_on: ["pr_opened"],
        persistent: true,
      },
    });

    tryTicketLifecycleRoute({
      event: "github.pr.opened",
      scope: { pr: 630 },
      detail: { body: "Implements CTL-275", title: "", headRef: "" },
    }, getInterests());

    const orchYReg = getInterests().get("orch-Y-pr-lifecycle");
    expect(orchYReg.pr_numbers).toEqual([]);
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
    expect(matches[0].wakeStateKey).toBe("ci_conclusion:502");
    expect(matches[0].wakeStateValue).toBe("success");
  });

  test("tryDeterministicRoute returns wakeStateKey/wakeStateValue for check_suite failure", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-bc-fail",
      detail: {
        interest_id: "ci-watch-fail",
        notify_event: "filter.wake.ci-watch-fail",
        interest_type: "pr_lifecycle",
        pr_numbers: [503],
        repo: "org/repo",
        base_branches: [],
        persistent: true,
      },
    });
    const matches = tryDeterministicRoute({
      event: "github.check_suite.completed",
      detail: { prNumbers: [503], conclusion: "failure" },
    }, getInterests());
    expect(matches).toHaveLength(1);
    expect(matches[0].wakeStateKey).toBe("ci_conclusion:503");
    expect(matches[0].wakeStateValue).toBe("failure");
  });

  test("non-CI events have wakeStateKey null (always emit)", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-bc-push",
      detail: {
        interest_id: "ci-watch-push",
        notify_event: "filter.wake.ci-watch-push",
        interest_type: "pr_lifecycle",
        pr_numbers: [504],
        repo: "org/repo",
        base_branches: [{ pr: 504, base: "main" }],
        persistent: true,
      },
    });
    const matches = tryDeterministicRoute({
      event: "github.push",
      scope: { ref: "refs/heads/main" },
      detail: {},
    }, getInterests());
    expect(matches).toHaveLength(1);
    expect(matches[0].wakeStateKey).toBeNull();
  });
});

// ─── CTL-407: suppress redundant wakes when downstream state unchanged ────────

describe("CTL-407: suppress redundant wakes when downstream state unchanged", () => {
  function countWakesInLog(notifyEvent) {
    const ym = new Date().toISOString().slice(0, 7);
    const logPath = join(tmpDir, "events", `${ym}.jsonl`);
    if (!existsSync(logPath)) return 0;
    const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
    return lines.filter((l) => {
      try {
        const evt = JSON.parse(l);
        return evt.attributes?.["event.name"] === notifyEvent;
      } catch { return false; }
    }).length;
  }

  function makeCheckSuiteEvent(prNumber, conclusion) {
    return {
      id: `cs-${prNumber}-${conclusion}-${Math.random().toString(36).slice(2)}`,
      ts: new Date().toISOString(),
      event: "github.check_suite.completed",
      detail: { prNumbers: [prNumber], conclusion },
    };
  }

  test("3 identical check_suite.completed success events → 1 wake emitted", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-407-1",
      detail: {
        interest_id: "suppress-test-1",
        notify_event: "filter.wake.suppress-test-1",
        interest_type: "pr_lifecycle",
        pr_numbers: [601],
        repo: "org/repo",
        base_branches: [],
        persistent: true,
      },
    });

    processEvent(makeCheckSuiteEvent(601, "success"));
    processEvent(makeCheckSuiteEvent(601, "success"));
    processEvent(makeCheckSuiteEvent(601, "success"));

    expect(countWakesInLog("filter.wake.suppress-test-1")).toBe(1);
  });

  test("check_suite failure then success → 2 wakes emitted (state changed)", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-407-2",
      detail: {
        interest_id: "suppress-test-2",
        notify_event: "filter.wake.suppress-test-2",
        interest_type: "pr_lifecycle",
        pr_numbers: [602],
        repo: "org/repo",
        base_branches: [],
        persistent: true,
      },
    });

    processEvent(makeCheckSuiteEvent(602, "failure"));
    processEvent(makeCheckSuiteEvent(602, "failure"));
    processEvent(makeCheckSuiteEvent(602, "success"));

    expect(countWakesInLog("filter.wake.suppress-test-2")).toBe(2);
  });

  test("suppress_identical_wakes: false → all 3 wakes emitted", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-407-3",
      detail: {
        interest_id: "suppress-test-3",
        notify_event: "filter.wake.suppress-test-3",
        interest_type: "pr_lifecycle",
        pr_numbers: [603],
        repo: "org/repo",
        base_branches: [],
        persistent: true,
        suppress_identical_wakes: false,
      },
    });

    processEvent(makeCheckSuiteEvent(603, "success"));
    processEvent(makeCheckSuiteEvent(603, "success"));
    processEvent(makeCheckSuiteEvent(603, "success"));

    expect(countWakesInLog("filter.wake.suppress-test-3")).toBe(3);
  });

  test("suppress_identical_wakes defaults to true on pr_lifecycle interests", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-407-4",
      detail: {
        interest_id: "suppress-test-4",
        notify_event: "filter.wake.suppress-test-4",
        interest_type: "pr_lifecycle",
        pr_numbers: [604],
        repo: "org/repo",
        base_branches: [],
        persistent: true,
      },
    });
    const reg = getInterests().get("suppress-test-4");
    expect(reg.suppress_identical_wakes).toBe(true);
    expect(reg.last_wake_state).toEqual({});
  });

  test("last_wake_state updated after first emission", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-407-5",
      detail: {
        interest_id: "suppress-test-5",
        notify_event: "filter.wake.suppress-test-5",
        interest_type: "pr_lifecycle",
        pr_numbers: [605],
        repo: "org/repo",
        base_branches: [],
        persistent: true,
      },
    });

    processEvent(makeCheckSuiteEvent(605, "success"));

    const reg = getInterests().get("suppress-test-5");
    expect(reg.last_wake_state["ci_conclusion:605"]).toBe("success");
  });
});

// ─── Canonical-format filter events (CTL-336) ────────────────────────────────

describe("canonical-format filter events (CTL-336)", () => {
  test("handleRegister accepts canonical filter.register event", () => {
    handleRegister({
      ts: "2026-05-12T15:00:00Z",
      attributes: {
        "event.name": "filter.register",
        "catalyst.orchestrator.id": "orch-canon-1",
      },
      body: {
        payload: {
          interest_id: "canon-watcher-1",
          notify_event: "filter.wake.canon-watcher-1",
          interest_type: "pr_lifecycle",
          pr_numbers: [123],
          repo: "org/repo",
          base_branches: [],
          persistent: true,
        },
      },
    });
    const reg = getInterests().get("canon-watcher-1");
    expect(reg).toBeDefined();
    expect(reg.interest_type).toBe("pr_lifecycle");
    expect(reg.pr_numbers).toEqual([123]);
    expect(reg.orchestrator).toBe("orch-canon-1");
    expect(reg.persistent).toBe(true);
  });

  test("handleDeregister accepts canonical filter.deregister event", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-canon-2",
      detail: {
        interest_id: "canon-watcher-2",
        notify_event: "filter.wake.canon-watcher-2",
        persistent: true,
      },
    });
    expect(getInterests().has("canon-watcher-2")).toBe(true);

    handleDeregister({
      ts: "2026-05-12T15:01:00Z",
      attributes: {
        "event.name": "filter.deregister",
        "catalyst.orchestrator.id": "orch-canon-2",
      },
      body: { payload: { interest_id: "canon-watcher-2" } },
    });
    expect(getInterests().has("canon-watcher-2")).toBe(false);
  });

  test("processEvent dispatches canonical filter.register", () => {
    processEvent({
      ts: "2026-05-12T15:02:00Z",
      attributes: {
        "event.name": "filter.register",
        "catalyst.orchestrator.id": "orch-canon-3",
      },
      body: {
        payload: {
          interest_id: "canon-watcher-3",
          notify_event: "filter.wake.canon-watcher-3",
          interest_type: "ticket_lifecycle",
          tickets: ["CTL-336"],
          persistent: true,
        },
      },
    });
    expect(getInterests().has("canon-watcher-3")).toBe(true);
  });

  test("processEvent dispatches canonical filter.deregister", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-canon-4",
      detail: {
        interest_id: "canon-watcher-4",
        notify_event: "filter.wake.canon-watcher-4",
        persistent: true,
      },
    });
    expect(getInterests().has("canon-watcher-4")).toBe(true);

    processEvent({
      ts: "2026-05-12T15:03:00Z",
      attributes: {
        "event.name": "filter.deregister",
        "catalyst.orchestrator.id": "orch-canon-4",
      },
      body: { payload: { interest_id: "canon-watcher-4" } },
    });
    expect(getInterests().has("canon-watcher-4")).toBe(false);
  });

  test("handleRegister falls back to orchestrator from attributes when event.orchestrator is absent", () => {
    handleRegister({
      attributes: {
        "event.name": "filter.register",
        "catalyst.orchestrator.id": "orch-canon-5",
      },
      body: {
        payload: {
          interest_id: "canon-watcher-5",
          notify_event: "filter.wake.canon-watcher-5",
          persistent: true,
        },
      },
    });
    const reg = getInterests().get("canon-watcher-5");
    expect(reg).toBeDefined();
    expect(reg.orchestrator).toBe("orch-canon-5");
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

// ─── shouldSkipEvent — broker self-emission guards (CTL-346) ─────────────────

describe("shouldSkipEvent — broker self-emission guards (CTL-346)", () => {
  test("skips canonical filter.wake.* event (broker self-emission)", () => {
    expect(shouldSkipEvent({
      attributes: { "event.name": "filter.wake.orch-1" },
      resource: { "service.name": "catalyst.broker" },
      body: { payload: {} },
    })).toBe(true);
  });

  test("skips canonical broker.daemon.startup event", () => {
    expect(shouldSkipEvent({
      attributes: { "event.name": "broker.daemon.startup" },
      resource: { "service.name": "catalyst.broker" },
    })).toBe(true);
  });

  // CTL-351: broker.daemon.shutdown follows the same self-emission pattern.
  test("skips canonical broker.daemon.shutdown event", () => {
    expect(shouldSkipEvent({
      attributes: { "event.name": "broker.daemon.shutdown" },
      resource: { "service.name": "catalyst.broker" },
    })).toBe(true);
  });

  test("skips any event with resource.service.name == catalyst.broker", () => {
    // Defense-in-depth: future broker.* event names still get skipped.
    expect(shouldSkipEvent({
      attributes: { "event.name": "broker.future.metric" },
      resource: { "service.name": "catalyst.broker" },
    })).toBe(true);
  });

  test("does not skip github.* events from other services", () => {
    expect(shouldSkipEvent({
      attributes: { "event.name": "github.pr.merged" },
      resource: { "service.name": "catalyst.github-webhook" },
    })).toBe(false);
  });

  test("does not skip canonical linear.* events from other services", () => {
    expect(shouldSkipEvent({
      attributes: { "event.name": "linear.issue.state_changed" },
      resource: { "service.name": "catalyst.linear-webhook" },
    })).toBe(false);
  });

  test("BROKER_INGEST_OWN_EMISSIONS=1 opts out — broker.daemon flows through", () => {
    const prev = process.env.BROKER_INGEST_OWN_EMISSIONS;
    process.env.BROKER_INGEST_OWN_EMISSIONS = "1";
    try {
      // filter.* still skipped (original semantics for control-plane events)
      expect(shouldSkipEvent({
        attributes: { "event.name": "filter.wake.orch-1" },
        resource: { "service.name": "catalyst.broker" },
      })).toBe(true);
      // broker.daemon.* now passes through for debugging visibility
      expect(shouldSkipEvent({
        attributes: { "event.name": "broker.daemon.startup" },
        resource: { "service.name": "catalyst.broker" },
      })).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.BROKER_INGEST_OWN_EMISSIONS;
      else process.env.BROKER_INGEST_OWN_EMISSIONS = prev;
    }
  });
});

// ─── Broker state file (CTL-343 — API key health) ───────────────────────────

describe("buildBrokerState (CTL-343)", () => {
  test("has keyHealth.groq with present/source/prefix/probeStatus/gateway shape", () => {
    const state = buildBrokerState();
    expect(state.pid).toBe(process.pid);
    expect(typeof state.startedAt).toBe("string");
    expect(state.keyHealth).toBeDefined();
    expect(state.keyHealth.groq).toBeDefined();
    expect("present" in state.keyHealth.groq).toBe(true);
    expect("source" in state.keyHealth.groq).toBe(true);
    expect("prefix" in state.keyHealth.groq).toBe(true);
    expect("probeStatus" in state.keyHealth.groq).toBe(true);
    expect("probeError" in state.keyHealth.groq).toBe(true);
    expect("probeAt" in state.keyHealth.groq).toBe(true);
    expect(state.gateway).toBeDefined();
    expect(typeof state.gateway.enabled).toBe("boolean");
  });

  test("initial state has probeStatus 'pending' or 'missing' (no probe yet)", () => {
    const state = buildBrokerState();
    expect(["pending", "missing"]).toContain(state.keyHealth.groq.probeStatus);
    expect(state.keyHealth.groq.probeAt).toBeNull();
  });

  test("with probe result, surfaces probe status + probeAt timestamp", () => {
    const state = buildBrokerState({ probe: { status: "ok", modelCount: 41 } });
    expect(state.keyHealth.groq.probeStatus).toBe("ok");
    expect(state.keyHealth.groq.modelCount).toBe(41);
    expect(state.keyHealth.groq.probeAt).not.toBeNull();
  });

  test("with probe failure, surfaces error message", () => {
    const state = buildBrokerState({
      probe: { status: "unauthorized", error: "HTTP 401: invalid_api_key" },
    });
    expect(state.keyHealth.groq.probeStatus).toBe("unauthorized");
    expect(state.keyHealth.groq.probeError).toContain("401");
  });
});

describe("writeBrokerStateFile (CTL-343)", () => {
  test("writes valid JSON to a custom path", () => {
    const target = join(tmpDir, "broker.state.json");
    const state = buildBrokerState();
    writeBrokerStateFile(state, { path: target });
    expect(existsSync(target)).toBe(true);
    const parsed = JSON.parse(readFileSync(target, "utf8"));
    expect(parsed.pid).toBe(process.pid);
    expect(parsed.keyHealth.groq).toBeDefined();
    rmFile(target, { force: true });
  });

  test("overwrites existing file (atomic rename)", () => {
    const target = join(tmpDir, "broker.state.json");
    writeBrokerStateFile(buildBrokerState(), { path: target });
    writeBrokerStateFile(
      buildBrokerState({ probe: { status: "ok", modelCount: 7 } }),
      { path: target },
    );
    const parsed = JSON.parse(readFileSync(target, "utf8"));
    expect(parsed.keyHealth.groq.probeStatus).toBe("ok");
    expect(parsed.keyHealth.groq.modelCount).toBe(7);
    rmFile(target, { force: true });
  });
});

// ─── event.id read-site fallback (CTL-344) ───────────────────────────────────

describe("CTL-344 read-site event.id fallback", () => {
  test("tryDeterministicRoute uses real event.id when present", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-id-1",
      detail: {
        interest_id: "id-1",
        notify_event: "filter.wake.id-1",
        interest_type: "pr_lifecycle",
        pr_numbers: [777],
        repo: "org/repo",
        base_branches: [{ pr: 777, base: "main" }],
        persistent: true,
        session_id: "sess-id-1",
      },
    });
    const realId = "11111111-2222-4333-8444-555555555555";
    const matches = tryDeterministicRoute({
      id: realId,
      event: "github.pr.merged",
      scope: { pr: 777 },
      detail: { mergeCommitSha: "deadbeef", merged: true },
    }, getInterests());
    expect(matches).toHaveLength(1);
    expect(matches[0].sourceEventId).toBe(realId);
  });

  test("tryDeterministicRoute synthesizes id when event.id is absent (legacy event)", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-id-2",
      detail: {
        interest_id: "id-2",
        notify_event: "filter.wake.id-2",
        interest_type: "pr_lifecycle",
        pr_numbers: [778],
        repo: "org/repo",
        base_branches: [{ pr: 778, base: "main" }],
        persistent: true,
        session_id: "sess-id-2",
      },
    });
    const matches = tryDeterministicRoute({
      ts: "2026-05-12T00:00:00Z",
      event: "github.pr.merged",
      scope: { pr: 778 },
      attributes: { "event.name": "github.pr.merged" },
      detail: { mergeCommitSha: "deadbeef", merged: true },
    }, getInterests());
    expect(matches).toHaveLength(1);
    // synth fallback is a 32-char lowercase hex, not null and not the trivial empty string
    expect(matches[0].sourceEventId).toBeString();
    expect(matches[0].sourceEventId.length).toBe(32);
    expect(/^[0-9a-f]{32}$/.test(matches[0].sourceEventId)).toBe(true);
  });

  test("tryTicketLifecycleRoute synthesizes id when event.id is absent (legacy event)", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-id-3",
      detail: {
        interest_id: "id-3",
        notify_event: "filter.wake.id-3",
        interest_type: "ticket_lifecycle",
        tickets: ["CTL-999"],
        persistent: true,
        session_id: "sess-id-3",
      },
    });
    const matches = tryTicketLifecycleRoute({
      ts: "2026-05-12T00:00:00Z",
      event: "linear.issue.state_changed",
      attributes: {
        "event.name": "linear.issue.state_changed",
        "linear.issue.identifier": "CTL-999",
      },
      detail: { ticket: "CTL-999", toState: "Done" },
    }, getInterests());
    expect(matches.length).toBeGreaterThan(0);
    const m = matches[0];
    expect(m.sourceEventId).toBeString();
    expect(m.sourceEventId.length).toBe(32);
    expect(/^[0-9a-f]{32}$/.test(m.sourceEventId)).toBe(true);
  });
});

// ─── classifyMatches prose-routing suppression gate (CTL-340) ────────────────

describe("CTL-340 classifyMatches", () => {
  function registerProseInterest(id, { persistent = true, orchestrator = null } = {}) {
    handleRegister({
      event: "filter.register",
      orchestrator,
      detail: {
        interest_id: id,
        notify_event: `filter.wake.${id}`,
        prompt: "match anything relevant",
        context: {},
        persistent,
        session_id: `sess-${id}`,
      },
    });
  }

  // CTL-350 Phase 1: ensure tests cannot write to ~/catalyst/broker-interests.json
  test("prose-* registrations do not write to production interests file", () => {
    const homeDir = process.env.HOME ?? "/tmp";
    const liveInterestsPath = join(homeDir, "catalyst", "broker-interests.json");
    const before = existsSync(liveInterestsPath) ? readFileSync(liveInterestsPath, "utf8") : "";
    registerProseInterest("prose-canary");
    const after = existsSync(liveInterestsPath) ? readFileSync(liveInterestsPath, "utf8") : "";
    expect(after).toBe(before);
  });

  test("loadPersistedInterests skips entries with session_id matching /^sess-prose-\\d+$/", () => {
    const tmpFile = join(tmpDir, "broker-interests.json");
    writeFileSync(
      tmpFile,
      JSON.stringify([
        ["prose-99", {
          notify_event: "filter.wake.prose-99",
          prompt: "x",
          session_id: "sess-prose-99",
          persistent: true,
          context: {},
          orchestrator: null,
          interest_type: null,
          pr_numbers: null,
          repo: null,
          base_branches: null,
          tickets: null,
          wake_on: null,
        }],
        ["real-orch", {
          notify_event: "filter.wake.real-orch",
          prompt: "y",
          session_id: null,
          persistent: true,
          context: {},
          orchestrator: "real-orch",
          interest_type: null,
          pr_numbers: null,
          repo: null,
          base_branches: null,
          tickets: null,
          wake_on: null,
        }],
      ])
    );
    clearInterests();
    loadPersistedInterests();
    expect(getInterests().has("prose-99")).toBe(false);
    expect(getInterests().has("real-orch")).toBe(true);
  });

  test("emits wake for canonical events without .id (uses synthesizeEventId)", () => {
    registerProseInterest("prose-1");
    const events = [
      {
        ts: "2026-05-12T20:14:00Z",
        traceId: "1d0338f8f2ec2acf633e0d95618dee70",
        spanId: "d30d48f47d343921",
        resource: { "service.name": "catalyst.session" },
        attributes: { "event.name": "session.heartbeat" },
        body: { payload: null },
      },
      {
        ts: "2026-05-12T20:14:01Z",
        traceId: "2d0338f8f2ec2acf633e0d95618dee70",
        spanId: "e30d48f47d343921",
        resource: { "service.name": "catalyst.broker" },
        attributes: { "event.name": "broker.event" },
        body: { payload: null },
      },
    ];
    const matches = [
      { interest_id: "prose-1", reason: "both events relevant", event_indices: [1, 2] },
    ];
    const { wakes, oneShotsToDelete } = classifyMatches(events, matches, getInterests());

    expect(wakes).toHaveLength(1);
    const wake = wakes[0];
    expect(wake.event).toBe("filter.wake.prose-1");
    expect(wake.detail.source_event_ids).toHaveLength(2);
    for (const id of wake.detail.source_event_ids) {
      expect(/^[0-9a-f]{32}$/.test(id)).toBe(true);
    }
    expect(wake.detail.matched_indices_count).toBe(2);
    expect(wake.detail.interest_id).toBe("prose-1");
    expect(oneShotsToDelete).toEqual([]);
  });

  test("suppresses wake when match.event_indices is empty (regression guard for original suppression intent)", () => {
    registerProseInterest("prose-2");
    const events = [
      { id: "evt-1", ts: "2026-05-12T20:14:00Z", event: "foo" },
    ];
    const matches = [
      { interest_id: "prose-2", reason: "groq invented match", event_indices: [] },
    ];
    const { wakes } = classifyMatches(events, matches, getInterests());
    expect(wakes).toHaveLength(0);
  });

  test("legacy events with real .id still resolve to that .id (regression guard)", () => {
    registerProseInterest("prose-3");
    const events = [
      { id: "real-id-1", ts: "2026-05-12T20:14:00Z", event: "foo" },
      { id: "real-id-2", ts: "2026-05-12T20:14:01Z", event: "bar" },
    ];
    const matches = [
      { interest_id: "prose-3", reason: "both", event_indices: [1, 2] },
    ];
    const { wakes } = classifyMatches(events, matches, getInterests());
    expect(wakes).toHaveLength(1);
    expect(wakes[0].detail.source_event_ids).toEqual(["real-id-1", "real-id-2"]);
    expect(wakes[0].detail.matched_indices_count).toBe(2);
  });

  test("indices pointing past batch end emit wake with filtered ids + accurate matched_indices_count", () => {
    registerProseInterest("prose-4");
    const events = [
      { id: "a", ts: "2026-05-12T20:14:00Z", event: "foo" },
      { id: "b", ts: "2026-05-12T20:14:01Z", event: "bar" },
    ];
    const matches = [
      { interest_id: "prose-4", reason: "groq returned invalid index", event_indices: [1, 2, 99] },
    ];
    const { wakes } = classifyMatches(events, matches, getInterests());
    expect(wakes).toHaveLength(1);
    expect(wakes[0].detail.source_event_ids).toEqual(["a", "b"]);
    expect(wakes[0].detail.matched_indices_count).toBe(3);
  });

  test("skips matches with unknown interest_id", () => {
    const events = [{ id: "x", ts: "2026-05-12T20:14:00Z", event: "foo" }];
    const matches = [
      { interest_id: "does-not-exist", reason: "...", event_indices: [1] },
    ];
    const { wakes } = classifyMatches(events, matches, getInterests());
    expect(wakes).toHaveLength(0);
  });

  test("non-persistent (one-shot) interest is reported in oneShotsToDelete", () => {
    registerProseInterest("prose-5", { persistent: false });
    const events = [{ id: "x", ts: "2026-05-12T20:14:00Z", event: "foo" }];
    const matches = [
      { interest_id: "prose-5", reason: "match", event_indices: [1] },
    ];
    const { wakes, oneShotsToDelete } = classifyMatches(events, matches, getInterests());
    expect(wakes).toHaveLength(1);
    expect(oneShotsToDelete).toEqual(["prose-5"]);
  });

  test("handles non-array matches gracefully (returns empty result)", () => {
    registerProseInterest("prose-6");
    const events = [{ id: "x", ts: "2026-05-12T20:14:00Z", event: "foo" }];
    const { wakes, oneShotsToDelete } = classifyMatches(events, null, getInterests());
    expect(wakes).toHaveLength(0);
    expect(oneShotsToDelete).toEqual([]);
  });

  test("orchestrator falls back to interest_id when reg.orchestrator is null", () => {
    registerProseInterest("prose-7", { orchestrator: null });
    const events = [{ id: "x", ts: "2026-05-12T20:14:00Z", event: "foo" }];
    const matches = [
      { interest_id: "prose-7", reason: "match", event_indices: [1] },
    ];
    const { wakes } = classifyMatches(events, matches, getInterests());
    expect(wakes[0].orchestrator).toBe("prose-7");
  });
});

// ─── CTL-350 Phase 2: source_events inlining ────────────────────────────────

describe("CTL-350 source_events inlining", () => {
  function registerProseInterest(id, { persistent = true, orchestrator = null } = {}) {
    handleRegister({
      event: "filter.register",
      orchestrator,
      detail: {
        interest_id: id,
        notify_event: `filter.wake.${id}`,
        prompt: "match anything relevant",
        context: {},
        persistent,
        session_id: `sess-${id}`,
      },
    });
  }

  test("summarizeEvent extracts compact fields with lookup_jq", () => {
    const event = {
      id: "11111111-1111-1111-1111-111111111111",
      ts: "2026-05-12T21:08:40.000Z",
      attributes: {
        "event.name": "linear.issue.state_changed",
        "linear.issue.identifier": "ADV-87",
      },
      body: {
        message: "Ticket marked Done",
        payload: { state: "Done", stateType: "completed" },
      },
    };
    const s = summarizeEvent(event);
    expect(s.id).toBe(event.id);
    expect(s.name).toBe("linear.issue.state_changed");
    expect(s.ts).toBe(event.ts);
    expect(s.ticket).toBe("ADV-87");
    expect(s.message).toBe("Ticket marked Done");
    expect(s.payload_excerpt).toEqual({ state: "Done", stateType: "completed" });
    expect(s.lookup_jq).toContain("2026-05.jsonl");
    expect(s.lookup_jq).toContain(event.id);
  });

  test("summarizeEvent synthesizes id and handles legacy event shapes", () => {
    const event = {
      ts: "2026-05-12T21:08:40Z",
      event: "github.pr.merged",
      scope: { pr: 42 },
      detail: { merged: true, mergeCommitSha: "deadbeef" },
    };
    const s = summarizeEvent(event);
    expect(s.id).toBeString();
    expect(s.id.length).toBe(32);
    expect(s.name).toBe("github.pr.merged");
    expect(s.payload_excerpt.merged).toBe(true);
    expect(s.lookup_jq).toContain(s.id);
  });

  test("summarizeEvent truncates long message bodies to 200 chars", () => {
    const event = {
      id: "evt-long",
      ts: "2026-05-12T21:08:40Z",
      attributes: { "event.name": "github.pr_review_comment.created" },
      body: { message: "x".repeat(500), payload: {} },
    };
    const s = summarizeEvent(event);
    expect(s.message.length).toBe(200);
  });

  test("ticket_lifecycle wake includes sourceEvent with ticket+state", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-x",
      detail: {
        interest_id: "watcher-x",
        notify_event: "filter.wake.watcher-x",
        interest_type: "ticket_lifecycle",
        tickets: ["ADV-87"],
        wake_on: ["status_done"],
        persistent: true,
      },
    });
    const event = {
      id: "uuid-1",
      ts: "2026-05-12T21:08:40Z",
      event: "linear.issue.state_changed",
      detail: { state: "Done" },
      attributes: { "linear.issue.identifier": "ADV-87" },
    };
    const matches = tryTicketLifecycleRoute(event, getInterests());
    expect(matches[0].sourceEvent).toBeDefined();
    expect(matches[0].sourceEvent.id).toBe("uuid-1");
    expect(matches[0].sourceEvent.ticket).toBe("ADV-87");
    expect(matches[0].sourceEvent.payload_excerpt.state).toBe("Done");
  });

  test("pr_lifecycle deterministic route attaches sourceEvent to matches", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-pr",
      detail: {
        interest_id: "pr-watcher",
        notify_event: "filter.wake.pr-watcher",
        interest_type: "pr_lifecycle",
        pr_numbers: [123],
        repo: "owner/repo",
        base_branches: [{ pr: 123, base: "main" }],
        persistent: true,
      },
    });
    const event = {
      id: "uuid-pr",
      ts: "2026-05-12T21:08:40Z",
      event: "github.pr.merged",
      scope: { pr: 123 },
      attributes: { "event.name": "github.pr.merged", "vcs.pr.number": 123 },
      detail: { mergeCommitSha: "deadbeef", merged: true },
    };
    const matches = tryDeterministicRoute(event, getInterests());
    expect(matches[0].sourceEvent).toBeDefined();
    expect(matches[0].sourceEvent.id).toBe("uuid-pr");
    expect(matches[0].sourceEvent.name).toBe("github.pr.merged");
    expect(matches[0].sourceEvent.pr).toBe(123);
  });

  test("classifyMatches builds source_events parallel to source_event_ids", () => {
    registerProseInterest("prose-se");
    const events = [
      {
        id: "uuid-a",
        ts: "2026-05-12T21:08:40Z",
        attributes: {
          "event.name": "linear.issue.state_changed",
          "linear.issue.identifier": "ADV-87",
        },
        body: { payload: { state: "Done" } },
      },
    ];
    const matches = [
      { interest_id: "prose-se", reason: "ticket done", event_indices: [1] },
    ];
    const { wakes } = classifyMatches(events, matches, getInterests());
    expect(wakes[0].detail.source_events).toHaveLength(1);
    expect(wakes[0].detail.source_events[0].id).toBe("uuid-a");
    expect(wakes[0].detail.source_events[0].ticket).toBe("ADV-87");
    expect(wakes[0].detail.source_event_ids).toEqual(["uuid-a"]);
  });

  test("classifyMatches handles indices past batch end without source_events leaks", () => {
    registerProseInterest("prose-se2");
    const events = [
      { id: "uuid-a", ts: "2026-05-12T21:08:40Z", attributes: { "event.name": "foo" }, body: { payload: {} } },
    ];
    const matches = [
      { interest_id: "prose-se2", reason: "match", event_indices: [1, 99] },
    ];
    const { wakes } = classifyMatches(events, matches, getInterests());
    expect(wakes[0].detail.source_events).toHaveLength(1);
    expect(wakes[0].detail.source_events[0].id).toBe("uuid-a");
    expect(wakes[0].detail.source_event_ids).toEqual(["uuid-a"]);
    expect(wakes[0].detail.matched_indices_count).toBe(2);
  });
});

// ─── CTL-352 saveInterests guards ───────────────────────────────────────────

describe("CTL-352 saveInterests guards", () => {
  const REAL_REG = {
    notify_event: "filter.wake.real-1",
    prompt: "",
    context: null,
    orchestrator: "real-1",
    session_id: null,
    persistent: true,
    interest_type: null,
    pr_numbers: null,
    repo: null,
    base_branches: null,
    tickets: null,
    wake_on: null,
  };

  const PROSE_REG = {
    notify_event: "filter.wake.prose-x",
    prompt: "match anything",
    context: {},
    orchestrator: null,
    session_id: "sess-prose-77",
    persistent: true,
    interest_type: null,
    pr_numbers: null,
    repo: null,
    base_branches: null,
    tickets: null,
    wake_on: null,
  };

  afterEach(() => {
    delete process.env.CATALYST_BROKER_ALLOW_EMPTY_SAVE;
  });

  test("prose-* rows are dropped at save (mirrors load guard)", async () => {
    const { saveInterests } = await import("./index.mjs");
    getInterests().set("real-1", REAL_REG);
    getInterests().set("prose-x", PROSE_REG);
    saveInterests();
    const file = join(tmpDir, "broker-interests.json");
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    expect(parsed.map(([id]) => id)).toEqual(["real-1"]);
  });

  test("refuses to write empty array without escape hatch — on-disk file preserved", async () => {
    const { saveInterests } = await import("./index.mjs");
    const file = join(tmpDir, "broker-interests.json");
    writeFileSync(file, JSON.stringify([["real-1", REAL_REG]], null, 2));
    const before = readFileSync(file, "utf8");
    clearInterests();
    saveInterests();
    const after = readFileSync(file, "utf8");
    expect(after).toBe(before);
  });

  test("with CATALYST_BROKER_ALLOW_EMPTY_SAVE=1 the escape hatch permits empty write", async () => {
    const { saveInterests } = await import("./index.mjs");
    const file = join(tmpDir, "broker-interests.json");
    writeFileSync(file, JSON.stringify([["real-1", REAL_REG]], null, 2));
    clearInterests();
    process.env.CATALYST_BROKER_ALLOW_EMPTY_SAVE = "1";
    saveInterests();
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    expect(parsed).toEqual([]);
  });

  test("when all in-memory rows are prose-*, save is still treated as empty and refused", async () => {
    const { saveInterests } = await import("./index.mjs");
    const file = join(tmpDir, "broker-interests.json");
    writeFileSync(file, JSON.stringify([["real-1", REAL_REG]], null, 2));
    const before = readFileSync(file, "utf8");
    clearInterests();
    getInterests().set("prose-only", PROSE_REG);
    saveInterests();
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("normal save leaves no .tmp file behind (atomic rename)", async () => {
    const { saveInterests } = await import("./index.mjs");
    getInterests().set("real-1", REAL_REG);
    saveInterests();
    const tmpFile = join(tmpDir, "broker-interests.json.tmp");
    expect(existsSync(tmpFile)).toBe(false);
  });
});

// ─── CTL-352 broker state + degraded event ───────────────────────────────────

describe("CTL-352 broker state + degraded event", () => {
  const STATE_FILE = () => join(tmpDir, "broker.state.json");

  beforeEach(async () => {
    const { __resetBrokerLivenessForTest } = await import("./index.mjs");
    __resetBrokerLivenessForTest();
  });

  afterEach(async () => {
    const { __resetBrokerLivenessForTest } = await import("./index.mjs");
    __resetBrokerLivenessForTest();
  });

  test("buildBrokerState includes interestCount, lastWakeAt, lastRegisterAt", async () => {
    const { buildBrokerState, __setBrokerStartedAtForTest } = await import("./index.mjs");
    __setBrokerStartedAtForTest(new Date().toISOString());
    const state = buildBrokerState();
    expect(state).toHaveProperty("interestCount");
    expect(state).toHaveProperty("lastWakeAt");
    expect(state).toHaveProperty("lastRegisterAt");
    expect(state.interestCount).toBe(0);
    expect(state.lastWakeAt).toBeNull();
    expect(state.lastRegisterAt).toBeNull();
  });

  test("handleRegister updates lastRegisterAt and persists state file", async () => {
    const { handleRegister, buildBrokerState } = await import("./index.mjs");
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-state-1",
      detail: { interest_id: "state-1", notify_event: "filter.wake.state-1", prompt: "p" },
    });
    const state = buildBrokerState();
    expect(state.interestCount).toBe(1);
    expect(state.lastRegisterAt).not.toBeNull();
    expect(typeof state.lastRegisterAt).toBe("string");

    expect(existsSync(STATE_FILE())).toBe(true);
    const parsed = JSON.parse(readFileSync(STATE_FILE(), "utf8"));
    expect(parsed.interestCount).toBe(1);
    expect(parsed.lastRegisterAt).toBe(state.lastRegisterAt);
  });

  test("a wake firing updates lastWakeAt", async () => {
    const { handleRegister, processEvent, buildBrokerState } = await import("./index.mjs");
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-wake-1",
      detail: {
        interest_id: "wake-1",
        notify_event: "filter.wake.wake-1",
        interest_type: "pr_lifecycle",
        pr_numbers: [999],
        repo: "org/repo",
        base_branches: [{ pr: 999, base: "main" }],
        persistent: true,
        session_id: "sess-wake-1",
      },
    });
    const before = buildBrokerState().lastWakeAt;
    expect(before).toBeNull();

    processEvent({
      id: "deadbeefdeadbeefdeadbeefdeadbeef",
      ts: new Date().toISOString(),
      event: "github.pr.merged",
      attributes: { "event.name": "github.pr.merged" },
      scope: { pr: 999 },
      detail: { mergeCommitSha: "feedface", merged: true },
    });
    const after = buildBrokerState().lastWakeAt;
    expect(after).not.toBeNull();
    expect(typeof after).toBe("string");
  });

  test("broker.daemon.degraded emitted once when interests empty and uptime > 5 min", async () => {
    const {
      runWatchdogTick,
      __setBrokerStartedAtForTest,
      getInterests,
    } = await import("./index.mjs");
    clearInterests();
    const sixMinAgo = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    __setBrokerStartedAtForTest(sixMinAgo);

    runWatchdogTick();
    runWatchdogTick();
    runWatchdogTick();

    // Read the month event log; assert exactly one degraded event.
    const ym = new Date().toISOString().slice(0, 7);
    const logPath = join(tmpDir, "events", `${ym}.jsonl`);
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
    const degradedLines = lines.filter((l) => {
      try {
        const evt = JSON.parse(l);
        return evt.attributes?.["event.name"] === "broker.daemon.degraded";
      } catch { return false; }
    });
    expect(degradedLines).toHaveLength(1);
    const evt = JSON.parse(degradedLines[0]);
    expect(evt.severityText).toBe("WARN");
    expect(evt.body.payload.reason).toBe("no registered interests");
    expect(typeof evt.body.payload.uptimeMs).toBe("number");
    expect(getInterests().size).toBe(0);
  });

  test("degraded NOT emitted within the 5-minute startup grace", async () => {
    const { runWatchdogTick, __setBrokerStartedAtForTest } = await import("./index.mjs");
    clearInterests();
    const oneMinAgo = new Date(Date.now() - 60 * 1000).toISOString();
    __setBrokerStartedAtForTest(oneMinAgo);

    runWatchdogTick();

    const ym = new Date().toISOString().slice(0, 7);
    const logPath = join(tmpDir, "events", `${ym}.jsonl`);
    if (!existsSync(logPath)) return; // no events at all — vacuously fine
    const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
    const degradedLines = lines.filter((l) => {
      try { return JSON.parse(l).attributes?.["event.name"] === "broker.daemon.degraded"; }
      catch { return false; }
    });
    expect(degradedLines).toHaveLength(0);
  });

  test("degraded re-arms after interests come back and go empty again", async () => {
    const {
      runWatchdogTick,
      __setBrokerStartedAtForTest,
      handleRegister,
      handleDeregister,
    } = await import("./index.mjs");
    clearInterests();
    const sixMinAgo = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    __setBrokerStartedAtForTest(sixMinAgo);

    runWatchdogTick(); // emits first degraded

    handleRegister({
      event: "filter.register",
      orchestrator: "orch-rearm-1",
      detail: { interest_id: "rearm-1", notify_event: "filter.wake.rearm-1", prompt: "p" },
    });
    handleDeregister({
      event: "filter.deregister",
      orchestrator: "orch-rearm-1",
      detail: { interest_id: "rearm-1" },
    });

    runWatchdogTick(); // should re-emit (cleared on non-empty, then armed again on empty)

    const ym = new Date().toISOString().slice(0, 7);
    const logPath = join(tmpDir, "events", `${ym}.jsonl`);
    const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
    const degradedLines = lines.filter((l) => {
      try { return JSON.parse(l).attributes?.["event.name"] === "broker.daemon.degraded"; }
      catch { return false; }
    });
    expect(degradedLines).toHaveLength(2);
  });
});

// ─── CTL-357 comms_lifecycle interest type ───────────────────────────────────

describe("CTL-357 comms_lifecycle registration", () => {
  test("handleRegister stores comms_lifecycle interest fields (legacy envelope)", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-comms-1",
      detail: {
        interest_id: "orch-comms-1-comms",
        notify_event: "filter.wake.orch-comms-1",
        interest_type: "comms_lifecycle",
        channel: "orch-orch-comms-1",
        subscriber_kind: "orchestrator",
        owned_workers: ["CTL-100", "CTL-101"],
        types_of_interest: ["attention", "done"],
        persistent: true,
      },
    });
    const reg = getInterests().get("orch-comms-1-comms");
    expect(reg).toBeDefined();
    expect(reg.interest_type).toBe("comms_lifecycle");
    expect(reg.channel).toBe("orch-orch-comms-1");
    expect(reg.subscriber_kind).toBe("orchestrator");
    expect(reg.owned_workers).toEqual(["CTL-100", "CTL-101"]);
    expect(reg.types_of_interest).toEqual(["attention", "done"]);
    expect(reg.persistent).toBe(true);
    // pr_lifecycle/ticket_lifecycle fields stay null
    expect(reg.pr_numbers).toBeNull();
    expect(reg.tickets).toBeNull();
  });

  test("handleRegister stores comms_lifecycle interest fields (canonical envelope)", () => {
    handleRegister({
      attributes: {
        "event.name": "filter.register",
        "catalyst.orchestrator.id": "orch-comms-canon",
      },
      body: {
        payload: {
          interest_id: "worker-CTL-200",
          notify_event: "filter.wake.worker-CTL-200",
          interest_type: "comms_lifecycle",
          channel: "orch-orch-comms-canon",
          subscriber_kind: "worker",
          subscriber_ticket: "CTL-200",
          persistent: true,
        },
      },
    });
    const reg = getInterests().get("worker-CTL-200");
    expect(reg).toBeDefined();
    expect(reg.interest_type).toBe("comms_lifecycle");
    expect(reg.subscriber_kind).toBe("worker");
    expect(reg.subscriber_ticket).toBe("CTL-200");
    expect(reg.channel).toBe("orch-orch-comms-canon");
  });

  test("comms_lifecycle interest is excluded from Groq prompt", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-comms-2",
      detail: {
        interest_id: "comms-only",
        interest_type: "comms_lifecycle",
        channel: "orch-orch-comms-2",
        subscriber_kind: "orchestrator",
        owned_workers: ["CTL-300"],
        persistent: true,
      },
    });
    // No prose interest exists, so the prompt should be null entirely.
    const prompt = buildGroqPrompt([{ event: "comms.message.posted" }]);
    expect(prompt).toBeNull();
  });
});

describe("CTL-357 tryDeterministicRoute — comms_lifecycle (orchestrator subscriber)", () => {
  beforeEach(() => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-comms-orch",
      detail: {
        interest_id: "orch-comms-orch-comms",
        notify_event: "filter.wake.orch-comms-orch",
        interest_type: "comms_lifecycle",
        channel: "orch-orch-comms-orch",
        subscriber_kind: "orchestrator",
        owned_workers: ["CTL-100", "CTL-101"],
        types_of_interest: ["attention", "done"],
        persistent: true,
      },
    });
  });

  const buildCommsEvent = ({ sender, channel, type, to = "all", body = "test" }) => ({
    attributes: {
      "event.name": "comms.message.posted",
      "catalyst.worker.ticket": sender,
    },
    body: {
      payload: { channel, type, msgId: "msg-test", to, body },
    },
  });

  test("fires when an owned worker posts attention on the watched channel", () => {
    const matches = tryDeterministicRoute(
      buildCommsEvent({ sender: "CTL-100", channel: "orch-orch-comms-orch", type: "attention", body: "CI blocked" }),
      getInterests(),
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].interestId).toBe("orch-comms-orch-comms");
    expect(matches[0].reason).toContain("CTL-100");
    expect(matches[0].reason).toContain("attention");
  });

  test("fires when an owned worker posts done on the watched channel", () => {
    const matches = tryDeterministicRoute(
      buildCommsEvent({ sender: "CTL-101", channel: "orch-orch-comms-orch", type: "done" }),
      getInterests(),
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].reason).toContain("CTL-101");
    expect(matches[0].reason).toContain("done");
  });

  test("does NOT fire when an owned worker posts info (not in types_of_interest)", () => {
    const matches = tryDeterministicRoute(
      buildCommsEvent({ sender: "CTL-100", channel: "orch-orch-comms-orch", type: "info" }),
      getInterests(),
    );
    expect(matches).toHaveLength(0);
  });

  test("does NOT fire when a non-owned worker posts on the watched channel", () => {
    const matches = tryDeterministicRoute(
      buildCommsEvent({ sender: "CTL-999", channel: "orch-orch-comms-orch", type: "attention" }),
      getInterests(),
    );
    expect(matches).toHaveLength(0);
  });

  test("does NOT fire on a different channel", () => {
    const matches = tryDeterministicRoute(
      buildCommsEvent({ sender: "CTL-100", channel: "orch-other-orch", type: "attention" }),
      getInterests(),
    );
    expect(matches).toHaveLength(0);
  });

  test("orchestrator default types_of_interest is ['attention','done'] when omitted", () => {
    clearInterests();
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-default",
      detail: {
        interest_id: "orch-default-comms",
        notify_event: "filter.wake.orch-default",
        interest_type: "comms_lifecycle",
        channel: "orch-orch-default",
        subscriber_kind: "orchestrator",
        owned_workers: ["CTL-555"],
        // types_of_interest omitted
        persistent: true,
      },
    });
    expect(
      tryDeterministicRoute(
        buildCommsEvent({ sender: "CTL-555", channel: "orch-orch-default", type: "attention" }),
        getInterests(),
      ),
    ).toHaveLength(1);
    expect(
      tryDeterministicRoute(
        buildCommsEvent({ sender: "CTL-555", channel: "orch-orch-default", type: "done" }),
        getInterests(),
      ),
    ).toHaveLength(1);
    expect(
      tryDeterministicRoute(
        buildCommsEvent({ sender: "CTL-555", channel: "orch-orch-default", type: "info" }),
        getInterests(),
      ),
    ).toHaveLength(0);
  });

  test("only matches comms.message.posted events", () => {
    // A different event name on the watched channel should not match a comms interest.
    const matches = tryDeterministicRoute(
      {
        attributes: { "event.name": "github.pr.merged", "catalyst.worker.ticket": "CTL-100" },
        body: { payload: { channel: "orch-orch-comms-orch", type: "attention", to: "all", body: "" } },
      },
      getInterests(),
    );
    expect(matches).toHaveLength(0);
  });
});

describe("CTL-357 tryDeterministicRoute — comms_lifecycle (worker subscriber)", () => {
  beforeEach(() => {
    handleRegister({
      event: "filter.register",
      detail: {
        interest_id: "worker-CTL-357",
        notify_event: "filter.wake.worker-CTL-357",
        interest_type: "comms_lifecycle",
        channel: "orch-orch-comms-worker",
        subscriber_kind: "worker",
        subscriber_ticket: "CTL-357",
        persistent: true,
      },
    });
  });

  const buildCommsEvent = ({ sender, channel, type = "info", to, body = "test" }) => ({
    attributes: {
      "event.name": "comms.message.posted",
      "catalyst.worker.ticket": sender,
    },
    body: {
      payload: { channel, type, msgId: "msg-test", to, body },
    },
  });

  test("fires when payload.to equals subscriber_ticket", () => {
    const matches = tryDeterministicRoute(
      buildCommsEvent({ sender: "orchestrator", channel: "orch-orch-comms-worker", to: "CTL-357", body: "rebase now" }),
      getInterests(),
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].interestId).toBe("worker-CTL-357");
  });

  test("fires when payload.to is 'all'", () => {
    const matches = tryDeterministicRoute(
      buildCommsEvent({ sender: "orchestrator", channel: "orch-orch-comms-worker", to: "all" }),
      getInterests(),
    );
    expect(matches).toHaveLength(1);
  });

  test("does NOT fire when payload.to is a different worker", () => {
    const matches = tryDeterministicRoute(
      buildCommsEvent({ sender: "orchestrator", channel: "orch-orch-comms-worker", to: "CTL-999" }),
      getInterests(),
    );
    expect(matches).toHaveLength(0);
  });

  test("does NOT fire when sender is the worker itself (self-loop guard)", () => {
    const matches = tryDeterministicRoute(
      buildCommsEvent({ sender: "CTL-357", channel: "orch-orch-comms-worker", to: "all" }),
      getInterests(),
    );
    expect(matches).toHaveLength(0);
  });

  test("worker default fires on all types when types_of_interest omitted", () => {
    for (const type of ["info", "attention", "done"]) {
      const matches = tryDeterministicRoute(
        buildCommsEvent({ sender: "orchestrator", channel: "orch-orch-comms-worker", type, to: "all" }),
        getInterests(),
      );
      expect(matches).toHaveLength(1);
    }
  });
});

// ─── CTL-357 prose env gate ──────────────────────────────────────────────────

describe("CTL-357 prose env gate (CATALYST_BROKER_PROSE_ENABLED)", () => {
  let savedEnv;
  let savedFetch;

  beforeEach(() => {
    savedEnv = process.env.CATALYST_BROKER_PROSE_ENABLED;
    savedFetch = globalThis.fetch;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.CATALYST_BROKER_PROSE_ENABLED;
    else process.env.CATALYST_BROKER_PROSE_ENABLED = savedEnv;
    globalThis.fetch = savedFetch;
  });

  test("when disabled, classifyBatch does NOT call Groq fetch", async () => {
    delete process.env.CATALYST_BROKER_PROSE_ENABLED;
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({ choices: [{ message: { content: "[]" } }] }) };
    };
    // Register a prose interest so classifyBatch has something to chew on.
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-prose-gate",
      detail: {
        interest_id: "prose-gate-1",
        notify_event: "filter.wake.prose-gate-1",
        prompt: "wake on anything",
        persistent: true,
      },
    });
    const { classifyBatch } = await import("./index.mjs");
    await classifyBatch([{ event: "linear.issue.state_changed", detail: { state: "Done" } }]);
    expect(fetchCalled).toBe(false);
  });

  test("when CATALYST_BROKER_PROSE_ENABLED=1, classifyBatch DOES call Groq fetch", async () => {
    process.env.CATALYST_BROKER_PROSE_ENABLED = "1";
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({ choices: [{ message: { content: "[]" } }] }) };
    };
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-prose-on",
      detail: {
        interest_id: "prose-on-1",
        notify_event: "filter.wake.prose-on-1",
        prompt: "wake on anything",
        persistent: true,
      },
    });
    // classifyBatch requires GROQ_API_KEY too; export the fake.
    process.env.GROQ_API_KEY = "test-key";
    const { classifyBatch } = await import("./index.mjs");
    await classifyBatch([{ event: "linear.issue.state_changed", detail: { state: "Done" } }]);
    expect(fetchCalled).toBe(true);
    delete process.env.GROQ_API_KEY;
  });
});

describe("CTL-357 broker.daemon.prose_disabled startup event", () => {
  beforeEach(async () => {
    const { __resetProseDisabledForTest } = await import("./index.mjs");
    __resetProseDisabledForTest?.();
  });

  test("emits exactly one prose_disabled event when prose interests exist and gate is off", async () => {
    delete process.env.CATALYST_BROKER_PROSE_ENABLED;
    const { maybeEmitProseDisabled, __resetProseDisabledForTest } = await import("./index.mjs");
    __resetProseDisabledForTest();
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-prose-stale",
      detail: {
        interest_id: "stale-prose-1",
        notify_event: "filter.wake.stale-prose-1",
        prompt: "legacy prose interest",
        persistent: true,
      },
    });
    maybeEmitProseDisabled();
    maybeEmitProseDisabled(); // idempotent — should not double-emit

    const ym = new Date().toISOString().slice(0, 7);
    const logPath = join(tmpDir, "events", `${ym}.jsonl`);
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
    const proseDisabledLines = lines.filter((l) => {
      try { return JSON.parse(l).attributes?.["event.name"] === "broker.daemon.prose_disabled"; }
      catch { return false; }
    });
    expect(proseDisabledLines).toHaveLength(1);
    const evt = JSON.parse(proseDisabledLines[0]);
    expect(evt.body.payload.count).toBe(1);
    expect(evt.body.payload.sample).toContain("stale-prose-1");
  });

  test("emits nothing when no prose interests exist", async () => {
    delete process.env.CATALYST_BROKER_PROSE_ENABLED;
    const { maybeEmitProseDisabled, __resetProseDisabledForTest } = await import("./index.mjs");
    __resetProseDisabledForTest();
    // Only register a deterministic interest.
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-no-prose",
      detail: {
        interest_id: "pr-only-1",
        interest_type: "pr_lifecycle",
        notify_event: "filter.wake.pr-only-1",
        pr_numbers: [1],
        repo: "x/y",
        base_branches: [],
        persistent: true,
      },
    });
    maybeEmitProseDisabled();

    const ym = new Date().toISOString().slice(0, 7);
    const logPath = join(tmpDir, "events", `${ym}.jsonl`);
    if (!existsSync(logPath)) return;
    const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
    const proseDisabledLines = lines.filter((l) => {
      try { return JSON.parse(l).attributes?.["event.name"] === "broker.daemon.prose_disabled"; }
      catch { return false; }
    });
    expect(proseDisabledLines).toHaveLength(0);
  });

  test("emits nothing when gate is on", async () => {
    process.env.CATALYST_BROKER_PROSE_ENABLED = "1";
    const { maybeEmitProseDisabled, __resetProseDisabledForTest } = await import("./index.mjs");
    __resetProseDisabledForTest();
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-prose-on-2",
      detail: {
        interest_id: "prose-on-2-1",
        notify_event: "filter.wake.prose-on-2-1",
        prompt: "still prose",
        persistent: true,
      },
    });
    maybeEmitProseDisabled();

    const ym = new Date().toISOString().slice(0, 7);
    const logPath = join(tmpDir, "events", `${ym}.jsonl`);
    if (!existsSync(logPath)) {
      delete process.env.CATALYST_BROKER_PROSE_ENABLED;
      return;
    }
    const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
    const proseDisabledLines = lines.filter((l) => {
      try { return JSON.parse(l).attributes?.["event.name"] === "broker.daemon.prose_disabled"; }
      catch { return false; }
    });
    expect(proseDisabledLines).toHaveLength(0);
    delete process.env.CATALYST_BROKER_PROSE_ENABLED;
  });
});

// ─── CTL-357 tryTicketLifecycleRoute canonical envelopes ─────────────────────

describe("CTL-357 tryTicketLifecycleRoute canonical envelopes", () => {
  beforeEach(() => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-canon-ticket",
      detail: {
        interest_id: "watch-ctl-canon",
        notify_event: "filter.wake.watch-ctl-canon",
        interest_type: "ticket_lifecycle",
        tickets: ["CTL-275"],
        wake_on: ["status_done", "status_in_review", "status_changed", "pr_merged", "comment_added"],
        persistent: true,
      },
    });
  });

  test("matches canonical linear.issue.state_changed event", () => {
    const matches = tryTicketLifecycleRoute(
      {
        attributes: {
          "event.name": "linear.issue.state_changed",
          "linear.issue.identifier": "CTL-275",
        },
        body: { payload: { state: "Done" } },
      },
      getInterests(),
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].reason).toContain("marked Done");
  });

  test("matches canonical linear.comment.created event", () => {
    const matches = tryTicketLifecycleRoute(
      {
        attributes: {
          "event.name": "linear.comment.created",
          "linear.issue.identifier": "CTL-275",
        },
        body: { payload: { author: "ryan" } },
      },
      getInterests(),
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].reason).toContain("CTL-275");
  });

  test("matches canonical github.pr.merged event with ticket reference in body", () => {
    const matches = tryTicketLifecycleRoute(
      {
        attributes: {
          "event.name": "github.pr.merged",
          "vcs.pr.number": 999,
        },
        body: {
          payload: {
            body: "Fixes CTL-275",
            title: "fix thing",
            headRef: "ryan/ctl-275",
          },
        },
      },
      getInterests(),
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].ticket).toBe("CTL-275");
    expect(matches[0].reason).toContain("merged");
  });

  test("legacy envelope tests continue to pass after canonical fix", () => {
    // Re-run the existing legacy pattern explicitly to lock in backward compat.
    const matches = tryTicketLifecycleRoute(
      {
        event: "linear.issue.state_changed",
        attributes: { "linear.issue.identifier": "CTL-275" },
        detail: { state: "Done" },
      },
      getInterests(),
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].reason).toContain("marked Done");
  });
});

// ─── CTL-359 tryDeterministicRoute canonical envelopes ───────────────────────

describe("CTL-359 tryDeterministicRoute canonical envelopes", () => {
  beforeEach(() => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-canon-pr",
      detail: {
        interest_id: "sess-canon-pr",
        notify_event: "filter.wake.sess-canon-pr",
        interest_type: "pr_lifecycle",
        pr_numbers: [777],
        repo: "org/repo",
        base_branches: [{ pr: 777, base: "main" }],
        persistent: true,
        session_id: "sess-canon-pr",
      },
    });
  });

  test("matches canonical github.pr.merged event", () => {
    const matches = tryDeterministicRoute(
      {
        attributes: { "event.name": "github.pr.merged" },
        body: { payload: { mergeCommitSha: "deadbeef", merged: true } },
        scope: { pr: 777 },
      },
      getInterests(),
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].interestId).toBe("sess-canon-pr");
    expect(matches[0].reason).toContain("merged");
    expect(matches[0].reason).toContain("deadbeef");
  });

  test("matches canonical github.check_suite.completed event", () => {
    const matches = tryDeterministicRoute(
      {
        attributes: { "event.name": "github.check_suite.completed" },
        body: { payload: { prNumbers: [777], conclusion: "success" } },
      },
      getInterests(),
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].interestId).toBe("sess-canon-pr");
    expect(matches[0].reason).toContain("CI checks passing");
  });

  test("matches canonical github.pr_review.submitted (changes_requested by bot)", () => {
    const matches = tryDeterministicRoute(
      {
        attributes: { "event.name": "github.pr_review.submitted" },
        body: {
          payload: {
            reviewer: "coderabbitai",
            state: "changes_requested",
            author: { login: "coderabbitai", type: "Bot" },
          },
        },
        scope: { pr: 777 },
      },
      getInterests(),
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].reason).toContain("Automated review comment");
    expect(matches[0].reason).toContain("coderabbitai");
    expect(matches[0].reason).toContain("blocked from merging");
  });

  test("legacy envelope github.pr.merged continues to pass (backward compat)", () => {
    // Re-run the existing legacy shape explicitly to lock in backward compat.
    const matches = tryDeterministicRoute(
      {
        event: "github.pr.merged",
        scope: { pr: 777 },
        detail: { mergeCommitSha: "feedface", merged: true },
      },
      getInterests(),
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].interestId).toBe("sess-canon-pr");
    expect(matches[0].reason).toContain("merged");
    expect(matches[0].reason).toContain("feedface");
  });
});

// ─── CTL-370: documented allowlist ↔ broker routing-table parity ─────────────
//
// Asserts that `plugins/dev/references/event-name-allowlist.md` and the broker's
// deterministic routing tables agree. If a canonical event-name appears in one
// but not the other, this test fails — that's the drift CTL-370 was filed for.

describe("CTL-370: allowlist parity with broker routing tables", () => {
  // Closed sets extracted by reading the broker source. Update both sides
  // together — the doc is the contract, this set is the implementation truth.
  const PR_LIFECYCLE_ROUTED = new Set([
    "github.check_suite.completed",
    "github.pr.merged",
    "github.pr.closed",
    "github.pr_review.submitted",
    "github.pr_review_comment.created",
    "github.pr_review_thread.resolved",
    "github.deployment.created",
    "github.deployment_status.success",
    "github.deployment_status.failure",
    "github.deployment_status.error",
    "github.push",
  ]);
  const TICKET_LIFECYCLE_ROUTED = new Set([
    "linear.issue.state_changed",
    "linear.issue.updated",
    "linear.comment.created",
    "github.pr.opened",
    "github.pr.merged",
    "github.pr.closed",
  ]);

  // Parse the markdown allowlist. Each `## <section>` introduces a section;
  // event names live in bulleted lines as the first backticked token. Returns
  // a map of section title → Set<event.name>.
  function parseAllowlist(path) {
    const text = readFileSync(path, "utf8");
    const lines = text.split("\n");
    const sections = new Map();
    let current = null;
    for (const raw of lines) {
      const h = raw.match(/^##\s+([a-z_]+)\s*$/);
      if (h) {
        current = h[1];
        sections.set(current, new Set());
        continue;
      }
      if (!current) continue;
      const bullet = raw.match(/^\s*[-*]\s+`([^`]+)`/);
      if (!bullet) continue;
      // Drop entries that are clearly kind-names (no dots) so the parser only
      // collects canonical event.name strings.
      if (!bullet[1].includes(".")) continue;
      sections.get(current).add(bullet[1]);
    }
    return sections;
  }

  const ALLOWLIST_PATH = join(
    import.meta.dir,
    "..",
    "..",
    "references",
    "event-name-allowlist.md",
  );

  test("event-name-allowlist.md exists at plugins/dev/references/", () => {
    expect(existsSync(ALLOWLIST_PATH)).toBe(true);
  });

  test("documented pr_lifecycle names match broker pr_lifecycle routing table", () => {
    const sections = parseAllowlist(ALLOWLIST_PATH);
    const documented = sections.get("pr_lifecycle") ?? new Set();
    // Bidirectional equality — any drift fails loudly.
    expect([...documented].sort()).toEqual([...PR_LIFECYCLE_ROUTED].sort());
  });

  test("documented ticket_lifecycle names match broker ticket_lifecycle routing table", () => {
    const sections = parseAllowlist(ALLOWLIST_PATH);
    const documented = sections.get("ticket_lifecycle") ?? new Set();
    expect([...documented].sort()).toEqual([...TICKET_LIFECYCLE_ROUTED].sort());
  });
});
