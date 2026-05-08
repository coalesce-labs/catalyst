import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  parseWindowMs,
  preprocessEvents,
  buildActivityPrompt,
  readActivityEvents,
  generateActivityBriefing,
  type RawEvent,
} from "../lib/activity-briefing";
import type { SummarizeConfig } from "../lib/summarize/config";
import type { SummarizeProvider } from "../lib/summarize/providers";

const BASE_TS = new Date("2026-05-07T10:00:00Z").toISOString();

describe("parseWindowMs", () => {
  it("parses 30m as 30 minutes in ms", () => {
    expect(parseWindowMs("30m")).toBe(30 * 60 * 1000);
  });

  it("parses 1h as 1 hour in ms", () => {
    expect(parseWindowMs("1h")).toBe(60 * 60 * 1000);
  });

  it("parses 6h as 6 hours in ms", () => {
    expect(parseWindowMs("6h")).toBe(6 * 60 * 60 * 1000);
  });

  it("defaults to 30m for unknown value", () => {
    // @ts-expect-error testing invalid input
    expect(parseWindowMs("unknown")).toBe(30 * 60 * 1000);
  });
});

describe("preprocessEvents", () => {
  it("strips session.heartbeat events", () => {
    const events: RawEvent[] = [
      { ts: BASE_TS, event: "session.heartbeat", orchestrator: null, worker: null, detail: null },
    ];
    const result = preprocessEvents(events);
    expect(result.signalEvents).toHaveLength(0);
    expect(result.strippedCount).toBe(1);
  });

  it("strips filter.register events", () => {
    const events: RawEvent[] = [
      { ts: BASE_TS, event: "filter.register", orchestrator: "o1", worker: null, detail: {} },
    ];
    const result = preprocessEvents(events);
    expect(result.strippedCount).toBe(1);
    expect(result.signalEvents).toHaveLength(0);
  });

  it("strips filter.deregister events", () => {
    const events: RawEvent[] = [
      { ts: BASE_TS, event: "filter.deregister", orchestrator: "o1", worker: null, detail: {} },
    ];
    const result = preprocessEvents(events);
    expect(result.strippedCount).toBe(1);
  });

  it("collapses filter.wake events with no matches to footnote count", () => {
    const events: RawEvent[] = [
      {
        ts: BASE_TS,
        event: "filter.wake.abc",
        orchestrator: "o1",
        worker: null,
        detail: { source_event_ids: [] },
      },
      {
        ts: BASE_TS,
        event: "filter.wake.def",
        orchestrator: "o1",
        worker: null,
        detail: { source_event_ids: [] },
      },
    ];
    const result = preprocessEvents(events);
    expect(result.noMatchWakeCount).toBe(2);
    expect(result.signalEvents).toHaveLength(0);
  });

  it("keeps filter.wake events WITH matches as signal", () => {
    const events: RawEvent[] = [
      {
        ts: BASE_TS,
        event: "filter.wake.abc",
        orchestrator: "o1",
        worker: null,
        detail: { reason: "PR merged", source_event_ids: ["evt1"] },
      },
    ];
    const result = preprocessEvents(events);
    expect(result.signalEvents).toHaveLength(1);
    expect(result.noMatchWakeCount).toBe(0);
  });

  it("keeps orchestrator.worker.phase_advanced as signal", () => {
    const events: RawEvent[] = [
      {
        ts: BASE_TS,
        event: "orchestrator.worker.phase_advanced",
        orchestrator: "o1",
        worker: "CTL-1",
        detail: { from: "planning", to: "implementing" },
      },
    ];
    const result = preprocessEvents(events);
    expect(result.signalEvents).toHaveLength(1);
  });

  it("groups events by (orchestrator, worker) thread", () => {
    const events: RawEvent[] = [
      {
        ts: BASE_TS,
        event: "orchestrator.worker.phase_advanced",
        orchestrator: "o1",
        worker: "CTL-1",
        detail: { from: "planning", to: "implementing" },
      },
      {
        ts: BASE_TS,
        event: "orchestrator.worker.phase_advanced",
        orchestrator: "o1",
        worker: "CTL-2",
        detail: { from: "planning", to: "implementing" },
      },
      {
        ts: BASE_TS,
        event: "orchestrator.attention.raised",
        orchestrator: "o1",
        worker: "CTL-1",
        detail: { reason: "CI blocked" },
      },
    ];
    const result = preprocessEvents(events);
    const thread1 = result.threads.find((t) => t.worker === "CTL-1");
    const thread2 = result.threads.find((t) => t.worker === "CTL-2");
    expect(thread1?.events).toHaveLength(2);
    expect(thread2?.events).toHaveLength(1);
  });

  it("surfaces orchestrator.attention.raised in attentionItems", () => {
    const events: RawEvent[] = [
      {
        ts: BASE_TS,
        event: "orchestrator.attention.raised",
        orchestrator: "o1",
        worker: "CTL-1",
        detail: { reason: "needs help", attentionType: "waiting-for-user" },
      },
    ];
    const result = preprocessEvents(events);
    expect(result.attentionItems).toHaveLength(1);
    expect(result.attentionItems[0]?.reason).toBe("needs help");
  });

  it("places attention threads first when sorted", () => {
    const events: RawEvent[] = [
      {
        ts: BASE_TS,
        event: "orchestrator.worker.phase_advanced",
        orchestrator: "o1",
        worker: "CTL-10",
        detail: { from: "planning", to: "implementing" },
      },
      {
        ts: BASE_TS,
        event: "orchestrator.attention.raised",
        orchestrator: "o1",
        worker: "CTL-1",
        detail: { reason: "blocked" },
      },
    ];
    const result = preprocessEvents(events);
    // Thread with attention (CTL-1) should come first
    expect(result.threads[0]?.worker).toBe("CTL-1");
  });

  it("handles empty event list", () => {
    const result = preprocessEvents([]);
    expect(result.threads).toHaveLength(0);
    expect(result.attentionItems).toHaveLength(0);
    expect(result.signalEvents).toHaveLength(0);
    expect(result.strippedCount).toBe(0);
    expect(result.noMatchWakeCount).toBe(0);
  });

  it("groups global events (no orchestrator) into a thread", () => {
    const events: RawEvent[] = [
      {
        ts: BASE_TS,
        event: "linear.issue.created",
        orchestrator: null,
        worker: null,
        detail: { ticket: "CTL-100" },
      },
    ];
    const result = preprocessEvents(events);
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0]?.orchestrator).toBeNull();
  });
});

