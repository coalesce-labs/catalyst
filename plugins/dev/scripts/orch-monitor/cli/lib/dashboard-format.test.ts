// dashboard-format.test.ts — pure formatters for the HUD dashboard (CTL-392).

import { describe, test, expect } from "bun:test";
import {
  formatRelativeTime,
  isStaleHeartbeat,
  STALE_HEARTBEAT_MS,
  interestWatches,
  workerStatusColor,
  truncateRight,
  lastPathSegment,
  DASHBOARD_VIEWS,
  dashboardViewLabel,
  shortOrchId,
  formatWorkerCell,
} from "./dashboard-format.ts";
import type { BrokerInterest } from "./broker-interests-reader.ts";

const NOW = Date.parse("2026-05-14T16:00:00Z");

describe("formatRelativeTime", () => {
  test("seconds → Ns", () => {
    expect(formatRelativeTime(new Date(NOW - 5_000).toISOString(), NOW)).toBe("5s");
  });
  test("under-minute boundary", () => {
    expect(formatRelativeTime(new Date(NOW - 59_000).toISOString(), NOW)).toBe("59s");
  });
  test("minutes → Nm", () => {
    expect(formatRelativeTime(new Date(NOW - 90_000).toISOString(), NOW)).toBe("1m");
    expect(formatRelativeTime(new Date(NOW - 75 * 60_000).toISOString(), NOW)).toBe("1h");
  });
  test("hours → Nh", () => {
    expect(formatRelativeTime(new Date(NOW - 2 * 3_600_000).toISOString(), NOW)).toBe("2h");
  });
  test("days → Nd", () => {
    expect(formatRelativeTime(new Date(NOW - 26 * 3_600_000).toISOString(), NOW)).toBe("1d");
  });
  test("null → em-dash", () => {
    expect(formatRelativeTime(null, NOW)).toBe("—");
  });
  test("invalid date → em-dash", () => {
    expect(formatRelativeTime("not a date", NOW)).toBe("—");
  });
});

describe("isStaleHeartbeat", () => {
  test("STALE_HEARTBEAT_MS is 5 minutes", () => {
    expect(STALE_HEARTBEAT_MS).toBe(5 * 60_000);
  });
  test("true when older than threshold", () => {
    expect(isStaleHeartbeat(new Date(NOW - 6 * 60_000).toISOString(), undefined, NOW)).toBe(true);
  });
  test("false when fresher than threshold", () => {
    expect(isStaleHeartbeat(new Date(NOW - 4 * 60_000).toISOString(), undefined, NOW)).toBe(false);
  });
  test("false for null", () => {
    expect(isStaleHeartbeat(null, undefined, NOW)).toBe(false);
  });
  test("false for invalid date", () => {
    expect(isStaleHeartbeat("not a date", undefined, NOW)).toBe(false);
  });
});

describe("interestWatches", () => {
  test("structured pr_lifecycle with repo + pr_numbers", () => {
    const i: BrokerInterest = {
      key: "x",
      notify_event: "filter.wake.foo",
      prompt: "",
      context: null,
      orchestrator: "o-x",
      session_id: null,
      persistent: true,
      interest_type: "pr_lifecycle",
      pr_numbers: [599],
      repo: "coalesce-labs/catalyst",
      base_branches: null,
      tickets: null,
      wake_on: null,
    };
    expect(interestWatches(i)).toContain("PR#599");
    expect(interestWatches(i)).toContain("coalesce-labs/catalyst");
  });

  test("prose interest with context.tickets + pr_numbers", () => {
    const i: BrokerInterest = {
      key: "x",
      notify_event: "filter.wake.foo",
      prompt: "wake when…",
      context: { pr_numbers: [599], tickets: ["CTL-352", "CTL-354"] },
      orchestrator: "o-x",
      session_id: null,
      persistent: true,
      interest_type: null,
      pr_numbers: null,
      repo: null,
      base_branches: null,
      tickets: null,
      wake_on: null,
    };
    const out = interestWatches(i);
    expect(out).toContain("PR#599");
    expect(out).toContain("CTL-352");
    expect(out).toContain("CTL-354");
  });

  test("ticket_lifecycle with tickets only", () => {
    const i: BrokerInterest = {
      key: "x",
      notify_event: "filter.wake.foo",
      prompt: "",
      context: null,
      orchestrator: "o-x",
      session_id: null,
      persistent: true,
      interest_type: "ticket_lifecycle",
      pr_numbers: null,
      repo: null,
      base_branches: null,
      tickets: ["CTL-1", "CTL-2"],
      wake_on: null,
    };
    expect(interestWatches(i)).toBe("CTL-1, CTL-2");
  });

  test("empty / fully-null interest → em-dash", () => {
    const i: BrokerInterest = {
      key: "x",
      notify_event: null,
      prompt: "",
      context: null,
      orchestrator: null,
      session_id: null,
      persistent: false,
      interest_type: null,
      pr_numbers: null,
      repo: null,
      base_branches: null,
      tickets: null,
      wake_on: null,
    };
    expect(interestWatches(i)).toBe("—");
  });
});

