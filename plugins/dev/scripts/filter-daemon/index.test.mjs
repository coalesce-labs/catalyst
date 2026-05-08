// Unit tests for filter-daemon core logic
// Run: bun test plugins/dev/scripts/filter-daemon/index.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, writeFileSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve, join } from "node:path";
import {
  handleRegister,
  handleDeregister,
  handleOrchestratorTerminated,
  shouldSkipEvent,
  buildGroqPrompt,
  getInterests,
  clearInterests,
  getLastHeartbeat,
  clearLastHeartbeat,
  processEvent,
  runWatchdogTick,
  saveInterests,
  loadPersistedInterests,
  readGroqApiKeyFromConfig,
  tryDeterministicRoute,
} from "./index.mjs";
import {
  openFilterStateDb,
  closeFilterStateDb,
  upsertFilterStateOpen,
  setFilterStateMerged,
  getFilterStateByInterest,
} from "./filter-state.mjs";

describe("interest table", () => {
  beforeEach(() => clearInterests());

  test("handleRegister adds entry keyed by interest_id", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-1",
      detail: {
        interest_id: "orch-1",
        notify_event: "filter.wake.orch-1",
        prompt: "Wake me on CI failure",
        context: { pr_numbers: [42] },
      },
    });
    const entry = getInterests().get("orch-1");
    expect(entry).toBeDefined();
    expect(entry.notify_event).toBe("filter.wake.orch-1");
    expect(entry.prompt).toBe("Wake me on CI failure");
    expect(entry.context).toEqual({ pr_numbers: [42] });
  });

  test("handleRegister falls back to orchestrator field when no interest_id", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-2",
      detail: {
        notify_event: "filter.wake.orch-2",
        prompt: "PR merge events",
      },
    });
    expect(getInterests().has("orch-2")).toBe(true);
  });

  test("handleRegister derives notify_event from id when not provided", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-x",
      detail: { interest_id: "orch-x", prompt: "any event" },
    });
    expect(getInterests().get("orch-x").notify_event).toBe("filter.wake.orch-x");
  });

  test("handleRegister is idempotent — updates existing entry", () => {
    const base = {
      event: "filter.register",
      orchestrator: "orch-3",
      detail: { interest_id: "orch-3", notify_event: "filter.wake.orch-3", prompt: "v1" },
    };
    handleRegister(base);
    handleRegister({ ...base, detail: { ...base.detail, prompt: "v2" } });
    expect(getInterests().get("orch-3").prompt).toBe("v2");
    expect(getInterests().size).toBe(1);
  });

  test("handleDeregister removes entry by interest_id", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-4",
      detail: { interest_id: "orch-4", notify_event: "filter.wake.orch-4", prompt: "x" },
    });
    handleDeregister({ event: "filter.deregister", detail: { interest_id: "orch-4" } });
    expect(getInterests().has("orch-4")).toBe(false);
  });

  test("handleDeregister falls back to orchestrator field", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-5",
      detail: { interest_id: "orch-5", notify_event: "filter.wake.orch-5", prompt: "x" },
    });
    handleDeregister({ event: "filter.deregister", orchestrator: "orch-5", detail: {} });
    expect(getInterests().has("orch-5")).toBe(false);
  });

  test("handleDeregister is a no-op for unknown ids", () => {
    expect(() =>
      handleDeregister({ event: "filter.deregister", detail: { interest_id: "nonexistent" } })
    ).not.toThrow();
  });

  test("handleRegister stores persistent: false by default", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-p1",
      detail: { interest_id: "orch-p1", notify_event: "filter.wake.orch-p1", prompt: "x" },
    });
    expect(getInterests().get("orch-p1").persistent).toBe(false);
  });

  test("handleRegister stores persistent: true when passed", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-p2",
      detail: {
        interest_id: "orch-p2",
        notify_event: "filter.wake.orch-p2",
        prompt: "x",
        persistent: true,
      },
    });
    expect(getInterests().get("orch-p2").persistent).toBe(true);
  });

  test("handleRegister treats persistent: false explicitly as false", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-p3",
      detail: {
        interest_id: "orch-p3",
        notify_event: "filter.wake.orch-p3",
        prompt: "x",
        persistent: false,
      },
    });
    expect(getInterests().get("orch-p3").persistent).toBe(false);
  });

  test("handleRegister stores session_id from detail.session_id", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-s1",
      detail: {
        interest_id: "sess_abc",
        session_id: "sess_abc",
        notify_event: "filter.wake.sess_abc",
        prompt: "worker registration",
      },
    });
    expect(getInterests().get("sess_abc").session_id).toBe("sess_abc");
  });

  test("handleRegister defaults session_id to null when absent", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-s2",
      detail: { interest_id: "orch-s2", notify_event: "filter.wake.orch-s2", prompt: "no session" },
    });
    expect(getInterests().get("orch-s2").session_id).toBeNull();
  });
});

