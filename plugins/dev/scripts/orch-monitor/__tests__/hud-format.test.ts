import { describe, expect, test } from "bun:test";
import type { CanonicalEvent } from "../lib/canonical-event.ts";
import {
  formatTime,
  formatRepo,
  formatSource,
  formatEvent,
  formatRef,
  formatDetails,
  shouldSkipEvent,
} from "../cli/lib/format.ts";

const baseEvent: CanonicalEvent = {
  ts: "2026-05-08T07:23:01.000Z",
  severityText: "INFO",
  severityNumber: 9,
  traceId: "abc123def456abc123def456abc123de",
  spanId: "abc123de456abc12",
  resource: {
    "service.name": "github-webhook",
    "service.namespace": "catalyst",
    "service.version": "8.2.0",
  },
  attributes: {
    "event.name": "github.pr.merged",
    "vcs.repository.name": "coalesce-labs/catalyst",
    "vcs.pr.number": 501,
  },
  body: { message: "PR merged", payload: {} },
};

describe("formatTime", () => {
  test("formats ISO ts as HH:MM:SS", () => {
    const result = formatTime(baseEvent);
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});

describe("formatRepo", () => {
  test("strips org prefix from repository name", () => {
    expect(formatRepo(baseEvent)).toBe("catalyst");
  });

  test("returns repo as-is when no slash", () => {
    const e = { ...baseEvent, attributes: { ...baseEvent.attributes, "vcs.repository.name": "myrepo" } };
    expect(formatRepo(e)).toBe("myrepo");
  });

  test("returns empty string when no vcs.repository.name", () => {
    const e = { ...baseEvent, attributes: { "event.name": "heartbeat" } } as unknown as CanonicalEvent;
    expect(formatRepo(e)).toBe("");
  });
});

describe("formatSource", () => {
  test("maps github events to 'github'", () => {
    expect(formatSource(baseEvent)).toBe("github");
  });

  test("maps comms.message.posted to 'comms'", () => {
    const e = { ...baseEvent, attributes: { ...baseEvent.attributes, "event.name": "comms.message.posted" } };
    expect(formatSource(e)).toBe("comms");
  });

  test("maps linear events to 'linear'", () => {
    const e = { ...baseEvent, attributes: { ...baseEvent.attributes, "event.name": "linear.issue.updated" } };
    expect(formatSource(e)).toBe("linear");
  });

  test("maps orchestrator events with orch+worker to orch/ticket format", () => {
    const e = {
      ...baseEvent,
      attributes: {
        "event.name": "orchestrator.worker.done",
        "catalyst.orchestrator.id": "orch-abc",
        "catalyst.worker.ticket": "CTL-312",
      },
    } as unknown as CanonicalEvent;
    expect(formatSource(e)).toBe("orch-abc/CTL-312");
  });

  test("maps orchestrator events with orch only", () => {
    const e = {
      ...baseEvent,
      attributes: {
        "event.name": "orchestrator.worker.done",
        "catalyst.orchestrator.id": "orch-abc",
      },
    } as unknown as CanonicalEvent;
    expect(formatSource(e)).toBe("orch-abc");
  });

  test("returns system for unknown events", () => {
    const e = { ...baseEvent, attributes: { "event.name": "some.unknown.event" } } as unknown as CanonicalEvent;
    expect(formatSource(e)).toBe("system");
  });
});

describe("formatEvent", () => {
  test("maps github.pr.merged to 'merged'", () => {
    expect(formatEvent(baseEvent)).toBe("merged");
  });

  test("maps github.check_suite.completed/failure to 'ci fail'", () => {
    const e = {
      ...baseEvent,
      attributes: {
        "event.name": "github.check_suite.completed",
        "cicd.pipeline.run.conclusion": "failure",
      },
    } as unknown as CanonicalEvent;
    expect(formatEvent(e)).toBe("ci fail");
  });

  test("maps github.check_suite.completed/success to 'ci pass'", () => {
    const e = {
      ...baseEvent,
      attributes: {
        "event.name": "github.check_suite.completed",
        "cicd.pipeline.run.conclusion": "success",
      },
    } as unknown as CanonicalEvent;
    expect(formatEvent(e)).toBe("ci pass");
  });

  test("maps github.pr.opened to 'pr open'", () => {
    const e = { ...baseEvent, attributes: { ...baseEvent.attributes, "event.name": "github.pr.opened" } };
    expect(formatEvent(e)).toBe("pr open");
  });

  test("truncates unknown event names to 15 chars", () => {
    const e = { ...baseEvent, attributes: { "event.name": "some.very.long.event.name.here" } } as unknown as CanonicalEvent;
    const result = formatEvent(e);
    expect(result.length).toBeLessThanOrEqual(15);
  });

  test("maps orchestrator.worker.done to 'done'", () => {
    const e = { ...baseEvent, attributes: { "event.name": "orchestrator.worker.done" } } as unknown as CanonicalEvent;
    expect(formatEvent(e)).toBe("done");
  });
});

describe("formatRef", () => {
  test("formats PR number with # prefix", () => {
    expect(formatRef(baseEvent)).toBe("#501");
  });

  test("formats ticket identifier when no PR", () => {
    const e = {
      ...baseEvent,
      attributes: {
        ...baseEvent.attributes,
        "vcs.pr.number": undefined,
        "linear.issue.identifier": "CTL-312",
      },
    } as unknown as CanonicalEvent;
    expect(formatRef(e)).toBe("CTL-312");
  });

  test("formats branch with → prefix when no PR or ticket", () => {
    const e = {
      ...baseEvent,
      attributes: {
        "event.name": "github.push",
        "vcs.ref.name": "main",
      },
    } as unknown as CanonicalEvent;
    expect(formatRef(e)).toBe("→main");
  });

  test("returns empty string when no ref info", () => {
    const e = { ...baseEvent, attributes: { "event.name": "heartbeat" } } as unknown as CanonicalEvent;
    expect(formatRef(e)).toBe("");
  });
});

describe("formatDetails", () => {
  test("returns payload title when present", () => {
    const e = { ...baseEvent, body: { message: "ignored", payload: { title: "feat: add thing" } } };
    expect(formatDetails(e)).toBe("feat: add thing");
  });

  test("returns message when no payload title", () => {
    const e = { ...baseEvent, body: { message: "Something happened", payload: {} } };
    expect(formatDetails(e)).toBe("Something happened");
  });

  test("returns long messages in full (scrollable detail pane handles overflow)", () => {
    const long = "x".repeat(100);
    const e = { ...baseEvent, body: { message: long } };
    expect(formatDetails(e)).toBe(long);
  });
});

describe("shouldSkipEvent", () => {
  test("skips session.heartbeat", () => {
    const e = { ...baseEvent, attributes: { "event.name": "session.heartbeat" } } as unknown as CanonicalEvent;
    expect(shouldSkipEvent(e)).toBe(true);
  });

  test("skips orchestrator.archived", () => {
    const e = { ...baseEvent, attributes: { "event.name": "orchestrator.archived" } } as unknown as CanonicalEvent;
    expect(shouldSkipEvent(e)).toBe(true);
  });

  test("skips session.started", () => {
    const e = { ...baseEvent, attributes: { "event.name": "session.started" } } as unknown as CanonicalEvent;
    expect(shouldSkipEvent(e)).toBe(true);
  });

  test("skips session.ended", () => {
    const e = { ...baseEvent, attributes: { "event.name": "session.ended" } } as unknown as CanonicalEvent;
    expect(shouldSkipEvent(e)).toBe(true);
  });

  test("skips check_run.completed with success conclusion", () => {
    const e = {
      ...baseEvent,
      attributes: {
        "event.name": "github.check_run.completed",
        "cicd.pipeline.run.conclusion": "success",
      },
    } as unknown as CanonicalEvent;
    expect(shouldSkipEvent(e)).toBe(true);
  });

  test("skips check_run.completed with neutral conclusion", () => {
    const e = {
      ...baseEvent,
      attributes: {
        "event.name": "github.check_run.completed",
        "cicd.pipeline.run.conclusion": "neutral",
      },
    } as unknown as CanonicalEvent;
    expect(shouldSkipEvent(e)).toBe(true);
  });

  test("does not skip check_run.completed with failure conclusion", () => {
    const e = {
      ...baseEvent,
      attributes: {
        "event.name": "github.check_run.completed",
        "cicd.pipeline.run.conclusion": "failure",
      },
    } as unknown as CanonicalEvent;
    expect(shouldSkipEvent(e)).toBe(false);
  });

  test("does not skip github.pr.merged", () => {
    expect(shouldSkipEvent(baseEvent)).toBe(false);
  });

  test("skips filter.wake with 'No matching events found' reason", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "filter.wake" },
      body: { payload: { reason: "No matching events found" } },
    } as unknown as CanonicalEvent;
    expect(shouldSkipEvent(e)).toBe(true);
  });

  test("does not skip filter.wake with other reason", () => {
    const e = {
      ...baseEvent,
      attributes: { "event.name": "filter.wake" },
      body: { payload: { reason: "ci_completed" } },
    } as unknown as CanonicalEvent;
    expect(shouldSkipEvent(e)).toBe(false);
  });
});
