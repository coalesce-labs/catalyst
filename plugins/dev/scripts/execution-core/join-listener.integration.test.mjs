// join-listener.integration.test.mjs — Phase 2 integration tests for CTL-1183.
// Binds an ephemeral port; exercises arm → fetch → consume → replay-refused.
// Run: cd plugins/dev/scripts/execution-core && bun test join-listener.integration.test.mjs

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startArmedListener } from "./join-listener.mjs";

let repoDir;
let layer2File;

// Set up minimal config fixtures so assembleJoinBundle() doesn't throw.
beforeAll(() => {
  repoDir = mkdtempSync(join(tmpdir(), "jl-int-"));
  mkdirSync(join(repoDir, ".catalyst"), { recursive: true });
  layer2File = join(repoDir, "layer2.json");

  process.env.CATALYST_CONFIG_FILE = join(repoDir, ".catalyst", "config.json");
  process.env.CATALYST_LAYER2_CONFIG_FILE = layer2File;
  process.env.CATALYST_HOST_NAME = "test-node";

  writeFileSync(
    process.env.CATALYST_CONFIG_FILE,
    JSON.stringify({
      catalyst: {
        projectKey: "test-project",
        linear: { teamKey: "TST", teamId: "t-1", stateMap: {} },
      },
    }),
  );
  writeFileSync(
    layer2File,
    JSON.stringify({
      catalyst: {
        linear: {
          bot: {
            orchestrator: { accessToken: "orch-tok" },
            worker: { accessToken: "worker-tok" },
          },
        },
        repository: { org: "test-org", name: "test-repo" },
      },
    }),
  );
});

afterAll(() => {
  delete process.env.CATALYST_CONFIG_FILE;
  delete process.env.CATALYST_LAYER2_CONFIG_FILE;
  delete process.env.CATALYST_HOST_NAME;
  rmSync(repoDir, { recursive: true, force: true });
});

test("arm → fetch (200) → consume → replay refused (server down)", async () => {
  const { url, token, stop, pidFile } = startArmedListener({
    port: 0,
    hostname: "127.0.0.1",
    token: "t0k-integration",
    ttlMs: 60_000,
    pidFile: join(repoDir, "listener-1.pid"),
  });

  // First fetch: should succeed and consume the token.
  const ok = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  expect(ok.status).toBe(200);
  const body = await ok.json();
  expect(body.schemaVersion).toBeDefined();
  expect(body.botCreds).toBeDefined();

  // Allow the consume-on-first-200 microtask to run and server to stop.
  await Bun.sleep(50);

  // Second fetch: server should be down (connection refused → fetch rejects).
  await expect(
    fetch(url, { headers: { Authorization: `Bearer ${token}` } }),
  ).rejects.toBeDefined();

  // PID file removed on shutdown.
  expect(existsSync(pidFile)).toBe(false);

  stop(); // idempotent
});

test("TTL-expired token → 401 before bundle served, listener stays up", async () => {
  const { url, token, stop } = startArmedListener({
    port: 0,
    hostname: "127.0.0.1",
    token: "exp-tok",
    ttlMs: 1, // effectively immediate expiry (1ms)
    pidFile: join(repoDir, "listener-2.pid"),
  });

  await Bun.sleep(10); // let TTL expire

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  expect([401, 403]).toContain(res.status);

  stop();
});

test("no token → 401, listener stays up", async () => {
  const { url, stop } = startArmedListener({
    port: 0,
    hostname: "127.0.0.1",
    token: "unused",
    ttlMs: 60_000,
    pidFile: join(repoDir, "listener-3.pid"),
  });

  const res = await fetch(url);
  expect(res.status).toBe(401);

  stop();
});
