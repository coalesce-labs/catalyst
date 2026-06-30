// doctor-replica.test.mjs — CTL-1394. Tests for checkCloudSync() in doctor.mjs.
// All deps are injected so the test touches no fs/pgrep/launchctl. The load-bearing
// invariants: NEVER emit a FAIL record (it would block the catalyst-join activation
// gate), and NEVER leak a token VALUE. Run:
//   cd plugins/dev/scripts/execution-core && bun test doctor-replica
import { describe, test, expect } from "bun:test";
import { checkCloudSync } from "../doctor.mjs";

const NOW = 1_800_000_000_000;
const DB = "/tmp/ctl1394/catalyst-replica.db";
const TOKEN_ENV = { envVar: "CATALYST_CLOUD_TOKEN", source: "default" };

// "healthy" defaults; override per test.
function deps(over = {}) {
  return {
    label: "ai.coalesce.catalyst-cloud-sync",
    laDir: "/tmp/la",
    agentInstalled: () => true,
    processAlive: () => true,
    dbPath: DB,
    fileExists: (p) => p === DB || p === `${DB}.writer.lock`,
    statFile: () => ({ size: 64_000_000, mtimeMs: NOW - 5_000 }),
    mode: "on",
    tokenEnv: TOKEN_ENV,
    env: { [TOKEN_ENV.envVar]: "secret-value" },
    now: NOW,
    staleMs: 120_000,
    sizeFloorBytes: 65_536,
    ...over,
  };
}
const byName = (recs) => Object.fromEntries(recs.map((r) => [r.name, r]));
const noFail = (recs) => recs.every((r) => r.status !== "fail");

