import { describe, it, expect } from "bun:test";
import {
  normalize,
  phaseTime,
  stalls,
  ciFunnel,
  type NormalizedEvent,
} from "../lib/event-analysis";

// -----------------------------------------------------------------------------
// normalize() — canonical, legacy v1, legacy v2, corrupt lines, heartbeats
// -----------------------------------------------------------------------------

describe("normalize", () => {
  it("normalizes a canonical session.phase event", () => {
    const line = JSON.stringify({
      ts: "2026-05-08T04:40:44Z",
      severityText: "INFO",
      severityNumber: 9,
      traceId: "c42df669bbe3a6c86ff788d0c1068bf2",
      spanId: "143c52152dd279fb",
      resource: { "service.name": "catalyst.session" },
      attributes: {
        "event.name": "session.phase",
        "catalyst.worker.ticket": "ADV-852",
        "catalyst.session.id": "sess_x",
        "catalyst.phase": 1,
      },
      body: { payload: { to: "researching", phase: 1 } },
    });
    const e = normalize(line);
    expect(e).not.toBeNull();
    expect(e!.eventName).toBe("session.phase");
    expect(e!.ticket).toBe("ADV-852");
    expect(e!.sessionId).toBe("sess_x");
    expect(e!.phase).toBe(1);
    expect(e!.phaseTo).toBe("researching");
    expect(e!.severityText).toBe("INFO");
  });

  it("normalizes a canonical orchestrator.worker.pr_merged event", () => {
    const line = JSON.stringify({
      ts: "2026-05-08T04:45:54Z",
      severityText: "INFO",
      severityNumber: 9,
      traceId: null,
      spanId: null,
      resource: { "service.name": "catalyst.github" },
      attributes: {
        "event.name": "github.pr.merged",
        "vcs.pr.number": 600,
        "vcs.repository.name": "rightsite-cloud/Adva",
        "catalyst.orchestrator.id": "orch-adv-854",
      },
      body: { payload: { merged: true } },
    });
    const e = normalize(line);
    expect(e).not.toBeNull();
    expect(e!.eventName).toBe("github.pr.merged");
    expect(e!.prNumber).toBe(600);
    expect(e!.orchestratorId).toBe("orch-adv-854");
  });

  it("normalizes a legacy v2 github webhook event with PR in scope.pr", () => {
    const line = JSON.stringify({
      ts: "2026-05-08T04:40:55Z",
      schemaVersion: 2,
      source: "github.webhook",
      event: "github.pr.opened",
      scope: { repo: "rightsite-cloud/Adva", pr: 600 },
      detail: { action: "opened", merged: false },
      orchestrator: "orch-adv-854",
      worker: null,
    });
    const e = normalize(line);
    expect(e).not.toBeNull();
    expect(e!.eventName).toBe("github.pr.opened");
    expect(e!.prNumber).toBe(600);
    expect(e!.orchestratorId).toBe("orch-adv-854");
  });

  it("normalizes a legacy v2 check_suite event with prNumbers array", () => {
    const line = JSON.stringify({
      ts: "2026-05-08T04:34:46Z",
      schemaVersion: 2,
      source: "github.webhook",
      event: "github.check_suite.completed",
      scope: { repo: "coalesce-labs/catalyst" },
      detail: { conclusion: "success", status: "completed", prNumbers: [442] },
      orchestrator: null,
      worker: null,
    });
    const e = normalize(line);
    expect(e).not.toBeNull();
    expect(e!.eventName).toBe("github.check_suite.completed");
    expect(e!.prNumber).toBe(442);
    expect(e!.ciConclusion).toBe("success");
  });

  it("extracts ticket from legacy v1 top-level worker field", () => {
    const line = JSON.stringify({
      ts: "2026-04-14T20:04:04Z",
      orchestrator: "agent-obs",
      worker: "CTL-52",
      event: "attention-raised",
      detail: { attentionType: "waiting-for-user", reason: "..." },
    });
    const e = normalize(line);
    expect(e).not.toBeNull();
    expect(e!.ticket).toBe("CTL-52");
    expect(e!.orchestratorId).toBe("agent-obs");
    expect(e!.eventName).toBe("orchestrator.attention.raised");
  });

  it("normalizes a legacy v1 phase-changed event using the name table", () => {
    const line = JSON.stringify({
      ts: "2026-04-14T22:16:06Z",
      session: "sess_old",
      event: "phase-changed",
      detail: { to: "researching", phase: 1 },
      ticket: "CTL-50",
    });
    const e = normalize(line);
    expect(e).not.toBeNull();
    expect(e!.eventName).toBe("session.phase"); // mapped
    expect(e!.phaseTo).toBe("researching");
    expect(e!.phase).toBe(1);
    expect(e!.ticket).toBe("CTL-50");
    expect(e!.sessionId).toBe("sess_old");
  });

  it("returns null for canonical heartbeats (76% of volume — not analyzable)", () => {
    const line = JSON.stringify({
      ts: "2026-05-08T04:40:44Z",
      severityText: "DEBUG",
      severityNumber: 5,
      traceId: null,
      spanId: null,
      resource: { "service.name": "catalyst.session" },
      attributes: { "event.name": "session.heartbeat" },
      body: { payload: null },
    });
    expect(normalize(line)).toBeNull();
  });

  it("returns null for legacy v1 heartbeat", () => {
    const line = JSON.stringify({ ts: "2026-04-14T22:00:00Z", event: "heartbeat" });
    expect(normalize(line)).toBeNull();
  });

  it("returns null for the corrupt sentinel line without throwing", () => {
    expect(normalize("adr-bootstrap")).toBeNull();
    expect(normalize("not json")).toBeNull();
    expect(normalize("")).toBeNull();
  });

  it("preserves unknown event names verbatim (forward-compat)", () => {
    const line = JSON.stringify({
      ts: "2026-05-08T05:00:00Z",
      severityText: "INFO",
      severityNumber: 9,
      traceId: null,
      spanId: null,
      resource: { "service.name": "catalyst.future" },
      attributes: { "event.name": "future.event.kind" },
      body: { payload: null },
    });
    const e = normalize(line);
    expect(e).not.toBeNull();
    expect(e!.eventName).toBe("future.event.kind");
  });

  it("extracts vcs.pr.number from canonical attributes", () => {
    const line = JSON.stringify({
      ts: "2026-05-08T05:00:00Z",
      severityText: "INFO",
      severityNumber: 9,
      traceId: null,
      spanId: null,
      resource: { "service.name": "catalyst.github" },
      attributes: { "event.name": "github.pr_review.submitted", "vcs.pr.number": 600 },
      body: { payload: { state: "changes_requested", reviewer: "alice" } },
    });
    const e = normalize(line);
    expect(e).not.toBeNull();
    expect(e!.prNumber).toBe(600);
  });
});