describe("handleOrchestratorTerminated", () => {
  beforeEach(() => clearInterests());

  test("removes all interests belonging to the terminated orchestrator", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-A",
      detail: { interest_id: "orch-A", notify_event: "filter.wake.orch-A", prompt: "x" },
    });
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-A",
      detail: { interest_id: "orch-A-2", notify_event: "filter.wake.orch-A-2", prompt: "y" },
    });
    handleOrchestratorTerminated({ event: "orchestrator-completed", orchestrator: "orch-A" });
    expect(getInterests().has("orch-A")).toBe(false);
    expect(getInterests().has("orch-A-2")).toBe(false);
  });

  test("does not remove interests belonging to other orchestrators", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-A",
      detail: { interest_id: "orch-A", notify_event: "filter.wake.orch-A", prompt: "x" },
    });
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-B",
      detail: { interest_id: "orch-B", notify_event: "filter.wake.orch-B", prompt: "y" },
    });
    handleOrchestratorTerminated({ event: "orchestrator-completed", orchestrator: "orch-A" });
    expect(getInterests().has("orch-A")).toBe(false);
    expect(getInterests().has("orch-B")).toBe(true);
  });

  test("is a no-op when no interests match the orchestrator", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-X",
      detail: { interest_id: "orch-X", notify_event: "filter.wake.orch-X", prompt: "x" },
    });
    handleOrchestratorTerminated({ event: "orchestrator-failed", orchestrator: "orch-Y" });
    expect(getInterests().has("orch-X")).toBe(true);
  });

  test("is a no-op when event has no orchestrator field", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-Z",
      detail: { interest_id: "orch-Z", notify_event: "filter.wake.orch-Z", prompt: "x" },
    });
    expect(() => handleOrchestratorTerminated({ event: "orchestrator-completed" })).not.toThrow();
    expect(getInterests().has("orch-Z")).toBe(true);
  });
});

describe("shouldSkipEvent", () => {
  test("skips filter.wake.* events (self-loop prevention)", () => {
    expect(shouldSkipEvent({ event: "filter.wake.orch-1" })).toBe(true);
    expect(shouldSkipEvent({ event: "filter.wake.anything" })).toBe(true);
  });

  test("skips all filter.* events to prevent Groq loop", () => {
    expect(shouldSkipEvent({ event: "filter.register" })).toBe(true);
    expect(shouldSkipEvent({ event: "filter.deregister" })).toBe(true);
    expect(shouldSkipEvent({ event: "filter.anything" })).toBe(true);
  });

  test("does not skip github events", () => {
    expect(shouldSkipEvent({ event: "github.pr.merged" })).toBe(false);
    expect(shouldSkipEvent({ event: "github.check_suite.completed" })).toBe(false);
  });

  test("does not skip worker lifecycle events", () => {
    expect(shouldSkipEvent({ event: "worker-done" })).toBe(false);
    expect(shouldSkipEvent({ event: "worker-status-change" })).toBe(false);
  });

  test("does not skip linear events", () => {
    expect(shouldSkipEvent({ event: "linear.issue.state_changed" })).toBe(false);
  });

  test("handles missing event field gracefully", () => {
    expect(shouldSkipEvent({})).toBe(false);
  });
});

describe("buildGroqPrompt", () => {
  beforeEach(() => clearInterests());

  test("returns null when no interests registered", () => {
    expect(buildGroqPrompt([{ event: "github.push" }])).toBeNull();
  });

  test("includes all events numbered in userPrompt", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-a",
      detail: { interest_id: "orch-a", notify_event: "filter.wake.orch-a", prompt: "CI failures" },
    });
    const events = [
      { event: "github.check_suite.completed", detail: { conclusion: "failure" } },
      { event: "github.push" },
    ];
    const result = buildGroqPrompt(events);
    expect(result).not.toBeNull();
    expect(result.userPrompt).toContain("1.");
    expect(result.userPrompt).toContain("2.");
    expect(result.userPrompt).toContain("github.check_suite.completed");
    expect(result.userPrompt).toContain("github.push");
  });

  test("includes all registered interests in userPrompt", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-a",
      detail: { interest_id: "orch-a", notify_event: "filter.wake.orch-a", prompt: "CI failures" },
    });
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-b",
      detail: { interest_id: "orch-b", notify_event: "filter.wake.orch-b", prompt: "PR merges" },
    });
    const result = buildGroqPrompt([{ event: "github.push" }]);
    expect(result.userPrompt).toContain("CI failures");
    expect(result.userPrompt).toContain("PR merges");
  });

  test("includes context in interest description when present", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-c",
      detail: {
        interest_id: "orch-c",
        notify_event: "filter.wake.orch-c",
        prompt: "my PRs",
        context: { pr_numbers: [123] },
      },
    });
    const result = buildGroqPrompt([{ event: "github.push" }]);
    expect(result.userPrompt).toContain("pr_numbers");
    expect(result.userPrompt).toContain("123");
  });

  test("systemPrompt instructs JSON-only output", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-d",
      detail: { interest_id: "orch-d", notify_event: "filter.wake.orch-d", prompt: "anything" },
    });
    const result = buildGroqPrompt([{ event: "github.push" }]);
    expect(result.systemPrompt).toContain("JSON array");
    expect(result.systemPrompt.toLowerCase()).toContain("no other text");
  });
});

