// reaper-metrics.test.mjs — unit tests for the incremental reap-outcome counter
// (CTL-695 Phase 2). Run: cd plugins/dev/scripts/execution-core && bun test reaper-metrics.test.mjs
import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let catalystDir;
let logPath;

// Append a flat reap-family JSONL line to the fixture event log.
function appendFlat(obj) {
  mkdirSync(join(catalystDir, "events"), { recursive: true });
  appendFileSync(logPath, JSON.stringify(obj) + "\n");
}

beforeEach(async () => {
  catalystDir = mkdtempSync(join(tmpdir(), "reap-metrics-"));
  const ym = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}`;
  logPath = join(catalystDir, "events", `${ym}.jsonl`);
  // Reset the incremental index so each test starts from a clean slate.
  const { __resetReaperMetricsIndexForTest } = await import(
    `./reaper-metrics.mjs?reset=${Date.now()}-${Math.random()}`
  );
  __resetReaperMetricsIndexForTest();
});

async function freshMetrics() {
  const { countReapOutcomes, __resetReaperMetricsIndexForTest } = await import(
    `./reaper-metrics.mjs?cb=${Date.now()}-${Math.random()}`
  );
  __resetReaperMetricsIndexForTest();
  return { countReapOutcomes };
}

describe("countReapOutcomes", () => {
  test("counts reap-requested, reap-complete, reap-failed by family", async () => {
    const { countReapOutcomes } = await freshMetrics();
    appendFlat({ event: "phase.predecessor.reap-requested", bg_job_id: "a" });
    appendFlat({ event: "phase.terminal.reap-requested", bg_job_id: "b" });
    appendFlat({ event: "phase.predecessor.reap-complete", bg_job_id: "a" });
    appendFlat({ event: "phase.revive.reap-failed", bg_job_id: "c" });
    const m = countReapOutcomes({ path: logPath });
    expect(m).toEqual({ staleSeen: 2, staleReaped: 1, reapFailures: 1 });
  });

  test("ignores OTLP-wrapped session lines (attributes['event.name'])", async () => {
    const { countReapOutcomes } = await freshMetrics();
    appendFlat({ ts: "2026-05-28T00:00:00Z", attributes: { "event.name": "github.issue_comment" } });
    const m = countReapOutcomes({ path: logPath });
    expect(m).toEqual({ staleSeen: 0, staleReaped: 0, reapFailures: 0 });
  });

  test("missing log → all zeros (cold start)", async () => {
    const { countReapOutcomes } = await freshMetrics();
    const m = countReapOutcomes({ path: "/no/such/log.jsonl" });
    expect(m).toEqual({ staleSeen: 0, staleReaped: 0, reapFailures: 0 });
  });

  test("since filter excludes older events", async () => {
    const { countReapOutcomes } = await freshMetrics();
    appendFlat({ ts: "2026-05-01T00:00:00Z", event: "phase.predecessor.reap-complete" });
    appendFlat({ ts: "2026-05-28T00:00:00Z", event: "phase.predecessor.reap-complete" });
    const m = countReapOutcomes({ path: logPath, since: "2026-05-15T00:00:00Z" });
    expect(m.staleReaped).toBe(1);
  });

  test("incremental: second call on the same path reads only new bytes", async () => {
    const { countReapOutcomes } = await freshMetrics();
    appendFlat({ event: "phase.predecessor.reap-requested", bg_job_id: "x" });
    const first = countReapOutcomes({ path: logPath });
    expect(first.staleSeen).toBe(1);
    // Append a second event and call again — should see 2 total, not 1.
    appendFlat({ event: "phase.terminal.reap-requested", bg_job_id: "y" });
    const second = countReapOutcomes({ path: logPath });
    expect(second.staleSeen).toBe(2);
  });
});
