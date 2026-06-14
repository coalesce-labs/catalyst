import { readFileSync, writeFileSync, existsSync } from "node:fs";

export interface Checkpoint {
  path: string;
  offset: number;
  updatedAt: string;
  /** ISO-8601 timestamp of the newest event confirmed delivered to OTLP/Loki (CTL-1060 Phase 3). */
  lastForwardedTs?: string;
}

export function readCheckpoint(ckPath: string): Checkpoint | null {
  if (!existsSync(ckPath)) return null;
  try { return JSON.parse(readFileSync(ckPath, "utf8")); } catch { return null; }
}

export function writeCheckpoint(ckPath: string, ck: Omit<Checkpoint, "updatedAt">): void {
  writeFileSync(ckPath, JSON.stringify({ ...ck, updatedAt: new Date().toISOString() }, null, 2));
}