describe("heartbeat tracking", () => {
  beforeEach(() => {
    clearInterests();
    clearLastHeartbeat();
  });

  test("processEvent with heartbeat updates lastHeartbeat by worker id", () => {
    processEvent({
      event: "heartbeat",
      worker: "CTL-99",
      session: "sess-1",
      orchestrator: "orch-1",
    });
    expect(getLastHeartbeat().has("CTL-99")).toBe(true);
    const entry = getLastHeartbeat().get("CTL-99");
    expect(entry.notified).toBe(false);
    expect(typeof entry.ts).toBe("number");
  });

  test("processEvent falls back to session when no worker", () => {
    processEvent({ event: "heartbeat", session: "sess-2", orchestrator: "orch-1" });
    expect(getLastHeartbeat().has("sess-2")).toBe(true);
  });

  test("processEvent falls back to orchestrator when no worker or session", () => {
    processEvent({ event: "heartbeat", orchestrator: "orch-solo" });
    expect(getLastHeartbeat().has("orch-solo")).toBe(true);
  });

  test("processEvent ignores heartbeat with no identifiers", () => {
    processEvent({ event: "heartbeat" });
    expect(getLastHeartbeat().size).toBe(0);
  });

  test("processEvent does not update lastHeartbeat for non-heartbeat events", () => {
    processEvent({ event: "worker-done", worker: "CTL-99" });
    expect(getLastHeartbeat().size).toBe(0);
  });

  test("fresh heartbeat preserves notified=false on repeated updates", () => {
    processEvent({ event: "heartbeat", worker: "CTL-99" });
    processEvent({ event: "heartbeat", worker: "CTL-99" });
    expect(getLastHeartbeat().get("CTL-99").notified).toBe(false);
  });
});

describe("watchdog tick", () => {
  const STALE_AGO = 200_000; // ms — above the 180s threshold in test env

  beforeEach(() => {
    clearInterests();
    clearLastHeartbeat();
  });

  function registerInterest(id, opts = {}) {
    handleRegister({
      event: "filter.register",
      orchestrator: opts.orchestrator ?? id,
      detail: {
        interest_id: id,
        notify_event: `filter.wake.${id}`,
        prompt: "test",
        context: opts.context ?? null,
      },
    });
  }

  test("does not throw when no heartbeats and no interests", () => {
    expect(() => runWatchdogTick()).not.toThrow();
  });

  test("marks stale entry as notified after tick", () => {
    getLastHeartbeat().set("CTL-99", { ts: Date.now() - STALE_AGO, notified: false });
    registerInterest("orch-1", { orchestrator: "orch-1", context: { workers: ["CTL-99"] } });
    runWatchdogTick();
    expect(getLastHeartbeat().get("CTL-99").notified).toBe(true);
  });

  test("does not re-notify an already-notified stale entry", () => {
    getLastHeartbeat().set("CTL-99", { ts: Date.now() - STALE_AGO, notified: true });
    registerInterest("orch-1", { orchestrator: "orch-1", context: { workers: ["CTL-99"] } });
    // If it emitted again it would throw trying to write to disk — the test
    // verifies no such write happens by checking notified stays true and no error
    expect(() => runWatchdogTick()).not.toThrow();
    expect(getLastHeartbeat().get("CTL-99").notified).toBe(true);
  });

  test("resets notified flag when fresh heartbeat arrives after stale", () => {
    // Simulate: was stale and notified, now recovered
    getLastHeartbeat().set("CTL-99", { ts: Date.now() - 1_000, notified: true });
    runWatchdogTick();
    expect(getLastHeartbeat().get("CTL-99").notified).toBe(false);
  });

  test("fresh (non-stale) entry is not notified", () => {
    getLastHeartbeat().set("CTL-99", { ts: Date.now() - 1_000, notified: false });
    registerInterest("orch-1", { orchestrator: "orch-1", context: { workers: ["CTL-99"] } });
    runWatchdogTick();
    expect(getLastHeartbeat().get("CTL-99").notified).toBe(false);
  });

  test("stale entry without matching interest does not set notified (no wake emitted)", () => {
    getLastHeartbeat().set("CTL-orphan", { ts: Date.now() - STALE_AGO, notified: false });
    // No interests registered → no matching interest
    runWatchdogTick();
    // notified stays false because no matching interest was found
    expect(getLastHeartbeat().get("CTL-orphan").notified).toBe(false);
  });

  test("matches interest by explicit context.workers list", () => {
    getLastHeartbeat().set("CTL-77", { ts: Date.now() - STALE_AGO, notified: false });
    registerInterest("orch-x", { orchestrator: "orch-x", context: { workers: ["CTL-77"] } });
    runWatchdogTick();
    expect(getLastHeartbeat().get("CTL-77").notified).toBe(true);
  });

  test("does not match when worker not in explicit context.workers list", () => {
    getLastHeartbeat().set("CTL-other", { ts: Date.now() - STALE_AGO, notified: false });
    registerInterest("orch-x", { orchestrator: "orch-x", context: { workers: ["CTL-different"] } });
    runWatchdogTick();
    expect(getLastHeartbeat().get("CTL-other").notified).toBe(false);
  });
});

