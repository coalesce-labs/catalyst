import { readFileSync, writeFileSync, existsSync } from "node:fs";

export interface Checkpoint { path: string; offset: number; updatedAt: string }

export function readCheckpoint(ckPath: string): Checkpoint | null {
  if (!existsSync(ckPath)) return null;
  try { return JSON.parse(readFileSync(ckPath, "utf8")); } catch { return null; }
}

export function writeCheckpoint(ckPath: string, ck: Omit<Checkpoint, "updatedAt">): void {
  writeFileSync(ckPath, JSON.stringify({ ...ck, updatedAt: new Date().toISOString() }, null, 2));
}
