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
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
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
 * CTL-1529: how many bytes the first-line probe reads before giving up.
 *
 * The rotation check needs exactly ONE line, but the file it inspects is the
 * MONTHLY EVENT LOG — 344 MB on the busiest host. `readFileSync(filePath,
 * "utf8")` materialized all of it to look at the first ~1 KB, once per writer
 * instance; `server.ts` constructs three writers, each with its own `rotated`
 * Set, so a single monitor process paid that three times at startup.
 *
 * 64 KiB is ~20x the largest canonical envelope observed (a phase event with an
 * embedded brief). The probe DOUBLES up to `PROBE_MAX_BYTES` if the first
 * newline is further out than that, so a pathologically long first line is
 * still classified correctly rather than mis-parsed.
 */
const PROBE_INITIAL_BYTES = 64 * 1024;
const PROBE_MAX_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;

/**
 * firstNonEmptyLine — CTL-1529. The first "\n"-delimited non-empty line of
 * `filePath`, read with a bounded `readSync` prefix instead of a whole-file
 * read. Mirrors the semantics of the `content.split("\n").find(l => l.length >
 * 0)` it replaces: leading empty lines are skipped, and a final line without a
 * trailing newline still counts.
 *
 * `undecided:true` means the probe hit `PROBE_MAX_BYTES` without finding a line
 * terminator — the caller MUST NOT treat that as legacy, because "I could not
 * read enough" and "this is a legacy envelope" have opposite consequences (the
 * latter RENAMES the live log out from under every reader).
 */
function firstNonEmptyLine(filePath: string): {
  line: string | null;
  undecided: boolean;
} {
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return { line: null, undecided: false };
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return { line: null, undecided: false };
    let probe = Math.min(PROBE_INITIAL_BYTES, size);
    for (;;) {
      const buf = Buffer.allocUnsafe(probe);
      let got = 0;
      while (got < probe) {
        const n = readSync(fd, buf, got, probe - got, got);
        if (n <= 0) break;
        got += n;
      }
      let start = 0;
      for (let i = 0; i < got; i++) {
        if (buf[i] !== NEWLINE) continue;
        if (i > start) return { line: buf.toString("utf8", start, i), undecided: false };
        start = i + 1; // an empty line — skip it, exactly as `.find(l => l.length > 0)` did
      }
      if (got >= size) {
        // The probe holds the WHOLE file and no terminator followed the first
        // non-empty run: that run is the final unterminated line.
        return { line: got > start ? buf.toString("utf8", start, got) : null, undecided: false };
      }
      if (probe >= PROBE_MAX_BYTES) return { line: null, undecided: true };
      probe = Math.min(probe * 2, PROBE_MAX_BYTES, size);
    }
  } catch {
    return { line: null, undecided: false };
  } finally {
    closeSync(fd);
  }
}

/**
 * Detect whether the existing line is a canonical envelope by looking for
 * the `attributes` field. Legacy v1 (bash) and v2 (webhook) envelopes both
 * lack `attributes`, so this single check distinguishes them from
 * canonical lines without parsing the full schema.
 */
function isLegacyFirstLine(filePath: string, logger?: EventWriterLogger): boolean {
  if (!existsSync(filePath)) return false;
  const { line, undecided } = firstNonEmptyLine(filePath);
  if (undecided) {
    // Fail SAFE: an undecidable probe must never trigger a rename of the live
    // log. Loud, because the only way to reach here is a >1 MiB first line.
    logger?.warn?.(
      `[event-writer] first-line probe exceeded ${PROBE_MAX_BYTES}B for ${filePath} — skipping legacy rotation`,
    );
    return false;
  }
  if (line === null) return false;
  try {
    const parsed: unknown = JSON.parse(line);
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
    if (!isLegacyFirstLine(filePath, this.logger)) return;
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
