import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "../server";

const FAKE = {
  generatedAt: "2026-08-05T12:00:00.000Z",
  accounts: [
    {
      label: "acctA",
      isActive: true,
      email: "a@x.io",
      overallStatus: "rejected",
      representativeClaim: "seven_day",
      fiveHour: { pct: 40, resetsAt: "2026-08-05T13:00:00.000Z", status: "allowed" },
      sevenDay: { pct: 100, resetsAt: "2026-08-06T00:00:00.000Z", status: "rejected" },
      error: null,
      token: "sk-ant-oat-SHOULD-NOT-APPEAR",
    },
  ],
};

// Minimal shape of the /api/accounts response body (token-free by construction).
interface AccountsBody {
  available?: boolean;
  node?: string;
  status?: string;
  cached?: boolean;
  active?: {
    label?: string;
    email?: string;
    fiveHour?: { pct?: number };
    sevenDay?: { status?: string };
  };
}

function mkWtDir(prefix: string): { tmpDir: string; wtDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), prefix));
  const wtDir = join(tmpDir, "wt");
  mkdirSync(wtDir, { recursive: true });
  return { tmpDir, wtDir };
}

describe("/api/accounts", () => {
  let server: ReturnType<typeof createServer>;
  let tmpDir = "";
  let base = "";
  let calls = 0;
  beforeAll(() => {
    const dirs = mkWtDir("accounts-endpoint-");
    tmpDir = dirs.tmpDir;
    server = createServer({
      port: 0,
      wtDir: dirs.wtDir,
      startWatcher: false,
      // Disable the refresh floor so the ?refresh assertion exercises the route,
      // not the DoS throttle (the floor has its own unit tests in accounts-probe).
      accountsRefreshFloorMs: 0,
      accountsProbeExec: () => {
        calls += 1;
        return Promise.resolve(FAKE);
      },
    });
    base = `http://localhost:${server.port}`;
  });
  afterAll(() => {
    void server.stop(true);
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("returns node identity, active account, per-window data, overall status; NO token", async () => {
    const r = await fetch(`${base}/api/accounts`);
    const b = (await r.json()) as AccountsBody;
    expect(r.status).toBe(200);
    expect(typeof b.node).toBe("string");
    expect(b.active?.label).toBe("acctA");
    expect(b.active?.email).toBe("a@x.io");
    expect(b.active?.fiveHour?.pct).toBe(40);
    expect(b.active?.sevenDay?.status).toBe("rejected");
    expect(b.status).toBe("rejected");
    expect(JSON.stringify(b)).not.toContain("sk-ant-oat");
  });
  it("serves cache on a second call within TTL (no new probe)", async () => {
    const before = calls;
    await fetch(`${base}/api/accounts`);
    expect(calls).toBe(before); // cached, no probe spent
    const b = (await (await fetch(`${base}/api/accounts`)).json()) as AccountsBody;
    expect(b.cached).toBe(true);
  });
  it("?refresh=true forces a new probe", async () => {
    const before = calls;
    await fetch(`${base}/api/accounts?refresh=true`);
    expect(calls).toBe(before + 1);
  });
  it("?refresh=true from an untrusted cross-origin caller is rejected (403), no probe spent", async () => {
    const before = calls;
    const r = await fetch(`${base}/api/accounts?refresh=true`, {
      headers: { Origin: "http://evil.example:1234" },
    });
    expect(r.status).toBe(403);
    expect(calls).toBe(before); // no probe spawned
  });
  it("a plain (non-refresh) read is unaffected by a cross-origin caller", async () => {
    const r = await fetch(`${base}/api/accounts`, {
      headers: { Origin: "http://evil.example:1234" },
    });
    expect(r.status).toBe(200);
  });
});

describe("/api/accounts when the accounts env file is absent", () => {
  it("returns available:false (same contract as the disabled path), not available:true+status:unknown", async () => {
    const { tmpDir, wtDir } = mkWtDir("accounts-endpoint-no-env-");
    const s = createServer({
      port: 0,
      wtDir,
      startWatcher: false,
      // Mirrors defaultAccountsProbeExec's own no-env-file record.
      accountsProbeExec: () =>
        Promise.resolve({ generatedAt: new Date().toISOString(), accounts: [], available: false }),
    });
    const b = (await (await fetch(`http://localhost:${s.port}/api/accounts`)).json()) as AccountsBody;
    expect(b.available).toBe(false);
    expect(b.status).toBeUndefined();
    void s.stop(true);
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
});

describe("/api/accounts/stream", () => {
  it("emits an 'account' framed SSE event on connect", async () => {
    const { tmpDir, wtDir } = mkWtDir("accounts-stream-");
    const s = createServer({
      port: 0,
      wtDir,
      startWatcher: false,
      accountsProbeExec: () => Promise.resolve(FAKE),
      accountsTtlMs: 10,
    });
    const res = await fetch(`http://localhost:${s.port}/api/accounts/stream`, {
      headers: { Accept: "text/event-stream" },
    });
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("event: account");
    expect(text).toContain('"status"');
    await reader.cancel();
    void s.stop(true);
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
});

describe("/api/accounts disabled (accountsProbeExec:null)", () => {
  it("returns available:false, never spawns", async () => {
    const { tmpDir, wtDir } = mkWtDir("accounts-endpoint-disabled-");
    const s = createServer({ port: 0, wtDir, startWatcher: false, accountsProbeExec: null });
    const b = (await (
      await fetch(`http://localhost:${s.port}/api/accounts`)
    ).json()) as AccountsBody;
    expect(b.available).toBe(false);
    void s.stop(true);
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
});
