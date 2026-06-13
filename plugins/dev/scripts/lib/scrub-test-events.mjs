#!/usr/bin/env node
// scrub-test-events.mjs — CTL-1086 one-time remediation scrubber.
//
// Strips sentinel-stamped (orch-test) lines from a fleet event log.
// Dry-run by default; pass --apply to rewrite the file atomically after
// creating a .pre-scrub-<UTC-ts> backup.
//
// Usage:
//   node scrub-test-events.mjs [path]           # dry-run: report counts
//   node scrub-test-events.mjs [path] --apply   # backup + rewrite
//   node scrub-test-events.mjs --apply          # default path (current UTC month)
//
// Never deletes the backup. Dependency-free (Node/Bun stdlib only).

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname, basename } from "node:path";

const SENTINEL_ORCHIDS = new Set(["orch-test"]);

function isSentinelLine(line) {
  if (!line.trim()) return false;
  try {
    const parsed = JSON.parse(line);
    const orch = parsed?.resource?.["catalyst.orchestration"];
    return SENTINEL_ORCHIDS.has(orch);
  } catch {
    return false;
  }
}

/**
 * Scrub a single event log file.
 * @param {string} filePath - path to the .jsonl file
 * @param {{ apply?: boolean }} options
 * @returns {{ sentinelCount: number, realCount: number, applied: boolean }}
 */
export async function scrubFile(filePath, { apply = false } = {}) {
  const content = readFileSync(filePath, "utf8");
  const allLines = content.split("\n");
  // Preserve trailing newline behavior: remove the last empty element if file ended with \n
  const hasTrailingNewline = content.endsWith("\n");
  const lines = hasTrailingNewline ? allLines.slice(0, -1) : allLines;

  const sentinelLines = lines.filter((l) => isSentinelLine(l));
  const keepLines = lines.filter((l) => !isSentinelLine(l));

  if (!apply) {
    return { sentinelCount: sentinelLines.length, realCount: keepLines.length, applied: false };
  }

  if (sentinelLines.length === 0) {
    return { sentinelCount: 0, realCount: keepLines.length, applied: true };
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = dirname(filePath);
  const base = basename(filePath);
  const backupPath = resolve(dir, `${base}.pre-scrub-${ts}`);

  // Backup then atomically rewrite.
  writeFileSync(backupPath, content);
  const newContent = keepLines.join("\n") + (hasTrailingNewline ? "\n" : "");
  const tmpPath = `${filePath}.scrub-tmp`;
  writeFileSync(tmpPath, newContent);
  renameSync(tmpPath, filePath);

  return { sentinelCount: sentinelLines.length, realCount: keepLines.length, applied: true };
}

// CLI entrypoint
if (import.meta.url === new URL(import.meta.url).href && process.argv[1] === new URL(import.meta.url).pathname) {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const pathArg = args.find((a) => !a.startsWith("--"));

  let filePath;
  if (pathArg) {
    filePath = resolve(pathArg);
  } else {
    const now = new Date();
    const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const home = process.env.HOME ?? homedir();
    const catalystDir = process.env.CATALYST_DIR ?? `${home}/catalyst`;
    filePath = resolve(catalystDir, "events", `${ym}.jsonl`);
  }

  if (!existsSync(filePath)) {
    console.error(`scrub-test-events: file not found: ${filePath}`);
    process.exit(1);
  }

  const result = await scrubFile(filePath, { apply });
  if (!apply) {
    console.log(`Dry-run: ${result.sentinelCount} sentinel lines, ${result.realCount} real lines in ${filePath}`);
    console.log("Pass --apply to rewrite the file.");
  } else {
    console.log(`Applied: removed ${result.sentinelCount} sentinel lines, kept ${result.realCount} real lines.`);
    if (result.sentinelCount > 0) {
      console.log(`Backup created at ${filePath}.pre-scrub-*`);
    }
  }
}
