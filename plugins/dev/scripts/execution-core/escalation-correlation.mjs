import { createHash } from "node:crypto";

export const RECOVERY_CORRELATION_WINDOW_MS =
  Number(process.env.CATALYST_RECOVERY_CORRELATION_WINDOW_MIN) * 60 * 1000 || 60 * 60 * 1000;
export const RECOVERY_CORRELATION_MIN_GROUP =
  Number(process.env.CATALYST_RECOVERY_CORRELATION_MIN_GROUP) || 2;

// Ticket ids vary per ledger entry even when the underlying failure is shared.
const TICKET_ID_NOISE = /\b[A-Z]{2,5}-\d+\b/gi;
// Absolute timestamps describe when a failure occurred, not what caused it.
const ISO_TIMESTAMP_NOISE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})\b/gi;
// Epoch-millisecond values are occurrence-specific and safe to omit from a cause signature.
const EPOCH_MS_NOISE = /\b\d{12,}\b/g;
const MAX_SIGNATURE_LENGTH = 96;

function shortHash(value, length) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function normalizeSignature(raw) {
  if (raw == null) return null;
  const signature = String(raw)
    .trim()
    .toLowerCase()
    .replace(TICKET_ID_NOISE, "")
    .replace(ISO_TIMESTAMP_NOISE, "")
    .replace(EPOCH_MS_NOISE, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!signature) return null;
  if (signature.length > MAX_SIGNATURE_LENGTH) {
    return `sha256:${shortHash(signature, 16)}`;
  }
  return signature;
}

export function correlationId(signature, anchorTicket) {
  return `corr-${shortHash(`${signature}|${anchorTicket}`, 12)}`;
}

function timestamp(candidate) {
  const value = Number(candidate.lastTs);
  return Number.isFinite(value) ? value : 0;
}

function compareCandidates(left, right) {
  return timestamp(left) - timestamp(right) || left.ticket.localeCompare(right.ticket);
}

function makeGroup(candidates, signature, correlated) {
  const ordered = [...candidates].sort(compareCandidates);
  const anchor = ordered[0].ticket;
  const members = ordered.slice(1).map(({ ticket }) => ticket).sort((a, b) => a.localeCompare(b));
  return {
    signature,
    anchor,
    members,
    tickets: [anchor, ...members],
    correlated,
    _anchorTs: timestamp(ordered[0]),
  };
}

export function groupCandidates(
  candidates,
  {
    windowMs = RECOVERY_CORRELATION_WINDOW_MS,
    minGroup = RECOVERY_CORRELATION_MIN_GROUP,
    now: _now = Date.now(),
  } = {},
) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];

  const buckets = new Map();
  const groups = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate.ticket !== "string" || !candidate.ticket) continue;
    if (candidate.signature == null) {
      groups.push(makeGroup([candidate], null, false));
      continue;
    }
    const bucket = buckets.get(candidate.signature) ?? [];
    bucket.push(candidate);
    buckets.set(candidate.signature, bucket);
  }

  const effectiveWindowMs = Number(windowMs) || RECOVERY_CORRELATION_WINDOW_MS;
  const effectiveMinGroup = Number(minGroup) || RECOVERY_CORRELATION_MIN_GROUP;
  for (const [signature, bucket] of buckets) {
    const ordered = bucket.sort(compareCandidates);
    let cluster = [];
    for (const candidate of ordered) {
      if (cluster.length > 0 && timestamp(candidate) - timestamp(cluster[0]) > effectiveWindowMs) {
        appendCluster(groups, cluster, signature, effectiveMinGroup);
        cluster = [];
      }
      cluster.push(candidate);
    }
    appendCluster(groups, cluster, signature, effectiveMinGroup);
  }

  return groups
    .sort((left, right) => left._anchorTs - right._anchorTs || left.anchor.localeCompare(right.anchor))
    .map(({ _anchorTs, ...group }) => group);
}

function appendCluster(groups, cluster, signature, minGroup) {
  if (cluster.length >= minGroup) {
    groups.push(makeGroup(cluster, signature, true));
    return;
  }
  for (const candidate of cluster) {
    groups.push(makeGroup([candidate], signature, false));
  }
}
