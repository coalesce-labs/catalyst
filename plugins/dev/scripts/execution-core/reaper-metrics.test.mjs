// reaper-metrics.test.mjs — unit tests for the incremental reap-outcome counter
// (CTL-695 Phase 2; CTL-793 counters-not-rows).
// Run: cd plugins/dev/scripts/execution-core && bun test reaper-metrics.test.mjs
import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
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
  const { countReapOutcomes, __resetReaperMetricsIndexForTest, __reaperMetricsIndexSizeForTest } =
    await import(`./reaper-metrics.mjs?cb=${Date.now()}-${Math.random()}`);
  __resetReaperMetricsIndexForTest();
  return { countReapOutcomes, __reaperMetricsIndexSizeForTest };
}

describe("countReapOutcomes (folded counters, CTL-793)", () => {
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

  test("first call seeds counters from a full cursor-0 scan (continuity, no per-boot discontinuity)", async () => {
    // The folded counters must equal the absolute totals over the whole log on
    // the first read — the gauge stays continuous with the pre-CTL-793 array sum.
    const { countReapOutcomes } = await freshMetrics();
    for (let i = 0; i < 50; i++) {
      appendFlat({ event: "phase.terminal.reap-requested", bg_job_id: `b${i}` });
    }
    appendFlat({ event: "phase.terminal.reap-complete", bg_job_id: "done" });
    const m = countReapOutcomes({ path: logPath });
    expect(m).toEqual({ staleSeen: 50, staleReaped: 1, reapFailures: 0 });
  });

  test("incremental: folded counters accumulate across calls, reading only new bytes", async () => {
    const { countReapOutcomes } = await freshMetrics();
    appendFlat({ event: "phase.predecessor.reap-requested", bg_job_id: "x" });
    const first = countReapOutcomes({ path: logPath });
    expect(first.staleSeen).toBe(1);
    // Append a second event and call again — should fold to 2 total, not re-scan.
    appendFlat({ event: "phase.terminal.reap-requested", bg_job_id: "y" });
    const second = countReapOutcomes({ path: logPath });
    expect(second.staleSeen).toBe(2);
  });

  test("cross-month evict: a new month's log drops the prior month's entry (bounded Map, finding #4)", async () => {
    // Switching the active path (month rollover) must evict the prior entry so the
    // index can never accumulate prior months — the whole point of CTL-793 §3 #4.
    const { countReapOutcomes, __reaperMetricsIndexSizeForTest } = await freshMetrics();
    const dir = mkdtempSync(join(tmpdir(), "reap-evict-"));
    mkdirSync(join(dir, "events"), { recursive: true });
    const may = join(dir, "events", "2026-05.jsonl");
    const jun = join(dir, "events", "2026-06.jsonl");
    writeFileSync(may, JSON.stringify({ event: "phase.terminal.reap-requested" }) + "\n");
    writeFileSync(jun, JSON.stringify({ event: "phase.terminal.reap-complete" }) + "\n");
    expect(countReapOutcomes({ path: may })).toEqual({ staleSeen: 1, staleReaped: 0, reapFailures: 0 });
    // June must NOT inherit May's totals…
    expect(countReapOutcomes({ path: jun })).toEqual({ staleSeen: 0, staleReaped: 1, reapFailures: 0 });
    // …and May's entry must be evicted so the Map stays bounded across months.
    expect(__reaperMetricsIndexSizeForTest()).toBe(1);
  });

  test("rotation/truncation resets the folded counters (size < cursor)", async () => {
    // A new/rotated month must not inherit the prior month's running totals.
    const { countReapOutcomes } = await freshMetrics();
    appendFlat({ event: "phase.terminal.reap-requested" });
    appendFlat({ event: "phase.terminal.reap-requested" });
    expect(countReapOutcomes({ path: logPath }).staleSeen).toBe(2);
    // Truncate the log to a strictly smaller size → triggers the reset path.
    writeFileSync(logPath, JSON.stringify({ event: "phase.terminal.reap-complete" }) + "\n");
    const m = countReapOutcomes({ path: logPath });
    expect(m).toEqual({ staleSeen: 0, staleReaped: 1, reapFailures: 0 });
  });
});
