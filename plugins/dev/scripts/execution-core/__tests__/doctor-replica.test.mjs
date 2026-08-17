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
    // CAT-35: schema verification seams — injected so this suite keeps touching no
    // fs/spawn. Healthy default = a real SQLite file carrying both required tables.
    isSqliteFile: () => true,
    readDbTables: () => ["issues", "sync_meta", "labels"],
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

  test("0-byte replica reports never-seeded schema", () => {
    const m = byName(checkCloudSync(deps({ statFile: () => ({ size: 0, mtimeMs: NOW }) })));
    expect(m["replica-schema"].status).toBe("warn");
    expect(m["replica-schema"].detail).toMatch(/never seeded|no schema|0 bytes/i);
  });

  test("unreadable replica does not report a never-seeded schema", () => {
    const m = byName(checkCloudSync(deps({ statFile: () => { throw new Error("permission denied"); } })));
    expect(m["replica-schema"].status).toBe("warn");
    expect(m["replica-schema"].detail).toMatch(/unreadable/i);
    expect(m["replica-schema"].detail).not.toMatch(/never seeded|0 bytes/i);
  });

  test("seeded-but-stale replica passes schema check", () => {
    const m = byName(checkCloudSync(deps({ statFile: () => ({ size: 4_000_000, mtimeMs: NOW - 86_400_000 }) })));
    expect(m["replica-schema"].status).toBe("pass");
    expect(m["replica-schema"].detail).toMatch(/issues \+ sync_meta present/);
  });

  // CAT-35 (Codex round 1): size alone must never earn a PASS. A large file that is
  // not a database, or is a database missing the tables the production reader
  // prepares against, previously reported "schema seeded" while every read missed.
  test("large non-SQLite file above the floor does NOT pass schema check", () => {
    const m = byName(checkCloudSync(deps({ isSqliteFile: () => false })));
    expect(m["replica-schema"].status).toBe("warn");
    expect(m["replica-schema"].detail).toMatch(/no SQLite header|corrupt/i);
  });

  test("valid SQLite file missing a required table does NOT pass schema check", () => {
    const m = byName(checkCloudSync(deps({ readDbTables: () => ["issues"] })));
    expect(m["replica-schema"].status).toBe("warn");
    expect(m["replica-schema"].detail).toMatch(/sync_meta/);
  });

  test("no sqlite3 reader → unverified INFO, never a PASS claiming a seeded schema", () => {
    const m = byName(checkCloudSync(deps({ readDbTables: () => null })));
    expect(m["replica-schema"].status).toBe("info");
    expect(m["replica-schema"].detail).toMatch(/unverified/i);
  });

  test("header/table verification never introduces a FAIL", () => {
    for (const over of [{ isSqliteFile: () => false }, { readDbTables: () => [] }, { readDbTables: () => null }]) {
      expect(noFail(checkCloudSync(deps(over)))).toBe(true);
    }
  });

  test("tier-inert summary names token and read flag gaps", () => {
    const m = byName(checkCloudSync(deps({ mode: "off", env: {}, statFile: () => ({ size: 0, mtimeMs: NOW }) })));
    expect(m["replica-tier"].status).toBe("warn");
    expect(m["replica-tier"].detail).toMatch(/token/i);
    expect(m["replica-tier"].detail).toMatch(/CATALYST_LINEAR_REPLICA/);
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

// ─────────────────────────────────────────────────────────────────────────────
// ⛔ CTL-1913 — doctor must be ABLE to FAIL on a permanently-inert replica.
//
// Before this, every check on this path was WARN/INFO, so nothing in the install
// path returned non-zero for a completely dead writer. The state that earns it:
// the agent is ADOPTED and the replica db has never been created. That does not
// heal — the writer exits 0 on an absent/misnamed/rejected token, and under
// KeepAlive={SuccessfulExit:false} launchd never retries.
//
// ⚠️ The capability is OPT-IN (`strict`) and wired into no profile, because
// doctor's exit code IS the catalyst-join activation gate and `do_doctor_gate`
// runs BEFORE `install-services` — a default FAIL would block the join that
// reinstalls the writer, i.e. block the self-heal for the condition it reports.
// The suite above (which asserts NEVER-FAIL across an exhaustive matrix) is the
// guard on that, and it still passes unchanged.
// ─────────────────────────────────────────────────────────────────────────────
describe("CTL-1913 — the never-seeded FAIL capability", () => {
  const LA = "/tmp/la";
  const LABEL = "ai.coalesce.catalyst-cloud-sync";
  // Adopted well past the grace, with no replica db: the terminal state.
  const inert = (over = {}) =>
    deps({
      agentInstalled: () => true,
      fileExists: () => false, // no replica db, no writer-lock
      agentInstalledAt: () => NOW - 3_600_000, // adopted an hour ago
      neverSeededGraceMs: 900_000,
      ...over,
    });

  test("strict:true + adopted an hour ago + no replica → replica-fresh FAILs", () => {
    const m = byName(checkCloudSync(inert({ strict: true })));
    expect(m["replica-fresh"].status).toBe("fail");
    expect(m["replica-fresh"].detail).toMatch(/never been created/i);
    // The message must carry the ACTIONABLE cause, not just the symptom: the
    // clean-exit/KeepAlive mechanism is why an operator cannot just wait.
    expect(m["replica-fresh"].detail).toMatch(/never retries|does NOT self-heal/i);
  });

  test("⭐ DEFAULT (no strict) on the identical state → WARN, never FAIL", () => {
    // The join-gate invariant. Same fixture, strict omitted.
    const recs = checkCloudSync(inert());
    expect(byName(recs)["replica-fresh"].status).toBe("warn");
    expect(recs.every((r) => r.status !== "fail")).toBe(true);
  });

  test("strict:true but WITHIN the grace → WARN (a fresh adoption is not a fault)", () => {
    // NEGATIVE CONTROL for the FAIL: without it, the assertion above could be
    // satisfied by a check that FAILs on any missing db under strict, which would
    // fire on every legitimate fresh install.
    const m = byName(checkCloudSync(inert({ strict: true, agentInstalledAt: () => NOW - 60_000 })));
    expect(m["replica-fresh"].status).toBe("warn");
    expect(m["replica-fresh"].detail).toMatch(/first-seed window|has not seeded/i);
  });

  test("⛔ strict:true but the adoption time is UNREADABLE → WARN, not FAIL", () => {
    // "Could not look" is not evidence of the terminal state. An unreadable plist
    // mtime must not be escalated — and it must not be silently treated as 0
    // either, which would compute an age of ~56 years and FAIL instantly.
    for (const bad of [null, undefined, NaN, "nope"]) {
      const m = byName(checkCloudSync(inert({ strict: true, agentInstalledAt: () => bad })));
      expect(m["replica-fresh"].status, String(bad)).toBe("warn");
      expect(m["replica-fresh"].detail, String(bad)).toMatch(/unreadable|not connected/i);
    }
  });

  test("strict:true with NO agent adopted → WARN (nothing was provisioned to be broken)", () => {
    const m = byName(checkCloudSync(inert({ strict: true, agentInstalled: () => false, mode: "on" })));
    expect(m["replica-fresh"].status).toBe("warn");
  });

  test("strict:true with a HEALTHY replica → no FAIL anywhere", () => {
    // Proves strict does not simply redden a working host.
    const recs = checkCloudSync(deps({ strict: true }));
    expect(recs.every((r) => r.status !== "fail")).toBe(true);
    expect(byName(recs)["replica-fresh"].status).toBe("pass");
  });

  test("the real adoption-time probe reads the plist mtime, and returns null when absent", () => {
    // The injected seam above is only honest if the DEFAULT it replaces actually
    // works. Drive checkCloudSync with no agentInstalledAt override against a
    // LaunchAgents dir that does not exist: the default probe must fail to a WARN
    // (null) rather than throwing or fabricating a timestamp.
    const recs = checkCloudSync(
      deps({
        strict: true,
        agentInstalled: () => true,
        fileExists: () => false,
        laDir: "/tmp/definitely-not-a-launchagents-dir-ctl1913",
        label: LABEL,
      }),
    );
    const m = byName(recs);
    expect(m["replica-fresh"].status).toBe("warn"); // null age ⇒ no escalation
    expect(recs.every((r) => r.status !== "fail")).toBe(true);
    expect(LA).toBe("/tmp/la"); // (fixture sanity; keeps the constant referenced)
  });
});
