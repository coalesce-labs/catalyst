// capacity-history.mjs — CTL-1092 Phase 5. Reads node.capacity.changed events
// from the unified event log and returns a per-host time-ordered change history.
//
// Pattern mirrors readClusterHeartbeats (execution-core/recovery.mjs): cheap
// string pre-filter → JSON parse → field extraction, with dependency injection
// for the log reader so tests never touch fs.
//
// Alias resolution (A4): pre-pin hostnames in the event log are mapped onto
// their current pinned names via `aliases` (catalyst.host.aliases from
// .catalyst/config.json). Steps from an aliased host merge into the pinned
// host's array. No destructive log migration needed.

// CTL-1529: bounded. The production path used to readFileSync the whole
// current-month log on every hit of GET /api/capacity-history — polled every
// 15-60 s while an OBSERVE Utilization tab is open, with no memo and no ring. Its
// failure mode was perfectly camouflaged: `catch { return {} }` renders an empty
// timeline, which is indistinguishable from the honest "no autotune moves this
// month" state the UI documents.
//
// This one wants the WHOLE month (node.capacity.changed events are rare and the
// chart spans the month), so it is bounded in MEMORY, not in coverage:
// scanEventsChunked folds 1 MiB at a time. Coverage is byte-identical.
import { scanEventsChunked } from "../../execution-core/event-tail.mjs";
import { resolveHostAlias } from "../../execution-core/host-alias.mjs";

export const CAPACITY_CHANGED_EVENT = "node.capacity.changed";

/**
 * readCapacityHistory — scan the event log for node.capacity.changed events and
 * return a per-host map of time-ordered capacity steps.
 *
 * @param {{ logPath?: string, read?: () => string, aliases?: Record<string,string> }} opts
 *   - `read`: injectable reader, called with no args, returns the raw log content.
 *     Defaults to readFileSync(logPath). Throws are caught → returns {}.
 *   - `aliases`: static alias map from catalyst.host.aliases (pre-pin → pinned name).
 *     Absent/null → no aliasing.
 * @returns {Record<string, Array<{ ts: string, old: number, new: number, reason: string }>>}
 */
export function readCapacityHistory({ read, logPath, aliases = null } = {}) {
  /** @type {Record<string, Array<{ ts: string, old: number, new: number, reason: string }>>} */
  const byHost = {};

  const ingest = (evt) => {
    if (evt?.attributes?.["event.name"] !== CAPACITY_CHANGED_EVENT) return;
    const rawHost =
      evt?.body?.payload?.["host.name"] ?? evt?.resource?.["host.name"];
    const ts = evt?.ts;
    const oldV = evt?.body?.payload?.old_maxParallel;
    const newV = evt?.body?.payload?.new_maxParallel;
    const reason = evt?.body?.payload?.reason;
    if (typeof rawHost !== "string" || rawHost.length === 0) return;
    if (typeof ts !== "string" || ts.length === 0) return;
    if (!Number.isInteger(oldV) || !Number.isInteger(newV)) return;

    const host = resolveHostAlias(rawHost, aliases);
    if (!byHost[host]) byHost[host] = [];
    byHost[host].push({ ts, old: oldV, new: newV, reason: reason ?? "" });
  };

  try {
    if (typeof read === "function") {
      // Legacy string seam (tests inject a synthetic body).
      const raw = read();
      if (typeof raw !== "string" || raw.length === 0) return {};
      for (const line of raw.split("\n")) {
        if (!line) continue;
        // Cheap pre-filter — avoids JSON.parse on every heartbeat/other line.
        if (!line.includes(CAPACITY_CHANGED_EVENT)) continue;
        try {
          ingest(JSON.parse(line));
        } catch {
          continue;
        }
      }
    } else {
      // CTL-1529 production path: chunked scan, peak transient = one 1 MiB buffer.
      scanEventsChunked({
        path: logPath ?? "",
        fromOffset: 0,
        lineFilter: (line) => line.includes(CAPACITY_CHANGED_EVENT),
        // CTL-1529 (Codex P2): one-shot read to EOF — include a final record that
        // lacks a trailing newline. The legacy `read()` string seam above splits on
        // "\n" and therefore already parses it; without this the production path
        // would drop the most recent autotune step (the one the Utilization chart
        // is being polled for) whenever the log's last write is mid-flush.
        emitTrailingLine: true,
        onEvent: ingest,
      });
    }
  } catch {
    return {};
  }

  // Sort each host's steps by ts ascending (ISO-8601 sorts lexicographically).
  for (const host of Object.keys(byHost)) {
    byHost[host].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  }

  return byHost;
}
