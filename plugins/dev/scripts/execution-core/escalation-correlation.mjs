import { createHash } from "node:crypto";

export const DEFAULT_CORRELATION_WINDOW_MS = 60 * 60 * 1000;
export const DEFAULT_CORRELATION_MIN_GROUP = 2;

// CAT-170 (Codex #3209 P2): `Number(value) || default` accepts a NEGATIVE or
// non-finite setting instead of falling back — a negative window prevents matching
// tickets from ever grouping, `Infinity` removes the age bound entirely, and
// MIN_GROUP=-1 marks a single signed ticket as a correlated "incident". Both
// tunables are validated at their declared domain: a finite positive window, and an
// integer group size of at least two (a group of one is a singleton by definition).
export function resolveCorrelationWindowMs(raw, fallback = DEFAULT_CORRELATION_WINDOW_MS) {
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) return fallback;
  return minutes * 60 * 1000;
}

export function resolveCorrelationMinGroup(raw, fallback = DEFAULT_CORRELATION_MIN_GROUP) {
  const size = Number(raw);
  if (!Number.isInteger(size) || size < 2) return fallback;
  return size;
}

export const RECOVERY_CORRELATION_WINDOW_MS = resolveCorrelationWindowMs(
  process.env.CATALYST_RECOVERY_CORRELATION_WINDOW_MIN,
);
export const RECOVERY_CORRELATION_MIN_GROUP = resolveCorrelationMinGroup(
  process.env.CATALYST_RECOVERY_CORRELATION_MIN_GROUP,
);

// Ticket ids vary per ledger entry even when the underlying failure is shared.
const TICKET_ID_NOISE = /\b[A-Z]{2,5}-\d+\b/gi;
// Absolute timestamps describe when a failure occurred, not what caused it.
const ISO_TIMESTAMP_NOISE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})\b/gi;
// Epoch-millisecond values are occurrence-specific and safe to omit from a cause
// signature.
//
// CAT-170 (Codex #3209 P2): the old `\b\d{12,}\b` erased EVERY long digit run, not
// just occurrence timestamps — a 12-digit AWS account id, a customer id, or a build
// number was normalized away, so `AccessDenied for account 123456789012` and
// `AccessDenied for account 999999999999` collapsed into ONE operator incident even
// though they are distinct causes. Epoch-millisecond values have a known shape:
// exactly 13 digits beginning with 1 (2001-09-09 → 2286-11-20), which covers every
// timestamp this fleet can observe while leaving stable identifiers of any other
// length or leading digit intact. Narrowing here can only ever SPLIT signatures that
// used to collapse — never merge two that previously stayed apart.
const EPOCH_MS_NOISE = /\b1\d{12}\b/g;
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

  // CAT-170 (Codex #3209 P2): validate the per-call overrides at the same domain as
  // the env-derived defaults — an injected negative/non-finite value must not slip
  // past `Number(x) || default` the way it did before.
  const effectiveWindowMs = resolveCorrelationWindowMs(
    Number(windowMs) / 60000,
    RECOVERY_CORRELATION_WINDOW_MS,
  );
  const effectiveMinGroup = resolveCorrelationMinGroup(minGroup, RECOVERY_CORRELATION_MIN_GROUP);
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
