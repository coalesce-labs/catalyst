import { Database } from "bun:sqlite";

export interface NoteEntry {
  text: string;
  createdAt: string;
}

export interface SessionAnnotation {
  sessionId: string;
  displayName: string | null;
  flags: string[];
  notes: NoteEntry[];
  tags: string[];
  updatedAt: string;
}

let db: Database | null = null;

const DEFAULT_DB_DIR =
  process.env.CATALYST_DIR ?? `${process.env.HOME}/catalyst`;

export function openDb(
  dbPath: string = `${DEFAULT_DB_DIR}/annotations.db`,
): Database {
  if (db) return db;
  db = new Database(dbPath, { create: true });
  db.run("PRAGMA journal_mode=WAL");
  db.run(`
    CREATE TABLE IF NOT EXISTS session_annotations (
      session_id TEXT PRIMARY KEY,
      display_name TEXT,
      flags TEXT NOT NULL DEFAULT '[]',
      notes TEXT NOT NULL DEFAULT '[]',
      tags TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    )
  `);
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

function ensureDb(): Database {
  if (!db) throw new Error("Database not opened — call openDb() first");
  return db;
}

function now(): string {
  return new Date().toISOString();
}

function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch (err) {
    console.warn("[annotations] corrupt JSON in DB column:", raw, err);
    return [];
  }
}

interface RawRow {
  session_id: string;
  display_name: string | null;
  flags: string;
  notes: string;
  tags: string;
  updated_at: string;
}

function rowToAnnotation(row: RawRow): SessionAnnotation {
  return {
    sessionId: row.session_id,
    displayName: row.display_name,
    flags: parseJsonArray<string>(row.flags),
    notes: parseJsonArray<NoteEntry>(row.notes),
    tags: parseJsonArray<string>(row.tags),
    updatedAt: row.updated_at,
  };
}

export function getAnnotation(sessionId: string): SessionAnnotation | null {
  const d = ensureDb();
  const row = d
    .query("SELECT * FROM session_annotations WHERE session_id = ?")
    .get(sessionId) as RawRow | null;
  return row ? rowToAnnotation(row) : null;
}

export function getAllAnnotations(): Record<string, SessionAnnotation> {
  const d = ensureDb();
  const rows = d
    .query("SELECT * FROM session_annotations")
    .all() as RawRow[];
  const result: Record<string, SessionAnnotation> = {};
  for (const row of rows) {
    result[row.session_id] = rowToAnnotation(row);
  }
  return result;
}

function ensureRow(sessionId: string): void {
  const d = ensureDb();
  d.run(
    `INSERT OR IGNORE INTO session_annotations (session_id, updated_at) VALUES (?, ?)`,
    [sessionId, now()],
  );
}

export function setDisplayName(
  sessionId: string,
  name: string | null,
): void {
  ensureRow(sessionId);
  ensureDb().run(
    `UPDATE session_annotations SET display_name = ?, updated_at = ? WHERE session_id = ?`,
    [name, now(), sessionId],
  );
}

export function addFlag(sessionId: string, flag: string): void {
  ensureRow(sessionId);
  const ann = getAnnotation(sessionId);
  if (!ann || ann.flags.includes(flag)) return;
  const updated = [...ann.flags, flag];
  ensureDb().run(
    `UPDATE session_annotations SET flags = ?, updated_at = ? WHERE session_id = ?`,
    [JSON.stringify(updated), now(), sessionId],
  );
}

export function removeFlag(sessionId: string, flag: string): void {
  const ann = getAnnotation(sessionId);
  if (!ann) return;
  const updated = ann.flags.filter((f) => f !== flag);
  if (updated.length === ann.flags.length) return;
  ensureDb().run(
    `UPDATE session_annotations SET flags = ?, updated_at = ? WHERE session_id = ?`,
    [JSON.stringify(updated), now(), sessionId],
  );
}

export function addNote(sessionId: string, text: string): void {
  ensureRow(sessionId);
  const ann = getAnnotation(sessionId);
  if (!ann) return;
  const updated = [...ann.notes, { text, createdAt: now() }];
  ensureDb().run(
    `UPDATE session_annotations SET notes = ?, updated_at = ? WHERE session_id = ?`,
    [JSON.stringify(updated), now(), sessionId],
  );
}

export function removeNote(sessionId: string, index: number): void {
  const ann = getAnnotation(sessionId);
  if (!ann || index < 0 || index >= ann.notes.length) return;
  const updated = ann.notes.filter((_, i) => i !== index);
  ensureDb().run(
    `UPDATE session_annotations SET notes = ?, updated_at = ? WHERE session_id = ?`,
    [JSON.stringify(updated), now(), sessionId],
  );
}

export function addTag(sessionId: string, tag: string): void {
  ensureRow(sessionId);
  const ann = getAnnotation(sessionId);
  if (!ann || ann.tags.includes(tag)) return;
  const updated = [...ann.tags, tag];
  ensureDb().run(
    `UPDATE session_annotations SET tags = ?, updated_at = ? WHERE session_id = ?`,
    [JSON.stringify(updated), now(), sessionId],
  );
}

export function removeTag(sessionId: string, tag: string): void {
  const ann = getAnnotation(sessionId);
  if (!ann) return;
  const updated = ann.tags.filter((t) => t !== tag);
  if (updated.length === ann.tags.length) return;
  ensureDb().run(
    `UPDATE session_annotations SET tags = ?, updated_at = ? WHERE session_id = ?`,
    [JSON.stringify(updated), now(), sessionId],
  );
}

export function deleteAnnotation(sessionId: string): void {
  ensureDb().run(
    `DELETE FROM session_annotations WHERE session_id = ?`,
    [sessionId],
  );
}
