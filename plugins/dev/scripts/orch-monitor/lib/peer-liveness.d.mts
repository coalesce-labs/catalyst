// Type declarations for peer-liveness.mjs (CTL-1551) — source-aware selection of
// the cross-host peer-liveness transport (Loki preferred, Linear anchor legacy
// fallback) for the monitor's background peer poll.

/** Per-host peer record — the shape both transports produce (AnchorPeerRec-compatible). */
export interface PeerRecord {
  host?: string;
  last_seen?: string;
  in_flight_tickets?: string[];
  max_parallel?: number | null;
  in_flight_count?: number | null;
}

export interface ReadPeerRecordsArgs {
  /** Raw CATALYST_LIVENESS_READ_SOURCE value: "loki" | "linear" | unset (AUTO). */
  rawSource?: string | undefined;
  /** Resolved Loki query base URL, or null when none is available. */
  lokiUrl?: string | null;
  /** The Linear liveness-anchor issue id, or null when unconfigured. */
  anchorIssue?: string | null;
  /** Loki transport (throws are swallowed → AUTO falls back to the anchor). */
  readLoki?: (args: { lokiUrl: string }) => Record<string, PeerRecord>;
  /** Anchor transport (throws PROPAGATE so the caller keeps its last cache). */
  readAnchor?: (args: { anchorIssue: string }) => Record<string, PeerRecord>;
}

export interface ReadPeerRecordsResult {
  /** The per-host map, or null when no transport is configured (clear caches). */
  peers: Record<string, PeerRecord> | null;
  source: "loki" | "anchor" | "none";
}

export function readPeerRecords(args?: ReadPeerRecordsArgs): ReadPeerRecordsResult;
