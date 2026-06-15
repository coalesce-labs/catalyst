import { Database } from "bun:sqlite";

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

let db: Database | null = null;

const DEFAULT_DB_DIR =
  process.env.CATALYST_DIR ?? `${process.env.HOME}/catalyst`;

export function openDb(
  dbPath: string = `${DEFAULT_DB_DIR}/push-subscriptions.db`,
): Database {
  if (db) return db;
  db = new Database(dbPath, { create: true });
  db.run("PRAGMA journal_mode=WAL");
  db.run(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint    TEXT PRIMARY KEY,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    last_used_at TEXT
  )`);
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

function ensureDb(): Database {
  if (!db) throw new Error("push-subscriptions: openDb() first");
  return db;
}

export function upsertSubscription(sub: PushSubscriptionRecord): void {
  ensureDb().run(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth`,
    [sub.endpoint, sub.keys.p256dh, sub.keys.auth, new Date().toISOString()],
  );
}

export function listSubscriptions(): PushSubscriptionRecord[] {
  return (
    ensureDb()
      .query(`SELECT endpoint, p256dh, auth FROM push_subscriptions`)
      .all() as Array<{ endpoint: string; p256dh: string; auth: string }>
  ).map((r) => ({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }));
}

export function deleteSubscription(endpoint: string): void {
  ensureDb().run(`DELETE FROM push_subscriptions WHERE endpoint = ?`, [
    endpoint,
  ]);
}

export function touchLastUsed(endpoint: string): void {
  ensureDb().run(
    `UPDATE push_subscriptions SET last_used_at = ? WHERE endpoint = ?`,
    [new Date().toISOString(), endpoint],
  );
}
