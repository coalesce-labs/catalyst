// Type declarations for phase-fsm.mjs (CTL-1100).
// Exposes the per-phase FSM constants and transition function to TypeScript
// consumers (server.ts, fsm-descriptor.mjs, test files).

export declare const PARK_STATE: string;
export declare const TERMINAL_SUCCESS: string;
export declare const TERMINAL_FAILURE: string;
export declare const TERMINAL_STATES: ReadonlySet<string>;
export declare const EVENT_TYPES: ReadonlySet<string>;
export declare const REVIVE_BUDGET: number;
export declare const TERMINAL_LINEAR_KEY: string;

export declare class PhaseFsmError extends Error {}

export declare function isKnownPhase(phase: string): boolean;
export declare function linearKeyForPhase(phase: string): string;
export declare function phaseIndex(phase: string): number;
export declare function initialState(): Record<string, unknown>;
export declare function isTerminal(state: Record<string, unknown>): boolean;
export declare function transition(state: Record<string, unknown>, event: string): Record<string, unknown>;