describe("watchdog cleanup of stale-session registrations (CTL-269)", () => {
  const STALE_AGO = 200_000;

  beforeEach(() => {
    clearInterests();
    clearLastHeartbeat();
  });

  function registerSessionInterest(id, sessionId, opts = {}) {
    handleRegister({
      event: "filter.register",
      orchestrator: opts.orchestrator ?? id,
      detail: {
        interest_id: id,
        session_id: sessionId,
        notify_event: `filter.wake.${id}`,
        prompt: "session-keyed worker",
        context: opts.context ?? { workers: [sessionId] },
      },
    });
  }

  test("deletes interest whose session_id matches the stale sourceId after firing wake", () => {
    getLastHeartbeat().set("sess_abc", { ts: Date.now() - STALE_AGO, notified: false });
    registerSessionInterest("sess_abc", "sess_abc");
    runWatchdogTick();
    expect(getInterests().has("sess_abc")).toBe(false);
  });

  test("preserves interest whose session_id does NOT match the stale sourceId", () => {
    getLastHeartbeat().set("sess_abc", { ts: Date.now() - STALE_AGO, notified: false });
    // session_id belongs to a different session, but workers list still matches sess_abc → wake fires
    registerSessionInterest("orch-a", "sess_other", {
      orchestrator: "orch-a",
      context: { workers: ["sess_abc"] },
    });
    runWatchdogTick();
    expect(getInterests().has("orch-a")).toBe(true);
  });

  test("preserves interests without a session_id field (legacy / orchestrator registrations)", () => {
    getLastHeartbeat().set("CTL-77", { ts: Date.now() - STALE_AGO, notified: false });
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-legacy",
      detail: {
        interest_id: "orch-legacy",
        notify_event: "filter.wake.orch-legacy",
        prompt: "legacy without session",
        context: { workers: ["CTL-77"] },
      },
    });
    runWatchdogTick();
    expect(getInterests().has("orch-legacy")).toBe(true);
    expect(getInterests().get("orch-legacy").session_id).toBeNull();
  });

  test("does not delete when wake does not fire (no matching context)", () => {
    getLastHeartbeat().set("sess_abc", { ts: Date.now() - STALE_AGO, notified: false });
    // Interest has matching session_id, but its workers list does not include sess_abc → no wake
    registerSessionInterest("sess_abc", "sess_abc", {
      orchestrator: "orch-unrelated",
      context: { workers: ["sess_unrelated"] },
    });
    runWatchdogTick();
    expect(getInterests().has("sess_abc")).toBe(true);
  });

  test("cleanup runs exactly once per stale source (subsequent ticks find no matching interest)", () => {
    getLastHeartbeat().set("sess_abc", { ts: Date.now() - STALE_AGO, notified: false });
    registerSessionInterest("sess_abc", "sess_abc");
    runWatchdogTick();
    expect(getInterests().has("sess_abc")).toBe(false);
    // Second tick: heartbeat still stale + already notified → no new wake, no error
    expect(() => runWatchdogTick()).not.toThrow();
    expect(getInterests().has("sess_abc")).toBe(false);
  });
});

