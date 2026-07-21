// Type declarations for event-stream-class.mjs (CTL-1488).
// Exposes the coordination/telemetry stream classifier to TypeScript consumers
// (orch-monitor/lib/canonical-event.ts and any other .ts producer).

export type StreamClass = "coordination" | "telemetry";

export declare const COORDINATION_EXACT: readonly string[];
export declare const COORDINATION_PREFIXES: readonly string[];

export declare function classifyEventStream(eventName: string | null | undefined): StreamClass;
