import { existsSync, appendFileSync, readFileSync, unlinkSync } from "node:fs";

export function appendToDlq(dlqPath: string, batch: unknown[]): void {
  appendFileSync(dlqPath, JSON.stringify(batch) + "\n");
}

export function drainDlq(dlqPath: string): unknown[][] {
  if (!existsSync(dlqPath)) return [];
  const lines = readFileSync(dlqPath, "utf8").split("\n").filter(Boolean);
  unlinkSync(dlqPath);
  return lines.map((l: string) => JSON.parse(l));
}
