import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultProbe, readReplicaState, resolveIntervalMs, sampleReplicaOnce, startReplicaSampleTimer } from "./replica-sample-timer.mjs";

const fakeClock = () => { const timers = []; return { timers, setInterval: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; }, clearInterval: () => timers.splice(0), now: () => 1_786_000_000_000 }; };
const capture = () => { const writes = new Map(); return { writes, ops: { writeFileSync: (p, d) => writes.set(p, d), renameSync: (a, b) => writes.set(b, writes.get(a)) } }; };

describe("replica sampler", () => {
  test("the production SQLite probe reads rows, teams, cursor, and rejects non-SQLite files", () => {
    const dir = mkdtempSync(join(tmpdir(), "cat49-replica-")); const dbPath = join(dir, "replica.db");
    try {
      const db = new Database(dbPath); db.run("CREATE TABLE issues(identifier TEXT)"); db.run("CREATE TABLE sync_meta(key TEXT, value TEXT)");
      db.run("INSERT INTO issues VALUES ('CAT-49'), ('VAN-1')"); db.run("INSERT INTO sync_meta VALUES ('cursor', 'seeded')"); db.close();
      expect(defaultProbe(dbPath)).toMatchObject({ dbPresent: true, isSqlite: true, issueRows: 2, teams: ["CAT", "VAN"], cursor: "seeded" });
      const plain = join(dir, "plain"); writeFileSync(plain, "not sqlite"); expect(defaultProbe(plain)).toMatchObject({ dbPresent: true, isSqlite: false });
      expect(defaultProbe(join(dir, "absent"))).toEqual({ dbPresent: false });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("atomically publishes populated and absent snapshots", () => {
    for (const probed of [{ dbPresent: true, issueRows: 5 }, { dbPresent: false }]) {
      const { writes, ops } = capture();
      expect(sampleReplicaOnce({ orchDir: "/tmp/orch", clock: fakeClock(), fileOps: ops, mkdir: () => {}, probe: () => probed, registeredTeams: () => ["CAT"] })).toBe(true);
      expect(JSON.parse(writes.get("/tmp/orch/replica-state.json"))).toMatchObject({ ...probed, registeredTeams: ["CAT"] });
    }
  });
  test("probe failure is contained and registry failure degrades coverage only", () => {
    expect(sampleReplicaOnce({ orchDir: "/tmp/o", probe: () => { throw new Error("locked"); }, log: { warn() {} } })).toBe(false);
    const { writes, ops } = capture();
    expect(sampleReplicaOnce({ orchDir: "/tmp/orch", clock: fakeClock(), fileOps: ops, mkdir: () => {}, probe: () => ({ dbPresent: true }), registeredTeams: () => { throw new Error("registry"); }, log: { warn() {} } })).toBe(true);
    expect(JSON.parse(writes.get("/tmp/orch/replica-state.json")).registeredTeams).toEqual([]);
  });
  test("interval guard rejects spawn-storm values", () => {
    for (const bad of ["", "abc", 0, -1, NaN, {}]) expect(resolveIntervalMs(bad, { warn() {} })).toBe(300_000);
    expect(resolveIntervalMs(30)).toBe(30_000);
  });
  test("disabled is inert; enabled primes synchronously", () => {
    const disabled = fakeClock(); expect(startReplicaSampleTimer({ enabled: false, orchDir: "/tmp/o", clock: disabled }).primed).toBe(false); expect(disabled.timers).toHaveLength(0);
    const clock = fakeClock(); const { writes, ops } = capture();
    expect(startReplicaSampleTimer({ enabled: true, orchDir: "/tmp/orch", clock, fileOps: ops, mkdir: () => {}, probe: () => ({ dbPresent: true }), registeredTeams: () => [], primeImmediately: true }).primed).toBe(true);
    expect(writes.has("/tmp/orch/replica-state.json")).toBe(true); expect(clock.timers[0].ms).toBe(300_000);
  });
  test("missing and corrupt state reads return null", () => {
    expect(readReplicaState("/nope/nowhere")).toBeNull();
    expect(readReplicaState("/tmp/o", { readFile: () => "{oops", log: { warn() {} } })).toBeNull();
  });
});