// -----------------------------------------------------------------------------
// phaseTime() — Q1
// -----------------------------------------------------------------------------

describe("phaseTime", () => {
  function phaseEvent(
    ticket: string,
    ts: string,
    phaseNum: number,
    phaseName: string,
  ): NormalizedEvent {
    return {
      ts,
      eventName: "session.phase",
      orchestratorId: null,
      ticket,
      sessionId: `sess_${ticket}`,
      prNumber: null,
      phase: phaseNum,
      phaseTo: phaseName,
      ciConclusion: null,
      ciStatus: null,
      severityText: "INFO",
      bodyMessage: null,
      raw: {},
    };
  }

  it("computes per-ticket phase durations from consecutive session.phase events", () => {
    const events: NormalizedEvent[] = [
      phaseEvent("ADV-1", "2026-05-08T00:00:00Z", 1, "researching"),
      phaseEvent("ADV-1", "2026-05-08T00:10:00Z", 2, "planning"),
      phaseEvent("ADV-1", "2026-05-08T00:25:00Z", 3, "implementing"),
    ];
    const r = phaseTime(events);
    const adv = r.byTicket.find((t) => t.ticket === "ADV-1");
    expect(adv).toBeDefined();
    expect(adv!.phases).toEqual([
      { name: "researching", durationSec: 600, startedAt: "2026-05-08T00:00:00Z" },
      { name: "planning", durationSec: 900, startedAt: "2026-05-08T00:10:00Z" },
    ]);
  });

  it("aggregates median and p90 per phase across tickets", () => {
    const events: NormalizedEvent[] = [
      phaseEvent("A", "2026-05-08T00:00:00Z", 1, "researching"),
      phaseEvent("A", "2026-05-08T00:01:00Z", 2, "planning"), // 60s research
      phaseEvent("B", "2026-05-08T00:00:00Z", 1, "researching"),
      phaseEvent("B", "2026-05-08T00:05:00Z", 2, "planning"), // 300s research
      phaseEvent("C", "2026-05-08T00:00:00Z", 1, "researching"),
      phaseEvent("C", "2026-05-08T00:02:00Z", 2, "planning"), // 120s research
    ];
    const r = phaseTime(events);
    const research = r.byPhase.find((p) => p.phase === "researching");
    expect(research).toBeDefined();
    expect(research!.sampleCount).toBe(3);
    expect(research!.medianSec).toBe(120);
  });

  it("omits the trailing phase (no end event seen) but still lists the ticket", () => {
    const events: NormalizedEvent[] = [
      phaseEvent("X", "2026-05-08T00:00:00Z", 4, "validating"),
      // no further phase event — worker stalled
    ];
    const r = phaseTime(events);
    const x = r.byTicket.find((t) => t.ticket === "X");
    expect(x).toBeDefined();
    expect(x!.phases).toHaveLength(0);
  });

  it("ignores non-phase events", () => {
    const events: NormalizedEvent[] = [
      phaseEvent("A", "2026-05-08T00:00:00Z", 1, "researching"),
      {
        ts: "2026-05-08T00:01:00Z",
        eventName: "github.pr.opened",
        orchestratorId: null,
        ticket: "A",
        sessionId: null,
        prNumber: 1,
        phase: null,
        phaseTo: null,
        ciConclusion: null,
        ciStatus: null,
        severityText: "INFO",
        bodyMessage: null,
        raw: {},
      },
      phaseEvent("A", "2026-05-08T00:05:00Z", 2, "planning"),
    ];
    const r = phaseTime(events);
    const a = r.byTicket.find((t) => t.ticket === "A");
    expect(a!.phases[0]?.durationSec).toBe(300);
  });
});

