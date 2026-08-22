import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// CTL-1216: resolve the event-log filename through the production leaf so this
// fixture follows the ACTIVE scheme. A pinned monthly name addresses a file the
// code under test never opens.
import { eventLogBasenameFor, resolveRotationScheme } from "../../lib/event-log-paths.mjs";

const CLOUD_SYNC = resolve(import.meta.dir, "../cloud-sync.mjs");
const scratch = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "cloud-sync-idle-"));
  scratch.push(dir);
  return dir;
}

function runCloudSync({ catalystDir = tempDir(), token } = {}) {
  const home = tempDir();
  const env = {
    ...process.env,
    HOME: home,
    CATALYST_DIR: catalystDir,
    CATALYST_HOST_NAME: "idle-test-host",
    CATALYST_LAYER2_CONFIG_FILE: join(home, "missing-layer2.json"),
    CATALYST_REPLICA_START_TIMEOUT_MS: "1",
    CATALYST_CLOUD_BASE_URL: "http://127.0.0.1:1",
  };
  delete env.CATALYST_CLOUD_TOKEN;
  delete env.CATALYST_CLOUD_TOKEN_ENV;
  if (token !== undefined) env.CATALYST_CLOUD_TOKEN = token;
  const result = Bun.spawnSync([process.execPath, CLOUD_SYNC], { env, stdout: "pipe", stderr: "pipe" });
  return {
    catalystDir,
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function eventsFrom(dir) {
  const now = new Date();
  const ym = eventLogBasenameFor(now, resolveRotationScheme({ env: process.env })).replace(/\.jsonl$/, "");
  const text = readFileSync(join(dir, "events", `${ym}.jsonl`), "utf8");
  return text.trim().split("\n").map(JSON.parse);
}

describe("cloud-sync tokenless idle event", () => {
  test("appends exactly one canonical writer_idle event with provisioning context", () => {
    const { catalystDir, exitCode } = runCloudSync();
    expect(exitCode).toBe(0);
    const events = eventsFrom(catalystDir);
    expect(events).toHaveLength(1);
    expect(events[0].attributes).toMatchObject({
      "event.name": "catalyst.replica.writer_idle",
      host: "idle-test-host",
      token_env: "CATALYST_CLOUD_TOKEN",
      token_source: "default",
      db_path: join(catalystDir, "catalyst-replica.db"),
    });
  });

  test("retains the clean exit and existing human-readable idle line", () => {
    const result = runCloudSync();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no token in CATALYST_CLOUD_TOKEN (source=default); writer idle — provision the token, then adopt/kickstart to activate");
  });

  test("never includes a token value under any event key", () => {
    const { catalystDir } = runCloudSync();
    const serialized = JSON.stringify(eventsFrom(catalystDir));
    expect(serialized).not.toContain("secret-token-value");
    expect(serialized).not.toMatch(/token[_-]?value/i);
  });

  test("event append failure remains fail-open and preserves the idle line", () => {
    const blocked = tempDir();
    const catalystDir = join(blocked, "not-a-directory");
    writeFileSync(catalystDir, "block mkdir");
    const result = runCloudSync({ catalystDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("writer idle — provision the token, then adopt/kickstart to activate");
  });

  test("does not emit writer_idle when a token is present", () => {
    const result = runCloudSync({ token: "secret-token-value" });
    expect(result.exitCode).not.toBe(0);
    let events = [];
    try { events = eventsFrom(result.catalystDir); } catch {}
    expect(events.filter((event) => event.attributes?.["event.name"] === "catalyst.replica.writer_idle")).toHaveLength(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain("secret-token-value");
  });
});
