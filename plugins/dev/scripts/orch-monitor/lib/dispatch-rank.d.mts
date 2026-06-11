// dispatch-rank.d.mts — types for the canonical dispatch-order comparator (CTL-1015).

/** Minimal shape the comparator reads. All fields optional — it degrades gracefully. */
export interface DispatchRankable {
  id?: string;
  identifier?: string;
  priority?: number | null;
  createdAt?: string | null;
  /** In-flight tickets carry an integer pipeline stage; queue items omit it (tie at -1). */
  stage?: number | null;
}

/** Linear priority → rank. 1=Urgent…4=Low; 0/absent/non-numeric → 5 (below Low). */
export const PRIORITY_RANK: (p: number | null | undefined) => number;

/** Total-order comparator: priority asc → stage desc → createdAt asc → id asc. */
export function compareDispatchOrder(a: DispatchRankable, b: DispatchRankable): number;

/** A new array sorted by compareDispatchOrder. Never mutates the input. */
export function rankDispatchOrder<T extends DispatchRankable>(items: readonly T[] | null | undefined): T[];