// -----------------------------------------------------------------------------
// stalls() — Q2
// -----------------------------------------------------------------------------

describe("stalls", () => {
  it("counts attention events and groups by ticket", () => {
    const events: NormalizedEvent[] = [
      {
        ts: "2026-05-08T07:21:18Z",
        eventName: "orchestrator.attention.raised",
        orchestratorId: "orch-1",
        ticket: "CTL-241",
        sessionId: null,
        prNumber: null,
        phase: null,
        phaseTo: null,
        ciConclusion: null,
        ciStatus: null,
        severityText: "WARN",
        bodyMessage: null,
        raw: {
          body: { payload: { attentionType: "stalled", reason: "No PR after plan" } },
        },
      },
      {
        ts: "2026-05-08T07:30:00Z",
        eventName: "orchestrator.attention.raised",
        orchestratorId: "orch-1",
        ticket: "CTL-241",
        sessionId: null,
        prNumber: null,
        phase: null,
        phaseTo: null,
        ciConclusion: null,
        ciStatus: null,
        severityText: "WARN",
        bodyMessage: null,
        raw: {
          body: { payload: { attentionType: "stalled", reason: "No PR after plan" } },
        },
      },
    ];
    const r = stalls(events);
    expect(r.totalAttentionEvents).toBe(2);
    expect(r.perTicket).toEqual([
      { ticket: "CTL-241", count: 2, lastAt: "2026-05-08T07:30:00Z" },
    ]);
    expect(r.byReason[0]).toEqual({ reason: "stalled", count: 2 });
  });

  it("extracts reviewer logins from CHANGES_REQUESTED reviews per PR", () => {
    const events: NormalizedEvent[] = [
      {
        ts: "2026-05-08T05:00:00Z",
        eventName: "github.pr_review.submitted",
        orchestratorId: null,
        ticket: null,
        sessionId: null,
        prNumber: 600,
        phase: null,
        phaseTo: null,
        ciConclusion: null,
        ciStatus: null,
        severityText: "INFO",
        bodyMessage: null,
        raw: {
          body: {
            payload: {
              state: "changes_requested",
              reviewer: "chatgpt-codex-connector[bot]",
            },
          },
        },
      },
      {
        ts: "2026-05-08T05:05:00Z",
        eventName: "github.pr_review.submitted",
        orchestratorId: null,
        ticket: null,
        sessionId: null,
        prNumber: 600,
        phase: null,
        phaseTo: null,
        ciConclusion: null,
        ciStatus: null,
        severityText: "INFO",
        bodyMessage: null,
        raw: { body: { payload: { state: "approved", reviewer: "alice" } } },
      },
    ];
    const r = stalls(events);
    expect(r.reviewerStats).toHaveLength(1);
    expect(r.reviewerStats[0]).toEqual({
      pr: 600,
      reviewers: ["chatgpt-codex-connector[bot]", "alice"],
      changesRequestedCount: 1,
    });
  });

  it("returns empty result when no attention or review events", () => {
    const r = stalls([]);
    expect(r.totalAttentionEvents).toBe(0);
    expect(r.perTicket).toEqual([]);
    expect(r.reviewerStats).toEqual([]);
  });

  it("reads attentionType from legacy v1 detail.attentionType", () => {
    // Legacy attention-raised events store the type in detail.* not body.payload.*
    const events: NormalizedEvent[] = [
      {
        ts: "2026-04-14T20:04:04Z",
        eventName: "orchestrator.attention.raised",
        orchestratorId: "agent-obs",
        ticket: "CTL-52",
        sessionId: null,
        prNumber: null,
        phase: null,
        phaseTo: null,
        ciConclusion: null,
        ciStatus: null,
        severityText: "WARN",
        bodyMessage: null,
        raw: {
          event: "attention-raised",
          detail: { attentionType: "waiting-for-user", reason: "PR check stalled" },
        },
      },
    ];
    const r = stalls(events);
    expect(r.byReason[0]).toEqual({ reason: "waiting-for-user", count: 1 });
  });
});

