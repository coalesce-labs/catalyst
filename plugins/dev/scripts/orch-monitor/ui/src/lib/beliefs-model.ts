// beliefs-model.ts — CTL-1100 Phase 6: belief stream data model.
// Pure; no DOM dependency.

/** One row from the /api/beliefs/stream `belief` SSE event. */
export interface BeliefFrame {
  belief_id: number;
  tick_id: number;
  rule_id: string;
  name: string;
  subject: string;
  value: string | null;
  source_fact_ids: string;
  stratum: number;
  ts_ms: number | null;
  host: string | null;
  rules_sha: string | null;
}

/** Map: beliefKey → latest BeliefFrame. */
export type BeliefStore = Map<string, BeliefFrame>;

/** The current belief state passed through BeliefsContext. */
export interface BeliefsState {
  store: BeliefStore;
  cursor: number; // latest belief_id seen; monotonically increasing
}

export function isBeliefFrame(v: unknown): v is BeliefFrame {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.belief_id === "number" &&
    typeof r.tick_id === "number" &&
    typeof r.rule_id === "string" &&
    typeof r.name === "string" &&
    typeof r.subject === "string"
  );
}

export function decodeBeliefFrame(data: string): BeliefFrame | null {
  try {
    const parsed: unknown = JSON.parse(data);
    return isBeliefFrame(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Stable key for deduplication: last-writer-wins by belief_id. */
export function beliefKey(r: BeliefFrame): string {
  return `${r.rule_id} ${r.subject}`;
}

/** Fold a new frame into the store. Only replaces if belief_id is higher (monotonic). */
export function applyBeliefFrame(state: BeliefsState, frame: BeliefFrame): BeliefsState {
  const key = beliefKey(frame);
  const existing = state.store.get(key);
  if (existing && existing.belief_id >= frame.belief_id) {
    // newer cursor still advances even if this key doesn't update
    const nextCursor = Math.max(state.cursor, frame.belief_id);
    return nextCursor === state.cursor
      ? state
      : { store: state.store, cursor: nextCursor };
  }
  const nextStore = new Map(state.store);
  nextStore.set(key, frame);
  return { store: nextStore, cursor: Math.max(state.cursor, frame.belief_id) };
}

export function beliefsToArray(store: BeliefStore): BeliefFrame[] {
  return [...store.values()];
}

export const EMPTY_BELIEFS_STATE: BeliefsState = {
  store: new Map(),
  cursor: -1,
};
