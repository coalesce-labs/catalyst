// Type declarations for event-name.mjs (CTL-1834).
// Exposes the shared event-name boundary to TypeScript consumers
// (orch-monitor/lib/*.ts, otel-forward/*.ts) via the same .d.mts sidecar shape
// lib/event-stream-class.d.mts already uses.

export declare const EVENT_NAME_KEYS: readonly string[];

export declare function getEventName(event: unknown): string;
