export const SYSTEM_PROMPT: string;
export const FEW_SHOT_EXAMPLES: ReadonlyArray<{ user: string; assistant: object }>;
export function buildSystemPrompt(opts?: { now?: Date }): string;
