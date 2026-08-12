import { getLivenessAnchorIssue } from "./config.mjs";

// CAT-159: the liveness-anchor issue is an operational bulletin board, not
// implementation work. Missing configuration deliberately fails open: losing
// the exclusion is safer than suppressing an unidentified real work ticket.
export const NOT_DISPATCHABLE_LIVENESS_ANCHOR =
  "liveness-anchor-not-implementation-work";

const ANCHOR_CACHE_TTL_MS = 60_000;
let cachedAnchor;
let cachedAt = Number.NEGATIVE_INFINITY;

export function resolveAnchorIssueCached(
  nowMs = Date.now(),
  { reader = getLivenessAnchorIssue } = {},
) {
  if (nowMs - cachedAt < ANCHOR_CACHE_TTL_MS) return cachedAnchor;
  try {
    cachedAnchor = reader() ?? null;
  } catch {
    cachedAnchor = null;
  }
  cachedAt = nowMs;
  return cachedAnchor;
}

export function _resetAnchorCacheForTests() {
  cachedAnchor = undefined;
  cachedAt = Number.NEGATIVE_INFINITY;
}

export function isLivenessAnchorTicket(
  identifier,
  options = {},
) {
  const anchorIssue = Object.hasOwn(options, "anchorIssue")
    ? options.anchorIssue
    : resolveAnchorIssueCached();
  const candidate = typeof identifier === "string" ? identifier.trim() : "";
  const configured = typeof anchorIssue === "string" ? anchorIssue.trim() : "";
  return candidate.length > 0 && configured.length > 0 &&
    candidate.toLowerCase() === configured.toLowerCase();
}
