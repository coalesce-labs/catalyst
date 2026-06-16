export declare const FORBIDDEN_PREFIXES: readonly string[];
export declare const PROTECTED_EXACT_NAMES: readonly string[];
export declare const KNOWN_PHASES: readonly string[];
export declare const INTENTIONAL_PHASE_SLOT_EXCEPTIONS: readonly string[];
export declare const PHASE_EVENT_PATTERN: RegExp;
export declare function isBrokerProtectedName(name: string): boolean;
export declare function phaseSlotOf(name: string): string | null;
export declare function isAllowedPhaseSlot(slot: string): boolean;
