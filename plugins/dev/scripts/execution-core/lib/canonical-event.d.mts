// Type declarations for canonical-event.mjs (CTL-1817).
//
// The implementation is .mjs — execution-core is JavaScript — but otel-forward is TypeScript
// and imports the builder across the package boundary so one test can prove the producer and
// the forwarder agree on the envelope. Without this file that import is an implicit `any`.
// Kept hand-written and deliberately minimal: it describes the public seam only.

export interface CanonicalEventSpec {
  /** Full event name, e.g. "phase.rescue.escalated.CTL-1832". Required; empty throws. */
  name: string;
  /** Structured detail → body.payload. Omitted from the envelope when undefined or null. */
  payload?: unknown;
  /** Resource service.name. Defaults to "catalyst.execution-core". */
  serviceName?: string;
  /** Extra OTel attributes. Merged alongside event.name, which they cannot displace. */
  attributes?: Record<string, unknown>;
  severityText?: string;
  severityNumber?: number;
}

export interface CanonicalEventSeams {
  now?: () => Date;
  newId?: () => string;
  newTrace?: () => string;
  newSpan?: () => string;
}

/** Build one canonical ("v2") JSONL event line, newline-terminated. */
export function buildCanonicalEventLine(
  spec: CanonicalEventSpec,
  seams?: CanonicalEventSeams,
): string;

/** The same envelope as an object, before serialization (CTL-1795). */
export function buildCanonicalEvent(
  spec: CanonicalEventSpec,
  seams?: CanonicalEventSeams,
): Record<string, unknown>;

/**
 * Which v1 flat fields are promoted to first-class OTel attributes (CTL-1795).
 * Byte-identical to otel-forward's ATTR_MAP — see the note on the implementation.
 */
export const FLAT_ATTRIBUTE_MAP: Readonly<Record<string, string>>;

export interface DualEnvelopeOpts {
  serviceName?: string;
  severityText?: string;
  severityNumber?: number;
}

/**
 * Build ONE superset JSONL line carrying both the v1 top-level `event` and a v2
 * `attributes`/`body`/`resource` block (CTL-1795). Throws on a nameless record or one that
 * is already canonical — callers fall back to the plain v1 line.
 */
export function buildDualEnvelopeLine(
  flat: Record<string, unknown>,
  opts?: DualEnvelopeOpts,
  seams?: CanonicalEventSeams,
): string;
