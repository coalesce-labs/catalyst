import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "../server";

let tmpDir: string;
let wtDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "orch-monitor-pid-test-"));
  wtDir = join(tmpDir, "wt");
  mkdirSync(wtDir, { recursive: true });
  const orchDir = join(wtDir, "orch-pid");
  mkdirSync(join(orchDir, "workers"), { recursive: true });
  writeFileSync(
    join(orchDir, "state.json"),
    JSON.stringify({ id: "orch-pid", waves: [] }),
  );
});

afterAll(() => {
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("PID file support", () => {
  let server: ReturnType<typeof createServer> | null = null;

  afterEach(() => {
    if (server) {
      void server.stop(true);
      server = null;
    }
  });

  it("writes PID file when pidFile option is provided", () => {
    const pidPath = join(tmpDir, "test.pid");
    server = createServer({
      port: 0,
      wtDir,
      startWatcher: false,
      pidFile: pidPath,
      annotationsDbPath: join(tmpDir, "annotations.db"),
    });

    expect(existsSync(pidPath)).toBe(true);
    const content = readFileSync(pidPath, "utf-8").trim();
    expect(parseInt(content, 10)).toBe(process.pid);
  });

  it("does not write PID file when pidFile option is omitted", () => {
    const pidPath = join(tmpDir, "should-not-exist.pid");
    server = createServer({ port: 0, wtDir, startWatcher: false, annotationsDbPath: join(tmpDir, "annotations.db") });

    expect(existsSync(pidPath)).toBe(false);
  });

  it("deletes PID file on server stop", () => {
    const pidPath = join(tmpDir, "stop-test.pid");
    server = createServer({
      port: 0,
      wtDir,
      startWatcher: false,
      pidFile: pidPath,
      annotationsDbPath: join(tmpDir, "annotations.db"),
    });

    expect(existsSync(pidPath)).toBe(true);
    void server.stop(true);
    server = null;
    expect(existsSync(pidPath)).toBe(false);
  });

  it("PID file contains only the numeric PID", () => {
    const pidPath = join(tmpDir, "format-test.pid");
    server = createServer({
      port: 0,
      wtDir,
      startWatcher: false,
      pidFile: pidPath,
      annotationsDbPath: join(tmpDir, "annotations.db"),
    });

    const content = readFileSync(pidPath, "utf-8");
    expect(content).toMatch(/^\d+\n$/);
  });
});
