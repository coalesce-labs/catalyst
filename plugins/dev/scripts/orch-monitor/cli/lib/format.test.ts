// format.test.ts — unit tests for per-event-class DETAILS formatting.
// CTL-418: github/linear structured details
// CTL-419: filter.wake wake-event rendering with recipient-short suffix

import { describe, test, expect } from "bun:test";
import { formatDetails, formatRef, shouldSkipEvent, formatStatus, fmtDuration } from "./format";
import type { CanonicalEvent } from "../../lib/canonical-event.ts";

function makeEvent(
  name: string,
  attributes: Record<string, unknown> = {},
  payload?: unknown,
  message?: string,
): CanonicalEvent {
  return {
    ts: "2026-05-14T00:00:00.000Z",
    id: "test-id",
    severityText: "INFO",
    severityNumber: 9,
    traceId: null,
    spanId: null,
    resource: { "service.name": "catalyst", "service.namespace": "catalyst", "service.version": "0.0.0", "host.name": "test-host", "host.id": "0000000000000000" },
    attributes: { "event.name": name, ...attributes } as CanonicalEvent["attributes"],
    body: { message, payload },
  };
}

function makeWakeEvent(
  recipientSessId: string,
  payload: Record<string, unknown>,
): CanonicalEvent {
  return {
    id: "test-id",
    ts: "2026-05-14T00:00:00.000Z",
    observedTs: "2026-05-14T00:00:00.000Z",
    severityText: "INFO",
    severityNumber: 9,
    traceId: null,
    spanId: null,
    resource: { "service.name": "test" },
    attributes: { "event.name": `filter.wake.${recipientSessId}` },
    body: { payload },
  } as unknown as CanonicalEvent;
}

describe("formatDetails — github.pr.* (CTL-418)", () => {
  test("merged: PR #N merged (event.name suffix is canonical)", () => {
    const ev = makeEvent("github.pr.merged", { "vcs.pr.number": 724 });
    expect(formatDetails(ev)).toBe("PR #724 merged");
  });

  test("opened: PR #N opened", () => {
    const ev = makeEvent("github.pr.opened", { "vcs.pr.number": 723 });
    expect(formatDetails(ev)).toBe("PR #723 opened");
  });

  test("synchronize → pushed", () => {
    const ev = makeEvent("github.pr.synchronize", { "vcs.pr.number": 700 });
    expect(formatDetails(ev)).toBe("PR #700 pushed");
  });

  test("ready_for_review → ready", () => {
    const ev = makeEvent("github.pr.ready_for_review", { "vcs.pr.number": 701 });
    expect(formatDetails(ev)).toBe("PR #701 ready");
  });

  test("closed (not merged)", () => {
    const ev = makeEvent("github.pr.closed", { "vcs.pr.number": 702 });
    expect(formatDetails(ev)).toBe("PR #702 closed");
  });

  test("falls back to generic when no pr number", () => {
    const ev = makeEvent("github.pr.merged", {}, undefined, "github.pr.merged for org/repo PR #99");
    expect(formatDetails(ev)).toBe("github.pr.merged for org/repo PR #99");
  });
});

describe("formatDetails — github.check_suite.* (CTL-418)", () => {
  test("success from attributes", () => {
    const ev = makeEvent("github.check_suite.completed", {
      "cicd.pipeline.run.conclusion": "success",
    });
    expect(formatDetails(ev)).toBe("CI: success");
  });

  test("failure from attributes", () => {
    const ev = makeEvent("github.check_suite.completed", {
      "cicd.pipeline.run.conclusion": "failure",
    });
    expect(formatDetails(ev)).toBe("CI: failure");
  });

  test("conclusion from payload when attribute absent", () => {
    const ev = makeEvent("github.check_suite.completed", {}, { conclusion: "timed_out" });
    expect(formatDetails(ev)).toBe("CI: timed_out");
  });

  test("falls back to generic when no conclusion", () => {
    const ev = makeEvent("github.check_suite.completed", {}, undefined, "github.check_suite.completed for repo");
    expect(formatDetails(ev)).toBe("github.check_suite.completed for repo");
  });
});

describe("formatDetails — github.workflow_run.* (CTL-418)", () => {
  test("workflow name + conclusion", () => {
    const ev = makeEvent("github.workflow_run.completed", {
      "cicd.pipeline.name": "Deploy Website",
      "cicd.pipeline.run.conclusion": "success",
    });
    expect(formatDetails(ev)).toBe("Deploy Website: success");
  });

  test("workflow name only when no conclusion", () => {
    const ev = makeEvent("github.workflow_run.completed", {
      "cicd.pipeline.name": "CI",
    });
    expect(formatDetails(ev)).toBe("CI");
  });

  test("name + conclusion from payload fallback", () => {
    const ev = makeEvent("github.workflow_run.completed", {}, { name: "Lint", conclusion: "failure" });
    expect(formatDetails(ev)).toBe("Lint: failure");
  });

  test("falls back to generic when no name", () => {
    const ev = makeEvent("github.workflow_run.completed", {}, undefined, "github.workflow_run.completed");
    expect(formatDetails(ev)).toBe("github.workflow_run.completed");
  });
});

