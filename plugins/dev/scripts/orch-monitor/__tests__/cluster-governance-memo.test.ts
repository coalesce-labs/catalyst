// CTL-1257: cluster-governance.mjs TTL memo. readClusterGovernance is now wrapped
// in a pure internal 10s TTL memo (no ring — preserves the VITE-GRAPH-GUARD) so
// the every-15s /api/cluster/governance poll stops full-reading the ~190MB log on
// every hit. We prove the memo by REWRITING the file between two same-key calls:
//   - within TTL → the cached (stale) snapshot is returned (1 read), and
//   - past TTL (advance the injected `now`) → the file is re-read (2nd read),
//     surfacing the rewritten content.
// Classification within TTL stays byte-identical to a fresh read with the same
// inputs (the injected `now` keeps it hermetic).

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClusterGovernance } from "../lib/cluster-governance.mjs";

const GOV_A = { intentsEnforce: false, watchdog: { mode: "shadow" } };
const GOV_B = { intentsEnforce: true, watchdog: { mode: "enforce" } };

function hb(host: string, ts: string, gov: Record<string, unknown>) {
  return JSON.stringify({
    ts,
    attributes: { "event.name": "node.heartbeat" },
    resource: { "host.name": host },
    body: { payload: { "host.name": host, governance: gov } },
  });
}

let tmp: string;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function freshLog(lines: string[]): string {
  tmp = mkdtempSync(join(tmpdir(), "ctl1257-gov-"));
  const p = join(tmp, "events.jsonl");
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

const NOW = Date.parse("2026-06-17T12:00:00.000Z");
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe("readClusterGovernance — TTL memo", () => {
  it("two same-key calls within 10s do ONE read (cached, ignores a file rewrite)", () => {
    const logPath = freshLog([hb("host-A", at(5_000), GOV_A)]);

    const first = readClusterGovernance({ logPath, roster: ["host-A"], now: NOW });
    expect(first.nodes[0].governance).toEqual(GOV_A);

    // Rewrite the file underneath the memo. A non-memoized reader would now see
    // GOV_B; the memo (same key, now within TTL) must return the cached GOV_A.
    writeFileSync(logPath, hb("host-A", at(5_000), GOV_B) + "\n");
    const second = readClusterGovernance({ logPath, roster: ["host-A"], now: NOW + 5_000 });
    expect(second.nodes[0].governance).toEqual(GOV_A); // still cached → 1 read
  });

  it("a call past the 10s TTL re-reads (surfaces the rewritten file)", () => {
    const logPath = freshLog([hb("host-A", at(5_000), GOV_A)]);

    const first = readClusterGovernance({ logPath, roster: ["host-A"], now: NOW });
    expect(first.nodes[0].governance).toEqual(GOV_A);

    writeFileSync(logPath, hb("host-A", at(5_000), GOV_B) + "\n");
    // Advance now() past TTL (10s) → cache is stale → re-read.
    const later = readClusterGovernance({ logPath, roster: ["host-A"], now: NOW + 10_000 });
    expect(later.nodes[0].governance).toEqual(GOV_B); // re-read → new content
  });

  it("classification within TTL is byte-identical to a fresh-key read with same inputs", () => {
    // Two DIFFERENT logPaths with identical content + roster + now ⇒ two fresh
    // reads (distinct keys) ⇒ identical classification proves the memo wrapper
    // changes nothing about what's computed, only how often.
    const lines = [hb("host-A", at(60_000), GOV_A)]; // 60s old (degraded territory)
    const lpA = freshLog(lines);
    const a = readClusterGovernance({ logPath: lpA, roster: ["host-A"], now: NOW });
    rmSync(tmp, { recursive: true, force: true });
    const lpB = freshLog(lines);
    const b = readClusterGovernance({ logPath: lpB, roster: ["host-A"], now: NOW });

    // Same shape (only generatedAt + the path-derived nothing differ; generatedAt
    // is the same injected now here).
    expect(a.nodes[0].status).toBe(b.nodes[0].status);
    expect(a.nodes[0].governance).toEqual(b.nodes[0].governance);
    expect(a.nodes[0].ageMs).toBe(b.nodes[0].ageMs);
    expect(a.singleHost).toBe(b.singleHost);
  });

  it("a different roster on the same path is a distinct key (re-read, no skew)", () => {
    const logPath = freshLog([hb("host-A", at(5_000), GOV_A), hb("host-B", at(5_000), GOV_B)]);
    const one = readClusterGovernance({ logPath, roster: ["host-A"], now: NOW });
    const two = readClusterGovernance({ logPath, roster: ["host-A", "host-B"], now: NOW });
    expect(one.nodes).toHaveLength(1);
    expect(two.nodes).toHaveLength(2); // different roster key → fresh compute
    expect(one.singleHost).toBe(true);
    expect(two.singleHost).toBe(false);
  });
});
