import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLokiChangeSource, COORDINATION_LOKI_QUERY } from "./interim-loki-source.ts";
import { createMirrorTailClient } from "./mirror-tail-client.ts";
import type { LokiFetcher, LokiQueryResult } from "../../orch-monitor/lib/loki.ts";

function envelopeLine(id: string, name: string): string {
  return JSON.stringify({
    id,
    ts: "2026-07-21T00:00:00Z",
    caused_by: null,
    attributes: { "event.name": name, "event.stream_class": "coordination" },
    // Real coordination events carry host.name (buildCatalystResource), NOT catalyst.node.name.
    resource: { "service.name": "catalyst.execution-core", "host.name": "laptop" },
  });
}

// A fake LokiFetcher: records the logql it was queried with and returns scripted streams.
function fakeLoki(opts: { available: boolean; streams?: Array<{ line: string; tsNs: string }> }): LokiFetcher & { lastQuery: string | null } {
  return {
    lastQuery: null,
    async queryRange(logql: string): Promise<LokiQueryResult | null> {
      (this as { lastQuery: string | null }).lastQuery = logql;
      if (!opts.available) return null;
      return {
        data: {
          resultType: "streams",
          result: [
            {
              stream: { service_namespace: "catalyst" },
              values: (opts.streams ?? []).map((s) => [s.tsNs, s.line] as [string, string]),
            },
          ],
        },
      };
    },
    isAvailable() {
      return opts.available;
    },
  };
}

function mirrorRows(p: string): Array<Record<string, unknown>> {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

describe("createLokiChangeSource (CTL-1488 Phase 5 interim transport)", () => {
  let dir: string, mirrorPath: string, ac: AbortController;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ctl1488-loki-"));
    mirrorPath = join(dir, "coordination.jsonl");
    ac = new AbortController();
  });
  afterEach(() => { ac.abort(); rmSync(dir, { recursive: true, force: true }); });

  test("queries the coordination LogQL and normalizes stream values into the SAME merge path", async () => {
    const loki = fakeLoki({
      available: true,
      streams: [{ line: envelopeLine("evt-loki-1", "phase.plan.complete.CTL-9"), tsNs: "1700000000000000000" }],
    });
    const source = createLokiChangeSource({ lokiFetcher: loki, nowMs: 1_700_000_100_000 });
    const client = createMirrorTailClient({ mirrorPath, source, signal: ac.signal });
    await client.tick();

    // The interim source issues the canonical coordination selector.
    expect(loki.lastQuery).toBe(COORDINATION_LOKI_QUERY);
    // The Loki envelope was normalized to a ChangeDelta and merged through the identical merge logic.
    const rows = mirrorRows(mirrorPath);
    expect(rows.map((r) => r.id)).toEqual(["evt-loki-1"]);
    expect((rows[0].attributes as Record<string, unknown>)["event.stream_class"]).toBe("coordination");
    // host provenance is resolved from resource["host.name"] (CTL-1488 review finding #2).
    expect(rows[0].host).toBe("laptop");
  });

  test("dedups by event.id across ticks (the window is re-queried, rows are not double-appended)", async () => {
    const loki = fakeLoki({
      available: true,
      streams: [{ line: envelopeLine("evt-dup", "phase.pr.complete.CTL-1"), tsNs: "1700000000000000000" }],
    });
    const source = createLokiChangeSource({ lokiFetcher: loki, nowMs: 1_700_000_100_000 });
    const client = createMirrorTailClient({ mirrorPath, source, signal: ac.signal });
    await client.tick();
    await client.tick(); // same window, same row
    expect(mirrorRows(mirrorPath).map((r) => r.id)).toEqual(["evt-dup"]); // exactly once
  });

  test("Loki unavailable (queryRange null / isAvailable false) is a no-op tick, not a crash (fail-open)", async () => {
    const loki = fakeLoki({ available: false });
    const source = createLokiChangeSource({ lokiFetcher: loki, nowMs: 1_700_000_100_000 });
    const client = createMirrorTailClient({ mirrorPath, source, signal: ac.signal });
    await client.tick(); // must not throw
    expect(mirrorRows(mirrorPath).length).toBe(0);
  });
});
