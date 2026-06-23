// recovery-admission.test.mjs — CTL-1322. readClusterAdmission extracts the
// per-node admission block from the local event log (newest-line-wins, fail-open).
//
// Run: cd plugins/dev/scripts/execution-core && bun test recovery-admission.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClusterAdmission } from "./recovery.mjs";

const HB = "node.heartbeat";

function hbLine(host, ts, admission) {
  return JSON.stringify({
    ts,
    attributes: { "event.name": HB },
    body: { payload: { "host.name": host, admission } },
  });
}

describe("readClusterAdmission (CTL-1322)", () => {
  let tmp;
  let logPath;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cluster-adm-"));
    logPath = join(tmp, "events.jsonl");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("extracts the admission block per host", () => {
    writeFileSync(
      logPath,
      hbLine("mini", "2026-06-23T10:00:00Z", { accepting: false, holdReason: "drain", effectiveCapacity: 0, activeWorkers: 6 }) + "\n",
    );
    expect(readClusterAdmission({ logPath })).toEqual({
      mini: { accepting: false, holdReason: "drain", effectiveCapacity: 0, activeWorkers: 6 },
    });
  });

  test("newest line wins — a later accepting:true overrides an earlier hold", () => {
    writeFileSync(logPath, [
      hbLine("mini", "2026-06-23T10:00:00Z", { accepting: false, holdReason: "drain", effectiveCapacity: 0, activeWorkers: 6 }),
      hbLine("mini", "2026-06-23T10:00:30Z", { accepting: true, holdReason: null, effectiveCapacity: 6, activeWorkers: 2 }),
    ].join("\n") + "\n");
    const r = readClusterAdmission({ logPath });
    expect(r.mini.accepting).toBe(true);
    expect(r.mini.holdReason).toBe(null);
  });

  test("a fresh admission:null clears a stale hold (host omitted)", () => {
    writeFileSync(logPath, [
      hbLine("mini", "2026-06-23T10:00:00Z", { accepting: false, holdReason: "drain", effectiveCapacity: 0, activeWorkers: 6 }),
      hbLine("mini", "2026-06-23T10:00:30Z", null),
    ].join("\n") + "\n");
    expect(readClusterAdmission({ logPath })).toEqual({});
  });

  test("a heartbeat with no admission key omits the host", () => {
    writeFileSync(
      logPath,
      JSON.stringify({ ts: "2026-06-23T10:00:00Z", attributes: { "event.name": HB }, body: { payload: { "host.name": "mini" } } }) + "\n",
    );
    expect(readClusterAdmission({ logPath })).toEqual({});
  });

  test("missing log file → {} (fail-open, never throws)", () => {
    const gone = join(tmp, "nope.jsonl");
    expect(() => readClusterAdmission({ logPath: gone })).not.toThrow();
    expect(readClusterAdmission({ logPath: gone })).toEqual({});
  });

  test("garbage + non-heartbeat lines are skipped", () => {
    writeFileSync(logPath, [
      "not json at all",
      JSON.stringify({ ts: "2026-06-23T09:00:00Z", attributes: { "event.name": "node.boot" }, body: { payload: { "host.name": "mini", admission: { accepting: false } } } }),
      hbLine("mini-2", "2026-06-23T10:00:00Z", { accepting: false, holdReason: "liveness-cold", effectiveCapacity: 0, activeWorkers: 0 }),
    ].join("\n") + "\n");
    expect(readClusterAdmission({ logPath })).toEqual({
      "mini-2": { accepting: false, holdReason: "liveness-cold", effectiveCapacity: 0, activeWorkers: 0 },
    });
  });

  test("multiple hosts each carry their own admission", () => {
    writeFileSync(logPath, [
      hbLine("mini", "2026-06-23T10:00:00Z", { accepting: true, holdReason: null, effectiveCapacity: 6, activeWorkers: 1 }),
      hbLine("mini-2", "2026-06-23T10:00:00Z", { accepting: false, holdReason: "drain", effectiveCapacity: 0, activeWorkers: 3 }),
    ].join("\n") + "\n");
    const r = readClusterAdmission({ logPath });
    expect(r.mini.accepting).toBe(true);
    expect(r["mini-2"].holdReason).toBe("drain");
  });
});
