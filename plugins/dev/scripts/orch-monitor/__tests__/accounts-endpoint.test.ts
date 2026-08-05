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
