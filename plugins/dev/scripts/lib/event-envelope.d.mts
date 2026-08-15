// Type declarations for event-envelope.mjs (CTL-1819).
// Exposes the envelope schema boundary to TypeScript consumers
// (orch-monitor/lib/*.ts, otel-forward/*.ts) via the same .d.mts sidecar shape
// lib/event-name.d.mts and lib/event-stream-class.d.mts already use.

export declare const ENVELOPE_SHAPES: readonly string[];

export interface EnvelopeVerdict {
  ok: boolean;
  /** "v1" | "v2" | "v3" | "dual" | "unknown" | "bypassed" */
  shape: string;
  errors: string[];
}

export declare function classifyEnvelope(event: unknown): string;
export declare function validateEnvelope(event: unknown): EnvelopeVerdict;

export declare function malformedEventCount(): number;
export declare function malformedCountsByShape(): Record<string, number>;
export declare function resetMalformedEventCount(): void;
export declare function noteMalformedEvent(result: EnvelopeVerdict): void;
export declare function checkEnvelope(event: unknown): EnvelopeVerdict;