describe("interest persistence (saveInterests / loadPersistedInterests)", () => {
  const INTERESTS_FILE = resolve(homedir(), "catalyst", "filter-interests.json");

  beforeEach(() => {
    clearInterests();
    try { unlinkSync(INTERESTS_FILE); } catch { /* ok if missing */ }
  });

  afterEach(() => {
    clearInterests();
    try { unlinkSync(INTERESTS_FILE); } catch { /* ok if missing */ }
  });

  test("saveInterests writes interests to disk and loadPersistedInterests reads them back", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-persist-1",
      detail: {
        interest_id: "orch-persist-1",
        notify_event: "filter.wake.orch-persist-1",
        prompt: "persist test",
        persistent: true,
      },
    });
    clearInterests();
    expect(getInterests().size).toBe(0);

    loadPersistedInterests();
    expect(getInterests().has("orch-persist-1")).toBe(true);
    expect(getInterests().get("orch-persist-1").prompt).toBe("persist test");
  });

  test("loadPersistedInterests is a no-op when file is missing", () => {
    expect(() => loadPersistedInterests()).not.toThrow();
    expect(getInterests().size).toBe(0);
  });

  test("handleRegister triggers save automatically", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-autosave",
      detail: { interest_id: "orch-autosave", notify_event: "filter.wake.orch-autosave", prompt: "autosave" },
    });
    expect(existsSync(INTERESTS_FILE)).toBe(true);
  });

  test("handleDeregister removes entry and saves", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-del",
      detail: { interest_id: "orch-del", notify_event: "filter.wake.orch-del", prompt: "x" },
    });
    handleDeregister({ event: "filter.deregister", detail: { interest_id: "orch-del" } });
    clearInterests();
    loadPersistedInterests();
    expect(getInterests().has("orch-del")).toBe(false);
  });

  test("handleOrchestratorTerminated removes entries and saves", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-term",
      detail: { interest_id: "orch-term", notify_event: "filter.wake.orch-term", prompt: "x" },
    });
    handleOrchestratorTerminated({ event: "orchestrator-completed", orchestrator: "orch-term" });
    clearInterests();
    loadPersistedInterests();
    expect(getInterests().has("orch-term")).toBe(false);
  });

  test("saveInterests overwrites stale entries on repeated calls", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-v1",
      detail: { interest_id: "orch-v1", notify_event: "filter.wake.orch-v1", prompt: "v1" },
    });
    saveInterests();
    handleDeregister({ event: "filter.deregister", detail: { interest_id: "orch-v1" } });
    saveInterests();
    clearInterests();
    loadPersistedInterests();
    expect(getInterests().has("orch-v1")).toBe(false);
  });
});

describe("readGroqApiKeyFromConfig", () => {
  const tmpDir = join(tmpdir(), "filter-daemon-test-" + process.pid);
  const configPath = join(tmpDir, "config.json");

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  test("returns groq.apiKey from a valid config file", () => {
    writeFileSync(configPath, JSON.stringify({ groq: { apiKey: "test-key-123" } }));
    expect(readGroqApiKeyFromConfig(configPath)).toBe("test-key-123");
    rmSync(configPath);
  });

  test("returns empty string when file does not exist", () => {
    expect(readGroqApiKeyFromConfig(join(tmpDir, "nonexistent.json"))).toBe("");
  });

  test("returns empty string when config has no groq key", () => {
    writeFileSync(configPath, JSON.stringify({ linear: { apiKey: "other" } }));
    expect(readGroqApiKeyFromConfig(configPath)).toBe("");
    rmSync(configPath);
  });

  test("returns empty string when groq.apiKey is null", () => {
    writeFileSync(configPath, JSON.stringify({ groq: { apiKey: null } }));
    expect(readGroqApiKeyFromConfig(configPath)).toBe("");
    rmSync(configPath);
  });

  test("returns empty string on invalid JSON", () => {
    writeFileSync(configPath, "not-valid-json{{{");
    expect(readGroqApiKeyFromConfig(configPath)).toBe("");
    rmSync(configPath);
  });
});

// CTL-284: deterministic event routing for pr_lifecycle interests.
// These tests use a real per-test SQLite database for filter_state correlations,
// matching the pattern in filter-state.test.mjs.

