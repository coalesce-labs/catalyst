import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer, ACCOUNTS_REFRESH_HEADER } from "../server";

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
  it("?refresh=true WITH the required header forces a new probe (admit path)", async () => {
    const before = calls;
    const r = await fetch(`${base}/api/accounts?refresh=true`, {
      headers: { [ACCOUNTS_REFRESH_HEADER]: "1" },
    });
    expect(r.status).toBe(200);
    expect(calls).toBe(before + 1);
  });
  it("?refresh=true WITHOUT the header is rejected (403), no probe spent (deny path)", async () => {
    // CTL-1653 Codex round-2: the header is what closes the simple-request /
    // originless-GET hole — an <img>/top-level-nav/plain-form GET (and a bare
    // curl call, and this fetch()) can never carry it unless deliberately set.
    const before = calls;
    const r = await fetch(`${base}/api/accounts?refresh=true`);
    expect(r.status).toBe(403);
    expect(calls).toBe(before); // no probe spawned
  });
  it("?refresh=true WITH the header but an untrusted cross-origin caller is still rejected (403)", async () => {
    // The header alone isn't sufficient either — the origin allowlist still
    // applies on top of it (defense in depth for a same-origin-page-with-
    // custom-header scenario the header check alone wouldn't catch).
    const before = calls;
    const r = await fetch(`${base}/api/accounts?refresh=true`, {
      headers: { [ACCOUNTS_REFRESH_HEADER]: "1", Origin: "http://evil.example:1234" },
    });
    expect(r.status).toBe(403);
    expect(calls).toBe(before); // no probe spawned
  });
  it("a plain (non-refresh) read needs neither the header nor a trusted origin", async () => {
    const r = await fetch(`${base}/api/accounts`, {
      headers: { Origin: "http://evil.example:1234" },
    });
    expect(r.status).toBe(200);
  });
  it("a DNS-rebinding-shaped request (foreign Host, header present, no Origin) is rejected (403)", async () => {
    // CTL-1653 Codex round-3: a page loaded as http://evil.example:<port> that
    // later re-resolves to THIS server's IP is same-origin to the browser once
    // rebound — its JS can attach the refresh header with no CORS preflight,
    // and a same-origin fetch isn't guaranteed to carry Origin either (which
    // originAllowed(null) would otherwise admit). The Host header is what the
    // browser's own HTTP stack sets from the page's URL — the attacker's
    // domain, not this server's real name — so it must be checked too. Same
    // physical connection (127.0.0.1/localhost) as every other test here, but
    // an untrusted Host is exactly what a rebound browser would send.
    const before = calls;
    const r = await fetch(`${base}/api/accounts?refresh=true`, {
      headers: { [ACCOUNTS_REFRESH_HEADER]: "1", Host: "evil.example:1234" },
    });
    expect(r.status).toBe(403);
    expect(calls).toBe(before); // no probe spawned
  });
  it("a request with the REAL Host (localhost:<port>) + the header succeeds (positive control)", async () => {
    const before = calls;
    const port = new URL(base).port;
    const r = await fetch(`${base}/api/accounts?refresh=true`, {
      headers: { [ACCOUNTS_REFRESH_HEADER]: "1", Host: `localhost:${port}` },
    });
    expect(r.status).toBe(200);
    expect(calls).toBe(before + 1);
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

describe("/api/accounts refresh behind an HTTPS reverse proxy", () => {
  // CTL-1653 Codex round-4: MONITOR_TRUSTED_ORIGINS' documented reverse-proxy
  // form is a FULL https:// origin, but Host carries no scheme — an
  // http://-only probe of the trusted set would 403 every legitimate proxied
  // refresh. The guard must accept a Host that matches a trusted origin under
  // EITHER scheme.
  let server: ReturnType<typeof createServer>;
  let tmpDir = "";
  let base = "";
  let calls = 0;
  let prevTrusted: string | undefined;
  beforeAll(() => {
    prevTrusted = process.env.MONITOR_TRUSTED_ORIGINS;
    process.env.MONITOR_TRUSTED_ORIGINS = "https://catalyst.internal.example";
    const dirs = mkWtDir("accounts-endpoint-https-");
    tmpDir = dirs.tmpDir;
    server = createServer({
      port: 0,
      wtDir: dirs.wtDir,
      startWatcher: false,
      accountsRefreshFloorMs: 0,
      accountsProbeExec: () => {
        calls += 1;
        return Promise.resolve(FAKE);
      },
    });
    base = `http://localhost:${server.port}`;
  });
  afterAll(() => {
    if (prevTrusted === undefined) delete process.env.MONITOR_TRUSTED_ORIGINS;
    else process.env.MONITOR_TRUSTED_ORIGINS = prevTrusted;
    void server.stop(true);
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  it("a proxied refresh (X-Forwarded-Proto https from loopback) whose Host matches the https trusted origin is admitted", async () => {
    const before = calls;
    const r = await fetch(`${base}/api/accounts?refresh=true`, {
      headers: {
        [ACCOUNTS_REFRESH_HEADER]: "1",
        Host: "catalyst.internal.example",
        Origin: "https://catalyst.internal.example",
        "X-Forwarded-Proto": "https",
      },
    });
    expect(r.status).toBe(200);
    expect(calls).toBe(before + 1);
  });
  it("the SAME request WITHOUT X-Forwarded-Proto is rejected — an https-only trusted host is never treated as plaintext", async () => {
    // CTL-1653 Codex round-5: a page served over plain HTTP for the trusted
    // hostname (originless same-origin GET) must not be able to spend the
    // probe when the config trusts only the https:// origin. Without the
    // proxy's X-Forwarded-Proto the effective scheme is http, and
    // http://catalyst.internal.example is deliberately NOT in the trusted set.
    const before = calls;
    const r = await fetch(`${base}/api/accounts?refresh=true`, {
      headers: { [ACCOUNTS_REFRESH_HEADER]: "1", Host: "catalyst.internal.example" },
    });
    expect(r.status).toBe(403);
    expect(calls).toBe(before);
  });
  it("an untrusted Host is still rejected even with the https set configured", async () => {
    const before = calls;
    const r = await fetch(`${base}/api/accounts?refresh=true`, {
      headers: { [ACCOUNTS_REFRESH_HEADER]: "1", Host: "evil.example" },
    });
    expect(r.status).toBe(403);
    expect(calls).toBe(before);
  });
});
