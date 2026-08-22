// event-mirror/lib/state.ts — per-host byte cursor + event-id dedup ring (CTL-1654).
// Transport-agnostic: the mirror writer injects a fetchFn; this module owns bookkeeping only.

/** Per-host mirror state persisted across ticks.
 *
 *  CTL-1216: cursors are keyed BY FILE. The old shape was one scalar `cursor`
 *  plus a `currentFile`, and a file change reset the cursor to 0 — which is both
 *  a re-read of the whole new file and, worse, a permanent loss of where we were
 *  in the old one if the remote is still being appended to across the boundary.
 *  Per-file cursors also make a MIXED-SCHEME fleet safe: this node can be
 *  tracking a peer's 2026-W34.jsonl and its own 2026-08.jsonl independently
 *  instead of applying one locally-computed name to every host.
 *
 *  `cursor`/`currentFile` are retained as the MIGRATION source only — loadState
 *  folds them into `cursors` once and they are never written again. Dropping
 *  them outright would silently restart every host from byte 0 on the first tick
 *  after deploy, re-mirroring an entire file. */
export interface HostState {
  cursors: Record<string, number>;
  lastSeenTs: string | null;
  healthy: boolean;
  /** @deprecated migration source only — see the note above. */
  cursor?: number;
  /** @deprecated migration source only — see the note above. */
  currentFile?: string | null;
}

/** Fold the pre-CTL-1216 scalar shape into the per-file map, exactly once.
 *  A host that already has `cursors` is left alone. */
export function migrateHostState(hs: HostState): HostState {
  if (!hs.cursors) hs.cursors = {};
  if (typeof hs.cursor === "number" && hs.currentFile) {
    if (hs.cursors[hs.currentFile] === undefined) {
      hs.cursors[hs.currentFile] = hs.cursor;
    }
    delete hs.cursor;
    delete hs.currentFile;
  }
  return hs;
}

/** The full mirror state (one entry per host). */
export interface MirrorState {
  byHost: Record<string, HostState>;
  // dedup ring: event ids seen in the current month's file (bounded to the current file name).
  seenIds: Set<string>;
  seenIdsFile: string | null;
}

export function newMirrorState(): MirrorState {
  return { byHost: {}, seenIds: new Set(), seenIdsFile: null };
}

export function getHostState(state: MirrorState, host: string): HostState {
  if (!state.byHost[host]) {
    state.byHost[host] = { cursors: {}, lastSeenTs: null, healthy: true };
  }
  return migrateHostState(state.byHost[host]);
}

/**
 * maybeResetDedup — resets the dedup ring when the event file name changes (month rollover).
 * The ring is scoped to the current month's file so its memory stays bounded.
 */
export function maybeResetDedup(state: MirrorState, currentFile: string): void {
  if (state.seenIdsFile !== currentFile) {
    state.seenIds = new Set();
    state.seenIdsFile = currentFile;
  }
}

/**
 * extractEventId — tries to read `id`, `event_id`, or `attributes["event.id"]` from a JSONL line.
 * Returns null for unparseable lines.
 */
export function extractEventId(line: string): string | null {
  try {
    const obj = JSON.parse(line);
    if (typeof obj?.id === "string") return obj.id;
    if (typeof obj?.event_id === "string") return obj.event_id;
    if (typeof obj?.attributes?.["event.id"] === "string") return obj.attributes["event.id"];
    // CTL-1812: there is NO fallback id, deliberately.
    //
    // This used to return the `${ts}:${name}` composite, which is not an identity — two
    // genuinely distinct events sharing a timestamp and an event name collide, and the
    // second is silently discarded as a duplicate. MEASURED: replaying that rule over the
    // authoritative worker logs suppressed 35,931 real events (14,660 mini + 21,271
    // mini-2), 100% of them via this path and 0 via a real id.
    //
    // A CONTENT HASH was the obvious replacement and is also WRONG — measured before
    // adopting it: mini's own August log contains 14,515 byte-identical duplicate lines
    // (1.32% of 1,096,795). Those are real, separately-emitted events, so hashing would
    // trade one silent-loss bug for a smaller one. Fewer lost events is still lost events.
    //
    // So we return null and let the caller's conservative path include the line. A
    // duplicate is visible and harmless; a dropped event is neither. The dedup ring
    // still does its job for every event that carries a REAL id, which is the population
    // it was built for.
    return null;
  } catch {
    return null;
  }
}

/**
 * filterNewLines — given raw lines from a remote host, return only those whose event ids
 * have not yet been seen. Updates state.seenIds in-place. Lines with no parseable id are
 * ALWAYS appended (conservative: never drop an event just because it lacks an id).
 */
export function filterNewLines(
  state: MirrorState,
  lines: string[],
  currentFile: string
): string[] {
  maybeResetDedup(state, currentFile);
  const survivors: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const id = extractEventId(line);
    if (id === null) {
      // No id — always include (conservative).
      survivors.push(line);
      continue;
    }
    if (!state.seenIds.has(id)) {
      state.seenIds.add(id);
      survivors.push(line);
    }
  }
  return survivors;
}
