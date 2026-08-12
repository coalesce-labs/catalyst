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

// CTL-1612 round 2 (Codex P2): cmd_start now mints the monitor's scoped
// app-actor token via linear_app_actor_auth, which resolves
// catalyst.linear.bot.orchestrator.{clientId,clientSecret} through the shared
// secret-contract chain — on a host with real orchestrator creds configured
// (any dev machine running the broker/execution-core) every "start" run in
// this file is a REAL POST to https://api.linear.app/oauth/token.
// CATALYST_LAYER2_CONFIG_FILE is checked FIRST in that chain
// (unconditionally, before CATALYST_MACHINE_CONFIG/XDG/~/.config), so pinning
// it to an absent sandbox path seals the read with no fallback — same fix as
// __tests__/catalyst-monitor-dist-redirect.test.sh's run_cmd_start. The other
// two keys are unset (Bun.spawn treats an `undefined` value as "omit this
// var") rather than pinned, since a stale inherited value would otherwise
// survive the `...process.env` spread below.
function sandboxSecretEnv(dir: string): Record<string, string | undefined> {
  return {
    CATALYST_LAYER2_CONFIG_FILE: join(dir, "absent-layer2-config.json"),
    CATALYST_MACHINE_CONFIG: undefined,
    CATALYST_MONITOR_APP_ACTOR_TOKEN: undefined,
  };
}

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
      MONITOR_SKIP_BOOTSTRAP: "1",
      ...env,
      ...sandboxSecretEnv(tmpDir),
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
    expect(stdout).toContain("restart");
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
    expect("runningVersion" in data).toBe(true);
    expect("latestAvailableVersion" in data).toBe(true);
    expect("isStale" in data).toBe(true);
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
    expect("runningVersion" in data).toBe(true);
    expect("latestAvailableVersion" in data).toBe(true);
    expect("isStale" in data).toBe(true);
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

  it("restart subcommand exists and is dispatched", () => {
    // restart with no running daemon should call start (which we skip past
    // by triggering bootstrap failure via missing SERVER_SCRIPT). We just
    // need to confirm dispatch routes correctly — not "unknown command".
    const { stderr } = run(["restart"], {
      MONITOR_SERVER_SCRIPT: "/nonexistent/server.ts",
      MONITOR_SKIP_BOOTSTRAP: "0",
    });
    expect(stderr).not.toContain("unknown command");
  });
});

