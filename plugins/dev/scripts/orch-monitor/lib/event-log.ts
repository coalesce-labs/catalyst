/**
 * Thin facade over `event-writer.ts` — preserves the `createEventLogWriter`
 * factory and `EventLogWriter` interface used by `server.ts` while routing
 * every `append()` to the canonical writer that lives in `event-writer.ts`.
 *
 * Events are written to `${catalystDir}/events/YYYY-MM.jsonl` as canonical
 * OTel-shaped envelopes (CTL-300). Pre-existing legacy v1/v2 monthly files
 * are renamed to `*.legacy` on the first canonical write so old monitor
 * binaries fail loud rather than silently mis-reading mismatched data.
 */

import { join } from "node:path";
import {
  CanonicalEventWriter,
  type EventWriterLogger,
} from "./event-writer";
import type { CanonicalEvent } from "./canonical-event";

export type EventLogLogger = EventWriterLogger;

export interface EventLogWriter {
  append(event: CanonicalEvent): Promise<void>;
}

export interface CreateEventLogWriterOpts {
  /** ~/catalyst directory; events go to {catalystDir}/events/YYYY-MM.jsonl. */
  catalystDir: string;
  /** Override for tests. */
  now?: () => Date;
  logger?: EventLogLogger;
}

export function createEventLogWriter(
  opts: CreateEventLogWriterOpts,
): EventLogWriter {
  return new CanonicalEventWriter({
    baseDir: join(opts.catalystDir, "events"),
    now: opts.now,
    logger: opts.logger,
  });
}
