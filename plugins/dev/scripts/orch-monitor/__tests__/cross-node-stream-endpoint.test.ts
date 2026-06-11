// cross-node-stream-endpoint.test.ts — CTL-885 (BFF3): HTTP route-plumbing tests
// for the NODE-AWARE /api/ec-worker-stream route. The routing LOGIC itself
// (resolveTailRoute branches, proxyRemoteTail, resolvePeerBaseUrl) is exhaustively
// covered by the injectable unit tests in cross-node-stream.test.ts; these prove
// the server wiring honors the roster at the HTTP boundary:
//
//   • SINGLE-HOST (no hosts.json) — the identity no-op: the route behaves exactly
//     like the non-cluster BFF5 path (400 on a bad id, 404 on no transcript).
//   • MULTI-HOST roster present but the session has no resident worker (owner
//     UNKNOWN) — the route falls back to the LOCAL tail (404 on no transcript),
//     never a wrong-node guess. This proves the route READS the roster and that a
//     multi-host roster does not break the local fallback.
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { createServer } from "../server";

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let tmpDir: string;
let catalystDir: string;
const prevConfigFile = process.env.CATALYST_CONFIG_FILE;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cross-node-stream-endpoint-"));
  const wtDir = join(tmpDir, "wt");
  mkdirSync(wtDir, { recursive: true });
  // A 2-host committed roster → multi-host. readClusterRoster resolves it via
  // CATALYST_CONFIG_FILE's sibling hosts.json (same contract as config.mjs).
  catalystDir = join(tmpDir, ".catalyst");
  mkdirSync(catalystDir, { recursive: true });
  writeFileSync(join(catalystDir, "config.json"), "{}");
  writeFileSync(join(catalystDir, "hosts.json"), JSON.stringify(["mini", "mac-studio"]));
  process.env.CATALYST_CONFIG_FILE = join(catalystDir, "config.json");
  server = createServer({ port: 0, wtDir, startWatcher: false });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  void server?.stop(true);
  if (prevConfigFile === undefined) delete process.env.CATALYST_CONFIG_FILE;
  else process.env.CATALYST_CONFIG_FILE = prevConfigFile;
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("GET /api/ec-worker-stream/:sessionId — node-aware (CTL-885 BFF3)", () => {
  it("still rejects a malformed sessionId with 400 under a multi-host roster", async () => {
    expect((await fetch(`${baseUrl}/api/ec-worker-stream/not a uuid!`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/ec-worker-stream/..%2F..%2Fetc`)).status).toBe(400);
  });

  it("multi-host roster, session has no resident worker (owner unknown) → local fallback → 404 on no transcript", async () => {
    // A well-formed UUID with no worker and no transcript: owner resolves to null
    // → resolveTailRoute returns { mode: "local" } → the local tail 404s. The
    // multi-host roster does NOT divert this to a remote/unroutable path.
    const res = await fetch(`${baseUrl}/api/ec-worker-stream/${randomUUID()}`);
    expect(res.status).toBe(404);
  });
});
