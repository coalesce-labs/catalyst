// worker-grouping.ts — the PURE, DOM-free grouping/filter decision for the
// Workers surface (CTL-909 / SURF1).
//
// The Workers board lays its worker cards out in columns. Today the grouping
// axis is "status" (Active/Stuck) or "phase" (one column per pipeline phase);
// SURF1 adds a third axis, "node" — one column per owning HOST, plus a node
// FILTER that scopes the whole grid to a single host. Both read the
// `BoardWorker.host` field (a {name,id} HostRef, plumbed by BFF10/CTL-922 onto
// every worker entity from the phase signal's host:{name,id}, CTL-852).
//
// SINGLE-HOST IDENTITY NO-OP (the hard operator constraint): with one node the
// node grouping collapses to exactly ONE column and the grid reads identically
// to a host-unaware grid — there is no separate cluster code path, no added
// latency, no extra chrome. The same column-derivation runs whether there are
// one or N hosts; N just yields N columns. A worker with no named host falls
// into an explicit "unattributed" bucket rather than being dropped.
//
// Kept React-/router-free (the same discipline surface.ts / list-order.ts /
// route-search.ts follow) so the Gherkin acceptance scenarios are unit-tested
// under `bun test` without a DOM. Board.tsx renders the columns this module
// derives; it owns no layout itself.
import type { BoardWorker } from "./types";
import { sortWorkers } from "./list-order";

/** The worker-board grouping axis. SURF1 adds "node" to the existing pair. */
export type WorkerGrouping = "status" | "phase" | "node";

/** The sentinel host-filter value meaning "every node" (no filter applied). */
export const HOST_FILTER_ALL = "all" as const;

/** The label a worker with no named host is grouped/displayed under. A worker's
 *  `host` is null until a phase signal stamps host:{name,id} (CTL-852); we name
 *  that honestly rather than inventing a host id. */
export const UNATTRIBUTED_HOST = "unattributed" as const;

/** The sentinel label for workers whose host is neither in the roster nor
 *  currently live (heartbeating). All such "historical" names collapse into
 *  a single column rather than rendering as phantom dead-node lanes. CTL-1093. */
export const HISTORICAL_ALIAS_HOST = "historical alias" as const;

/** Context required for historical-alias folding. Both fields come from the
 *  cluster roster + liveness data already available to Board.tsx. CTL-1093. */
export interface NodeContext {
  /** The committed cluster roster (from .catalyst/hosts.json via /api/cluster). */
  roster: readonly string[];
  /** Host names currently considered live (heartbeating within grace window). */
  liveHosts: ReadonlySet<string>;
}

/** One node column on the Workers grid: the host name (its column label) and the
 *  workers that resolve to it, already ordered by the shared worker comparator. */
export interface NodeColumn {
  /** The host name the column groups by, or `UNATTRIBUTED_HOST` for hostless workers. */
  host: string;
  /** This node's workers, in `sortWorkers` order (active → others → stuck). */
  workers: BoardWorker[];
}

/** The host a worker is attributed to: its `host.name`, or null when unnamed. */
export function workerHostName(w: BoardWorker): string | null {
  return w.host?.name ?? null;
}

/** Returns true when a host name should be folded into the historical bucket:
 *  it is neither in the roster nor currently live. When ctx is absent, never folds
 *  (backward compatibility). CTL-1093. */
function isHistoricalHost(name: string, ctx?: NodeContext): boolean {
  if (!ctx) return false;
  return !ctx.roster.includes(name) && !ctx.liveHosts.has(name);
}

/**
 * The distinct host names present across the given workers, in stable display
 * order: real host names sorted alphabetically, with the `unattributed` bucket
 * (if any worker lacks a host) appended LAST so a hostless worker never hides a
 * real node. An empty input yields `[]` (no columns) — never a fabricated host.
 *
 * When `ctx` is supplied, non-roster non-live host names are collapsed into a
 * single `HISTORICAL_ALIAS_HOST` entry (appended after real names, before
 * unattributed) so phantom dead columns do not clutter the view. CTL-1093.
 *
 * SINGLE-HOST: one node ⇒ exactly one entry, so `nodeColumns` collapses to one
 * column — the identity no-op the spec mandates.
 */
export function workerHostNames(workers: readonly BoardWorker[], ctx?: NodeContext): string[] {
  const named = new Set<string>();
  let hasUnattributed = false;
  let hasHistorical = false;
  for (const w of workers) {
    const name = workerHostName(w);
    if (name === null || name === "") { hasUnattributed = true; continue; }
    if (isHistoricalHost(name, ctx)) { hasHistorical = true; continue; }
    named.add(name);
  }
  const out = [...named].sort((a, b) => a.localeCompare(b));
  if (hasHistorical) out.push(HISTORICAL_ALIAS_HOST);
  if (hasUnattributed) out.push(UNATTRIBUTED_HOST);
  return out;
}

/**
 * Scope a worker list to a single host. `HOST_FILTER_ALL` is a pure identity
 * no-op (returns the same membership, never a copy-induced reorder concern —
 * callers pass the result straight into grouping). `UNATTRIBUTED_HOST` selects
 * exactly the hostless workers. `HISTORICAL_ALIAS_HOST` selects all workers
 * whose host is historical under ctx (non-roster and non-live). Any other value
 * selects the workers whose `host.name` matches. Returns a new array (never
 * mutates the payload).
 */
export function filterWorkersByHost(
  workers: readonly BoardWorker[],
  host: string,
  ctx?: NodeContext,
): BoardWorker[] {
  if (host === HOST_FILTER_ALL) return [...workers];
  if (host === UNATTRIBUTED_HOST) {
    return workers.filter((w) => {
      const n = workerHostName(w);
      return n === null || n === "";
    });
  }
  if (host === HISTORICAL_ALIAS_HOST) {
    return workers.filter((w) => {
      const n = workerHostName(w);
      return n !== null && n !== "" && isHistoricalHost(n, ctx);
    });
  }
  return workers.filter((w) => workerHostName(w) === host);
}

/**
 * Lay the workers out as one column per host name (the "node" grouping axis).
 * Columns follow `workerHostNames` order; each column's workers are ordered by
 * the SAME `sortWorkers` comparator the status/phase lenses and the in-flight
 * queue use, so card order is consistent across every Workers view.
 *
 * When `ctx` is supplied, non-roster non-live host names collapse into a single
 * `HISTORICAL_ALIAS_HOST` column rather than rendering as phantom dead-node
 * lanes. Without `ctx`, behavior is byte-for-byte identical to before. CTL-1093.
 *
 * SINGLE-HOST IDENTITY NO-OP: with one node this returns a single column whose
 * workers are exactly `sortWorkers(workers)` — byte-for-byte the host-unaware
 * ordering, no extra chrome. An empty input yields `[]`.
 */
export function nodeColumns(workers: readonly BoardWorker[], ctx?: NodeContext): NodeColumn[] {
  return workerHostNames(workers, ctx).map((host) => ({
    host,
    workers: sortWorkers(filterWorkersByHost(workers, host, ctx)),
  }));
}

/** True when the workers span more than one node (so the node FILTER control is
 *  worth showing). With a single host the filter would be inert, so the surface
 *  can hide it — the single-host case stays chrome-free. */
export function isMultiHost(workers: readonly BoardWorker[]): boolean {
  return workerHostNames(workers).length > 1;
}
