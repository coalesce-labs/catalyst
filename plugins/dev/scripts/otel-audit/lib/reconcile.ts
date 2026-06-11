export interface ReconcileRow {
  kind: string;
  jsonlCount: number;
  lokiCount: number;
  status: "OK" | "MISSING" | "DRIFT" | "LOKI_ONLY";
}

export interface ReconcileOpts {
  lagTolerancePct?: number;
}

// Strip trailing per-event suffixes so event kinds can be compared across sources.
// Two suffix forms exist:
//   1. Ticket suffix: "phase.plan.complete.CTL-1008" → "phase.plan.complete"
//   2. Session-id suffix: "filter.wake.sess_20260607T104342_497673f6" → "filter.wake"
export function normalizeEventName(name: string): string {
  // Strip ".CTL-NNN" or similar ticket suffixes (uppercase + digits/dash pattern)
  const ticketStripped = name.replace(/\.[A-Z][A-Z0-9]*-\d+$/, "");
  if (ticketStripped !== name) return ticketStripped;
  // Strip ".sess_…" session-id suffixes
  const sessStripped = name.replace(/\.sess_[A-Za-z0-9_]+$/, "");
  return sessStripped;
}

export function reconcile(
  jsonlCounts: Map<string, number>,
  lokiCounts: Map<string, number>,
  opts: ReconcileOpts = {}
): ReconcileRow[] {
  const lagTolerancePct = opts.lagTolerancePct ?? 10;
  const rows: ReconcileRow[] = [];
  const allKinds = new Set([...jsonlCounts.keys(), ...lokiCounts.keys()]);

  for (const kind of allKinds) {
    const jsonlCount = jsonlCounts.get(kind) ?? 0;
    const lokiCount = lokiCounts.get(kind) ?? 0;

    let status: ReconcileRow["status"];
    if (jsonlCount > 0 && lokiCount === 0) {
      status = "MISSING";
    } else if (jsonlCount === 0 && lokiCount > 0) {
      status = "LOKI_ONLY";
    } else {
      const lagPct = (Math.abs(jsonlCount - lokiCount) / jsonlCount) * 100;
      status = lagPct <= lagTolerancePct ? "OK" : "DRIFT";
    }
    rows.push({ kind, jsonlCount, lokiCount, status });
  }

  return rows.sort((a, b) => a.kind.localeCompare(b.kind));
}