describe("workerStatusColor", () => {
  test("done → green", () => expect(workerStatusColor("done")).toBe("green"));
  test("failed → red", () => expect(workerStatusColor("failed")).toBe("red"));
  test("stalled → red", () => expect(workerStatusColor("stalled")).toBe("red"));
  test("in-progress → cyan", () => {
    expect(workerStatusColor("researching")).toBe("cyan");
    expect(workerStatusColor("planning")).toBe("cyan");
    expect(workerStatusColor("implementing")).toBe("cyan");
    expect(workerStatusColor("validating")).toBe("cyan");
    expect(workerStatusColor("shipping")).toBe("cyan");
    expect(workerStatusColor("pr-created")).toBe("cyan");
  });
  // CTL-476: phase-agents mode per-phase signal statuses ride the same cyan
  // bucket as legacy in-progress statuses.
  test("phase-agents per-phase statuses → cyan", () => {
    expect(workerStatusColor("dispatched")).toBe("cyan");
    expect(workerStatusColor("running")).toBe("cyan");
  });
  test("unknown → gray", () => expect(workerStatusColor("frobnicating")).toBe("gray"));
});

describe("truncateRight", () => {
  test("string shorter than width → unchanged", () => {
    expect(truncateRight("abc", 5)).toBe("abc");
  });
  test("string equal to width → unchanged", () => {
    expect(truncateRight("abcde", 5)).toBe("abcde");
  });
  test("string longer than width → suffix ellipsis", () => {
    expect(truncateRight("abcdefg", 4)).toBe("abc…");
  });
  test("width of 1 → single char only", () => {
    expect(truncateRight("abc", 1)).toBe("…");
  });
  test("width of 0 → empty", () => {
    expect(truncateRight("abc", 0)).toBe("");
  });
});

describe("lastPathSegment", () => {
  test("normal path", () => expect(lastPathSegment("/foo/bar/baz")).toBe("baz"));
  test("trailing slash stripped", () => expect(lastPathSegment("/foo/bar/")).toBe("bar"));
  test("no slash → whole string", () => expect(lastPathSegment("plain")).toBe("plain"));
  test("null → em-dash", () => expect(lastPathSegment(null)).toBe("—"));
  test("empty string → em-dash", () => expect(lastPathSegment("")).toBe("—"));
});

describe("shortOrchId", () => {
  test("returns a 4-char string", () => {
    expect(shortOrchId("o-tl-431-ctl-432")).toHaveLength(4);
  });
  test("is deterministic", () => {
    const id = "o-tl-431-ctl-432-ctl-433-ctl-434-CTL-431";
    expect(shortOrchId(id)).toBe(shortOrchId(id));
  });
  test("returns base36 chars only", () => {
    expect(shortOrchId("orch-adv-944-946")).toMatch(/^[0-9a-z]{4}$/);
  });
  test("distinct inputs produce distinct outputs (regression guard)", () => {
    expect(shortOrchId("orch-a")).not.toBe(shortOrchId("orch-b"));
    expect(shortOrchId("o-tl-431-ctl-432")).not.toBe(shortOrchId("o-tl-431-ctl-433"));
  });
});

describe("formatWorkerCell", () => {
  test("strips orchestrator prefix and prepends short fingerprint", () => {
    const orch = "o-tl-431-ctl-432-ctl-433";
    const result = formatWorkerCell(`${orch}-CTL-431`, orch);
    expect(result).toBe(`${shortOrchId(orch)}:CTL-431`);
  });

  test("null orchestrator → workerName unchanged", () => {
    expect(formatWorkerCell("standalone-worker", null)).toBe("standalone-worker");
  });

  test("empty orchestrator → workerName unchanged", () => {
    expect(formatWorkerCell("standalone-worker", "")).toBe("standalone-worker");
  });

  test("worker does not start with orchestrator prefix → unchanged", () => {
    expect(formatWorkerCell("unrelated-worker", "o-foo")).toBe("unrelated-worker");
  });

  test("worker equals orchestrator exactly → unchanged (no `-` to strip)", () => {
    expect(formatWorkerCell("o-foo", "o-foo")).toBe("o-foo");
  });

  test("worker matches orchestrator prefix without `-` separator → unchanged", () => {
    // "o-foo-bar" starts with "o-foo" but the next char isn't `-`, so don't strip.
    expect(formatWorkerCell("o-foobar", "o-foo")).toBe("o-foobar");
  });

  test("interest key with -pr-lifecycle suffix is stripped to lifecycle name", () => {
    const orch = "orch-adv-944-946-947";
    expect(formatWorkerCell(`${orch}-pr-lifecycle`, orch)).toBe(
      `${shortOrchId(orch)}:pr-lifecycle`,
    );
  });
});

describe("DASHBOARD_VIEWS + dashboardViewLabel", () => {
  test("has four views in order", () => {
    expect(DASHBOARD_VIEWS).toEqual(["interests", "workers", "orchs", "runs"]);
  });
  test("labels for each view", () => {
    expect(dashboardViewLabel("interests")).toBe("Interests");
    expect(dashboardViewLabel("workers")).toBe("Workers");
    expect(dashboardViewLabel("orchs")).toBe("Orchestrators");
    expect(dashboardViewLabel("runs")).toBe("Runs");
  });
});