describe("buildActivityPrompt", () => {
  it("produces a non-empty prompt with signal events", () => {
    const preprocessed = {
      threads: [
        {
          orchestrator: "orch-abc",
          worker: "CTL-1",
          events: [
            {
              ts: "2026-05-07T10:00:00Z",
              event: "orchestrator.worker.phase_advanced",
              detail: { from: "planning", to: "implementing" },
            },
          ],
        },
      ],
      attentionItems: [],
      noMatchWakeCount: 50,
      strippedCount: 500,
      signalEvents: [{ ts: BASE_TS, event: "orchestrator.worker.phase_advanced", orchestrator: "orch-abc", worker: "CTL-1", detail: {} }],
      windowLabel: "30m",
    };
    const prompt = buildActivityPrompt(preprocessed);
    expect(prompt).toContain("CTL-1");
    expect(prompt).toContain("planning");
    expect(prompt.length).toBeGreaterThan(100);
  });

  it("includes attention items prominently", () => {
    const preprocessed = {
      threads: [],
      attentionItems: [
        {
          orchestrator: "orch-abc",
          worker: "CTL-5",
          ts: "2026-05-07T10:00:00Z",
          reason: "CI blocked 3 times",
        },
      ],
      noMatchWakeCount: 0,
      strippedCount: 0,
      signalEvents: [],
      windowLabel: "30m",
    };
    const prompt = buildActivityPrompt(preprocessed);
    expect(prompt).toContain("CI blocked");
    expect(prompt).toContain("ATTENTION");
  });

  it("handles empty event window gracefully", () => {
    const preprocessed = {
      threads: [],
      attentionItems: [],
      noMatchWakeCount: 0,
      strippedCount: 0,
      signalEvents: [],
      windowLabel: "30m",
    };
    const prompt = buildActivityPrompt(preprocessed);
    expect(prompt).toBeTruthy();
    expect(typeof prompt).toBe("string");
  });

  it("includes stripped and no-match counts in prompt", () => {
    const preprocessed = {
      threads: [],
      attentionItems: [],
      noMatchWakeCount: 42,
      strippedCount: 300,
      signalEvents: [],
      windowLabel: "1h",
    };
    const prompt = buildActivityPrompt(preprocessed);
    expect(prompt).toContain("42");
    expect(prompt).toContain("300");
  });

  it("emits 'No activity in this window.' when threads is empty", () => {
    const preprocessed = {
      threads: [],
      attentionItems: [],
      noMatchWakeCount: 0,
      strippedCount: 0,
      signalEvents: [],
      windowLabel: "30m",
    };
    const prompt = buildActivityPrompt(preprocessed);
    expect(prompt).toContain("No activity in this window.");
  });

  it("caps threads at 20 with '... and N more threads' tail", () => {
    const threads = Array.from({ length: 25 }, (_, i) => ({
      orchestrator: "orch",
      worker: `CTL-${i}`,
      events: [{ ts: BASE_TS, event: "orchestrator.worker.phase_advanced", detail: null }],
    }));
    const prompt = buildActivityPrompt({
      threads,
      attentionItems: [],
      noMatchWakeCount: 0,
      strippedCount: 0,
      signalEvents: [],
      windowLabel: "1h",
    });
    expect(prompt).toContain("... and 5 more threads");
    expect(prompt).not.toContain("CTL-20");
  });
});