// CAT-53: the stack supervisor should reap an orphan squatting a service
// port rather than silently failing to start. These tests use their OWN
// isolated tmpDir/pidFile/port — deliberately never the shared fixtures or
// the default 7400 (this suite may run on a host with a REAL production
// monitor already bound to 7400; a naive test here could otherwise probe or,
// worse, kill a live process). Every port is dynamically allocated per test.
describe("catalyst-monitor.sh orphan port reap (CAT-53)", () => {
  let cat53Dir: string;
  let cat53PidFile: string;
  const spawnedPids: number[] = [];

  beforeAll(() => {
    cat53Dir = mkdtempSync(join(tmpdir(), "catalyst-monitor-cat53-"));
    mkdirSync(join(cat53Dir, "wt"), { recursive: true });
    cat53PidFile = join(cat53Dir, "monitor.pid");
  });

  afterEach(() => {
    // Belt-and-suspenders: kill anything this test spawned that might have
    // survived an assertion failure, plus whatever cmd_start itself started.
    for (const pid of spawnedPids.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already dead */
      }
    }
    if (existsSync(cat53PidFile)) {
      try {
        const pid = parseInt(readFileSync(cat53PidFile, "utf-8").trim(), 10);
        process.kill(pid, "SIGKILL");
      } catch {
        /* already dead */
      }
      rmSync(cat53PidFile, { force: true });
    }
  });

  afterAll(() => {
    if (cat53Dir) {
      try {
        rmSync(cat53Dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  // A free ephemeral port, picked fresh per test (bind :0, read back, close).
  async function freePort(): Promise<number> {
    const srv = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {}, open() {}, close() {} },
    });
    const port = srv.port;
    srv.stop(true);
    return port;
  }

  // Spawns a real listener on `port`, backgrounds it, and lets its OWN
  // parent shell exit — the kernel reparents the listener to PID 1, the
  // exact "orphan from an earlier stack generation" shape CAT-53 describes.
  // Returns the orphan's real PID (read back from a marker file, since the
  // wrapper shell — not the orphan — is what Bun.spawnSync's own PID names).
  function spawnRealOrphanListener(port: number): number {
    const marker = join(cat53Dir, `orphan-pid-${port}`);
    const listenScript = `Bun.listen({hostname:'127.0.0.1',port:${port},socket:{data(){},open(){},close(){}}});setInterval(()=>{},1000);`;
    const wrapper = `nohup bun -e "${listenScript}" >/dev/null 2>&1 & echo $! > '${marker}'; disown; exit 0`;
    Bun.spawnSync(["bash", "-c", wrapper]);
    const pid = parseInt(readFileSync(marker, "utf-8").trim(), 10);
    rmSync(marker, { force: true });
    return pid;
  }

  // A normal (non-orphan) listener — parent is this test process, so its
  // PPID is real and live. Used to prove the reap logic fails CLOSED.
  function spawnNormalListener(port: number): { proc: any; pid: number } {
    const proc = Bun.spawn([
      "bun",
      "-e",
      `Bun.listen({hostname:'127.0.0.1',port:${port},socket:{data(){},open(){},close(){}}});setInterval(()=>{},1000);`,
    ]);
    return { proc, pid: proc.pid };
  }

  function pidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  function ppidOf(pid: number): string {
    const r = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)]);
    return r.stdout.toString().trim();
  }

  async function waitForPortBound(port: number, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = Bun.spawnSync(["bash", "-c", `lsof -ti :${port} -sTCP:LISTEN`]);
      if (r.stdout.toString().trim()) return;
      Bun.sleepSync(50);
    }
    throw new Error(`port ${port} never became bound`);
  }

  it("real orphan fixture: reparents to PPID 1", async () => {
    const port = await freePort();
    const pid = spawnRealOrphanListener(port);
    spawnedPids.push(pid);
    await waitForPortBound(port);
    expect(ppidOf(pid)).toBe("1");
    expect(pidAlive(pid)).toBe(true);
  });

  it("start reaps a PPID-1 orphan squatting the port, then binds clean", async () => {
    const port = await freePort();
    const orphanPid = spawnRealOrphanListener(port);
    spawnedPids.push(orphanPid);
    await waitForPortBound(port);
    expect(ppidOf(orphanPid)).toBe("1");

    const { exitCode } = Bun.spawnSync(["bash", SCRIPT, "start"], {
      env: {
        ...process.env,
        CATALYST_DIR: cat53Dir,
        MONITOR_PID_FILE: cat53PidFile,
        MONITOR_PORT: String(port),
        MONITOR_SERVER_SCRIPT: SERVER_SCRIPT,
        MONITOR_SKIP_BOOTSTRAP: "1",
        CATALYST_LAYER2_CONFIG_FILE: join(cat53Dir, "absent-layer2-config.json"),
        CATALYST_MACHINE_CONFIG: undefined,
        CATALYST_MONITOR_APP_ACTOR_TOKEN: undefined,
      },
      cwd: cat53Dir,
    });

    // The orphan must be gone — reaped before the real monitor tried to bind.
    expect(pidAlive(orphanPid)).toBe(false);
    expect(exitCode).toBe(0);

    Bun.sleepSync(500);
    expect(existsSync(cat53PidFile)).toBe(true);
    const newPid = parseInt(readFileSync(cat53PidFile, "utf-8").trim(), 10);
    expect(newPid).not.toBe(orphanPid);
    expect(pidAlive(newPid)).toBe(true);
    spawnedPids.push(newPid);
  });

  it("start does NOT reap a port holder with a live (non-1) PPID", async () => {
    const port = await freePort();
    const { proc, pid: holderPid } = spawnNormalListener(port);
    spawnedPids.push(holderPid);
    await waitForPortBound(port);
    expect(ppidOf(holderPid)).not.toBe("1");
    expect(pidAlive(holderPid)).toBe(true);

    const { exitCode } = Bun.spawnSync(["bash", SCRIPT, "start"], {
      env: {
        ...process.env,
        CATALYST_DIR: cat53Dir,
        MONITOR_PID_FILE: cat53PidFile,
        MONITOR_PORT: String(port),
        MONITOR_SERVER_SCRIPT: SERVER_SCRIPT,
        MONITOR_SKIP_BOOTSTRAP: "1",
        CATALYST_LAYER2_CONFIG_FILE: join(cat53Dir, "absent-layer2-config.json"),
        CATALYST_MACHINE_CONFIG: undefined,
        CATALYST_MONITOR_APP_ACTOR_TOKEN: undefined,
      },
      cwd: cat53Dir,
    });

    // Fails closed: the live, non-orphan holder is left alone, and
    // cmd_start explicitly refuses to start rather than risk a second
    // monitor silently binding alongside it.
    expect(pidAlive(holderPid)).toBe(true);
    expect(exitCode).not.toBe(0);
    expect(existsSync(cat53PidFile)).toBe(false);

    proc.kill();
  });
});