describe("tryDeterministicRoute — pr_lifecycle", () => {
  let tmpDir;

  beforeEach(() => {
    clearInterests();
    tmpDir = mkdtempSync(join(tmpdir(), "deterministic-route-test-"));
    openFilterStateDb(join(tmpDir, "filter-state.db"));
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-A",
      detail: {
        interest_id: "i-A",
        interest_type: "pr_lifecycle",
        notify_event: "filter.wake.i-A",
        pr_numbers: [445, 446],
        repo: "o/r",
        base_branches: [
          { pr: 445, base: "main" },
          { pr: 446, base: "develop" },
        ],
        persistent: true,
      },
    });
  });

  afterEach(() => {
    closeFilterStateDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("check_suite.completed (failure) for matched PR → wake", () => {
    const matches = tryDeterministicRoute(
      {
        id: "evt_1",
        event: "github.check_suite.completed",
        scope: { repo: "o/r" },
        detail: { conclusion: "failure", status: "completed", prNumbers: [445] },
      },
      getInterests(),
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].interestId).toBe("i-A");
    expect(matches[0].reason).toContain("CI failing on PR #445");
    expect(matches[0].sourceEventId).toBe("evt_1");
  });

  test("check_suite.completed (success) for matched PR → wake", () => {
    const [m] = tryDeterministicRoute(
      {
        id: "evt_2",
        event: "github.check_suite.completed",
        scope: { repo: "o/r" },
        detail: { conclusion: "success", status: "completed", prNumbers: [446] },
      },
      getInterests(),
    );
    expect(m.reason).toContain("All CI checks passing on PR #446");
  });

  test("check_suite.completed neutral/cancelled → no wake", () => {
    const matches = tryDeterministicRoute(
      {
        id: "evt_2b",
        event: "github.check_suite.completed",
        scope: { repo: "o/r" },
        detail: { conclusion: "cancelled", status: "completed", prNumbers: [445] },
      },
      getInterests(),
    );
    expect(matches).toHaveLength(0);
  });

  test("check_suite.completed for unrelated PR → no wake", () => {
    const matches = tryDeterministicRoute(
      {
        id: "evt_3",
        event: "github.check_suite.completed",
        scope: { repo: "o/r" },
        detail: { conclusion: "failure", status: "completed", prNumbers: [999] },
      },
      getInterests(),
    );
    expect(matches).toHaveLength(0);
  });

  test("pr_review.submitted (changes_requested) by human → wake without bot prefix", () => {
    const [m] = tryDeterministicRoute(
      {
        id: "evt_4",
        event: "github.pr_review.submitted",
        scope: { repo: "o/r", pr: 445 },
        detail: {
          state: "changes_requested",
          reviewer: "alice",
          body: "fix this",
          author: { login: "alice", type: "User" },
        },
      },
      getInterests(),
    );
    expect(m.reason).toContain("Changes requested by alice on PR #445");
    expect(m.reason).toContain("blocked from merging");
    expect(m.reason).not.toContain("(bot)");
  });

  test("pr_review.submitted (changes_requested) by bot → wake with (bot) prefix", () => {
    const [m] = tryDeterministicRoute(
      {
        id: "evt_5",
        event: "github.pr_review.submitted",
        scope: { repo: "o/r", pr: 446 },
        detail: {
          state: "changes_requested",
          reviewer: "codex[bot]",
          body: "fix this",
          author: { login: "codex[bot]", type: "Bot" },
        },
      },
      getInterests(),
    );
    expect(m.reason).toContain("Automated review comment from codex[bot]");
    expect(m.reason).toContain("(bot)");
  });

  test("pr_review.submitted (approved) → wake with 'approved by'", () => {
    const [m] = tryDeterministicRoute(
      {
        id: "evt_6",
        event: "github.pr_review.submitted",
        scope: { repo: "o/r", pr: 445 },
        detail: {
          state: "approved",
          reviewer: "alice",
          body: "lgtm",
          author: { login: "alice", type: "User" },
        },
      },
      getInterests(),
    );
    expect(m.reason).toContain("PR #445 approved by alice");
  });

  test("pr_review_comment.created by bot → wake with bot prefix", () => {
    const [m] = tryDeterministicRoute(
      {
        id: "evt_7",
        event: "github.pr_review_comment.created",
        scope: { repo: "o/r", pr: 445 },
        detail: {
          commentId: 12345,
          body: "consider X",
          htmlUrl: "https://github.com/o/r/pull/445#discussion_r12345",
          author: { login: "codex[bot]", type: "Bot" },
        },
      },
      getInterests(),
    );
    expect(m.reason).toContain("Automated review comment from codex[bot]");
    expect(m.reason).toContain("comment ID: 12345");
    expect(m.reason).toContain("consider X");
    expect(m.reason).toContain("must be marked resolved");
  });

  test("pr_review_thread.resolved → wake with thread ID", () => {
    const [m] = tryDeterministicRoute(
      {
        id: "evt_8",
        event: "github.pr_review_thread.resolved",
        scope: { repo: "o/r", pr: 445 },
        detail: { threadId: 987 },
      },
      getInterests(),
    );
    expect(m.reason).toContain("Review thread 987 resolved on PR #445");
  });

  test("pr.merged → wake with merge SHA AND persists SHA to filter_state", () => {
    upsertFilterStateOpen({ interestId: "i-A", prNumber: 445, repo: "o/r" });
    const [m] = tryDeterministicRoute(
      {
        id: "evt_9",
        event: "github.pr.merged",
        scope: { repo: "o/r", pr: 445 },
        detail: {
          action: "closed",
          merged: true,
          mergedAt: "2026-05-07T12:00:00Z",
          mergeCommitSha: "deadbeef0001",
          draft: false,
          mergeable: true,
        },
      },
      getInterests(),
    );
    expect(m.reason).toContain("PR #445 merged");
    expect(m.reason).toContain("deadbeef0001");
    expect(m.reason).toContain("waiting for deployment");
    const row = getFilterStateByInterest("i-A");
    expect(row.mergeCommitSha).toBe("deadbeef0001");
    expect(row.status).toBe("merged");
  });

  test("pr.merged with null mergeCommitSha → wake with 'unknown'; no persistence", () => {
    upsertFilterStateOpen({ interestId: "i-A", prNumber: 445, repo: "o/r" });
    const [m] = tryDeterministicRoute(
      {
        id: "evt_9b",
        event: "github.pr.merged",
        scope: { repo: "o/r", pr: 445 },
        detail: {
          action: "closed",
          merged: true,
          mergedAt: "2026-05-07T12:00:00Z",
          mergeCommitSha: null,
          draft: false,
          mergeable: true,
        },
      },
      getInterests(),
    );
    expect(m.reason).toContain("merge commit: unknown");
    const row = getFilterStateByInterest("i-A");
    expect(row.mergeCommitSha).toBeNull();
  });

  test("pr.closed (merged=false) → wake with 'closed without merging'", () => {
    const [m] = tryDeterministicRoute(
      {
        id: "evt_10",
        event: "github.pr.closed",
        scope: { repo: "o/r", pr: 445 },
        detail: {
          action: "closed",
          merged: false,
          mergedAt: null,
          mergeCommitSha: null,
          draft: false,
          mergeable: null,
        },
      },
      getInterests(),
    );
    expect(m.reason).toContain("PR #445 closed without merging");
  });

  test("pr.closed (merged=true) → no wake (it should have routed as pr.merged)", () => {
    // The webhook handler maps closed+merged=true to "pr.merged", not "pr.closed".
    // But defensive: if a weird event arrives, we shouldn't double-fire.
    const matches = tryDeterministicRoute(
      {
        id: "evt_10b",
        event: "github.pr.closed",
        scope: { repo: "o/r", pr: 445 },
        detail: {
          action: "closed",
          merged: true,
          mergedAt: "2026-05-07T12:00:00Z",
          mergeCommitSha: "abc",
          draft: false,
          mergeable: null,
        },
      },
      getInterests(),
    );
    expect(matches).toHaveLength(0);
  });

  test("push to base branch of watched PR → BEHIND wake", () => {
    const [m] = tryDeterministicRoute(
      {
        id: "evt_11",
        event: "github.push",
        scope: { repo: "o/r", ref: "refs/heads/main", sha: "newhead" },
        detail: { baseSha: "old", headSha: "newhead", commits: [] },
      },
      getInterests(),
    );
    expect(m.reason).toContain("Base branch main updated");
    expect(m.reason).toContain("PR #445");
    expect(m.reason).toContain("behind");
  });

  test("push to non-base branch → no wake", () => {
    const matches = tryDeterministicRoute(
      {
        id: "evt_12",
        event: "github.push",
        scope: { repo: "o/r", ref: "refs/heads/feature-x", sha: "newhead" },
        detail: { baseSha: "old", headSha: "newhead", commits: [] },
      },
      getInterests(),
    );
    expect(matches).toHaveLength(0);
  });
});

