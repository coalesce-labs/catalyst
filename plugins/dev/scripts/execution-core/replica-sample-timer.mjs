import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, openSync, readSync, closeSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { getReplicaDbPath, log as defaultLog } from "./config.mjs";
import { listProjects } from "./registry.mjs";

export const DEFAULTS = { intervalSeconds: 300 };
const SQLITE_MAGIC = "SQLite format 3\0";

export function defaultProbe(dbPath) {
  if (!existsSync(dbPath)) return { dbPresent: false };
  const out = { dbPresent: true, sizeBytes: null, isSqlite: false, tables: null, issueRows: null, teams: null, cursor: null, lockMtimeMs: null };
  try { out.sizeBytes = statSync(dbPath).size; } catch { /* unreadable */ }
  try { out.lockMtimeMs = statSync(`${dbPath}.writer.lock`).mtimeMs; } catch { /* absent is unknown */ }
  let fd = null;
  try { fd = openSync(dbPath, "r"); const buf = Buffer.alloc(SQLITE_MAGIC.length); out.isSqlite = readSync(fd, buf, 0, buf.length, 0) === buf.length && buf.toString("latin1") === SQLITE_MAGIC; }
  catch { /* unreadable */ } finally { if (fd !== null) try { closeSync(fd); } catch { /* closed */ } }
  if (out.sizeBytes === 0 || !out.isSqlite) return out;
  let db = null;
  try {
    db = new Database(dbPath, { readonly: true }); db.run("PRAGMA busy_timeout = 250");
    out.tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
    if (out.tables.includes("issues")) {
      out.issueRows = Number(db.prepare("SELECT COUNT(*) AS n FROM issues").get()?.n) || 0;
      out.teams = db.prepare("SELECT DISTINCT substr(identifier, 1, instr(identifier, '-') - 1) AS team FROM issues WHERE instr(identifier, '-') > 1").all().map((row) => row.team).filter(Boolean).sort();
    }
    if (out.tables.includes("sync_meta")) out.cursor = db.prepare("SELECT value FROM sync_meta WHERE key = 'cursor'").get()?.value ?? null;
  } finally { try { db?.close(); } catch { /* closed */ } }
  return out;
}

export function readReplicaSweepConfig(configPath) {
  if (!configPath) return {};
  try { return JSON.parse(readFileSync(configPath, "utf8"))?.catalyst?.orchestration?.replicaSweep ?? {}; }
  catch (err) { if (err?.code !== "ENOENT") defaultLog.warn({ configPath, err: err?.message }, "replica-sample-timer: config unreadable; using defaults"); return {}; }
}
export function readReplicaState(orchDir, { readFile = readFileSync, log = defaultLog } = {}) {
  const path = join(orchDir, "replica-state.json"); let raw;
  try { raw = readFile(path, "utf8"); } catch { return null; }
  try { return JSON.parse(raw); } catch (err) { log?.warn?.({ path, err: err?.message }, "replica-sample-timer: replica-state.json corrupt — skipping"); return null; }
}
export function resolveIntervalMs(intervalSeconds, log = defaultLog) {
  const n = Number(intervalSeconds);
  if (!Number.isFinite(n) || n <= 0) { log?.warn?.({ intervalSeconds, fallbackSeconds: DEFAULTS.intervalSeconds }, "replica-sample-timer: invalid interval; using default"); return DEFAULTS.intervalSeconds * 1_000; }
  return Math.max(1, n) * 1_000;
}
const realClock = () => ({ setInterval, clearInterval, now: () => Date.now() });
export function sampleReplicaOnce({ orchDir, dbPath = getReplicaDbPath(), probe = defaultProbe, registeredTeams = () => listProjects().map((p) => p.team), clock = realClock(), now, host = hostname(), log = defaultLog, fileOps = { writeFileSync, renameSync }, mkdir = (dir) => mkdirSync(dir, { recursive: true }) } = {}) {
  if (!orchDir) return false;
  try {
    const probed = probe(dbPath); if (!probed) return false; let teams = [];
    try { teams = [...new Set(registeredTeams())].filter((team) => typeof team === "string" && team).sort(); } catch (err) { log?.warn?.({ err: err?.message }, "replica-sample-timer: registry read failed"); }
    const nowMs = typeof now === "function" ? now() : clock.now(); const snapshot = { ...probed, registeredTeams: teams, host, dbPath, sampledAt: new Date(nowMs).toISOString() };
    mkdir(orchDir); const finalPath = join(orchDir, "replica-state.json"); const tmpPath = join(orchDir, `replica-state.json.tmp.${process.pid}`);
    fileOps.writeFileSync(tmpPath, JSON.stringify(snapshot)); fileOps.renameSync(tmpPath, finalPath); return true;
  } catch (err) { log?.warn?.({ err: err?.message }, "replica-sample-timer: sample error"); return false; }
}
export function startReplicaSampleTimer({ orchDir, intervalSeconds = DEFAULTS.intervalSeconds, enabled = false, primeImmediately = false, ...rest } = {}) {
  if (!enabled || !orchDir) return { stop: () => {}, primed: false };
  const clock = rest.clock ?? realClock(); const sample = () => sampleReplicaOnce({ orchDir, ...rest, clock }); const primed = primeImmediately ? sample() : false;
  const handle = clock.setInterval(sample, resolveIntervalMs(intervalSeconds, rest.log ?? defaultLog)); handle?.unref?.();
  return { stop: () => clock.clearInterval(handle), primed };
}