// -----------------------------------------------------------------------------
// ciFunnel() — Q3
// -----------------------------------------------------------------------------

describe("ciFunnel", () => {
  function prEvent(
    ts: string,
    eventName: string,
    pr: number,
    extra: Partial<NormalizedEvent> = {},
  ): NormalizedEvent {
    return {
      ts,
      eventName,
      orchestratorId: null,
      ticket: null,
      sessionId: null,
      prNumber: pr,
      phase: null,
      phaseTo: null,
      ciConclusion: null,
      ciStatus: null,
      severityText: "INFO",
      bodyMessage: null,
      raw: {},
      ...extra,
    };
  }

  it("counts opened/merged PRs and identifies failing CI before merge", () => {
    const events: NormalizedEvent[] = [
      // PR 100: opened → green → merged (clean path)
      prEvent("2026-05-08T00:00:00Z", "github.pr.opened", 100),
      prEvent("2026-05-08T00:02:00Z", "github.check_suite.completed", 100, {
        ciConclusion: "success",
      }),
      prEvent("2026-05-08T00:05:00Z", "github.pr.merged", 100),
      // PR 101: opened → fail → green → merged
      prEvent("2026-05-08T01:00:00Z", "github.pr.opened", 101),
      prEvent("2026-05-08T01:01:00Z", "github.check_suite.completed", 101, {
        ciConclusion: "failure",
      }),
      prEvent("2026-05-08T01:05:00Z", "github.check_suite.completed", 101, {
        ciConclusion: "success",
      }),
      prEvent("2026-05-08T01:10:00Z", "github.pr.merged", 101),
      // PR 102: opened only
      prEvent("2026-05-08T02:00:00Z", "github.pr.opened", 102),
    ];
    const r = ciFunnel(events);
    expect(r.prsOpened).toBe(3);
    expect(r.prsMerged).toBe(2);
    expect(r.prsWithFailingCheckSuite).toBe(1);

    const pr101 = r.perPr.find((p) => p.pr === 101);
    expect(pr101).toBeDefined();
    expect(pr101!.failingCheckSuites).toBe(1);
    expect(pr101!.firstGreenAt).toBe("2026-05-08T01:05:00Z");
    expect(pr101!.mergedAt).toBe("2026-05-08T01:10:00Z");

    const pr102 = r.perPr.find((p) => p.pr === 102);
    expect(pr102!.mergedAt).toBeNull();
    expect(pr102!.firstGreenAt).toBeNull();
  });

  it("computes median latencies in seconds", () => {
    const events: NormalizedEvent[] = [
      prEvent("2026-05-08T00:00:00Z", "github.pr.opened", 1),
      prEvent("2026-05-08T00:01:00Z", "github.check_suite.completed", 1, {
        ciConclusion: "success",
      }),
      prEvent("2026-05-08T00:02:00Z", "github.pr.merged", 1),
    ];
    const r = ciFunnel(events);
    expect(r.medianOpenToFirstGreenSec).toBe(60);
    expect(r.medianFirstGreenToMergeSec).toBe(60);
  });

  it("returns zero counts on empty input", () => {
    const r = ciFunnel([]);
    expect(r.prsOpened).toBe(0);
    expect(r.prsMerged).toBe(0);
    expect(r.medianOpenToFirstGreenSec).toBeNull();
  });
});
