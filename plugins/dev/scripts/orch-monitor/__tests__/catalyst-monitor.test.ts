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
import { join, resolve } from "path";

const SCRIPT = resolve(
  import.meta.dir,
  "..",
  "..",
  "catalyst-monitor.sh",
);
const SERVER_SCRIPT = resolve(import.meta.dir, "..", "server.ts");

let tmpDir: string;
let wtDir: string;
let pidFile: string;

function run(
  args: string[],
  env?: Record<string, string>,
): { stdout: string; stderr: string; exitCode: number } {
  const result = Bun.spawnSync(["bash", SCRIPT, ...args], {
    env: {
      ...process.env,
      CATALYST_DIR: tmpDir,
      MONITOR_PID_FILE: pidFile,
      MONITOR_SERVER_SCRIPT: SERVER_SCRIPT,
      ...env,
    },
    cwd: tmpDir,
  });
  return {
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    exitCode: result.exitCode,
  };
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "catalyst-monitor-test-"));
  wtDir = join(tmpDir, "wt");
  mkdirSync(wtDir, { recursive: true });
  pidFile = join(tmpDir, "monitor.pid");

  const orchDir = join(wtDir, "orch-test");
  mkdirSync(join(orchDir, "workers"), { recursive: true });
  writeFileSync(
    join(orchDir, "state.json"),
    JSON.stringify({ id: "orch-test", waves: [] }),
  );
});

afterAll(() => {
  // Clean up any lingering server processes
  if (existsSync(pidFile)) {
    try {
      const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
      process.kill(pid, "SIGTERM");
    } catch {
      /* already dead */
    }
  }
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

afterEach(() => {
  // Stop server between tests
  if (existsSync(pidFile)) {
    try {
      const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
      process.kill(pid, "SIGTERM");
    } catch {
      /* already dead */
    }
    // Wait briefly for process to exit
    Bun.sleepSync(200);
    try {
      rmSync(pidFile, { force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("catalyst-monitor.sh", () => {
  it("script exists and is executable", () => {
    expect(existsSync(SCRIPT)).toBe(true);
    const result = Bun.spawnSync(["test", "-x", SCRIPT]);
    expect(result.exitCode).toBe(0);
  });

  it("help command prints usage", () => {
    const { stdout, exitCode } = run(["help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("start");
    expect(stdout).toContain("stop");
    expect(stdout).toContain("status");
    expect(stdout).toContain("open");
    expect(stdout).toContain("url");
  });

  it("url command prints monitor URL", () => {
    const { stdout, exitCode } = run(["url"]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^http:\/\/localhost:\d+$/);
  });

  it("url respects MONITOR_PORT env var", () => {
    const { stdout, exitCode } = run(["url"], { MONITOR_PORT: "9999" });
    expect(exitCode).toBe(0);
    expect(stdout).toBe("http://localhost:9999");
  });

  it("status reports stopped when no PID file", () => {
    const { stdout, exitCode } = run(["status"]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("stopped");
  });

  it("status --json reports stopped when no PID file", () => {
    const { stdout, exitCode } = run(["status", "--json"]);
    expect(exitCode).toBe(1);
    const data = JSON.parse(stdout);
    expect(data.running).toBe(false);
    expect(data.pid).toBeNull();
  });

  it("start launches server and creates PID file", () => {
    const { exitCode } = run(["start"]);
    expect(exitCode).toBe(0);

    // Give server a moment to start
    Bun.sleepSync(500);
    expect(existsSync(pidFile)).toBe(true);

    const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    expect(pid).toBeGreaterThan(0);

    // Verify the process is actually running
    expect(() => process.kill(pid, 0)).not.toThrow();
  });

  it("start is idempotent when server already running", () => {
    // Start first
    run(["start"]);
    Bun.sleepSync(500);
    const pid1 = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);

    // Start again — should detect existing and not start a new one
    const { stdout, exitCode } = run(["start"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("already running");

    // PID should be unchanged
    const pid2 = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    expect(pid2).toBe(pid1);
  });

  it("stop kills the process and removes PID file", () => {
    run(["start"]);
    Bun.sleepSync(500);
    const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);

    const { exitCode } = run(["stop"]);
    expect(exitCode).toBe(0);

    Bun.sleepSync(300);

    // Process should be dead
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("stop when not running is a no-op", () => {
    const { exitCode, stdout } = run(["stop"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("not running");
  });

  it("status reports running after start", () => {
    run(["start"]);
    Bun.sleepSync(500);

    const { stdout, exitCode } = run(["status"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("running");
  });

  it("status --json reports running with PID and port", () => {
    run(["start"]);
    Bun.sleepSync(500);

    const { stdout, exitCode } = run(["status", "--json"]);
    expect(exitCode).toBe(0);
    const data = JSON.parse(stdout);
    expect(data.running).toBe(true);
    expect(data.pid).toBeGreaterThan(0);
    expect(data.port).toBe(7400);
    expect(data.url).toBe("http://localhost:7400");
  });

  it("handles stale PID file (dead process)", () => {
    // Write a PID file pointing to a non-existent process
    writeFileSync(pidFile, "999999\n");

    const { exitCode } = run(["start"]);
    expect(exitCode).toBe(0);

    Bun.sleepSync(500);
    const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    expect(pid).not.toBe(999999);
    expect(pid).toBeGreaterThan(0);
  });

  it("unknown command prints error", () => {
    const { exitCode, stderr } = run(["bogus"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("unknown command");
  });
});