describe("formatDetails — linear.issue.* (CTL-418)", () => {
  test("state_changed with identifier from attributes", () => {
    const ev = makeEvent("linear.issue.state_changed", {
      "linear.issue.identifier": "ADV-987",
    });
    expect(formatDetails(ev)).toBe("ADV-987: state changed");
  });

  test("updated with identifier", () => {
    const ev = makeEvent("linear.issue.updated", {
      "linear.issue.identifier": "ADV-985",
    });
    expect(formatDetails(ev)).toBe("ADV-985: updated");
  });

  test("identifier from payload ticket when attribute absent", () => {
    const ev = makeEvent("linear.issue.state_changed", {}, { ticket: "CTL-210" });
    expect(formatDetails(ev)).toBe("CTL-210: state changed");
  });

  test("priority_changed", () => {
    const ev = makeEvent("linear.issue.priority_changed", {
      "linear.issue.identifier": "CTL-99",
    });
    expect(formatDetails(ev)).toBe("CTL-99: priority changed");
  });

  test("falls back to generic when no identifier", () => {
    const ev = makeEvent("linear.issue.updated", {}, undefined, "linear.issue.updated CTL-100");
    expect(formatDetails(ev)).toBe("linear.issue.updated CTL-100");
  });
});

describe("formatDetails — session.phase (CTL-418)", () => {
  test("shows phase name from payload.to", () => {
    const ev = makeEvent("session.phase", {}, { to: "researching", phase: 1 });
    expect(formatDetails(ev)).toBe("researching");
  });

  test("implementing phase", () => {
    const ev = makeEvent("session.phase", {}, { to: "implementing", phase: 3 });
    expect(formatDetails(ev)).toBe("implementing");
  });

  test("falls back to generic when no payload.to", () => {
    const ev = makeEvent("session.phase", {}, undefined, "session.phase");
    expect(formatDetails(ev)).toBe("session.phase");
  });
});

describe("phase.dispatch.runaway — CTL-671 runaway alert", () => {
  const runaway = (count = 312, windowMs = 600_000) =>
    makeEvent("phase.dispatch.runaway.CTL-9", {}, { count, window_ms: windowMs });

  test("is NOT skipped by the HUD filter (operator-critical)", () => {
    expect(shouldSkipEvent(runaway())).toBe(false);
  });

  test("renders count + window in DETAILS", () => {
    expect(formatDetails(runaway(312, 600_000))).toBe("runaway: 312 events in 10min");
  });

  test("WARN severity drives the attention glyph", () => {
    const ev = { ...runaway(), severityText: "WARN" } as ReturnType<typeof runaway>;
    expect(formatStatus(ev)).toBe("! ");
  });
});

describe("formatDetails — filter.wake events (CTL-419)", () => {
  test("single stale session: shows reason with recipient short suffix", () => {
    const event = makeWakeEvent("sess_20260511T203845_16d33281", {
      reason: "No heartbeat from worker-A for >4 min",
      stale_sessions: ["worker-A"],
      stale_count: 1,
      source_event_ids: [],
      source_events: [],
    });
    const details = formatDetails(event);
    expect(details).toContain("wake →");
    expect(details).toContain("16d33281");
  });

  test("multi stale: shows stale count + recipient short", () => {
    const event = makeWakeEvent("sess_20260511T203845_16d33281", {
      reason: "3 sessions stale",
      stale_sessions: ["worker-A", "worker-B", "worker-C"],
      stale_count: 3,
      source_event_ids: [],
      source_events: [],
    });
    const details = formatDetails(event);
    expect(details).toMatch(/3 sessions stale/);
    expect(details).toContain("16d33281");
  });

  test("legacy reason without stale_sessions: still appends recipient", () => {
    const event = makeWakeEvent("sess_abc_deadbeef", {
      reason: "No heartbeat from old-worker for >5 min",
      source_event_ids: [],
      source_events: [],
    });
    const details = formatDetails(event);
    expect(details).toContain("deadbeef");
  });

  test("structured source_events path: appends recipient short", () => {
    const event = makeWakeEvent("sess_abc_feedface", {
      source_events: [
        {
          name: "linear.issue.state_changed",
          ticket: "CTL-99",
          payload_excerpt: { state: "Done" },
        },
      ],
      source_event_ids: ["evt-1"],
    });
    const details = formatDetails(event);
    expect(details).toMatch(/wake ← linear\.issue\.state_changed CTL-99 → Done/);
    expect(details).toContain("feedface");
  });

  test("session ID with no underscore: uses full id as short form", () => {
    const event = makeWakeEvent("orchestrator-1", {
      reason: "No heartbeat from w for >3 min",
      stale_sessions: ["w"],
      stale_count: 1,
      source_event_ids: [],
      source_events: [],
    });
    const details = formatDetails(event);
    expect(details).toContain("orchestrator-1");
  });
});

describe("formatRef — filter.wake (CTL-419 — unchanged)", () => {
  test("still returns stripped session id", () => {
    const event = makeWakeEvent("sess_20260511T203845_16d33281", {});
    expect(formatRef(event)).toBe("sess_20260511T203845_16d33281");
  });
});

describe("fmtDuration (CTL-700)", () => {
  test("sub-second: renders as Nms", () => {
    expect(fmtDuration(420)).toBe("420ms");
  });
  test("seconds range: renders as N.Ns", () => {
    expect(fmtDuration(2345)).toBe("2.3s");
  });
  test("upper seconds boundary: 59s", () => {
    expect(fmtDuration(59000)).toBe("59.0s");
  });
  test("minutes range: renders as NmNNs with zero-padded seconds", () => {
    expect(fmtDuration(842000)).toBe("14m02s");
  });
  test("hours range: renders as NhNNm with zero-padded minutes", () => {
    expect(fmtDuration(3900000)).toBe("1h05m");
  });
  test("zero: returns 0ms", () => {
    expect(fmtDuration(0)).toBe("0ms");
  });
});
