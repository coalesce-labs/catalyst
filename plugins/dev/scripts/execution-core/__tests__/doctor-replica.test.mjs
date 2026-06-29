// doctor-replica.test.mjs — CTL-1394. Tests for checkReplicaWriter() in doctor.mjs.
// All deps are injected so the test touches no fs/pgrep/launchctl. The load-bearing
// invariants: NEVER emit a FAIL record (it would block the catalyst-join activation
// gate), and NEVER leak a token VALUE. Run:
//   cd plugins/dev/scripts/execution-core && bun test doctor-replica
import { describe, test, expect } from "bun:test";
import { checkReplicaWriter } from "../doctor.mjs";

const NOW = 1_800_000_000_000;
const DB = "/tmp/ctl1394/catalyst-replica.db";
const TOKEN_ENV = { envVar: "CATALYST_MINI_ACCOUNT_TOKEN", source: "table" };

// "healthy" defaults; override per test.
function deps(over = {}) {
  return {
    label: "ai.coalesce.catalyst-replica-writer",
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

describe("checkReplicaWriter", () => {
  test("feature-off node (no agent, mode off, no db) → single INFO, no FAIL", () => {
    const recs = checkReplicaWriter(deps({ agentInstalled: () => false, mode: "off", fileExists: () => false }));
    expect(recs).toHaveLength(1);
    expect(recs[0].name).toBe("replica-writer");
    expect(recs[0].status).toBe("info");
    expect(noFail(recs)).toBe(true);
  });

  test("healthy: agent running + fresh db + token set + flag on → all PASS", () => {
    const m = byName(checkReplicaWriter(deps()));
    expect(m["replica-writer"].status).toBe("pass");
    expect(m["replica-fresh"].status).toBe("pass");
    expect(m["replica-token"].status).toBe("pass");
    expect(m["replica-read-flag"].status).toBe("pass");
  });

  test("token unset → replica-token WARN; the value never leaks", () => {
    const SECRET = "lin_should_never_appear";
    const recs = checkReplicaWriter(deps({ env: { SOME_OTHER: SECRET } }));
    const m = byName(recs);
    expect(m["replica-token"].status).toBe("warn");
    expect(m["replica-token"].detail).toContain(TOKEN_ENV.envVar);
    expect(JSON.stringify(recs)).not.toContain(SECRET);
  });

  test("token set to a sentinel → PASS reports only the NAME, never the value", () => {
    const SECRET = "lin_value_must_not_print";
    const recs = checkReplicaWriter(deps({ env: { [TOKEN_ENV.envVar]: SECRET } }));
    expect(JSON.stringify(recs)).not.toContain(SECRET);
    expect(byName(recs)["replica-token"].status).toBe("pass");
  });

  test("db absent → replica-fresh WARN (not connected)", () => {
    const m = byName(checkReplicaWriter(deps({ fileExists: () => false })));
    expect(m["replica-fresh"].status).toBe("warn");
    expect(m["replica-fresh"].detail).toMatch(/not connected|seeded/i);
  });

  test("db tiny → replica-fresh WARN (seed not applied)", () => {
    const m = byName(checkReplicaWriter(deps({ statFile: () => ({ size: 1000, mtimeMs: NOW }) })));
    expect(m["replica-fresh"].status).toBe("warn");
    expect(m["replica-fresh"].detail).toMatch(/tiny|seed/i);
  });

  test("db stale (old mtime) → replica-fresh WARN", () => {
    const m = byName(checkReplicaWriter(deps({ statFile: () => ({ size: 64_000_000, mtimeMs: NOW - 600_000 }) })));
    expect(m["replica-fresh"].status).toBe("warn");
    expect(m["replica-fresh"].detail).toMatch(/stale/i);
  });

  test("fresh -wal sidecar keeps a checkpointed (older main-db mtime) replica fresh", () => {
    // main db mtime is stale, but the writer's non-empty -wal was just appended → fresh.
    const recs = checkReplicaWriter(
      deps({
        statFile: (p) =>
          p.endsWith("-wal")
            ? { size: 4096, mtimeMs: NOW - 2_000 }
            : { size: 64_000_000, mtimeMs: NOW - 600_000 },
      }),
    );
    expect(byName(recs)["replica-fresh"].status).toBe("pass");
  });

  test("writer healthy + flag OFF → replica-read-flag WARN (flip it on)", () => {
    const m = byName(checkReplicaWriter(deps({ mode: "off" })));
    expect(m["replica-read-flag"].status).toBe("warn");
    expect(m["replica-read-flag"].detail).toMatch(/flip it on/i);
  });

  test("flag ON but db absent → replica-read-flag WARN (MISS-fallthrough)", () => {
    const m = byName(checkReplicaWriter(deps({ fileExists: () => false })));
    expect(m["replica-read-flag"].status).toBe("warn");
    expect(m["replica-read-flag"].detail).toMatch(/MISS/i);
  });

  test("agent installed but process dead → replica-writer WARN", () => {
    const m = byName(checkReplicaWriter(deps({ processAlive: () => false, fileExists: (p) => p === DB })));
    expect(m["replica-writer"].status).toBe("warn");
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
                const recs = checkReplicaWriter(deps({ agentInstalled, processAlive, mode, fileExists, statFile, env }));
                expect(recs.every((r) => r.status !== "fail")).toBe(true);
              }
  });
});
