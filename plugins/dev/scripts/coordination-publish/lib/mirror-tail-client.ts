// mirror-tail-client — CTL-1488 Phase 5. The INBOUND half of the coordination mirror.
//
// Pulls OTHER hosts' coordination rows from the catalyst-cloud hub's HTTP
// /coordination/changes contract (Phase 4) into the local ~/catalyst/coordination.jsonl, deduped by
// event.id, so each host materializes the full cross-host coordination stream. Cursor lifecycle:
// no saved cursor → since=0 full drain → steady-state delta poll → HTTP-409 cursor_underflow → full
// resync. The transport is abstracted behind `ChangeSource` so the merge logic NEVER branches on it —
// the interim Loki-tail source (interim-loki-source.ts) drops in behind the same interface when the
// hub isn't configured.
//
// Local-first invariant preserved: this only ever APPENDS remote rows the local tailer didn't write.
// A host's own rows (written by index.ts with a `local_seq`) are reconciled by event.id and never
// double-appended when the hub echoes them back.

import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

/** One coordination delta as the hub's /coordination/changes NDJSON emits it. */
export interface CoordinationDelta {
  seq: number;
  host: string | null;
  event_id: string;
  event_name: string;
  ts: string | null;
  caused_by: string | null;
  attributes: unknown;
  resource: unknown;
}

/** The result of one pull: rows + head cursor, an underflow signal (resync), or a transient error. */
export type PullResult =
  | { ok: true; deltas: CoordinationDelta[]; headSeq: number }
  | { ok: false; underflow: true }
  | { ok: false; error: true };

/** Transport-agnostic source of coordination deltas. Hub (HTTP) or interim Loki both implement this. */
export interface ChangeSource {
  pullChanges(since: number): Promise<PullResult>;
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

/** Read the set of event ids already present in the mirror (the `id` field of every line). */
export function readMirrorEventIds(mirrorPath: string): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(mirrorPath)) return ids;
  const text = readFileSync(mirrorPath, "utf8");
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as { id?: unknown };
      if (typeof obj.id === "string") ids.add(obj.id);
    } catch {
      // skip malformed line
    }
  }
  return ids;
}

/** Reconstruct a mirror row from a remote delta. `id` mirrors the local rows' `id` so dedup is uniform;
 *  `hub_seq` (not local_seq) marks it as pulled-in, not locally tailed. */
function deltaToMirrorRow(d: CoordinationDelta): Record<string, unknown> {
  return {
    id: d.event_id,
    ts: d.ts,
    caused_by: d.caused_by,
    attributes: d.attributes,
    resource: d.resource,
    host: d.host,
    hub_seq: d.seq,
  };
}

export interface MirrorTailClientOpts {
  mirrorPath: string;
  source: ChangeSource;
  signal?: AbortSignal;
  /** Seed the hub cursor (tests / resume). null → first tick is a since=0 full drain. */
  startHubSeq?: number | null;
  /** Injected logger; defaults to console.error. */
  logError?: (msg: string) => void;
}

export interface MirrorTailClient {
  tick: () => Promise<void>;
  currentHubSeq: () => number | null;
}

export function createMirrorTailClient(opts: MirrorTailClientOpts): MirrorTailClient {
  let lastHubSeq: number | null = opts.startHubSeq ?? null;
  const logError = opts.logError ?? ((m: string) => console.error(`[coordination-mirror-tail] ${m}`));

  function mergeDeltas(deltas: CoordinationDelta[]): void {
    if (deltas.length === 0) return;
    const seen = readMirrorEventIds(opts.mirrorPath);
    mkdirSync(dirname(opts.mirrorPath), { recursive: true });
    for (const d of deltas) {
      if (!d.event_id || seen.has(d.event_id)) continue; // dedup: own rows + already-pulled remote rows
      appendFileSync(opts.mirrorPath, JSON.stringify(deltaToMirrorRow(d)) + "\n");
      seen.add(d.event_id);
    }
  }

  async function tick(): Promise<void> {
    if (opts.signal?.aborted) return;
    const since = lastHubSeq ?? 0;
    let res: PullResult;
    try {
      res = await opts.source.pullChanges(since);
    } catch (err) {
      logError(`pull threw: ${err instanceof Error ? err.message : String(err)}`);
      return; // no-op tick, retried next tick
    }

    if (!res.ok && "underflow" in res) {
      // Cursor evicted past `since` — full resync from 0.
      lastHubSeq = null;
      let resync: PullResult;
      try {
        resync = await opts.source.pullChanges(0);
      } catch (err) {
        logError(`resync pull threw: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      if (resync.ok) {
        mergeDeltas(resync.deltas);
        lastHubSeq = Math.max(resync.headSeq, seqCeiling(resync.deltas, 0));
      }
      return;
    }
    if (!res.ok) {
      // Transient error — leave the cursor untouched, retry next tick.
      logError("pull failed (transient); retrying next tick");
      return;
    }

    mergeDeltas(res.deltas);
    lastHubSeq = Math.max(res.headSeq, seqCeiling(res.deltas, lastHubSeq ?? 0));
  }

  return { tick, currentHubSeq: () => lastHubSeq };
}

function seqCeiling(deltas: CoordinationDelta[], floor: number): number {
  let m = floor;
  for (const d of deltas) if (typeof d.seq === "number" && d.seq > m) m = d.seq;
  return m;
}

export interface HubChangeSourceOpts {
  hubUrl: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/**
 * The hub HTTP transport: GET <hubUrl>/coordination/changes?since=<seq>, NDJSON body parsed into
 * deltas. 409 → underflow (resync); any network / non-2xx (other than 409) → error (retry next tick).
 */
export function createHubChangeSource(opts: HubChangeSourceOpts): ChangeSource {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  const base = opts.hubUrl.replace(/\/$/, "");
  return {
    async pullChanges(since: number): Promise<PullResult> {
      const url = `${base}/coordination/changes?since=${since}`;
      try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 5000) });
        if (res.status === 409) return { ok: false, underflow: true };
        if (!res.ok) return { ok: false, error: true };
        const text = await res.text();
        const deltas: CoordinationDelta[] = [];
        let headSeq = since;
        for (const line of text.split("\n")) {
          if (!line) continue;
          try {
            const d = JSON.parse(line) as CoordinationDelta;
            deltas.push(d);
            if (typeof d.seq === "number" && d.seq > headSeq) headSeq = d.seq;
          } catch {
            // skip malformed NDJSON line
          }
        }
        return { ok: true, deltas, headSeq };
      } catch {
        return { ok: false, error: true };
      }
    },
  };
}
