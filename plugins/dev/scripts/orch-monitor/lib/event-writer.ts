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
  linkSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import type { CanonicalEvent } from "./canonical-event";
import { eventLogBasenameFor, resolveRotationScheme } from "../../lib/event-log-paths.mjs";

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
    // CTL-1813: an UNPARSEABLE first line is NOT a legacy log, and must never move the live
    // one. This used to return true — "garbage; rotate it out of the way" — which meant a
    // single torn line retired the whole month: measured against this writer, one truncated
    // first line rotated 349 live events aside, and because the destination is a fixed
    // `.legacy` name, a second torn line one rotation later overwrote the only surviving
    // copy. A torn line is precisely what CTL-1809's bash-append tearing produces above 1025
    // bytes, so the two defects compose into unrecoverable loss.
    //
    // Rotation exists for the v1 -> canonical migration, which is a line that PARSES and
    // lacks `attributes`. Damage is a different thing: refuse, keep every event in place,
    // and say so — the same fail-safe the >1 MiB probe branch above already takes.
    logger?.warn?.(
      `[event-writer] first line of ${filePath} does not parse as JSON — NOT rotating (events preserved in place)`,
    );
    return false;
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

  // CTL-1216: resolved by lib/event-log-paths.mjs. Renamed off "monthly"
  // because it is not — under CATALYST_EVENT_LOG_ROTATION=week this returns
  // 2026-W34.jsonl. The legacy-rotation behaviour documented at the top of this
  // file is unchanged; only which filename it operates on moved.
  private eventLogFilePath(d: Date): string {
    return join(this.baseDir, eventLogBasenameFor(d, resolveRotationScheme({ env: process.env })));
  }

  private maybeRotateLegacy(filePath: string): void {
    if (this.rotated.has(filePath)) return;
    this.rotated.add(filePath);
    if (!isLegacyFirstLine(filePath, this.logger)) return;
    // CTL-1813: a destination that CANNOT COLLIDE. A fixed `.legacy` is a rescue slot of
    // depth one — the next rotation renames over it and the previous month's only surviving
    // copy is gone. Measured: two consecutive rotations left the first month unrecoverable.
    //
    // A timestamp alone is not sufficient, and the test for this caught it: two rotations
    // inside the same millisecond produce the same name and the collision returns. So probe
    // for a free name and never rename onto an existing file — the whole point is that no
    // rotation may destroy a previous one.
    // `existsSync` then `renameSync` is check-then-act: two writers can both see the name
    // free, and POSIX rename() OVERWRITES — so the second would destroy the first's rescue
    // copy, which is this ticket's own defect one layer down (Codex #3318 P1).
    //
    // `linkSync` is the atomic primitive: it throws EEXIST rather than overwriting, so the
    // link itself RESERVES the name. Unlink the source only once the link succeeded; if it
    // fails we try the next name and the original is untouched.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let legacyPath = "";
    let reserved = false;
    for (let n = 0; n <= 50 && !reserved; n += 1) {
      legacyPath = n === 0 ? `${filePath}.legacy.${stamp}` : `${filePath}.legacy.${stamp}.${n}`;
      try {
        linkSync(filePath, legacyPath);
        reserved = true;
      } catch {
        // EEXIST (a peer reserved it) or a real error — either way, try the next name.
      }
    }
    if (!reserved) {
      this.logger.warn?.(
        `[event-writer] could not reserve a rotation name for ${filePath} — leaving it in place`,
      );
      return;
    }
    try {
      unlinkSync(filePath);
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
    const path = this.eventLogFilePath(this.now());
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