describe("readActivityEvents", () => {
  let tmp: string;
  let eventsDir: string;

  // CTL-300: readActivityEvents now expects canonical OTel-shaped envelopes,
  // so the on-disk fixture must use the canonical shape.
  function makeEvent(ts: string, event = "orchestrator.worker.phase_advanced"): string {
    return JSON.stringify({
      ts,
      severityText: "INFO",
      severityNumber: 9,
      traceId: null,
      spanId: null,
      resource: {
        "service.name": "catalyst.orchestrator",
        "service.namespace": "catalyst",
        "service.version": "8.2.0",
      },
      attributes: { "event.name": event },
      body: { payload: null },
    });
  }

  function monthFile(d: Date): string {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    return join(eventsDir, `${y}-${m}.jsonl`);
  }

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "orch-activity-events-"));
    eventsDir = join(tmp, "events");
    mkdirSync(eventsDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns events within the window from a single month file", () => {
    const now = new Date("2026-05-07T10:00:00Z");
    const insideTs = "2026-05-07T09:45:00Z"; // 15 min ago
    const outsideTs = "2026-05-07T09:00:00Z"; // 60 min ago
    writeFileSync(monthFile(now), [makeEvent(insideTs), makeEvent(outsideTs)].join("\n") + "\n");

    const events = readActivityEvents(tmp, 30 * 60 * 1000, now);
    expect(events.map((e) => e.ts)).toContain(insideTs);
    expect(events.map((e) => e.ts)).not.toContain(outsideTs);
  });

  it("reads across month boundary when window spans two months", () => {
    const now = new Date("2026-06-01T01:00:00Z");
    const inPrev = "2026-05-31T23:30:00Z"; // in May, within 6h window
    const inCurr = "2026-06-01T00:30:00Z"; // in June, within 6h window
    writeFileSync(monthFile(new Date("2026-05-31T00:00:00Z")), makeEvent(inPrev) + "\n");
    writeFileSync(monthFile(now), makeEvent(inCurr) + "\n");

    const events = readActivityEvents(tmp, 6 * 60 * 60 * 1000, now);
    const tsList = events.map((e) => e.ts);
    expect(tsList).toContain(inPrev);
    expect(tsList).toContain(inCurr);
  });

  it("silently skips malformed JSONL lines", () => {
    const now = new Date("2026-07-15T10:00:00Z");
    const goodTs = "2026-07-15T09:55:00Z";
    writeFileSync(
      monthFile(now),
      ["not-json", makeEvent(goodTs), "{broken", ""].join("\n"),
    );

    const events = readActivityEvents(tmp, 30 * 60 * 1000, now);
    expect(events.map((e) => e.ts)).toContain(goodTs);
    expect(events).toHaveLength(1);
  });

  it("returns empty array when events directory does not exist", () => {
    const events = readActivityEvents("/nonexistent/path/catalyst", 30 * 60 * 1000);
    expect(events).toHaveLength(0);
  });
});

describe("generateActivityBriefing", () => {
  let tmp: string;
  let callCount: { n: number };
  let stubProv: SummarizeProvider;

  const enabledConfig = (apiKey = "sk-test"): SummarizeConfig => ({
    enabled: true,
    defaultProvider: "anthropic",
    defaultModel: "claude-sonnet-4-6",
    providers: { anthropic: { apiKeyEnv: "ANTHROPIC_API_KEY", apiKey } },
  });

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "orch-activity-gen-"));
    mkdirSync(join(tmp, "events"), { recursive: true });
    callCount = { n: 0 };
    stubProv = {
      name: "anthropic",
      summarize: () => {
        callCount.n += 1;
        return Promise.resolve({ summary: "stub briefing", cost: 0, tokens: 10 });
      },
    };
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns enabled:false when config.enabled is false", async () => {
    const result = await generateActivityBriefing(tmp, { enabled: false, defaultProvider: "anthropic", defaultModel: "claude-sonnet-4-6", providers: {} });
    expect(result.enabled).toBe(false);
  });

  it("returns enabled:false when apiKey is missing", async () => {
    const cfg: SummarizeConfig = {
      enabled: true,
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-4-6",
      providers: { anthropic: { apiKeyEnv: "ANTHROPIC_API_KEY", apiKey: "" } },
    };
    const result = await generateActivityBriefing(tmp, cfg);
    expect(result.enabled).toBe(false);
  });

  it("calls provider and returns briefing with correct shape", async () => {
    const before = callCount.n;
    const result = await generateActivityBriefing(tmp, enabledConfig("sk-test-1"), "1h", stubProv);
    expect(result.enabled).toBe(true);
    if (result.enabled) {
      expect(result.briefing).toBe("stub briefing");
      expect(result.window).toBe("1h");
      expect(result.cached).toBe(false);
      expect(typeof result.generatedAt).toBe("string");
    }
    expect(callCount.n).toBe(before + 1);
  });

  it("returns cached:true on repeated calls within TTL", async () => {
    // Use a distinct key to avoid hitting previous test's cache
    const before = callCount.n;
    const cfg = enabledConfig("sk-test-cache");
    await generateActivityBriefing(tmp, cfg, "6h", stubProv);
    const second = await generateActivityBriefing(tmp, cfg, "6h", stubProv);
    expect(second.enabled).toBe(true);
    if (second.enabled) expect(second.cached).toBe(true);
    // Provider called exactly once (second hit was cached)
    expect(callCount.n).toBe(before + 1);
  });
});
