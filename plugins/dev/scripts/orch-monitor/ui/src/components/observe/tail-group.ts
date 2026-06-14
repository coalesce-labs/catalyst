// tail-group.ts — PURE grouping + filtering for the TELEMETRY P1 live tail
// (OBS-6). DOM-/React-free so the bucketing, the filter predicate, and the
// worker-header derivation all unit-test directly under the ui package's
// `bun test`, the same discipline as board/live-tail-data.ts.
//
// The tail is the fleet-wide claude-code stream (one /api/otel/tail scan). Each
// TailRow carries the grouping keys lifted from the line (sessionId / linearKey)
// and the parsed event fields. We group rows under `▾<ticket>·<phase>` worker
// headers by joining sessionId → a BoardWorker (ticket + phase) when the board
// knows the session; rows we can't attribute fall into a single honest
// "unattributed" bucket — NEVER dropped, NEVER fabricated (Principle 6).

import type { TailRow } from "@/lib/types";

/** The filter axes the toggle chips expose. `errorsOnly` keeps only rows whose
 *  event is an api_error / a failed result; the worker/event/tool filters are
 *  exact-match selections (empty string = no filter on that axis). */
export interface TailFilter {
  /** Keep only rows attributed to this worker bucket key (sessionId), or "" for all. */
  worker: string;
  /** Keep only rows whose eventName equals this, or "" for all. */
  eventType: string;
  /** Keep only rows whose toolName equals this, or "" for all. */
  tool: string;
  /** Keep only error rows (api_error event OR success === false). */
  errorsOnly: boolean;
}

export const EMPTY_TAIL_FILTER: TailFilter = {
  worker: "",
  eventType: "",
  tool: "",
  errorsOnly: false,
};

/** Minimal board-worker shape the tail needs to attribute a session to a worker.
 *  Kept structural (not the full BoardWorker) so the grouping logic doesn't drag
 *  the board types into a pure module. */
export interface TailWorkerRef {
  sessionId?: string | undefined;
  ticket: string;
  phase: string;
  /** The worker RUN id (BoardWorker.name, e.g. "CTL-845:2") — the `/worker/$id`
   *  drill target. The grouping key is the sessionId; this is what the drill
   *  navigates to. Optional so a worker without a name still groups. */
  name?: string | undefined;
}

/** A row is an "error" row when its event is a claude_code.api_error OR it carries
 *  an explicit `success === false`. Used by the errors-only chip AND to tint the
 *  row red. Pure. */
export function isErrorRow(row: TailRow): boolean {
  if (row.eventName && row.eventName.toLowerCase().includes("api_error")) return true;
  return row.success === false;
}

/** Apply the filter chips to a row set. AND semantics across axes; an empty axis
 *  is a pass-through. Pure — returns a new array. */
export function filterTailRows(
  rows: TailRow[],
  filter: TailFilter,
  bucketKeyOf: (row: TailRow) => string,
): TailRow[] {
  return rows.filter((row) => {
    if (filter.errorsOnly && !isErrorRow(row)) return false;
    if (filter.worker && bucketKeyOf(row) !== filter.worker) return false;
    if (filter.eventType && row.eventName !== filter.eventType) return false;
    if (filter.tool && row.toolName !== filter.tool) return false;
    return true;
  });
}

/** A grouped worker bucket: the header label + its rows (newest-first, inherited
 *  from the input order). `key` is the stable group key (the sessionId, or the
 *  sentinel for unattributed rows). */
export interface TailGroup {
  key: string;
  /** `▾<ticket>·<phase>` when attributed, else "unattributed". */
  label: string;
  ticket: string | null;
  phase: string | null;
  /** The worker RUN id for the `/worker/$id` drill (null when unattributed). */
  workerName: string | null;
  rows: TailRow[];
}

/** The sentinel bucket key for rows we couldn't attribute to a board worker. */
export const UNATTRIBUTED_KEY = "__unattributed__";

/**
 * Group tail rows into per-worker buckets, joining each row's sessionId to a
 * BoardWorker (→ ticket + phase) when the board knows it. Rows whose session is
 * unknown (or absent) collapse into ONE "unattributed" bucket at the end — the
 * page is never blank and no row is silently dropped. Buckets are emitted in
 * first-seen order (the newest activity surfaces first since rows arrive
 * newest-first). Pure.
 */
export function groupTailByWorker(
  rows: TailRow[],
  workers: TailWorkerRef[],
): TailGroup[] {
  // session → {ticket, phase, name} index from the board.
  const bySession = new Map<
    string,
    { ticket: string; phase: string; name: string | null }
  >();
  for (const w of workers) {
    if (w.sessionId) {
      bySession.set(w.sessionId, {
        ticket: w.ticket,
        phase: w.phase,
        name: w.name ?? null,
      });
    }
  }

  const order: string[] = [];
  const groups = new Map<string, TailGroup>();

  for (const row of rows) {
    const known = row.sessionId ? bySession.get(row.sessionId) : undefined;
    const key = known && row.sessionId ? row.sessionId : UNATTRIBUTED_KEY;
    let g = groups.get(key);
    if (!g) {
      g = known
        ? {
            key,
            label: `${known.ticket}·${known.phase}`,
            ticket: known.ticket,
            phase: known.phase,
            workerName: known.name,
            rows: [],
          }
        : {
            key,
            label: "unattributed",
            ticket: null,
            phase: null,
            workerName: null,
            rows: [],
          };
      groups.set(key, g);
      order.push(key);
    }
    g.rows.push(row);
  }

  // Unattributed always sorts last so real workers lead the tail.
  return order
    .map((k) => groups.get(k)!)
    .sort((a, b) => {
      if (a.key === UNATTRIBUTED_KEY) return 1;
      if (b.key === UNATTRIBUTED_KEY) return -1;
      return 0;
    });
}

/** The bucket key for one row (sessionId when the board knows it, else the
 *  sentinel). Exported so the worker filter chip and filterTailRows agree on the
 *  same key. */
export function bucketKeyFactory(
  workers: TailWorkerRef[],
): (row: TailRow) => string {
  const known = new Set(
    workers.map((w) => w.sessionId).filter((s): s is string => !!s),
  );
  return (row: TailRow) =>
    row.sessionId && known.has(row.sessionId) ? row.sessionId : UNATTRIBUTED_KEY;
}

/** Distinct event-type values present in the rows (for the event-type chip),
 *  sorted for stable chip order. Pure. */
export function distinctEventTypes(rows: TailRow[]): string[] {
  const set = new Set<string>();
  for (const r of rows) if (r.eventName) set.add(r.eventName);
  return [...set].sort();
}