describe("checkCloudSync", () => {
  test("feature-off node (no agent, mode off, no db) → single INFO, no FAIL", () => {
    const recs = checkCloudSync(deps({ agentInstalled: () => false, mode: "off", fileExists: () => false }));
    expect(recs).toHaveLength(1);
    expect(recs[0].name).toBe("cloud-sync");
    expect(recs[0].status).toBe("info");
    expect(noFail(recs)).toBe(true);
  });

  test("healthy: agent running + fresh db + token set + flag on → all PASS", () => {
    const m = byName(checkCloudSync(deps()));
    expect(m["cloud-sync"].status).toBe("pass");
    expect(m["replica-fresh"].status).toBe("pass");
    expect(m["replica-token"].status).toBe("pass");
    expect(m["replica-read-flag"].status).toBe("pass");
  });

  test("token unset → replica-token WARN; the value never leaks", () => {
    const SECRET = "lin_should_never_appear";
    const recs = checkCloudSync(deps({ env: { SOME_OTHER: SECRET } }));
    const m = byName(recs);
    expect(m["replica-token"].status).toBe("warn");
    expect(m["replica-token"].detail).toContain(TOKEN_ENV.envVar);
    expect(JSON.stringify(recs)).not.toContain(SECRET);
  });

  test("token set to a sentinel → PASS reports only the NAME, never the value", () => {
    const SECRET = "lin_value_must_not_print";
    const recs = checkCloudSync(deps({ env: { [TOKEN_ENV.envVar]: SECRET } }));
    expect(JSON.stringify(recs)).not.toContain(SECRET);
    expect(byName(recs)["replica-token"].status).toBe("pass");
  });

  test("db absent → replica-fresh WARN (not connected)", () => {
    const m = byName(checkCloudSync(deps({ fileExists: () => false })));
    expect(m["replica-fresh"].status).toBe("warn");
    expect(m["replica-fresh"].detail).toMatch(/not connected|seeded/i);
  });

  test("db tiny → replica-fresh WARN (seed not applied)", () => {
    const m = byName(checkCloudSync(deps({ statFile: () => ({ size: 1000, mtimeMs: NOW }) })));
    expect(m["replica-fresh"].status).toBe("warn");
    expect(m["replica-fresh"].detail).toMatch(/tiny|seed/i);
  });

  test("all mtimes old incl the writer-lock (heartbeat stopped) → replica-fresh WARN (likely down)", () => {
    const m = byName(checkCloudSync(deps({ statFile: () => ({ size: 64_000_000, mtimeMs: NOW - 600_000 }) })));
    expect(m["replica-fresh"].status).toBe("warn");
    expect(m["replica-fresh"].detail).toMatch(/heartbeat stale|likely down/i);
  });

  // THE CORE FIX (my adversarial review): the DB/-wal mtime freezes on a quiet feed (the SDK
  // has no idle keepalive), but the writer-lock heartbeat keeps ticking — so a live writer on
  // a quiet feed must NOT be reported "down" just because no change landed recently.
  test("live writer-lock keeps a quiet-feed replica healthy — no false 'writer down' on stale DB mtime", () => {
    const recs = checkCloudSync(
      deps({
        statFile: (p) =>
          p.endsWith(".writer.lock")
            ? { size: 256, mtimeMs: NOW - 4_000 } // heartbeat ~4s ago = provably alive
            : { size: 64_000_000, mtimeMs: NOW - 1_800_000 }, // db/-wal 30 min stale (quiet feed)
      }),
    );
    const m = byName(recs);
    expect(m["replica-fresh"].status).toBe("pass");
    expect(m["replica-fresh"].detail).toMatch(/writer live/i);
    expect(m["replica-fresh"].detail).not.toMatch(/down/i);
  });

  test("no writer-lock (guard disabled): stale db → ambiguous WARN; fresh db → PASS", () => {
    const noLock = (mtime) => (p) => {
      if (p.endsWith(".writer.lock")) throw new Error("no lock");
      return { size: 64_000_000, mtimeMs: mtime };
    };
    const stale = byName(checkCloudSync(deps({ statFile: noLock(NOW - 600_000) })));
    expect(stale["replica-fresh"].status).toBe("warn");
    expect(stale["replica-fresh"].detail).toMatch(/no writer-lock/i);
    const fresh = byName(checkCloudSync(deps({ statFile: noLock(NOW - 5_000) })));
    expect(fresh["replica-fresh"].status).toBe("pass");
  });

  test("writer healthy + flag OFF → replica-read-flag WARN (flip it on)", () => {
    const m = byName(checkCloudSync(deps({ mode: "off" })));
    expect(m["replica-read-flag"].status).toBe("warn");
    expect(m["replica-read-flag"].detail).toMatch(/flip it on/i);
  });

  test("flag ON but db absent → replica-read-flag WARN (MISS-fallthrough)", () => {
    const m = byName(checkCloudSync(deps({ fileExists: () => false })));
    expect(m["replica-read-flag"].status).toBe("warn");
    expect(m["replica-read-flag"].detail).toMatch(/MISS/i);
  });

  test("agent installed but process dead → cloud-sync WARN", () => {
    const m = byName(checkCloudSync(deps({ processAlive: () => false, fileExists: (p) => p === DB })));
    expect(m["cloud-sync"].status).toBe("warn");
  });

  test("INVARIANT: no permutation ever yields a FAIL record", () => {
    const bools = [() => true, () => false];
    const stats = [
      () => ({ size: 64_000_000, mtimeMs: NOW }),
      () => ({ size: 10, mtimeMs: 0 }),
      () => { throw new Error("stat fail"); },
    ];
    for (const agentInstalled of bools)
      for (const processAlive of bools)
        for (const mode of ["on", "off"])
          for (const fileExists of bools)
            for (const statFile of stats)
              for (const env of [{ [TOKEN_ENV.envVar]: "x" }, {}]) {
                const recs = checkCloudSync(deps({ agentInstalled, processAlive, mode, fileExists, statFile, env }));
                expect(recs.every((r) => r.status !== "fail")).toBe(true);
              }
  });
});