describe("tryDeterministicRoute — deployment correlation", () => {
  let tmpDir;

  beforeEach(() => {
    clearInterests();
    tmpDir = mkdtempSync(join(tmpdir(), "deterministic-deploy-test-"));
    openFilterStateDb(join(tmpDir, "filter-state.db"));
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-D",
      detail: {
        interest_id: "i-D",
        interest_type: "pr_lifecycle",
        notify_event: "filter.wake.i-D",
        pr_numbers: [501],
        repo: "o/r",
        base_branches: [{ pr: 501, base: "main" }],
        persistent: true,
      },
    });
  });

  afterEach(() => {
    closeFilterStateDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("registration seeds filter_state row with status='open'", () => {
    const row = getFilterStateByInterest("i-D");
    expect(row).not.toBeNull();
    expect(row.prNumber).toBe(501);
    expect(row.status).toBe("open");
  });

  test("pr.merged → deployment.created → deployment_status.success: full chain", () => {
    // pr.merged
    tryDeterministicRoute(
      {
        id: "evt_m",
        event: "github.pr.merged",
        scope: { repo: "o/r", pr: 501 },
        detail: {
          action: "closed", merged: true, mergedAt: "2026-05-07T12:00:00Z",
          mergeCommitSha: "shaProd", draft: false, mergeable: true,
        },
      },
      getInterests(),
    );
    expect(getFilterStateByInterest("i-D").mergeCommitSha).toBe("shaProd");

    // deployment.created matches by SHA
    const [deployStart] = tryDeterministicRoute(
      {
        id: "evt_d",
        event: "github.deployment.created",
        scope: { repo: "o/r", environment: "production", sha: "shaProd", ref: "main" },
        detail: { deploymentId: 7777, payloadUrl: null },
      },
      getInterests(),
    );
    expect(deployStart.reason).toContain("Deployment started");
    expect(deployStart.reason).toContain("shaProd");
    expect(getFilterStateByInterest("i-D").deploymentId).toBe(7777);
    expect(getFilterStateByInterest("i-D").status).toBe("deploying");

    // deployment_status.success matches by deploymentId
    const [deployOk] = tryDeterministicRoute(
      {
        id: "evt_s",
        event: "github.deployment_status.success",
        scope: { repo: "o/r", environment: "production" },
        detail: {
          deploymentId: 7777, state: "success",
          targetUrl: "https://...", environmentUrl: "https://app",
        },
      },
      getInterests(),
    );
    expect(deployOk.reason).toContain("Deployment succeeded");
    expect(getFilterStateByInterest("i-D").status).toBe("deployed");
  });

  test("deployment_status.failure → wake with 'Deployment failed' and status='failed'", () => {
    upsertFilterStateOpen({ interestId: "i-D", prNumber: 501, repo: "o/r" });
    setFilterStateMerged("i-D", "shaF");
    tryDeterministicRoute(
      {
        id: "evt_d2",
        event: "github.deployment.created",
        scope: { repo: "o/r", environment: "production", sha: "shaF", ref: "main" },
        detail: { deploymentId: 8888, payloadUrl: null },
      },
      getInterests(),
    );
    const [m] = tryDeterministicRoute(
      {
        id: "evt_s2",
        event: "github.deployment_status.failure",
        scope: { repo: "o/r", environment: "production" },
        detail: {
          deploymentId: 8888, state: "failure",
          targetUrl: "https://err", environmentUrl: null,
        },
      },
      getInterests(),
    );
    expect(m.reason).toContain("Deployment failed");
    expect(m.reason).toContain("https://err");
    expect(getFilterStateByInterest("i-D").status).toBe("failed");
  });

  test("deployment.created with unmatched SHA → no wake", () => {
    const matches = tryDeterministicRoute(
      {
        id: "evt_d3",
        event: "github.deployment.created",
        scope: { repo: "o/r", environment: "production", sha: "unknown", ref: "main" },
        detail: { deploymentId: 9, payloadUrl: null },
      },
      getInterests(),
    );
    expect(matches).toHaveLength(0);
  });
});