describe("catalyst-monitor.sh version drift detection", () => {
  let cacheRoot: string;
  let versionFile: string;

  beforeAll(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), "catalyst-monitor-cache-"));
    versionFile = join(tmpDir, "test-version.txt");
  });

  afterAll(() => {
    if (cacheRoot) {
      try {
        rmSync(cacheRoot, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  function setCache(versions: string[]) {
    // Reset
    rmSync(cacheRoot, { recursive: true, force: true });
    mkdirSync(cacheRoot, { recursive: true });
    for (const v of versions) {
      mkdirSync(join(cacheRoot, v), { recursive: true });
    }
  }

  function setRunningVersion(v: string) {
    writeFileSync(versionFile, v + "\n");
  }

  it("isStale=true when running < latest in cache", () => {
    setRunningVersion("8.0.0");
    setCache(["7.12.1", "8.0.0", "8.1.0"]);

    const { stdout, exitCode } = run(["status", "--json"], {
      CATALYST_VERSION_FILE: versionFile,
      CATALYST_PLUGIN_CACHE_ROOT: cacheRoot,
    });
    expect(exitCode).toBe(1);
    const data = JSON.parse(stdout);
    expect(data.runningVersion).toBe("8.0.0");
    expect(data.latestAvailableVersion).toBe("8.1.0");
    expect(data.isStale).toBe(true);
  });

  it("isStale=false when running == latest in cache", () => {
    setRunningVersion("8.1.0");
    setCache(["7.12.1", "8.0.0", "8.1.0"]);

    const { stdout } = run(["status", "--json"], {
      CATALYST_VERSION_FILE: versionFile,
      CATALYST_PLUGIN_CACHE_ROOT: cacheRoot,
    });
    const data = JSON.parse(stdout);
    expect(data.runningVersion).toBe("8.1.0");
    expect(data.latestAvailableVersion).toBe("8.1.0");
    expect(data.isStale).toBe(false);
  });

  it("isStale=false when running > latest in cache (dev clone ahead of releases)", () => {
    setRunningVersion("9.0.0");
    setCache(["8.0.0", "8.1.0"]);

    const { stdout } = run(["status", "--json"], {
      CATALYST_VERSION_FILE: versionFile,
      CATALYST_PLUGIN_CACHE_ROOT: cacheRoot,
    });
    const data = JSON.parse(stdout);
    expect(data.runningVersion).toBe("9.0.0");
    expect(data.latestAvailableVersion).toBe("8.1.0");
    expect(data.isStale).toBe(false);
  });

  it("handles missing version.txt gracefully (null running, not stale)", () => {
    setCache(["8.0.0", "8.1.0"]);

    const { stdout } = run(["status", "--json"], {
      CATALYST_VERSION_FILE: "/nonexistent/version.txt",
      CATALYST_PLUGIN_CACHE_ROOT: cacheRoot,
    });
    const data = JSON.parse(stdout);
    expect(data.runningVersion).toBeNull();
    expect(data.isStale).toBe(false);
  });

  it("handles missing plugin cache directory (null latest, not stale)", () => {
    setRunningVersion("8.1.0");

    const { stdout } = run(["status", "--json"], {
      CATALYST_VERSION_FILE: versionFile,
      CATALYST_PLUGIN_CACHE_ROOT: "/nonexistent/cache",
    });
    const data = JSON.parse(stdout);
    expect(data.runningVersion).toBe("8.1.0");
    expect(data.latestAvailableVersion).toBeNull();
    expect(data.isStale).toBe(false);
  });

  it("ignores non-semver entries in plugin cache", () => {
    setRunningVersion("8.0.0");
    rmSync(cacheRoot, { recursive: true, force: true });
    mkdirSync(join(cacheRoot, "8.0.0"), { recursive: true });
    mkdirSync(join(cacheRoot, "8.1.0"), { recursive: true });
    mkdirSync(join(cacheRoot, "current"), { recursive: true });
    mkdirSync(join(cacheRoot, "broken-dir"), { recursive: true });

    const { stdout } = run(["status", "--json"], {
      CATALYST_VERSION_FILE: versionFile,
      CATALYST_PLUGIN_CACHE_ROOT: cacheRoot,
    });
    const data = JSON.parse(stdout);
    expect(data.latestAvailableVersion).toBe("8.1.0");
  });

  it("compares versions numerically, not lexically (10.0.0 > 9.0.0)", () => {
    setRunningVersion("9.0.0");
    setCache(["9.0.0", "10.0.0"]);

    const { stdout } = run(["status", "--json"], {
      CATALYST_VERSION_FILE: versionFile,
      CATALYST_PLUGIN_CACHE_ROOT: cacheRoot,
    });
    const data = JSON.parse(stdout);
    expect(data.latestAvailableVersion).toBe("10.0.0");
    expect(data.isStale).toBe(true);
  });

  it("start prints version drift warning to stderr when stale", () => {
    setRunningVersion("8.0.0");
    setCache(["8.0.0", "8.1.0"]);

    const { stderr } = run(["start"], {
      CATALYST_VERSION_FILE: versionFile,
      CATALYST_PLUGIN_CACHE_ROOT: cacheRoot,
    });
    expect(stderr).toContain("v8.0.0");
    expect(stderr).toContain("v8.1.0");
    expect(stderr).toContain("warning");
  });

  it("start does NOT print warning when current", () => {
    setRunningVersion("8.1.0");
    setCache(["8.0.0", "8.1.0"]);

    const { stderr } = run(["start"], {
      CATALYST_VERSION_FILE: versionFile,
      CATALYST_PLUGIN_CACHE_ROOT: cacheRoot,
    });
    expect(stderr).not.toContain("v8.0.0");
    expect(stderr).not.toContain("warning: catalyst-monitor running");
  });

  it("warning suppressed when catalyst.monitor.suppressVersionWarning=true in .catalyst/config.json", () => {
    setRunningVersion("8.0.0");
    setCache(["8.0.0", "8.1.0"]);

    const projectDir = mkdtempSync(join(tmpdir(), "catalyst-monitor-proj-"));
    mkdirSync(join(projectDir, ".catalyst"), { recursive: true });
    writeFileSync(
      join(projectDir, ".catalyst/config.json"),
      JSON.stringify({
        catalyst: { monitor: { suppressVersionWarning: true } },
      }),
    );

    // Run from the project dir so the script's two-location config probe finds it
    const result = Bun.spawnSync(["bash", SCRIPT, "start"], {
      env: {
        ...process.env,
        CATALYST_DIR: tmpDir,
        MONITOR_PID_FILE: pidFile,
        MONITOR_SERVER_SCRIPT: SERVER_SCRIPT,
        MONITOR_SKIP_BOOTSTRAP: "1",
        CATALYST_VERSION_FILE: versionFile,
        CATALYST_PLUGIN_CACHE_ROOT: cacheRoot,
        ...sandboxSecretEnv(tmpDir),
      },
      cwd: projectDir,
    });
    const stderr = result.stderr.toString();
    expect(stderr).not.toContain("warning: catalyst-monitor running");

    rmSync(projectDir, { recursive: true, force: true });
  });
});
