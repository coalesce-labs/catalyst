// cli/governance.test.mjs — CTL-1062. readLatestGovernance + renderGovernance.
// Run: cd plugins/dev/scripts/execution-core && bun test cli/governance.test.mjs

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLatestGovernance, renderGovernance } from "./governance.mjs";

function heartbeatLine(host, ts, governance) {
  return JSON.stringify({
    ts, attributes: { "event.name": "node.heartbeat" },
    resource: { "host.name": host },
    body: { payload: { "host.name": host, epoch: 1, governance } },
  }) + "\n";
}

describe("readLatestGovernance (CTL-1062)", () => {
  test("returns the governance block of the most recent heartbeat for the host", () => {
    const dir = mkdtempSync(join(tmpdir(), "gov-"));
    const logPath = join(dir, "events.jsonl");
    writeFileSync(logPath,
      heartbeatLine("mini", "2026-06-12T10:00:00Z", { beliefsShadow: false }) +
      heartbeatLine("mini", "2026-06-12T10:05:00Z", { beliefsShadow: true }) +
      heartbeatLine("other", "2026-06-12T11:00:00Z", { beliefsShadow: false }));
    const res = readLatestGovernance({ logPath, host: "mini" });
    expect(res.found).toBe(true);
    expect(res.governance.beliefsShadow).toBe(true);
    expect(res.ts).toBe("2026-06-12T10:05:00Z");
    rmSync(dir, { recursive: true, force: true });
  });

  test("found:false when no heartbeat for the host / no log", () => {
    expect(readLatestGovernance({ logPath: "/nope/x.jsonl", host: "mini" }).found).toBe(false);
  });

  test("ignores heartbeats without a governance block", () => {
    const dir = mkdtempSync(join(tmpdir(), "gov-nogov-"));
    const logPath = join(dir, "events.jsonl");
    // old-format heartbeat (no governance field)
    writeFileSync(logPath,
      JSON.stringify({ ts: "2026-06-12T10:00:00Z", attributes: { "event.name": "node.heartbeat" },
        resource: { "host.name": "mini" }, body: { payload: { "host.name": "mini", epoch: 1 } } }) + "\n");
    const res = readLatestGovernance({ logPath, host: "mini" });
    expect(res.found).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("renderGovernance (CTL-1062)", () => {
  test("--json emits the raw snapshot", () => {
    const out = renderGovernance({ found: true, host: "mini", ts: "t",
      governance: { beliefsShadow: true } }, { json: true });
    expect(JSON.parse(out).governance.beliefsShadow).toBe(true);
  });

  test("human form lists each flag and a not-found message", () => {
    const human = renderGovernance({ found: true, host: "mini", ts: "t",
      governance: { beliefsShadow: true, stallJanitor: { mode: "shadow" } } }, { json: false });
    expect(human).toContain("beliefsShadow");
    expect(human).toContain("mini");
    const missing = renderGovernance({ found: false, host: "mini" }, { json: false });
    expect(missing.toLowerCase()).toContain("no heartbeat");
  });
});
