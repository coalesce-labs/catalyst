import type { CanonicalEvent } from "../../../orch-monitor/lib/canonical-event.ts";

export interface AgePartition { fresh: CanonicalEvent[]; aged: CanonicalEvent[]; }

/** Split by record age. Aged = ts strictly older than (nowMs - windowMs).
 *  Unparseable ts → fresh (fail-open; never silently drop an unjudgeable record). */
export function partitionByAge(
  batch: CanonicalEvent[],
  nowMs: number,
  windowMs: number
): AgePartition {
  const cutoff = nowMs - windowMs;
  const fresh: CanonicalEvent[] = [];
  const aged: CanonicalEvent[] = [];
  for (const ev of batch) {
    const t = Date.parse(ev.ts);
    if (!Number.isNaN(t) && t < cutoff) aged.push(ev);
    else fresh.push(ev);
  }
  return { fresh, aged };
}
