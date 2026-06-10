// cluster-endpoint.test.ts — HTTP route test for GET /api/cluster/board (CTL-865).
// Validates the server wiring: the route returns 200 and a well-formed
// ClusterBoardPayload shape. The production getClusterBoard() is bypassed via the
// injected clusterBoardReader so no linearis subprocess or event log is touched.
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "../server";
import type { ClusterBoardPayload } from "../lib/cluster-data";

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let tmpDir: string;

const now = Date.now();
const at = (msAgo: number) => new Date(now - msAgo).toISOString();

const MOCK_PAYLOAD: ClusterBoardPayload = {
  generatedAt: at(0),
  hosts: [
    {
      hostName: "mini",
      lastHeartbeatISO: at(5_000),
      liveness: "live",
      tickets: [
        { id: "CTL-900", title: "Test ticket", phase: "implement", linearState: "In Progress", pr: null, prState: null },
      ],
    },
  ],
  unclaimed: [],
};

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cluster-endpoint-test-"));
  const wtDir = join(tmpDir, "wt");
  mkdirSync(wtDir, { recursive: true });
  server = createServer({
    port: 0,
    wtDir,
    catalystDir: tmpDir,
    startWatcher: false,
    clusterBoardReader: async () => MOCK_PAYLOAD,
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  void server?.stop(true);
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("GET /api/cluster/board", () => {
  it("returns 200 with a well-formed ClusterBoardPayload shape", async () => {
    const res = await fetch(`${baseUrl}/api/cluster/board`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ClusterBoardPayload;
    expect(body).toHaveProperty("generatedAt");
    expect(Array.isArray(body.hosts)).toBe(true);
    expect(Array.isArray(body.unclaimed)).toBe(true);
    for (const h of body.hosts) {
      expect(["live", "degraded", "offline"]).toContain(h.liveness);
      expect(h).toHaveProperty("hostName");
      expect(Array.isArray(h.tickets)).toBe(true);
    }
  });

  it("returns the injected payload content", async () => {
    const res = await fetch(`${baseUrl}/api/cluster/board`);
    const body = (await res.json()) as ClusterBoardPayload;
    expect(body.hosts).toHaveLength(1);
    expect(body.hosts[0].hostName).toBe("mini");
    expect(body.hosts[0].liveness).toBe("live");
    expect(body.hosts[0].tickets[0].id).toBe("CTL-900");
  });
});
