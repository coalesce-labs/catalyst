/**
 * Append-only writer for the canonical event log.
 *
 * Writes one canonical envelope per JSONL line to
 * `${baseDir}/YYYY-MM.jsonl`. On first write to any monthly file, if the
 * existing file is in the legacy v1/v2 format (no top-level `attributes`
 * field on the first line), the file is rotated to `*.jsonl.legacy` so old
 * monitor binaries fail loud rather than silently mis-reading mismatched
 * data.
 *
 * The writer is line-buffered via `appendFileSync` — each event flushes to
 * disk before returning so a crash mid-batch loses at most one event.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import type { CanonicalEvent } from "./canonical-event";

export interface EventWriterLogger {
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface CanonicalEventWriterOpts {
  /** Directory where YYYY-MM.jsonl files live. Defaults to ~/catalyst/events when called without args externally. */
  baseDir: string;
  /** Override for tests. */
  now?: () => Date;
  logger?: EventWriterLogger;
}

/**
 * Detect whether the existing line is a canonical envelope by looking for
 * the `attributes` field. Legacy v1 (bash) and v2 (webhook) envelopes both
 * lack `attributes`, so this single check distinguishes them from
 * canonical lines without parsing the full schema.
 */
function isLegacyFirstLine(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return false;
  }
  const firstLine = content.split("\n").find((l) => l.length > 0);
  if (!firstLine) return false;
  try {
    const parsed: unknown = JSON.parse(firstLine);
    if (typeof parsed !== "object" || parsed === null) return true;
    return !("attributes" in parsed);
  } catch {
    // unparseable — treat as legacy/garbage; rotate it out of the way
    return true;
  }
}

export class CanonicalEventWriter {
  private readonly baseDir: string;
  private readonly now: () => Date;
  private readonly logger: EventWriterLogger;
  private readonly rotated = new Set<string>();

  constructor(opts: CanonicalEventWriterOpts) {
    this.baseDir = opts.baseDir;
    this.now = opts.now ?? (() => new Date());
    this.logger = opts.logger ?? {};
  }

  private monthlyFilePath(d: Date): string {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    return join(this.baseDir, `${y}-${m}.jsonl`);
  }

  private maybeRotateLegacy(filePath: string): void {
    if (this.rotated.has(filePath)) return;
    this.rotated.add(filePath);
    if (!isLegacyFirstLine(filePath)) return;
    const legacyPath = `${filePath}.legacy`;
    try {
      renameSync(filePath, legacyPath);
      this.logger.warn?.(
        `[event-writer] rotated legacy file ${filePath} → ${legacyPath}`,
      );
    } catch (err) {
      this.logger.warn?.(
        `[event-writer] legacy rotation failed for ${filePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  append(event: CanonicalEvent): Promise<void> {
    const path = this.monthlyFilePath(this.now());
    try {
      mkdirSync(this.baseDir, { recursive: true });
      this.maybeRotateLegacy(path);
      appendFileSync(path, JSON.stringify(event) + "\n");
    } catch (err) {
      this.logger.error?.(
        `[event-writer] append failed for ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return Promise.resolve();
  }
}