describe("tryDeterministicRoute — backward compat with prose interests", () => {
  let tmpDir;

  beforeEach(() => {
    clearInterests();
    tmpDir = mkdtempSync(join(tmpdir(), "deterministic-bc-test-"));
    openFilterStateDb(join(tmpDir, "filter-state.db"));
  });

  afterEach(() => {
    closeFilterStateDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("prose-only registration → tryDeterministicRoute returns []", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-prose",
      detail: {
        interest_id: "i-prose",
        notify_event: "filter.wake.i-prose",
        prompt: "Wake me when the moon is full",
        persistent: true,
      },
    });
    const matches = tryDeterministicRoute(
      {
        id: "evt_p",
        event: "github.pr.merged",
        scope: { repo: "o/r", pr: 1 },
        detail: { action: "closed", merged: true, mergeCommitSha: "x" },
      },
      getInterests(),
    );
    expect(matches).toHaveLength(0);
  });

  test("buildGroqPrompt excludes pr_lifecycle interests but includes prose interests", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-prose",
      detail: {
        interest_id: "i-prose",
        notify_event: "filter.wake.i-prose",
        prompt: "prose interest",
        persistent: true,
      },
    });
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-pr",
      detail: {
        interest_id: "lifecycle-only",
        interest_type: "pr_lifecycle",
        notify_event: "filter.wake.lifecycle-only",
        pr_numbers: [42],
        repo: "o/r",
        persistent: true,
      },
    });
    const out = buildGroqPrompt([
      { id: "evt_x", event: "github.something" },
    ]);
    expect(out).not.toBeNull();
    expect(out.userPrompt).toContain("i-prose");
    expect(out.userPrompt).toContain("prose interest");
    // pr_lifecycle interests must NOT appear in the Groq prompt — they have no
    // prompt text and are routed deterministically.
    expect(out.userPrompt).not.toContain("lifecycle-only");
  });
});
