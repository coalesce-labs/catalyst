// Type declarations for event-log-paths.mjs (CTL-1216).
// Exposes the canonical event-log path resolver to TypeScript consumers
// (orch-monitor/lib/*.ts, otel-forward/*.ts, event-mirror/*.ts) via the same
// .d.mts sidecar shape lib/event-name.d.mts already uses.

export type RotationScheme = "month" | "week";

export declare const ROTATION_SCHEMES: readonly RotationScheme[];
export declare const DEFAULT_ROTATION_SCHEME: RotationScheme;

export interface RotationSchemeOptions {
  env?: Record<string, string | undefined>;
  config?: unknown;
}

export declare function resolveRotationScheme(opts?: RotationSchemeOptions): RotationScheme;

export declare function isoWeekParts(date: Date): { isoYear: number; isoWeek: number };
export declare function isoWeekStartMs(isoYear: number, isoWeek: number): number;
export declare function isoWeeksInYear(isoYear: number): number;

export declare function eventLogBasenameFor(date: Date, scheme?: RotationScheme): string;

export interface EventLogInterval {
  scheme: RotationScheme;
  startMs: number;
  endMs: number;
}

export declare function parseEventLogBasename(name: unknown): EventLogInterval | null;

export declare function eventsDir(opts?: { env?: Record<string, string | undefined> }): string;

export declare function getEventLogPath(opts?: {
  env?: Record<string, string | undefined>;
  now?: Date;
  config?: unknown;
}): string;

export declare function resolveEventLogPathsForWindow(opts?: {
  eventsDir?: string;
  sinceMs: number;
  nowMs?: number;
  env?: Record<string, string | undefined>;
  includeCurrent?: boolean;
}): string[];

export declare function getPrevEventLogPath(opts?: {
  env?: Record<string, string | undefined>;
  now?: Date;
}): string | null;
